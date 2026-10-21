"""Validated application settings backed by the backend's config.json."""

import json
import re
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.core.cli_config import (
    CliCompactionConfig,
    CliLiteLLMClientConfig,
    CliModelRecommenderConfig,
    CliPiConfig,
    CliTelemetryConfig,
    OtelProxySettings,
    parse_cli_compaction,
    parse_cli_litellm_client,
    parse_cli_model_recommender,
    parse_cli_pi,
    parse_cli_telemetry,
    parse_otel_proxy,
)
from app.core.s3 import S3StorageSettings, parse_s3_storage
from app.core.session_storage import SessionStorageSettings, parse_session_storage
from app.core.terminal_permissions import TerminalPermissionsSettings, parse_terminal_permissions
from app.core.web_search import WebSearchSettings, parse_web_search
from app.telemetry import BackendTelemetrySettings, parse_backend_telemetry

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
    api_key: str = field(default="", repr=False)
    identity_sync_enabled: bool = False
    ui_enabled: bool = False
    ui_body_idle_timeout_seconds: int = 30
    ui_write_timeout_seconds: int = 30
    ui_request_timeout_seconds: int = 360
    ui_max_request_body_bytes: int = 32 * 1024 * 1024
    identity_sync_timeout_seconds: int = 10
    identity_sync_cache_seconds: int = 60
    identity_sync_cache_max_entries: int = 1000
    team_id: str = ""
    team_role: str = "user"
    decision_timeout_seconds: int = 120
    decision_max_concurrency: int = 10
    read_timeout_seconds: int = 360
    management_max_connections: int = 20


@dataclass(frozen=True, slots=True)
class ModelRecommenderSettings:
    """Backend-owned classifier model alias registered in LiteLLM."""

    classifier_model: str = "typesafe/jev-1.14"


@dataclass(frozen=True, slots=True)
class AuthServiceSettings:
    """Private auth-service origin and operator-controlled browser login page."""

    base_url: str
    browser_login_url: str
    connect_timeout_seconds: int
    request_timeout_seconds: int


@dataclass(frozen=True, slots=True)
class CliInstallSettings:
    """Public CLI release distribution settings; never include secrets here."""

    releases_url: str


CLI_RELEASE_TARGETS = ("darwin-arm64", "darwin-x64")
# Launchers released before x64 support know only this target, so every version must ship it.
DEFAULT_CLI_RELEASE_TARGET = "darwin-arm64"


@dataclass(frozen=True, slots=True)
class CliReleaseAsset:
    s3_key: str
    archive_sha256: str
    binary_sha256: str


@dataclass(frozen=True, slots=True)
class CliReleaseSettings:
    s3: S3StorageSettings
    key_prefix: str
    upload_auth_key: str = field(repr=False)
    put_url_expiry_seconds: int
    get_url_expiry_seconds: int
    distribution_url: str
    key_pair_id: str
    private_key: str = field(repr=False)
    latest_version: str
    # version -> release target -> asset
    versions: dict[str, dict[str, CliReleaseAsset]]


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
    auth_service: AuthServiceSettings | None
    cli_telemetry: CliTelemetryConfig | None
    otel_proxy: OtelProxySettings | None
    session_backups: SessionStorageSettings | None = None
    web_search: WebSearchSettings = field(default_factory=WebSearchSettings)
    model_recommender: ModelRecommenderSettings = field(default_factory=ModelRecommenderSettings)
    backend_telemetry: BackendTelemetrySettings | None = None
    cli_pi: CliPiConfig | None = None
    cli_compaction: CliCompactionConfig | None = None
    cli_model_recommender: CliModelRecommenderConfig | None = None
    cli_litellm_client: CliLiteLLMClientConfig | None = None
    terminal_permissions: TerminalPermissionsSettings | None = None


def _cli_pi_settings(raw_config: dict[str, Any]) -> CliPiConfig | None:
    try:
        return parse_cli_pi(raw_config)
    except (ValueError, TypeError):
        raise ConfigurationError("config.CLI_CLIENT_CONFIG.PI contains invalid Pi defaults") from None


