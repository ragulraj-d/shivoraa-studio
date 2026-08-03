"""Dialect-portable column types.

PostgreSQL is the production database and gets its native UUID and JSONB. But
requiring a Postgres server just to run the app locally is friction, so these
decorators fall back to portable representations on SQLite. The Python-side type
is identical either way, so no application code knows the difference.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy import CHAR, Text, TypeDecorator
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.engine import Dialect
from sqlalchemy.types import JSON


class GUID(TypeDecorator[uuid.UUID]):
    """UUID as a native Postgres type, CHAR(36) elsewhere."""

    impl = CHAR
    cache_ok = True

    def load_dialect_impl(self, dialect: Dialect) -> Any:
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PGUUID(as_uuid=True))
        return dialect.type_descriptor(CHAR(36))

    def process_bind_param(self, value: Any, dialect: Dialect) -> Any:
        if value is None:
            return None
        if not isinstance(value, uuid.UUID):
            value = uuid.UUID(str(value))
        return value if dialect.name == "postgresql" else str(value)

    def process_result_value(self, value: Any, dialect: Dialect) -> uuid.UUID | None:
        if value is None:
            return None
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


class JSONType(TypeDecorator[Any]):
    """JSONB on Postgres (indexable, binary), JSON text elsewhere."""

    impl = Text
    cache_ok = True

    def load_dialect_impl(self, dialect: Dialect) -> Any:
        if dialect.name == "postgresql":
            return dialect.type_descriptor(JSONB())
        return dialect.type_descriptor(JSON())

    def process_bind_param(self, value: Any, dialect: Dialect) -> Any:
        # Both backends serialise natively; this hook exists only so a stray
        # non-serialisable value fails here with a clear error rather than deep
        # inside the driver.
        if value is not None and dialect.name != "postgresql":
            json.dumps(value)
        return value
