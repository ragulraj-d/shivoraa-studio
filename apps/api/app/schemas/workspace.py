"""Workspace, environment, collection, and request schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field


# --------------------------------------------------------------------------- #
# Workspace
# --------------------------------------------------------------------------- #
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


# --------------------------------------------------------------------------- #
# Environment
# --------------------------------------------------------------------------- #
class VariableIn(BaseModel):
    key: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    value: str = ""
    is_secret: bool = False
    enabled: bool = True
    description: str | None = None


class VariableResponse(BaseModel):
    id: UUID
    key: str
    # Secret values are never serialised. The client sees the mask and knows a
    # value exists; only execution-plan building decrypts the real thing.
    value: str | None
    is_secret: bool
    enabled: bool
    description: str | None


class EnvironmentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    color: str | None = None
    variables: list[VariableIn] = Field(default_factory=list)


class EnvironmentUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    color: str | None = None
    is_default: bool | None = None
    variables: list[VariableIn] | None = None


class EnvironmentResponse(BaseModel):
    id: UUID
    name: str
    color: str | None
    is_default: bool
    version: int
    variables: list[VariableResponse]
    created_at: datetime


# --------------------------------------------------------------------------- #
# Collections & requests
# --------------------------------------------------------------------------- #
class KeyValue(BaseModel):
    key: str = ""
    value: str = ""
    enabled: bool = True
    description: str | None = None


class RequestBody(BaseModel):
    mode: Literal["none", "json", "raw", "form", "urlencoded", "graphql", "binary"] = "none"
    content: str = ""
    form_data: list[KeyValue] = Field(default_factory=list)
    graphql_variables: str = ""
    content_type: str | None = None


class AuthConfig(BaseModel):
    type: Literal["none", "inherit", "bearer", "basic", "api_key"] = "inherit"
    token: str = ""
    username: str = ""
    password: str = ""
    key: str = ""
    value: str = ""
    add_to: Literal["header", "query"] = "header"


class CollectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    base_url: str | None = None


class CollectionUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    base_url: str | None = None
    auth: dict[str, Any] | None = None
    default_headers: list[dict[str, Any]] | None = None
    docs_markdown: str | None = None
    version: int | None = None  # optimistic concurrency


class FolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    parent_id: UUID | None = None
    description: str | None = None


class RequestCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    method: str = "GET"
    url: str = ""
    folder_id: UUID | None = None
    description: str | None = None
    headers: list[KeyValue] = Field(default_factory=list)
    query_params: list[KeyValue] = Field(default_factory=list)
    body: RequestBody = Field(default_factory=RequestBody)
    auth: AuthConfig | None = None


class RequestUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    method: str | None = None
    url: str | None = None
    folder_id: UUID | None = None
    description: str | None = None
    headers: list[KeyValue] | None = None
    query_params: list[KeyValue] | None = None
    path_params: list[KeyValue] | None = None
    body: RequestBody | None = None
    auth: AuthConfig | None = None
    settings: dict[str, Any] | None = None
    position: int | None = None
    docs_markdown: str | None = None
    tests_code: str | None = None
    tests_framework: str | None = None
    version: int | None = None


class RequestResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    collection_id: UUID
    folder_id: UUID | None
    name: str
    method: str
    url: str
    description: str | None
    headers: list[dict[str, Any]]
    query_params: list[dict[str, Any]]
    path_params: list[dict[str, Any]]
    body: dict[str, Any]
    auth: dict[str, Any] | None
    settings: dict[str, Any]
    position: int
    docs_markdown: str | None
    tests_code: str | None
    tests_framework: str | None
    version: int
    updated_at: datetime


class FolderResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    collection_id: UUID
    parent_id: UUID | None
    name: str
    description: str | None
    position: int
    version: int


class CollectionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    workspace_id: UUID
    name: str
    description: str | None
    base_url: str | None
    auth: dict[str, Any]
    default_headers: list[dict[str, Any]]
    docs_markdown: str | None
    position: int
    version: int
    created_at: datetime


class CollectionTreeResponse(CollectionResponse):
    """A collection with its full contents, for the explorer tree."""

    folders: list[FolderResponse] = Field(default_factory=list)
    requests: list[RequestResponse] = Field(default_factory=list)
