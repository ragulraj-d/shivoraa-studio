"""Add is_guest to users.

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-03
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # server_default so the column is populated for rows that already exist —
    # without it, adding a NOT NULL column to a non-empty table fails.
    op.add_column(
        "users",
        sa.Column("is_guest", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("users", "is_guest")
