"""Opt-in/local disposable Postgres integration; never reads application DB settings."""

import asyncio
import io
import os
from collections.abc import Iterator
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID, uuid4

import asyncpg
import pytest
from fastapi import HTTPException
from tortoise import Tortoise

from app.core.s3 import S3ClientSettings, S3StorageSettings
from app.core.session_storage import SessionStorageSettings
from app.models.session_backup import SessionBackup
from app.services.sessions.adapters import Adapter, InvalidSessionError
from app.services.sessions.contracts import Registration, Snapshot, UploadRequest
from app.services.sessions.integrity import verify_chunks
from app.services.sessions.service import BackupService, now
from deployment.run_migrations import LEDGER, run_migrations
from tests.test_session_backups import declaration, named_payload, payload

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/20261002140000_create_sessions.sql"
UP, DOWN = MIGRATION.read_text().split("-- migrate:down")


@pytest.fixture
def disposable_db() -> Iterator[str]:
    admin = os.environ.get("SESSION_TEST_POSTGRES_URL", "postgresql://localhost/postgres")
    name = f"dd_session_test_{uuid4().hex}"
    parsed = urlsplit(admin)
    dsn = urlunsplit(parsed._replace(path=f"/{name}"))

    async def setup() -> None:
        connection = await asyncpg.connect(admin, timeout=3)
        try:
            await connection.execute(f'CREATE DATABASE "{name}"')
        finally:
            await connection.close()
        db = await asyncpg.connect(dsn)
        try:
            await db.execute(
                "CREATE TABLE public.user_teams(id BIGINT PRIMARY KEY); INSERT INTO user_teams VALUES (1),(2); CREATE TABLE public.schema_migrations(version TEXT PRIMARY KEY); INSERT INTO schema_migrations VALUES ('legacy-sentinel'); CREATE TABLE session_chats(id BIGINT); INSERT INTO session_chats VALUES (99);"
            )
        finally:
            await db.close()

    try:
        asyncio.run(setup())
    except (OSError, asyncpg.PostgresError):
        pytest.skip("Disposable Postgres unavailable; configure SESSION_TEST_POSTGRES_URL")
    yield dsn

    async def cleanup() -> None:
        connection = await asyncpg.connect(admin)
        try:
            await connection.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        finally:
            await connection.close()

    asyncio.run(cleanup())


class MemoryStore:
    settings = SessionStorageSettings(S3StorageSettings("synthetic", S3ClientSettings("ap-south-1")))

    def __init__(self) -> None:
        self.data = {}
        self.delete_fails = False

    def put_url(self, key: str, snapshot: Snapshot) -> dict:
        return {"url": key, "headers": {"If-None-Match": "*"}}

    def get_url(self, key: str) -> str:
        return key

    def validate(self, key: str, snapshot: Snapshot, adapter: Adapter, native_id: str | None) -> None:
        output = io.BytesIO()
        verify_chunks(iter([self.data[key][0]]), snapshot, output)
        if adapter.validate(output, native_id, snapshot.resume_metadata) != snapshot.display_name:
            raise InvalidSessionError("Display name does not match session archive")

    def delete(self, key: str) -> None:
        if self.delete_fails:
            raise RuntimeError("synthetic delete failure")
        self.data.pop(key, None)

    def objects(self) -> Iterator[tuple[str, datetime]]:
        return iter([(key, value[1]) for key, value in self.data.items()])


