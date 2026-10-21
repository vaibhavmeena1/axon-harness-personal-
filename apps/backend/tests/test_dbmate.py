"""Exercise the deployment's thin dbmate wrapper without connecting to a database."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
SCRIPT = BACKEND / "deployment/run_migrations.sh"


@pytest.mark.parametrize("args", [[], ["up"], ["down"], ["status"]])
@pytest.mark.parametrize("exit_code", [0, 7])
def test_wrapper_invokes_dbmate_and_propagates_failure(tmp_path: Path, args: list[str], exit_code: int) -> None:
    log = tmp_path / "dbmate.json"
    binary = tmp_path / "dbmate"
    binary.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "with open(os.environ['DBMATE_TEST_LOG'], 'w') as log:\n"
        "    json.dump({'args': sys.argv[1:], 'url': os.environ['DATABASE_URL']}, log)\n"
        "sys.exit(int(os.environ['DBMATE_TEST_EXIT']))\n"
    )
    binary.chmod(0o755)
    url = "postgresql://test@localhost/disposable"
    result = subprocess.run(
        ["sh", str(SCRIPT), *args],
        cwd=tmp_path,
        env={
            **os.environ,
            "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
            "DATABASE_URL": url,
            "DBMATE_TEST_LOG": str(log),
            "DBMATE_TEST_EXIT": str(exit_code),
        },
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert result.returncode == exit_code
    assert json.loads(log.read_text()) == {
        "args": ["--migrations-dir", str(BACKEND / "db/migrations"), "--no-dump-schema", *(args or ["migrate"])],
        "url": url,
    }
    assert not (tmp_path / "db/schema.sql").exists()


@pytest.mark.parametrize("url", [None, ""])
def test_wrapper_requires_an_explicit_database_url(tmp_path: Path, url: str | None) -> None:
    env = {key: value for key, value in os.environ.items() if key != "DATABASE_URL"}
    if url is not None:
        env["DATABASE_URL"] = url
    result = subprocess.run(["sh", str(SCRIPT)], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=5)
    assert result.returncode != 0
    assert "Set DATABASE_URL to the intended PostgreSQL database" in result.stderr
    assert list(tmp_path.iterdir()) == []


def test_repository_migration_uses_dbmate_sections() -> None:
    sql = (BACKEND / "db/migrations/20261002140000_create_sessions.sql").read_text()
    up, down = sql.split("-- migrate:down")
    assert up.startswith("-- migrate:up\n")
    assert 'CREATE TABLE "META_HARNESS_sessions"' in up
    assert "owner_user_id BIGINT NOT NULL" in up
    assert 'DROP TABLE "META_HARNESS_sessions"' in down
    assert "Clean up session objects and pending reservations before rolling back" in down
    assert "schema_migrations" not in sql


def test_dockerfile_copies_the_deployment_wrapper() -> None:
    dockerfile = (BACKEND.parents[1] / "Dockerfile").read_text()
    assert "WORKDIR /home/ubuntu/1mg/axon-backend" in dockerfile
    assert "COPY --chown=1001:1001 apps/backend/ ." in dockerfile
    assert "RUN chmod +x deployment/*.sh" in dockerfile
    assert SCRIPT.is_file()
    assert not (BACKEND / "dbmate.py").exists()
