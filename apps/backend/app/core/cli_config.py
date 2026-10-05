"""Managed CLI telemetry always targets our authenticated OTLP/HTTP proxy."""

from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field

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