def test_migration_exact_fk_constraints_and_legacy_safety(disposable_db: str) -> None:
    async def test() -> None:
        db = await asyncpg.connect(disposable_db)
        try:
            await db.execute(UP)
            assert await db.fetchval("SELECT count(*) FROM schema_migrations WHERE version='legacy-sentinel'") == 1
            assert await db.fetchval("SELECT id FROM session_chats") == 99
            assert (
                await db.fetchval(
                    "SELECT confrelid::regclass::text FROM pg_constraint WHERE conname='META_HARNESS_sessions_owner_fk'"
                )
                == "user_teams"
            )
            names = await db.fetch(
                "SELECT conname FROM pg_constraint WHERE conrelid='\"META_HARNESS_sessions\"'::regclass"
            )
            assert all(row["conname"].startswith("META_HARNESS_") and len(row["conname"]) <= 63 for row in names)
            await db.execute(DOWN)
            await db.execute(UP)
            assert await db.fetchval("SELECT id FROM session_chats") == 99
            await db.execute('DROP TABLE "META_HARNESS_sessions"; DROP TABLE user_teams')
            with pytest.raises(asyncpg.RaiseError, match="require existing public.user_teams"):
                await db.execute(UP)
        finally:
            await db.close()

    asyncio.run(test())


def test_python_migrations_separate_ledger_up_down_up(disposable_db: str) -> None:
    async def check() -> None:
        db = await asyncpg.connect(disposable_db)
        try:
            for operation in ["up", "up", "down", "up"]:
                await run_migrations(db, operation=operation)
                assert await db.fetchval(f"SELECT count(*) FROM {LEDGER}") == (0 if operation == "down" else 1)
            assert await db.fetchval("SELECT version FROM schema_migrations") == "legacy-sentinel"
            assert await db.fetchval("SELECT id FROM session_chats") == 99
        finally:
            await db.close()

    asyncio.run(check())


def test_python_migration_failure_rolls_back_and_releases_lock(disposable_db: str, tmp_path: Path) -> None:
    migration = tmp_path / "20261002140000_failure.sql"
    migration.write_text(
        "-- migrate:up\nCREATE TABLE migration_failure (id INT); SELECT 1/0;\n"
        "-- migrate:down\nDROP TABLE migration_failure;\n"
    )

    async def check() -> None:
        db = await asyncpg.connect(disposable_db)
        other = await asyncpg.connect(disposable_db)
        try:
            with pytest.raises(asyncpg.DivisionByZeroError):
                await run_migrations(db, tmp_path)
            assert await db.fetchval("SELECT to_regclass('public.migration_failure')") is None
            assert await db.fetchval(f"SELECT count(*) FROM {LEDGER}") == 0
            # A different connection must be able to acquire the released lock.
            await asyncio.wait_for(run_migrations(other), timeout=5)
            assert await db.fetchval(f"SELECT count(*) FROM {LEDGER}") == 1
        finally:
            await db.close()
            await other.close()

    asyncio.run(check())


def test_python_migrations_serialize_concurrent_runners(disposable_db: str) -> None:
    async def check() -> None:
        first = await asyncpg.connect(disposable_db)
        second = await asyncpg.connect(disposable_db)
        try:
            await asyncio.wait_for(asyncio.gather(run_migrations(first), run_migrations(second)), timeout=5)
            assert await first.fetchval(f"SELECT count(*) FROM {LEDGER}") == 1
        finally:
            await first.close()
            await second.close()

    asyncio.run(check())


