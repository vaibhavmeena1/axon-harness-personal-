"""HTTP router registration."""

from fastapi import APIRouter

from app.routers.cli_releases import router as cli_releases_router
from app.routers.health import ping_router
from app.routers.health import router as health_router
from app.routers.install import router as install_router
from app.routers.model_recommendations import router as model_recommendations_router

ROUTERS: list[APIRouter] = [
    health_router,
    model_recommendations_router,
    ping_router,
    install_router,
    cli_releases_router,
]
