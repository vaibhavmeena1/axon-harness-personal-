"""ASGI application entry point."""

from fastapi import FastAPI

from app.authentication import SessionRefreshResponseMiddleware
from app.core.config import get_settings
from app.core.logging import configure_application_logging
from app.listeners import lifespan
from app.proxies import mount_litellm_proxy
from app.routers import ROUTERS
from app.web import mount_frontend

configure_application_logging()
settings = get_settings()
app = FastAPI(
    title=settings.name,
    debug=settings.debug,
    lifespan=lifespan,
    description="Centralized management API for Axon CLI installations",
    version="0.1.1",
)
app.add_middleware(SessionRefreshResponseMiddleware)
for router in ROUTERS:
    app.include_router(router)
mount_litellm_proxy(app)

# Must run after the API routes: the console is mounted at "/" as a catch-all,
# and Starlette matches routes in registration order.
mount_frontend(app)
