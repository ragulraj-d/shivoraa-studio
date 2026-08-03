"""Execution schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.core.schemas import AuthConfig, KeyValue, RequestBody


class AdhocRequest(BaseModel):
    """A request sent without being saved first — the 'paste a cURL and go' path."""

    method: str = "GET"
    url: str
    headers: list[KeyValue] = Field(default_factory=list)
    query_params: list[KeyValue] = Field(default_factory=list)
    body: RequestBody = Field(default_factory=RequestBody)
    auth: AuthConfig | None = None
    settings: dict[str, Any] = Field(default_factory=dict)


class ExecuteRequest(BaseModel):
    request_id: UUID | None = None
    environment_id: UUID | None = None
    adhoc: AdhocRequest | None = None
    variable_overrides: dict[str, str] = Field(default_factory=dict)
    # "auto" picks server or local based on whether the host is reachable from
    # the internet; the client always displays which one actually ran.
    mode: Literal["auto", "server", "local"] = "auto"


class TimingResponse(BaseModel):
    dns_ms: float | None = None
    connect_ms: float | None = None
    tls_ms: float | None = None
    ttfb_ms: float | None = None
    total_ms: float = 0.0


class ExecutionResponse(BaseModel):
    id: UUID | None = None
    ok: bool
    mode: str
    status_code: int | None = None
    headers: dict[str, str] = Field(default_factory=dict)
    body: str | None = None
    content_type: str | None = None
    size_bytes: int = 0
    timing: TimingResponse = Field(default_factory=TimingResponse)
    error_code: str | None = None
    error_message: str | None = None
    error_hint: str | None = None
    final_url: str | None = None
    redirect_count: int = 0
    unresolved_variables: list[str] = Field(default_factory=list)
    # Present when the target is private: the UI turns this into a one-click
    # "send locally instead" action rather than a dead end.
    requires_local: bool = False


class ExecutionPlanResponse(BaseModel):
    """Returned to the extension so it can execute locally using exactly the
    same resolution the server would have used."""

    method: str
    url: str
    headers: dict[str, str]
    body: str | None
    timeout: int
    follow_redirects: bool
    verify_ssl: bool
    unresolved: list[str]


class HistoryItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    request_id: UUID | None
    method: str
    url: str
    status_code: int | None
    duration_ms: float | None
    response_size: int | None
    mode: str
    status: str
    error_message: str | None
    created_at: datetime


class RecordLocalExecution(BaseModel):
    """Metadata-only record of a locally-executed request.

    The response body stays on the user's machine unless they explicitly save it
    as an example — local mode exists partly for people who cannot send internal
    API data to a hosted service.
    """

    request_id: UUID | None = None
    environment_id: UUID | None = None
    method: str
    url: str
    status_code: int | None = None
    duration_ms: float | None = None
    size_bytes: int | None = None
    error_message: str | None = None


class AgentExecuteRequest(BaseModel):
    """A fully-resolved request for the local agent to send.

    The browser has already interpolated variables and applied auth, so the
    agent does no resolution of its own — it is a sender, not a second source
    of truth about what a request means.
    """

    method: str = "GET"
    url: str = Field(min_length=1)
    headers: dict[str, str] = Field(default_factory=dict)
    body: str | None = None
    timeout: float = 30.0
    follow_redirects: bool = True
    verify_ssl: bool = True
