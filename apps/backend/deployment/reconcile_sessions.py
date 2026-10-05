"""Run from an operator scheduler (e.g. every 10 minutes), without schema changes."""

import asyncio

from tortoise import Tortoise

from app.core.config import get_settings
from app.services.sessions.service import BackupService
from app.services.sessions.storage import SessionObjectStore


async def reconcile() -> None:
    settings = get_settings()
    if settings.session_backups is None:
        raise RuntimeError("Session backups are disabled")
    await Tortoise.init(config=settings.database.tortoise_config())
    try:
        result = await BackupService(SessionObjectStore(settings.session_backups)).reconcile()
        print(f"Session reconciliation complete: {result['objects_deleted']} objects deleted")  # noqa: T201 - operational CLI summary
    finally:
        await Tortoise.close_connections()


if __name__ == "__main__":
    asyncio.run(reconcile())
