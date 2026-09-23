"""ASGI application entry point."""

from vortex import Vortex

from app.listeners import LIFESPANS
from app.proxies import mount_litellm_proxy
from app.routers import ROUTERS
from app.web import mount_frontend

vortex = Vortex(
    routers=ROUTERS,
    lifespans=LIFESPANS,
    description="Centralized management API for DeputyDev CLI installations",
    version="0.1.0",
)
app = vortex.create_app()
mount_litellm_proxy(app)

# Must run after create_app(): the console is mounted at "/" as a catch-all, and
# Starlette matches routes in registration order, so every API route has to be
# registered first.
mount_frontend(app)
