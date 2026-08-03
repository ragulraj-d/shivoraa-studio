"""AI providers, conversations, messages, and usage accounting."""

from __future__ import annotations

import enum
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import (
    Boolean,
    Enum,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base, TimestampMixin, UUIDMixin
from app.core.types import GUID, JSONType


class ProviderType(str, enum.Enum):
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    GEMINI = "gemini"
    GROQ = "groq"
    OLLAMA = "ollama"
    OCI = "oci"
    CUSTOM = "custom"  # any OpenAI-compatible endpoint


class AIFeature(str, enum.Enum):
    CHAT = "chat"
    GENERATE_REQUEST = "generate_request"
    GENERATE_DOCS = "generate_docs"
    GENERATE_TESTS = "generate_tests"
    DEBUG = "debug"
    SECURITY = "security"


class AIProvider(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "ai_providers"

    workspace_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    type: Mapped[ProviderType] = mapped_column(Enum(ProviderType, name="provider_type"))
    name: Mapped[str] = mapped_column(String(120), nullable=False)

    # Never stored in plaintext. Ollama and some self-hosted endpoints need no key.
    api_key_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    base_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    default_model: Mapped[str] = mapped_column(String(120), nullable=False)

    config: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # {"generate_docs": "gpt-4o-mini", "debug": "gpt-4o"} — the cost lever.
    feature_overrides: Mapped[dict[str, str]] = mapped_column(
        JSONType, default=dict, nullable=False
    )

    last_health_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    last_health_message: Mapped[str | None] = mapped_column(Text, nullable=True)


class AIConversation(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "ai_conversations"

    workspace_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(200), default="New conversation", nullable=False)
    feature: Mapped[AIFeature] = mapped_column(
        Enum(AIFeature, name="ai_feature"), default=AIFeature.CHAT, nullable=False
    )
    # Anchors the conversation to what the user was looking at.
    request_id: Mapped[UUID | None] = mapped_column(
        GUID(), ForeignKey("api_requests.id", ondelete="SET NULL"), nullable=True
    )

    messages: Mapped[list[AIMessage]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="AIMessage.created_at",
    )


class AIMessage(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "ai_messages"

    conversation_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("ai_conversations.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False)  # user | assistant | system
    content: Mapped[str] = mapped_column(Text, nullable=False)

    # The exact context manifest sent with this message, persisted so a
    # historical message stays inspectable — the UI panel reads this same
    # structure, so what the user sees cannot drift from what was sent.
    context_manifest: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONType, default=list, nullable=False
    )
    # Structured actions the model proposed, e.g. a request patch to apply.
    suggested_actions: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONType, default=list, nullable=False
    )

    provider_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    model: Mapped[str | None] = mapped_column(String(120), nullable=True)
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 6), nullable=True)
    latency_ms: Mapped[float | None] = mapped_column(nullable=True)
    feedback: Mapped[int | None] = mapped_column(Integer, nullable=True)  # +1 / -1

    conversation: Mapped[AIConversation] = relationship(back_populates="messages")


class AIUsage(Base, UUIDMixin, TimestampMixin):
    """One row per AI call. Cost analytics reads this and nothing else."""

    __tablename__ = "ai_usage"

    workspace_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    feature: Mapped[AIFeature] = mapped_column(Enum(AIFeature, name="ai_feature"))
    provider_type: Mapped[str] = mapped_column(String(32), nullable=False)
    model: Mapped[str] = mapped_column(String(120), nullable=False)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), default=0, nullable=False)
    latency_ms: Mapped[float | None] = mapped_column(nullable=True)
    success: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_trial: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    __table_args__ = (Index("ix_usage_ws_created", "workspace_id", "created_at"),)
