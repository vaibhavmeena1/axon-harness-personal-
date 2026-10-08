"""Per-application LiteLLM integration startup and shutdown."""

import logging

from fastapi import FastAPI

from app.clients.litellm.dependencies import LITELLM_IDENTITY_CLIENT_STATE_KEY, LITELLM_TRANSPORT_STATE_KEY
from app.clients.litellm.identity import LiteLLMIdentityClient
from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import get_settings

logger = logging.getLogger(__name__)


async def initialize_litellm_proxy(app: FastAPI) -> None:
    """Compose streaming proxy and identity management over one HTTP pool."""
    settings = get_settings()
    transport = LiteLLMTransport(settings.litellm)
    try:
        identity = LiteLLMIdentityClient(settings.litellm, transport)
        setattr(app.state, LITELLM_TRANSPORT_STATE_KEY, transport)
        setattr(app.state, LITELLM_IDENTITY_CLIENT_STATE_KEY, identity)
    except BaseException:
        await transport.aclose()
        raise
    logger.info("LiteLLM integration initialized")


async def close_litellm_proxy(app: FastAPI) -> None:
    """Detach all consumers before closing their shared connection pool."""
    transport = getattr(app.state, LITELLM_TRANSPORT_STATE_KEY, None)
    setattr(app.state, LITELLM_TRANSPORT_STATE_KEY, None)
    setattr(app.state, LITELLM_IDENTITY_CLIENT_STATE_KEY, None)
    if transport is not None:
        await transport.aclose()
    logger.info("LiteLLM integration closed")
