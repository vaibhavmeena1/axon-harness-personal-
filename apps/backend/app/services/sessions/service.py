"""Owner-scoped latest-only compare-and-swap protocol and durable reconciliation."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import HTTPException
from tortoise.backends.base.client import BaseDBAsyncClient
from tortoise.exceptions import IntegrityError
from tortoise.expressions import Q
from tortoise.transactions import in_transaction

from app.models.session_backup import SessionBackup
from app.services.sessions.adapters import ADAPTERS, InvalidSessionError, get_adapter
from app.services.sessions.contracts import Registration, Snapshot, UploadRequest
from app.services.sessions.storage import SessionObjectStore

SNAPSHOT_FIELDS = tuple(Snapshot.model_fields)
PENDING_FIELDS = (
    "pending_request_id",
    "pending_object_key",
    "pending_expected_token",
    "pending_expires_at",
    "pending_snapshot",
)


def now() -> datetime:
    return datetime.now(UTC)


def conflict(message: str = "Backup changed or reservation expired; reconcile current state") -> HTTPException:
    return HTTPException(409, message, headers={"Cache-Control": "no-store"})


def clear_pending(row: SessionBackup) -> None:
    for field in PENDING_FIELDS:
        setattr(row, field, None)


def current_snapshot(row: SessionBackup) -> dict:
    return {field: getattr(row, field) for field in SNAPSHOT_FIELDS}


def metadata(row: SessionBackup) -> dict:
    return {
        "id": str(row.id),
        "display_name": row.display_name,
        "harness": row.harness,
        "harness_session_id": row.harness_session_id,
        "session_format": row.session_format,
        "device_id": str(row.device_id),
        "client_session_key": str(row.client_session_key),
        "update_token": str(row.update_token),
        "last_backup_at": row.last_backup_at.isoformat() if row.last_backup_at else None,
        "updated_at": row.updated_at.isoformat(),
        "snapshot": current_snapshot(row) if row.object_key else None,
    }


def committed(row: SessionBackup, status: str = "committed") -> dict:
    return {"status": status, "session": metadata(row)}


async def owned(
    session_id: UUID, owner: int, connection: BaseDBAsyncClient | None = None, lock: bool = False
) -> SessionBackup:
    query = SessionBackup.filter(id=session_id, owner_user_team_id=owner, deleted_at=None)
    if connection is not None:
        query = query.using_db(connection)
    if lock:
        query = query.select_for_update()
    row = await query.first()
    if row is None:
        raise HTTPException(404, "Session not found", headers={"Cache-Control": "no-store"})
    return row


class BackupService:
    def __init__(self, store: SessionObjectStore) -> None:
        self.store = store
        self._verified_until = now()
        self._ready_lock = asyncio.Lock()
        self._validation_slots = asyncio.Semaphore(2)

    async def ready(self) -> None:
        async with self._ready_lock:
            if self._verified_until > now():
                return
            await asyncio.to_thread(self.store.assert_private_create_only)
            self._verified_until = now() + timedelta(seconds=60)

    async def register(self, owner: int, declaration: Registration) -> dict:
        if not any(h == declaration.harness and f == declaration.session_format for h, f, _ in ADAPTERS):
            raise InvalidSessionError("Unsupported harness or session format")
        identity = declaration.model_dump()
        try:
            row = await SessionBackup.create(owner_user_team_id=owner, **identity)
        except IntegrityError:
            row = await SessionBackup.get_or_none(
                owner_user_team_id=owner, client_session_key=declaration.client_session_key
            )
            if row is None:
                raise HTTPException(403, "Membership unavailable", headers={"Cache-Control": "no-store"}) from None
            if row.deleted_at is not None or any(getattr(row, key) != value for key, value in identity.items()):
                raise conflict("Stream registration identity does not match") from None
        return metadata(row)

    async def reserve(self, session_id: UUID, owner: int, request: UploadRequest) -> dict:
        declaration = request.snapshot.model_dump()
        async with in_transaction() as db:
            row = await owned(session_id, owner, db, lock=True)
            # Tracked requests precede token and no-op checks. Stored declarations remain immutable.
            if row.last_committed_request_id == request.request_id:
                if current_snapshot(row) != declaration:
                    raise conflict("Committed request UUID reused with different declarations")
                return committed(row)
            if row.pending_request_id == request.request_id:
                if row.pending_snapshot != declaration or row.pending_expected_token != request.expected_token:
                    raise conflict("Pending request UUID reused with different declarations")
                if row.pending_expires_at <= now():
                    raise conflict()
            else:
                adapter = get_adapter(row.harness, row.session_format, request.snapshot.session_format_version)
                adapter.resume(request.snapshot.resume_metadata)
                if row.update_token != request.expected_token:
                    raise conflict()
                if row.object_key and all(
                    getattr(row, field) == declaration[field]
                    for field in (
                        "display_name",
                        "raw_sha256",
                        "raw_size_bytes",
                        "session_format_version",
                        "resume_metadata",
                    )
                ):
                    return committed(row, "already_current")
                if row.pending_request_id is not None and row.pending_expires_at > now():
                    raise conflict("Another upload is reserved for this stream")
                row.pending_request_id = request.request_id
                row.pending_expected_token = request.expected_token
                row.pending_expires_at = now() + timedelta(seconds=self.store.settings.reservation_seconds)
                row.pending_object_key = f"{self.store.settings.key_prefix}{row.id}/{uuid4()}"
                row.pending_snapshot = declaration
                await row.save(using_db=db)
            key = row.pending_object_key
            expires = row.pending_expires_at
        # Reservation commits before a URL is issued. Never issue a URL beyond its reservation.
        if expires <= now() + timedelta(seconds=self.store.settings.url_seconds):
            raise conflict("Reservation is near expiry; reconcile current state")
        upload = await asyncio.to_thread(self.store.put_url, key, request.snapshot)
        return {"status": "upload_required", "request_id": str(request.request_id), "upload": upload}

    async def finalize(self, session_id: UUID, owner: int, request_id: UUID) -> dict:
        async with in_transaction() as db:
            row = await owned(session_id, owner, db, lock=True)
            if row.last_committed_request_id == request_id:
                return committed(row)
            if row.pending_request_id != request_id or row.pending_expires_at <= now():
                raise conflict()
            snapshot = Snapshot.model_validate(row.pending_snapshot)
            key, token = row.pending_object_key, row.pending_expected_token
            adapter = get_adapter(row.harness, row.session_format, snapshot.session_format_version)
            adapter.resume(snapshot.resume_metadata)
            native_id = row.harness_session_id
        # No database lock during the bounded object read/decompression/validation.
        async with self._validation_slots:
            await asyncio.to_thread(self.store.validate, key, snapshot, adapter, native_id)
        async with in_transaction() as db:
            row = await owned(session_id, owner, db, lock=True)
            if row.last_committed_request_id == request_id:
                return committed(row)
            if (
                row.pending_request_id != request_id
                or row.pending_object_key != key
                or row.pending_snapshot != snapshot.model_dump()
                or row.pending_expires_at <= now()
                or row.update_token != token
            ):
                raise conflict()
            previous = row.object_key
            row.object_key = key
            for field, value in snapshot.model_dump().items():
                setattr(row, field, value)
            row.last_committed_request_id = request_id
            row.last_backup_at = now()
            row.update_token = uuid4()
            clear_pending(row)
            await row.save(using_db=db)
            result = committed(row)
        if previous:
            try:
                await asyncio.to_thread(self.store.delete, previous)
            except (BotoCoreError, ClientError, OSError, RuntimeError):
                # Durable namespace reconciliation catches this even after a crash.
                pass
        return result

    async def download(self, session_id: UUID, owner: int) -> dict:
        row = await owned(session_id, owner)
        if row.object_key is None:
            raise HTTPException(404, "No committed backup", headers={"Cache-Control": "no-store"})
        return {
            "session": metadata(row),
            "object_id": row.object_key.rsplit("/", 1)[-1],
            "url": await asyncio.to_thread(self.store.get_url, row.object_key),
            "expires_in": self.store.settings.url_seconds,
        }

    async def delete(self, session_id: UUID, owner: int) -> None:
        async with in_transaction() as db:
            row = (
                await SessionBackup.filter(id=session_id, owner_user_team_id=owner)
                .using_db(db)
                .select_for_update()
                .first()
            )
            if row is None:
                raise HTTPException(404, "Session not found", headers={"Cache-Control": "no-store"})
            if row.deleted_at is None:
                row.deleted_at = now()
                await row.save(using_db=db)
        for key in (row.object_key, row.pending_object_key):
            if key:
                try:
                    await asyncio.to_thread(self.store.delete, key)
                except (BotoCoreError, ClientError, OSError, RuntimeError):
                    pass

    async def reconcile(self) -> dict:
        """Run periodically from deployment/reconcile_sessions.py, not a client worker."""
        cutoff = now() - timedelta(seconds=self.store.settings.cleanup_grace_seconds)
        removed = 0
        # Streaming pages, not an unbounded listing. A fresh reservation always uses a fresh key.
        iterator = self.store.objects()
        sentinel = object()
        while True:
            item = await asyncio.to_thread(next, iterator, sentinel)
            if item is sentinel:
                break
            key, modified = item
            if modified > cutoff:
                continue
            referenced = await SessionBackup.filter(
                Q(object_key=key, deleted_at=None)
                | Q(pending_object_key=key, pending_expires_at__gt=now(), deleted_at=None),
            ).exists()
            if not referenced:
                await asyncio.to_thread(self.store.delete, key)
                removed += 1
        for row in await SessionBackup.filter(pending_expires_at__lte=now(), deleted_at=None):
            async with in_transaction() as db:
                locked = await SessionBackup.filter(id=row.id).using_db(db).select_for_update().first()
                if locked and locked.pending_expires_at and locked.pending_expires_at <= now():
                    clear_pending(locked)
                    await locked.save(using_db=db)
        # Keep tombstones beyond all URL lifetimes, then verify their whole namespace is empty.
        for row in await SessionBackup.filter(deleted_at__lte=cutoff):

            def has_objects(session: SessionBackup = row) -> bool:
                prefix = f"{self.store.settings.key_prefix}{session.id}/"
                return any(key.startswith(prefix) for key, _ in self.store.objects())

            if not await asyncio.to_thread(has_objects):
                await row.delete()
        return {"objects_deleted": removed}
