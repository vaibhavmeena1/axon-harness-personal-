"""Authenticated metadata API. Payloads travel directly between harness and S3."""

from collections import OrderedDict
from collections.abc import Awaitable
from datetime import datetime
from time import monotonic
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from tortoise.expressions import Q

from app.authentication import require_authenticated_user
from app.clients.auth_service import AuthData
from app.core.config import Settings, get_settings
from app.models.session_backup import SessionBackup
from app.services.sessions.adapters import InvalidSessionError
from app.services.sessions.contracts import FinalizeRequest, Registration, UploadRequest
from app.services.sessions.service import BackupService, metadata
from app.services.storage_dependencies import get_backup_service


class PrivateMetadataRoute(APIRoute):
    def get_route_handler(self):  # noqa: ANN201 - FastAPI route-handler callable
        handler = super().get_route_handler()

        async def bounded(request: Request) -> Response:
            if request.method == "POST":
                size = 0
                pieces = []
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > 16384:
                        return JSONResponse(
                            {"detail": "Session metadata request is too large"},
                            status_code=413,
                            headers={"Cache-Control": "no-store"},
                        )
                    pieces.append(chunk)
                request._body = b"".join(pieces)
            try:
                response = await handler(request)
            except RequestValidationError:
                # Do not reflect invalid metadata, paths, credentials or payload fragments.
                return JSONResponse(
                    {"detail": "Invalid session metadata request"},
                    status_code=422,
                    headers={"Cache-Control": "no-store"},
                )
            response.headers["Cache-Control"] = "no-store"
            return response

        return bounded


router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"], route_class=PrivateMetadataRoute)
# Bounded per-process guard; configure an owner-keyed edge limiter for multi-worker deployment.
_upload_rates: OrderedDict[int, list[float]] = OrderedDict()


def rate_limit(owner: int) -> None:
    stamp = monotonic()
    calls = [value for value in _upload_rates.pop(owner, []) if value > stamp - 60]
    _upload_rates[owner] = calls
    if len(_upload_rates) > 4096:
        _upload_rates.popitem(last=False)
    if len(calls) >= 30:
        raise HTTPException(429, "Too many backup requests", headers={"Cache-Control": "no-store", "Retry-After": "60"})
    calls.append(stamp)


async def run[T](operation: Awaitable[T]) -> T:
    try:
        return await operation
    except InvalidSessionError:
        raise HTTPException(
            422, "Unsupported or invalid session payload/metadata", headers={"Cache-Control": "no-store"}
        ) from None
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001 - never expose storage/ORM diagnostics to callers
        # Never expose SDK errors containing object keys, signed URLs or payloads.
        raise HTTPException(
            503, "Session storage operation failed; retry or reconcile", headers={"Cache-Control": "no-store"}
        ) from None


@router.get("/status")
async def status(
    request: Request,
    auth: AuthData = Depends(require_authenticated_user),
    settings: Settings = Depends(get_settings),
) -> dict:
    if settings.session_backups is None:
        return {"enabled": False, "owner_user_team_id": str(auth.user_team_id)}
    # Enabled policy is advertised only after private storage is ready.
    await get_backup_service(request, settings)
    return {
        "enabled": True,
        "owner_user_team_id": str(auth.user_team_id),
        "max_raw_size_bytes": 104857600,
        "max_stored_size_bytes": 105906176,
        "formats": [{"harness": "pi", "session_format": "pi-jsonl", "versions": ["3"]}],
    }


@router.post("")
async def register(
    body: Registration,
    auth: AuthData = Depends(require_authenticated_user),
    backups: BackupService = Depends(get_backup_service),
) -> dict:
    rate_limit(auth.user_team_id)
    return await run(backups.register(auth.user_team_id, body))


@router.get("")
async def list_sessions(
    auth: AuthData = Depends(require_authenticated_user),
    backups: BackupService = Depends(get_backup_service),
    limit: int = Query(50, ge=1, le=100),
    before: datetime | None = None,
    before_id: UUID | None = None,
) -> dict:
    if (before is None) != (before_id is None) or (before is not None and before.tzinfo is None):
        raise HTTPException(
            422, "Pagination requires a timestamp with timezone and session ID", headers={"Cache-Control": "no-store"}
        )
    query = SessionBackup.filter(owner_user_team_id=auth.user_team_id, deleted_at=None, object_key__not_isnull=True)
    if before is not None:
        query = query.filter(Q(updated_at__lt=before) | Q(updated_at=before, id__lt=before_id))
    rows = await query.order_by("-updated_at", "-id").limit(limit + 1)
    selected = rows[:limit]
    return {
        "sessions": [metadata(row) for row in selected],
        "next": {
            "before": selected[-1].updated_at.isoformat(),
            "before_id": str(selected[-1].id),
        }
        if len(rows) > limit
        else None,
    }


@router.post("/{session_id}/backup-upload")
async def upload(
    session_id: UUID,
    body: UploadRequest,
    auth: AuthData = Depends(require_authenticated_user),
    backups: BackupService = Depends(get_backup_service),
) -> dict:
    rate_limit(auth.user_team_id)
    return await run(backups.reserve(session_id, auth.user_team_id, body))


@router.post("/{session_id}/backup-finalize")
async def finalize(
    session_id: UUID,
    body: FinalizeRequest,
    auth: AuthData = Depends(require_authenticated_user),
    backups: BackupService = Depends(get_backup_service),
) -> dict:
    rate_limit(auth.user_team_id)
    return await run(backups.finalize(session_id, auth.user_team_id, body.request_id))


@router.get("/{session_id}/backup-download")
async def download(
    session_id: UUID,
    auth: AuthData = Depends(require_authenticated_user),
    backups: BackupService = Depends(get_backup_service),
) -> dict:
    return await run(backups.download(session_id, auth.user_team_id))


@router.delete("/{session_id}", status_code=204)
async def delete(
    session_id: UUID,
    auth: AuthData = Depends(require_authenticated_user),
    backups: BackupService = Depends(get_backup_service),
) -> Response:
    await run(backups.delete(session_id, auth.user_team_id))
    return Response(status_code=204, headers={"Cache-Control": "no-store"})
