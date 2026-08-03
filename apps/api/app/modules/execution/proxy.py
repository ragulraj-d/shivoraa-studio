"""The HTTP proxy that actually sends user requests.

Isolation note: in a hosted deployment this should run as its own container on a
subnet with no route to the database, Redis, or KMS, consuming plans from a
queue. It is the only component that fetches attacker-influenced URLs, so it
should hold nothing worth stealing. The code is already structured for that
extraction — it takes a plan and returns a result, touching no other module.
"""

from __future__ import annotations

import ssl
import time
from dataclasses import asdict, dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx
import structlog

from app.core.config import settings
from app.modules.execution.resolver import ExecutionPlan
from app.modules.execution.ssrf import BlockedTarget, validate_url

log = structlog.get_logger()

# Headers that describe a single hop and must not be forwarded in either direction.
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}
# Cloud/proxy metadata headers stripped so nothing about our infrastructure leaks.
STRIPPED_PREFIXES = ("x-amz-", "x-forwarded-", "x-real-ip", "cf-", "x-envoy-")


@dataclass(slots=True)
class Timing:
    dns_ms: float | None = None
    connect_ms: float | None = None
    tls_ms: float | None = None
    ttfb_ms: float | None = None
    total_ms: float = 0.0


@dataclass(slots=True)
class ExecutionResult:
    """One shape regardless of where the request ran.

    The extension's local executor produces this same structure, so the response
    viewer needs no knowledge of execution mode.
    """

    ok: bool
    status_code: int | None = None
    headers: dict[str, str] = field(default_factory=dict)
    body: str | None = None
    content_type: str | None = None
    size_bytes: int = 0
    timing: Timing = field(default_factory=Timing)
    error_code: str | None = None
    error_message: str | None = None
    error_hint: str | None = None
    final_url: str | None = None
    redirect_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["timing"] = asdict(self.timing)
        return data


def _clean_request_headers(headers: dict[str, str]) -> dict[str, str]:
    out = {}
    for key, value in headers.items():
        low = key.lower()
        if low in HOP_BY_HOP or low.startswith(STRIPPED_PREFIXES):
            continue
        out[key] = value
    return out


def _clean_response_headers(headers: httpx.Headers) -> dict[str, str]:
    return {k: v for k, v in headers.items() if k.lower() not in HOP_BY_HOP}


