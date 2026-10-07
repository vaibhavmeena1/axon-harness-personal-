"""Application lifecycle listener registration."""

from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager

from fastapi import FastAPI

from app.clients.auth_service import AUTH_SERVICE_CLIENT_STATE_KEY, AuthServiceClient
from app.core.config import get_settings
from app.listeners.database import close_database, initialize_database
from app.listeners.litellm import close_litellm_proxy, initialize_litellm_proxy
from app.listeners.openrouter import close_openrouter_client, initialize_openrouter_client
from app.proxies.otel import close_otel_proxy, initialize_otel_proxy
from app.telemetry import close_backend_telemetry, initialize_backend_telemetry


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Start dependencies in order and close initialized resources in reverse order."""
    async with AsyncExitStack() as stack:
        await initialize_backend_telemetry(app)
        stack.push_async_callback(close_backend_telemetry, app)

        await initialize_database(app)
        stack.push_async_callback(close_database, app)

        await initialize_litellm_proxy(app)
        stack.push_async_callback(close_litellm_proxy, app)

        await initialize_openrouter_client(app)
        stack.push_async_callback(close_openrouter_client, app)

        auth_settings = get_settings().auth_service
        if auth_settings is not None:
            auth_client = AuthServiceClient(auth_settings)
            setattr(app.state, AUTH_SERVICE_CLIENT_STATE_KEY, auth_client)
            stack.push_async_callback(auth_client.close)

        await initialize_otel_proxy(app)
        stack.push_async_callback(close_otel_proxy, app)

        yield
