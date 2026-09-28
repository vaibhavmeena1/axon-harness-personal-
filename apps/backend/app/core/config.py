"""Validated application settings backed by the backend's config.json."""

import json
import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

DATABASE_CONFIG_NAME = "DEFAULT_DATABASE"
DATABASE_TABLE_PREFIX = "META_HARNESS_"

# The backend package root, used to resolve relative paths from config.json.
BASE_DIR = Path(__file__).resolve().parents[2]
DEFAULT_FRONTEND_DIR = "static"


class ConfigurationError(ValueError):
    """Raised when required application configuration is missing or invalid."""


@dataclass(frozen=True, slots=True)
class DatabaseSettings:
    """PostgreSQL connection and pool settings."""

    name: str
    host: str
    port: int
    user: str
    password: str
    pool_min_size: int
    pool_max_size: int

    def tortoise_config(self) -> dict[str, Any]:
        """Build Tortoise's asyncpg configuration without serializing credentials."""
        return {
            "connections": {
                "default": {
                    "engine": "tortoise.backends.asyncpg",
                    "credentials": {
                        "database": self.name,
                        "host": self.host,
                        "port": self.port,
                        "user": self.user,
                        "password": self.password,
                        "minsize": self.pool_min_size,
                        "maxsize": self.pool_max_size,
                    },
                }
            },
            "apps": {
                "models": {
                    "models": ["app.models"],
                    "default_connection": "default",
                }
            },
        }

    def dbmate_url(self) -> str:
        """Build a PostgreSQL URL for dbmate without logging credentials."""
        database = quote(self.name, safe="")
        user = quote(self.user, safe="")
        password = quote(self.password, safe="")
        host = f"[{self.host}]" if ":" in self.host and not self.host.startswith("[") else self.host
        auth = f"{user}:{password}" if password else user
        return f"postgresql://{auth}@{host}:{self.port}/{database}"


@dataclass(frozen=True, slots=True)
class LiteLLMSettings:
    """Private LiteLLM upstream and reverse-proxy connection-pool settings."""

    upstream_url: str
    upstream_root_path: str
    connect_timeout_seconds: int
    pool_timeout_seconds: int
    max_connections: int
    max_keepalive_connections: int
    keepalive_expiry_seconds: int


@dataclass(frozen=True, slots=True)
class OpenRouterSettings:
    """OpenRouter API, attribution, timeout, and connection-pool settings."""

    api_key: str
    base_url: str
    http_referer: str
    app_title: str
    app_categories: str
    connect_timeout_seconds: int
    request_timeout_seconds: int
    pool_timeout_seconds: int
    max_connections: int
    max_keepalive_connections: int
    keepalive_expiry_seconds: int


@dataclass(frozen=True, slots=True)
class CliInstallSettings:
    """Public CLI release distribution settings; never include secrets here."""

    releases_url: str


@dataclass(frozen=True, slots=True)
class CliReleaseAsset:
    s3_key: str
    archive_sha256: str
    binary_sha256: str


@dataclass(frozen=True, slots=True)
class CliReleaseSettings:
    bucket: str
    region: str
    key_prefix: str
    upload_auth_key: str
    put_url_expiry_seconds: int
    get_url_expiry_seconds: int
    distribution_url: str
    key_pair_id: str
    private_key: str
    latest_version: str
    versions: dict[str, CliReleaseAsset]


@dataclass(frozen=True, slots=True)
class Settings:
    """Settings used directly by the backend application and deployment scripts."""

    name: str
    host: str
    port: int
    workers: int
    access_log: bool
    debug: bool
    frontend_dir: Path
    cli_install: CliInstallSettings
    cli_releases: CliReleaseSettings | None
    database: DatabaseSettings
    litellm: LiteLLMSettings
    openrouter: OpenRouterSettings


def _mapping(source: dict[str, Any], key: str, path: str) -> dict[str, Any]:
    value = source.get(key)
    if not isinstance(value, dict):
        raise ConfigurationError(f"{path}.{key} must be an object")
    return value


