"""Generate only application DDL from a NEW disposable database.

Never dump the populated shared database. An admin URL is explicitly required;
its database is used only to CREATE/DROP a uniquely named disposable database.
"""

import argparse
import asyncio
import os
import subprocess
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import asyncpg


async def generate(admin_url: str) -> str:
    name = f"dd_session_schema_{uuid4().hex}"
    dsn = urlunsplit(urlsplit(admin_url)._replace(path=f"/{name}"))
    admin = await asyncpg.connect(admin_url)
    try:
        await admin.execute(f'CREATE DATABASE "{name}"')
        # Apply the same migration chain as deployment, never a hard-coded single file.
        directory = Path(__file__).resolve().parents[1] / "db/migrations"
        env = {key: value for key, value in os.environ.items() if not key.startswith("DBMATE_")}
        env["DATABASE_URL"] = dsn
        await asyncio.to_thread(
            subprocess.run,
            ["dbmate", "--env-file", os.devnull, "--migrations-dir", str(directory), "--no-dump-schema", "migrate"],
            env=env,
            capture_output=True,
            text=True,
            check=True,
        )
        dump = await asyncio.to_thread(
            subprocess.run,
            [
                "pg_dump",
                "--dbname",
                dsn,
                "--schema-only",
                "--no-owner",
                "--no-privileges",
                '--table=public."META_HARNESS_sessions"',
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        lines = [line for line in dump.stdout.splitlines() if not line.startswith(("\\restrict", "\\unrestrict"))]
        return "-- Generated in isolation; no auth-service tables required.\n" + "\n".join(lines).rstrip() + "\n"
    finally:
        await admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        await admin.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--admin-url", required=True)
    options = parser.parse_args()
    print(asyncio.run(generate(options.admin_url)), end="")  # noqa: T201 - explicit schema generation CLI
