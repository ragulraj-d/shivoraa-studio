"""Shared request primitives.

KeyValue, RequestBody and AuthConfig describe the shape of an HTTP request.
The collection module stores them and the execution module sends them, so they
belong to neither — putting them in core keeps modules from importing each
other's internals.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


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
