from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query

from fastapi.responses import FileResponse

from .. import device_icons, miot_catalog
from ..schemas import (
    ActionRequest,
    CatalogSyncRequest,
    CatalogSyncStartResponse,
    DevicesResponse,
    DeviceDto,
    HomesResponse,
    HomeDto,
    ModelProductDto,
    PropGetRequest,
    PropSetRequest,
    RunSceneRequest,
    ScenesResponse,
    SceneDto,
    SyncIconsRequest,
    SyncIconsResponse,
)
from ..session import session

router = APIRouter(tags=["mijia"])


def _ensure_auth() -> None:
    if not session.is_authenticated():
        raise HTTPException(status_code=401, detail="Not authenticated")


@router.get("/homes", response_model=HomesResponse)
def list_homes() -> HomesResponse:
    _ensure_auth()
    try:
        homes = [HomeDto(**h) for h in session.list_homes()]
        return HomesResponse(homes=homes)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/devices", response_model=DevicesResponse)
def list_devices(home_id: Optional[str] = Query(default=None)) -> DevicesResponse:
    _ensure_auth()
    try:
        devices = [DeviceDto(**d) for d in session.list_devices(home_id=home_id)]
        return DevicesResponse(devices=devices)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/devices/{did}/snapshot")
def get_snapshot(did: str) -> dict[str, Any]:
    """Fast template payload: only essential props for common device kinds."""
    _ensure_auth()
    try:
        return session.get_snapshot(did)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/devices/{did}/capabilities")
def get_capabilities(
    did: str,
    include_values: bool = Query(default=True),
) -> dict[str, Any]:
    _ensure_auth()
    try:
        return session.get_capabilities(did, include_values=include_values)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/devices/{did}/switch")
