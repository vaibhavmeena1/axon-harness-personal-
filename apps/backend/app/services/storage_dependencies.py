"""Request dependencies for application-owned release and backup services."""

from fastapi import Depends, HTTPException, Request

from app.core.config import Settings, get_settings
from app.services.cli_releases import CliReleaseService
from app.services.sessions.service import BackupService

CLI_RELEASE_SERVICE_STATE_KEY = "cli_release_service"
BACKUP_SERVICE_STATE_KEY = "backup_service"


def get_cli_release_service(request: Request, settings: Settings = Depends(get_settings)) -> CliReleaseService:
    service = getattr(request.app.state, CLI_RELEASE_SERVICE_STATE_KEY, None)
    if settings.cli_releases is None or service is None:
        raise HTTPException(503, "CLI releases are not configured")
    return service


async def get_backup_service(request: Request, settings: Settings = Depends(get_settings)) -> BackupService:
    if settings.session_backups is None:
        raise HTTPException(503, "Session backups are disabled", headers={"Cache-Control": "no-store"})
    service = getattr(request.app.state, BACKUP_SERVICE_STATE_KEY, None)
    try:
        if service is None:
            raise RuntimeError("Session storage is not initialized")
        await service.ready()
    except Exception:  # noqa: BLE001 - sanitize storage SDK/configuration errors at the API boundary
        raise HTTPException(
            503, "Private create-only session storage is unavailable", headers={"Cache-Control": "no-store"}
        ) from None
    return service
