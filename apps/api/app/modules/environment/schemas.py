"""Environment and variable schemas."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


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
