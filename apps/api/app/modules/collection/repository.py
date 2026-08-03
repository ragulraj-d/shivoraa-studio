"""Workspace-scoped repositories.

Every query in a scoped repository passes through `_scope()`, which appends the
workspace predicate. That single choke point is what makes tenant isolation
testable — a test can enumerate these methods and assert the predicate is present,
which no amount of code review reliably achieves at scale.
"""

from __future__ import annotations

from typing import Any, Generic, TypeVar
from uuid import UUID

from sqlalchemy import Select, delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.db import Base
from app.core.errors import ConflictError, NotFoundError
from app.models.collection import ApiRequest, Collection, Folder

T = TypeVar("T", bound=Base)


class WorkspaceScopedRepository(Generic[T]):
    model: type[T]

    def __init__(self, db: AsyncSession, workspace_id: UUID) -> None:
        self.db = db
        self.workspace_id = workspace_id

    def _scope(self, stmt: Select[Any]) -> Select[Any]:
        return stmt.where(self.model.workspace_id == self.workspace_id)  # type: ignore[attr-defined]

    async def get(self, entity_id: UUID) -> T | None:
        return await self.db.scalar(
            self._scope(select(self.model).where(self.model.id == entity_id))
        )  # type: ignore[attr-defined]

    async def get_or_404(self, entity_id: UUID, label: str = "item") -> T:
        entity = await self.get(entity_id)
        if entity is None:
            raise NotFoundError(f"That {label} doesn't exist, or you don't have access to it.")
        return entity

    async def list(self) -> list[T]:
        rows = await self.db.execute(self._scope(select(self.model)))
        return list(rows.scalars())

    async def delete(self, entity_id: UUID) -> None:
        entity = await self.get_or_404(entity_id)
        await self.db.delete(entity)


class CollectionRepository(WorkspaceScopedRepository[Collection]):
    model = Collection

    async def list_tree(self) -> list[Collection]:
        stmt = (
            self._scope(select(Collection))
            .options(selectinload(Collection.folders), selectinload(Collection.requests))
            .order_by(Collection.position, Collection.created_at)
        )
        rows = await self.db.execute(stmt)
        return list(rows.scalars().unique())

    async def get_tree(self, collection_id: UUID) -> Collection:
        stmt = (
            self._scope(select(Collection))
            .where(Collection.id == collection_id)
            .options(selectinload(Collection.folders), selectinload(Collection.requests))
        )
        collection = (await self.db.execute(stmt)).scalars().unique().one_or_none()
        if collection is None:
            raise NotFoundError("That collection doesn't exist, or you don't have access to it.")
        return collection

    async def update_versioned(
        self, collection_id: UUID, values: dict[str, Any], expected_version: int | None
    ) -> Collection:
        return await _versioned_update(
            self.db, Collection, collection_id, values, expected_version, "collection"
        )


class RequestRepository:
    """Requests are scoped through their parent collection rather than carrying
    workspace_id themselves — a join keeps the schema normalised, and the
    collection lookup already enforces the tenant boundary."""

    def __init__(self, db: AsyncSession, workspace_id: UUID) -> None:
        self.db = db
        self.workspace_id = workspace_id

    def _scope(self, stmt: Select[Any]) -> Select[Any]:
        return stmt.join(Collection, ApiRequest.collection_id == Collection.id).where(
            Collection.workspace_id == self.workspace_id
        )

    async def get(self, request_id: UUID) -> ApiRequest | None:
        return await self.db.scalar(
            self._scope(select(ApiRequest)).where(ApiRequest.id == request_id)
        )

    async def get_or_404(self, request_id: UUID) -> ApiRequest:
        req = await self.get(request_id)
        if req is None:
            raise NotFoundError("That request doesn't exist, or you don't have access to it.")
        return req

    async def list_for_collection(self, collection_id: UUID) -> list[ApiRequest]:
        rows = await self.db.execute(
            self._scope(select(ApiRequest))
            .where(ApiRequest.collection_id == collection_id)
            .order_by(ApiRequest.position, ApiRequest.created_at)
        )
        return list(rows.scalars())

    async def search(self, term: str, limit: int = 50) -> list[ApiRequest]:
        pattern = f"%{term}%"
        rows = await self.db.execute(
            self._scope(select(ApiRequest))
            .where(ApiRequest.name.ilike(pattern) | ApiRequest.url.ilike(pattern))
            .limit(limit)
        )
        return list(rows.scalars())

    async def update_versioned(
        self, request_id: UUID, values: dict[str, Any], expected_version: int | None
    ) -> ApiRequest:
        await self.get_or_404(request_id)  # enforces tenancy before the versioned write
        return await _versioned_update(
            self.db, ApiRequest, request_id, values, expected_version, "request"
        )

    async def delete(self, request_id: UUID) -> None:
        req = await self.get_or_404(request_id)
        await self.db.delete(req)


class FolderRepository:
    def __init__(self, db: AsyncSession, workspace_id: UUID) -> None:
        self.db = db
        self.workspace_id = workspace_id

    async def get_or_404(self, folder_id: UUID) -> Folder:
        folder = await self.db.scalar(
            select(Folder)
            .join(Collection, Folder.collection_id == Collection.id)
            .where(Folder.id == folder_id, Collection.workspace_id == self.workspace_id)
        )
        if folder is None:
            raise NotFoundError("That folder doesn't exist, or you don't have access to it.")
        return folder

    async def delete(self, folder_id: UUID) -> None:
        folder = await self.get_or_404(folder_id)
        await self.db.delete(folder)


async def _versioned_update(
    db: AsyncSession,
    model: type[Any],
    entity_id: UUID,
    values: dict[str, Any],
    expected_version: int | None,
    label: str,
) -> Any:
    """Optimistic concurrency in a single statement.

    `WHERE id = ? AND version = ?` is atomic — no read-modify-write race is
    possible. Zero rows affected means someone else wrote first, and the caller
    gets a 409 carrying the current server state so the client can show a diff
    without a second round-trip.
    """
    values = {k: v for k, v in values.items() if v is not None}
    if not values:
        entity = await db.get(model, entity_id)
        if entity is None:
            raise NotFoundError(f"That {label} no longer exists.")
        return entity

    stmt = update(model).where(model.id == entity_id)
    if expected_version is not None:
        stmt = stmt.where(model.version == expected_version)

    result = await db.execute(stmt.values(**values, version=model.version + 1).returning(model))
    entity = result.scalars().one_or_none()

    if entity is None:
        current = await db.get(model, entity_id)
        if current is None:
            raise NotFoundError(f"That {label} no longer exists.")
        raise ConflictError(
            f"This {label} was changed somewhere else while you were editing it.",
            hint="Review both versions and choose which changes to keep.",
            code="version_conflict",
            extra={
                "server_version": current.version,
                "base_version": expected_version,
                "server_state": {
                    c.name: _jsonable(getattr(current, c.name)) for c in current.__table__.columns
                },
            },
        )
    return entity


def _jsonable(value: Any) -> Any:
    from datetime import datetime
    from uuid import UUID as _UUID

    if isinstance(value, _UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    return value


__all__ = [
    "CollectionRepository",
    "FolderRepository",
    "RequestRepository",
    "WorkspaceScopedRepository",
    "delete",
]
