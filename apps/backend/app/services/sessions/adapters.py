"""Registered validators; JSONL alone is not a session format contract."""

import json
from collections.abc import Callable, Iterator
from typing import BinaryIO

from app.services.sessions.contracts import MAX_RAW_BYTES, normalize_display_name


class InvalidSessionError(ValueError):
    """Safe diagnostic: never include offending transcript bytes."""


def pi_resume(metadata: dict[str, object]) -> dict[str, object]:
    if set(metadata) != {"leaf_known", "selected_leaf_id"} or type(metadata["leaf_known"]) is not bool:
        raise InvalidSessionError("Invalid Pi resume metadata")
    leaf = metadata["selected_leaf_id"]
    if leaf is not None and (not isinstance(leaf, str) or not 1 <= len(leaf) <= 256):
        raise InvalidSessionError("Invalid Pi selected leaf")
    if not metadata["leaf_known"] and leaf is not None:
        raise InvalidSessionError("Unknown Pi leaf must be null")
    return metadata


def records(source: BinaryIO) -> Iterator[dict]:
    """One bounded line at a time, strict UTF-8, no discarded malformed/tail records."""
    source.seek(0)
    while line := source.readline(MAX_RAW_BYTES + 1):
        if len(line) > MAX_RAW_BYTES or not line.endswith(b"\n"):
            raise InvalidSessionError("Incomplete or oversized JSONL record")
        try:
            record = json.loads(line, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeError, RecursionError):
            raise InvalidSessionError("Invalid JSONL record") from None
        if not isinstance(record, dict):
            raise InvalidSessionError("JSONL records must be objects")
        yield record


def validate_entry_payload(entry: dict) -> None:
    required_text = {
        "custom": ("customType",),
        "custom_message": ("customType",),
        "model_change": ("provider", "modelId"),
        "thinking_level_change": ("thinkingLevel",),
        "branch_summary": ("fromId", "summary"),
        "session_info": ("name",),
        "usage": ("kind", "provider", "model"),
        "context_edit": ("targetId",),
        "label": ("targetId",),
    }
    if any(not isinstance(entry.get(field), str) for field in required_text.get(entry["type"], ())):
        raise InvalidSessionError("Invalid Pi entry payload")
    if entry["type"] != "message":
        return
    message = entry.get("message")
    if not isinstance(message, dict) or not isinstance(message.get("role"), str):
        raise InvalidSessionError("Invalid Pi message")
    role, content = message["role"], message.get("content")
    if role in {"user", "system", "custom"} and not isinstance(content, (str, list)):
        raise InvalidSessionError("Invalid Pi message content")
    if role in {"assistant", "toolResult"} and not isinstance(content, list):
        raise InvalidSessionError("Invalid Pi message content")


def validate_pi(source: BinaryIO, native_id: str | None, metadata: dict[str, object]) -> str | None:
    pi_resume(metadata)
    items = records(source)
    header = next(items, None)
    if (
        header is None
        or header.get("type") != "session"
        or type(header.get("version")) is not int
        or header["version"] != 3
        or not isinstance(header.get("id"), str)
        or not 1 <= len(header["id"]) <= 256
        or not isinstance(header.get("cwd"), str)
        or not isinstance(header.get("timestamp"), str)
        or (native_id is not None and header["id"] != native_id)
    ):
        raise InvalidSessionError("Invalid Pi header or native identity")
    display_name = None
    ids: set[str] = set()
    references: list[str] = []
    types = {
        "message",
        "model_change",
        "thinking_level_change",
        "compaction",
        "branch_summary",
        "custom",
        "custom_message",
        "label",
        "session_info",
        "context_edit",
        "usage",
    }
    for entry in items:
        entry_id, parent = entry.get("id"), entry.get("parentId")
        if (
            entry.get("type") not in types
            or not isinstance(entry_id, str)
            or not 1 <= len(entry_id) <= 256
            or entry_id in ids
            or "parentId" not in entry
            or (parent is not None and (not isinstance(parent, str) or parent not in ids))
            or not isinstance(entry.get("timestamp"), str)
        ):
            raise InvalidSessionError("Invalid Pi entry tree")
        validate_entry_payload(entry)
        if entry["type"] == "session_info":
            display_name = normalize_display_name(entry["name"])
        if entry["type"] == "compaction":
            if not isinstance(entry.get("summary"), str) or not isinstance(entry.get("firstKeptEntryId"), str):
                raise InvalidSessionError("Invalid Pi compaction")
            references.append(entry["firstKeptEntryId"])
        ids.add(entry_id)
    if not ids or any(ref not in ids for ref in references):
        raise InvalidSessionError("Empty Pi session or invalid compaction reference")
    if metadata["leaf_known"] and metadata["selected_leaf_id"] is not None and metadata["selected_leaf_id"] not in ids:
        raise InvalidSessionError("Selected leaf is absent from Pi snapshot")
    return display_name


class Adapter:
    """Validate native bytes/resume state and return their normalized display name."""

    def __init__(
        self,
        validate: Callable[[BinaryIO, str | None, dict[str, object]], str | None],
        resume: Callable[[dict[str, object]], dict[str, object]],
    ) -> None:
        self.validate = validate
        self.resume = resume


ADAPTERS = {("pi", "pi-jsonl", "3"): Adapter(validate_pi, pi_resume)}


def get_adapter(harness: str, session_format: str, version: str) -> Adapter:
    adapter = ADAPTERS.get((harness, session_format, version))
    if adapter is None:
        raise InvalidSessionError("Unsupported harness, session format or version")
    return adapter