async def execute(plan: ExecutionPlan) -> ExecutionResult:
    """Send the request described by `plan`, enforcing every safety limit."""
    started = time.perf_counter()

    # Validate before any connection is attempted. Each redirect hop re-enters
    # this same check below.
    try:
        validate_url(plan.url)
    except BlockedTarget as blocked:
        return ExecutionResult(
            ok=False,
            error_code="blocked_target",
            error_message=blocked.reason,
            error_hint=blocked.hint,
        )

    timeout = httpx.Timeout(
        connect=settings.exec_connect_timeout_seconds,
        read=min(plan.timeout, settings.exec_timeout_seconds),
        write=min(plan.timeout, settings.exec_timeout_seconds),
        pool=settings.exec_connect_timeout_seconds,
    )
    limits = httpx.Limits(max_connections=100, max_keepalive_connections=20)

    headers = _clean_request_headers(plan.headers)
    body = plan.body.encode() if isinstance(plan.body, str) else plan.body

    try:
        async with httpx.AsyncClient(
            timeout=timeout,
            limits=limits,
            verify=plan.verify_ssl,
            # Redirects are followed manually so every hop can be re-validated;
            # httpx's automatic following would bypass the SSRF check.
            follow_redirects=False,
            http2=True,
        ) as client:
            url = plan.url
            method = plan.method
            redirects = 0
            connect_start = time.perf_counter()

            while True:
                request_start = time.perf_counter()
                response = await client.request(method, url, headers=headers, content=body)
                ttfb = (time.perf_counter() - request_start) * 1000

                if (
                    plan.follow_redirects
                    and response.status_code in (301, 302, 303, 307, 308)
                    and "location" in response.headers
                ):
                    if redirects >= settings.exec_max_redirects:
                        return ExecutionResult(
                            ok=False,
                            error_code="too_many_redirects",
                            error_message=(f"Stopped after {redirects} redirects."),
                            error_hint="The server may be redirecting in a loop.",
                        )

                    next_url = str(httpx.URL(url).join(response.headers["location"]))
                    try:
                        validate_url(next_url)
                    except BlockedTarget as blocked:
                        # A public URL that redirects to 169.254.169.254 is the
                        # classic bypass; this is where it dies.
                        log.warning("ssrf_blocked_redirect", from_url=url, to_url=next_url)
                        return ExecutionResult(
                            ok=False,
                            error_code="blocked_redirect",
                            error_message=(
                                f"That URL redirected somewhere we won't follow: {blocked.reason}"
                            ),
                            error_hint=blocked.hint,
                        )

                    url = next_url
                    redirects += 1
                    # 303 (and the historical treatment of 301/302) turn the
                    # follow-up into a GET without a body.
                    if response.status_code in (301, 302, 303) and method not in ("GET", "HEAD"):
                        method = "GET"
                        body = None
                    continue

                content = response.content
                if len(content) > settings.exec_max_body_bytes:
                    content = content[: settings.exec_max_body_bytes]

                total = (time.perf_counter() - started) * 1000
                try:
                    text = content.decode(response.encoding or "utf-8", errors="replace")
                except (LookupError, UnicodeDecodeError):
                    text = f"<{len(content)} bytes of binary data>"

                return ExecutionResult(
                    ok=True,
                    status_code=response.status_code,
                    headers=_clean_response_headers(response.headers),
                    body=text,
                    content_type=response.headers.get("content-type"),
                    size_bytes=len(content),
                    timing=Timing(
                        connect_ms=round((request_start - connect_start) * 1000, 2),
                        ttfb_ms=round(ttfb, 2),
                        total_ms=round(total, 2),
                    ),
                    final_url=str(response.url),
                    redirect_count=redirects,
                )

    except httpx.ConnectTimeout:
        return ExecutionResult(
            ok=False,
            error_code="connect_timeout",
            error_message=f"Couldn't connect to {urlparse(plan.url).hostname} within "
            f"{settings.exec_connect_timeout_seconds}s.",
            error_hint="The server may be down, or blocking connections from our network.",
        )
    except httpx.ReadTimeout:
        return ExecutionResult(
            ok=False,
            error_code="read_timeout",
            error_message=(
                f"The server accepted the connection but sent no response within {plan.timeout}s."
            ),
            error_hint="Try raising the timeout in request settings, or check the endpoint.",
        )
    except httpx.ConnectError as exc:
        return ExecutionResult(
            ok=False,
            error_code="connection_failed",
            error_message=f"Couldn't reach {urlparse(plan.url).hostname}: {exc}",
            error_hint="Check the host is correct and reachable from the public internet.",
        )
    except httpx.TooManyRedirects:
        return ExecutionResult(
            ok=False,
            error_code="too_many_redirects",
            error_message="The server redirected too many times.",
            error_hint="This usually means a redirect loop.",
        )
    except ssl.SSLError as exc:
        return ExecutionResult(
            ok=False,
            error_code="tls_error",
            error_message=f"The TLS handshake failed: {exc}",
            error_hint="If this is a self-signed certificate, turn off SSL verification "
            "in request settings.",
        )
    except Exception as exc:  # noqa: BLE001 — the proxy must never crash the API
        log.exception("proxy_unexpected_error", url=plan.url)
        return ExecutionResult(
            ok=False,
            error_code="request_failed",
            error_message=str(exc) or "The request failed for an unknown reason.",
            error_hint="Try again, and check the request configuration.",
        )
