"""Validated application settings backed by the backend's config.json."""

import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

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
class AuthServiceSettings:
    """Private auth-service origin and operator-controlled browser login page."""

    base_url: str
    browser_login_url: str
    connect_timeout_seconds: int
    request_timeout_seconds: int


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
    database: DatabaseSettings
    litellm: LiteLLMSettings
    openrouter: OpenRouterSettings
    auth_service: AuthServiceSettings | None


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
        database=database,
        litellm=litellm,
        openrouter=openrouter,
        auth_service=auth_service,
    )
