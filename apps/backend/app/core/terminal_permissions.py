"""Non-secret terminal approval preferences for the managed Pi extension.

This is a client-side approval guard, not an operating-system sandbox.
Command lists contain literal command prefixes, never regular expressions.
"""

import re
from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

CONTROL_WORDS = frozenset(
    {
        "if",
        "then",
        "else",
        "elif",
        "fi",
        "for",
        "while",
        "until",
        "do",
        "done",
        "case",
        "esac",
        "function",
        "select",
        "in",
        "coproc",
    }
)
COMMAND_CHARACTERS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./:=,@%+-")


def _parse_command_prefix(command: str) -> tuple[list[str], str | None]:
    """Return literal words and any unclosed quote, rejecting unsupported characters."""
    # Match parseCommands in the standalone terminal-permissions.ts extension,
    # restricted to one command. Shell tokenizers accept syntax that it cannot verify.
    words: list[str] = []
    word = ""
    word_started = False
    quote: str | None = None
    for character in command:
        if quote is not None:
            if character == quote:
                quote = None
            else:
                if quote == '"' and character in "$`\\":
                    raise ValueError("Terminal command prefixes contain unsupported shell syntax")
                word += character
            continue
        if character in ("'", '"'):
            quote = character
            word_started = True
        elif character == " ":
            if word_started:
                words.append(word)
            word = ""
            word_started = False
        else:
            # This also rejects unquoted pipelines, chains, and expansions.
            if character not in COMMAND_CHARACTERS:
                raise ValueError("Terminal command prefixes contain unsupported shell syntax")
            word_started = True
            word += character
    if word_started:
        words.append(word)
    return words, quote


def _validate_command_prefix(command: str) -> str:
    # JavaScript counts UTF-16 code units for the extension's 96-character limit.
    if sum(2 if ord(character) > 0xFFFF else 1 for character in command) > 96:
        raise ValueError("Terminal command prefixes must be at most 96 characters")
    words, quote = _parse_command_prefix(command)
    if (
        quote is not None
        or not words
        or re.fullmatch(r"[a-zA-Z0-9_./-]+", words[0]) is None
        or words[0] in CONTROL_WORDS
    ):
        raise ValueError("Terminal command prefixes contain unsupported shell syntax")
    return command


CommandPrefix = Annotated[
    str,
    Field(min_length=1, max_length=96, pattern=r"^[^\x00-\x1f\x7f-\x9f]+$"),
    AfterValidator(_validate_command_prefix),
]


class CliTerminalPermissionsConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)

    # Eligibility only: users must explicitly toggle /yolo in each session.
    yolo_mode: bool = Field(alias="yoloMode")
    require_approval_commands: tuple[str, ...] = Field(alias="requireApprovalCommands")
    blocked_commands: tuple[str, ...] = Field(alias="blockedCommands")
    approval_timeout_ms: int = Field(alias="approvalTimeoutMs")


class TerminalPermissionsSettings(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)

    # Grants access to /yolo; never activates autonomous execution by default.
    yolo_mode: bool = Field(default=False, alias="YOLO_MODE")
    require_approval_commands: list[CommandPrefix] = Field(
        default_factory=list, alias="REQUIRE_APPROVAL_COMMANDS", max_length=32
    )
    blocked_commands: list[CommandPrefix] = Field(default_factory=list, alias="BLOCKED_COMMANDS", max_length=32)
    approval_timeout_seconds: int = Field(default=60, alias="APPROVAL_TIMEOUT_SECONDS", ge=1, le=300)

    def cli_config(self) -> CliTerminalPermissionsConfig:
        return CliTerminalPermissionsConfig(
            yolo_mode=self.yolo_mode,
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
    return TerminalPermissionsSettings.model_validate(section)
