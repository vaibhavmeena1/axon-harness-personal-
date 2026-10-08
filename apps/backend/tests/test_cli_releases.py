"""Release selection, secret-protected PUTs and CloudFront download URLs."""

import json
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import parse_qs, urlsplit

import pytest
from botocore.client import BaseClient
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.clients.cloudfront import CloudFrontUrlSigner
from app.clients.s3 import S3Client
from app.core import config as config_module
from app.core.config import CliReleaseAsset, CliReleaseSettings, ConfigurationError, get_settings
from app.core.s3 import S3ClientSettings, S3StorageSettings
from app.routers.cli_releases import router
from app.services import cli_releases
from app.services.cli_releases import CliReleaseService
from app.services.storage_dependencies import CLI_RELEASE_SERVICE_STATE_KEY

BACKEND_DIR = Path(__file__).resolve().parents[1]
VERSION = "0.2.0"
ARCHIVE_HASH = "a" * 64
BINARY_HASH = "b" * 64
KEY = f"cli/releases/{VERSION}/axon-darwin-arm64.gz"


def release_settings() -> CliReleaseSettings:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    return CliReleaseSettings(
        s3=S3StorageSettings("private-cli", S3ClientSettings("ap-south-1")),
        key_prefix="cli/releases/",
        upload_auth_key="test-secret-not-public-very-long-key",
        put_url_expiry_seconds=900,
        get_url_expiry_seconds=1800,
        distribution_url="https://cdn.example.test",
        key_pair_id="TEST_KEY",
        private_key=pem,
        latest_version=VERSION,
        versions={VERSION: CliReleaseAsset(KEY, ARCHIVE_HASH, BINARY_HASH)},
    )


def client_for(settings: CliReleaseSettings | None, sdk_client: BaseClient | None = None) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_settings] = lambda: SimpleNamespace(cli_releases=settings)
    if settings is not None:
        service = CliReleaseService(
            settings,
            S3Client(settings.s3.client, client=sdk_client if sdk_client is not None else Mock()),
            CloudFrontUrlSigner(settings.distribution_url, settings.key_pair_id, settings.private_key),
        )
        setattr(app.state, CLI_RELEASE_SERVICE_STATE_KEY, service)
    return TestClient(app, follow_redirects=False)


def test_disabled_release_service_fails_closed() -> None:
    client = client_for(None)
    assert client.get("/api/v1/cli/releases/latest").status_code == 503
    assert client.post("/api/v1/cli/releases/uploads/presign", json={"version": VERSION}).status_code == 503


def test_public_exact_version_download_and_checksums() -> None:
    client = client_for(release_settings())
    root = "/api/v1/cli/releases"
    latest = client.get(f"{root}/latest")
    assert latest.json() == {"version": VERSION}
    assert latest.headers["cache-control"] == "no-store"
    assert client.get(f"{root}/latest/VERSION").text == f"{VERSION}\n"
    checksums = client.get(f"{root}/{VERSION}/checksums.txt")
    assert checksums.text == (f"{ARCHIVE_HASH}  axon-darwin-arm64.gz\n{BINARY_HASH}  axon-darwin-arm64\n")
    redirect = client.get(f"{root}/{VERSION}/axon-darwin-arm64.gz")
    assert redirect.status_code == 302
    assert redirect.headers["cache-control"] == "no-store"
    assert redirect.headers["location"].startswith(f"https://cdn.example.test/{KEY}?")
    assert "Signature=" in redirect.headers["location"]
    assert "Key-Pair-Id=TEST_KEY" in redirect.headers["location"]
    assert client.get(f"{root}/0.1.0/axon-darwin-arm64.gz").status_code == 404
    assert client.get(f"{root}/0.1.0/checksums.txt").status_code == 404


def test_first_release_can_be_staged_without_publishing_latest() -> None:
    client = client_for(replace(release_settings(), latest_version=""))
    assert client.get("/api/v1/cli/releases/latest").status_code == 503
    assert client.get("/api/v1/cli/releases/latest/VERSION").status_code == 503
    assert client.get(f"/api/v1/cli/releases/{VERSION}/checksums.txt").status_code == 200


