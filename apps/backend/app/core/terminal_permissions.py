"""Non-secret terminal approval preferences for the managed Pi extension.

This is a client-side approval guard, not an operating-system sandbox.
Command lists contain literal command prefixes, never regular expressions.
"""

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

CommandPrefix = Annotated[str, Field(min_length=1, max_length=96, pattern=r"^[^\x00-\x1f\x7f-\x9f]+$")]


class CliTerminalPermissionsConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)

    yolo_mode: bool = Field(alias="yoloMode")
    allow_yolo_mode: bool = Field(alias="allowYoloMode")
    auto_approve_commands: tuple[str, ...] = Field(alias="autoApproveCommands")
    require_approval_commands: tuple[str, ...] = Field(alias="requireApprovalCommands")
    blocked_commands: tuple[str, ...] = Field(alias="blockedCommands")
    approval_timeout_ms: int = Field(alias="approvalTimeoutMs")


class TerminalPermissionsSettings(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)

    yolo_mode: bool = Field(default=False, alias="YOLO_MODE")
    allow_yolo_mode: bool = Field(default=True, alias="ALLOW_YOLO_MODE")
    auto_approve_commands: list[CommandPrefix] = Field(
        default_factory=list, alias="AUTO_APPROVE_COMMANDS", max_length=32
    )
    require_approval_commands: list[CommandPrefix] = Field(
        default_factory=list, alias="REQUIRE_APPROVAL_COMMANDS", max_length=32
    )
    blocked_commands: list[CommandPrefix] = Field(default_factory=list, alias="BLOCKED_COMMANDS", max_length=32)
    approval_timeout_seconds: int = Field(default=60, alias="APPROVAL_TIMEOUT_SECONDS", ge=1, le=300)

    def cli_config(self) -> CliTerminalPermissionsConfig:
        return CliTerminalPermissionsConfig(
            yolo_mode=self.yolo_mode and self.allow_yolo_mode,
            allow_yolo_mode=self.allow_yolo_mode,
            auto_approve_commands=tuple(self.auto_approve_commands),
            require_approval_commands=tuple(self.require_approval_commands),
            blocked_commands=tuple(self.blocked_commands),
            approval_timeout_ms=self.approval_timeout_seconds * 1000,
        )


def parse_terminal_permissions(raw: dict[str, object]) -> TerminalPermissionsSettings | None:
    # Absence preserves local client preferences; a configured section takes precedence.
    section = raw.get("TERMINAL_PERMISSIONS")
    if section is None:
        return None
    if not isinstance(section, dict):
        raise ValueError("TERMINAL_PERMISSIONS must be an object")
    settings = TerminalPermissionsSettings.model_validate(section)
    for commands in (settings.auto_approve_commands, settings.require_approval_commands, settings.blocked_commands):
        if any(not command.strip() for command in commands):
            raise ValueError("Terminal command prefixes must not be blank")
    return settings
