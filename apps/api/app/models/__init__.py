"""Model registry. Importing this module registers every table on Base.metadata,
which is what Alembic autogenerate reflects against."""

from app.core.db import Base
from app.models.ai import (
    AIConversation,
    AIFeature,
    AIMessage,
    AIProvider,
    AIUsage,
    ProviderType,
)
from app.models.collection import ApiRequest, Collection, Folder, RequestExample
from app.models.execution import Execution, ExecutionMode, ExecutionStatus
from app.models.user import (
    ApiKey,
    DeviceAuthorization,
    RefreshToken,
    Session,
    User,
)
from app.models.workspace import (
    Environment,
    EnvVariable,
    Invitation,
    Role,
    Workspace,
    WorkspaceMember,
)

__all__ = [
    "AIConversation",
    "AIFeature",
    "AIMessage",
    "AIProvider",
    "AIUsage",
    "ApiKey",
    "ApiRequest",
    "Base",
    "Collection",
    "DeviceAuthorization",
    "EnvVariable",
    "Environment",
    "Execution",
    "ExecutionMode",
    "ExecutionStatus",
    "Folder",
    "Invitation",
    "ProviderType",
    "RefreshToken",
    "RequestExample",
    "Role",
    "Session",
    "User",
    "Workspace",
    "WorkspaceMember",
]
