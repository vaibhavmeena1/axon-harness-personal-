"""FastAPI dependency wiring for model recommendation services."""

from typing import Annotated

from fastapi import Depends

from app.clients.litellm.decisions import LiteLLMDecisionClient
from app.clients.litellm.dependencies import get_litellm_decision_client
from app.services.model_recommendation.service import ModelRecommendationService


def get_model_recommendation_service(
    decision_client: Annotated[LiteLLMDecisionClient, Depends(get_litellm_decision_client)],
) -> ModelRecommendationService:
    """Build a lightweight service around the app-owned LiteLLM decision client."""
    return ModelRecommendationService(decision_client)
