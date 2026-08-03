"""Google Gemini adapter.

Gemini uses `contents` with `parts` instead of `messages`, calls the assistant
role "model", and streams newline-delimited JSON arrays rather than SSE events.
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

BASE = "https://generativelanguage.googleapis.com/v1beta"


class GeminiAdapter:
    type = "gemini"

    def __init__(self, *, api_key: str, base_url: str = BASE) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")

    @property
    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            streaming=True, tools=True, vision=True, json_mode=True, max_context_tokens=1_000_000
        )

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamChunk]:
        contents = [
            {
                "role": "model" if m.role == "assistant" else "user",
                "parts": [{"text": m.content}],
            }
            for m in request.messages
            if m.role in ("user", "assistant")
        ]

        payload: dict[str, object] = {
            "contents": contents,
            "generationConfig": {
                "temperature": request.temperature,
                "maxOutputTokens": request.max_tokens,
            },
        }
        if request.system:
            payload["systemInstruction"] = {"parts": [{"text": request.system}]}
        if request.json_mode:
            payload["generationConfig"]["responseMimeType"] = "application/json"  # type: ignore[index]

        url = (
            f"{self._base_url}/models/{request.model}:streamGenerateContent"
            f"?alt=sse&key={self._api_key}"
        )

        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
            try:
                async with client.stream(
                    "POST", url, json=payload, headers={"Content-Type": "application/json"}
                ) as response:
                    if response.status_code >= 400:
                        body = await response.aread()
                        raise _translate_error(response.status_code, body.decode(errors="replace"))

                    usage = TokenUsage()
                    async for line in response.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        try:
                            event = json.loads(line[6:])
                        except json.JSONDecodeError:
                            continue

                        for candidate in event.get("candidates", []):
                            for part in candidate.get("content", {}).get("parts", []):
                                if text := part.get("text"):
                                    yield StreamChunk(text=text)

                        if meta := event.get("usageMetadata"):
                            usage = TokenUsage(
                                prompt_tokens=meta.get("promptTokenCount", 0),
                                completion_tokens=meta.get("candidatesTokenCount", 0),
                            )

                    yield StreamChunk(done=True, usage=usage)
            except httpx.TimeoutException as exc:
                raise ProviderError(
                    "Gemini didn't respond in time.", hint="Try again.", retryable=True
                ) from exc
            except httpx.HTTPError as exc:
                raise ProviderError(
                    f"Couldn't reach Gemini: {exc}", hint="Check your network.", retryable=True
                ) from exc

    async def health(self) -> HealthStatus:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.get(f"{self._base_url}/models?key={self._api_key}")
                if response.status_code in (400, 403):
                    return HealthStatus(ok=False, message="That API key was rejected.")
                if response.status_code >= 400:
                    return HealthStatus(
                        ok=False, message=f"Gemini returned {response.status_code}."
                    )
                models = [
                    m["name"].split("/")[-1]
                    for m in response.json().get("models", [])
                    if "generateContent" in m.get("supportedGenerationMethods", [])
                ]
                return HealthStatus(ok=True, message="Connected", models=models[:60])
        except httpx.HTTPError as exc:
            return HealthStatus(ok=False, message=f"Couldn't reach Gemini: {exc}")

    def estimate_cost(self, model: str, usage: TokenUsage) -> Decimal:
        return price_for(model, usage)


def _translate_error(status_code: int, body: str) -> ProviderError:
    detail = body[:400]
    try:
        detail = json.loads(body).get("error", {}).get("message", detail)
    except (json.JSONDecodeError, AttributeError):
        pass

    if status_code in (400, 403) and "api key" in detail.lower():
        return ProviderError(
            "Google rejected your API key.", hint="Check the key in Google AI Studio."
        )
    if status_code == 429:
        return ProviderError(
            "Gemini is rate-limiting you.", hint="Wait a moment and try again.", retryable=True
        )
    if status_code >= 500:
        return ProviderError(
            f"Gemini is having problems ({status_code}).", hint="Try again shortly.", retryable=True
        )
    return ProviderError(f"Gemini returned an error: {detail}")
