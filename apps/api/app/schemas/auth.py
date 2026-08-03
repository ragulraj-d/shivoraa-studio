"""Auth request/response schemas."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=12, max_length=200)
    display_name: str = Field(min_length=1, max_length=120)

    @field_validator("password")
    @classmethod
    def _strength(cls, v: str) -> str:
        # Length is the dominant factor in password strength; composition rules
        # mostly push users toward predictable substitutions. We require length
        # and reject the obvious cases rather than mandating symbol classes.
        if v.lower() in {"password1234", "123456789012", "qwertyuiop12"}:
            raise ValueError("That password is too common. Choose something else.")
        return v


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class GoogleLoginRequest(BaseModel):
    # The ID token from Google Identity Services, verified server-side.
    credential: str = Field(min_length=20)


class UpgradeGuestRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=12, max_length=200)
    display_name: str = Field(min_length=1, max_length=120)


class AuthConfigResponse(BaseModel):
    """What sign-in methods this server actually supports.

    The UI reads this instead of hardcoding buttons, so a Google button never
    appears on a deployment where Google sign-in isn't configured.
    """

    google_enabled: bool
    guest_enabled: bool
    google_client_id: str | None = None


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    # Only returned to non-browser clients (extension/CLI). Browsers get the
    # refresh token as an HttpOnly cookie they cannot read.
    refresh_token: str | None = None


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: str
    display_name: str
    avatar_url: str | None = None
    email_verified: bool
    is_guest: bool
    ai_trial_used: int
    created_at: datetime


class WorkspaceSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    slug: str
    is_personal: bool
    role: str


class MeResponse(BaseModel):
    user: UserResponse
    workspaces: list[WorkspaceSummary]


class DeviceCodeResponse(BaseModel):
    device_code: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_in: int
    interval: int = 5


class DeviceTokenRequest(BaseModel):
    device_code: str


class DeviceApproveRequest(BaseModel):
    user_code: str


class ApiKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class ApiKeyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    key_prefix: str
    last_used_at: datetime | None
    created_at: datetime


class ApiKeyCreatedResponse(ApiKeyResponse):
    # Present exactly once, at creation. Never retrievable afterwards.
    key: str
