"""Builds an ExecutionPlan from a saved request plus its environment.

Resolution happens exactly once and produces the same plan whether the request
will run on the server or locally in the extension. Two resolution paths would
produce mode-dependent behaviour, which is the worst class of bug this product
could ship.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.core.security import crypto
from app.models.collection import ApiRequest, Collection
from app.models.workspace import Environment

VARIABLE_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


@dataclass(slots=True)
class VariableSet:
    values: dict[str, str] = field(default_factory=dict)
    secret_names: set[str] = field(default_factory=set)

    @property
    def secrets(self) -> dict[str, str]:
        """Name -> value, for the redactor. Never logged, never sent to AI."""
        return {k: v for k, v in self.values.items() if k in self.secret_names}


@dataclass(slots=True)
class ExecutionPlan:
    method: str
    url: str
    headers: dict[str, str]
    body: str | None
    content_type: str | None
    timeout: int
    follow_redirects: bool
    verify_ssl: bool
    unresolved: list[str] = field(default_factory=list)
    variables: VariableSet = field(default_factory=VariableSet)

    def to_dict(self) -> dict[str, Any]:
        return {
            "method": self.method,
            "url": self.url,
            "headers": self.headers,
            "body": self.body,
            "content_type": self.content_type,
            "timeout": self.timeout,
            "follow_redirects": self.follow_redirects,
            "verify_ssl": self.verify_ssl,
            "unresolved": self.unresolved,
        }


def build_variable_set(
    env: Environment | None, overrides: dict[str, str] | None = None
) -> VariableSet:
    """Collect variables with precedence: runtime overrides beat environment."""
    vs = VariableSet()
    if env:
        for var in env.variables:
            if not var.enabled:
                continue
            if var.is_secret:
                if var.value_encrypted:
                    try:
                        vs.values[var.key] = crypto.decrypt(var.value_encrypted)
                        vs.secret_names.add(var.key)
                    except ValueError:
                        # A value encrypted under a rotated key shouldn't take
                        # down the whole request; it surfaces as unresolved.
                        continue
            else:
                vs.values[var.key] = var.value or ""
    for key, value in (overrides or {}).items():
        vs.values[key] = value
    return vs


def interpolate(text: str, variables: VariableSet, unresolved: list[str]) -> str:
    """Replace `{{var}}` with its value, recording anything undefined.

    Undefined variables are left verbatim rather than blanked, so a failing
    request shows `{{api_token}}` in its URL — which is far easier to diagnose
    than a silently empty string.
    """

    def _sub(match: re.Match[str]) -> str:
        name = match.group(1)
        if name in variables.values:
            return variables.values[name]
        if name not in unresolved:
            unresolved.append(name)
        return match.group(0)

    return VARIABLE_RE.sub(_sub, text or "")


def _enabled_pairs(items: list[dict[str, Any]]) -> list[tuple[str, str]]:
    return [
        (i.get("key", ""), i.get("value", ""))
        for i in items or []
        if i.get("enabled", True) and i.get("key")
    ]


def _resolve_auth(
    auth: dict[str, Any] | None, headers: dict[str, str], query: list[tuple[str, str]]
) -> None:
    if not auth:
        return
    auth_type = auth.get("type", "none")

    if auth_type == "bearer" and auth.get("token"):
        headers["Authorization"] = f"Bearer {auth['token']}"
    elif auth_type == "basic":
        import base64

        raw = f"{auth.get('username', '')}:{auth.get('password', '')}".encode()
        headers["Authorization"] = f"Basic {base64.b64encode(raw).decode()}"
    elif auth_type == "api_key" and auth.get("key"):
        if auth.get("add_to", "header") == "header":
            headers[auth["key"]] = auth.get("value", "")
        else:
            query.append((auth["key"], auth.get("value", "")))


def build_plan(
    request: ApiRequest,
    collection: Collection | None,
    env: Environment | None,
    *,
    overrides: dict[str, str] | None = None,
) -> ExecutionPlan:
    variables = build_variable_set(env, overrides)
    unresolved: list[str] = []

    def interp(text: str) -> str:
        return interpolate(text, variables, unresolved)

    # --- URL: collection base_url is a prefix unless the request is absolute ---
    url = interp(request.url or "")
    if collection and collection.base_url and not url.lower().startswith(("http://", "https://")):
        url = interp(collection.base_url).rstrip("/") + "/" + url.lstrip("/")

    # --- Path params: /users/{id} ---
    for key, value in _enabled_pairs(request.path_params):
        url = url.replace(f"{{{key}}}", interp(value))

    # --- Headers: collection defaults, then request headers override ---
    headers: dict[str, str] = {}
    if collection:
        for key, value in _enabled_pairs(collection.default_headers):
            headers[interp(key)] = interp(value)
    for key, value in _enabled_pairs(request.headers):
        headers[interp(key)] = interp(value)

    # --- Query params ---
    query: list[tuple[str, str]] = [
        (interp(k), interp(v)) for k, v in _enabled_pairs(request.query_params)
    ]

    # --- Auth: request-level overrides collection-level ---
    auth = request.auth
    if not auth or auth.get("type") in (None, "inherit"):
        auth = collection.auth if collection else None
    if auth:
        auth = {k: interp(v) if isinstance(v, str) else v for k, v in auth.items()}
    _resolve_auth(auth, headers, query)

    if query:
        from urllib.parse import urlencode

        separator = "&" if "?" in url else "?"
        url = f"{url}{separator}{urlencode(query)}"

    # --- Body ---
    body_spec = request.body or {}
    mode = body_spec.get("mode", "none")
    body: str | None = None
    content_type: str | None = body_spec.get("content_type")

    if mode == "json":
        body = interp(body_spec.get("content", ""))
        content_type = content_type or "application/json"
    elif mode == "raw":
        body = interp(body_spec.get("content", ""))
        content_type = content_type or "text/plain"
    elif mode == "graphql":
        import json

        query_text = interp(body_spec.get("content", ""))
        raw_vars = interp(body_spec.get("graphql_variables", "") or "{}")
        try:
            parsed_vars = json.loads(raw_vars) if raw_vars.strip() else {}
        except json.JSONDecodeError:
            parsed_vars = {}
        body = json.dumps({"query": query_text, "variables": parsed_vars})
        content_type = "application/json"
    elif mode == "urlencoded":
        from urllib.parse import urlencode

        pairs = [
            (interp(i.get("key", "")), interp(i.get("value", "")))
            for i in body_spec.get("form_data", [])
            if i.get("enabled", True)
        ]
        body = urlencode(pairs)
        content_type = "application/x-www-form-urlencoded"

    if content_type and body is not None:
        headers.setdefault("Content-Type", content_type)

    settings_map = request.settings or {}
    return ExecutionPlan(
        method=(request.method or "GET").upper(),
        url=url,
        headers=headers,
        body=body,
        content_type=content_type,
        timeout=int(settings_map.get("timeout", 30)),
        follow_redirects=bool(settings_map.get("follow_redirects", True)),
        verify_ssl=bool(settings_map.get("verify_ssl", True)),
        unresolved=unresolved,
        variables=variables,
    )