def get_switch(did: str) -> dict[str, Any]:
    _ensure_auth()
    try:
        name = session.find_switch_prop(did)
        if not name:
            return {"name": None, "value": None}
        props = session.get_props(did, [name])
        return {"name": name, "value": props.get(name)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.put("/devices/{did}/switch")
def set_switch(did: str, body: dict[str, Any]) -> dict[str, Any]:
    _ensure_auth()
    try:
        value = bool(body.get("value"))
        name = session.find_switch_prop(did)
        if not name:
            raise RuntimeError("No writable switch property on this device")
        ok = session.set_prop(did, name, value)
        return {"ok": ok, "name": name, "value": value}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/devices/{did}/props")
def get_props(did: str, body: PropGetRequest) -> dict[str, Any]:
    _ensure_auth()
    try:
        return {"props": session.get_props(did, body.names)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.put("/devices/{did}/props")
def set_prop(did: str, body: PropSetRequest) -> dict[str, Any]:
    _ensure_auth()
    try:
        ok = session.set_prop(did, body.name, body.value)
        return {"ok": ok}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/devices/{did}/actions")
def run_action(did: str, body: ActionRequest) -> dict[str, Any]:
    _ensure_auth()
    try:
        ok = session.run_action(did, body.name, body.params)
        return {"ok": ok}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/scenes", response_model=ScenesResponse)
def list_scenes(home_id: Optional[str] = Query(default=None)) -> ScenesResponse:
    _ensure_auth()
    try:
        scenes = [SceneDto(**s) for s in session.list_scenes(home_id=home_id)]
        return ScenesResponse(scenes=scenes)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/scenes/{scene_id}/run")
def run_scene(scene_id: str, body: RunSceneRequest | None = None) -> dict[str, Any]:
    _ensure_auth()
    try:
        home_id = body.home_id if body else None
        ok = session.run_scene(scene_id, home_id=home_id)
        return {"ok": ok}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/consumables")
def list_consumables(home_id: Optional[str] = Query(default=None)) -> dict[str, Any]:
    _ensure_auth()
    try:
        return {"items": session.list_consumables(home_id=home_id)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/devices/{did}/scale/history")
def get_scale_history(
    did: str,
    model: Optional[str] = Query(default=None),
    limit: int = Query(default=30, ge=1, le=100),
) -> dict[str, Any]:
    """Body composition history from eco/scale cloud (weight, BMI, fat, muscle…)."""
    _ensure_auth()
    try:
        return session.get_scale_history(did, model=model, limit=limit)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/devices/{did}/abwheel/history")
def get_abwheel_history(
    did: str,
    model: Optional[str] = Query(default=None),
    days: int = Query(default=366, ge=1, le=366),
    limit: int = Query(default=100, ge=1, le=100),
) -> dict[str, Any]:
    """Ab-wheel workout history from eco/ym-sports (HAW) cloud."""
    _ensure_auth()
    try:
        return session.get_abwheel_history(did, model=model, days=days, limit=limit)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/devices/{did}/abwheel/period")
def get_abwheel_period(
    did: str,
    model: Optional[str] = Query(default=None),
    period: str = Query(default="week", pattern="^(week|month|year)$"),
    offset: int = Query(default=0, ge=-120, le=0),
) -> dict[str, Any]:
    """Week/month/year trend axis (includes zero days) for a selected offset."""
    _ensure_auth()
    try:
        return session.get_abwheel_period(
            did, model=model, period=period, offset=offset
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/devices/{did}/pcboot/logs")
def get_pcboot_op_logs(
    did: str,
    model: Optional[str] = Query(default=None),
    days: int = Query(default=180, ge=1, le=366),
    limit: int = Query(default=50, ge=1, le=100),
) -> dict[str, Any]:
    """HiPC boot-card cloud operation log (prop 3.6 onoff-log)."""
    _ensure_auth()
    try:
        return session.get_pcboot_op_logs(
            did, model=model, days=days, limit=limit
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/devices/{did}/speaker/now-playing")
def get_speaker_now_playing(did: str) -> dict[str, Any]:
    """Current track from MiNA cloud (title / artist / cover). Spec alone has no song name."""
    _ensure_auth()
    try:
        return session.get_speaker_now_playing(did)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/devices/{did}/power/history")
def get_plug_power_history(
    did: str,
    period: str = Query(default="week"),
    offset: int = Query(default=0, ge=-120, le=0),
) -> dict[str, Any]:
    """Plug electricity history for week / month / year charts."""
    _ensure_auth()
    if period not in {"week", "month", "year"}:
        raise HTTPException(status_code=400, detail="period must be week|month|year")
    try:
        return session.get_plug_power_history(did, period=period, offset=offset)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/models/{model}/product", response_model=ModelProductDto)
def get_model_product(
    model: str,
    refresh: bool = Query(default=False),
) -> ModelProductDto:
    """Product name / brand / icon URL from home.miot-spec.com (cached locally)."""
    try:
        if refresh or not device_icons.load_meta(model):
            device_icons.ensure_product(model, force=refresh)
        dto = device_icons.product_dto(model)
        if not dto:
            raise HTTPException(status_code=404, detail=f"No product info for {model}")
        return ModelProductDto(**dto)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/models/{model}/icon")
def get_model_icon(
    model: str,
    refresh: bool = Query(default=False),
) -> FileResponse:
    """Serve cached product icon. Never block the <img> path on network fetch."""
    try:
        path = device_icons.resolve_icon_file(model)
        if refresh or not path:
            # Background fill/refresh — keep GET fast for the UI
            device_icons.ensure_product_async(model, force=refresh)
        if not path:
            raise HTTPException(status_code=404, detail=f"No icon for {model}")
        media = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
            ".svg": "image/svg+xml",
        }.get(path.suffix.lower(), "application/octet-stream")
        # Must be inline — attachment breaks <img> in Electron/Chromium
        headers = {
            # Icons are content-addressed by model; allow long browser cache
            "Cache-Control": "public, max-age=604800, immutable",
        }
        if refresh:
            headers["Cache-Control"] = "no-store"
        return FileResponse(
            path,
            media_type=media,
            filename=path.name,
            content_disposition_type="inline",
            headers=headers,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/models/icons/sync", response_model=SyncIconsResponse)
def sync_model_icons(body: SyncIconsRequest) -> SyncIconsResponse:
    """
    Download icons + product params for given models (or all current devices if empty).
    Use force=true when product art may have updated on miot-spec.
    """
    _ensure_auth()
    try:
        models = list(body.models or [])
        if not models:
            models = [str(d.get("model") or "") for d in session.list_devices()]
        result = device_icons.sync_models(models, force=body.force)
        return SyncIconsResponse(**result)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/catalog/sync", response_model=CatalogSyncStartResponse)
def start_catalog_sync(body: CatalogSyncRequest) -> CatalogSyncStartResponse:
    """
    Background job: crawl home.miot-spec.com categories, download product icons
    and cache Spec trees under apps/bridge/data/ (rate-limited, serial downloads).
    """
    # Catalog sync does not require Mi account — public product library
    try:
        models = [m for m in (body.models or []) if m] or None
        result = miot_catalog.start_full_sync_async(
            icons=body.icons,
            specs=body.specs,
            force=body.force,
            models=models,
        )
        return CatalogSyncStartResponse(**result)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/catalog/status")
def catalog_sync_status() -> dict[str, Any]:
    return miot_catalog.get_status()


@router.get("/catalog/products")
def catalog_products(
    q: str = Query(default=""),
    category: str = Query(default=""),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    return miot_catalog.list_products(q=q, category=category, limit=limit, offset=offset)


@router.get("/catalog/products/{model}")
def catalog_product_detail(model: str, refresh: bool = Query(default=False)) -> dict[str, Any]:
    """Preset technical Spec (tree + urn) for a model."""
    try:
        data = miot_catalog.load_product_spec(model)
        if refresh or not data:
            data = miot_catalog.ensure_product_spec(model, force=refresh)
        if not data:
            raise HTTPException(status_code=404, detail=f"No catalog Spec for {model}")
        return data
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc
