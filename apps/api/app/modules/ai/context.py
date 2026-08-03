"""Context assembly — the part that makes the AI useful.

An assistant that sees only a text box gives generic answers. One that sees the
request, the response that failed, the auth configuration, and the sibling
requests in the collection gives specific ones. This module builds that view.

Three rules hold throughout:

1. Everything is redacted at construction, so a secret value cannot reach a
   provider even by accident.
2. Everything is budgeted, and anything dropped is *recorded* — silent
   truncation degrades answers in ways nobody can debug.
3. The manifest the user sees is the same structure that was sent, so the
   disclosure panel cannot drift from reality.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import redact_mapping, redact_text
from app.models.ai import AIFeature
from app.models.collection import ApiRequest, Collection
from app.models.execution import Execution
from app.models.workspace import Environment
from app.modules.ai.providers import approx_tokens

MAX_BODY_CHARS = 8000


class ContextKind(str, Enum):
    REQUEST = "request"
    RESPONSE = "response"
    AUTH = "auth"
    ENVIRONMENT = "environment"
    COLLECTION = "collection"
    SIBLINGS = "siblings"
    HISTORY = "history"
    EXISTING_DOCS = "existing_docs"
    EXISTING_TESTS = "existing_tests"


@dataclass(slots=True)
class ContextItem:
    kind: ContextKind
    label: str
    content: str
    priority: int  # lower is more important
    included: bool = True
    tokens: int = 0

    def __post_init__(self) -> None:
        self.tokens = approx_tokens(self.content)


@dataclass(slots=True)
class AIContext:
    items: list[ContextItem] = field(default_factory=list)
    budget: int = 8000

    def manifest(self) -> list[dict[str, Any]]:
        """What the disclosure panel renders. Same data that was sent."""
        return [
            {
                "kind": i.kind.value,
                "label": i.label,
                "tokens": i.tokens,
                "included": i.included,
            }
            for i in self.items
        ]

    @property
    def dropped(self) -> list[str]:
        return [i.label for i in self.items if not i.included]

    def render(self) -> str:
        """Render included items as delimited, labelled blocks.

        Content is wrapped in explicit tags and the system prompt states that
        anything inside is data to analyse, never instructions to follow. An API
        response is attacker-controlled, so a body containing "ignore previous
        instructions" must read as text, not as a command.
        """
        blocks = []
        for item in self.items:
            if not item.included:
                continue
            blocks.append(
                f'<context kind="{item.kind.value}" label="{item.label}">\n'
                f"{item.content}\n"
                f"</context>"
            )
        return "\n\n".join(blocks)


# Which context matters most, per feature. Budget is filled in this order.
PRIORITIES: dict[AIFeature, list[ContextKind]] = {
    AIFeature.CHAT: [
        ContextKind.REQUEST,
        ContextKind.RESPONSE,
        ContextKind.AUTH,
        ContextKind.ENVIRONMENT,
        ContextKind.COLLECTION,
        ContextKind.SIBLINGS,
    ],
    AIFeature.DEBUG: [
        ContextKind.RESPONSE,
        ContextKind.REQUEST,
        ContextKind.AUTH,
        ContextKind.ENVIRONMENT,
        ContextKind.HISTORY,
        ContextKind.COLLECTION,
    ],
    AIFeature.GENERATE_REQUEST: [
        ContextKind.SIBLINGS,
        ContextKind.COLLECTION,
        ContextKind.AUTH,
        ContextKind.ENVIRONMENT,
    ],
    AIFeature.GENERATE_DOCS: [
        ContextKind.REQUEST,
        ContextKind.RESPONSE,
        ContextKind.EXISTING_DOCS,
        ContextKind.COLLECTION,
    ],
    AIFeature.GENERATE_TESTS: [
        ContextKind.REQUEST,
        ContextKind.RESPONSE,
        ContextKind.EXISTING_TESTS,
        ContextKind.AUTH,
    ],
    AIFeature.SECURITY: [
        ContextKind.REQUEST,
        ContextKind.RESPONSE,
        ContextKind.AUTH,
        ContextKind.COLLECTION,
    ],
}


class ContextManager:
    def __init__(self, db: AsyncSession, workspace_id: UUID) -> None:
        self.db = db
        self.workspace_id = workspace_id

    async def assemble(
        self,
        *,
        feature: AIFeature,
        request_id: UUID | None = None,
        execution_id: UUID | None = None,
        environment_id: UUID | None = None,
        budget: int = 8000,
    ) -> AIContext:
        secrets = await self._secret_values(environment_id)
        items: list[ContextItem] = []

        request_row: ApiRequest | None = None
        if request_id:
            request_row = await self.db.scalar(
                select(ApiRequest)
                .join(Collection, ApiRequest.collection_id == Collection.id)
                .where(ApiRequest.id == request_id, Collection.workspace_id == self.workspace_id)
            )

        if request_row:
            items.append(self._request_item(request_row, secrets))
            if auth_item := self._auth_item(request_row):
                items.append(auth_item)

            collection = await self.db.get(Collection, request_row.collection_id)
            if collection:
                items.append(self._collection_item(collection))
                items.append(await self._siblings_item(collection, request_row))

            if request_row.docs_markdown:
                items.append(
                    ContextItem(
                        kind=ContextKind.EXISTING_DOCS,
                        label="Existing documentation",
                        content=request_row.docs_markdown[:3000],
                        priority=5,
                    )
                )
            if request_row.tests_code:
                items.append(
                    ContextItem(
                        kind=ContextKind.EXISTING_TESTS,
                        label=f"Existing tests ({request_row.tests_framework})",
                        content=request_row.tests_code[:3000],
                        priority=5,
                    )
                )

        execution = await self._load_execution(execution_id, request_id)
        if execution:
            items.append(self._response_item(execution, secrets))

        if request_id and (history := await self._history_item(request_id)):
            items.append(history)

        if env_item := await self._environment_item(environment_id):
            items.append(env_item)

        return self._budget(items, feature, budget)

    # ------------------------------------------------------------------ #
    # Item builders
    # ------------------------------------------------------------------ #
    def _request_item(self, req: ApiRequest, secrets: dict[str, str]) -> ContextItem:
        body = req.body or {}
        payload = {
            "name": req.name,
            "method": req.method,
            "url": req.url,
            "headers": [
                {"key": h.get("key"), "value": h.get("value")}
                for h in req.headers or []
                if h.get("enabled", True)
            ],
            "query_params": [
                {"key": q.get("key"), "value": q.get("value")}
                for q in req.query_params or []
                if q.get("enabled", True)
            ],
            "body_mode": body.get("mode", "none"),
            "body": (body.get("content") or "")[:2000],
        }
        return ContextItem(
            kind=ContextKind.REQUEST,
            label=f"Request: {req.method} {req.name}",
            content=json.dumps(redact_mapping(payload, secrets), indent=2),
            priority=1,
        )

    def _auth_item(self, req: ApiRequest) -> ContextItem | None:
        auth = req.auth
        if not auth or auth.get("type") in (None, "none", "inherit"):
            return None
        # The auth *shape* is what matters for diagnosis; the credential itself
        # never helps the model and must never be sent.
        redacted = {"type": auth.get("type")}
        if auth.get("type") == "api_key":
            redacted["key"] = auth.get("key", "")
            redacted["add_to"] = auth.get("add_to", "header")
        return ContextItem(
            kind=ContextKind.AUTH,
            label=f"Auth: {auth.get('type')}",
            content=json.dumps(redacted, indent=2) + "\n(credential values withheld)",
            priority=3,
        )

    def _response_item(self, execution: Execution, secrets: dict[str, str]) -> ContextItem:
        body = (execution.response_body or "")[:MAX_BODY_CHARS]
        truncated = len(execution.response_body or "") > MAX_BODY_CHARS
        payload = {
            "status": execution.status_code,
            "duration_ms": execution.duration_ms,
            "content_type": execution.content_type,
            "headers": dict(list((execution.response_headers or {}).items())[:20]),
            "body": body + ("\n…(truncated)" if truncated else ""),
            "error": execution.error_message,
        }
        return ContextItem(
            kind=ContextKind.RESPONSE,
            label=f"Response: {execution.status_code or 'failed'}",
            content=json.dumps(redact_mapping(payload, secrets), indent=2),
            priority=1,
        )

    def _collection_item(self, collection: Collection) -> ContextItem:
        payload = {
            "name": collection.name,
            "description": collection.description,
            "base_url": collection.base_url,
            "auth_type": (collection.auth or {}).get("type", "none"),
        }
        return ContextItem(
            kind=ContextKind.COLLECTION,
            label=f"Collection: {collection.name}",
            content=json.dumps(payload, indent=2),
            priority=6,
        )

    async def _siblings_item(self, collection: Collection, current: ApiRequest) -> ContextItem:
        """Neighbouring requests, so generated output matches existing conventions.

        This is what stops the model inventing a different header casing or URL
        style than the rest of the collection uses.
        """
        rows = await self.db.execute(
            select(ApiRequest)
            .where(ApiRequest.collection_id == collection.id, ApiRequest.id != current.id)
            .limit(15)
        )
        siblings = [{"name": r.name, "method": r.method, "url": r.url} for r in rows.scalars()]
        return ContextItem(
            kind=ContextKind.SIBLINGS,
            label=f"{len(siblings)} other requests in this collection",
            content=json.dumps(siblings, indent=2),
            priority=5,
        )

    async def _history_item(self, request_id: UUID) -> ContextItem | None:
        rows = await self.db.execute(
            select(Execution)
            .where(Execution.request_id == request_id)
            .order_by(Execution.created_at.desc())
            .limit(5)
        )
        history = [
            {
                "at": e.created_at.isoformat(),
                "status": e.status_code,
                "duration_ms": e.duration_ms,
                "error": e.error_message,
            }
            for e in rows.scalars()
        ]
        if not history:
            return None
        return ContextItem(
            kind=ContextKind.HISTORY,
            label=f"Last {len(history)} runs of this request",
            content=json.dumps(history, indent=2),
            priority=4,
        )

    async def _environment_item(self, environment_id: UUID | None) -> ContextItem | None:
        env = await self._load_environment(environment_id)
        if env is None:
            return None
        # Names only. Knowing that `api_token` exists is what the model needs to
        # diagnose a 401; knowing its value adds nothing and risks everything.
        listing = [
            {"key": v.key, "secret": v.is_secret, "defined": bool(v.value or v.value_encrypted)}
            for v in env.variables
            if v.enabled
        ]
        return ContextItem(
            kind=ContextKind.ENVIRONMENT,
            label=f"Environment '{env.name}' ({len(listing)} variables, values hidden)",
            content=json.dumps(listing, indent=2),
            priority=3,
        )

    # ------------------------------------------------------------------ #
    # Loading helpers
    # ------------------------------------------------------------------ #
    async def _load_environment(self, environment_id: UUID | None) -> Environment | None:
        from sqlalchemy.orm import selectinload

        stmt = (
            select(Environment)
            .where(Environment.workspace_id == self.workspace_id)
            .options(selectinload(Environment.variables))
        )
        stmt = (
            stmt.where(Environment.id == environment_id)
            if environment_id
            else stmt.where(Environment.is_default.is_(True))
        )
        return await self.db.scalar(stmt)

    async def _secret_values(self, environment_id: UUID | None) -> dict[str, str]:
        """Decrypt secrets solely so the redactor can find and mask them."""
        from app.modules.execution.resolver import build_variable_set

        env = await self._load_environment(environment_id)
        return build_variable_set(env).secrets

    async def _load_execution(
        self, execution_id: UUID | None, request_id: UUID | None
    ) -> Execution | None:
        if execution_id:
            return await self.db.scalar(
                select(Execution).where(
                    Execution.id == execution_id, Execution.workspace_id == self.workspace_id
                )
            )
        if request_id:
            return await self.db.scalar(
                select(Execution)
                .where(
                    Execution.request_id == request_id,
                    Execution.workspace_id == self.workspace_id,
                )
                .order_by(Execution.created_at.desc())
                .limit(1)
            )
        return None

    # ------------------------------------------------------------------ #
    # Budgeting
    # ------------------------------------------------------------------ #
    def _budget(self, items: list[ContextItem], feature: AIFeature, budget: int) -> AIContext:
        order = PRIORITIES.get(feature, PRIORITIES[AIFeature.CHAT])
        rank = {kind: index for index, kind in enumerate(order)}

        items.sort(key=lambda i: (rank.get(i.kind, 99), i.priority))

        used = 0
        for item in items:
            if used + item.tokens <= budget:
                item.included = True
                used += item.tokens
            else:
                # Marked, not deleted — the manifest shows the user exactly what
                # didn't fit rather than leaving them wondering.
                item.included = False

        return AIContext(items=items, budget=budget)


def redact_user_message(text: str, secrets: dict[str, str]) -> str:
    return redact_text(text, secrets)
