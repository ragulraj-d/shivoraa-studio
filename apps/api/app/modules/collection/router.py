"""Collection, folder, and request endpoints."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select

from app.core.deps import Auth, DbSession, RequireEditor
from app.models.collection import ApiRequest, Collection, Folder
from app.modules.collection.repository import (
    CollectionRepository,
    FolderRepository,
    RequestRepository,
)
from app.schemas.workspace import (
    CollectionCreate,
    CollectionResponse,
    CollectionTreeResponse,
    CollectionUpdate,
    FolderCreate,
    FolderResponse,
    RequestCreate,
    RequestResponse,
    RequestUpdate,
)

router = APIRouter(tags=["collections"])


def collections_repo(ctx: Auth, db: DbSession) -> CollectionRepository:
    return CollectionRepository(db, ctx.workspace_id)


def requests_repo(ctx: Auth, db: DbSession) -> RequestRepository:
    return RequestRepository(db, ctx.workspace_id)


def folders_repo(ctx: Auth, db: DbSession) -> FolderRepository:
    return FolderRepository(db, ctx.workspace_id)


Collections = Annotated[CollectionRepository, Depends(collections_repo)]
Requests = Annotated[RequestRepository, Depends(requests_repo)]
Folders = Annotated[FolderRepository, Depends(folders_repo)]


# --------------------------------------------------------------------------- #
# Collections
# --------------------------------------------------------------------------- #
@router.get("/collections", response_model=list[CollectionTreeResponse])
async def list_collections(repo: Collections) -> list[CollectionTreeResponse]:
    """The whole tree in one call.

    The explorer needs collections, folders, and requests together; three
    round-trips would show a visibly staggered tree on load.
    """
    collections = await repo.list_tree()
    return [
        CollectionTreeResponse(
            **CollectionResponse.model_validate(c).model_dump(),
            folders=[FolderResponse.model_validate(f) for f in c.folders],
            requests=[RequestResponse.model_validate(r) for r in c.requests],
        )
        for c in collections
    ]


@router.post("/collections", response_model=CollectionResponse, status_code=201)
async def create_collection(
    payload: CollectionCreate, ctx: RequireEditor, db: DbSession
) -> CollectionResponse:
    collection = Collection(
        workspace_id=ctx.workspace_id,
        name=payload.name,
        description=payload.description,
        base_url=payload.base_url,
    )
    db.add(collection)
    await db.flush()
    return CollectionResponse.model_validate(collection)


@router.get("/collections/{collection_id}", response_model=CollectionTreeResponse)
async def get_collection(collection_id: UUID, repo: Collections) -> CollectionTreeResponse:
    c = await repo.get_tree(collection_id)
    return CollectionTreeResponse(
        **CollectionResponse.model_validate(c).model_dump(),
        folders=[FolderResponse.model_validate(f) for f in c.folders],
        requests=[RequestResponse.model_validate(r) for r in c.requests],
    )


@router.patch("/collections/{collection_id}", response_model=CollectionResponse)
async def update_collection(
    collection_id: UUID, payload: CollectionUpdate, ctx: RequireEditor, repo: Collections
) -> CollectionResponse:
    data = payload.model_dump(exclude_unset=True, exclude={"version"})
    collection = await repo.update_versioned(collection_id, data, payload.version)
    return CollectionResponse.model_validate(collection)


@router.delete("/collections/{collection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_collection(collection_id: UUID, ctx: RequireEditor, repo: Collections) -> None:
    await repo.delete(collection_id)


# --------------------------------------------------------------------------- #
# Folders
# --------------------------------------------------------------------------- #
@router.post("/collections/{collection_id}/folders", response_model=FolderResponse, status_code=201)
async def create_folder(
    collection_id: UUID,
    payload: FolderCreate,
    ctx: RequireEditor,
    repo: Collections,
    db: DbSession,
) -> FolderResponse:
    await repo.get_or_404(collection_id, "collection")
    folder = Folder(
        collection_id=collection_id,
        parent_id=payload.parent_id,
        name=payload.name,
        description=payload.description,
    )
    db.add(folder)
    await db.flush()
    return FolderResponse.model_validate(folder)


@router.delete("/folders/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder(folder_id: UUID, ctx: RequireEditor, repo: Folders) -> None:
    await repo.delete(folder_id)


# --------------------------------------------------------------------------- #
# Requests
# --------------------------------------------------------------------------- #
@router.post(
    "/collections/{collection_id}/requests", response_model=RequestResponse, status_code=201
)
async def create_request(
    collection_id: UUID,
    payload: RequestCreate,
    ctx: RequireEditor,
    repo: Collections,
    db: DbSession,
) -> RequestResponse:
    await repo.get_or_404(collection_id, "collection")

    position = await db.scalar(
        select(ApiRequest.position)
        .where(ApiRequest.collection_id == collection_id)
        .order_by(ApiRequest.position.desc())
        .limit(1)
    )

    request_row = ApiRequest(
        collection_id=collection_id,
        folder_id=payload.folder_id,
        name=payload.name,
        method=payload.method.upper(),
        url=payload.url,
        description=payload.description,
        headers=[h.model_dump() for h in payload.headers],
        query_params=[q.model_dump() for q in payload.query_params],
        body=payload.body.model_dump(),
        auth=payload.auth.model_dump() if payload.auth else None,
        position=(position or 0) + 1,
    )
    db.add(request_row)
    await db.flush()
    return RequestResponse.model_validate(request_row)


@router.get("/requests/{request_id}", response_model=RequestResponse)
async def get_request(request_id: UUID, repo: Requests) -> RequestResponse:
    return RequestResponse.model_validate(await repo.get_or_404(request_id))


@router.patch("/requests/{request_id}", response_model=RequestResponse)
async def update_request(
    request_id: UUID, payload: RequestUpdate, ctx: RequireEditor, repo: Requests
) -> RequestResponse:
    data = payload.model_dump(exclude_unset=True, exclude={"version"})
    if "method" in data and data["method"]:
        data["method"] = data["method"].upper()
    for key in ("headers", "query_params", "path_params"):
        if key in data and data[key] is not None:
            data[key] = [item for item in data[key]]
    updated = await repo.update_versioned(request_id, data, payload.version)
    return RequestResponse.model_validate(updated)


@router.delete("/requests/{request_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_request(request_id: UUID, ctx: RequireEditor, repo: Requests) -> None:
    await repo.delete(request_id)


@router.get("/requests", response_model=list[RequestResponse])
async def search_requests(
    repo: Requests, q: Annotated[str, Query(min_length=1)], limit: int = 50
) -> list[RequestResponse]:
    rows = await repo.search(q, limit)
    return [RequestResponse.model_validate(r) for r in rows]