def test_database_all_or_none_and_pending_metadata_constraints(disposable_db: str) -> None:
    async def check() -> None:
        import json

        db = await asyncpg.connect(disposable_db)
        try:
            await db.execute(UP)
            sid, key, device, token = uuid4(), uuid4(), uuid4(), uuid4()
            await db.execute(
                "INSERT INTO \"META_HARNESS_sessions\" (id, owner_user_team_id, client_session_key, device_id, harness, session_format, update_token) VALUES ($1, 1, $2, $3, 'other-harness', 'other-jsonl', $4)",
                sid,
                key,
                device,
                token,
            )
            with pytest.raises(asyncpg.CheckViolationError):
                await db.execute("UPDATE \"META_HARNESS_sessions\" SET object_key='incomplete' WHERE id=$1", sid)
            with pytest.raises(asyncpg.CheckViolationError):
                await db.execute('UPDATE "META_HARNESS_sessions" SET display_name=$2 WHERE id=$1', sid, "Uncommitted")
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                await db.execute('UPDATE "META_HARNESS_sessions" SET owner_user_team_id=999 WHERE id=$1', sid)
            base = declaration(payload()).model_dump()
            base["session_format_version"] = "opaque-alpha"
            base["resume_metadata"] = {}
            query = "UPDATE \"META_HARNESS_sessions\" SET pending_request_id=$2,pending_object_key='test',pending_expected_token=$3,pending_expires_at=now()+interval '10 minutes',pending_snapshot=$4::jsonb WHERE id=$1"
            for invalid in [
                {**base, "encoding": None},
                {**base, "raw_size_bytes": 104857601},
                {**base, "raw_sha256": "X" * 64},
                {**base, "resume_metadata": []},
                {**base, "extra": True},
                {**base, "display_name": ""},
                {**base, "display_name": "x" * 257},
                {**base, "display_name": 123},
                {key: value for key, value in base.items() if key != "display_name"},
            ]:
                with pytest.raises(asyncpg.PostgresError):
                    await db.execute(query, sid, uuid4(), token, json.dumps(invalid))
            await db.execute(query, sid, uuid4(), token, json.dumps(base))
            assert await db.fetchval('SELECT update_token FROM "META_HARNESS_sessions" WHERE id=$1', sid) == token
        finally:
            await db.close()

    asyncio.run(check())


def test_titles_are_validated_and_committed_atomically_with_replay(disposable_db: str) -> None:
    async def check() -> None:
        db = await asyncpg.connect(disposable_db)
        await db.execute(UP)
        await db.close()
        await Tortoise.init(db_url=disposable_db, modules={"models": ["app.models"]})
        try:
            store = MemoryStore()
            service = BackupService(store)
            registration = Registration(
                client_session_key=uuid4(),
                device_id=uuid4(),
                harness="pi",
                harness_session_id="opaque/native-id",
                session_format="pi-jsonl",
            )
            remote = await service.register(1, registration)
            assert remote["display_name"] is None and remote["snapshot"] is None
            sid = UUID(remote["id"])

            async def reserve(raw: bytes, name: str | None) -> UploadRequest:
                latest = await service.register(1, registration)
                request = UploadRequest(
                    request_id=uuid4(),
                    expected_token=UUID(latest["update_token"]),
                    snapshot=declaration(raw, display_name=name),
                    capture_reason="manual",
                )
                result = await service.reserve(sid, 1, request)
                assert result["status"] == "upload_required"
                store.data[result["upload"]["url"]] = (raw, now())
                return request

            unnamed = await reserve(payload(), "synthetic")
            assert (await service.register(1, registration))["display_name"] is None
            fallback = await service.finalize(sid, 1, unnamed.request_id)
            assert fallback["session"]["display_name"] == "synthetic"
            assert (await SessionBackup.get(id=sid)).display_name == "synthetic"

            original_bytes = named_payload(["Original"])
            original = await reserve(original_bytes, "Original")
            assert (await service.register(1, registration))["display_name"] == "synthetic"
            first = await service.finalize(sid, 1, original.request_id)
            assert first["session"]["display_name"] == "Original"
            with pytest.raises(HTTPException):
                await service.reserve(
                    sid,
                    1,
                    original.model_copy(
                        update={
                            "snapshot": original.snapshot.model_copy(update={"display_name": "Forged"}),
                        }
                    ),
                )
            # Same archive bytes with a different title must not bypass validation as a no-op.
            forged = await reserve(original_bytes, "Forged")
            with pytest.raises(InvalidSessionError):
                await service.finalize(sid, 1, forged.request_id)
            assert (await service.download(sid, 1))["session"]["display_name"] == "Original"
            await SessionBackup.filter(id=sid).update(pending_expires_at=now() - timedelta(seconds=1))

            renamed = await reserve(named_payload(["Original", "Renamed"]), "Renamed")
            assert (await service.download(sid, 1))["session"]["display_name"] == "Original"
            committed = await service.finalize(sid, 1, renamed.request_id)
            assert committed["session"]["display_name"] == "Renamed"
            assert committed["session"]["snapshot"]["display_name"] == "Renamed"
            assert (await SessionBackup.get(id=sid)).display_name == "Renamed"
            assert await service.finalize(sid, 1, renamed.request_id) == committed
            assert await service.reserve(sid, 1, renamed) == committed
            assert (await service.download(sid, 1))["session"] == committed["session"]
            cleared = await reserve(named_payload(["Original", "Renamed", ""]), "synthetic")
            assert (await service.register(1, registration))["display_name"] == "Renamed"
            result = await service.finalize(sid, 1, cleared.request_id)
            assert result["session"]["display_name"] == "synthetic"
            assert result["session"]["snapshot"]["display_name"] == "synthetic"
            assert (await SessionBackup.get(id=sid)).display_name == "synthetic"
        finally:
            await Tortoise.close_connections()

    asyncio.run(check())


