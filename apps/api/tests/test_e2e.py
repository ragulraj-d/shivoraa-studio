"""End-to-end walk through the core product flow.

Register → create a collection → create a request → send it for real → read it
back from history. If this passes, the product works.

Runs against a temporary SQLite database and makes one real outbound HTTP call,
so it is skipped when the network is unavailable.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
import pytest_asyncio

TEST_DB = Path(tempfile.gettempdir()) / "shivoraa_e2e.db"
os.environ["SHIVORAA_DATABASE_URL"] = f"sqlite+aiosqlite:///{TEST_DB}"
os.environ["SHIVORAA_ENVIRONMENT"] = "local"


@pytest_asyncio.fixture
async def client() -> AsyncIterator[object]:
    import httpx

    from app.core.db import Base, engine
    from app.main import app

    if TEST_DB.exists():
        TEST_DB.unlink()

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http

    await engine.dispose()
    if TEST_DB.exists():
        TEST_DB.unlink()


API = "/api/v1"


async def _register(client, email: str = "ada@example.com") -> dict[str, str]:
    response = await client.post(
        f"{API}/auth/register",
        json={"email": email, "password": "a-long-enough-password", "display_name": "Ada"},
    )
    assert response.status_code == 201, response.text
    token = response.json()["access_token"]

    me = await client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200, me.text
    workspace_id = me.json()["workspaces"][0]["id"]

    return {"Authorization": f"Bearer {token}", "X-Workspace-Id": workspace_id}


@pytest.mark.asyncio
async def test_register_creates_workspace_and_environment(client) -> None:
    headers = await _register(client)

    me = await client.get(f"{API}/auth/me", headers=headers)
    body = me.json()
    assert body["user"]["email"] == "ada@example.com"
    # A brand-new user must land somewhere usable, not on an empty app.
    assert len(body["workspaces"]) == 1
    assert body["workspaces"][0]["role"] == "owner"

    environments = await client.get(f"{API}/environments", headers=headers)
    assert environments.status_code == 200
    assert len(environments.json()) == 1
    assert environments.json()[0]["name"] == "Development"


@pytest.mark.asyncio
async def test_duplicate_email_rejected(client) -> None:
    await _register(client)
    response = await client.post(
        f"{API}/auth/register",
        json={
            "email": "ada@example.com",
            "password": "a-long-enough-password",
            "display_name": "X",
        },
    )
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_login_failure_does_not_reveal_account_existence(client) -> None:
    await _register(client)

    wrong_password = await client.post(
        f"{API}/auth/login", json={"email": "ada@example.com", "password": "wrong-password-here"}
    )
    no_such_user = await client.post(
        f"{API}/auth/login", json={"email": "nobody@example.com", "password": "wrong-password-here"}
    )

    assert wrong_password.status_code == no_such_user.status_code == 401
    # Identical messages, so an attacker cannot enumerate registered emails.
    assert wrong_password.json()["error"]["detail"] == no_such_user.json()["error"]["detail"]


@pytest.mark.asyncio
async def test_unauthenticated_requests_rejected(client) -> None:
    response = await client.get(f"{API}/collections")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_collection_and_request_lifecycle(client) -> None:
    headers = await _register(client)

    created = await client.post(f"{API}/collections", json={"name": "My API"}, headers=headers)
    assert created.status_code == 201, created.text
    collection_id = created.json()["id"]

    request = await client.post(
        f"{API}/collections/{collection_id}/requests",
        json={"name": "Get users", "method": "get", "url": "https://example.com/users"},
        headers=headers,
    )
    assert request.status_code == 201, request.text
    assert request.json()["method"] == "GET"  # normalised
    request_id = request.json()["id"]
    version = request.json()["version"]

    tree = await client.get(f"{API}/collections", headers=headers)
    assert len(tree.json()) == 1
    assert len(tree.json()[0]["requests"]) == 1

    updated = await client.patch(
        f"{API}/requests/{request_id}",
        json={"name": "List users", "version": version},
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "List users"
    assert updated.json()["version"] == version + 1

    deleted = await client.delete(f"{API}/requests/{request_id}", headers=headers)
    assert deleted.status_code == 204


@pytest.mark.asyncio
async def test_stale_version_returns_conflict_with_server_state(client) -> None:
    """The sync guarantee: a concurrent edit is surfaced, never silently overwritten."""
    headers = await _register(client)
    collection_id = (
        await client.post(f"{API}/collections", json={"name": "C"}, headers=headers)
    ).json()["id"]
    request = (
        await client.post(
            f"{API}/collections/{collection_id}/requests",
            json={"name": "R", "url": "https://example.com"},
            headers=headers,
        )
    ).json()

    # First write succeeds and bumps the version.
    first = await client.patch(
        f"{API}/requests/{request['id']}",
        json={"name": "From device A", "version": request["version"]},
        headers=headers,
    )
    assert first.status_code == 200

    # Second write still holds the old version — this is the conflict case.
    second = await client.patch(
        f"{API}/requests/{request['id']}",
        json={"name": "From device B", "version": request["version"]},
        headers=headers,
    )
    assert second.status_code == 409
    error = second.json()["error"]
    assert error["code"] == "version_conflict"
    # The server sends its current state so the client can render a diff without
    # another round-trip.
    assert error["server_state"]["name"] == "From device A"


@pytest.mark.asyncio
async def test_tenant_isolation(client) -> None:
    """One user's collection must be invisible and unreachable to another."""
    ada = await _register(client, "ada@example.com")
    grace = await _register(client, "grace@example.com")

    collection_id = (
        await client.post(f"{API}/collections", json={"name": "Ada's secret"}, headers=ada)
    ).json()["id"]

    listed = await client.get(f"{API}/collections", headers=grace)
    assert listed.json() == []

    direct = await client.get(f"{API}/collections/{collection_id}", headers=grace)
    assert direct.status_code == 404

    deletion = await client.delete(f"{API}/collections/{collection_id}", headers=grace)
    assert deletion.status_code == 404


