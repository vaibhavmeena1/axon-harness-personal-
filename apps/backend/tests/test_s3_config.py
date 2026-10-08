"""Shared S3 config validation and feature-specific defaults, without credentials/network."""

import json
from dataclasses import asdict
from pathlib import Path

import pytest

from app.core.config import ConfigurationError, _cli_releases
from app.core.s3 import parse_s3_storage
from app.core.session_storage import parse_session_storage


def valid_s3() -> dict:
    return {"BUCKET": "private-test", "REGION": "ap-south-1"}


@pytest.mark.parametrize(
    "config", [{}, {"SESSION_BACKUPS": None}, {"SESSION_BACKUPS": {}}, {"SESSION_BACKUPS": {"ENABLED": False}}]
)
def test_backup_policy_defaults_off(config: dict) -> None:
    assert parse_session_storage(config) is None


def test_only_nested_backend_config_enables_backups() -> None:
    assert parse_session_storage({"SESSION_BACKUPS": {"ENABLED": True, "S3": valid_s3()}}) is not None
    assert parse_session_storage({"AXON_SESSION_BACKUPS_ENABLED": True, "SESSION_BACKUPS": {"ENABLED": False}}) is None
    assert parse_session_storage({"AXON_SESSION_BACKUPS_ENABLED": True}) is None


@pytest.mark.parametrize("flag", [None, "true", "false", "1", "0", "", 0, 1, [], {}])
def test_invalid_backup_config_fails_closed(flag: object) -> None:
    with pytest.raises(ValueError, match=r"SESSION_BACKUPS\.ENABLED must be a boolean"):
        parse_session_storage({"SESSION_BACKUPS": {"ENABLED": flag, "S3": valid_s3()}})


@pytest.mark.parametrize("env_flag", ["true", "false", "1", "0", "invalid"])
def test_backup_policy_ignores_environment(env_flag: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AXON_SESSION_BACKUPS_ENABLED", env_flag)
    assert parse_session_storage({"SESSION_BACKUPS": {"S3": valid_s3()}}) is None
    assert parse_session_storage({"SESSION_BACKUPS": {"ENABLED": True, "S3": valid_s3()}}) is not None


def test_enabled_backups_require_storage_configuration() -> None:
    with pytest.raises(ValueError, match=r"SESSION_BACKUPS\.S3"):
        parse_session_storage({"SESSION_BACKUPS": {"ENABLED": True}})


def test_default_chain_and_independent_feature_defaults() -> None:
    release = parse_s3_storage(valid_s3(), "config.CLI_RELEASES.S3")
    backups = parse_session_storage({"SESSION_BACKUPS": {"ENABLED": True, "S3": valid_s3()}})
    assert backups is not None
    assert release.client.access_key_id is None
    assert release.client.secret_access_key is None
    assert release.client.session_token is None
    assert release.client.endpoint_url is None
    assert release.client.connect_timeout == 60
    assert release.client.read_timeout == 60
    assert release.client.max_retries is None
    assert backups.s3.client.connect_timeout == 5
    assert backups.s3.client.read_timeout == 10
    assert backups.s3.client.max_retries == 1
    assert backups.require_create_only_policy is True


def test_explicit_connection_options_and_credentials() -> None:
    settings = parse_s3_storage(
        {
            **valid_s3(),
            "ENDPOINT_URL": "https://objects.example.test:8443/",
            "CONNECT_TIMEOUT_SECONDS": 3,
            "READ_TIMEOUT_SECONDS": 12,
            "MAX_RETRIES": 0,
            "CREDENTIALS": {
                "ACCESS_KEY_ID": "secret-id",
                "SECRET_ACCESS_KEY": "secret-key",
                "SESSION_TOKEN": "secret-token",
            },
        },
        "config.SESSION_BACKUPS.S3",
    )
    assert settings.client.endpoint_url == "https://objects.example.test:8443"
    assert settings.client.max_retries == 0
    assert settings.client.connect_timeout == 3
    assert settings.client.read_timeout == 12
    assert settings.client.session_token == "secret-token"
    assert "secret" not in repr(settings)


@pytest.mark.parametrize("field", ["CONNECT_TIMEOUT_SECONDS", "READ_TIMEOUT_SECONDS"])
@pytest.mark.parametrize("value", [None, True, 0, -1, 301, "5", 1.5])
def test_timeout_validation(field: str, value: object) -> None:
    with pytest.raises(ValueError, match=field):
        parse_s3_storage({**valid_s3(), field: value}, "config.S3")


@pytest.mark.parametrize("value", [True, -1, 11, "1", 1.5])
def test_retry_validation(value: object) -> None:
    with pytest.raises(ValueError, match="MAX_RETRIES"):
        parse_s3_storage({**valid_s3(), "MAX_RETRIES": value}, "config.S3")


@pytest.mark.parametrize("value", [None, 0, 1, 10])
def test_valid_retry_options(value: int | None) -> None:
    assert parse_s3_storage({**valid_s3(), "MAX_RETRIES": value}, "config.S3").client.max_retries == value


@pytest.mark.parametrize(
    "credentials",
    [
        None,
        [],
        {"ACCESS_KEY_ID": "secret-id"},
        {"SECRET_ACCESS_KEY": "secret-key"},
        {"SESSION_TOKEN": "secret-token"},
        {"ACCESS_KEY_ID": "", "SECRET_ACCESS_KEY": ""},
        {"ACCESS_KEY_ID": True, "SECRET_ACCESS_KEY": "secret-key"},
        {"ACCESS_KEY_ID": "secret-id", "SECRET_ACCESS_KEY": " "},
        {"MISSPELLED_KEY": "secret-value"},
    ],
)
def test_bad_credentials_do_not_echo_secrets(credentials: object) -> None:
    with pytest.raises(ValueError) as caught:
        parse_s3_storage({**valid_s3(), "CREDENTIALS": credentials}, "config.S3")
    assert "CREDENTIALS" in str(caught.value)
    assert all(value not in str(caught.value) for value in ("secret-id", "secret-key", "secret-token", "secret-value"))


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://objects.example.test",
        "https://user:secret-key@objects.example.test",
        "https://objects.example.test/path",
        "https://objects.example.test?secret-key",
        "https://objects.example.test#secret-key",
        "https://objects.example.test:0",
        "https://objects.example.test:99999",
        "https://objects.example.test:bad",
        "https://objects.example.test/\\path",
        "https://objects.example.test/\n",
        "",
        123,
    ],
)
def test_bad_endpoints_are_sanitized(endpoint: object) -> None:
    with pytest.raises(ValueError) as caught:
        parse_s3_storage({**valid_s3(), "ENDPOINT_URL": endpoint}, "config.S3")
    assert "ENDPOINT_URL" in str(caught.value)
    assert "secret" not in str(caught.value)