def test_expiry_and_deletion_during_validation_never_commit(disposable_db: str) -> None:
    async def check() -> None:
        from threading import Event

        db = await asyncpg.connect(disposable_db)
        await db.execute(UP)
        await db.close()
        await Tortoise.init(db_url=disposable_db, modules={"models": ["app.models"]})
        try:
            store = MemoryStore()
            service = BackupService(store)
            loop = asyncio.get_running_loop()
            for delete in (False, True):
                registration = Registration(
                    client_session_key=uuid4(),
                    device_id=uuid4(),
                    harness="pi",
                    harness_session_id="opaque/native-id",
                    session_format="pi-jsonl",
                )
                remote = await service.register(1, registration)
                sid = UUID(remote["id"])
                request = UploadRequest(
                    request_id=uuid4(),
                    expected_token=UUID(remote["update_token"]),
                    snapshot=declaration(payload()),
                    capture_reason="manual",
                )
                reservation = await service.reserve(sid, 1, request)
                store.data[reservation["upload"]["url"]] = (payload(), now())
                validated = asyncio.Event()
                release = Event()
                original = MemoryStore.validate

                def blocked(key: str, snapshot: Snapshot, adapter: Adapter, native_id: str | None) -> None:
                    original(store, key, snapshot, adapter, native_id)
                    loop.call_soon_threadsafe(validated.set)
                    release.wait(5)

                store.validate = blocked
                finalize = asyncio.create_task(service.finalize(sid, 1, request.request_id))
                await asyncio.wait_for(validated.wait(), 5)
                if delete:
                    await service.delete(sid, 1)
                else:
                    await SessionBackup.filter(id=sid).update(pending_expires_at=now() - timedelta(seconds=1))
                release.set()
                with pytest.raises(HTTPException):
                    await finalize
                assert (await SessionBackup.get(id=sid)).object_key is None
        finally:
            await Tortoise.close_connections()

    asyncio.run(check())


