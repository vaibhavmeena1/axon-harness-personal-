"""Backend orchestration for Jev-powered model recommendations."""

from app.clients.openrouter import OpenRouterClient
from app.services.model_recommendation.jev import (
    JevAssessmentError,
    build_jev_request,
    parse_jev_assessment,
)
from app.services.model_recommendation.ranking import rank_available_models
from app.services.model_recommendation.schemas import (
    ModelRecommendationRequest,
    ModelRecommendationResponse,
    TaskAssessment,
)


class ModelRecommendationError(RuntimeError):
    """Raised when a recommendation cannot be produced from Jev's response."""


class ModelRecommendationService:
    """Assess a user task with Jev and rank the models available to Pi."""

    def __init__(self, openrouter_client: OpenRouterClient) -> None:
        self._openrouter_client = openrouter_client

    async def recommend(
        self,
        request: ModelRecommendationRequest,
    ) -> ModelRecommendationResponse:
        """Return compatible models ordered by task fit."""
        jev_response = await self._openrouter_client.create_decision(build_jev_request(request.prompt))
        try:
            assessment = parse_jev_assessment(jev_response)
            recommendations = rank_available_models(request, assessment)
        except (JevAssessmentError, ValueError) as exc:
            raise ModelRecommendationError(str(exc)) from exc

        return ModelRecommendationResponse(
            recommendations=recommendations,
            assessment=TaskAssessment(
                complexity=assessment.complexity,
                complexity_confidence=assessment.complexity_confidence,
                high_complexity_probability=assessment.high_complexity_probability,
                needs_deep_reasoning=assessment.needs_deep_reasoning,
                prioritizes_speed=assessment.prioritizes_speed,
            ),
        )
