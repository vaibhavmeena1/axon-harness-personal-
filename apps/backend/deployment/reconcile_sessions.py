"""Run from an operator scheduler (e.g. every 10 minutes), without schema changes."""

import asyncio
from contextlib import AsyncExitStack

from tortoise import Tortoise

from app.clients.s3 import S3Client
from app.core.config import get_settings
from app.services.sessions.service import BackupService
from app.services.sessions.storage import SessionObjectStore


async def reconcile() -> None:
    settings = get_settings()
    if settings.session_backups is None:
        raise RuntimeError("Session backups are disabled")
    async with AsyncExitStack() as stack:
        await Tortoise.init(config=settings.database.tortoise_config())
        stack.push_async_callback(Tortoise.close_connections)
        s3 = await asyncio.to_thread(S3Client, settings.session_backups.s3.client)
        stack.push_async_callback(asyncio.to_thread, s3.close)
        result = await BackupService(SessionObjectStore(settings.session_backups, s3)).reconcile()
        print(f"Session reconciliation complete: {result['objects_deleted']} objects deleted")  # noqa: T201 - operational CLI summary


if __name__ == "__main__":
    asyncio.run(reconcile())
