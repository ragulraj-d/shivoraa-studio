"""Adapters for OpenAI and every API that mirrors its shape.

OpenAI's chat-completions format became the de-facto standard, so Groq, Ollama,
OCI's generic endpoint, and most self-hosted gateways speak it. One adapter with
a configurable base URL covers all of them, which is why `custom` is a
first-class provider type rather than a special case.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from decimal import Decimal

import httpx

from app.modules.ai.providers.base import (
    CompletionRequest,
    HealthStatus,
    ProviderCapabilities,
    ProviderError,
    StreamChunk,
    TokenUsage,
    price_for,
)


class OpenAICompatibleAdapter:
    """Works with OpenAI, Groq, Ollama, OCI, and custom OpenAI-shaped endpoints."""

    def __init__(
        self,
        *,
        api_key: str | None,
        base_url: str = "https://api.openai.com/v1",
        provider_type: str = "openai",
        max_context: int = 128_000,
    ) -> None:
        self.type = provider_type
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._max_context = max_context

    @property
    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            streaming=True,
            tools=self.type in ("openai", "groq"),
            vision=self.type == "openai",
            json_mode=True,
            max_context_tokens=self._max_context,
        )

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        # Ollama and some local gateways need no credential at all.
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    def _payload(self, request: CompletionRequest, stream: bool) -> dict[str, object]:
        messages = []
        if request.system:
            messages.append({"role": "system", "content": request.system})
        messages.extend({"role": m.role, "content": m.content} for m in request.messages)

        payload: dict[str, object] = {
            "model": request.model,
            "messages": messages,
            "temperature": request.temperature,
            "max_tokens": request.max_tokens,
            "stream": stream,
        }
        if stream:
            # Without this, OpenAI omits usage from streamed responses and cost
            # accounting silently reports zero.
            payload["stream_options"] = {"include_usage": True}
        if request.json_mode:
            payload["response_format"] = {"type": "json_object"}
        return payload

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamChunk]:
        url = f"{self._base_url}/chat/completions"
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
            try:
                async with client.stream(
                    "POST", url, headers=self._headers(), json=self._payload(request, True)
                ) as response:
                    if response.status_code >= 400:
                        body = await response.aread()
                        raise _translate_error(
                            response.status_code, body.decode(errors="replace"), self.type
                        )

                    usage: TokenUsage | None = None
                    async for line in response.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        data = line[6:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            event = json.loads(data)
                        except json.JSONDecodeError:
                            continue

                        if event.get("usage"):
                            usage = TokenUsage(
                                prompt_tokens=event["usage"].get("prompt_tokens", 0),
                                completion_tokens=event["usage"].get("completion_tokens", 0),
                            )
                        for choice in event.get("choices", []):
                            text = choice.get("delta", {}).get("content")
                            if text:
                                yield StreamChunk(text=text)

                    yield StreamChunk(done=True, usage=usage)
            except httpx.TimeoutException as exc:
                raise ProviderError(
                    f"{self.type} didn't respond in time.",
                    hint="Try again, or switch to a faster model.",
                    retryable=True,
                ) from exc
            except httpx.HTTPError as exc:
                raise ProviderError(
                    f"Couldn't reach {self.type}: {exc}",
                    hint="Check the base URL and your network connection.",
                    retryable=True,
                ) from exc

    async def health(self) -> HealthStatus:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.get(f"{self._base_url}/models", headers=self._headers())
                if response.status_code == 401:
                    return HealthStatus(ok=False, message="That API key was rejected.")
                if response.status_code >= 400:
                    return HealthStatus(
                        ok=False, message=f"{self.type} returned {response.status_code}."
                    )
                data = response.json()
                models = [m.get("id", "") for m in data.get("data", [])][:60]
                return HealthStatus(ok=True, message="Connected", models=models)
        except httpx.HTTPError as exc:
            return HealthStatus(ok=False, message=f"Couldn't reach {self._base_url}: {exc}")

    def estimate_cost(self, model: str, usage: TokenUsage) -> Decimal:
        return price_for(model, usage)


class OllamaAdapter(OpenAICompatibleAdapter):
    """Ollama exposes an OpenAI-compatible surface but lists models differently."""

    def __init__(self, base_url: str = "http://localhost:11434") -> None:
        super().__init__(
            api_key=None,
            base_url=f"{base_url.rstrip('/')}/v1",
            provider_type="ollama",
            max_context=32_000,
        )
        self._root = base_url.rstrip("/")

    async def health(self) -> HealthStatus:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(f"{self._root}/api/tags")
                if response.status_code >= 400:
                    return HealthStatus(
                        ok=False, message=f"Ollama returned {response.status_code}."
                    )
                models = [m["name"] for m in response.json().get("models", [])]
                return HealthStatus(ok=True, message="Connected", models=models)
        except httpx.HTTPError as exc:
            return HealthStatus(
                ok=False,
                message=f"Couldn't reach Ollama at {self._root}. Is it running? ({exc})",
            )

    def estimate_cost(self, model: str, usage: TokenUsage) -> Decimal:
        return Decimal(0)  # local inference costs no API money


def _translate_error(status_code: int, body: str, provider: str) -> ProviderError:
    """Turn a raw provider error into something a user can act on."""
    detail = body[:400]
    try:
        parsed = json.loads(body)
        detail = parsed.get("error", {}).get("message", detail)
    except (json.JSONDecodeError, AttributeError):
        pass

    if status_code == 401:
        return ProviderError(
            f"{provider} rejected your API key.",
            hint="Check the key was copied completely, and that it hasn't been revoked.",
        )
    if status_code == 402 or "quota" in detail.lower() or "credit" in detail.lower():
        return ProviderError(
            f"Your {provider} account is out of credit.",
            hint="Top up your account with the provider, or switch to another provider.",
        )
    if status_code == 404:
        return ProviderError(
            f"{provider} doesn't have that model.",
            hint="Pick a different model in provider settings.",
        )
    if status_code == 429:
        return ProviderError(
            f"{provider} is rate-limiting you.",
            hint="Wait a moment and try again, or configure a fallback provider.",
            retryable=True,
        )
    if status_code >= 500:
        return ProviderError(
            f"{provider} is having problems ({status_code}).",
            hint="This is on their side. Try again shortly.",
            retryable=True,
        )
    return ProviderError(f"{provider} returned an error: {detail}", hint="Check your settings.")
