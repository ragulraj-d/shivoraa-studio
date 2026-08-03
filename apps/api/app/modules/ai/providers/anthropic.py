"""Anthropic adapter.

Anthropic's Messages API differs from the OpenAI shape in two ways that matter:
the system prompt is a top-level field rather than a message, and usage arrives
across two separate SSE events rather than one.
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

API_VERSION = "2023-06-01"


class AnthropicAdapter:
    type = "anthropic"

    def __init__(self, *, api_key: str, base_url: str = "https://api.anthropic.com") -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")

    @property
    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            streaming=True, tools=True, vision=True, json_mode=False, max_context_tokens=200_000
        )

    def _headers(self) -> dict[str, str]:
        return {
            "x-api-key": self._api_key,
            "anthropic-version": API_VERSION,
            "content-type": "application/json",
        }

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamChunk]:
        payload: dict[str, object] = {
            "model": request.model,
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
            "stream": True,
            "messages": [
                {"role": m.role, "content": m.content}
                for m in request.messages
                if m.role in ("user", "assistant")
            ],
        }
        if request.system:
            payload["system"] = request.system

        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
            try:
                async with client.stream(
                    "POST", f"{self._base_url}/v1/messages", headers=self._headers(), json=payload
                ) as response:
                    if response.status_code >= 400:
                        body = await response.aread()
                        raise _translate_error(response.status_code, body.decode(errors="replace"))

                    prompt_tokens = 0
                    completion_tokens = 0

                    async for line in response.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        try:
                            event = json.loads(line[6:])
                        except json.JSONDecodeError:
                            continue

                        event_type = event.get("type")
                        if event_type == "message_start":
                            usage = event.get("message", {}).get("usage", {})
                            prompt_tokens = usage.get("input_tokens", 0)
                        elif event_type == "content_block_delta":
                            text = event.get("delta", {}).get("text")
                            if text:
                                yield StreamChunk(text=text)
                        elif event_type == "message_delta":
                            completion_tokens = event.get("usage", {}).get("output_tokens", 0)
                        elif event_type == "error":
                            message = event.get("error", {}).get("message", "Unknown error")
                            raise ProviderError(f"Anthropic: {message}")

                    yield StreamChunk(
                        done=True,
                        usage=TokenUsage(
                            prompt_tokens=prompt_tokens, completion_tokens=completion_tokens
                        ),
                    )
            except httpx.TimeoutException as exc:
                raise ProviderError(
                    "Anthropic didn't respond in time.",
                    hint="Try again, or use a faster model like Haiku.",
                    retryable=True,
                ) from exc
            except httpx.HTTPError as exc:
                raise ProviderError(
                    f"Couldn't reach Anthropic: {exc}", hint="Check your network.", retryable=True
                ) from exc

    async def health(self) -> HealthStatus:
        # Anthropic has no free introspection endpoint, so a minimal completion
        # is the only honest way to prove the key works.
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                response = await client.post(
                    f"{self._base_url}/v1/messages",
                    headers=self._headers(),
                    json={
                        "model": "claude-3-5-haiku-20241022",
                        "max_tokens": 1,
                        "messages": [{"role": "user", "content": "hi"}],
                    },
                )
                if response.status_code == 401:
                    return HealthStatus(ok=False, message="That API key was rejected.")
                if response.status_code >= 400:
                    return HealthStatus(
                        ok=False, message=f"Anthropic returned {response.status_code}."
                    )
                return HealthStatus(
                    ok=True,
                    message="Connected",
                    models=[
                        "claude-opus-4-20250514",
                        "claude-sonnet-4-20250514",
                        "claude-3-5-haiku-20241022",
                    ],
                )
        except httpx.HTTPError as exc:
            return HealthStatus(ok=False, message=f"Couldn't reach Anthropic: {exc}")

    def estimate_cost(self, model: str, usage: TokenUsage) -> Decimal:
        return price_for(model, usage)


def _translate_error(status_code: int, body: str) -> ProviderError:
    detail = body[:400]
    try:
        detail = json.loads(body).get("error", {}).get("message", detail)
    except (json.JSONDecodeError, AttributeError):
        pass

    if status_code == 401:
        return ProviderError(
            "Anthropic rejected your API key.",
            hint="Check the key starts with sk-ant- and is complete.",
        )
    if status_code == 429:
        return ProviderError(
            "Anthropic is rate-limiting you.",
            hint="Wait a moment, or configure a fallback.",
            retryable=True,
        )
    if status_code >= 500:
        return ProviderError(
            f"Anthropic is having problems ({status_code}).",
            hint="Try again shortly.",
            retryable=True,
        )
    return ProviderError(f"Anthropic returned an error: {detail}")
