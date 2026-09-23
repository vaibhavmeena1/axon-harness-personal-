"""Service health endpoints beyond Vortex's basic liveness check."""

from asyncpg import PostgresError
from fastapi import APIRouter, HTTPException, Request, status
from tortoise.exceptions import DBConnectionError, OperationalError

router = APIRouter(prefix="/api/v1/health", tags=["health"])


@router.get("/readiness", status_code=status.HTTP_200_OK)
async def readiness(request: Request) -> dict[str, str]:
    """Report readiness only when the database accepts a query."""
    database = getattr(request.app.state, "database", None)
    if database is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database is not initialized",
        )

    try:
        await database.execute_query("SELECT 1")
    except (DBConnectionError, OperationalError, PostgresError, OSError, RuntimeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database is unavailable",
        ) from exc

    return {"status": "ready"}
