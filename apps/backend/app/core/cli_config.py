"""Validated CLI defaults and telemetry for our authenticated config endpoint."""

import math
from dataclasses import dataclass, field
from typing import Annotated, Literal, TypeVar
from urllib.parse import urlsplit

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator, model_validator

OTEL_PROXY_PATH = "/api/v1/otel"


class CliTelemetryConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    enabled: bool = Field(strict=True)
    endpoint: Literal["/api/v1/otel"] = OTEL_PROXY_PATH
    protocol: Literal["http/protobuf"] = "http/protobuf"
    trace_sample_ratio: float = Field(default=1, alias="traceSampleRatio", ge=0, le=1, strict=True, allow_inf_nan=False)
    metric_export_interval_ms: int = Field(
        default=10000, alias="metricExportIntervalMs", ge=1000, le=300000, strict=True
    )


class CliPiConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    codemode_enabled: bool = Field(alias="codemodeEnabled", strict=True)
    litellm_mcp_enabled: bool = Field(alias="litellmMcpEnabled", strict=True)
    # Pi only uses a saved default when both are set, so they are managed as a pair.
    default_provider: str | None = Field(default=None, alias="defaultProvider", strict=True, max_length=256)
    default_model: str | None = Field(default=None, alias="defaultModel", strict=True, max_length=256)

    @field_validator("default_provider", "default_model", mode="before")
    @classmethod
    def unmanaged_when_empty(cls, value: object) -> object:
        return None if value == "" else value

    @field_validator("default_provider", "default_model")
    @classmethod
    def setting_text(cls, value: str | None) -> str | None:
        if value is not None and (
            value != value.strip(_JS_WHITESPACE) or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value)
        ):
            raise ValueError("Expected trimmed text without control characters")
        return value

    @model_validator(mode="after")
    def default_model_pair(self) -> "CliPiConfig":
        if (self.default_provider is None) != (self.default_model is None):
            raise ValueError("DEFAULT_PROVIDER and DEFAULT_MODEL must be set together")
        return self


def parse_cli_pi(raw: dict[str, object]) -> CliPiConfig | None:
    """An absent/null PI section leaves existing local Pi defaults unchanged."""
    section = raw.get("CLI_CLIENT_CONFIG")
    if section is None:
        return None
    if not isinstance(section, dict):
        raise ValueError("CLI_CLIENT_CONFIG must be an object")
    pi = section.get("PI")
    if pi is None:
        return None
    if not isinstance(pi, dict) or set(pi) - {
        "CODEMODE_ENABLED",
        "LITELLM_MCP_ENABLED",
        "DEFAULT_PROVIDER",
        "DEFAULT_MODEL",
    }:
        raise ValueError("PI must contain only supported Pi defaults")
    return CliPiConfig.model_validate(
        {
            "codemodeEnabled": pi.get("CODEMODE_ENABLED"),
            "litellmMcpEnabled": pi.get("LITELLM_MCP_ENABLED"),
            "defaultProvider": pi.get("DEFAULT_PROVIDER"),
            "defaultModel": pi.get("DEFAULT_MODEL"),
        }
    )


def _json_integer(value: object) -> int:
    # JSON 1 and 1.0 have identical semantics in JavaScript. Never coerce strings/bools.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Expected an integral JSON number")
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        raise ValueError("Expected an integral JSON number")
    return int(value)


# Match JavaScript String.trim(), including BOM but excluding non-whitespace controls.
_JS_WHITESPACE = " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

PositiveInteger = Annotated[int, Field(strict=True, ge=1, le=2147483647), BeforeValidator(_json_integer)]
Countdown = Annotated[int, Field(strict=True, ge=1, le=300000), BeforeValidator(_json_integer)]
DiscoveryTimeout = Annotated[int, Field(strict=True, ge=0, le=300000), BeforeValidator(_json_integer)]


class CliCompactionConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    enabled: bool | None = Field(default=None, strict=True)
    model: str | None = Field(default=None, strict=True, max_length=256)
    threshold_tokens: PositiveInteger | None = Field(default=None, alias="thresholdTokens")
    max_output_tokens: PositiveInteger | None = Field(default=None, alias="maxOutputTokens")
    timeout_ms: PositiveInteger | None = Field(default=None, alias="timeoutMs")

    @field_validator("model")
    @classmethod
    def qualified_model(cls, value: str | None) -> str | None:
        if value is None:
            return None
        provider, separator, model_id = value.partition("/")
        if (
            value != value.strip(_JS_WHITESPACE)
            or not separator
            or not provider.strip(_JS_WHITESPACE)
            or not model_id.strip(_JS_WHITESPACE)
            or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value)
        ):
            raise ValueError("Expected a trimmed provider/model-id without control characters")
        return value


class CliModelRecommenderConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    enabled: bool | None = Field(default=None, strict=True)
    timeout_ms: Countdown | None = Field(default=None, alias="timeoutMs")
    auto_select_ms: Countdown | None = Field(default=None, alias="autoSelectMs")


class CliLiteLLMClientConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    discovery_timeout_ms: DiscoveryTimeout | None = Field(default=None, alias="discoveryTimeoutMs")
    default_context_window: PositiveInteger | None = Field(default=None, alias="defaultContextWindow")


Preference = TypeVar("Preference", bound=BaseModel)


def _parse_preferences(
    raw: dict[str, object], name: str, fields: dict[str, str], model: type[Preference]
) -> Preference | None:
    section = raw.get("CLI_CLIENT_CONFIG")
    if section is None:
        return None
    if not isinstance(section, dict):
        raise ValueError("CLI_CLIENT_CONFIG must be an object")
    preferences = section.get(name)
    if preferences is None:
        return None
    if not isinstance(preferences, dict) or set(preferences) - set(fields):
        raise ValueError(f"{name} must contain only supported preferences")
    supplied = {fields[key]: value for key, value in preferences.items() if value is not None}
    return model.model_validate(supplied) if supplied else None


def parse_cli_compaction(raw: dict[str, object]) -> CliCompactionConfig | None:
    return _parse_preferences(
        raw,
        "COMPACTION",
        {
            "ENABLED": "enabled",
            "MODEL": "model",
            "THRESHOLD_TOKENS": "thresholdTokens",
            "MAX_OUTPUT_TOKENS": "maxOutputTokens",
            "TIMEOUT_MS": "timeoutMs",
        },
        CliCompactionConfig,
    )


def parse_cli_model_recommender(raw: dict[str, object]) -> CliModelRecommenderConfig | None:
    return _parse_preferences(
        raw,
        "MODEL_RECOMMENDER",
        {"ENABLED": "enabled", "TIMEOUT_MS": "timeoutMs", "AUTO_SELECT_MS": "autoSelectMs"},
        CliModelRecommenderConfig,
    )


def parse_cli_litellm_client(raw: dict[str, object]) -> CliLiteLLMClientConfig | None:
    return _parse_preferences(
        raw,
        "LITELLM_CLIENT",
        {"DISCOVERY_TIMEOUT_MS": "discoveryTimeoutMs", "DEFAULT_CONTEXT_WINDOW": "defaultContextWindow"},
        CliLiteLLMClientConfig,
    )


@dataclass(frozen=True, slots=True)
class OtelProxySettings:
    upstream_url: str
    headers: dict[str, str] = field(repr=False)
    connect_timeout_seconds: int = 2
    request_timeout_seconds: int = 5
    max_body_bytes: int = 2097152
    max_decoded_body_bytes: int = 4194304
    max_concurrent_requests: int = 20
    rate_limit_per_minute: int = 120


def collector_url(value: object) -> str:
    """Private, operator-configured upstream; HTTP is allowed on private networks."""
    if not isinstance(value, str):
        raise ValueError("Invalid collector URL")
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"https", "http"}
        or not parsed.hostname
        or parsed.port == 0
        or parsed.username is not None
        or parsed.password is not None
        or "?" in value
        or "#" in value
        or "\\" in value
        or any(ord(char) < 33 or ord(char) > 126 for char in value)
    ):
        raise ValueError("Invalid collector URL")
    return value.rstrip("/")


