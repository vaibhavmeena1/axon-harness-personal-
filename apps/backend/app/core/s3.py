"""Shared, validated S3 configuration; no AWS SDK construction or domain policy."""

import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit


@dataclass(frozen=True, slots=True)
class S3ClientSettings:
    region: str
    endpoint_url: str | None = None
    access_key_id: str | None = field(default=None, repr=False)
    secret_access_key: str | None = field(default=None, repr=False)
    session_token: str | None = field(default=None, repr=False)
    connect_timeout: int = 60
    read_timeout: int = 60
    max_retries: int | None = None  # Botocore Config's max_attempts counts retries, not the initial request.


@dataclass(frozen=True, slots=True)
class S3StorageSettings:
    bucket: str
    client: S3ClientSettings


def _endpoint(value: Any, path: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value or any(ord(char) < 33 for char in value) or "\\" in value:
        raise ValueError(f"{path}.ENDPOINT_URL must be an HTTPS origin")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise ValueError(f"{path}.ENDPOINT_URL must be an HTTPS origin") from None
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or "?" in value
        or "#" in value
        or parsed.path not in {"", "/"}
        or port == 0
    ):
        raise ValueError(f"{path}.ENDPOINT_URL must be an HTTPS origin")
    return value.rstrip("/")


def _credentials(value: Any, path: str) -> tuple[str | None, str | None, str | None]:
    if not isinstance(value, dict) or value.keys() - {"ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "SESSION_TOKEN"}:
        raise ValueError(f"{path}.CREDENTIALS must contain only supported credential fields")
    key, secret, token = value.get("ACCESS_KEY_ID"), value.get("SECRET_ACCESS_KEY"), value.get("SESSION_TOKEN")
    if (
        bool(key) != bool(secret)
        or (token is not None and not key)
        or any(item is not None and (not isinstance(item, str) or not item.strip()) for item in (key, secret, token))
    ):
        raise ValueError(f"{path}.CREDENTIALS requires paired access/secret keys and an optional session token")
    return key, secret, token


def _timeout(value: Any, path: str) -> int:
    if type(value) is not int or not 1 <= value <= 300:
        raise ValueError(f"{path} must be an integer between 1 and 300")
    return value


def parse_s3_storage(
    raw: Any,
    path: str,
    *,
    connect_timeout: int = 60,
    read_timeout: int = 60,
    max_retries: int | None = None,
) -> S3StorageSettings:
    """Parse one feature's S3 block; empty credentials use the AWS default chain.

    MAX_RETRIES=null preserves SDK/environment retry defaults. Explicit retry
    values describe additional attempts (the same meaning as Config.max_attempts).
    Error messages report field paths, never credential values or endpoint inputs.
    """
    allowed = {
        "BUCKET",
        "REGION",
        "ENDPOINT_URL",
        "CREDENTIALS",
        "CONNECT_TIMEOUT_SECONDS",
        "READ_TIMEOUT_SECONDS",
        "MAX_RETRIES",
    }
    if not isinstance(raw, dict) or raw.keys() - allowed:
        raise ValueError(f"{path} must be an object containing only supported S3 fields")
    bucket, region = raw.get("BUCKET"), raw.get("REGION")
    if not isinstance(bucket, str) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
        raise ValueError(f"{path}.BUCKET must be a valid S3 bucket name")
    if not isinstance(region, str) or not re.fullmatch(r"[a-z0-9-]{3,40}", region):
        raise ValueError(f"{path}.REGION must be an AWS region")
    endpoint = _endpoint(raw.get("ENDPOINT_URL"), path)
    key, secret, token = _credentials(raw.get("CREDENTIALS", {}), path)
    connect = _timeout(raw.get("CONNECT_TIMEOUT_SECONDS", connect_timeout), f"{path}.CONNECT_TIMEOUT_SECONDS")
    read = _timeout(raw.get("READ_TIMEOUT_SECONDS", read_timeout), f"{path}.READ_TIMEOUT_SECONDS")
    retries = raw.get("MAX_RETRIES", max_retries)
    if retries is not None and (type(retries) is not int or not 0 <= retries <= 10):
        raise ValueError(f"{path}.MAX_RETRIES must be null or an integer between 0 and 10")
    return S3StorageSettings(
        bucket=bucket,
        client=S3ClientSettings(
            region=region,
            endpoint_url=endpoint,
            access_key_id=key,
            secret_access_key=secret,
            session_token=token,
            connect_timeout=connect,
            read_timeout=read,
            max_retries=retries,
        ),
    )
