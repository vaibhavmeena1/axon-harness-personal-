"""FastAPI dependency for the process-wide OpenRouter client."""

from fastapi import Request

from app.clients.openrouter.client import OpenRouterClient

OPENROUTER_CLIENT_STATE_KEY = "openrouter_client"


def get_openrouter_client(request: Request) -> OpenRouterClient:
    """Return the initialized OpenRouter client for a request."""
    client = getattr(request.app.state, OPENROUTER_CLIENT_STATE_KEY, None)
    if not isinstance(client, OpenRouterClient):
        raise RuntimeError("OpenRouter client is not initialized")
    return client