def test_upload_requires_secret_and_only_configured_version() -> None:
    settings = release_settings()
    seen = []

    def sign(method: str, *, Params: dict, ExpiresIn: int, HttpMethod: str) -> str:  # noqa: N803
        seen.append((method, Params, ExpiresIn, HttpMethod))
        return "https://s3.example.test/signed-upload"

    sdk = Mock(generate_presigned_url=sign)
    client = client_for(settings, sdk)
    root = "/api/v1/cli/releases/uploads/presign"
    assert client.post(root, json={"version": VERSION}).status_code == 401
    assert (
        client.post(root, headers={"Authorization": "Bearer incorrect"}, json={"version": VERSION}).status_code == 401
    )
    assert (
        client.post(
            root, headers={"Authorization": "Bearer test-secret-not-public-very-long-key"}, json={"version": "0.3.0"}
        ).status_code
        == 404
    )
    assert seen == []
    response = client.post(
        root, headers={"Authorization": "Bearer test-secret-not-public-very-long-key"}, json={"version": VERSION}
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["url"] == "https://s3.example.test/signed-upload"
    assert body["headers"]["If-None-Match"] == "*"
    assert body["headers"]["Cache-Control"] == cli_releases.IMMUTABLE_CACHE_CONTROL
    assert seen[0][0] == "put_object"
    assert seen[0][1]["Key"] == KEY
    assert seen[0][1]["ChecksumSHA256"] == body["headers"]["x-amz-checksum-sha256"]
    assert seen[0][2:] == (900, "PUT")
    service = getattr(client.app.state, CLI_RELEASE_SERVICE_STATE_KEY)
    assert service.presign_s3_get(settings.versions[VERSION]) == "https://s3.example.test/signed-upload"
    assert seen[-1][0] == "get_object"


def test_real_s3_put_signing_includes_immutability_and_checksum(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "local-test-key")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "local-test-secret")
    monkeypatch.setenv("AWS_EC2_METADATA_DISABLED", "true")
    release = release_settings()
    with S3Client(release.s3.client) as s3:
        service = CliReleaseService(
            release, s3, CloudFrontUrlSigner(release.distribution_url, release.key_pair_id, release.private_key)
        )
        url, headers = service.presign_s3_put(release.versions[VERSION])
    signed = parse_qs(urlsplit(url).query)["X-Amz-SignedHeaders"][0].split(";")
    assert "cache-control" in signed
    assert "content-type" in signed
    assert "if-none-match" in signed
    assert "x-amz-checksum-sha256" in signed
    assert headers["If-None-Match"] == "*"


def test_enabled_release_settings_load_from_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    release = release_settings()
    config = json.loads((BACKEND_DIR / "config_template.json").read_text(encoding="utf-8"))
    config["CLI_RELEASES"].update(
        {
            "ENABLED": True,
            "S3": {"BUCKET": release.s3.bucket, "REGION": release.s3.client.region},
            "UPLOAD_AUTH_KEY": release.upload_auth_key,
            "LATEST_VERSION": VERSION,
            "CLOUDFRONT": {
                "DISTRIBUTION_URL": release.distribution_url,
                "KEY_PAIR_ID": release.key_pair_id,
                "PRIVATE_KEY": release.private_key,
            },
            "VERSIONS": {
                VERSION: {
                    "s3_key": KEY,
                    "archive_sha256": ARCHIVE_HASH,
                    "binary_sha256": BINARY_HASH,
                }
            },
        }
    )
    (tmp_path / "config.json").write_text(json.dumps(config), encoding="utf-8")
    monkeypatch.setattr(config_module, "BASE_DIR", tmp_path)
    get_settings.cache_clear()
    try:
        loaded = get_settings().cli_releases
        assert loaded is not None
        assert loaded.latest_version == release.latest_version
        assert loaded.versions == release.versions
        assert loaded.private_key == release.private_key.strip()
    finally:
        get_settings.cache_clear()


@pytest.mark.parametrize(
    "change",
    [
        {"LATEST_VERSION": "0.3.0"},
        {
            "VERSIONS": {
                VERSION: {
                    "s3_key": "../../evil/axon-darwin-arm64.gz",
                    "archive_sha256": ARCHIVE_HASH,
                    "binary_sha256": BINARY_HASH,
                }
            }
        },
        {"VERSIONS": {VERSION: {"s3_key": KEY, "archive_sha256": "not-a-hash", "binary_sha256": BINARY_HASH}}},
    ],
)
def test_rejects_unsafe_release_config(change: dict, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = json.loads((BACKEND_DIR / "config_template.json").read_text(encoding="utf-8"))
    config["CLI_RELEASES"].update(
        {
            "ENABLED": True,
            "S3": {"BUCKET": "private-cli", "REGION": "ap-south-1"},
            "UPLOAD_AUTH_KEY": "secret",
            "LATEST_VERSION": VERSION,
            "CLOUDFRONT": {
                "DISTRIBUTION_URL": "https://cdn.example.test",
                "KEY_PAIR_ID": "KEY",
                "PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----",
            },
            "VERSIONS": {VERSION: {"s3_key": KEY, "archive_sha256": ARCHIVE_HASH, "binary_sha256": BINARY_HASH}},
        }
    )
    config["CLI_RELEASES"].update(change)
    (tmp_path / "config.json").write_text(json.dumps(config), encoding="utf-8")
    monkeypatch.setattr(config_module, "BASE_DIR", tmp_path)
    get_settings.cache_clear()
    try:
        with pytest.raises(ConfigurationError, match="config.CLI_RELEASES"):
            get_settings()
    finally:
        get_settings.cache_clear()
