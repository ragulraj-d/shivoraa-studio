"""Workspace and membership schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class WorkspaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = None


class WorkspaceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    default_provider_id: UUID | None = None


class WorkspaceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    slug: str
    description: str | None
    is_personal: bool
    plan: str
    default_provider_id: UUID | None
    created_at: datetime


class MemberResponse(BaseModel):
    id: UUID
    user_id: UUID
    email: str
    display_name: str
    avatar_url: str | None
    role: str
    joined_at: datetime


class InviteCreate(BaseModel):
    email: EmailStr
    role: Literal["editor", "viewer"] = "editor"


class RoleUpdate(BaseModel):
    role: Literal["owner", "editor", "viewer"]
