"""Request execution and history endpoints."""

from __future__ import annotations

from dataclasses import asdict
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

import structlog
from fastapi import APIRouter, Query, status
from sqlalchemy import select

from app.core.deps import Auth, DbSession
from app.core.errors import NotFoundError, ValidationError
from app.core.security import redact_mapping, redact_text
from app.models.collection import ApiRequest, Collection
from app.models.execution import Execution, ExecutionMode, ExecutionStatus
from app.models.workspace import Environment
from app.modules.collection.repository import RequestRepository
from app.modules.execution import proxy
from app.modules.execution.resolver import ExecutionPlan, build_plan
from app.modules.execution.ssrf import BlockedTarget, is_private_hostname, validate_url
from app.schemas.execution import (
    ExecuteRequest,
    ExecutionPlanResponse,
    ExecutionResponse,
    HistoryItem,
    RecordLocalExecution,
    TimingResponse,
)

log = structlog.get_logger()
router = APIRouter(tags=["execution"])

MAX_STORED_BODY = 256 * 1024  # larger bodies belong in object storage, not a row


async def _load_environment(db: DbSession, ctx: Auth, env_id: UUID | None) -> Environment | None:
    from sqlalchemy.orm import selectinload

    stmt = (
        select(Environment)
        .where(Environment.workspace_id == ctx.workspace_id)
        .options(selectinload(Environment.variables))
    )
    stmt = (
        stmt.where(Environment.id == env_id)
        if env_id
        else stmt.where(Environment.is_default.is_(True))
    )
    return await db.scalar(stmt)


async def _resolve_plan(
    db: DbSession, ctx: Auth, payload: ExecuteRequest
) -> tuple[ExecutionPlan, ApiRequest | None]:
    env = await _load_environment(db, ctx, payload.environment_id)

    if payload.request_id:
        repo = RequestRepository(db, ctx.workspace_id)
        request_row = await repo.get_or_404(payload.request_id)
        collection = await db.get(Collection, request_row.collection_id)
        plan = build_plan(request_row, collection, env, overrides=payload.variable_overrides)
        return plan, request_row

    if payload.adhoc:
        # An unsaved request runs through the same resolver by wrapping it in a
        # transient ApiRequest, so ad-hoc and saved requests cannot diverge.
        adhoc = payload.adhoc
        transient = ApiRequest(
            collection_id=UUID(int=0),
            name="ad-hoc",
            method=adhoc.method,
            url=adhoc.url,
            headers=[h.model_dump() for h in adhoc.headers],
            query_params=[q.model_dump() for q in adhoc.query_params],
            path_params=[],
            body=adhoc.body.model_dump(),
            auth=adhoc.auth.model_dump() if adhoc.auth else None,
            settings=adhoc.settings,
        )
        plan = build_plan(transient, None, env, overrides=payload.variable_overrides)
        return plan, None

    raise ValidationError(
        "Nothing to send.", hint="Provide either a saved request_id or an adhoc request."
    )


@router.post("/executions", response_model=ExecutionResponse)
async def execute_request(payload: ExecuteRequest, ctx: Auth, db: DbSession) -> ExecutionResponse:
    plan, request_row = await _resolve_plan(db, ctx, payload)

    if not plan.url.strip():
        raise ValidationError("This request has no URL.", hint="Enter a URL and try again.")

    # A private target can't be reached from a hosted server. Rather than failing
    # opaquely, tell the client so it can offer local execution.
    if payload.mode == "local" or (payload.mode == "auto" and _looks_private(plan.url)):
        return ExecutionResponse(
            ok=False,
            mode="local",
            requires_local=True,
            error_code="requires_local_execution",
            error_message=f"{_hostname(plan.url)} is only reachable from your own machine.",
            error_hint="Send this request from the VS Code extension, which runs it locally.",
            unresolved_variables=plan.unresolved,
        )

    started_at = datetime.now(UTC)
    result = await proxy.execute(plan)

    secrets = plan.variables.secrets
    execution = Execution(
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
        request_id=request_row.id if request_row else None,
        environment_id=payload.environment_id,
        mode=ExecutionMode.SERVER,
        status=(
            ExecutionStatus.SUCCESS
            if result.ok
            else (
                ExecutionStatus.BLOCKED
                if result.error_code in ("blocked_target", "blocked_redirect")
                else ExecutionStatus.FAILED
            )
        ),
        method=plan.method,
        url=redact_text(plan.url, secrets),
        # Secrets are replaced with {{NAME}} placeholders before anything is
        # persisted, so history stays useful without storing credentials.
        request_headers=redact_mapping(plan.headers, secrets),
        request_body=redact_text(plan.body, secrets)[:MAX_STORED_BODY] if plan.body else None,
        status_code=result.status_code,
        response_headers=result.headers,
        response_body=(result.body or "")[:MAX_STORED_BODY] or None,
        response_size=result.size_bytes,
        content_type=result.content_type,
        duration_ms=result.timing.total_ms,
        connect_ms=result.timing.connect_ms,
        ttfb_ms=result.timing.ttfb_ms,
        error_code=result.error_code,
        error_message=result.error_message,
        started_at=started_at,
    )
    db.add(execution)
    await db.flush()

    return ExecutionResponse(
        id=execution.id,
        ok=result.ok,
        mode="server",
        status_code=result.status_code,
        headers=result.headers,
        body=result.body,
        content_type=result.content_type,
        size_bytes=result.size_bytes,
        timing=TimingResponse(**asdict(result.timing)),
        error_code=result.error_code,
        error_message=result.error_message,
        error_hint=result.error_hint,
        final_url=result.final_url,
        redirect_count=result.redirect_count,
        unresolved_variables=plan.unresolved,
        requires_local=result.error_code in ("blocked_target",) and _looks_private(plan.url),
    )


