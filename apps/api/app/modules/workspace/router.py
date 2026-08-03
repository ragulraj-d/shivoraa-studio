"""Workspace and membership endpoints."""

from __future__ import annotations

import secrets
from uuid import UUID

from fastapi import APIRouter, status
from sqlalchemy import func, select

from app.core.deps import Auth, CurrentUser, DbSession, RequireOwner
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models.user import User
from app.models.workspace import Environment, Role, Workspace, WorkspaceMember
from app.modules.identity.service import slugify
from app.schemas.workspace import (
    InviteCreate,
    MemberResponse,
    RoleUpdate,
    WorkspaceCreate,
    WorkspaceResponse,
    WorkspaceUpdate,
)

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


@router.post("", response_model=WorkspaceResponse, status_code=201)
async def create_workspace(
    payload: WorkspaceCreate, user: CurrentUser, db: DbSession
) -> WorkspaceResponse:
    workspace = Workspace(
        name=payload.name,
        slug=f"{slugify(payload.name)}-{secrets.token_hex(4)}",
        description=payload.description,
        is_personal=False,
    )
    db.add(workspace)
    await db.flush()

    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=Role.OWNER))
    db.add(Environment(workspace_id=workspace.id, name="Development", is_default=True))
    await db.flush()
    return WorkspaceResponse.model_validate(workspace)


@router.get("/current", response_model=WorkspaceResponse)
async def get_current_workspace(ctx: Auth) -> WorkspaceResponse:
    return WorkspaceResponse.model_validate(ctx.workspace)


@router.patch("/current", response_model=WorkspaceResponse)
async def update_workspace(payload: WorkspaceUpdate, ctx: RequireOwner) -> WorkspaceResponse:
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(ctx.workspace, field, value)
    return WorkspaceResponse.model_validate(ctx.workspace)


@router.delete("/current", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workspace(ctx: RequireOwner, db: DbSession) -> None:
    if ctx.workspace.is_personal:
        raise ValidationError(
            "Your personal workspace can't be deleted.",
            hint="Delete your account instead if you want to remove everything.",
        )
    await db.delete(ctx.workspace)


# --------------------------------------------------------------------------- #
# Members
# --------------------------------------------------------------------------- #
@router.get("/current/members", response_model=list[MemberResponse])
async def list_members(ctx: Auth, db: DbSession) -> list[MemberResponse]:
    rows = await db.execute(
        select(WorkspaceMember, User)
        .join(User, WorkspaceMember.user_id == User.id)
        .where(WorkspaceMember.workspace_id == ctx.workspace_id)
        .order_by(WorkspaceMember.created_at)
    )
    return [
        MemberResponse(
            id=m.id,
            user_id=u.id,
            email=u.email,
            display_name=u.display_name,
            avatar_url=u.avatar_url,
            role=m.role.value,
            joined_at=m.created_at,
        )
        for m, u in rows.all()
    ]


@router.post("/current/members", response_model=MemberResponse, status_code=201)
async def add_member(payload: InviteCreate, ctx: RequireOwner, db: DbSession) -> MemberResponse:
    """Add a member by email.

    Invitation emails arrive with SES wiring; until then an existing user is
    added directly, which keeps team workspaces usable without a mail provider.
    """
    user = await db.scalar(select(User).where(User.email == payload.email.lower()))
    if user is None:
        raise NotFoundError(
            "Nobody with that email has a Shivoraa account yet.",
            hint="Ask them to sign up first, then add them here.",
        )

    existing = await db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == ctx.workspace_id,
            WorkspaceMember.user_id == user.id,
        )
    )
    if existing:
        raise ConflictError(f"{user.display_name} is already in this workspace.")

    member = WorkspaceMember(
        workspace_id=ctx.workspace_id, user_id=user.id, role=Role(payload.role)
    )
    db.add(member)
    await db.flush()
    return MemberResponse(
        id=member.id,
        user_id=user.id,
        email=user.email,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        role=member.role.value,
        joined_at=member.created_at,
    )


@router.patch("/current/members/{member_id}", response_model=MemberResponse)
async def update_member_role(
    member_id: UUID, payload: RoleUpdate, ctx: RequireOwner, db: DbSession
) -> MemberResponse:
    member = await db.get(WorkspaceMember, member_id)
    if member is None or member.workspace_id != ctx.workspace_id:
        raise NotFoundError("That member isn't in this workspace.")

    if member.user_id == ctx.user_id:
        raise ValidationError(
            "You can't change your own role.",
            hint="Ask another owner to do it.",
        )

    # A workspace without an owner is unadministrable, so the last one is pinned.
    if member.role == Role.OWNER and payload.role != "owner":
        owners = await db.scalar(
            select(func.count())
            .select_from(WorkspaceMember)
            .where(
                WorkspaceMember.workspace_id == ctx.workspace_id,
                WorkspaceMember.role == Role.OWNER,
            )
        )
        if (owners or 0) <= 1:
            raise ValidationError(
                "This is the only owner of the workspace.",
                hint="Promote someone else to owner first.",
            )

    member.role = Role(payload.role)
    user = await db.get(User, member.user_id)
    assert user is not None
    return MemberResponse(
        id=member.id,
        user_id=user.id,
        email=user.email,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        role=member.role.value,
        joined_at=member.created_at,
    )


@router.delete("/current/members/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(member_id: UUID, ctx: RequireOwner, db: DbSession) -> None:
    member = await db.get(WorkspaceMember, member_id)
    if member is None or member.workspace_id != ctx.workspace_id:
        raise NotFoundError("That member isn't in this workspace.")
    if member.role == Role.OWNER:
        owners = await db.scalar(
            select(func.count())
            .select_from(WorkspaceMember)
            .where(
                WorkspaceMember.workspace_id == ctx.workspace_id,
                WorkspaceMember.role == Role.OWNER,
            )
        )
        if (owners or 0) <= 1:
            raise ValidationError("You can't remove the last owner of a workspace.")
    await db.delete(member)
