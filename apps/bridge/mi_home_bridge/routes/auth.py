from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..schemas import (
    AuthStatusResponse,
    QrLoginStartResponse,
    UserProfileResponse,
)
from ..session import session

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/status", response_model=AuthStatusResponse)
def auth_status() -> AuthStatusResponse:
    data = session.auth_status()
    return AuthStatusResponse(
        authenticated=data["authenticated"],
        user_id=data.get("user_id"),
        status=data.get("status") or "idle",
        message=data.get("message"),
    )


@router.get("/profile", response_model=UserProfileResponse)
def user_profile() -> UserProfileResponse:
    try:
        return UserProfileResponse(**session.user_profile())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/qr/start", response_model=QrLoginStartResponse)
def start_qr_login() -> QrLoginStartResponse:
    try:
        data = session.start_qr_login()
        return QrLoginStartResponse(**data)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/qr/status")
def qr_status() -> dict:
    return session.auth_status()


@router.post("/logout")
def logout() -> dict[str, bool]:
    session.logout()
    return {"ok": True}
