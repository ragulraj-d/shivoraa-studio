"""AI endpoints: streaming chat, conversations, provider management, usage."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Annotated
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, status
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from app.core.config import settings
from app.core.deps import Auth, DbSession, RequireOwner
from app.core.errors import NotFoundError
from app.core.security import crypto
from app.models.ai import (
    AIConversation,
    AIFeature,
    AIMessage,
    AIProvider,
    AIUsage,
    ProviderType,
)
from app.modules.ai.providers import DEFAULT_MODELS, build_adapter
from app.modules.ai.service import AIService
from app.schemas.ai import (
    ChatRequest,
    ConversationDetail,
    ConversationResponse,
    FeedbackRequest,
    HealthCheckResponse,
    MessageResponse,
    ProviderCreate,
    ProviderResponse,
    ProviderUpdate,
    UsageSummary,
)

log = structlog.get_logger()
router = APIRouter(prefix="/ai", tags=["ai"])


def get_ai_service(ctx: Auth, db: DbSession) -> AIService:
    return AIService(db, ctx.workspace, ctx.user)


Service = Annotated[AIService, Depends(get_ai_service)]


# --------------------------------------------------------------------------- #
# Chat (SSE)
# --------------------------------------------------------------------------- #
@router.post("/chat")
async def chat(
    payload: ChatRequest, ctx: Auth, db: DbSession, service: Service
) -> EventSourceResponse:
    """Stream a contextual AI response.

    SSE rather than WebSockets: the flow is unidirectional, it survives every
    corporate proxy, and browsers reconnect natively. WebSockets are reserved for
    the WebSocket *testing* feature, which is a different concern.
    """
    feature = AIFeature(payload.feature)

    conversation = await service.get_or_create_conversation(
        payload.conversation_id,
        feature=feature,
        request_id=payload.request_id,
        first_message=payload.message,
    )

    context = await service.context_manager().assemble(
        feature=feature,
        request_id=payload.request_id,
        execution_id=payload.execution_id,
        environment_id=payload.environment_id,
        budget=settings.ai_context_token_budget,
    )

    async def event_stream() -> AsyncIterator[dict[str, str]]:
        try:
            async for event_name, data in service.stream_completion(
                conversation=conversation,
                user_message=payload.message,
                feature=feature,
                context=context,
                request_id=payload.request_id,
                temperature=payload.temperature,
            ):
                yield {"event": event_name, "data": json.dumps(data, default=str)}
            await db.commit()
        except Exception as exc:  # noqa: BLE001 — a stream must end with a message, not a hang
            log.exception("ai_stream_failed")
            await db.rollback()
            yield {
                "event": "error",
                "data": json.dumps(
                    {
                        "detail": str(exc) or "The AI request failed.",
                        "hint": "Try again, or switch provider in Settings.",
                    }
                ),
            }

    return EventSourceResponse(event_stream())


# --------------------------------------------------------------------------- #
# Conversations
# --------------------------------------------------------------------------- #
@router.get("/conversations", response_model=list[ConversationResponse])
async def list_conversations(
    ctx: Auth, db: DbSession, limit: int = 50
) -> list[ConversationResponse]:
    rows = await db.execute(
        select(AIConversation)
        .where(
            AIConversation.workspace_id == ctx.workspace_id,
            AIConversation.user_id == ctx.user_id,
        )
        .order_by(AIConversation.updated_at.desc())
        .limit(limit)
    )
    return [
        ConversationResponse(
            id=c.id,
            title=c.title,
            feature=c.feature.value,
            request_id=c.request_id,
            created_at=c.created_at,
            updated_at=c.updated_at,
        )
        for c in rows.scalars()
    ]


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
async def get_conversation(conversation_id: UUID, ctx: Auth, db: DbSession) -> ConversationDetail:
    conversation = await db.scalar(
        select(AIConversation)
        .where(
            AIConversation.id == conversation_id,
            AIConversation.workspace_id == ctx.workspace_id,
        )
        .options(selectinload(AIConversation.messages))
    )
    if conversation is None:
        raise NotFoundError("That conversation doesn't exist.")

    return ConversationDetail(
        id=conversation.id,
        title=conversation.title,
        feature=conversation.feature.value,
        request_id=conversation.request_id,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        messages=[MessageResponse.model_validate(m) for m in conversation.messages],
    )


@router.delete("/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(conversation_id: UUID, ctx: Auth, db: DbSession) -> None:
    conversation = await db.scalar(
        select(AIConversation).where(
            AIConversation.id == conversation_id,
            AIConversation.workspace_id == ctx.workspace_id,
        )
    )
    if conversation:
        await db.delete(conversation)


@router.post("/messages/{message_id}/feedback", status_code=status.HTTP_204_NO_CONTENT)
async def submit_feedback(
    message_id: UUID, payload: FeedbackRequest, ctx: Auth, db: DbSession
) -> None:
    message = await db.scalar(
        select(AIMessage)
        .join(AIConversation, AIMessage.conversation_id == AIConversation.id)
        .where(AIMessage.id == message_id, AIConversation.workspace_id == ctx.workspace_id)
    )
    if message is None:
        raise NotFoundError("That message doesn't exist.")
    message.feedback = payload.value


# --------------------------------------------------------------------------- #
# Providers
# --------------------------------------------------------------------------- #
def _provider_response(provider: AIProvider) -> ProviderResponse:
    return ProviderResponse(
        id=provider.id,
        type=provider.type.value,
        name=provider.name,
        base_url=provider.base_url,
        default_model=provider.default_model,
        enabled=provider.enabled,
        feature_overrides=provider.feature_overrides or {},
        last_health_status=provider.last_health_status,
        last_health_message=provider.last_health_message,
        has_key=provider.api_key_encrypted is not None,
        created_at=provider.created_at,
    )


@router.get("/providers", response_model=list[ProviderResponse])
async def list_providers(ctx: Auth, db: DbSession) -> list[ProviderResponse]:
    rows = await db.execute(
        select(AIProvider)
        .where(AIProvider.workspace_id == ctx.workspace_id)
        .order_by(AIProvider.created_at)
    )
    return [_provider_response(p) for p in rows.scalars()]


@router.post("/providers", response_model=ProviderResponse, status_code=201)
async def create_provider(
    payload: ProviderCreate, ctx: RequireOwner, service: Service
) -> ProviderResponse:
    provider_type = ProviderType(payload.type)
    provider = await service.create_provider(
        provider_type=provider_type,
        name=payload.name,
        api_key=payload.api_key,
        base_url=payload.base_url,
        default_model=payload.default_model or DEFAULT_MODELS[provider_type],
    )
    return _provider_response(provider)


@router.patch("/providers/{provider_id}", response_model=ProviderResponse)
async def update_provider(
    provider_id: UUID, payload: ProviderUpdate, ctx: RequireOwner, db: DbSession
) -> ProviderResponse:
    provider = await db.scalar(
        select(AIProvider).where(
            AIProvider.id == provider_id, AIProvider.workspace_id == ctx.workspace_id
        )
    )
    if provider is None:
        raise NotFoundError("That provider isn't configured in this workspace.")

    data = payload.model_dump(exclude_unset=True)
    if api_key := data.pop("api_key", None):
        provider.api_key_encrypted = crypto.encrypt(api_key)
    for field_name, value in data.items():
        setattr(provider, field_name, value)

    return _provider_response(provider)


@router.delete("/providers/{provider_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_provider(provider_id: UUID, ctx: RequireOwner, db: DbSession) -> None:
    provider = await db.scalar(
        select(AIProvider).where(
            AIProvider.id == provider_id, AIProvider.workspace_id == ctx.workspace_id
        )
    )
    if provider:
        if ctx.workspace.default_provider_id == provider.id:
            ctx.workspace.default_provider_id = None
        await db.delete(provider)


@router.post("/providers/{provider_id}/health", response_model=HealthCheckResponse)
async def check_provider_health(
    provider_id: UUID, ctx: Auth, db: DbSession, service: Service
) -> HealthCheckResponse:
    provider = await db.scalar(
        select(AIProvider).where(
            AIProvider.id == provider_id, AIProvider.workspace_id == ctx.workspace_id
        )
    )
    if provider is None:
        raise NotFoundError("That provider isn't configured in this workspace.")
    ok, message, models = await service.check_health(provider)
    return HealthCheckResponse(ok=ok, message=message, models=models)


@router.post("/providers/test", response_model=HealthCheckResponse)
async def test_provider_credentials(payload: ProviderCreate, ctx: Auth) -> HealthCheckResponse:
    """Validate credentials before saving, so a typo never becomes a stored provider."""
    provider_type = ProviderType(payload.type)
    transient = AIProvider(
        workspace_id=ctx.workspace_id,
        type=provider_type,
        name=payload.name,
        api_key_encrypted=crypto.encrypt(payload.api_key) if payload.api_key else None,
        base_url=payload.base_url,
        default_model=payload.default_model or DEFAULT_MODELS[provider_type],
    )
    adapter = build_adapter(transient)
    health = await adapter.health()  # type: ignore[attr-defined]
    return HealthCheckResponse(ok=health.ok, message=health.message, models=health.models)


# --------------------------------------------------------------------------- #
# Usage
# --------------------------------------------------------------------------- #
@router.get("/usage", response_model=UsageSummary)
async def usage_summary(ctx: Auth, db: DbSession, days: int = 30) -> UsageSummary:
    from datetime import UTC, datetime, timedelta

    since = datetime.now(UTC) - timedelta(days=days)

    rows = await db.execute(
        select(
            AIUsage.provider_type,
            AIUsage.feature,
            func.sum(AIUsage.cost_usd),
            func.sum(AIUsage.prompt_tokens + AIUsage.completion_tokens),
            func.count(),
        )
        .where(AIUsage.workspace_id == ctx.workspace_id, AIUsage.created_at >= since)
        .group_by(AIUsage.provider_type, AIUsage.feature)
    )

    by_provider: dict[str, dict[str, object]] = {}
    by_feature: dict[str, dict[str, object]] = {}
    total_cost = 0
    total_tokens = 0
    total_calls = 0

    for provider_type, feature, cost, tokens, calls in rows.all():
        cost = cost or 0
        tokens = tokens or 0
        total_cost += cost
        total_tokens += tokens
        total_calls += calls

        entry = by_provider.setdefault(provider_type, {"cost_usd": 0, "tokens": 0, "calls": 0})
        entry["cost_usd"] += cost  # type: ignore[operator]
        entry["tokens"] += tokens  # type: ignore[operator]
        entry["calls"] += calls  # type: ignore[operator]

        key = feature.value if hasattr(feature, "value") else str(feature)
        fentry = by_feature.setdefault(key, {"cost_usd": 0, "tokens": 0, "calls": 0})
        fentry["cost_usd"] += cost  # type: ignore[operator]
        fentry["tokens"] += tokens  # type: ignore[operator]
        fentry["calls"] += calls  # type: ignore[operator]

    return UsageSummary(
        total_cost_usd=total_cost,
        total_tokens=total_tokens,
        calls=total_calls,
        by_provider=by_provider,
        by_feature=by_feature,
    )
