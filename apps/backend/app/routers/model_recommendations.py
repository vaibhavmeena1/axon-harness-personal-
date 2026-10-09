"""Task-based coding-model recommendation endpoint."""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from app.authentication import require_authenticated_user
from app.clients.auth_service import AuthenticatedUser
from app.clients.litellm.identity import LiteLLMIdentityError
from app.services.model_recommendation import (
    ModelRecommendationError,
    ModelRecommendationRequest,
    ModelRecommendationResponse,
    ModelRecommendationService,
    get_model_recommendation_service,
)
from app.services.model_recommendation.catalog import is_model_recommendation_enabled
from app.services.model_recommendation.dependencies import get_model_recommendation_user
from app.telemetry import product_telemetry, verified_telemetry_identity

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/v1/model-recommendations",
    tags=["model-recommendations"],
    dependencies=[Depends(require_authenticated_user)],
)


@router.post(
    "",
    response_model=ModelRecommendationResponse,
    responses={status.HTTP_204_NO_CONTENT: {"description": "Recommendation is disabled for the current model"}},
)
async def recommend_model(
    request: ModelRecommendationRequest,
    user: Annotated[AuthenticatedUser, Depends(get_model_recommendation_user)],
    service: Annotated[
        ModelRecommendationService,
        Depends(get_model_recommendation_service),
    ],
    response: Response,
    http_request: Request,
) -> ModelRecommendationResponse | Response:
    """Recommend models available to the caller for a new coding task."""
    # The prompt may contain user content, so log only metadata Pi supplied for routing.
    logger.info(
        "Model recommendation request received with Pi model data: %s",
        request.model_dump(by_alias=True, exclude={"prompt"}),
    )

    telemetry = product_telemetry(http_request.app)
    identity = await verified_telemetry_identity(http_request)
    try:
        with telemetry.operation(
            "request", identity, **{"axon.recommendation.id": str(request.request_id)}
        ) as operation:
            if not is_model_recommendation_enabled(request.current_model):
                operation.skipped = True
                telemetry.event("eligible", "skipped", identity, reason="policy_disabled")
                return Response(status_code=status.HTTP_204_NO_CONTENT, headers=dict(response.headers))
            return await service.recommend(request, telemetry, identity, user=user)
    except LiteLLMIdentityError as exc:
        logger.warning("Model recommendation identity resolution failed (%s)", type(exc).__name__)
        raise HTTPException(
            status_code=exc.status_code,
            detail="LiteLLM access denied"
            if exc.status_code == 403
            else "Model recommendation identity is unavailable",
        ) from None
    except ModelRecommendationError as exc:
        # Do not export exception text or traceback locals: they can include the prompt.
        logger.warning("Model recommendation failed (%s)", type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Model recommendation is temporarily unavailable",
        ) from exc
