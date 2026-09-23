"""Run database migrations once using the repository-owned JSON settings."""

import os
import shutil
import subprocess
from pathlib import Path

from app.core.config import DATABASE_TABLE_PREFIX, get_settings

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIRECTORY = PROJECT_ROOT / "db" / "migrations"
MIGRATIONS_TABLE = f"{DATABASE_TABLE_PREFIX}schema_migrations"
SCHEMA_FILE = PROJECT_ROOT / "db" / "schema.sql"


def _database_url() -> str:
    """Build dbmate's PostgreSQL URL from the validated application settings."""
    return get_settings().database.dbmate_url()


def main() -> None:
    """Execute all pending migrations in a dedicated deployment process."""
    dbmate = shutil.which("dbmate")
    if dbmate is None:
        raise RuntimeError("dbmate executable is not available")

    environment = os.environ.copy()
    environment["DATABASE_URL"] = _database_url()
    subprocess.run(
        [
            dbmate,
            "--migrations-dir",
            str(MIGRATIONS_DIRECTORY),
            "--migrations-table",
            MIGRATIONS_TABLE,
            "--schema-file",
            str(SCHEMA_FILE),
            "up",
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        check=True,
    )


if __name__ == "__main__":
    main()
