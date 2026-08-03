"""Execution history — every request sent through the platform."""

from __future__ import annotations

import enum
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import BigInteger, DateTime, Enum, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin, UUIDMixin
from app.core.types import GUID, JSONType


class ExecutionMode(str, enum.Enum):
    SERVER = "server"
    LOCAL = "local"


class ExecutionStatus(str, enum.Enum):
    PENDING = "pending"
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"
    BLOCKED = "blocked"  # refused by the SSRF policy


class Execution(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "executions"

    workspace_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # Nullable: an ad-hoc request that was never saved still belongs in history.
    request_id: Mapped[UUID | None] = mapped_column(
        GUID(), ForeignKey("api_requests.id", ondelete="SET NULL"), nullable=True
    )
    environment_id: Mapped[UUID | None] = mapped_column(
        GUID(), ForeignKey("environments.id", ondelete="SET NULL"), nullable=True
    )

    mode: Mapped[ExecutionMode] = mapped_column(
        Enum(ExecutionMode, name="execution_mode"), default=ExecutionMode.SERVER, nullable=False
    )
    status: Mapped[ExecutionStatus] = mapped_column(
        Enum(ExecutionStatus, name="execution_status"),
        default=ExecutionStatus.PENDING,
        nullable=False,
    )

    # --- What was sent (secrets already redacted) ---
    method: Mapped[str] = mapped_column(String(16), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    request_headers: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    request_body: Mapped[str | None] = mapped_column(Text, nullable=True)

    # --- What came back ---
    status_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    response_headers: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    response_body: Mapped[str | None] = mapped_column(Text, nullable=True)
    response_size: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    content_type: Mapped[str | None] = mapped_column(String(160), nullable=True)

    # --- Timing (milliseconds), for the response waterfall ---
    duration_ms: Mapped[float | None] = mapped_column(nullable=True)
    dns_ms: Mapped[float | None] = mapped_column(nullable=True)
    connect_ms: Mapped[float | None] = mapped_column(nullable=True)
    tls_ms: Mapped[float | None] = mapped_column(nullable=True)
    ttfb_ms: Mapped[float | None] = mapped_column(nullable=True)

    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_exec_ws_created", "workspace_id", "created_at"),
        Index("ix_exec_request_created", "request_id", "created_at"),
        Index("ix_exec_ws_status", "workspace_id", "status_code"),
    )
