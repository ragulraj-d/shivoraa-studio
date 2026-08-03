"""Execution-plan resolution tests.

Server-side and local execution share this resolver, so a bug here would produce
mode-dependent behaviour — a request that works in the extension and fails in the
browser, or vice versa.
"""

from __future__ import annotations

from app.models.collection import ApiRequest, Collection
from app.modules.execution.resolver import (
    VariableSet,
    build_plan,
    interpolate,
)


def make_request(**kwargs: object) -> ApiRequest:
    defaults = {
        "name": "test",
        "method": "GET",
        "url": "",
        "headers": [],
        "query_params": [],
        "path_params": [],
        "body": {},
        "auth": None,
        "settings": {},
    }
    defaults.update(kwargs)
    return ApiRequest(**defaults)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# Interpolation
# --------------------------------------------------------------------------- #
def test_interpolates_known_variables() -> None:
    variables = VariableSet(values={"host": "api.example.com", "version": "v2"})
    unresolved: list[str] = []
    result = interpolate("https://{{host}}/{{version}}/users", variables, unresolved)
    assert result == "https://api.example.com/v2/users"
    assert unresolved == []


def test_unknown_variables_are_left_visible() -> None:
    """An undefined variable stays as {{name}} rather than becoming an empty string.

    A URL containing a literal {{api_token}} is immediately diagnosable; a
    silently blanked value produces a confusing 401 with no clue why.
    """
    variables = VariableSet(values={})
    unresolved: list[str] = []
    result = interpolate("https://{{host}}/users", variables, unresolved)
    assert result == "https://{{host}}/users"
    assert unresolved == ["host"]


def test_unresolved_reported_once() -> None:
    variables = VariableSet(values={})
    unresolved: list[str] = []
    interpolate("{{a}}/{{a}}/{{b}}", variables, unresolved)
    assert unresolved == ["a", "b"]


def test_whitespace_inside_braces_is_tolerated() -> None:
    variables = VariableSet(values={"host": "example.com"})
    assert interpolate("{{ host }}", variables, []) == "example.com"


# --------------------------------------------------------------------------- #
# Plan building
# --------------------------------------------------------------------------- #
def test_collection_base_url_is_prefixed() -> None:
    collection = Collection(
        name="c", base_url="https://api.example.com", auth={}, default_headers=[]
    )
    request = make_request(url="/users")
    plan = build_plan(request, collection, None)
    assert plan.url == "https://api.example.com/users"


def test_absolute_url_ignores_base_url() -> None:
    collection = Collection(
        name="c", base_url="https://api.example.com", auth={}, default_headers=[]
    )
    request = make_request(url="https://other.com/thing")
    plan = build_plan(request, collection, None)
    assert plan.url == "https://other.com/thing"


def test_request_headers_override_collection_defaults() -> None:
    collection = Collection(
        name="c",
        base_url=None,
        auth={},
        default_headers=[{"key": "Accept", "value": "application/xml", "enabled": True}],
    )
    request = make_request(
        url="https://x.com",
        headers=[{"key": "Accept", "value": "application/json", "enabled": True}],
    )
    plan = build_plan(request, collection, None)
    assert plan.headers["Accept"] == "application/json"


def test_disabled_rows_are_skipped() -> None:
    request = make_request(
        url="https://x.com",
        headers=[
            {"key": "X-On", "value": "1", "enabled": True},
            {"key": "X-Off", "value": "2", "enabled": False},
        ],
    )
    plan = build_plan(request, None, None)
    assert "X-On" in plan.headers
    assert "X-Off" not in plan.headers


def test_bearer_auth_becomes_authorization_header() -> None:
    request = make_request(url="https://x.com", auth={"type": "bearer", "token": "abc123"})
    plan = build_plan(request, None, None)
    assert plan.headers["Authorization"] == "Bearer abc123"


def test_basic_auth_is_base64_encoded() -> None:
    import base64

    request = make_request(
        url="https://x.com", auth={"type": "basic", "username": "ada", "password": "lovelace"}
    )
    plan = build_plan(request, None, None)
    expected = base64.b64encode(b"ada:lovelace").decode()
    assert plan.headers["Authorization"] == f"Basic {expected}"


def test_request_auth_overrides_collection_auth() -> None:
    collection = Collection(
        name="c", base_url=None, auth={"type": "bearer", "token": "collection"}, default_headers=[]
    )
    request = make_request(url="https://x.com", auth={"type": "bearer", "token": "request"})
    plan = build_plan(request, collection, None)
    assert plan.headers["Authorization"] == "Bearer request"


def test_inherit_falls_back_to_collection_auth() -> None:
    collection = Collection(
        name="c", base_url=None, auth={"type": "bearer", "token": "collection"}, default_headers=[]
    )
    request = make_request(url="https://x.com", auth={"type": "inherit"})
    plan = build_plan(request, collection, None)
    assert plan.headers["Authorization"] == "Bearer collection"


def test_path_params_substituted() -> None:
    request = make_request(
        url="https://x.com/users/{id}",
        path_params=[{"key": "id", "value": "42", "enabled": True}],
    )
    plan = build_plan(request, None, None)
    assert plan.url == "https://x.com/users/42"


def test_query_params_appended() -> None:
    request = make_request(
        url="https://x.com/users",
        query_params=[
            {"key": "limit", "value": "20", "enabled": True},
            {"key": "cursor", "value": "abc", "enabled": True},
        ],
    )
    plan = build_plan(request, None, None)
    assert "limit=20" in plan.url
    assert "cursor=abc" in plan.url


def test_query_params_respect_existing_querystring() -> None:
    request = make_request(
        url="https://x.com/users?a=1",
        query_params=[{"key": "b", "value": "2", "enabled": True}],
    )
    plan = build_plan(request, None, None)
    assert plan.url == "https://x.com/users?a=1&b=2"


def test_json_body_sets_content_type() -> None:
    request = make_request(
        url="https://x.com", method="POST", body={"mode": "json", "content": '{"a":1}'}
    )
    plan = build_plan(request, None, None)
    assert plan.body == '{"a":1}'
    assert plan.headers["Content-Type"] == "application/json"


def test_graphql_body_is_wrapped() -> None:
    import json

    request = make_request(
        url="https://x.com",
        method="POST",
        body={"mode": "graphql", "content": "{ me { id } }", "graphql_variables": '{"x":1}'},
    )
    plan = build_plan(request, None, None)
    payload = json.loads(plan.body or "{}")
    assert payload["query"] == "{ me { id } }"
    assert payload["variables"] == {"x": 1}


def test_malformed_graphql_variables_do_not_crash() -> None:
    """A half-typed variables block shouldn't take down the send."""
    import json

    request = make_request(
        url="https://x.com",
        method="POST",
        body={"mode": "graphql", "content": "{ me }", "graphql_variables": "{not json"},
    )
    plan = build_plan(request, None, None)
    assert json.loads(plan.body or "{}")["variables"] == {}


def test_method_is_uppercased() -> None:
    plan = build_plan(make_request(url="https://x.com", method="post"), None, None)
    assert plan.method == "POST"
