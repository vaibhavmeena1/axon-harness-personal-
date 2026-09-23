"""Public OpenRouter client interface."""

from app.clients.openrouter.client import OpenRouterClient
from app.clients.openrouter.dependencies import (
    OPENROUTER_CLIENT_STATE_KEY,
    get_openrouter_client,
)
from app.clients.openrouter.exceptions import (
    OpenRouterAPIError,
    OpenRouterError,
    OpenRouterResponseError,
    OpenRouterTransportError,
)

__all__ = [
    "OPENROUTER_CLIENT_STATE_KEY",
    "OpenRouterAPIError",
    "OpenRouterClient",
    "OpenRouterError",
    "OpenRouterResponseError",
    "OpenRouterTransportError",
    "get_openrouter_client",
]
