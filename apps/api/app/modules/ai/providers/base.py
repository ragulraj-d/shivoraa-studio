"""The provider abstraction.

Every AI vendor is reduced to this one interface. That boundary is the entire
defence against provider drift: model names, pricing, and request shapes change
constantly, and confining that churn to one adapter per vendor keeps it out of
the rest of the codebase.

Capabilities are negotiated rather than hardcoded, so a feature that needs tool
calling asks the provider instead of assuming based on a model name string.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Protocol, runtime_checkable


@dataclass(slots=True)
class Message:
    role: str  # system | user | assistant
    content: str


@dataclass(slots=True)
class ProviderCapabilities:
    streaming: bool = True
    tools: bool = False
    vision: bool = False
    json_mode: bool = False
    max_context_tokens: int = 8192


@dataclass(slots=True)
class TokenUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total(self) -> int:
        return self.prompt_tokens + self.completion_tokens


@dataclass(slots=True)
class CompletionRequest:
    messages: list[Message]
    model: str
    temperature: float = 0.3
    max_tokens: int = 4096
    system: str | None = None
    json_mode: bool = False


@dataclass(slots=True)
class StreamChunk:
    text: str = ""
    done: bool = False
    usage: TokenUsage | None = None


@dataclass(slots=True)
class HealthStatus:
    ok: bool
    message: str = ""
    models: list[str] = field(default_factory=list)


@runtime_checkable
class AIProviderAdapter(Protocol):
    type: str

    @property
    def capabilities(self) -> ProviderCapabilities: ...

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamChunk]: ...

    async def health(self) -> HealthStatus: ...

    def estimate_cost(self, model: str, usage: TokenUsage) -> Decimal: ...


class ProviderError(Exception):
    """A provider call failed in a way the user can act on."""

    def __init__(self, message: str, *, hint: str = "", retryable: bool = False) -> None:
        self.message = message
        self.hint = hint
        self.retryable = retryable
        super().__init__(message)


def approx_tokens(text: str) -> int:
    """Rough token estimate for budgeting before a call.

    ~4 characters per token holds well enough for English prose and JSON to size
    a context window. Real counts come back from the provider afterwards and are
    what gets billed and recorded.
    """
    return max(1, len(text) // 4)


# Per-million-token pricing, USD. Kept in one table so cost reporting has a
# single source of truth; unknown models fall back to zero rather than guessing.
PRICING: dict[str, tuple[Decimal, Decimal]] = {
    # OpenAI
    "gpt-4o": (Decimal("2.50"), Decimal("10.00")),
    "gpt-4o-mini": (Decimal("0.15"), Decimal("0.60")),
    "gpt-4.1": (Decimal("2.00"), Decimal("8.00")),
    "gpt-4.1-mini": (Decimal("0.40"), Decimal("1.60")),
    "o4-mini": (Decimal("1.10"), Decimal("4.40")),
    # Anthropic
    "claude-opus-4-20250514": (Decimal("15.00"), Decimal("75.00")),
    "claude-sonnet-4-20250514": (Decimal("3.00"), Decimal("15.00")),
    "claude-3-5-haiku-20241022": (Decimal("0.80"), Decimal("4.00")),
    # Google
    "gemini-2.0-flash": (Decimal("0.10"), Decimal("0.40")),
    "gemini-1.5-pro": (Decimal("1.25"), Decimal("5.00")),
    # Groq
    "llama-3.3-70b-versatile": (Decimal("0.59"), Decimal("0.79")),
    "llama-3.1-8b-instant": (Decimal("0.05"), Decimal("0.08")),
}


def price_for(model: str, usage: TokenUsage) -> Decimal:
    prompt_rate, completion_rate = PRICING.get(model, (Decimal(0), Decimal(0)))
    million = Decimal(1_000_000)
    return (
        Decimal(usage.prompt_tokens) / million * prompt_rate
        + Decimal(usage.completion_tokens) / million * completion_rate
    ).quantize(Decimal("0.000001"))


def to_dict(obj: Any) -> dict[str, Any]:
    return {k: getattr(obj, k) for k in obj.__slots__}  # type: ignore[attr-defined]