def _string(source: dict[str, Any], key: str, path: str, *, allow_empty: bool = False) -> str:
    value = source.get(key)
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise ConfigurationError(f"{path}.{key} must be a non-empty string")
    return value.strip() if not allow_empty else value


def _integer(
    source: dict[str, Any],
    key: str,
    path: str,
    *,
    default: int | None = None,
    minimum: int = 1,
    maximum: int | None = None,
) -> int:
    value = source.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigurationError(f"{path}.{key} must be an integer")
    if value < minimum or (maximum is not None and value > maximum):
        expected_range = f"between {minimum} and {maximum}" if maximum is not None else f"at least {minimum}"
        raise ConfigurationError(f"{path}.{key} must be {expected_range}")
    return value


def _path(source: dict[str, Any], key: str, path: str, *, default: str) -> Path:
    """Resolve a filesystem path, treating a relative value as backend-root relative."""
    value = source.get(key, default)
    if not isinstance(value, str) or not value.strip():
        raise ConfigurationError(f"{path}.{key} must be a non-empty string")
    candidate = Path(value.strip()).expanduser()
    return candidate if candidate.is_absolute() else (BASE_DIR / candidate).resolve()


def _boolean(source: dict[str, Any], key: str, path: str, *, default: bool) -> bool:
    value = source.get(key, default)
    if not isinstance(value, bool):
        raise ConfigurationError(f"{path}.{key} must be a boolean")
    return value


def _http_origin(source: dict[str, Any], key: str, path: str) -> str:
    """Validate an HTTP(S) origin without credentials, query, or fragment."""
    value = _string(source, key, path).rstrip("/")
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ConfigurationError(f"{path}.{key} must be an HTTP(S) origin without credentials or a path")
    return value


def _https_releases_url(source: dict[str, Any], key: str, path: str) -> str:
    """Validate the public release base used by the POSIX shell installer."""
    value = _string(source, key, path)
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ConfigurationError(f"{path}.{key} must be an HTTPS release URL without a trailing slash") from exc
    if (
        not value.startswith("https://")
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or "?" in value
        or "#" in value
        or "\\" in value
        or value.endswith("/")
        or any(ord(char) < 33 or ord(char) > 126 for char in value)
        or (port is not None and port == 0)
    ):
        raise ConfigurationError(f"{path}.{key} must be an HTTPS release URL without a trailing slash")
    return value


SEMVER_PATTERN = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
S3_KEY_PATTERN = re.compile(r"^[A-Za-z0-9!_./+~=()\-]+$")


def _release_assets(config: dict[str, Any], prefix: str) -> dict[str, CliReleaseAsset]:
    versions_config = _mapping(config, "VERSIONS", "config.CLI_RELEASES")
    versions: dict[str, CliReleaseAsset] = {}
    for version, value in versions_config.items():
        if not isinstance(version, str) or not SEMVER_PATTERN.fullmatch(version) or not isinstance(value, dict):
            raise ConfigurationError("config.CLI_RELEASES.VERSIONS requires semantic-version objects")
        path = f"config.CLI_RELEASES.VERSIONS.{version}"
        key = _string(value, "s3_key", path)
        if (
            not key.startswith(f"{prefix}{version}/")
            or not key.endswith("/ddcli-darwin-arm64.gz")
            or not S3_KEY_PATTERN.fullmatch(key)
            or any(segment in {"", ".", ".."} for segment in key.split("/"))
        ):
            raise ConfigurationError(f"{path}.s3_key must be a safe versioned key under {prefix}")
        archive_hash = _string(value, "archive_sha256", path)
        binary_hash = _string(value, "binary_sha256", path)
        if not SHA256_PATTERN.fullmatch(archive_hash) or not SHA256_PATTERN.fullmatch(binary_hash):
            raise ConfigurationError(f"{path} requires lowercase 64-character SHA-256 hashes")
        versions[version] = CliReleaseAsset(key, archive_hash, binary_hash)
    return versions


