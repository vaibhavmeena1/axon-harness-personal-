"""OpenRouter client startup and shutdown listeners."""

import logging

from fastapi import FastAPI

from app.clients.openrouter import OPENROUTER_CLIENT_STATE_KEY, OpenRouterClient
from app.core.config import get_settings

logger = logging.getLogger(__name__)


async def initialize_openrouter_client(app: FastAPI) -> None:
    """Create the process-wide OpenRouter client and connection pool."""
    setattr(
        app.state,
        OPENROUTER_CLIENT_STATE_KEY,
        OpenRouterClient(get_settings().openrouter),
    )
    logger.info("OpenRouter HTTP client initialized")


async def close_openrouter_client(app: FastAPI) -> None:
    """Close the shared OpenRouter client and its connections."""
    client: OpenRouterClient | None = getattr(
        app.state,
        OPENROUTER_CLIENT_STATE_KEY,
        None,
    )
    setattr(app.state, OPENROUTER_CLIENT_STATE_KEY, None)

    if client is not None:
        await client.close()
    logger.info("OpenRouter HTTP client closed")