def _cli_launch_preferences(
    raw_config: dict[str, Any],
) -> tuple[CliCompactionConfig | None, CliModelRecommenderConfig | None, CliLiteLLMClientConfig | None]:
    try:
        return (
            parse_cli_compaction(raw_config),
            parse_cli_model_recommender(raw_config),
            parse_cli_litellm_client(raw_config),
        )
    except (ValueError, TypeError):
        raise ConfigurationError("config.CLI_CLIENT_CONFIG contains invalid launch preferences") from None


def _backend_telemetry_settings(raw_config: dict[str, Any]) -> BackendTelemetrySettings | None:
    try:
        return parse_backend_telemetry(raw_config)
    except (ValueError, TypeError):
        raise ConfigurationError("config.OPEN_TELEMETRY contains invalid settings") from None


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


def _optional_string(source: dict[str, Any], key: str, path: str) -> str:
    value = source.get(key, "")
    if not isinstance(value, str):
        raise ConfigurationError(f"{path}.{key} must be a string")
    return value.strip()


def _upstream_api_key(source: dict[str, Any], key: str, path: str) -> str:
    value = _optional_string(source, key, path)
    # A private stock LiteLLM deployment may not require its own API key.
    # Axon session authentication remains mandatory even when this is empty.
    if any(not 33 <= ord(character) <= 126 for character in value):
        raise ConfigurationError(f"{path}.{key} must contain only printable ASCII characters without spaces")
    return value


def _litellm_team_assignment(source: dict[str, Any]) -> tuple[str, str, bool]:
    team_id = _optional_string(source, "TEAM_ID", "config.LITELLM")
    if any(not 33 <= ord(character) <= 126 for character in team_id):
        raise ConfigurationError("config.LITELLM.TEAM_ID must contain only printable ASCII characters without spaces")
    team_role = _optional_string(source, "TEAM_ROLE", "config.LITELLM") if "TEAM_ROLE" in source else "user"
    if team_role not in {"user", "admin"}:
        raise ConfigurationError("config.LITELLM.TEAM_ROLE must be user or admin")
    identity_sync = _boolean(source, "IDENTITY_SYNC_ENABLED", "config.LITELLM", default=False)
    if identity_sync and not team_id:
        raise ConfigurationError("config.LITELLM.TEAM_ID is required when IDENTITY_SYNC_ENABLED is true")
    return team_id, team_role, identity_sync


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


def _release_asset(value: dict[str, Any], path: str, prefix: str, version: str, target: str) -> CliReleaseAsset:
    key = _string(value, "s3_key", path)
    if (
        not key.startswith(f"{prefix}{version}/")
        or not key.endswith(f"/axon-{target}.gz")
        or not S3_KEY_PATTERN.fullmatch(key)
        or any(segment in {"", ".", ".."} for segment in key.split("/"))
    ):
        raise ConfigurationError(f"{path}.s3_key must be a safe versioned key under {prefix}")
    archive_hash = _string(value, "archive_sha256", path)
    binary_hash = _string(value, "binary_sha256", path)
    if not SHA256_PATTERN.fullmatch(archive_hash) or not SHA256_PATTERN.fullmatch(binary_hash):
        raise ConfigurationError(f"{path} requires lowercase 64-character SHA-256 hashes")
    return CliReleaseAsset(key, archive_hash, binary_hash)


