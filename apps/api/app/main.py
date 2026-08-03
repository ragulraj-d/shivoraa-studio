"""Shivoraa Studio API — application entry point."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.db import engine
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging
from app.core.middleware import (
    RateLimitMiddleware,
    RequestIDMiddleware,
    SecurityHeadersMiddleware,
)
from app.modules.ai.router import router as ai_router
from app.modules.collection.router import router as collection_router
from app.modules.environment.router import router as environment_router
from app.modules.execution.router import router as execution_router
from app.modules.identity.router import router as identity_router
from app.modules.workspace.router import router as workspace_router

configure_logging()
log = structlog.get_logger()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    log.info(
        "api_starting",
        environment=settings.environment,
        deployment_mode=settings.deployment_mode,
    )
    yield
    await engine.dispose()
    log.info("api_stopped")


app = FastAPI(
    title="Shivoraa Studio API",
    description="AI-powered API development platform",
    version="0.1.0",
    docs_url="/docs" if not settings.is_production else None,
    redoc_url=None,
    openapi_url="/openapi.json" if not settings.is_production else None,
    lifespan=lifespan,
)

# Middleware executes bottom-up on the way in, so the last one added runs first.
# RequestID must be outermost, which is why it is registered last.
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID"],
)
app.add_middleware(RequestIDMiddleware)

register_exception_handlers(app)

prefix = settings.api_v1_prefix
app.include_router(identity_router, prefix=prefix)
app.include_router(workspace_router, prefix=prefix)
app.include_router(collection_router, prefix=prefix)
app.include_router(environment_router, prefix=prefix)
app.include_router(execution_router, prefix=prefix)
app.include_router(ai_router, prefix=prefix)


@app.get("/health", tags=["system"])
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "shivoraa-api", "version": "0.1.0"}


@app.get("/ready", tags=["system"])
async def ready() -> dict[str, str]:
    """Readiness probe — verifies the database is actually reachable.

    A liveness check that only returns 200 tells the load balancer nothing about
    whether this instance can serve traffic.
    """
    from sqlalchemy import text

    from app.core.db import SessionLocal

    async with SessionLocal() as session:
        await session.execute(text("SELECT 1"))
    return {"status": "ready"}