def test_protocol_ownership_cas_replay_loss_and_reconciliation(disposable_db: str) -> None:
    async def test() -> None:
        db = await asyncpg.connect(disposable_db)
        await db.execute(UP)
        await db.close()
        await Tortoise.init(db_url=disposable_db, modules={"models": ["app.models"]})
        try:
            store = MemoryStore()
            service = BackupService(store)
            registration = Registration(
                client_session_key=uuid4(),
                device_id=uuid4(),
                harness="pi",
                harness_session_id="opaque/native-id",
                session_format="pi-jsonl",
            )
            remote = await service.register(1, registration)
            assert await service.register(1, registration) == remote
            with pytest.raises(HTTPException) as immutable:
                await service.register(1, registration.model_copy(update={"device_id": uuid4()}))
            assert immutable.value.status_code == 409
            sid = UUID(remote["id"])
            request = UploadRequest(
                request_id=uuid4(),
                expected_token=UUID(remote["update_token"]),
                snapshot=declaration(payload()),
                capture_reason="manual",
            )
            with pytest.raises(HTTPException) as wrong_owner:
                await service.reserve(sid, 2, request)
            assert wrong_owner.value.status_code == 404
            reserved = await service.reserve(sid, 1, request)
            assert await service.reserve(sid, 1, request) == reserved
            with pytest.raises(HTTPException):
                await service.reserve(
                    sid,
                    1,
                    request.model_copy(
                        update={
                            "snapshot": request.snapshot.model_copy(
                                update={"raw_sha256": "0" * 64, "stored_sha256": "0" * 64}
                            )
                        }
                    ),
                )
            competing = request.model_copy(update={"request_id": uuid4()})
            with pytest.raises(HTTPException):
                await service.reserve(sid, 1, competing)
            key = reserved["upload"]["url"]
            store.data[key] = (payload(), now() - timedelta(hours=3))
            first, second = await asyncio.gather(
                service.finalize(sid, 1, request.request_id), service.finalize(sid, 1, request.request_id)
            )
            assert first == second
            assert (await service.reserve(sid, 1, request))["status"] == "committed"  # response lost after commit
            token = UUID(first["session"]["update_token"])
            noop = request.model_copy(update={"request_id": uuid4(), "expected_token": token})
            assert (await service.reserve(sid, 1, noop))["status"] == "already_current"
            # Same bytes but a different selected leaf is a real replacement.
            root = request.snapshot.model_copy(
                update={"resume_metadata": {"leaf_known": True, "selected_leaf_id": None}}
            )
            replacement = request.model_copy(update={"request_id": uuid4(), "expected_token": token, "snapshot": root})
            newer = await service.reserve(sid, 1, replacement)
            new_key = newer["upload"]["url"]
            store.data[new_key] = (b"corrupt", now() - timedelta(hours=3))
            with pytest.raises(InvalidSessionError):
                await service.finalize(sid, 1, replacement.request_id)
            assert (await SessionBackup.get(id=sid)).object_key == key
            store.data[new_key] = (payload(), now() - timedelta(hours=3))
            store.delete_fails = True
            changed = await service.finalize(sid, 1, replacement.request_id)
            assert (await service.download(sid, 1))["url"] == new_key
            assert key in store.data  # deletion failed, namespace is durable recovery information
            with pytest.raises(HTTPException):
                await service.finalize(sid, 1, request.request_id)
            with pytest.raises(HTTPException):
                await service.reserve(sid, 1, noop)
            store.delete_fails = False
            await service.reconcile()
            assert key not in store.data and new_key in store.data
            # Expiry during validation prevents pointer replacement.
            expires = replacement.model_copy(
                update={
                    "request_id": uuid4(),
                    "expected_token": UUID(changed["session"]["update_token"]),
                    "snapshot": declaration(payload()),
                }
            )
            await service.reserve(sid, 1, expires)
            await SessionBackup.filter(id=sid).update(pending_expires_at=now() - timedelta(seconds=1))
            with pytest.raises(HTTPException):
                await service.finalize(sid, 1, expires.request_id)
            assert (await SessionBackup.get(id=sid)).object_key == new_key
            with pytest.raises(HTTPException):
                await service.delete(sid, 2)
            await service.delete(sid, 1)
            for action in [
                service.download(sid, 1),
                service.finalize(sid, 1, replacement.request_id),
                service.reserve(sid, 1, expires),
            ]:
                with pytest.raises(HTTPException) as gone:
                    await action
                assert gone.value.status_code == 404
            assert await SessionBackup.filter(id=sid).exists()
            # A late PUT keeps a tombstone alive until old-enough cleanup succeeds.
            store.data[new_key] = (payload(), now())
            await SessionBackup.filter(id=sid).update(deleted_at=now() - timedelta(hours=2))
            await service.reconcile()
            assert await SessionBackup.filter(id=sid).exists()
            store.data[new_key] = (payload(), now() - timedelta(hours=3))
            await service.reconcile()
            assert not await SessionBackup.filter(id=sid).exists()
        finally:
            await Tortoise.close_connections()

    asyncio.run(test())
