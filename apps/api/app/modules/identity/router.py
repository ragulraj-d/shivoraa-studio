"""Auth endpoints."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Cookie, Depends, Request, Response, status
from sqlalchemy import select

from app.core.config import settings
from app.core.deps import CurrentUser, DbSession
from app.core.errors import AuthenticationError
from app.core.security import create_access_token
from app.modules.identity.service import IdentityService
from app.schemas.auth import (
    ApiKeyCreate,
    ApiKeyCreatedResponse,
    ApiKeyResponse,
    AuthConfigResponse,
    DeviceApproveRequest,
    DeviceCodeResponse,
    DeviceTokenRequest,
    GoogleLoginRequest,
    LoginRequest,
    MeResponse,
    RegisterRequest,
    TokenResponse,
    UpgradeGuestRequest,
    UserResponse,
    WorkspaceSummary,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def get_service(db: DbSession) -> IdentityService:
    return IdentityService(db)


Service = Annotated[IdentityService, Depends(get_service)]


def _set_refresh_cookie(response: Response, token: str) -> None:
    """Set the refresh cookie host-only.

    `domain` is deliberately omitted. A cookie scoped to `.shivoraa.in` would be
    readable by every subdomain, including any that ever serves user-controlled
    content; host-only keeps it to the API origin.
    """
    response.set_cookie(
        key=settings.refresh_cookie_name,
        value=token,
        max_age=settings.refresh_token_ttl_days * 86400,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        path="/",
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(key=settings.refresh_cookie_name, path="/")


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(
    payload: RegisterRequest, request: Request, response: Response, service: Service
) -> TokenResponse:
    user = await service.register(payload.email, payload.password, payload.display_name)
    access, refresh, _ = await service.create_session(
        user,
        user_agent=request.headers.get("user-agent"),
        ip_address=request.client.host if request.client else None,
    )
    _set_refresh_cookie(response, refresh)
    return TokenResponse(access_token=access, expires_in=settings.access_token_ttl_minutes * 60)


@router.get("/config", response_model=AuthConfigResponse)
async def auth_config() -> AuthConfigResponse:
    """Which sign-in methods this deployment supports.

    The UI renders buttons from this rather than assuming, so a Google button
    never shows up on a server where Google sign-in isn't configured.
    """
    return AuthConfigResponse(
        google_enabled=bool(settings.google_client_id),
        guest_enabled=True,
        google_client_id=settings.google_client_id or None,
    )


@router.post("/guest", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def continue_as_guest(
    request: Request, response: Response, service: Service
) -> TokenResponse:
    """Create a throwaway account and sign in immediately.

    No email, no password, no confirmation step. The guest gets a real
    workspace seeded with a few working requests, so the first thing they can
    do is press Send rather than fill in a form.
    """
    user = await service.create_guest()
    access, refresh, _ = await service.create_session(
        user,
        user_agent=request.headers.get("user-agent"),
        ip_address=request.client.host if request.client else None,
        client="guest",
    )
    _set_refresh_cookie(response, refresh)
    return TokenResponse(access_token=access, expires_in=settings.access_token_ttl_minutes * 60)


@router.post("/guest/upgrade", response_model=TokenResponse)
async def upgrade_guest(
    payload: UpgradeGuestRequest, user: CurrentUser, service: Service
) -> TokenResponse:
    """Convert the current guest account into a real one, keeping their work."""
    upgraded = await service.upgrade_guest(
        user, payload.email, payload.password, payload.display_name
    )
    access = create_access_token(user_id=upgraded.id, session_id=uuid4())
    return TokenResponse(access_token=access, expires_in=settings.access_token_ttl_minutes * 60)


@router.post("/google", response_model=TokenResponse)
async def google_login(
    payload: GoogleLoginRequest, request: Request, response: Response, service: Service
) -> TokenResponse:
    """Sign in with a Google ID token obtained by the browser."""
    user = await service.authenticate_google(payload.credential)
    access, refresh, _ = await service.create_session(
        user,
        user_agent=request.headers.get("user-agent"),
        ip_address=request.client.host if request.client else None,
        client="google",
    )
    _set_refresh_cookie(response, refresh)
    return TokenResponse(access_token=access, expires_in=settings.access_token_ttl_minutes * 60)


@router.post("/login", response_model=TokenResponse)
async def login(
    payload: LoginRequest, request: Request, response: Response, service: Service
) -> TokenResponse:
    user = await service.authenticate(payload.email, payload.password)
    access, refresh, _ = await service.create_session(
        user,
        user_agent=request.headers.get("user-agent"),
        ip_address=request.client.host if request.client else None,
    )
    _set_refresh_cookie(response, refresh)
    return TokenResponse(access_token=access, expires_in=settings.access_token_ttl_minutes * 60)


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(
    response: Response,
    service: Service,
    sv_refresh: Annotated[str | None, Cookie(alias=settings.refresh_cookie_name)] = None,
    body_token: str | None = None,
) -> TokenResponse:
    token = sv_refresh or body_token
    if not token:
        raise AuthenticationError("No session to refresh.", hint="Sign in again.")
    access, new_refresh = await service.rotate_refresh_token(token)
    _set_refresh_cookie(response, new_refresh)
    return TokenResponse(access_token=access, expires_in=settings.access_token_ttl_minutes * 60)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    response: Response,
    service: Service,
    sv_refresh: Annotated[str | None, Cookie(alias=settings.refresh_cookie_name)] = None,
) -> None:
    if sv_refresh:
        await service.revoke_by_refresh_token(sv_refresh)
    _clear_refresh_cookie(response)


@router.get("/me", response_model=MeResponse)
async def me(user: CurrentUser, service: Service) -> MeResponse:
    workspaces = await service.list_workspaces(user)
    return MeResponse(
        user=UserResponse.model_validate(user),
        workspaces=[
            WorkspaceSummary(
                id=w.id, name=w.name, slug=w.slug, is_personal=w.is_personal, role=role.value
            )
            for w, role in workspaces
        ],
    )


# --------------------------------------------------------------------------- #
# Device authorization — VS Code extension and CLI
# --------------------------------------------------------------------------- #
@router.post("/device/code", response_model=DeviceCodeResponse)
async def device_code(service: Service, client: str = "vscode") -> DeviceCodeResponse:
    code, user_code, ttl = await service.start_device_flow(client)
    base = settings.cors_origins[0] if settings.cors_origins else "http://localhost:5173"
    return DeviceCodeResponse(
        device_code=code,
        user_code=user_code,
        verification_uri=f"{base}/device",
        verification_uri_complete=f"{base}/device?code={user_code}",
        expires_in=ttl,
    )


@router.post("/device/approve", status_code=status.HTTP_204_NO_CONTENT)
async def device_approve(
    payload: DeviceApproveRequest, user: CurrentUser, service: Service
) -> None:
    await service.approve_device(payload.user_code, user)


@router.post("/device/token", response_model=TokenResponse)
async def device_token(payload: DeviceTokenRequest, service: Service) -> TokenResponse:
    access, refresh = await service.poll_device_token(payload.device_code)
    # Non-browser clients receive the refresh token in the body; they store it in
    # the OS keychain via VS Code SecretStorage rather than a cookie.
    return TokenResponse(
        access_token=access,
        refresh_token=refresh,
        expires_in=settings.access_token_ttl_minutes * 60,
    )


# --------------------------------------------------------------------------- #
# API keys
# --------------------------------------------------------------------------- #
@router.get("/api-keys", response_model=list[ApiKeyResponse])
async def list_api_keys(user: CurrentUser, db: DbSession) -> list[ApiKeyResponse]:
    from app.models.user import ApiKey

    rows = await db.execute(
        select(ApiKey).where(ApiKey.user_id == user.id, ApiKey.revoked_at.is_(None))
    )
    return [ApiKeyResponse.model_validate(k) for k in rows.scalars()]


@router.post("/api-keys", response_model=ApiKeyCreatedResponse, status_code=201)
async def create_api_key(
    payload: ApiKeyCreate, user: CurrentUser, service: Service
) -> ApiKeyCreatedResponse:
    api_key, raw = await service.create_api_key(user, payload.name)
    return ApiKeyCreatedResponse(
        id=api_key.id,
        name=api_key.name,
        key_prefix=api_key.key_prefix,
        last_used_at=None,
        created_at=api_key.created_at,
        key=raw,  # shown exactly once
    )


@router.delete("/api-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_api_key(key_id: UUID, user: CurrentUser, db: DbSession) -> None:
    from datetime import UTC, datetime

    from app.models.user import ApiKey

    key = await db.get(ApiKey, key_id)
    if key and key.user_id == user.id:
        key.revoked_at = datetime.now(UTC)
