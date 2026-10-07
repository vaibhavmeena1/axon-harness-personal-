"""LiteLLM reverse-proxy client startup and shutdown listeners."""

import logging

import httpx
from fastapi import FastAPI

from app.clients.litellm import LITELLM_IDENTITY_CLIENT_STATE_KEY, LiteLLMIdentityClient
from app.core.config import get_settings
from app.proxies.litellm import LITELLM_CLIENT_STATE_KEY

logger = logging.getLogger(__name__)


async def initialize_litellm_proxy(app: FastAPI) -> None:
    """Create the process-wide pooled client used for LiteLLM requests."""
    settings = get_settings().litellm
    app.state.litellm_proxy_client = httpx.AsyncClient(
        timeout=httpx.Timeout(
            connect=settings.connect_timeout_seconds,
            read=None,
            write=None,
            pool=settings.pool_timeout_seconds,
        ),
        limits=httpx.Limits(
            max_connections=settings.max_connections,
            max_keepalive_connections=settings.max_keepalive_connections,
            keepalive_expiry=settings.keepalive_expiry_seconds,
        ),
        follow_redirects=False,
        trust_env=False,
    )
    setattr(
        app.state,
        LITELLM_IDENTITY_CLIENT_STATE_KEY,
        LiteLLMIdentityClient(settings, app.state.litellm_proxy_client),
    )
    logger.info("LiteLLM proxy HTTP client initialized")


async def close_litellm_proxy(app: FastAPI) -> None:
    """Stop accepting proxy requests and close the shared HTTP connection pool."""
    client: httpx.AsyncClient | None = getattr(
        app.state,
        LITELLM_CLIENT_STATE_KEY,
        None,
    )
    setattr(app.state, LITELLM_CLIENT_STATE_KEY, None)
    setattr(app.state, LITELLM_IDENTITY_CLIENT_STATE_KEY, None)

    if client is not None:
        await client.aclose()
    logger.info("LiteLLM proxy HTTP client closed")
