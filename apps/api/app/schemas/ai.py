"""AI schemas."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    conversation_id: UUID | None = None
    feature: Literal[
        "chat", "debug", "generate_request", "generate_docs", "generate_tests", "security"
    ] = "chat"
    request_id: UUID | None = None
    execution_id: UUID | None = None
    environment_id: UUID | None = None
    temperature: float = Field(default=0.3, ge=0.0, le=2.0)
    # Per-message, never sticky. Sending secret values is always a deliberate act.
    include_secret_values: bool = False


class ContextItemResponse(BaseModel):
    kind: str
    label: str
    tokens: int
    included: bool


class MessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    role: str
    content: str
    context_manifest: list[dict[str, Any]]
    suggested_actions: list[dict[str, Any]]
    provider_type: str | None
    model: str | None
    prompt_tokens: int | None
    completion_tokens: int | None
    cost_usd: Decimal | None
    latency_ms: float | None
    feedback: int | None
    created_at: datetime


class ConversationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    feature: str
    request_id: UUID | None
    created_at: datetime
    updated_at: datetime


class ConversationDetail(ConversationResponse):
    messages: list[MessageResponse] = Field(default_factory=list)


class ProviderCreate(BaseModel):
    type: Literal["openai", "anthropic", "gemini", "groq", "ollama", "oci", "custom"]
    name: str = Field(min_length=1, max_length=120)
    api_key: str | None = None
    base_url: str | None = None
    default_model: str | None = None


class ProviderUpdate(BaseModel):
    name: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    default_model: str | None = None
    enabled: bool | None = None
    feature_overrides: dict[str, str] | None = None


class ProviderResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    type: str
    name: str
    base_url: str | None
    default_model: str
    enabled: bool
    feature_overrides: dict[str, str]
    last_health_status: str | None
    last_health_message: str | None
    has_key: bool
    created_at: datetime


class HealthCheckResponse(BaseModel):
    ok: bool
    message: str
    models: list[str] = Field(default_factory=list)


class FeedbackRequest(BaseModel):
    value: Literal[-1, 1]


class UsageSummary(BaseModel):
    total_cost_usd: Decimal
    total_tokens: int
    calls: int
    by_provider: dict[str, dict[str, Any]]
    by_feature: dict[str, dict[str, Any]]