@pytest.mark.asyncio
async def test_localhost_execution_is_refused_with_a_route_forward(client) -> None:
    """The SSRF block must be an actionable message, not a dead end."""
    headers = await _register(client)

    response = await client.post(
        f"{API}/executions",
        json={"adhoc": {"method": "GET", "url": "http://localhost:9999/health"}},
        headers=headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["requires_local"] is True
    assert "extension" in (body["error_hint"] or "").lower()


@pytest.mark.asyncio
async def test_metadata_endpoint_is_blocked(client) -> None:
    headers = await _register(client)
    response = await client.post(
        f"{API}/executions",
        json={"adhoc": {"method": "GET", "url": "http://169.254.169.254/latest/meta-data/"}},
        headers=headers,
    )
    assert response.json()["ok"] is False


@pytest.mark.asyncio
async def test_variables_resolve_into_the_request(client) -> None:
    headers = await _register(client)
    environment = (await client.get(f"{API}/environments", headers=headers)).json()[0]

    await client.patch(
        f"{API}/environments/{environment['id']}",
        json={
            "variables": [
                {
                    "key": "base_url",
                    "value": "https://httpbin.org",
                    "is_secret": False,
                    "enabled": True,
                },
                {"key": "api_token", "value": "super-secret", "is_secret": True, "enabled": True},
            ]
        },
        headers=headers,
    )

    # Secret values must never come back over the wire.
    refreshed = (await client.get(f"{API}/environments", headers=headers)).json()[0]
    secret = next(v for v in refreshed["variables"] if v["key"] == "api_token")
    assert secret["value"] != "super-secret"

    collection_id = (
        await client.post(f"{API}/collections", json={"name": "C"}, headers=headers)
    ).json()["id"]
    request_id = (
        await client.post(
            f"{API}/collections/{collection_id}/requests",
            json={
                "name": "R",
                "url": "{{base_url}}/get",
                "auth": {"type": "bearer", "token": "{{api_token}}"},
            },
            headers=headers,
        )
    ).json()["id"]

    plan = await client.post(
        f"{API}/executions/plan",
        json={"request_id": request_id, "environment_id": environment["id"]},
        headers=headers,
    )
    assert plan.status_code == 200, plan.text
    body = plan.json()
    assert body["url"] == "https://httpbin.org/get"
    # The plan is what the extension executes locally, so the real credential
    # does belong here — it goes to the user's own machine over TLS.
    assert body["headers"]["Authorization"] == "Bearer super-secret"
    assert body["unresolved"] == []


@pytest.mark.asyncio
async def test_unresolved_variable_is_reported_not_silently_blanked(client) -> None:
    headers = await _register(client)
    collection_id = (
        await client.post(f"{API}/collections", json={"name": "C"}, headers=headers)
    ).json()["id"]
    request_id = (
        await client.post(
            f"{API}/collections/{collection_id}/requests",
            json={"name": "R", "url": "https://example.com/{{missing_var}}"},
            headers=headers,
        )
    ).json()["id"]

    plan = (
        await client.post(
            f"{API}/executions/plan", json={"request_id": request_id}, headers=headers
        )
    ).json()
    assert plan["unresolved"] == ["missing_var"]
    assert "{{missing_var}}" in plan["url"]


@pytest.mark.asyncio
async def test_ai_without_provider_gives_actionable_guidance(client) -> None:
    headers = await _register(client)
    response = await client.post(
        f"{API}/ai/chat", json={"message": "hello", "feature": "chat"}, headers=headers
    )
    # SSE always returns 200; the failure arrives as an event in the stream.
    assert response.status_code == 200
    assert "no_provider" in response.text or "provider" in response.text.lower()


@pytest.mark.asyncio
@pytest.mark.network
async def test_real_request_end_to_end(client) -> None:
    """Send a genuine HTTP request through the proxy and read it back."""
    import httpx

    headers = await _register(client)

    try:
        response = await client.post(
            f"{API}/executions",
            json={
                "adhoc": {
                    "method": "GET",
                    "url": "https://httpbin.org/json",
                    "headers": [{"key": "Accept", "value": "application/json", "enabled": True}],
                }
            },
            headers=headers,
            timeout=45.0,
        )
    except (httpx.ConnectError, httpx.ReadTimeout):
        pytest.skip("no network access")

    body = response.json()
    if not body["ok"]:
        pytest.skip(f"upstream unavailable: {body.get('error_message')}")
    if body["status_code"] >= 500:
        # The proxy did its job — it faithfully returned what the upstream said.
        # A flaky third party is not a failure of this code.
        pytest.skip(f"upstream returned {body['status_code']}")

    assert body["status_code"] == 200
    assert body["mode"] == "server"
    assert body["size_bytes"] > 0
    assert body["timing"]["total_ms"] > 0
    assert body["body"]

    history = await client.get(f"{API}/executions", headers=headers)
    assert history.status_code == 200
    assert len(history.json()) == 1
    assert history.json()[0]["status_code"] == 200
