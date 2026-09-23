"""Errors raised by the OpenRouter client."""


class OpenRouterError(Exception):
    """Base error for OpenRouter requests and responses."""


class OpenRouterTransportError(OpenRouterError):
    """Raised when OpenRouter cannot be reached."""


class OpenRouterResponseError(OpenRouterError):
    """Raised when OpenRouter returns a malformed response."""


class OpenRouterAPIError(OpenRouterError):
    """Raised when OpenRouter returns a non-success HTTP response."""

    def __init__(
        self,
        status_code: int,
        message: str,
        *,
        request_id: str | None = None,
    ) -> None:
        self.status_code = status_code
        self.request_id = request_id
        request_suffix = f" (request ID: {request_id})" if request_id else ""
        super().__init__(f"OpenRouter returned HTTP {status_code}: {message}{request_suffix}")
