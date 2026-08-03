"""Environment and variable endpoints."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.core.deps import Auth, DbSession, RequireEditor
from app.core.errors import NotFoundError
from app.core.security import crypto
from app.models.workspace import Environment, EnvVariable
from app.modules.environment.schemas import (
    EnvironmentCreate,
    EnvironmentResponse,
    EnvironmentUpdate,
    VariableIn,
    VariableResponse,
)

router = APIRouter(prefix="/environments", tags=["environments"])

SECRET_MASK = "••••••••"


def _serialize(env: Environment) -> EnvironmentResponse:
    return EnvironmentResponse(
        id=env.id,
        name=env.name,
        color=env.color,
        is_default=env.is_default,
        version=env.version,
        created_at=env.created_at,
        variables=[
            VariableResponse(
                id=v.id,
                key=v.key,
                # Secret values never leave the server through this endpoint.
                # They are decrypted only when building an execution plan.
                value=SECRET_MASK if v.is_secret else (v.value or ""),
                is_secret=v.is_secret,
                enabled=v.enabled,
                description=v.description,
            )
            for v in sorted(env.variables, key=lambda x: x.key)
        ],
    )


async def _load(db: DbSession, workspace_id: UUID, env_id: UUID) -> Environment:
    env = await db.scalar(
        select(Environment)
        .where(Environment.id == env_id, Environment.workspace_id == workspace_id)
        .options(selectinload(Environment.variables))
    )
    if env is None:
        raise NotFoundError("That environment doesn't exist, or you don't have access to it.")
    return env


def _apply_variables(env: Environment, variables: list[VariableIn]) -> None:
    existing = {v.key: v for v in env.variables}
    incoming = {v.key for v in variables}

    for var in variables:
        row = existing.get(var.key)
        if row is None:
            row = EnvVariable(environment_id=env.id, key=var.key)
            env.variables.append(row)

        row.is_secret = var.is_secret
        row.enabled = var.enabled
        row.description = var.description

        if var.is_secret:
            # The mask means "unchanged" — the client never received the real
            # value, so echoing the mask back must not overwrite the secret.
            if var.value and var.value != SECRET_MASK:
                row.value_encrypted = crypto.encrypt(var.value)
            row.value = None
        else:
            row.value = var.value
            row.value_encrypted = None

    for key, row in existing.items():
        if key not in incoming:
            env.variables.remove(row)


@router.get("", response_model=list[EnvironmentResponse])
async def list_environments(ctx: Auth, db: DbSession) -> list[EnvironmentResponse]:
    rows = await db.execute(
        select(Environment)
        .where(Environment.workspace_id == ctx.workspace_id)
        .options(selectinload(Environment.variables))
        .order_by(Environment.created_at)
    )
    return [_serialize(e) for e in rows.scalars().unique()]


@router.post("", response_model=EnvironmentResponse, status_code=201)
async def create_environment(
    payload: EnvironmentCreate, ctx: RequireEditor, db: DbSession
) -> EnvironmentResponse:
    env = Environment(workspace_id=ctx.workspace_id, name=payload.name, color=payload.color)
    db.add(env)
    await db.flush()
    _apply_variables(env, payload.variables)
    await db.flush()
    await db.refresh(env, ["variables"])
    return _serialize(env)


@router.get("/{env_id}", response_model=EnvironmentResponse)
async def get_environment(env_id: UUID, ctx: Auth, db: DbSession) -> EnvironmentResponse:
    return _serialize(await _load(db, ctx.workspace_id, env_id))


@router.patch("/{env_id}", response_model=EnvironmentResponse)
async def update_environment(
    env_id: UUID, payload: EnvironmentUpdate, ctx: RequireEditor, db: DbSession
) -> EnvironmentResponse:
    env = await _load(db, ctx.workspace_id, env_id)

    if payload.name is not None:
        env.name = payload.name
    if payload.color is not None:
        env.color = payload.color
    if payload.is_default is not None and payload.is_default:
        others = await db.execute(
            select(Environment).where(
                Environment.workspace_id == ctx.workspace_id, Environment.id != env_id
            )
        )
        for other in others.scalars():
            other.is_default = False
        env.is_default = True
    if payload.variables is not None:
        _apply_variables(env, payload.variables)

    env.version += 1
    await db.flush()
    await db.refresh(env, ["variables"])
    return _serialize(env)


@router.delete("/{env_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_environment(env_id: UUID, ctx: RequireEditor, db: DbSession) -> None:
    env = await _load(db, ctx.workspace_id, env_id)
    await db.delete(env)
