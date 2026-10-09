"""Validate reviewed migration files before connecting to the database."""

from pathlib import Path

import pytest

from deployment.run_migrations import MIGRATIONS_DIRECTORY, load_migrations

SQL = "-- migrate:up\nSELECT 1;\n-- migrate:down\nSELECT 2;\n"


def test_load_repository_migration() -> None:
    migrations = load_migrations(MIGRATIONS_DIRECTORY)
    assert len(migrations) == 1
    assert migrations[0].version == "20261002140000"
    assert 'CREATE TABLE "META_HARNESS_sessions"' in migrations[0].up
    assert 'DROP TABLE "META_HARNESS_sessions"' in migrations[0].down


def test_load_migrations_in_numeric_order(tmp_path: Path) -> None:
    for version in ["10", "2", "1"]:
        (tmp_path / f"{version}_test.sql").write_text(SQL)
    assert [migration.version for migration in load_migrations(tmp_path)] == ["1", "2", "10"]


@pytest.mark.parametrize(
    "filename,sql,message",
    [
        ("invalid.sql", SQL, "Invalid migration filename"),
        ("1_test.sql", "SELECT 1;", "Expected one up and one down section"),
        ("1_test.sql", SQL + "-- migrate:up\nSELECT 3;\n", "Expected one up and one down section"),
        ("1_test.sql", "-- migrate:up\n-- migrate:down\nSELECT 2;", "Empty migration section"),
    ],
)
def test_reject_malformed_migration(tmp_path: Path, filename: str, sql: str, message: str) -> None:
    (tmp_path / filename).write_text(sql)
    with pytest.raises(ValueError, match=message):
        load_migrations(tmp_path)


def test_reject_duplicate_versions(tmp_path: Path) -> None:
    (tmp_path / "1_first.sql").write_text(SQL)
    (tmp_path / "1_second.sql").write_text(SQL)
    with pytest.raises(ValueError, match="Duplicate migration version"):
        load_migrations(tmp_path)
