"""Generate only application DDL from a NEW disposable database and FK fixture.

Never dump the populated shared database. An admin URL is explicitly required;
its database is used only to CREATE/DROP a uniquely named disposable database.
"""

import argparse
import asyncio
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
        database = await asyncpg.connect(dsn)
        try:
            await database.execute("CREATE TABLE public.user_teams(id BIGINT PRIMARY KEY)")
            migration = Path(__file__).resolve().parents[1] / "db/migrations/20261002140000_create_sessions.sql"
            await database.execute(migration.read_text().split("-- migrate:down")[0])
        finally:
            await database.close()
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
        return (
            "-- Generated in isolation; requires existing public.user_teams(id BIGINT PRIMARY KEY).\n"
            + "\n".join(lines).rstrip()
            + "\n"
        )
    finally:
        await admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        await admin.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--admin-url", required=True)
    options = parser.parse_args()
    print(asyncio.run(generate(options.admin_url)), end="")  # noqa: T201 - explicit schema generation CLI
