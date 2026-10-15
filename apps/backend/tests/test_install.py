"""Public installer delivery and release URL configuration."""

import json
import shlex
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core import config as config_module
from app.core.config import CliInstallSettings, ConfigurationError, get_settings
from app.routers import ROUTERS
from app.routers.install import DEFAULT_RELEASES_LINE, INSTALLER_TEMPLATE
from app.web.static import SinglePageApplication

BACKEND_DIR = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize(
    "releases_url",
    [
        "https://downloads.example.test/cli/$channel/releases",
        "https://deputydev.ai/axon/api/v1/cli/releases",
    ],
)
def test_install_script_is_public_and_precedes_frontend(tmp_path: Path, releases_url: str) -> None:
    """Match the application's registration order, including the SPA catch-all."""
    (tmp_path / "index.html").write_text("<html>console</html>", encoding="utf-8")
    app = FastAPI()
    for router in ROUTERS:
        app.include_router(router)
    app.mount("/", SinglePageApplication(directory=tmp_path), name="console")

    app.dependency_overrides[get_settings] = lambda: SimpleNamespace(
        cli_install=CliInstallSettings(releases_url=releases_url)
    )
    client = TestClient(app)

    response = client.get("/install.sh")  # No Authorization header.

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/x-shell")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.text == INSTALLER_TEMPLATE.replace(
        DEFAULT_RELEASES_LINE,
        f"DEFAULT_RELEASES_URL={shlex.quote(releases_url)}",
    )
    assert response.text.startswith("#!/bin/sh")
    assert subprocess.run(["/bin/sh", "-n"], input=response.text, text=True, check=False).returncode == 0

    # The variable is quoted even if the configured URL contains shell metacharacters.
    default_line = next(line for line in response.text.splitlines() if line.startswith("DEFAULT_RELEASES_URL="))
    result = subprocess.run(
        ["/bin/sh", "-c", f'{default_line}\nprintf "%s" "$DEFAULT_RELEASES_URL"'],
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout == releases_url
    assert client.get("/other-console-page").text == "<html>console</html>"


def test_backend_loads_install_config_from_template(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = json.loads((BACKEND_DIR / "config_template.json").read_text(encoding="utf-8"))
    (tmp_path / "config.json").write_text(json.dumps(config), encoding="utf-8")
    monkeypatch.setattr(config_module, "BASE_DIR", tmp_path)
    get_settings.cache_clear()
    try:
        assert get_settings().cli_install.releases_url == "https://YOUR_ORIGIN/api/v1/cli/releases"
    finally:
        get_settings.cache_clear()


@pytest.mark.parametrize(
    "url",
    [
        "http://example.test/releases",
        "https://example.test/releases/",
        "https://user:password@example.test/releases",
        "https://example.test/releases?asset=other",
        "https://example.test/releases#other",
        "https://example.test/releases\nINJECT=1",
        "https://[invalid/releases",
    ],
)
def test_backend_rejects_unsafe_release_urls(url: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = json.loads((BACKEND_DIR / "config_template.json").read_text(encoding="utf-8"))
    config["CLI_INSTALL"]["RELEASES_URL"] = url
    (tmp_path / "config.json").write_text(json.dumps(config), encoding="utf-8")
    monkeypatch.setattr(config_module, "BASE_DIR", tmp_path)
    get_settings.cache_clear()
    try:
        with pytest.raises(ConfigurationError, match=r"config\.CLI_INSTALL\.RELEASES_URL"):
            get_settings()
    finally:
        get_settings.cache_clear()