def _cloudfront_credentials(config: dict[str, Any]) -> tuple[str, str, str]:
    cloudfront = _mapping(config, "CLOUDFRONT", "config.CLI_RELEASES")
    distribution_url = _https_releases_url(cloudfront, "DISTRIBUTION_URL", "config.CLI_RELEASES.CLOUDFRONT")
    if urlsplit(distribution_url).path:
        raise ConfigurationError("config.CLI_RELEASES.CLOUDFRONT.DISTRIBUTION_URL must be an HTTPS origin")
    private_key = _string(cloudfront, "PRIVATE_KEY", "config.CLI_RELEASES.CLOUDFRONT")
    try:
        parsed_key = serialization.load_pem_private_key(private_key.encode("utf-8"), password=None)
    except (TypeError, ValueError) as exc:
        raise ConfigurationError("config.CLI_RELEASES.CLOUDFRONT.PRIVATE_KEY must be an RSA PEM private key") from exc
    if not isinstance(parsed_key, rsa.RSAPrivateKey):
        raise ConfigurationError("config.CLI_RELEASES.CLOUDFRONT.PRIVATE_KEY must be an RSA PEM private key")
    key_pair_id = _string(cloudfront, "KEY_PAIR_ID", "config.CLI_RELEASES.CLOUDFRONT")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", key_pair_id):
        raise ConfigurationError("config.CLI_RELEASES.CLOUDFRONT.KEY_PAIR_ID contains invalid characters")
    return distribution_url, key_pair_id, private_key


def _cli_releases(raw: dict[str, Any]) -> CliReleaseSettings | None:
    # Older local config.json files continue to start with distribution disabled.
    if "CLI_RELEASES" not in raw:
        return None
    config = _mapping(raw, "CLI_RELEASES", "config")
    if not _boolean(config, "ENABLED", "config.CLI_RELEASES", default=False):
        return None
    prefix = _string(config, "KEY_PREFIX", "config.CLI_RELEASES")
    if not prefix.endswith("/") or prefix.startswith("/") or not S3_KEY_PATTERN.fullmatch(prefix):
        raise ConfigurationError("config.CLI_RELEASES.KEY_PREFIX must be a safe relative S3 prefix ending in /")
    if any(segment in {"", ".", ".."} for segment in prefix[:-1].split("/")):
        raise ConfigurationError("config.CLI_RELEASES.KEY_PREFIX contains an unsafe path segment")
    versions = _release_assets(config, prefix)
    latest = _string(config, "LATEST_VERSION", "config.CLI_RELEASES", allow_empty=True)
    if latest and latest not in versions:
        raise ConfigurationError("config.CLI_RELEASES.LATEST_VERSION must reference a configured version")
    distribution_url, key_pair_id, private_key = _cloudfront_credentials(config)
    upload_auth_key = _string(config, "UPLOAD_AUTH_KEY", "config.CLI_RELEASES")
    if len(upload_auth_key) < 32:
        raise ConfigurationError("config.CLI_RELEASES.UPLOAD_AUTH_KEY must have at least 32 characters")
    bucket = _string(config, "BUCKET", "config.CLI_RELEASES")
    region = _string(config, "REGION", "config.CLI_RELEASES")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
        raise ConfigurationError("config.CLI_RELEASES.BUCKET must be a valid S3 bucket name")
    if not re.fullmatch(r"[a-z0-9-]+", region):
        raise ConfigurationError("config.CLI_RELEASES.REGION must be an AWS region")
    return CliReleaseSettings(
        bucket=bucket,
        region=region,
        key_prefix=prefix,
        upload_auth_key=upload_auth_key,
        put_url_expiry_seconds=_integer(config, "PUT_URL_EXPIRY_SECONDS", "config.CLI_RELEASES", maximum=3600),
        get_url_expiry_seconds=_integer(config, "GET_URL_EXPIRY_SECONDS", "config.CLI_RELEASES", maximum=3600),
        distribution_url=distribution_url,
        key_pair_id=key_pair_id,
        private_key=private_key,
        latest_version=latest,
        versions=versions,
    )


