"""Application state keys and dependencies for the shared LiteLLM integration."""

from fastapi import Request

from app.clients.litellm.decisions import LiteLLMDecisionClient
from app.clients.litellm.identity import LiteLLMIdentityClient

LITELLM_TRANSPORT_STATE_KEY = "litellm_transport"
LITELLM_IDENTITY_CLIENT_STATE_KEY = "litellm_identity_client"
LITELLM_DECISION_CLIENT_STATE_KEY = "litellm_decision_client"


def get_litellm_identity_client(request: Request) -> LiteLLMIdentityClient:
    """Return the app-owned client resolving backend-managed user/team keys."""
    client = getattr(request.app.state, LITELLM_IDENTITY_CLIENT_STATE_KEY, None)
    if not isinstance(client, LiteLLMIdentityClient):
        raise RuntimeError("LiteLLM identity client is not initialized")
    return client


def get_litellm_decision_client(request: Request) -> LiteLLMDecisionClient:
    """Return the app-owned decision client sharing the proxy's connection pool."""
    client = getattr(request.app.state, LITELLM_DECISION_CLIENT_STATE_KEY, None)
    if not isinstance(client, LiteLLMDecisionClient):
        raise RuntimeError("LiteLLM decision client is not initialized")
    return client
