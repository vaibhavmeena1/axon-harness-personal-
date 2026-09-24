"""Task-based coding-model recommendation endpoint."""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.clients.openrouter import OpenRouterError
from app.services.model_recommendation import (
    ModelRecommendationError,
    ModelRecommendationRequest,
    ModelRecommendationResponse,
    ModelRecommendationService,
    get_model_recommendation_service,
)
from app.services.model_recommendation.catalog import is_model_recommendation_enabled

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/model-recommendations", tags=["model-recommendations"])


@router.post(
    "",
    response_model=ModelRecommendationResponse,
    responses={status.HTTP_204_NO_CONTENT: {"description": "Recommendation is disabled for the current model"}},
)
async def recommend_model(
    request: ModelRecommendationRequest,
    service: Annotated[
        ModelRecommendationService,
        Depends(get_model_recommendation_service),
    ],
) -> ModelRecommendationResponse | Response:
    """Recommend models available to the caller for a new coding task."""
    # The prompt may contain user content, so log only metadata Pi supplied for routing.
    logger.info(
        "Model recommendation request received with Pi model data: %s",
        request.model_dump(by_alias=True, exclude={"prompt"}),
    )

    if not is_model_recommendation_enabled(request.current_model):
        logger.info(
            "Model recommendation skipped for current model %s",
            request.current_model,
        )
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    try:
        return await service.recommend(request)
    except (OpenRouterError, ModelRecommendationError) as exc:
        # Do not log traceback locals here: they include the user's prompt.
        logger.warning("Model recommendation failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Model recommendation is temporarily unavailable",
        ) from exc