def _approved_upstream(section: dict[str, object], proxy: dict[str, object]) -> str:
    upstream = collector_url(proxy.get("UPSTREAM_URL"))
    origins = section.get("ALLOWED_TELEMETRY_ORIGINS", [])
    if not isinstance(origins, list):
        raise ValueError("ALLOWED_TELEMETRY_ORIGINS must be a list")
    allowed = set()
    for origin in origins:
        parsed = urlsplit(collector_url(origin))
        if parsed.path not in {"", "/"}:
            raise ValueError("Collector allowlist requires origins, not paths")
        allowed.add((parsed.scheme, parsed.netloc.lower()))
    target = urlsplit(upstream)
    if (target.scheme, target.netloc.lower()) not in allowed:
        raise ValueError("Collector origin is not allowlisted")
    return upstream


def _proxy_headers(proxy: dict[str, object]) -> dict[str, str]:
    headers = proxy.get("HEADERS", {})
    if not isinstance(headers, dict):
        raise ValueError("PROXY.HEADERS must be an object")
    for name, value in headers.items():
        if (
            not isinstance(name, str)
            or not name
            or not all(char.isascii() and (char.isalnum() or char in "!#$%&'*+-.^_`|~") for char in name)
            or name.lower()
            in {"host", "content-length", "content-type", "content-encoding", "connection", "transfer-encoding"}
            or not isinstance(value, str)
            or not value
            or len(value) > 8192
            or any(ord(char) < 32 or ord(char) > 126 for char in value)
        ):
            raise ValueError("Invalid collector header")
    return dict(headers)


def _proxy_limits(proxy: dict[str, object]) -> dict[str, int]:
    integers = {}
    for name, default, maximum in [
        ("CONNECT_TIMEOUT_SECONDS", 2, 30),
        ("REQUEST_TIMEOUT_SECONDS", 5, 60),
        ("MAX_BODY_BYTES", 2097152, 16777216),
        ("MAX_DECODED_BODY_BYTES", 4194304, 33554432),
        ("MAX_CONCURRENT_REQUESTS", 20, 1000),
        ("RATE_LIMIT_PER_MINUTE", 120, 10000),
    ]:
        value = proxy.get(name, default)
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
            raise ValueError("Invalid proxy limit")
        integers[name.lower()] = value
    if integers["max_decoded_body_bytes"] < integers["max_body_bytes"]:
        raise ValueError("Decoded body limit must be at least the wire body limit")
    return integers


def parse_otel_proxy(raw: dict[str, object]) -> OtelProxySettings | None:
    section = raw.get("CLI_CLIENT_CONFIG")
    if section is None:
        return None
    if not isinstance(section, dict):
        raise ValueError("CLI_CLIENT_CONFIG must be an object")
    proxy = section.get("PROXY")
    if proxy is None:
        return None
    if not isinstance(proxy, dict) or not isinstance(proxy.get("ENABLED", False), bool):
        raise ValueError("PROXY must be an object with boolean ENABLED")
    if not proxy.get("ENABLED", False):
        return None
    return OtelProxySettings(
        upstream_url=_approved_upstream(section, proxy),
        headers=_proxy_headers(proxy),
        **_proxy_limits(proxy),
    )


def parse_cli_telemetry(raw: dict[str, object]) -> CliTelemetryConfig | None:
    """Null means env fallback; disabled policy is an explicit kill switch."""
    section = raw.get("CLI_CLIENT_CONFIG")
    if section is None:
        return None
    if not isinstance(section, dict):
        raise ValueError("CLI_CLIENT_CONFIG must be an object")
    telemetry = section.get("TELEMETRY")
    if telemetry is None:
        return None
    if not isinstance(telemetry, dict):
        raise ValueError("TELEMETRY must be an object")
    fields = {
        "ENABLED": "enabled",
        "ENDPOINT": "endpoint",
        "PROTOCOL": "protocol",
        "TRACE_SAMPLE_RATIO": "traceSampleRatio",
        "METRIC_EXPORT_INTERVAL_MS": "metricExportIntervalMs",
    }
    if set(telemetry) - set(fields):
        raise ValueError("Unknown telemetry setting")
    config = CliTelemetryConfig.model_validate({fields[key]: value for key, value in telemetry.items()})
    if config.enabled and parse_otel_proxy(raw) is None:
        raise ValueError("Managed telemetry requires an enabled proxy")
    return config