def _http_base_url(source: dict[str, Any], key: str, path: str) -> str:
    """Validate an HTTP(S) base URL and normalize it for relative endpoints."""
    value = _string(source, key, path).rstrip("/") + "/"
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ConfigurationError(f"{path}.{key} must be an HTTP(S) URL without credentials, query, or fragment")
    return value


def _app_categories(source: dict[str, Any], key: str, path: str) -> str:
    """Validate and normalize OpenRouter's comma-separated app categories."""
    raw_value = _string(source, key, path, allow_empty=True)
    categories = [category.strip() for category in raw_value.split(",") if category.strip()]
    if len(categories) > 2:
        raise ConfigurationError(f"{path}.{key} must contain at most two categories")
    if any(
        len(category) > 30 or not category.replace("-", "").isalnum() or category.lower() != category
        for category in categories
    ):
        raise ConfigurationError(
            f"{path}.{key} categories must be lowercase, hyphen-separated, and at most 30 characters"
        )
    return ",".join(categories)


def _url_path(source: dict[str, Any], key: str, path: str) -> str:
    """Validate and normalize an absolute ASCII URL path."""
    value = _string(source, key, path)
    if not value.startswith("/") or "?" in value or "#" in value:
        raise ConfigurationError(f"{path}.{key} must be an absolute URL path")
    try:
        value.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ConfigurationError(f"{path}.{key} must contain only ASCII characters") from exc
    return value if value == "/" else value.rstrip("/")


