"""Collections, folders, requests, and saved examples."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base, TimestampMixin, UUIDMixin, VersionMixin
from app.core.types import GUID, JSONType

if TYPE_CHECKING:
    from app.models.workspace import Workspace


class Collection(Base, UUIDMixin, TimestampMixin, VersionMixin):
    __tablename__ = "collections"

    workspace_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    base_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Inherited by every child request unless the request overrides it.
    # Shape: {"type": "bearer"|"basic"|"api_key"|"none", ...credentials}
    auth: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    default_headers: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONType, default=list, nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # AI-generated documentation, kept so regeneration can preserve human edits.
    docs_markdown: Mapped[str | None] = mapped_column(Text, nullable=True)

    workspace: Mapped[Workspace] = relationship(back_populates="collections")
    folders: Mapped[list[Folder]] = relationship(
        back_populates="collection", cascade="all, delete-orphan"
    )
    requests: Mapped[list[ApiRequest]] = relationship(
        back_populates="collection", cascade="all, delete-orphan"
    )


class Folder(Base, UUIDMixin, TimestampMixin, VersionMixin):
    __tablename__ = "folders"

    collection_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("collections.id", ondelete="CASCADE"), index=True
    )
    # Self-referential for unlimited nesting.
    parent_id: Mapped[UUID | None] = mapped_column(
        GUID(), ForeignKey("folders.id", ondelete="CASCADE"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    auth: Mapped[dict[str, Any] | None] = mapped_column(JSONType, nullable=True)

    collection: Mapped[Collection] = relationship(back_populates="folders")


class ApiRequest(Base, UUIDMixin, TimestampMixin, VersionMixin):
    """A saved, parameterised API call definition."""

    __tablename__ = "api_requests"

    collection_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("collections.id", ondelete="CASCADE"), index=True
    )
    folder_id: Mapped[UUID | None] = mapped_column(
        GUID(), ForeignKey("folders.id", ondelete="CASCADE"), nullable=True, index=True
    )

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    method: Mapped[str] = mapped_column(String(16), default="GET", nullable=False)
    url: Mapped[str] = mapped_column(Text, default="", nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # [{"key","value","enabled","description"}]
    headers: Mapped[list[dict[str, Any]]] = mapped_column(JSONType, default=list, nullable=False)
    query_params: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONType, default=list, nullable=False
    )
    path_params: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONType, default=list, nullable=False
    )

    # {"mode": "none"|"json"|"raw"|"form"|"urlencoded"|"graphql", "content": ...}
    body: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)

    # null means "inherit from folder, then collection"
    auth: Mapped[dict[str, Any] | None] = mapped_column(JSONType, nullable=True)

    settings: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    docs_markdown: Mapped[str | None] = mapped_column(Text, nullable=True)
    tests_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    tests_framework: Mapped[str | None] = mapped_column(String(32), nullable=True)

    collection: Mapped[Collection] = relationship(back_populates="requests")
    examples: Mapped[list[RequestExample]] = relationship(
        back_populates="request", cascade="all, delete-orphan"
    )

    __table_args__ = (Index("ix_requests_collection_folder", "collection_id", "folder_id"),)


class RequestExample(Base, UUIDMixin, TimestampMixin):
    """A saved response, used as documentation input and test-generation source."""

    __tablename__ = "request_examples"

    request_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("api_requests.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    status_code: Mapped[int] = mapped_column(Integer, nullable=False)
    response_headers: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    response_body: Mapped[str | None] = mapped_column(Text, nullable=True)
    content_type: Mapped[str | None] = mapped_column(String(160), nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    request: Mapped[ApiRequest] = relationship(back_populates="examples")
