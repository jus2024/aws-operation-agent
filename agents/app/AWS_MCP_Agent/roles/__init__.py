"""Role configuration for direct STS AssumeRole switching.

Provides the RoleConfig dataclass and functions to load and look up
Role_Entry records persisted in the RoleConfig DynamoDB table (Role_Config_Table),
replacing the deprecated AGENT_ROLES-environment-variable approach.
"""

from roles.config import RoleConfig, get_role_by_name, get_role_configs

__all__ = ["RoleConfig", "get_role_by_name", "get_role_configs"]
