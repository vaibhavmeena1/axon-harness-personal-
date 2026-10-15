"""Backend orchestration for Jev-powered model recommendations."""

from app.clients.auth_service import AuthenticatedUser
from app.clients.litellm.decisions import LiteLLMDecisionClient, LiteLLMDecisionError
from app.clients.litellm.identity import LiteLLMIdentityClient
from app.core.config import ModelRecommenderSettings
from app.services.model_recommendation.catalog import model_policy_version
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
from app.telemetry import ProductTelemetry, product_telemetry


class ModelRecommendationError(RuntimeError):
    """Raised when a recommendation cannot be produced from Jev's response."""


class ModelRecommendationService:
    """Assess a user task with Jev and rank the models available to Pi."""

    def __init__(
        self,
        decision_client: LiteLLMDecisionClient,
        identity_client: LiteLLMIdentityClient,
        settings: ModelRecommenderSettings,
    ) -> None:
        self._decision_client = decision_client
        self._identity_client = identity_client
        self._settings = settings

    async def recommend(
        self,
        request: ModelRecommendationRequest,
        telemetry: ProductTelemetry | None = None,
        identity: dict | None = None,
        *,
        user: AuthenticatedUser,
    ) -> ModelRecommendationResponse:
        """Return compatible models ordered by task fit."""
        telemetry = telemetry or product_telemetry()
        policy = model_policy_version()
        try:
            with telemetry.operation("assessment", identity, **{"axon.recommendation.id": str(request.request_id)}):
                # Recommendations always require a virtual key, even when the proxy
                # is configured to use shared credentials. Never use authenticated_key
                # here: it returns the admin key when identity sync is disabled.
                api_key = await self._identity_client.ensure_identity(user)
                jev_response = await self._decision_client.create_decision(
                    build_jev_request(request.prompt, model=self._settings.classifier_model), api_key=api_key
                )
                assessment = parse_jev_assessment(jev_response)
            with telemetry.operation("ranking", identity):
                recommendations = rank_available_models(request, assessment)
        except (LiteLLMDecisionError, JevAssessmentError, ValueError) as exc:
            raise ModelRecommendationError(str(exc)) from exc

        telemetry.event(
            "assessed",
            "success",
            identity,
            complexity=assessment.complexity,
            confidence=assessment.complexity_confidence,
            high_complexity_probability=assessment.high_complexity_probability,
            needs_deep_reasoning=assessment.needs_deep_reasoning,
            prioritizes_speed=assessment.prioritizes_speed,
        )
        telemetry.event(
            "recommended",
            "success",
            identity,
            model=f"{recommendations[0].provider}/{recommendations[0].id}" if recommendations else "none",
            policy_version=policy,
            candidate_count=len(recommendations),
        )
        return ModelRecommendationResponse(
            request_id=request.request_id,
            policy_version=policy,
            recommendations=recommendations,
            assessment=TaskAssessment(
                complexity=assessment.complexity,
                complexity_confidence=assessment.complexity_confidence,
                high_complexity_probability=assessment.high_complexity_probability,
                needs_deep_reasoning=assessment.needs_deep_reasoning,
                prioritizes_speed=assessment.prioritizes_speed,
            ),
        )
