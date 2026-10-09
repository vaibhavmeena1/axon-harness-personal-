"""Exercise CI base selection with a fake Docker CLI; no registry access needed."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts/build-backend-image.sh"
PRIVATE_IMAGE = "831059512818.dkr.ecr.ap-south-1.amazonaws.com/python:wolfi-3.12.14-r8"
PUBLIC_IMAGE = "cgr.dev/chainguard/wolfi-base:latest"


@pytest.mark.parametrize("pull_status", [0, 1])
@pytest.mark.parametrize("build_status", [0, 7])
def test_ci_selects_pullable_base_and_preserves_build_failure(
    tmp_path: Path, pull_status: int, build_status: int
) -> None:
    log = tmp_path / "docker-commands.jsonl"
    docker = tmp_path / "docker"
    docker.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "with open(os.environ['DOCKER_LOG'], 'a') as log:\n"
        "    log.write(json.dumps(sys.argv[1:]) + '\\n')\n"
        "sys.exit(int(os.environ['PULL_STATUS' if sys.argv[1] == 'pull' else 'BUILD_STATUS']))\n"
    )
    docker.chmod(0o755)
    result = subprocess.run(
        ["sh", str(SCRIPT), "--build-arg", "SERVICE_NAME=backend", "--label", "description=with spaces"],
        cwd=tmp_path,
        env={
            **os.environ,
            "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
            "DOCKER_LOG": str(log),
            "PULL_STATUS": str(pull_status),
            "BUILD_STATUS": str(build_status),
        },
        capture_output=True,
        text=True,
    )
    commands = [json.loads(line) for line in log.read_text().splitlines()]
    assert commands == [
        ["pull", "--platform=linux/amd64", PRIVATE_IMAGE],
        [
            "build",
            "--file",
            str(ROOT / "Dockerfile"),
            "--build-arg",
            f"PYTHON_BASE_IMAGE={PRIVATE_IMAGE if pull_status == 0 else PUBLIC_IMAGE}",
            "--build-arg",
            "SERVICE_NAME=backend",
            "--label",
            "description=with spaces",
            str(ROOT),
        ],
    ]
    assert result.returncode == build_status
    assert ("falling back" in result.stderr) == (pull_status != 0)


def test_python_stages_share_base_without_dbmate() -> None:
    dockerfile = (ROOT / "Dockerfile").read_text()
    assert f"ARG PYTHON_BASE_IMAGE={PUBLIC_IMAGE}" in dockerfile
    for stage in ["builder", "runtime"]:
        assert f"FROM --platform=linux/amd64 ${{PYTHON_BASE_IMAGE}} AS {stage}" in dockerfile
    assert "dbmate" not in dockerfile.lower()
    assert dockerfile.count("if [ ! -x /usr/bin/python3.12 ]") == 2
