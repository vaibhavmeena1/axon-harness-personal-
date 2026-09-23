"""Serve the built console SPA from the same origin as the API.

The frontend is a Vite build: an `index.html` plus content-hashed files under
`assets/`. Serving it here keeps one origin, one deploy, and one version for the
API and the console, which removes CORS and frontend/backend version skew.

Two behaviours a plain `StaticFiles` mount does not provide:

1. Client-side routes. A deep link such as `/installations/42` has no file on
   disk and must return `index.html` so the router can resolve it in the browser.
2. Correct caching. `assets/` filenames carry a content hash and can be cached
   permanently, while `index.html` points at those hashes and must never be
   cached, or a deploy would keep serving the previous build's asset names.
"""

import logging
from pathlib import Path

from fastapi import FastAPI
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import FileResponse, PlainTextResponse, Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

from app.core.config import get_settings

logger = logging.getLogger(__name__)

INDEX_FILE = "index.html"
ASSETS_PREFIX = "assets/"
API_PREFIX = "api/"
IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"
NO_STORE_CACHE_CONTROL = "no-cache, no-store, must-revalidate"


class SinglePageApplication(StaticFiles):
    """Static files with an `index.html` fallback for client-side routes."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404:
                raise
            return await self._fallback(path, scope)

        if response.status_code == 404:
            return await self._fallback(path, scope)

        if path.startswith(ASSETS_PREFIX):
            response.headers["cache-control"] = IMMUTABLE_CACHE_CONTROL
        elif path in ("", ".", INDEX_FILE):
            response.headers["cache-control"] = NO_STORE_CACHE_CONTROL
        return response

    async def _fallback(self, path: str, scope: Scope) -> Response:
        """Return `index.html` for unknown paths, but keep real 404s real.

        A miss under `assets/` means a stale or wrong asset URL, and a miss under
        `api/` means an unregistered endpoint. Answering either with `index.html`
        would turn a clear 404 into an HTML page that the caller cannot use.

        The 404 is returned directly rather than raised. Vortex installs a global
        `HTTPException` handler whose legacy status mapping rewrites 404 to 400
        and wraps the body in the API error envelope — wrong for a static asset,
        which browsers and CDNs cache and retry based on a true 404.
        """
        if path.startswith(ASSETS_PREFIX) or path.startswith(API_PREFIX):
            return PlainTextResponse("Not Found", status_code=404)

        response = await super().get_response(INDEX_FILE, scope)
        if isinstance(response, FileResponse):
            response.headers["cache-control"] = NO_STORE_CACHE_CONTROL
        return response


def mount_frontend(app: FastAPI) -> None:
    """Mount the built frontend at `/`, if it has been built.

    Mounting at `/` is safe only because this runs after `create_app()` has
    registered every router: Starlette matches routes in registration order, so
    the API, docs, and health routes are all matched before this catch-all.

    A missing build directory is not an error. The backend runs on its own during
    local development, where the console is served by `vite dev` instead.
    """
    directory: Path = get_settings().frontend_dir

    if not (directory / INDEX_FILE).is_file():
        logger.info(
            "Frontend build not found at %s; serving the API only.",
            directory,
        )
        return

    app.mount("/", SinglePageApplication(directory=directory), name="console")
    logger.info("Serving the console frontend from %s", directory)
