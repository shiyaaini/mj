from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str
    mode: Literal["live", "mock"]
    authenticated: bool
    version: str = "0.2.0"


class AuthStatusResponse(BaseModel):
    authenticated: bool
    user_id: Optional[str] = None
    status: Literal["idle", "pending", "success", "error"] = "idle"
    message: Optional[str] = None


class UserProfileResponse(BaseModel):
    authenticated: bool
    mode: Literal["live", "mock"] = "live"
    user_id: Optional[str] = None
    display_name: Optional[str] = None
    nickname: Optional[str] = None
    avatar_url: Optional[str] = None
    home_name: Optional[str] = None
    home_count: int = 0
    device_count: int = 0
    scene_count: int = 0
    login_time: Optional[int] = None
    expire_time: Optional[int] = None


class QrLoginStartResponse(BaseModel):
    status: Literal["authenticated", "pending", "error"]
    message: str
    qr_image_url: Optional[str] = None
    login_url: Optional[str] = None


class DeviceDto(BaseModel):
    id: str
    name: str
    model: str
    online: bool = True
    home_id: Optional[str] = None
    room_id: Optional[str] = None
    """Local Bridge URL for cached product icon, e.g. /models/{model}/icon"""
    icon_url: Optional[str] = None
    raw: dict[str, Any] = Field(default_factory=dict)


class ModelProductDto(BaseModel):
    model: str
    name: str = ""
    brand: str = ""
    icon: str = ""
    icon_url: Optional[str] = None
    href: str = ""
    plugin_download_href: str = ""
    source_url: str = ""
    updated_at: Optional[int] = None
    cached: bool = False


class SyncIconsRequest(BaseModel):
    models: list[str] = Field(default_factory=list)
    force: bool = False


class SyncIconsResponse(BaseModel):
    ok: list[str] = Field(default_factory=list)
    failed: list[str] = Field(default_factory=list)
    count: int = 0


class CatalogSyncRequest(BaseModel):
    """Bulk sync from home.miot-spec.com product library."""
    icons: bool = True
    specs: bool = True
    force: bool = False
    """If set, only these models; otherwise crawl full site catalog."""
    models: list[str] = Field(default_factory=list)


class CatalogSyncStartResponse(BaseModel):
    started: bool
    message: str
    status: dict[str, Any] = Field(default_factory=dict)


class DevicesResponse(BaseModel):
    devices: list[DeviceDto]


class HomeDto(BaseModel):
    id: str
    name: str
    rooms: list[dict[str, Any]] = Field(default_factory=list)
    raw: dict[str, Any] = Field(default_factory=dict)


class HomesResponse(BaseModel):
    homes: list[HomeDto]


class SceneDto(BaseModel):
    id: str
    name: str
    home_id: Optional[str] = None
    raw: dict[str, Any] = Field(default_factory=dict)


class ScenesResponse(BaseModel):
    scenes: list[SceneDto]


class PropGetRequest(BaseModel):
    names: list[str] = Field(default_factory=list)


class PropSetRequest(BaseModel):
    name: str
    value: Any


class ActionRequest(BaseModel):
    name: str
    params: list[Any] = Field(default_factory=list)


class RunSceneRequest(BaseModel):
    home_id: Optional[str] = None
