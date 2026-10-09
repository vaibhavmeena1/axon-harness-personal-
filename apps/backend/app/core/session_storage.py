"""Administrator-controlled private session storage, separate from CLI releases."""

import re
from dataclasses import dataclass

from app.core.s3 import S3StorageSettings, parse_s3_storage


@dataclass(frozen=True, slots=True)
class SessionStorageSettings:
    s3: S3StorageSettings
    key_prefix: str = "axon/sessions/"
    url_seconds: int = 300
    reservation_seconds: int = 900
    cleanup_grace_seconds: int = 3600
    require_create_only_policy: bool = True


def parse_session_storage(raw: dict) -> SessionStorageSettings | None:
    config = raw.get("SESSION_BACKUPS")
    if config is None:
        return None
    if not isinstance(config, dict):
        raise ValueError("config.SESSION_BACKUPS must be an object")
    enabled = config.get("ENABLED", False)
    if type(enabled) is not bool:
        raise ValueError("config.SESSION_BACKUPS.ENABLED must be a boolean")
    if not enabled:
        return None
    s3 = parse_s3_storage(
        config.get("S3"), "config.SESSION_BACKUPS.S3", connect_timeout=5, read_timeout=10, max_retries=1
    )
    prefix = config.get("KEY_PREFIX", "axon/sessions/")
    if (
        not isinstance(prefix, str)
        or not re.fullmatch(r"[a-zA-Z0-9_/-]{1,128}/", prefix)
        or ".." in prefix
        or prefix.startswith("/")
        or any(segment in {"", ".", ".."} for segment in prefix[:-1].split("/"))
    ):
        raise ValueError("Invalid session object prefix")
    require_create_only_policy = config.get("REQUIRE_CREATE_ONLY_POLICY", True)
    if type(require_create_only_policy) is not bool:
        raise ValueError("REQUIRE_CREATE_ONLY_POLICY must be a boolean")
    timings = [
        config.get("URL_SECONDS", 300),
        config.get("RESERVATION_SECONDS", 900),
        config.get("CLEANUP_GRACE_SECONDS", 3600),
    ]
    if (
        any(type(n) is not int for n in timings)
        or not 30 <= timings[0] <= 300
        or not timings[0] <= timings[1] <= 900
        or timings[2] < timings[1] + 600
    ):
        raise ValueError("Invalid session storage safety windows")
    return SessionStorageSettings(
        s3=s3,
        key_prefix=prefix,
        url_seconds=timings[0],
        reservation_seconds=timings[1],
        cleanup_grace_seconds=timings[2],
        require_create_only_policy=require_create_only_policy,
    )
