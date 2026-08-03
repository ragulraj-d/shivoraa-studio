"""Request-scoped dependencies: authentication, workspace context, permissions."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

import jwt
from fastapi import Depends, Header, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.errors import AuthenticationError, NotFoundError, PermissionError_
from app.core.security import decode_access_token, hash_token
from app.models.user import ApiKey, Session, User
from app.models.workspace import Role, Workspace, WorkspaceMember

DbSession = Annotated[AsyncSession, Depends(get_session)]


@dataclass(slots=True)
class AuthContext:
    """Everything an endpoint needs to authorize an action."""

    user: User
    workspace: Workspace
    role: Role

    @property
    def user_id(self) -> UUID:
        return self.user.id

    @property
    def workspace_id(self) -> UUID:
        return self.workspace.id

    def require(self, *roles: Role) -> None:
        if self.role not in roles:
            raise PermissionError_(
                f"This action requires {' or '.join(r.value for r in roles)} access.",
                hint=f"You have {self.role.value} access to this workspace.",
            )

    @property
    def can_write(self) -> bool:
        return self.role in (Role.OWNER, Role.EDITOR)


async def get_current_user(
    request: Request,
    db: DbSession,
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    """Resolve the caller from a Bearer JWT or an `sk_live_` API key."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise AuthenticationError(
            "You need to be signed in to do that.", hint="Include an Authorization header."
        )

    token = authorization[7:].strip()

    # API keys are for automation; they carry no session and cannot be refreshed.
    if token.startswith("sk_live_"):
        stmt = select(ApiKey).where(
            ApiKey.key_hash == hash_token(token), ApiKey.revoked_at.is_(None)
        )
        api_key = (await db.execute(stmt)).scalar_one_or_none()
        if not api_key:
            raise AuthenticationError("That API key is not valid or has been revoked.")
        api_key.last_used_at = datetime.now(UTC)
        user = await db.get(User, api_key.user_id)
        if not user or not user.is_active:
            raise AuthenticationError("This account is no longer active.")
        request.state.user_id = str(user.id)
        return user

    try:
        payload = decode_access_token(token)
    except jwt.ExpiredSignatureError as exc:
        raise AuthenticationError(
            "Your session expired.",
            hint="Refresh your session and try again.",
            code="token_expired",
        ) from exc
    except jwt.PyJWTError as exc:
        raise AuthenticationError("That sign-in token isn't valid.") from exc

    # A revoked session must stop working immediately, so session state is
    # checked on every request rather than trusted from the token alone.
    session = await db.get(Session, UUID(payload["sid"]))
    if session is None or session.revoked_at is not None:
        raise AuthenticationError("This session has been signed out.", code="session_revoked")

    user = await db.get(User, UUID(payload["sub"]))
    if user is None or not user.is_active:
        raise AuthenticationError("This account is no longer active.")

    request.state.user_id = str(user.id)
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def get_auth_context(
    request: Request,
    db: DbSession,
    user: CurrentUser,
    x_workspace_id: Annotated[str | None, Header()] = None,
) -> AuthContext:
    """Resolve the active workspace and re-check membership.

    Membership is read from the database on every request rather than trusted
    from the JWT, so removing someone from a workspace takes effect immediately
    instead of when their token happens to expire.
    """
    workspace_id: UUID | None = None
    if x_workspace_id:
        try:
            workspace_id = UUID(x_workspace_id)
        except ValueError as exc:
            raise AuthenticationError("X-Workspace-Id is not a valid identifier.") from exc

    stmt = select(WorkspaceMember).where(WorkspaceMember.user_id == user.id)
    if workspace_id:
        stmt = stmt.where(WorkspaceMember.workspace_id == workspace_id)

    member = (await db.execute(stmt.limit(1))).scalar_one_or_none()
    if member is None:
        raise PermissionError_(
            "You don't have access to that workspace.",
            hint="Ask an owner to invite you, or switch to a workspace you belong to.",
        )

    workspace = await db.get(Workspace, member.workspace_id)
    if workspace is None:
        raise NotFoundError("That workspace no longer exists.")

    request.state.workspace_id = str(workspace.id)
    return AuthContext(user=user, workspace=workspace, role=member.role)


Auth = Annotated[AuthContext, Depends(get_auth_context)]


def require_role(*roles: Role):  # noqa: ANN201 — FastAPI dependency factory
    """Declare the minimum role for a route.

    Used as a dependency so permission checks are declarative and greppable
    rather than scattered through service bodies.
    """

    async def _check(ctx: Auth) -> AuthContext:
        ctx.require(*roles)
        return ctx

    return _check


RequireEditor = Annotated[AuthContext, Depends(require_role(Role.OWNER, Role.EDITOR))]
RequireOwner = Annotated[AuthContext, Depends(require_role(Role.OWNER))]
