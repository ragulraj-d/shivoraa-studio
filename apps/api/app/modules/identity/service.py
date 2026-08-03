"""Identity service: registration, login, token rotation, device flow."""

from __future__ import annotations

import re
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import AuthenticationError, ConflictError, NotFoundError, ValidationError
from app.core.security import (
    create_access_token,
    generate_api_key,
    generate_device_code,
    generate_refresh_token,
    hash_password,
    hash_token,
    verify_password,
)
from app.models.user import ApiKey, DeviceAuthorization, RefreshToken, Session, User
from app.models.workspace import Environment, Role, Workspace, WorkspaceMember

log = structlog.get_logger()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "workspace"


class IdentityService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ------------------------------------------------------------------ #
    # Registration
    # ------------------------------------------------------------------ #
    async def register(self, email: str, password: str, display_name: str) -> User:
        existing = await self.db.scalar(select(User).where(User.email == email.lower()))
        if existing:
            raise ConflictError(
                "An account with that email already exists.",
                hint="Try signing in instead, or reset your password.",
            )

        user = User(
            email=email.lower(),
            password_hash=hash_password(password),
            display_name=display_name.strip(),
            email_verified=settings.environment == "local",  # skip the mail round-trip in dev
        )
        self.db.add(user)
        await self.db.flush()

        await self._bootstrap_workspace(user)
        await self.db.flush()

        log.info("user_registered", user_id=str(user.id))
        return user

    async def _bootstrap_workspace(self, user: User) -> Workspace:
        """Give every new user a personal workspace with a Development environment.

        A brand-new user landing on a completely empty app has nowhere to start;
        seeding one workspace and one environment removes two setup steps before
        their first request.
        """
        base = slugify(user.display_name or user.email.split("@")[0])
        workspace = Workspace(
            name=f"{user.display_name}'s Workspace",
            slug=f"{base}-{secrets.token_hex(4)}",
            is_personal=True,
        )
        self.db.add(workspace)
        await self.db.flush()

        self.db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=Role.OWNER))
        self.db.add(
            Environment(
                workspace_id=workspace.id, name="Development", is_default=True, color="#22c55e"
            )
        )
        return workspace

    # ------------------------------------------------------------------ #
    # Login
    # ------------------------------------------------------------------ #
    async def authenticate(self, email: str, password: str) -> User:
        user = await self.db.scalar(select(User).where(User.email == email.lower()))

        # Always run a hash comparison, even when the user does not exist, so the
        # response time does not reveal whether an email is registered.
        password_hash = (
            user.password_hash if user and user.password_hash else hash_password("dummy")
        )
        valid = verify_password(password, password_hash)

        if not user or not valid:
            raise AuthenticationError(
                "Email or password is incorrect.",
                hint="Check for typos, or reset your password.",
            )
        if not user.is_active:
            raise AuthenticationError("This account has been deactivated.")

        user.last_login_at = datetime.now(UTC)
        return user

    async def create_session(
        self,
        user: User,
        *,
        user_agent: str | None = None,
        ip_address: str | None = None,
        client: str = "web",
    ) -> tuple[str, str, Session]:
        session = Session(
            user_id=user.id,
            user_agent=user_agent,
            ip_address=ip_address,
            client=client,
            last_seen_at=datetime.now(UTC),
        )
        self.db.add(session)
        await self.db.flush()

        access = create_access_token(user_id=user.id, session_id=session.id)
        refresh_raw, refresh_hash = generate_refresh_token()
        self.db.add(
            RefreshToken(
                session_id=session.id,
                token_hash=refresh_hash,
                expires_at=datetime.now(UTC) + timedelta(days=settings.refresh_token_ttl_days),
            )
        )
        return access, refresh_raw, session

    # ------------------------------------------------------------------ #
    # Token rotation with reuse detection
    # ------------------------------------------------------------------ #
    async def rotate_refresh_token(self, raw_token: str) -> tuple[str, str]:
        token = await self.db.scalar(
            select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw_token))
        )
        if token is None:
            raise AuthenticationError("Please sign in again.", code="invalid_refresh")

        session = await self.db.get(Session, token.session_id)
        if session is None or session.revoked_at is not None:
            raise AuthenticationError("This session has been signed out.", code="session_revoked")

        if token.consumed_at is not None:
            # A legitimate client never presents the same refresh token twice.
            # Reuse means the token leaked, so the whole session dies rather than
            # letting an attacker and the real user both hold valid credentials.
            log.warning("refresh_token_reuse_detected", session_id=str(session.id))
            session.revoked_at = datetime.now(UTC)
            raise AuthenticationError(
                "For your security, we signed you out.",
                hint="Your session token was used more than once, which can mean it was copied.",
                code="token_reuse_detected",
            )

        if token.expires_at < datetime.now(UTC):
            raise AuthenticationError("Your session expired. Please sign in again.")

        token.consumed_at = datetime.now(UTC)
        session.last_seen_at = datetime.now(UTC)

        access = create_access_token(user_id=session.user_id, session_id=session.id)
        new_raw, new_hash = generate_refresh_token()
        self.db.add(
            RefreshToken(
                session_id=session.id,
                token_hash=new_hash,
                expires_at=datetime.now(UTC) + timedelta(days=settings.refresh_token_ttl_days),
            )
        )
        return access, new_raw

    async def revoke_session(self, session_id: UUID) -> None:
        session = await self.db.get(Session, session_id)
        if session:
            session.revoked_at = datetime.now(UTC)

    async def revoke_by_refresh_token(self, raw_token: str) -> None:
        token = await self.db.scalar(
            select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw_token))
        )
        if token:
            await self.revoke_session(token.session_id)

    # ------------------------------------------------------------------ #
    # Device authorization (VS Code extension, CLI)
    # ------------------------------------------------------------------ #
    async def start_device_flow(self, client: str = "vscode") -> tuple[str, str, int]:
        device_code, user_code = generate_device_code()
        ttl = 900
        self.db.add(
            DeviceAuthorization(
                device_code_hash=hash_token(device_code),
                user_code=user_code,
                client=client,
                expires_at=datetime.now(UTC) + timedelta(seconds=ttl),
            )
        )
        return device_code, user_code, ttl

    async def approve_device(self, user_code: str, user: User) -> None:
        auth = await self.db.scalar(
            select(DeviceAuthorization).where(DeviceAuthorization.user_code == user_code.upper())
        )
        if auth is None:
            raise NotFoundError(
                "That code isn't recognised.", hint="Check the code shown in your editor."
            )
        if auth.expires_at < datetime.now(UTC):
            raise ValidationError(
                "That code has expired.", hint="Start the sign-in again from your editor."
            )
        if auth.approved_at or auth.denied_at:
            raise ConflictError("That code has already been used.")

        auth.approved_at = datetime.now(UTC)
        auth.user_id = user.id

    async def poll_device_token(self, device_code: str) -> tuple[str, str]:
        auth = await self.db.scalar(
            select(DeviceAuthorization).where(
                DeviceAuthorization.device_code_hash == hash_token(device_code)
            )
        )
        if auth is None:
            raise AuthenticationError("Unknown device code.", code="invalid_grant")
        if auth.expires_at < datetime.now(UTC):
            raise AuthenticationError("This code expired.", code="expired_token")
        if auth.denied_at:
            raise AuthenticationError("Sign-in was denied.", code="access_denied")
        if auth.consumed_at:
            raise AuthenticationError("This code was already exchanged.", code="invalid_grant")
        if not auth.approved_at or not auth.user_id:
            # The polling contract: this is an expected, non-terminal response.
            raise AuthenticationError("Waiting for approval.", code="authorization_pending")

        user = await self.db.get(User, auth.user_id)
        if user is None:
            raise AuthenticationError("That account no longer exists.")

        auth.consumed_at = datetime.now(UTC)
        access, refresh, _ = await self.create_session(user, client=auth.client)
        return access, refresh

    # ------------------------------------------------------------------ #
    # API keys
    # ------------------------------------------------------------------ #
    async def create_api_key(self, user: User, name: str) -> tuple[ApiKey, str]:
        raw, key_hash, prefix = generate_api_key()
        api_key = ApiKey(user_id=user.id, name=name, key_hash=key_hash, key_prefix=prefix)
        self.db.add(api_key)
        await self.db.flush()
        return api_key, raw

    async def list_workspaces(self, user: User) -> list[tuple[Workspace, Role]]:
        rows = await self.db.execute(
            select(Workspace, WorkspaceMember.role)
            .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
            .where(WorkspaceMember.user_id == user.id)
            .order_by(Workspace.created_at)
        )
        return [(w, r) for w, r in rows.all()]