@router.post("/executions/plan", response_model=ExecutionPlanResponse)
async def get_execution_plan(
    payload: ExecuteRequest, ctx: Auth, db: DbSession
) -> ExecutionPlanResponse:
    """Resolve a request without sending it.

    The extension calls this, then executes locally. Because both paths share
    this resolver, a request behaves identically whichever way it runs.
    """
    plan, _ = await _resolve_plan(db, ctx, payload)
    return ExecutionPlanResponse(
        method=plan.method,
        url=plan.url,
        headers=plan.headers,
        body=plan.body,
        timeout=plan.timeout,
        follow_redirects=plan.follow_redirects,
        verify_ssl=plan.verify_ssl,
        unresolved=plan.unresolved,
    )


@router.post("/executions/record", status_code=status.HTTP_201_CREATED)
async def record_local_execution(
    payload: RecordLocalExecution, ctx: Auth, db: DbSession
) -> dict[str, str]:
    """Record metadata for a locally-executed request. No body is stored."""
    execution = Execution(
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
        request_id=payload.request_id,
        environment_id=payload.environment_id,
        mode=ExecutionMode.LOCAL,
        status=ExecutionStatus.SUCCESS if payload.status_code else ExecutionStatus.FAILED,
        method=payload.method,
        url=payload.url,
        status_code=payload.status_code,
        duration_ms=payload.duration_ms,
        response_size=payload.size_bytes,
        error_message=payload.error_message,
    )
    db.add(execution)
    await db.flush()
    return {"id": str(execution.id)}


@router.get("/executions", response_model=list[HistoryItem])
async def list_history(
    ctx: Auth,
    db: DbSession,
    request_id: UUID | None = None,
    limit: Annotated[int, Query(le=200)] = 50,
    offset: int = 0,
) -> list[HistoryItem]:
    stmt = (
        select(Execution)
        .where(Execution.workspace_id == ctx.workspace_id)
        .order_by(Execution.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    if request_id:
        stmt = stmt.where(Execution.request_id == request_id)
    rows = await db.execute(stmt)
    return [
        HistoryItem(
            id=e.id,
            request_id=e.request_id,
            method=e.method,
            url=e.url,
            status_code=e.status_code,
            duration_ms=e.duration_ms,
            response_size=e.response_size,
            mode=e.mode.value,
            status=e.status.value,
            error_message=e.error_message,
            created_at=e.created_at,
        )
        for e in rows.scalars()
    ]


@router.get("/executions/{execution_id}", response_model=ExecutionResponse)
async def get_execution(execution_id: UUID, ctx: Auth, db: DbSession) -> ExecutionResponse:
    execution = await db.scalar(
        select(Execution).where(
            Execution.id == execution_id, Execution.workspace_id == ctx.workspace_id
        )
    )
    if execution is None:
        raise NotFoundError("That execution isn't in your history.")
    return ExecutionResponse(
        id=execution.id,
        ok=execution.status == ExecutionStatus.SUCCESS,
        mode=execution.mode.value,
        status_code=execution.status_code,
        headers=execution.response_headers,
        body=execution.response_body,
        content_type=execution.content_type,
        size_bytes=execution.response_size or 0,
        timing=TimingResponse(
            total_ms=execution.duration_ms or 0,
            connect_ms=execution.connect_ms,
            ttfb_ms=execution.ttfb_ms,
        ),
        error_message=execution.error_message,
    )


def _hostname(url: str) -> str:
    from urllib.parse import urlparse

    return urlparse(url).hostname or url


def _looks_private(url: str) -> bool:
    try:
        validate_url(url)
        return False
    except BlockedTarget as blocked:
        return blocked.is_private
    except Exception:
        return is_private_hostname(_hostname(url))
