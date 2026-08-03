"""Workspaces, membership, environments, and variables."""

from __future__ import annotations

import enum
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import Boolean, Enum, ForeignKey, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base, TimestampMixin, UUIDMixin, VersionMixin
from app.core.types import GUID

if TYPE_CHECKING:
    from app.models.collection import Collection
    from app.models.user import User


class Role(str, enum.Enum):
    OWNER = "owner"
    EDITOR = "editor"
    VIEWER = "viewer"


class Workspace(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "workspaces"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    slug: Mapped[str] = mapped_column(String(140), unique=True, index=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_personal: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Reserved for billing at GA; every workspace is "free" until then.
    plan: Mapped[str] = mapped_column(String(32), default="free", nullable=False)

    # Default AI provider for this workspace; per-feature overrides live in
    # ai_providers.feature_overrides.
    default_provider_id: Mapped[UUID | None] = mapped_column(GUID(), nullable=True)

    members: Mapped[list[WorkspaceMember]] = relationship(
        back_populates="workspace", cascade="all, delete-orphan", lazy="selectin"
    )
    collections: Mapped[list[Collection]] = relationship(
        back_populates="workspace", cascade="all, delete-orphan"
    )
    environments: Mapped[list[Environment]] = relationship(
        back_populates="workspace", cascade="all, delete-orphan"
    )


class WorkspaceMember(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "workspace_members"

    workspace_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[Role] = mapped_column(Enum(Role, name="role"), default=Role.EDITOR, nullable=False)

    workspace: Mapped[Workspace] = relationship(back_populates="members")
    user: Mapped[User] = relationship(back_populates="memberships", lazy="joined")

    __table_args__ = (UniqueConstraint("workspace_id", "user_id", name="uq_member"),)


class Invitation(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "invitations"

    workspace_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    email: Mapped[str] = mapped_column(String(320), nullable=False, index=True)
    role: Mapped[Role] = mapped_column(Enum(Role, name="role"), default=Role.EDITOR, nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    invited_by: Mapped[UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    accepted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    __table_args__ = (UniqueConstraint("workspace_id", "email", name="uq_invite"),)


class Environment(Base, UUIDMixin, TimestampMixin, VersionMixin):
    __tablename__ = "environments"

    workspace_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    color: Mapped[str | None] = mapped_column(String(16), nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    workspace: Mapped[Workspace] = relationship(back_populates="environments")
    variables: Mapped[list[EnvVariable]] = relationship(
        back_populates="environment", cascade="all, delete-orphan", lazy="selectin"
    )

    __table_args__ = (UniqueConstraint("workspace_id", "name", name="uq_env_name"),)


class EnvVariable(Base, UUIDMixin, TimestampMixin):
    """A variable in an environment.

    Secret variables store ciphertext in `value_encrypted` and leave `value` null.
    The plaintext is decrypted only when building an execution plan, and is
    replaced by a `{{NAME}}` placeholder before anything reaches a log line or an
    AI provider.
    """

    __tablename__ = "env_variables"

    environment_id: Mapped[UUID] = mapped_column(
        GUID(), ForeignKey("environments.id", ondelete="CASCADE"), index=True
    )
    key: Mapped[str] = mapped_column(String(200), nullable=False)
    value: Mapped[str | None] = mapped_column(Text, nullable=True)
    value_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    is_secret: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    environment: Mapped[Environment] = relationship(back_populates="variables")

    __table_args__ = (UniqueConstraint("environment_id", "key", name="uq_env_var"),)
