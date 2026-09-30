"""Local HTTP bridge for mijiaAPI.

Exposes auth / homes / devices / scenes endpoints for the Electron UI.
"""

from __future__ import annotations

# Must run before imports that create requests.Session (inherits proxy env).
from mi_home_bridge.proxy_bypass import apply_proxy_bypass

apply_proxy_bypass()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from mi_home_bridge import __version__
from mi_home_bridge.config import settings
from mi_home_bridge.routes import api_router
from mi_home_bridge.schemas import HealthResponse
from mi_home_bridge.session import session

app = FastAPI(
    title="Mi Home Bridge",
    version=__version__,
    description=(
        "本机米家 Bridge HTTP API（Python + mijiaAPI）。"
        "默认仅监听 127.0.0.1；Swagger UI：`/docs`，ReDoc：`/redoc`。"
    ),
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        mode="mock" if settings.mock_mode else "live",
        authenticated=session.is_authenticated(),
        version=__version__,
    )


def main() -> None:
    import uvicorn

    # Pass the app object (not "main:app") so PyInstaller frozen exe works.
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
