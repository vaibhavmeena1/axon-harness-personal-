"""Protected CLI defaults: validation, safe projection, and auth errors."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import authentication
from app.clients.auth_service import AuthDataResponse, AuthServiceError
from app.core import config as config_module
from app.core.cli_config import CliPiConfig, CliTelemetryConfig, parse_cli_pi, parse_cli_telemetry
from app.core.config import ConfigurationError, get_settings
from app.core.web_search import WebSearchSettings
from app.routers.cli_config import router

POLICY = {
    "enabled": True,
    "endpoint": "/api/v1/otel",
    "protocol": "http/protobuf",
    "traceSampleRatio": 0.25,
    "metricExportIntervalMs": 20000,
}


def test_config_uses_session_guard_and_only_allowlisted_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = []

    class AuthClient:
        async def get_auth_data(self, authorization: str, grace_params: dict) -> AuthDataResponse:
            seen.append(authorization)
            return AuthDataResponse.model_validate(
                {
                    "auth_data": {
                        "user_team_id": 12,
                        "session_refresh_token": "rotated-secret",
                        "private": "not-public",
                    },
                    "response_headers": {},
                }
            )

    monkeypatch.setattr(authentication, "get_auth_service_client", lambda _request: AuthClient())
    app = FastAPI()
    app.include_router(router)
    web_search = WebSearchSettings()
    public_search = web_search.cli_config().model_dump(by_alias=True, mode="json", exclude_none=True)
    app.dependency_overrides[get_settings] = lambda: SimpleNamespace(
        cli_telemetry=CliTelemetryConfig.model_validate(POLICY),
        cli_pi=CliPiConfig.model_validate({"codemodeEnabled": True, "litellmMcpEnabled": True}),
        web_search=web_search,
        terminal_permissions=None,
    )
    client = TestClient(app)
    denied = client.get("/api/v1/cli/config")
    assert denied.status_code == 401
    assert denied.headers["cache-control"] == "no-store"
    response = client.get("/api/v1/cli/config", headers={"Authorization": "Bearer saved-secret"})
    assert seen == ["Bearer saved-secret"]
    assert response.json() == {
        "schemaVersion": 1,
        "telemetry": POLICY,
        "pi": {"codemodeEnabled": True, "litellmMcpEnabled": True},
        "webSearch": public_search,
    }
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-session-refresh-token"] == "rotated-secret"
    assert "secret" not in response.text
    app.dependency_overrides[get_settings] = lambda: SimpleNamespace(
        cli_telemetry=None, cli_pi=None, web_search=web_search, terminal_permissions=None
    )
    assert client.get("/api/v1/cli/config", headers={"Authorization": "Bearer second-user"}).json() == {
        "schemaVersion": 1,
        "webSearch": public_search,
    }


@pytest.mark.parametrize("status", [401, 403, 503])
def test_auth_errors_are_safe_and_uncached(monkeypatch: pytest.MonkeyPatch, status: int) -> None:
    class AuthClient:
        async def get_auth_data(self, *_args: object) -> None:
            raise AuthServiceError("credential-secret", status_code=status)

    monkeypatch.setattr(authentication, "get_auth_service_client", lambda _request: AuthClient())
    app = FastAPI()
    app.include_router(router)
    response = TestClient(app).get("/api/v1/cli/config", headers={"Authorization": "Bearer secret"})
    assert response.status_code == status
    assert response.headers["cache-control"] == "no-store"
    assert "secret" not in response.text


def settings_raw() -> dict:
    return {
        "DEBUG": False,
        "CLI_CLIENT_CONFIG": {
            "ALLOWED_TELEMETRY_ORIGINS": ["https://collector.example.test"],
            "PROXY": {
                "ENABLED": True,
                "UPSTREAM_URL": "https://collector.example.test/otlp",
                "HEADERS": {"Authorization": "Bearer collector-secret"},
            },
            "TELEMETRY": {
                "ENABLED": True,
                "ENDPOINT": POLICY["endpoint"],
                "PROTOCOL": "http/protobuf",
                "TRACE_SAMPLE_RATIO": 0.25,
                "METRIC_EXPORT_INTERVAL_MS": 20000,
            },
        },
    }


def test_telemetry_source_is_explicit_and_optional() -> None:
    assert parse_cli_telemetry({}) is None
    assert parse_cli_telemetry({"CLI_CLIENT_CONFIG": {"TELEMETRY": None}}) is None
    config = parse_cli_telemetry(settings_raw())
    assert config is not None
    assert config.model_dump(by_alias=True) == POLICY
    assert parse_cli_telemetry({"CLI_CLIENT_CONFIG": {"TELEMETRY": {"ENABLED": False}}}).enabled is False


@pytest.mark.parametrize(
    "patch",
    [
        {"ENDPOINT": "http://collector.example.test"},
        {"ENDPOINT": "https://evil.test"},
        {"ENDPOINT": "https://user:secret@collector.example.test"},
        {"ENDPOINT": "https://collector.example.test?token=secret"},
        {"ENDPOINT": "https://collector.example.test#fragment"},
        {"ENDPOINT": None},
        {"TRACE_SAMPLE_RATIO": -1},
        {"TRACE_SAMPLE_RATIO": float("nan")},
        {"TRACE_SAMPLE_RATIO": True},
        {"METRIC_EXPORT_INTERVAL_MS": 1},
        {"PROTOCOL": "http/json"},
        {"HEADERS": "secret"},
        {"ENABLED": "true"},
    ],
)
def test_rejects_unsafe_or_unbounded_policy(patch: dict) -> None:
    raw = settings_raw()
    raw["CLI_CLIENT_CONFIG"]["TELEMETRY"].update(patch)
    with pytest.raises(ValueError):
        parse_cli_telemetry(raw)


def test_private_collector_does_not_become_the_public_endpoint() -> None:
    raw = settings_raw()
    raw["CLI_CLIENT_CONFIG"]["PROXY"]["UPSTREAM_URL"] = "http://localhost:4318"
    raw["CLI_CLIENT_CONFIG"]["ALLOWED_TELEMETRY_ORIGINS"] = ["http://localhost:4318"]
    assert parse_cli_telemetry(raw).endpoint == "/api/v1/otel"
    raw["CLI_CLIENT_CONFIG"]["ALLOWED_TELEMETRY_ORIGINS"] = []
    with pytest.raises(ValueError):
        parse_cli_telemetry(raw)


def test_template_has_explicit_disabled_telemetry_defaults() -> None:
    raw = json.loads((Path(__file__).resolve().parents[1] / "config_template.json").read_text())
    # The Vault config generator recurses into configured objects, so the
    # corresponding template must expose their keys rather than use null.
    assert raw["CLI_CLIENT_CONFIG"]["TELEMETRY"] == {
        "ENABLED": False,
        "ENDPOINT": "/api/v1/otel",
        "PROTOCOL": "http/protobuf",
        "TRACE_SAMPLE_RATIO": 1.0,
        "METRIC_EXPORT_INTERVAL_MS": 10000,
    }
    telemetry = parse_cli_telemetry(raw)
    assert telemetry is not None
    assert telemetry.enabled is False


def test_settings_loader_and_template_are_synchronized(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    raw = json.loads((Path(__file__).resolve().parents[1] / "config_template.json").read_text())
    assert raw["CLI_CLIENT_CONFIG"]["PI"] == {"CODEMODE_ENABLED": True, "LITELLM_MCP_ENABLED": True}
    raw.update(settings_raw())
    raw["CLI_CLIENT_CONFIG"]["PI"] = {"CODEMODE_ENABLED": True, "LITELLM_MCP_ENABLED": True}
    (tmp_path / "config.json").write_text(json.dumps(raw))
    monkeypatch.setattr(config_module, "BASE_DIR", tmp_path)
    get_settings.cache_clear()
    try:
        assert get_settings().cli_telemetry.model_dump(by_alias=True) == POLICY
        assert get_settings().cli_pi.model_dump(by_alias=True) == {"codemodeEnabled": True, "litellmMcpEnabled": True}
        raw["CLI_CLIENT_CONFIG"]["TELEMETRY"]["ENDPOINT"] = "https://collector.example.test?token=private"
        (tmp_path / "config.json").write_text(json.dumps(raw))
        get_settings.cache_clear()
        with pytest.raises(ConfigurationError, match="CLI_CLIENT_CONFIG") as error:
            get_settings()
        assert "private" not in str(error.value)
    finally:
        get_settings.cache_clear()


def test_pi_defaults_are_explicit_and_optional() -> None:
    for raw in [{}, {"CLI_CLIENT_CONFIG": {}}, {"CLI_CLIENT_CONFIG": {"PI": None}}]:
        assert parse_cli_pi(raw) is None
    for codemode_enabled in [True, False]:
        for litellm_mcp_enabled in [True, False]:
            defaults = parse_cli_pi(
                {
                    "CLI_CLIENT_CONFIG": {
                        "PI": {
                            "CODEMODE_ENABLED": codemode_enabled,
                            "LITELLM_MCP_ENABLED": litellm_mcp_enabled,
                        }
                    }
                }
            )
            assert defaults is not None
            assert defaults.model_dump(by_alias=True) == {
                "codemodeEnabled": codemode_enabled,
                "litellmMcpEnabled": litellm_mcp_enabled,
            }


@pytest.mark.parametrize(
    "pi",
    [
        {},
        True,
        [],
        {"CODEMODE_ENABLED": True},
        {"LITELLM_MCP_ENABLED": True},
        {"CODEMODE_ENABLED": True, "LITELLM_MCP_ENABLED": "true"},
        {"CODEMODE_ENABLED": True, "LITELLM_MCP_ENABLED": 1},
        {"CODEMODE_ENABLED": True, "LITELLM_MCP_ENABLED": None},
        {"CODEMODE_ENABLED": "true", "LITELLM_MCP_ENABLED": True},
        {"CODEMODE_ENABLED": 1, "LITELLM_MCP_ENABLED": True},
        {"CODEMODE_ENABLED": None, "LITELLM_MCP_ENABLED": True},
        {"CODEMODE_ENABLED": True, "LITELLM_MCP_ENABLED": True, "INLINE_BUDGET": 3000},
        {"CODEMODE_ENABLED": True, "LITELLM_MCP_ENABLED": True, "SHELL_COMMAND_PREFIX": "private-secret"},
    ],
)
def test_rejects_invalid_or_unapproved_pi_defaults(pi: object) -> None:
    with pytest.raises(ValueError):
        parse_cli_pi({"CLI_CLIENT_CONFIG": {"PI": pi}})


def test_settings_loader_rejects_invalid_pi_defaults_safely(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    raw = json.loads((Path(__file__).resolve().parents[1] / "config_template.json").read_text())
    raw["CLI_CLIENT_CONFIG"]["PI"] = {"CODEMODE_ENABLED": True, "LITELLM_MCP_ENABLED": "private-secret"}
    (tmp_path / "config.json").write_text(json.dumps(raw))
    monkeypatch.setattr(config_module, "BASE_DIR", tmp_path)
    get_settings.cache_clear()
    try:
        with pytest.raises(ConfigurationError, match="CLI_CLIENT_CONFIG.PI") as error:
            get_settings()
        assert "private-secret" not in str(error.value)
    finally:
        get_settings.cache_clear()