@pytest.mark.parametrize(
    "raw",
    [
        None,
        [],
        {},
        {"BUCKET": "private-test"},
        {"REGION": "ap-south-1"},
        {"BUCKET": "bad/name", "REGION": "ap-south-1"},
        {**valid_s3(), "REGION": True},
        {**valid_s3(), "MAX_RETRY": 2},
    ],
)
def test_invalid_s3_blocks_and_misspelled_fields(raw: object) -> None:
    with pytest.raises(ValueError):
        parse_s3_storage(raw, "config.S3")


@pytest.mark.parametrize("config", [False, [], "invalid", 1])
def test_session_section_requires_an_object(config: object) -> None:
    with pytest.raises(ValueError):
        parse_session_storage({"SESSION_BACKUPS": config})


def test_disabled_storage_does_not_require_placeholder_configuration() -> None:
    assert parse_session_storage({"SESSION_BACKUPS": {"ENABLED": False, "S3": None}}) is None
    assert _cli_releases({"CLI_RELEASES": {"ENABLED": False, "S3": None}}) is None


@pytest.mark.parametrize("prefix", ["/sessions/", "sessions//", "sessions/../", "sessions/./", "sessions"])
def test_invalid_session_prefixes(prefix: str) -> None:
    with pytest.raises(ValueError, match="prefix"):
        parse_session_storage({"SESSION_BACKUPS": {"ENABLED": True, "S3": valid_s3(), "KEY_PREFIX": prefix}})


def test_template_uses_one_s3_shape_with_feature_specific_defaults() -> None:
    template = json.loads((Path(__file__).resolve().parents[1] / "config_template.json").read_text())
    release = template["CLI_RELEASES"]["S3"]
    session = template["SESSION_BACKUPS"]["S3"]
    assert release.keys() == session.keys()
    assert release["CREDENTIALS"] == session["CREDENTIALS"] == {}
    assert template["CLI_RELEASES"]["ENABLED"] is False
    assert "AXON_SESSION_BACKUPS_ENABLED" not in template
    assert template["SESSION_BACKUPS"]["ENABLED"] is False
    for block, kwargs in [(release, {}), (session, {"connect_timeout": 5, "read_timeout": 10, "max_retries": 1})]:
        configured = parse_s3_storage({**block, "BUCKET": "private-test"}, "S3", **kwargs)
        defaults = parse_s3_storage(valid_s3(), "S3", **kwargs)
        assert asdict(configured) == asdict(defaults)


def test_release_configuration_repr_hides_private_credentials() -> None:
    from tests.test_cli_releases import release_settings

    settings = release_settings()
    assert settings.upload_auth_key not in repr(settings)
    assert settings.private_key not in repr(settings)


def test_release_configuration_error_wraps_shared_s3_validation() -> None:
    from tests.test_cli_releases import release_settings

    settings = release_settings()
    raw = json.loads((Path(__file__).resolve().parents[1] / "config_template.json").read_text())
    raw["CLI_RELEASES"].update(
        {
            "ENABLED": True,
            "UPLOAD_AUTH_KEY": settings.upload_auth_key,
            "CLOUDFRONT": {
                "DISTRIBUTION_URL": settings.distribution_url,
                "KEY_PAIR_ID": settings.key_pair_id,
                "PRIVATE_KEY": settings.private_key,
            },
            "S3": {**valid_s3(), "CREDENTIALS": {"ACCESS_KEY_ID": "secret-key"}},
        }
    )
    with pytest.raises(ConfigurationError, match="config.CLI_RELEASES.S3.CREDENTIALS") as caught:
        _cli_releases(raw)
    assert "secret-key" not in str(caught.value)