def _release_assets(config: dict[str, Any], prefix: str) -> dict[str, dict[str, CliReleaseAsset]]:
    versions_config = _mapping(config, "VERSIONS", "config.CLI_RELEASES")
    versions: dict[str, dict[str, CliReleaseAsset]] = {}
    for version, value in versions_config.items():
        if not isinstance(version, str) or not SEMVER_PATTERN.fullmatch(version) or not isinstance(value, dict):
            raise ConfigurationError("config.CLI_RELEASES.VERSIONS requires semantic-version objects")
        path = f"config.CLI_RELEASES.VERSIONS.{version}"
        if "s3_key" in value:
            # A flat entry predates x64 support and describes only the darwin-arm64 archive.
            target = DEFAULT_CLI_RELEASE_TARGET
            versions[version] = {target: _release_asset(value, path, prefix, version, target)}
            continue
        unsupported = sorted(set(value) - set(CLI_RELEASE_TARGETS))
        if unsupported:
            raise ConfigurationError(f"{path} has unsupported release targets: {', '.join(unsupported)}")
        if DEFAULT_CLI_RELEASE_TARGET not in value:
            raise ConfigurationError(f"{path} requires a {DEFAULT_CLI_RELEASE_TARGET} release")
        assets: dict[str, CliReleaseAsset] = {}
        for target, target_value in value.items():
            if not isinstance(target_value, dict):
                raise ConfigurationError(f"{path}.{target} must be an object")
            assets[target] = _release_asset(target_value, f"{path}.{target}", prefix, version, target)
        versions[version] = assets
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
    try:
        s3 = parse_s3_storage(config.get("S3"), "config.CLI_RELEASES.S3")
    except ValueError as exc:
        raise ConfigurationError(str(exc)) from None
    return CliReleaseSettings(
        s3=s3,
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


def _session_backups(raw: dict) -> SessionStorageSettings | None:
    try:
        return parse_session_storage(raw)
    except (ValueError, TypeError, AttributeError):
        raise ConfigurationError("config.SESSION_BACKUPS contains invalid settings") from None


def _web_search(raw: dict[str, Any]) -> WebSearchSettings:
    try:
        return parse_web_search(raw)
    except (ValueError, TypeError):
        raise ConfigurationError("config.WEB_SEARCH contains invalid search settings") from None


def _model_recommender(raw: dict[str, Any]) -> ModelRecommenderSettings:
    section = raw.get("MODEL_RECOMMENDER", {})
    if not isinstance(section, dict):
        raise ConfigurationError("config.MODEL_RECOMMENDER must be an object")
    if "CLASSIFIER_MODEL" not in section:
        return ModelRecommenderSettings()
    return ModelRecommenderSettings(
        classifier_model=_string(section, "CLASSIFIER_MODEL", "config.MODEL_RECOMMENDER"),
    )


def _terminal_permissions(raw: dict[str, Any]) -> TerminalPermissionsSettings | None:
    try:
        return parse_terminal_permissions(raw)
    except (ValueError, TypeError):
        raise ConfigurationError("config.TERMINAL_PERMISSIONS contains invalid settings") from None


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
    cli_install_config = _mapping(raw_config, "CLI_INSTALL", "config")
    auth_service_config = raw_config.get("AUTH_SERVICE")
    if auth_service_config is not None and not isinstance(auth_service_config, dict):
        raise ConfigurationError("config.AUTH_SERVICE must be an object")
    auth_service = None
    if auth_service_config is not None:
        browser_login_url = _string(auth_service_config, "BROWSER_LOGIN_URL", "config.AUTH_SERVICE")
        parsed_browser_url = urlsplit(browser_login_url)
        if (
            parsed_browser_url.scheme not in {"http", "https"}
            or not parsed_browser_url.hostname
            or parsed_browser_url.username is not None
            or parsed_browser_url.password is not None
            or parsed_browser_url.fragment
            or parsed_browser_url.query
            or not parsed_browser_url.path.endswith("/external-auth")
            or (
                parsed_browser_url.scheme == "http"
                and parsed_browser_url.hostname not in {"localhost", "127.0.0.1", "::1"}
            )
        ):
            raise ConfigurationError(
                "config.AUTH_SERVICE.BROWSER_LOGIN_URL must end in /external-auth and use HTTPS (or loopback HTTP) without credentials, query, or fragment"
            )
        auth_service = AuthServiceSettings(
            base_url=_http_base_url(auth_service_config, "BASE_URL", "config.AUTH_SERVICE"),
            browser_login_url=browser_login_url,
            connect_timeout_seconds=_integer(
                auth_service_config, "CONNECT_TIMEOUT_SECONDS", "config.AUTH_SERVICE", default=5
            ),
            request_timeout_seconds=_integer(
                auth_service_config, "REQUEST_TIMEOUT_SECONDS", "config.AUTH_SERVICE", default=10
            ),
        )
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

    litellm_team_id, litellm_team_role, litellm_identity_sync = _litellm_team_assignment(litellm_config)

    litellm = LiteLLMSettings(
        api_key=_upstream_api_key(litellm_config, "API_KEY", "config.LITELLM"),
        decision_timeout_seconds=_integer(litellm_config, "DECISION_TIMEOUT_SECONDS", "config.LITELLM", default=120),
        decision_max_concurrency=_integer(litellm_config, "DECISION_MAX_CONCURRENCY", "config.LITELLM", default=10),
        team_id=litellm_team_id,
        team_role=litellm_team_role,
        identity_sync_enabled=litellm_identity_sync,
        ui_enabled=_boolean(litellm_config, "UI_ENABLED", "config.LITELLM", default=False),
        ui_body_idle_timeout_seconds=_integer(
            litellm_config, "UI_BODY_IDLE_TIMEOUT_SECONDS", "config.LITELLM", default=30
        ),
        ui_write_timeout_seconds=_integer(litellm_config, "UI_WRITE_TIMEOUT_SECONDS", "config.LITELLM", default=30),
        ui_request_timeout_seconds=_integer(
            litellm_config, "UI_REQUEST_TIMEOUT_SECONDS", "config.LITELLM", default=360
        ),
        ui_max_request_body_bytes=_integer(
            litellm_config, "UI_MAX_REQUEST_BODY_BYTES", "config.LITELLM", default=32 * 1024 * 1024
        ),
        identity_sync_timeout_seconds=_integer(
            litellm_config, "IDENTITY_SYNC_TIMEOUT_SECONDS", "config.LITELLM", default=10
        ),
        identity_sync_cache_seconds=_integer(
            litellm_config, "IDENTITY_SYNC_CACHE_SECONDS", "config.LITELLM", default=60, minimum=0
        ),
        identity_sync_cache_max_entries=_integer(
            litellm_config, "IDENTITY_SYNC_CACHE_MAX_ENTRIES", "config.LITELLM", default=1000
        ),
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
        read_timeout_seconds=_integer(litellm_config, "READ_TIMEOUT_SECONDS", "config.LITELLM", default=360),
        management_max_connections=_integer(litellm_config, "MANAGEMENT_MAX_CONNECTIONS", "config.LITELLM", default=20),
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
    # Decisions hold buffered connections for minutes; identity sync needs the remainder.
    if litellm.decision_max_concurrency >= litellm.management_max_connections:
        raise ConfigurationError("config.LITELLM.DECISION_MAX_CONCURRENCY must be less than MANAGEMENT_MAX_CONNECTIONS")

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

    try:
        cli_telemetry = parse_cli_telemetry(raw_config)
        otel_proxy = parse_otel_proxy(raw_config)
        if otel_proxy is not None and auth_service is None:
            raise ValueError("OTEL proxy requires auth service")
    except (ValueError, TypeError):
        # Suppress chained validation inputs, including credentials in invalid URLs.
        raise ConfigurationError("config.CLI_CLIENT_CONFIG contains invalid telemetry settings") from None

    cli_pi = _cli_pi_settings(raw_config)
    cli_compaction, cli_model_recommender, cli_litellm_client = _cli_launch_preferences(raw_config)
    session_backups = _session_backups(raw_config)
    web_search = _web_search(raw_config)
    terminal_permissions = _terminal_permissions(raw_config)
    backend_telemetry = _backend_telemetry_settings(raw_config)

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
        auth_service=auth_service,
        cli_telemetry=cli_telemetry,
        cli_pi=cli_pi,
        cli_compaction=cli_compaction,
        cli_model_recommender=cli_model_recommender,
        cli_litellm_client=cli_litellm_client,
        otel_proxy=otel_proxy,
        session_backups=session_backups,
        web_search=web_search,
        model_recommender=_model_recommender(raw_config),
        terminal_permissions=terminal_permissions,
        backend_telemetry=backend_telemetry,
    )
