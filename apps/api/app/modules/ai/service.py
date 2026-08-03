"""AI orchestration: pick a provider, assemble context, stream, account for cost."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from decimal import Decimal
from uuid import UUID

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import UpstreamError, ValidationError
from app.core.security import crypto
from app.models.ai import (
    AIConversation,
    AIFeature,
    AIMessage,
    AIProvider,
    AIUsage,
    ProviderType,
)
from app.models.user import User
from app.models.workspace import Workspace
from app.modules.ai.context import AIContext, ContextManager
from app.modules.ai.prompts import system_prompt
from app.modules.ai.providers import (
    CompletionRequest,
    Message,
    ProviderError,
    build_adapter,
)

log = structlog.get_logger()


@dataclass(slots=True)
class ResolvedProvider:
    adapter: object
    model: str
    provider_type: str
    provider_id: UUID | None
    is_trial: bool = False


class AIService:
    def __init__(self, db: AsyncSession, workspace: Workspace, user: User) -> None:
        self.db = db
        self.workspace = workspace
        self.user = user

    # ------------------------------------------------------------------ #
    # Provider resolution
    # ------------------------------------------------------------------ #
    async def resolve_provider(self, feature: AIFeature) -> ResolvedProvider:
        """Pick the provider for this feature.

        Order: an explicit per-feature override, then the workspace default,
        then any enabled provider, then the platform trial key. Per-feature
        routing is the main cost lever — documentation on a cheap model and
        debugging on a strong one is a large saving for output a human edits
        anyway.
        """
        providers = list(
            (
                await self.db.execute(
                    select(AIProvider).where(
                        AIProvider.workspace_id == self.workspace.id,
                        AIProvider.enabled.is_(True),
                    )
                )
            ).scalars()
        )

        chosen: AIProvider | None = None
        model: str | None = None

        for provider in providers:
            override = (provider.feature_overrides or {}).get(feature.value)
            if override:
                chosen, model = provider, override
                break

        if chosen is None and self.workspace.default_provider_id:
            chosen = next(
                (p for p in providers if p.id == self.workspace.default_provider_id), None
            )

        if chosen is None and providers:
            chosen = providers[0]

        if chosen is not None:
            return ResolvedProvider(
                adapter=build_adapter(chosen),
                model=model or chosen.default_model,
                provider_type=chosen.type.value,
                provider_id=chosen.id,
            )

        return await self._trial_provider()

    async def _trial_provider(self) -> ResolvedProvider:
        """Platform-key trial so a new user experiences AI before configuring anything.

        Without this, the first AI action requires signing up for a third-party
        account and pasting a key — which is where most people stop.
        """
        import os

        trial_key = os.getenv("SHIVORAA_TRIAL_OPENAI_KEY", "")
        if not trial_key:
            raise ValidationError(
                "No AI provider is connected yet.",
                hint="Add a provider in Settings → Providers to use AI features.",
                code="no_provider",
            )

        if self.user.ai_trial_used >= settings.ai_trial_actions:
            raise ValidationError(
                f"You've used all {settings.ai_trial_actions} free AI actions.",
                hint="Connect your own API key in Settings → Providers to keep going.",
                code="trial_exhausted",
            )

        from app.modules.ai.providers.openai_like import OpenAICompatibleAdapter

        return ResolvedProvider(
            adapter=OpenAICompatibleAdapter(api_key=trial_key, provider_type="openai"),
            model="gpt-4o-mini",
            provider_type="openai",
            provider_id=None,
            is_trial=True,
        )

    # ------------------------------------------------------------------ #
    # Conversations
    # ------------------------------------------------------------------ #
    async def get_or_create_conversation(
        self,
        conversation_id: UUID | None,
        *,
        feature: AIFeature,
        request_id: UUID | None,
        first_message: str,
    ) -> AIConversation:
        if conversation_id:
            conversation = await self.db.scalar(
                select(AIConversation).where(
                    AIConversation.id == conversation_id,
                    AIConversation.workspace_id == self.workspace.id,
                )
            )
            if conversation:
                return conversation

        title = first_message.strip()[:60] or "New conversation"
        conversation = AIConversation(
            workspace_id=self.workspace.id,
            user_id=self.user.id,
            title=title,
            feature=feature,
            request_id=request_id,
        )
        self.db.add(conversation)
        await self.db.flush()
        return conversation

    async def history(self, conversation: AIConversation, limit: int = 20) -> list[Message]:
        rows = await self.db.execute(
            select(AIMessage)
            .where(AIMessage.conversation_id == conversation.id)
            .order_by(AIMessage.created_at.desc())
            .limit(limit)
        )
        messages = list(rows.scalars())[::-1]
        return [Message(role=m.role, content=m.content) for m in messages]

    # ------------------------------------------------------------------ #
    # Streaming completion
    # ------------------------------------------------------------------ #
    async def stream_completion(
        self,
        *,
        conversation: AIConversation,
        user_message: str,
        feature: AIFeature,
        context: AIContext,
        request_id: UUID | None = None,
        temperature: float = 0.3,
    ) -> AsyncIterator[tuple[str, object]]:
        """Yield (event_name, payload) pairs for the SSE endpoint.

        The context manifest is emitted *before* the model's first token, so the
        user can see what was sent while it is being sent.
        """
        provider = await self.resolve_provider(feature)

        yield (
            "context",
            {
                "items": context.manifest(),
                "dropped": context.dropped,
                "provider": provider.provider_type,
                "model": provider.model,
                "is_trial": provider.is_trial,
            },
        )

        self.db.add(
            AIMessage(
                conversation_id=conversation.id,
                role="user",
                content=user_message,
                context_manifest=context.manifest(),
            )
        )
        await self.db.flush()

        history = await self.history(conversation)
        messages = [*history, Message(role="user", content=user_message)]

        completion = CompletionRequest(
            messages=messages,
            model=provider.model,
            temperature=temperature,
            system=system_prompt(feature, context.render()),
            json_mode=feature == AIFeature.GENERATE_REQUEST,
        )

        started = time.perf_counter()
        collected: list[str] = []
        usage = None

        try:
            async for chunk in provider.adapter.stream(completion):  # type: ignore[attr-defined]
                if chunk.text:
                    collected.append(chunk.text)
                    yield "token", {"text": chunk.text}
                if chunk.done:
                    usage = chunk.usage
        except ProviderError as exc:
            log.warning("ai_provider_error", provider=provider.provider_type, error=exc.message)
            await self._record_usage(feature, provider, None, 0, success=False)
            yield (
                "error",
                {
                    "detail": exc.message,
                    "hint": exc.hint,
                    "retryable": exc.retryable,
                    "provider": provider.provider_type,
                },
            )
            return

        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        text = "".join(collected)
        cost = Decimal(0)
        if usage:
            cost = provider.adapter.estimate_cost(provider.model, usage)  # type: ignore[attr-defined]

        self.db.add(
            AIMessage(
                conversation_id=conversation.id,
                role="assistant",
                content=text,
                provider_type=provider.provider_type,
                model=provider.model,
                prompt_tokens=usage.prompt_tokens if usage else None,
                completion_tokens=usage.completion_tokens if usage else None,
                cost_usd=cost,
                latency_ms=latency_ms,
            )
        )
        await self._record_usage(feature, provider, usage, latency_ms, cost=cost)

        if provider.is_trial:
            self.user.ai_trial_used += 1

        await self.db.flush()

        yield (
            "done",
            {
                "conversation_id": str(conversation.id),
                "latency_ms": latency_ms,
                "tokens": {
                    "prompt": usage.prompt_tokens if usage else 0,
                    "completion": usage.completion_tokens if usage else 0,
                },
                "cost_usd": str(cost),
                "trial_remaining": (
                    max(0, settings.ai_trial_actions - self.user.ai_trial_used)
                    if provider.is_trial
                    else None
                ),
            },
        )

    async def _record_usage(
        self,
        feature: AIFeature,
        provider: ResolvedProvider,
        usage: object,
        latency_ms: float,
        *,
        cost: Decimal = Decimal(0),
        success: bool = True,
    ) -> None:
        self.db.add(
            AIUsage(
                workspace_id=self.workspace.id,
                user_id=self.user.id,
                feature=feature,
                provider_type=provider.provider_type,
                model=provider.model,
                prompt_tokens=getattr(usage, "prompt_tokens", 0) or 0,
                completion_tokens=getattr(usage, "completion_tokens", 0) or 0,
                cost_usd=cost,
                latency_ms=latency_ms,
                success=success,
                is_trial=provider.is_trial,
            )
        )

    # ------------------------------------------------------------------ #
    # Provider management
    # ------------------------------------------------------------------ #
    async def create_provider(
        self,
        *,
        provider_type: ProviderType,
        name: str,
        api_key: str | None,
        base_url: str | None,
        default_model: str,
    ) -> AIProvider:
        provider = AIProvider(
            workspace_id=self.workspace.id,
            type=provider_type,
            name=name,
            api_key_encrypted=crypto.encrypt(api_key) if api_key else None,
            base_url=base_url,
            default_model=default_model,
        )
        self.db.add(provider)
        await self.db.flush()

        # Validate the key immediately. Accepting it blindly means the user
        # discovers a typo days later and blames the product.
        adapter = build_adapter(provider)
        health = await adapter.health()  # type: ignore[attr-defined]
        provider.last_health_status = "ok" if health.ok else "error"
        provider.last_health_message = health.message

        if not health.ok:
            raise UpstreamError(
                f"Couldn't connect to {name}: {health.message}",
                hint="Check the API key and base URL, then try again.",
            )

        if not self.workspace.default_provider_id:
            self.workspace.default_provider_id = provider.id

        return provider

    async def check_health(self, provider: AIProvider) -> tuple[bool, str, list[str]]:
        try:
            adapter = build_adapter(provider)
            health = await adapter.health()  # type: ignore[attr-defined]
            provider.last_health_status = "ok" if health.ok else "error"
            provider.last_health_message = health.message
            return health.ok, health.message, health.models
        except ProviderError as exc:
            provider.last_health_status = "error"
            provider.last_health_message = exc.message
            return False, exc.message, []

    def context_manager(self) -> ContextManager:
        return ContextManager(self.db, self.workspace.id)
