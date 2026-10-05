"""Harness-neutral, bounded wire declarations. No transcript or credential fields."""

import re
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_DISPLAY_NAME_LENGTH = 256


def normalize_display_name(name: str) -> str | None:
    """Single-line, bounded display metadata; native archive bytes remain untouched."""
    single_line = re.sub(r"[\x00-\x1f\x7f-\x9f\ud800-\udfff\u2028\u2029]", " ", name)
    # Match JavaScript trim/trimEnd, including BOM whitespace.
    single_line = re.sub(r"^[\s\ufeff]+|[\s\ufeff]+$", "", single_line)
    return re.sub(r"[\s\ufeff]+$", "", single_line[:MAX_DISPLAY_NAME_LENGTH]) or None


MAX_RAW_BYTES = 100 * 1024 * 1024
MAX_STORED_BYTES = 101 * 1024 * 1024
Hash = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Text = Annotated[str, Field(min_length=1, max_length=128)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Registration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_session_key: UUID
    device_id: UUID
    harness: Text
    harness_session_id: Annotated[str, Field(min_length=1, max_length=256)] | None = None
    session_format: Text


class Snapshot(StrictModel):
    display_name: Annotated[str, Field(min_length=1, max_length=MAX_DISPLAY_NAME_LENGTH)] | None
    raw_sha256: Hash
    stored_sha256: Hash
    raw_size_bytes: Annotated[int, Field(gt=0, le=MAX_RAW_BYTES)]
    stored_size_bytes: Annotated[int, Field(gt=0, le=MAX_STORED_BYTES)]
    encoding: Literal["identity", "gzip"]
    session_format_version: Text
    resume_metadata: dict[str, object]

    @model_validator(mode="after")
    def bounded_metadata(self) -> "Snapshot":
        import json

        if self.display_name is not None and normalize_display_name(self.display_name) != self.display_name:
            raise ValueError("Display name must be normalized")
        if len(json.dumps(self.resume_metadata).encode()) > 4096:
            raise ValueError("Resume metadata exceeds limit")
        if self.encoding == "identity" and (
            self.raw_sha256 != self.stored_sha256 or self.raw_size_bytes != self.stored_size_bytes
        ):
            raise ValueError("Identity encoding requires matching integrity declarations")
        return self


class UploadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    expected_token: UUID
    snapshot: Snapshot
    capture_reason: Literal["session_start", "session_shutdown", "manual"]


class FinalizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
