"""Local agent.

CORS is a browser rule. A request the browser refuses to let a page read is
still a perfectly ordinary request once something other than a browser sends it
— so this endpoint sends it, on the user's own machine, and hands back the whole
response.

It also reaches `localhost` and private networks, which a hosted server cannot.

Deliberate constraints, because this is an HTTP forwarder with no login:

* It only exists when SHIVORAA_AGENT_MODE=true. Off by default.
* It refuses to start listening on anything but a loopback address, so it is not
  reachable from the network even on a shared Wi-Fi.
* Only the configured browser origins may call it, so a random web page the user
  visits cannot quietly use their machine as a proxy.

Those three together mean the blast radius is "this user's own browser can make
this user's own machine send HTTP requests" — which is exactly the feature.
"""

from __future__ import annotations

from dataclasses import asdict

import structlog
from fastapi import APIRouter, Request

from app.core.config import settings
from app.core.errors import ValidationError
from app.modules.execution import proxy
from app.modules.execution.resolver import ExecutionPlan, VariableSet
from app.modules.execution.schemas import AgentExecuteRequest, ExecutionResponse, TimingResponse

log = structlog.get_logger()
router = APIRouter(prefix="/agent", tags=["agent"])

LOOPBACK = {"127.0.0.1", "::1", "localhost"}


@router.get("/health")
async def agent_health() -> dict[str, object]:
    """Advertise the agent so the web app can discover it.

    The web app checks this before every send and quietly falls back to a direct
    browser fetch when it is absent, so nothing breaks when the agent is off.
    """
    return {
        "status": "ok",
        "service": "shivoraa-agent",
        "version": "0.1.0",
        "capabilities": ["execute", "private_network", "cors_bypass"],
    }


@router.post("/execute", response_model=ExecutionResponse)
async def agent_execute(payload: AgentExecuteRequest, request: Request) -> ExecutionResponse:
    if not settings.agent_mode:
        raise ValidationError(
            "Agent mode is off on this server.",
            hint="Start it with SHIVORAA_AGENT_MODE=true, or run `make agent`.",
            code="agent_disabled",
        )

    client_host = request.client.host if request.client else ""
    if client_host not in LOOPBACK:
        # Refusing anything but loopback keeps this from becoming an open proxy
        # if the port is ever exposed by accident.
        log.warning("agent_rejected_remote_caller", host=client_host)
        raise ValidationError(
            "The agent only accepts requests from this machine.",
            code="agent_remote_denied",
        )

    plan = ExecutionPlan(
        method=payload.method.upper(),
        url=payload.url,
        headers=dict(payload.headers),
        body=payload.body,
        content_type=payload.headers.get("Content-Type") or payload.headers.get("content-type"),
        timeout=int(payload.timeout),
        follow_redirects=payload.follow_redirects,
        verify_ssl=payload.verify_ssl,
        variables=VariableSet(),
        unresolved=[],
    )

    # The SSRF guard exists to stop a hosted server being aimed at its own
    # infrastructure. Here the "infrastructure" is the user's laptop and
    # reaching it is the entire point, so the guard is bypassed by design.
    result = await proxy.execute(plan, allow_private=True)

    return ExecutionResponse(
        id=None,
        ok=result.ok,
        mode="agent",
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
        unresolved_variables=[],
        requires_local=False,
    )
