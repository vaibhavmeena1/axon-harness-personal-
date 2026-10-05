"""Opt-in private session storage, separate from CLI release distribution."""

import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit


@dataclass(frozen=True, slots=True)
class SessionStorageSettings:
    bucket: str
    region: str
    key_prefix: str = "deputydev/sessions/"
    endpoint_url: str | None = None
    access_key_id: str | None = field(default=None, repr=False)
    secret_access_key: str | None = field(default=None, repr=False)
    session_token: str | None = field(default=None, repr=False)
    url_seconds: int = 300
    reservation_seconds: int = 900
    cleanup_grace_seconds: int = 3600
    require_create_only_policy: bool = True


def _credentials(credentials: dict) -> tuple[str | None, str | None, str | None, str | None]:
    if not isinstance(credentials, dict):
        raise ValueError("Invalid session credentials")
    endpoint = credentials.get("ENDPOINT_URL")
    if endpoint is not None:
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
        ):
            raise ValueError("Session storage endpoint must be an HTTPS origin")
    key, secret = credentials.get("ACCESS_KEY_ID"), credentials.get("SECRET_ACCESS_KEY")
    token = credentials.get("SESSION_TOKEN")
    if bool(key) != bool(secret) or any(
        value is not None and (not isinstance(value, str) or not value) for value in (key, secret, token)
    ):
        raise ValueError("Invalid session credentials")
    return endpoint, key, secret, token


def parse_session_storage(raw: dict) -> SessionStorageSettings | None:
    config = raw.get("SESSION_BACKUPS")
    if config is None or config.get("ENABLED") is False:
        return None
    if not isinstance(config, dict) or config.get("ENABLED") is not True:
        raise ValueError("Invalid session storage configuration")
    bucket, region = config.get("AWS_BUCKET_NAME"), config.get("AWS_REGION")
    prefix = config.get("KEY_PREFIX", "deputydev/sessions/")
    if not isinstance(bucket, str) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
        raise ValueError("Invalid session bucket")
    if not isinstance(region, str) or not re.fullmatch(r"[a-z0-9-]{3,40}", region):
        raise ValueError("Invalid session region")
    if (
        not isinstance(prefix, str)
        or not re.fullmatch(r"[a-zA-Z0-9_/-]{1,128}/", prefix)
        or ".." in prefix
        or prefix.startswith("/")
    ):
        raise ValueError("Invalid session object prefix")
    require_create_only_policy = config.get("REQUIRE_CREATE_ONLY_POLICY", True)
    if type(require_create_only_policy) is not bool:
        raise ValueError("REQUIRE_CREATE_ONLY_POLICY must be a boolean")
    endpoint, key, secret, token = _credentials(config.get("CREDENTIALS", {}))
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
        bucket,
        region,
        prefix,
        endpoint,
        key,
        secret,
        token,
        *timings,
        require_create_only_policy=require_create_only_policy,
    )
