"""Per-application storage resources with startup-failure and shutdown cleanup."""

import asyncio
from contextlib import AsyncExitStack

from fastapi import FastAPI

from app.clients.cloudfront import CloudFrontUrlSigner
from app.clients.s3 import S3Client
from app.core.config import get_settings
from app.services.cli_releases import CliReleaseService
from app.services.sessions.service import BackupService
from app.services.sessions.storage import SessionObjectStore
from app.services.storage_dependencies import BACKUP_SERVICE_STATE_KEY, CLI_RELEASE_SERVICE_STATE_KEY

STORAGE_STACK_STATE_KEY = "storage_exit_stack"


async def initialize_storage(app: FastAPI) -> None:
    """Create separate S3 pools for releases and backups only when enabled.

    Bucket checks remain in BackupService.ready(), including its existing TTL.
    No bucket-policy network calls are added to application startup.
    """
    settings = get_settings()
    releases = None
    backups = None
    async with AsyncExitStack() as stack:
        if settings.cli_releases is not None:
            release_settings = settings.cli_releases
            signer = CloudFrontUrlSigner(
                release_settings.distribution_url, release_settings.key_pair_id, release_settings.private_key
            )
            s3 = await asyncio.to_thread(S3Client, release_settings.s3.client)
            stack.push_async_callback(asyncio.to_thread, s3.close)
            releases = CliReleaseService(release_settings, s3, signer)

        if settings.session_backups is not None:
            session_settings = settings.session_backups
            s3 = await asyncio.to_thread(S3Client, session_settings.s3.client)
            stack.push_async_callback(asyncio.to_thread, s3.close)
            backups = BackupService(SessionObjectStore(session_settings, s3))

        setattr(app.state, CLI_RELEASE_SERVICE_STATE_KEY, releases)
        setattr(app.state, BACKUP_SERVICE_STATE_KEY, backups)
        setattr(app.state, STORAGE_STACK_STATE_KEY, stack.pop_all())


async def close_storage(app: FastAPI) -> None:
    stack = getattr(app.state, STORAGE_STACK_STATE_KEY, None)
    setattr(app.state, STORAGE_STACK_STATE_KEY, None)
    setattr(app.state, CLI_RELEASE_SERVICE_STATE_KEY, None)
    setattr(app.state, BACKUP_SERVICE_STATE_KEY, None)
    if stack is not None:
        await stack.aclose()
