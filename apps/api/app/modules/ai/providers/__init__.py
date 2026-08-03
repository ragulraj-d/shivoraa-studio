"""Provider registry: turns a stored AIProvider row into a live adapter."""

from __future__ import annotations

from app.core.security import crypto
from app.models.ai import AIProvider, ProviderType
from app.modules.ai.providers.anthropic import AnthropicAdapter
from app.modules.ai.providers.base import (
    AIProviderAdapter,
    CompletionRequest,
    HealthStatus,
    Message,
    ProviderCapabilities,
    ProviderError,
    StreamChunk,
    TokenUsage,
    approx_tokens,
)
from app.modules.ai.providers.gemini import GeminiAdapter
from app.modules.ai.providers.openai_like import OllamaAdapter, OpenAICompatibleAdapter

# Sensible defaults so a user only has to paste a key to get going.
DEFAULT_MODELS: dict[ProviderType, str] = {
    ProviderType.OPENAI: "gpt-4o-mini",
    ProviderType.ANTHROPIC: "claude-sonnet-4-20250514",
    ProviderType.GEMINI: "gemini-2.0-flash",
    ProviderType.GROQ: "llama-3.3-70b-versatile",
    ProviderType.OLLAMA: "llama3.2",
    ProviderType.OCI: "openai.gpt-4o",
    ProviderType.CUSTOM: "gpt-4o-mini",
}

DEFAULT_BASE_URLS: dict[ProviderType, str] = {
    ProviderType.OPENAI: "https://api.openai.com/v1",
    ProviderType.GROQ: "https://api.groq.com/openai/v1",
    ProviderType.OLLAMA: "http://localhost:11434",
}


def build_adapter(provider: AIProvider) -> AIProviderAdapter:
    """Instantiate the adapter for a stored provider configuration."""
    api_key: str | None = None
    if provider.api_key_encrypted:
        api_key = crypto.decrypt(provider.api_key_encrypted)

    match provider.type:
        case ProviderType.ANTHROPIC:
            if not api_key:
                raise ProviderError(
                    "This Anthropic provider has no API key.",
                    hint="Add a key in provider settings.",
                )
            return AnthropicAdapter(
                api_key=api_key, base_url=provider.base_url or "https://api.anthropic.com"
            )

        case ProviderType.GEMINI:
            if not api_key:
                raise ProviderError(
                    "This Gemini provider has no API key.", hint="Add a key in provider settings."
                )
            return GeminiAdapter(api_key=api_key)

        case ProviderType.OLLAMA:
            return OllamaAdapter(base_url=provider.base_url or "http://localhost:11434")

        case ProviderType.OPENAI | ProviderType.GROQ | ProviderType.OCI | ProviderType.CUSTOM:
            base_url = provider.base_url or DEFAULT_BASE_URLS.get(
                provider.type, "https://api.openai.com/v1"
            )
            return OpenAICompatibleAdapter(
                api_key=api_key, base_url=base_url, provider_type=provider.type.value
            )

    raise ProviderError(f"Unsupported provider type: {provider.type}")


__all__ = [
    "AIProviderAdapter",
    "AnthropicAdapter",
    "CompletionRequest",
    "DEFAULT_BASE_URLS",
    "DEFAULT_MODELS",
    "GeminiAdapter",
    "HealthStatus",
    "Message",
    "OllamaAdapter",
    "OpenAICompatibleAdapter",
    "ProviderCapabilities",
    "ProviderError",
    "StreamChunk",
    "TokenUsage",
    "approx_tokens",
    "build_adapter",
]
