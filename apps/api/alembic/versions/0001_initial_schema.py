"""Initial schema.

Explicit DDL rather than Base.metadata.create_all().

create_all() in a baseline migration always builds the *current* models, so the
schema it produces silently moves as the code changes. The next migration that
adds a column then conflicts with the baseline that already created it — which
is exactly how "column is_guest already exists" happened. Explicit operations
freeze this revision, so the chain stays a real, replayable history.

Revision ID: 0001
Revises:
Create Date: 2026-08-03
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

import app.core.types
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("email_verified", sa.Boolean(), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=True),
        sa.Column("display_name", sa.String(length=120), nullable=False),
        sa.Column("avatar_url", sa.Text(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_guest", sa.Boolean(), nullable=False),
        sa.Column("oauth_provider", sa.String(length=32), nullable=True),
        sa.Column("oauth_subject", sa.String(length=255), nullable=True),
        sa.Column("ai_trial_used", sa.Integer(), nullable=False),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_users")),
    )
    op.create_index(op.f("ix_users_email"), "users", ["email"], unique=True)
    op.create_index("ix_users_oauth", "users", ["oauth_provider", "oauth_subject"], unique=False)
    op.create_table(
        "workspaces",
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("slug", sa.String(length=140), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("is_personal", sa.Boolean(), nullable=False),
        sa.Column("plan", sa.String(length=32), nullable=False),
        sa.Column("default_provider_id", app.core.types.GUID(), nullable=True),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_workspaces")),
    )
    op.create_index(op.f("ix_workspaces_slug"), "workspaces", ["slug"], unique=True)
    op.create_table(
        "ai_providers",
        sa.Column("workspace_id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "type",
            sa.Enum(
                "OPENAI",
                "ANTHROPIC",
                "GEMINI",
                "GROQ",
                "OLLAMA",
                "OCI",
                "CUSTOM",
                name="provider_type",
            ),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("api_key_encrypted", sa.LargeBinary(), nullable=True),
        sa.Column("base_url", sa.Text(), nullable=True),
        sa.Column("default_model", sa.String(length=120), nullable=False),
        sa.Column("config", app.core.types.JSONType(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("feature_overrides", app.core.types.JSONType(), nullable=False),
        sa.Column("last_health_status", sa.String(length=32), nullable=True),
        sa.Column("last_health_message", sa.Text(), nullable=True),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_ai_providers_workspace_id_workspaces"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ai_providers")),
    )
    op.create_index(
        op.f("ix_ai_providers_workspace_id"), "ai_providers", ["workspace_id"], unique=False
    )
    op.create_table(
        "ai_usage",
        sa.Column("workspace_id", app.core.types.GUID(), nullable=False),
        sa.Column("user_id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "feature",
            sa.Enum(
                "CHAT",
                "GENERATE_REQUEST",
                "GENERATE_DOCS",
                "GENERATE_TESTS",
                "DEBUG",
                "SECURITY",
                name="ai_feature",
            ),
            nullable=False,
        ),
        sa.Column("provider_type", sa.String(length=32), nullable=False),
        sa.Column("model", sa.String(length=120), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False),
        sa.Column("completion_tokens", sa.Integer(), nullable=False),
        sa.Column("cost_usd", sa.Numeric(precision=12, scale=6), nullable=False),
        sa.Column("latency_ms", sa.Float(), nullable=True),
        sa.Column("success", sa.Boolean(), nullable=False),
        sa.Column("is_trial", sa.Boolean(), nullable=False),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_ai_usage_user_id_users"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_ai_usage_workspace_id_workspaces"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ai_usage")),
    )
    op.create_index(op.f("ix_ai_usage_user_id"), "ai_usage", ["user_id"], unique=False)
    op.create_index(op.f("ix_ai_usage_workspace_id"), "ai_usage", ["workspace_id"], unique=False)
    op.create_index("ix_usage_ws_created", "ai_usage", ["workspace_id", "created_at"], unique=False)
    op.create_table(
        "api_keys",
        sa.Column("user_id", app.core.types.GUID(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("key_hash", sa.String(length=64), nullable=False),
        sa.Column("key_prefix", sa.String(length=24), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_api_keys_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_api_keys")),
    )
    op.create_index(op.f("ix_api_keys_key_hash"), "api_keys", ["key_hash"], unique=True)
    op.create_index(op.f("ix_api_keys_user_id"), "api_keys", ["user_id"], unique=False)
    op.create_table(
        "collections",
        sa.Column("workspace_id", app.core.types.GUID(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("base_url", sa.Text(), nullable=True),
        sa.Column("auth", app.core.types.JSONType(), nullable=False),
        sa.Column("default_headers", app.core.types.JSONType(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("docs_markdown", sa.Text(), nullable=True),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_collections_workspace_id_workspaces"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_collections")),
    )
    op.create_index(
        op.f("ix_collections_workspace_id"), "collections", ["workspace_id"], unique=False
    )
    op.create_table(
        "device_authorizations",
        sa.Column("device_code_hash", sa.String(length=64), nullable=False),
        sa.Column("user_code", sa.String(length=16), nullable=False),
        sa.Column("client", sa.String(length=32), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("denied_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("user_id", app.core.types.GUID(), nullable=True),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_device_authorizations_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_device_authorizations")),
    )
    op.create_index(
        op.f("ix_device_authorizations_device_code_hash"),
        "device_authorizations",
        ["device_code_hash"],
        unique=True,
    )
    op.create_index(
        op.f("ix_device_authorizations_user_code"),
        "device_authorizations",
        ["user_code"],
        unique=True,
    )
    op.create_table(
        "environments",
        sa.Column("workspace_id", app.core.types.GUID(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("color", sa.String(length=16), nullable=True),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_environments_workspace_id_workspaces"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_environments")),
        sa.UniqueConstraint("workspace_id", "name", name="uq_env_name"),
    )
    op.create_index(
        op.f("ix_environments_workspace_id"), "environments", ["workspace_id"], unique=False
    )
    op.create_table(
        "invitations",
        sa.Column("workspace_id", app.core.types.GUID(), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("role", sa.Enum("OWNER", "EDITOR", "VIEWER", name="role"), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("invited_by", app.core.types.GUID(), nullable=False),
        sa.Column("accepted", sa.Boolean(), nullable=False),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["invited_by"], ["users.id"], name=op.f("fk_invitations_invited_by_users")
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_invitations_workspace_id_workspaces"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_invitations")),
        sa.UniqueConstraint("workspace_id", "email", name="uq_invite"),
    )
    op.create_index(op.f("ix_invitations_email"), "invitations", ["email"], unique=False)
    op.create_index(op.f("ix_invitations_token_hash"), "invitations", ["token_hash"], unique=True)
    op.create_index(
        op.f("ix_invitations_workspace_id"), "invitations", ["workspace_id"], unique=False
    )
    op.create_table(
        "sessions",
        sa.Column("user_id", app.core.types.GUID(), nullable=False),
        sa.Column("user_agent", sa.String(length=512), nullable=True),
        sa.Column("ip_address", sa.String(length=64), nullable=True),
        sa.Column("client", sa.String(length=32), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_sessions_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sessions")),
    )
    op.create_index(op.f("ix_sessions_user_id"), "sessions", ["user_id"], unique=False)
    op.create_table(
        "workspace_members",
        sa.Column("workspace_id", app.core.types.GUID(), nullable=False),
        sa.Column("user_id", app.core.types.GUID(), nullable=False),
        sa.Column("role", sa.Enum("OWNER", "EDITOR", "VIEWER", name="role"), nullable=False),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_workspace_members_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_workspace_members_workspace_id_workspaces"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_workspace_members")),
        sa.UniqueConstraint("workspace_id", "user_id", name="uq_member"),
    )
    op.create_index(
        op.f("ix_workspace_members_user_id"), "workspace_members", ["user_id"], unique=False
    )
    op.create_index(
        op.f("ix_workspace_members_workspace_id"),
        "workspace_members",
        ["workspace_id"],
        unique=False,
    )
    op.create_table(
        "env_variables",
        sa.Column("environment_id", app.core.types.GUID(), nullable=False),
        sa.Column("key", sa.String(length=200), nullable=False),
        sa.Column("value", sa.Text(), nullable=True),
        sa.Column("value_encrypted", sa.LargeBinary(), nullable=True),
        sa.Column("is_secret", sa.Boolean(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["environment_id"],
            ["environments.id"],
            name=op.f("fk_env_variables_environment_id_environments"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_env_variables")),
        sa.UniqueConstraint("environment_id", "key", name="uq_env_var"),
    )
    op.create_index(
        op.f("ix_env_variables_environment_id"), "env_variables", ["environment_id"], unique=False
    )
    op.create_table(
        "folders",
        sa.Column("collection_id", app.core.types.GUID(), nullable=False),
        sa.Column("parent_id", app.core.types.GUID(), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("auth", app.core.types.JSONType(), nullable=True),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["collection_id"],
            ["collections.id"],
            name=op.f("fk_folders_collection_id_collections"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"],
            ["folders.id"],
            name=op.f("fk_folders_parent_id_folders"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_folders")),
    )
    op.create_index(op.f("ix_folders_collection_id"), "folders", ["collection_id"], unique=False)
    op.create_index(op.f("ix_folders_parent_id"), "folders", ["parent_id"], unique=False)
    op.create_table(
        "refresh_tokens",
        sa.Column("session_id", app.core.types.GUID(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["sessions.id"],
            name=op.f("fk_refresh_tokens_session_id_sessions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_refresh_tokens")),
    )
    op.create_index(
        op.f("ix_refresh_tokens_session_id"), "refresh_tokens", ["session_id"], unique=False
    )
    op.create_index(
        op.f("ix_refresh_tokens_token_hash"), "refresh_tokens", ["token_hash"], unique=True
    )
    op.create_table(
        "api_requests",
        sa.Column("collection_id", app.core.types.GUID(), nullable=False),
        sa.Column("folder_id", app.core.types.GUID(), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("method", sa.String(length=16), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("headers", app.core.types.JSONType(), nullable=False),
        sa.Column("query_params", app.core.types.JSONType(), nullable=False),
        sa.Column("path_params", app.core.types.JSONType(), nullable=False),
        sa.Column("body", app.core.types.JSONType(), nullable=False),
        sa.Column("auth", app.core.types.JSONType(), nullable=True),
        sa.Column("settings", app.core.types.JSONType(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("docs_markdown", sa.Text(), nullable=True),
        sa.Column("tests_code", sa.Text(), nullable=True),
        sa.Column("tests_framework", sa.String(length=32), nullable=True),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["collection_id"],
            ["collections.id"],
            name=op.f("fk_api_requests_collection_id_collections"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["folder_id"],
            ["folders.id"],
            name=op.f("fk_api_requests_folder_id_folders"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_api_requests")),
    )
    op.create_index(
        op.f("ix_api_requests_collection_id"), "api_requests", ["collection_id"], unique=False
    )
    op.create_index(op.f("ix_api_requests_folder_id"), "api_requests", ["folder_id"], unique=False)
    op.create_index(
        "ix_requests_collection_folder",
        "api_requests",
        ["collection_id", "folder_id"],
        unique=False,
    )
    op.create_table(
        "ai_conversations",
        sa.Column("workspace_id", app.core.types.GUID(), nullable=False),
        sa.Column("user_id", app.core.types.GUID(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column(
            "feature",
            sa.Enum(
                "CHAT",
                "GENERATE_REQUEST",
                "GENERATE_DOCS",
                "GENERATE_TESTS",
                "DEBUG",
                "SECURITY",
                name="ai_feature",
            ),
            nullable=False,
        ),
        sa.Column("request_id", app.core.types.GUID(), nullable=True),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["request_id"],
            ["api_requests.id"],
            name=op.f("fk_ai_conversations_request_id_api_requests"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_ai_conversations_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_ai_conversations_workspace_id_workspaces"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ai_conversations")),
    )
    op.create_index(
        op.f("ix_ai_conversations_user_id"), "ai_conversations", ["user_id"], unique=False
    )
    op.create_index(
        op.f("ix_ai_conversations_workspace_id"), "ai_conversations", ["workspace_id"], unique=False
    )
    op.create_table(
        "executions",
        sa.Column("workspace_id", app.core.types.GUID(), nullable=False),
        sa.Column("user_id", app.core.types.GUID(), nullable=False),
        sa.Column("request_id", app.core.types.GUID(), nullable=True),
        sa.Column("environment_id", app.core.types.GUID(), nullable=True),
        sa.Column("mode", sa.Enum("SERVER", "LOCAL", name="execution_mode"), nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "PENDING", "SUCCESS", "FAILED", "CANCELLED", "BLOCKED", name="execution_status"
            ),
            nullable=False,
        ),
        sa.Column("method", sa.String(length=16), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("request_headers", app.core.types.JSONType(), nullable=False),
        sa.Column("request_body", sa.Text(), nullable=True),
        sa.Column("status_code", sa.Integer(), nullable=True),
        sa.Column("response_headers", app.core.types.JSONType(), nullable=False),
        sa.Column("response_body", sa.Text(), nullable=True),
        sa.Column("response_size", sa.BigInteger(), nullable=True),
        sa.Column("content_type", sa.String(length=160), nullable=True),
        sa.Column("duration_ms", sa.Float(), nullable=True),
        sa.Column("dns_ms", sa.Float(), nullable=True),
        sa.Column("connect_ms", sa.Float(), nullable=True),
        sa.Column("tls_ms", sa.Float(), nullable=True),
        sa.Column("ttfb_ms", sa.Float(), nullable=True),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["environment_id"],
            ["environments.id"],
            name=op.f("fk_executions_environment_id_environments"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["request_id"],
            ["api_requests.id"],
            name=op.f("fk_executions_request_id_api_requests"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_executions_user_id_users"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_executions_workspace_id_workspaces"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_executions")),
    )
    op.create_index(
        "ix_exec_request_created", "executions", ["request_id", "created_at"], unique=False
    )
    op.create_index(
        "ix_exec_ws_created", "executions", ["workspace_id", "created_at"], unique=False
    )
    op.create_index(
        "ix_exec_ws_status", "executions", ["workspace_id", "status_code"], unique=False
    )
    op.create_index(op.f("ix_executions_user_id"), "executions", ["user_id"], unique=False)
    op.create_index(
        op.f("ix_executions_workspace_id"), "executions", ["workspace_id"], unique=False
    )
    op.create_table(
        "request_examples",
        sa.Column("request_id", app.core.types.GUID(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("status_code", sa.Integer(), nullable=False),
        sa.Column("response_headers", app.core.types.JSONType(), nullable=False),
        sa.Column("response_body", sa.Text(), nullable=True),
        sa.Column("content_type", sa.String(length=160), nullable=True),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["request_id"],
            ["api_requests.id"],
            name=op.f("fk_request_examples_request_id_api_requests"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_request_examples")),
    )
    op.create_index(
        op.f("ix_request_examples_request_id"), "request_examples", ["request_id"], unique=False
    )
    op.create_table(
        "ai_messages",
        sa.Column("conversation_id", app.core.types.GUID(), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("context_manifest", app.core.types.JSONType(), nullable=False),
        sa.Column("suggested_actions", app.core.types.JSONType(), nullable=False),
        sa.Column("provider_type", sa.String(length=32), nullable=True),
        sa.Column("model", sa.String(length=120), nullable=True),
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
        sa.Column("completion_tokens", sa.Integer(), nullable=True),
        sa.Column("cost_usd", sa.Numeric(precision=12, scale=6), nullable=True),
        sa.Column("latency_ms", sa.Float(), nullable=True),
        sa.Column("feedback", sa.Integer(), nullable=True),
        sa.Column("id", app.core.types.GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            ["ai_conversations.id"],
            name=op.f("fk_ai_messages_conversation_id_ai_conversations"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ai_messages")),
    )
    op.create_index(
        op.f("ix_ai_messages_conversation_id"), "ai_messages", ["conversation_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_ai_messages_conversation_id"), table_name="ai_messages")
    op.drop_table("ai_messages")
    op.drop_index(op.f("ix_request_examples_request_id"), table_name="request_examples")
    op.drop_table("request_examples")
    op.drop_index(op.f("ix_executions_workspace_id"), table_name="executions")
    op.drop_index(op.f("ix_executions_user_id"), table_name="executions")
    op.drop_index("ix_exec_ws_status", table_name="executions")
    op.drop_index("ix_exec_ws_created", table_name="executions")
    op.drop_index("ix_exec_request_created", table_name="executions")
    op.drop_table("executions")
    op.drop_index(op.f("ix_ai_conversations_workspace_id"), table_name="ai_conversations")
    op.drop_index(op.f("ix_ai_conversations_user_id"), table_name="ai_conversations")
    op.drop_table("ai_conversations")
    op.drop_index("ix_requests_collection_folder", table_name="api_requests")
    op.drop_index(op.f("ix_api_requests_folder_id"), table_name="api_requests")
    op.drop_index(op.f("ix_api_requests_collection_id"), table_name="api_requests")
    op.drop_table("api_requests")
    op.drop_index(op.f("ix_refresh_tokens_token_hash"), table_name="refresh_tokens")
    op.drop_index(op.f("ix_refresh_tokens_session_id"), table_name="refresh_tokens")
    op.drop_table("refresh_tokens")
    op.drop_index(op.f("ix_folders_parent_id"), table_name="folders")
    op.drop_index(op.f("ix_folders_collection_id"), table_name="folders")
    op.drop_table("folders")
    op.drop_index(op.f("ix_env_variables_environment_id"), table_name="env_variables")
    op.drop_table("env_variables")
    op.drop_index(op.f("ix_workspace_members_workspace_id"), table_name="workspace_members")
    op.drop_index(op.f("ix_workspace_members_user_id"), table_name="workspace_members")
    op.drop_table("workspace_members")
    op.drop_index(op.f("ix_sessions_user_id"), table_name="sessions")
    op.drop_table("sessions")
    op.drop_index(op.f("ix_invitations_workspace_id"), table_name="invitations")
    op.drop_index(op.f("ix_invitations_token_hash"), table_name="invitations")
    op.drop_index(op.f("ix_invitations_email"), table_name="invitations")
    op.drop_table("invitations")
    op.drop_index(op.f("ix_environments_workspace_id"), table_name="environments")
    op.drop_table("environments")
    op.drop_index(op.f("ix_device_authorizations_user_code"), table_name="device_authorizations")
    op.drop_index(
        op.f("ix_device_authorizations_device_code_hash"), table_name="device_authorizations"
    )
    op.drop_table("device_authorizations")
    op.drop_index(op.f("ix_collections_workspace_id"), table_name="collections")
    op.drop_table("collections")
    op.drop_index(op.f("ix_api_keys_user_id"), table_name="api_keys")
    op.drop_index(op.f("ix_api_keys_key_hash"), table_name="api_keys")
    op.drop_table("api_keys")
    op.drop_index("ix_usage_ws_created", table_name="ai_usage")
    op.drop_index(op.f("ix_ai_usage_workspace_id"), table_name="ai_usage")
    op.drop_index(op.f("ix_ai_usage_user_id"), table_name="ai_usage")
    op.drop_table("ai_usage")
    op.drop_index(op.f("ix_ai_providers_workspace_id"), table_name="ai_providers")
    op.drop_table("ai_providers")
    op.drop_index(op.f("ix_workspaces_slug"), table_name="workspaces")
    op.drop_table("workspaces")
    op.drop_index("ix_users_oauth", table_name="users")
    op.drop_index(op.f("ix_users_email"), table_name="users")
    op.drop_table("users")
