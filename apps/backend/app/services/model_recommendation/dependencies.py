"""FastAPI dependency wiring for model recommendation services."""

from typing import Annotated

from fastapi import Depends, HTTPException, status

from app.authentication import litellm_identity, require_authenticated_user
from app.clients.auth_service import AuthData, AuthenticatedUser, AuthServiceError
from app.clients.litellm.decisions import LiteLLMDecisionClient
from app.clients.litellm.dependencies import get_litellm_decision_client, get_litellm_identity_client
from app.clients.litellm.identity import LiteLLMIdentityClient
from app.services.model_recommendation.service import ModelRecommendationService


def get_model_recommendation_user(
    auth: Annotated[AuthData, Depends(require_authenticated_user)],
) -> AuthenticatedUser:
    """Use only auth-service data, never identity supplied in the request payload."""
    try:
        return litellm_identity(auth)
    except AuthServiceError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Model recommendation identity is unavailable",
        ) from None


def get_model_recommendation_service(
    decision_client: Annotated[LiteLLMDecisionClient, Depends(get_litellm_decision_client)],
    identity_client: Annotated[LiteLLMIdentityClient, Depends(get_litellm_identity_client)],
) -> ModelRecommendationService:
    """Build a lightweight service around the app-owned LiteLLM clients."""
    return ModelRecommendationService(decision_client, identity_client)
