"""Run reviewed SQL migrations with asyncpg, without an external binary."""

import argparse
import asyncio
import re
from dataclasses import dataclass
from pathlib import Path

import asyncpg

from app.core.config import DATABASE_TABLE_PREFIX, get_settings

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIRECTORY = PROJECT_ROOT / "db" / "migrations"
MIGRATIONS_TABLE = f"{DATABASE_TABLE_PREFIX}schema_migrations"
LEDGER = f'public."{MIGRATIONS_TABLE}"'


@dataclass(frozen=True)
class Migration:
    version: str
    up: str
    down: str


def load_migrations(directory: Path) -> list[Migration]:
    """Read the existing up/down SQL format; reject malformed migrations."""
    migrations = []
    versions: set[str] = set()
    for path in directory.glob("*.sql"):
        match = re.fullmatch(r"([0-9]+)_.+\.sql", path.name)
        if match is None:
            raise ValueError(f"Invalid migration filename: {path.name}")
        version = match[1]
        sql = path.read_text(encoding="utf-8")
        parts = re.split(r"^-- migrate:(up|down)\s*$", sql, flags=re.MULTILINE)
        if len(parts) != 5 or parts[0].strip() or parts[1] != "up" or parts[3] != "down":
            raise ValueError(f"Expected one up and one down section: {path.name}")
        if not parts[2].strip() or not parts[4].strip():
            raise ValueError(f"Empty migration section: {path.name}")
        if version in versions:
            raise ValueError(f"Duplicate migration version: {version}")
        versions.add(version)
        migrations.append(Migration(version, parts[2], parts[4]))
    return sorted(migrations, key=lambda migration: int(migration.version))


async def run_migrations(
    connection: asyncpg.Connection,
    directory: Path = MIGRATIONS_DIRECTORY,
    operation: str = "up",
) -> None:
    """Serialize runners and atomically update each migration and its ledger."""
    if operation not in {"up", "down"}:
        raise ValueError("Migration operation must be up or down")
    migrations = load_migrations(directory)
    # A session lock spans the per-migration transactions and is released even
    # on SQL failure. Closing the connection also releases it after a crash.
    await connection.execute("SELECT pg_advisory_lock(hashtext($1)::bigint)", LEDGER)
    try:
        await connection.execute(f"CREATE TABLE IF NOT EXISTS {LEDGER} (version VARCHAR(255) PRIMARY KEY)")
        applied = {row["version"] for row in await connection.fetch(f"SELECT version FROM {LEDGER}")}
        missing = applied - {migration.version for migration in migrations}
        if missing:
            raise RuntimeError(f"Applied migrations missing from repository: {', '.join(sorted(missing))}")
        if operation == "up":
            pending = [migration for migration in migrations if migration.version not in applied]
        else:
            pending = [migration for migration in reversed(migrations) if migration.version in applied][:1]
        for migration in pending:
            async with connection.transaction():
                # Transaction-local: SQL owns only the application's public tables.
                await connection.execute("SET LOCAL search_path TO public")
                await connection.execute(migration.up if operation == "up" else migration.down)
                if operation == "up":
                    await connection.execute(f"INSERT INTO {LEDGER} (version) VALUES ($1)", migration.version)
                else:
                    await connection.execute(f"DELETE FROM {LEDGER} WHERE version = $1", migration.version)
    finally:
        await connection.execute("SELECT pg_advisory_unlock(hashtext($1)::bigint)", LEDGER)


async def _run(operation: str) -> None:
    database = get_settings().database
    connection = await asyncpg.connect(
        database=database.name,
        host=database.host,
        port=database.port,
        user=database.user,
        password=database.password,
    )
    try:
        await run_migrations(connection, operation=operation)
    finally:
        await connection.close()


def main() -> None:
    """Use config.json; never dump unrelated schemas from the shared database."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("up", "down"), nargs="?", default="up")
    asyncio.run(_run(parser.parse_args().operation))


if __name__ == "__main__":
    main()