@cache
def get_settings() -> Settings:
    """Parse and cache the backend configuration from its project directory."""
    try:
        raw_config = json.loads((BASE_DIR / "config.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigurationError("config.json must be a readable JSON file") from exc
    if not isinstance(raw_config, dict):
        raise ConfigurationError("config.json must contain a JSON object")

    database_configs = _mapping(raw_config, "DATABASE", "config")
    database_config = _mapping(database_configs, DATABASE_CONFIG_NAME, "config.DATABASE")
    litellm_config = _mapping(raw_config, "LITELLM", "config")
    openrouter_config = _mapping(raw_config, "OPENROUTER", "config")
    cli_install_config = _mapping(raw_config, "CLI_INSTALL", "config")
    pool_min_size = _integer(
        database_config,
        "DB_POOL_MIN_SIZE",
        f"config.DATABASE.{DATABASE_CONFIG_NAME}",
        default=1,
    )
    pool_max_size = _integer(
        database_config,
        "DB_POOL_MAX_SIZE",
        f"config.DATABASE.{DATABASE_CONFIG_NAME}",
        default=10,
        minimum=pool_min_size,
    )

    litellm = LiteLLMSettings(
        upstream_url=_http_origin(litellm_config, "UPSTREAM_URL", "config.LITELLM"),
        upstream_root_path=_url_path(
            litellm_config,
            "UPSTREAM_ROOT_PATH",
            "config.LITELLM",
        ),
        connect_timeout_seconds=_integer(
            litellm_config,
            "CONNECT_TIMEOUT_SECONDS",
            "config.LITELLM",
            default=10,
        ),
        pool_timeout_seconds=_integer(
            litellm_config,
            "POOL_TIMEOUT_SECONDS",
            "config.LITELLM",
            default=10,
        ),
        max_connections=_integer(
            litellm_config,
            "MAX_CONNECTIONS",
            "config.LITELLM",
            default=100,
        ),
        max_keepalive_connections=_integer(
            litellm_config,
            "MAX_KEEPALIVE_CONNECTIONS",
            "config.LITELLM",
            default=20,
        ),
        keepalive_expiry_seconds=_integer(
            litellm_config,
            "KEEPALIVE_EXPIRY_SECONDS",
            "config.LITELLM",
            default=5,
        ),
    )
    if litellm.max_keepalive_connections > litellm.max_connections:
        raise ConfigurationError("config.LITELLM.MAX_KEEPALIVE_CONNECTIONS must not exceed MAX_CONNECTIONS")

    openrouter = OpenRouterSettings(
        api_key=_string(openrouter_config, "API_KEY", "config.OPENROUTER"),
        base_url=_http_base_url(openrouter_config, "BASE_URL", "config.OPENROUTER"),
        http_referer=_http_origin(openrouter_config, "HTTP_REFERER", "config.OPENROUTER"),
        app_title=_string(openrouter_config, "APP_TITLE", "config.OPENROUTER"),
        app_categories=_app_categories(
            openrouter_config,
            "APP_CATEGORIES",
            "config.OPENROUTER",
        ),
        connect_timeout_seconds=_integer(
            openrouter_config,
            "CONNECT_TIMEOUT_SECONDS",
            "config.OPENROUTER",
            default=10,
        ),
        request_timeout_seconds=_integer(
            openrouter_config,
            "REQUEST_TIMEOUT_SECONDS",
            "config.OPENROUTER",
            default=120,
        ),
        pool_timeout_seconds=_integer(
            openrouter_config,
            "POOL_TIMEOUT_SECONDS",
            "config.OPENROUTER",
            default=10,
        ),
        max_connections=_integer(
            openrouter_config,
            "MAX_CONNECTIONS",
            "config.OPENROUTER",
            default=20,
        ),
        max_keepalive_connections=_integer(
            openrouter_config,
            "MAX_KEEPALIVE_CONNECTIONS",
            "config.OPENROUTER",
            default=10,
        ),
        keepalive_expiry_seconds=_integer(
            openrouter_config,
            "KEEPALIVE_EXPIRY_SECONDS",
            "config.OPENROUTER",
            default=5,
        ),
    )
    if openrouter.max_keepalive_connections > openrouter.max_connections:
        raise ConfigurationError("config.OPENROUTER.MAX_KEEPALIVE_CONNECTIONS must not exceed MAX_CONNECTIONS")

    database = DatabaseSettings(
        name=_string(database_config, "DB_NAME", f"config.DATABASE.{DATABASE_CONFIG_NAME}"),
        host=_string(database_config, "DB_HOST", f"config.DATABASE.{DATABASE_CONFIG_NAME}"),
        port=_integer(
            database_config,
            "DB_PORT",
            f"config.DATABASE.{DATABASE_CONFIG_NAME}",
            default=5432,
            maximum=65535,
        ),
        user=_string(database_config, "DB_USER", f"config.DATABASE.{DATABASE_CONFIG_NAME}"),
        password=_string(
            database_config,
            "DB_PASSWORD",
            f"config.DATABASE.{DATABASE_CONFIG_NAME}",
            allow_empty=True,
        ),
        pool_min_size=pool_min_size,
        pool_max_size=pool_max_size,
    )

    return Settings(
        name=_string(raw_config, "NAME", "config"),
        host=_string(raw_config, "HOST", "config"),
        port=_integer(raw_config, "PORT", "config", maximum=65535),
        workers=_integer(raw_config, "WORKERS", "config", default=1),
        access_log=_boolean(raw_config, "ACCESS_LOG", "config", default=True),
        debug=_boolean(raw_config, "DEBUG", "config", default=False),
        frontend_dir=_path(raw_config, "FRONTEND_DIR", "config", default=DEFAULT_FRONTEND_DIR),
        cli_install=CliInstallSettings(
            releases_url=_https_releases_url(cli_install_config, "RELEASES_URL", "config.CLI_INSTALL"),
        ),
        cli_releases=_cli_releases(raw_config),
        database=database,
        litellm=litellm,
        openrouter=openrouter,
    )
