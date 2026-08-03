"""Middleware chain.

Order matters and is asserted by the registration order in main.py:
RequestID first (so every later log line is correlated), rate limiting before
auth (so unauthenticated floods are cheap to reject), security headers last.
"""

from __future__ import annotations

import time
import uuid
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable

import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app.core.config import settings

log = structlog.get_logger()

Handler = Callable[[Request], Awaitable[Response]]


class RequestIDMiddleware(BaseHTTPMiddleware):
    """Adopt or mint a correlation ID and bind it for the whole request."""

    async def dispatch(self, request: Request, call_next: Handler) -> Response:
        request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
        request.state.request_id = request_id
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=request_id)

        start = time.perf_counter()
        response = await call_next(request)
        duration_ms = round((time.perf_counter() - start) * 1000, 2)

        response.headers["X-Request-ID"] = request_id
        if request.url.path not in ("/health", "/ready", "/metrics"):
            log.info(
                "http_request",
                method=request.method,
                path=request.url.path,
                status=response.status_code,
                duration_ms=duration_ms,
            )
        return response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Handler) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        if settings.is_production:
            response.headers["Strict-Transport-Security"] = (
                "max-age=63072000; includeSubDomains; preload"
            )
        return response


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Sliding-window rate limiting, in-process.

    Correct for a single instance. Running more than one API replica requires
    moving these counters to Redis — the interface is intentionally small so that
    swap is contained to this class.
    """

    def __init__(self, app: object) -> None:
        super().__init__(app)  # type: ignore[arg-type]
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def _limit_for(self, path: str) -> tuple[int, int] | None:
        if path.startswith(f"{settings.api_v1_prefix}/auth/"):
            if path.endswith(("/login", "/register", "/password-reset")):
                return settings.rate_limit_auth, settings.rate_limit_auth_window_seconds
            return None
        if path.startswith(f"{settings.api_v1_prefix}/executions"):
            return settings.rate_limit_exec, settings.rate_limit_window_seconds
        if path.startswith(f"{settings.api_v1_prefix}/ai"):
            return settings.rate_limit_ai, settings.rate_limit_window_seconds
        return None

    async def dispatch(self, request: Request, call_next: Handler) -> Response:
        limit = self._limit_for(request.url.path)
        if limit is None:
            return await call_next(request)

        max_hits, window = limit
        client = request.client.host if request.client else "unknown"
        # Authenticated callers are bucketed by token so one office NAT does not
        # share a limit; anonymous callers fall back to IP.
        auth = request.headers.get("authorization", "")
        key = f"{request.url.path}:{auth[-32:] if auth else client}"

        now = time.time()
        bucket = self._hits[key]
        while bucket and bucket[0] < now - window:
            bucket.popleft()

        if len(bucket) >= max_hits:
            retry_after = int(window - (now - bucket[0])) + 1
            return JSONResponse(
                status_code=429,
                headers={"Retry-After": str(retry_after)},
                content={
                    "error": {
                        "code": "rate_limited",
                        "detail": f"Too many requests. Try again in {retry_after} seconds.",
                        "hint": "This limit protects the service from abuse.",
                        "retry_after": retry_after,
                    }
                },
            )

        bucket.append(now)
        return await call_next(request)
