"""Shared test fixtures."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def reset_rate_limiter() -> None:
    """Clear rate-limit buckets between tests.

    The limiter keys on client IP, and every test shares one loopback address,
    so without this the fifth test to hit /auth/register gets a 429. Production
    traffic comes from distinct IPs, so this is a test-harness concern only.
    """
    from app.core.middleware import RateLimitMiddleware
    from app.main import app

    current = app.middleware_stack
    while current is not None:
        if isinstance(current, RateLimitMiddleware):
            current._hits.clear()
            break
        current = getattr(current, "app", None)
