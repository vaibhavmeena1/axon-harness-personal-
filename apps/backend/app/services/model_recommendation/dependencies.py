"""FastAPI dependency wiring for model recommendation services."""

from typing import Annotated

from fastapi import Depends

from app.clients.openrouter import OpenRouterClient, get_openrouter_client
from app.services.model_recommendation.service import ModelRecommendationService


def get_model_recommendation_service(
    openrouter_client: Annotated[OpenRouterClient, Depends(get_openrouter_client)],
) -> ModelRecommendationService:
    """Build a lightweight service around the process-wide OpenRouter client."""
    return ModelRecommendationService(openrouter_client)
