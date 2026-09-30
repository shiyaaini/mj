from __future__ import annotations

import json
import threading
import time
import warnings
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from mijiaAPI import LoginError, mijiaAPI, mijiaDevice
from mijiaAPI.errors import APIError
from mijiaAPI.miutils import decrypt, gen_nonce, generate_enc_params, get_signed_nonce
from urllib3.exceptions import InsecureRequestWarning

from .config import settings
from . import miot_spec
from .mi_health import mi_health_client
from .mina import mina_client, normalize_now_playing

# Bridge sets requests session.verify=False (MITM / broken CA during refresh).
# Silence the per-request urllib3 spam; TLS is intentionally unverified here.
warnings.filterwarnings("ignore", category=InsecureRequestWarning)

_CST = timezone(timedelta(hours=8))
_ABWHEEL_DEVICE_TYPE = "HAW"
_ABWHEEL_TZ_OFFSET = -480  # minutes; matches Mi Home Android client (UTC+8)


def _prepare_http_session(api: mijiaAPI) -> None:
    """Direct connect: ignore system / env HTTP proxies."""
    api.session.verify = False
    api.session.trust_env = False
    api.session.proxies = {}


class BridgeSession:
    """Process-local mijiaAPI session with async QR login."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._api: Optional[mijiaAPI] = None
        self._login_api: Optional[mijiaAPI] = None
        self._login_thread: Optional[threading.Thread] = None
        self._login_status: dict[str, Any] = {"status": "idle", "message": None}
        self._qr_image_url: Optional[str] = None
        self._login_url: Optional[str] = None
        self._device_spec_types: dict[str, str] = {}
        self._bootstrap()

    def _bootstrap(self) -> None:
        if settings.mock_mode:
            return
        api = mijiaAPI(auth_data_path=str(settings.auth_path))
        # Local MITM (Reqable) breaks default CA chain during token refresh.
        _prepare_http_session(api)
        if api.auth_data and getattr(api, "available", False):
            self._api = api
        elif settings.auth_path.exists():
            # Keep instance for refresh / later use even if not currently available
            self._api = api
            try:
                api._refresh_token()
            except Exception:
                pass

    @property
    def mode(self) -> str:
        return "mock" if settings.mock_mode else "live"

    def is_authenticated(self) -> bool:
        if settings.mock_mode:
            return True
        with self._lock:
            api = self._api
            if api is None:
                return False
            try:
                if getattr(api, "available", False):
                    return True
                # auth.json may load with available=False until token refresh
                _prepare_http_session(api)
                api._refresh_token()
                return bool(getattr(api, "available", False))
            except Exception:
                return False

    def user_id(self) -> Optional[str]:
        with self._lock:
            if self._api and self._api.auth_data:
                return str(self._api.auth_data.get("userId") or "") or None
            return None

    def user_profile(self) -> dict[str, Any]:
        """Safe account summary for the Profile / Settings UI (no tokens)."""
        empty = {
            "authenticated": False,
            "mode": "live",
            "user_id": None,
            "display_name": None,
            "avatar_url": None,
            "nickname": None,
            "home_name": None,
            "home_count": 0,
            "device_count": 0,
            "scene_count": 0,
            "login_time": None,
            "expire_time": None,
        }
        if settings.mock_mode:
            return {
                **empty,
                "authenticated": True,
                "mode": "mock",
                "user_id": "demo-user",
                "display_name": "演示用户",
                "nickname": "演示用户",
                "home_count": 1,
            }

        if not self.is_authenticated():
            return empty

        api = self.require_api()
        auth = api.auth_data or {}
        user_id = str(auth.get("userId") or "") or None

        nickname: Optional[str] = None
        avatar_url: Optional[str] = None
        if user_id:
            try:
                # Mi Home cloud profile: nickname + avatar icon
                profile = api._request("/home/profile", {"id": user_id})
                if isinstance(profile, dict):
                    nickname = str(profile.get("nickname") or "").strip() or None
                    avatar_url = str(profile.get("icon") or "").strip() or None
            except Exception:
                pass

        home_name: Optional[str] = None
        home_count = 0
        device_count = 0
        scene_count = 0
        try:
            homes = self.list_homes()
            home_count = len(homes)
            if homes:
                raw_name = str(homes[0].get("name") or "").strip()
                if raw_name and raw_name != user_id:
                    home_name = raw_name
        except Exception:
            pass
        try:
            device_count = len(self.list_devices())
        except Exception:
            pass
        try:
            scene_count = len(self.list_scenes())
        except Exception:
            pass

        login_time = auth.get("saveTime")
        expire_time = auth.get("expireTime")
        try:
            login_time = int(login_time) if login_time is not None else None
        except (TypeError, ValueError):
            login_time = None
        try:
            expire_time = int(expire_time) if expire_time is not None else None
        except (TypeError, ValueError):
            expire_time = None

        return {
            "authenticated": True,
            "mode": "live",
            "user_id": user_id,
            "display_name": nickname,
            "nickname": nickname,
            "avatar_url": avatar_url,
            "home_name": home_name,
            "home_count": home_count,
            "device_count": device_count,
            "scene_count": scene_count,
            "login_time": login_time,
            "expire_time": expire_time,
        }

    def require_api(self) -> mijiaAPI:
        if settings.mock_mode:
            raise RuntimeError("Bridge is running in mock mode")
        with self._lock:
            if self._api is None:
                raise RuntimeError("Not authenticated. Please complete QR login first.")
            _prepare_http_session(self._api)
            if not getattr(self._api, "available", False):
                try:
                    self._api._refresh_token()
                except Exception:
                    pass
            if not getattr(self._api, "available", False):
                raise RuntimeError("Not authenticated. Please complete QR login first.")
            return self._api

    def auth_status(self) -> dict[str, Any]:
        with self._lock:
            status = self._login_status.get("status", "idle")
            message = self._login_status.get("message")
            if status == "success" and self._login_api is not None:
                self._api = self._login_api
                self._login_api = None
                self._login_thread = None
                self._login_status = {"status": "idle", "message": None}
                self._qr_image_url = None
                self._login_url = None
                status = "idle"
                message = "登录成功"
            elif status == "error":
                err = message or "登录失败"
                self._login_api = None
                self._login_thread = None
                self._login_status = {"status": "idle", "message": None}
                self._qr_image_url = None
                self._login_url = None
                return {
                    "authenticated": self.is_authenticated(),
                    "user_id": self.user_id(),
                    "status": "error",
                    "message": err,
                    "qr_image_url": None,
                    "login_url": None,
                }

            return {
                "authenticated": self.is_authenticated(),
                "user_id": self.user_id(),
                "status": status,
                "message": message,
                "qr_image_url": self._qr_image_url,
                "login_url": self._login_url,
            }

    def start_qr_login(self) -> dict[str, Any]:
        if settings.mock_mode:
            return {
                "status": "authenticated",
                "message": "Mock mode: already authenticated",
                "qr_image_url": None,
                "login_url": None,
            }

        with self._lock:
            if self._login_thread is not None and self._login_thread.is_alive():
                return {
                    "status": "pending",
                    "message": "QR login already in progress",
                    "qr_image_url": self._qr_image_url,
                    "login_url": self._login_url,
                }

            if self._api is not None:
                try:
                    if getattr(self._api, "available", False):
                        return {
                            "status": "authenticated",
                            "message": "Already authenticated",
                            "qr_image_url": None,
                            "login_url": None,
                        }
                    self._api._refresh_token()
                    if getattr(self._api, "available", False):
                        return {
                            "status": "authenticated",
                            "message": "Token refreshed",
                            "qr_image_url": None,
                            "login_url": None,
                        }
                except LoginError:
                    pass

            new_api = mijiaAPI(auth_data_path=str(settings.auth_path))
            login_data = new_api._get_qr_login_data()
            if login_data.get("refreshed"):
                self._api = new_api
                return {
                    "status": "authenticated",
                    "message": "Token refreshed",
                    "qr_image_url": None,
                    "login_url": None,
                }

            self._login_api = new_api
            self._qr_image_url = login_data.get("qr")
            self._login_url = login_data.get("loginUrl")
            self._login_status = {"status": "pending", "message": "Waiting for scan"}
            self._login_thread = threading.Thread(
                target=self._login_worker,
                args=(new_api, login_data),
                daemon=True,
            )
            self._login_thread.start()
            return {
                "status": "pending",
                "message": "Scan the QR code with Mi Home app within 2 minutes",
                "qr_image_url": self._qr_image_url,
                "login_url": self._login_url,
            }

    def _login_worker(self, api: mijiaAPI, login_data: dict[str, Any]) -> None:
        try:
            api._complete_qr_login(login_data)
            with self._lock:
                self._login_status = {"status": "success", "message": "Login success"}
        except LoginError as exc:
            with self._lock:
                self._login_status = {"status": "error", "message": f"Login failed: {exc}"}
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                self._login_status = {"status": "error", "message": f"Login failed: {exc}"}

    def logout(self) -> None:
        with self._lock:
            self._api = None
            self._login_api = None
            self._login_thread = None
            self._login_status = {"status": "idle", "message": None}
            self._qr_image_url = None
            self._login_url = None
            if settings.auth_path.exists():
                settings.auth_path.unlink()
        mina_client.clear()
        mi_health_client.clear()

    def list_homes(self) -> list[dict[str, Any]]:
        api = self.require_api()
        homes = api.get_homes_list() or []
        result: list[dict[str, Any]] = []
        for home in homes:
            result.append(
                {
                    "id": str(home.get("id") or home.get("home_id") or ""),
                    "name": str(home.get("name") or "Home"),
                    "rooms": home.get("roomlist") or home.get("rooms") or [],
                    "raw": home,
                }
            )
        return result

    def list_devices(self, home_id: Optional[str] = None) -> list[dict[str, Any]]:
        api = self.require_api()
        devices = api.get_devices_list(home_id=home_id) if home_id else api.get_devices_list()
        devices = devices or []

        # Xiaomi device list often omits roomId; membership lives on room.dids
        room_names: dict[str, str] = {}
        did_to_room: dict[str, str] = {}
        try:
            for home in api.get_homes_list() or []:
                for room in home.get("roomlist") or home.get("rooms") or []:
                    rid = str(room.get("id") or room.get("roomId") or "")
                    rname = str(room.get("name") or "")
                    if rid and rname:
                        room_names[rid] = rname
                    if not rid:
                        continue
                    for did in room.get("dids") or []:
                        did_s = str(did).strip()
                        if did_s and did_s not in did_to_room:
                            did_to_room[did_s] = rid
        except Exception:
            room_names = {}
            did_to_room = {}

        from . import device_icons

        result: list[dict[str, Any]] = []
        models_seen: set[str] = set()
        for device in devices:
            did = str(device.get("did") or "")
            room_id = str(device.get("roomId") or device.get("rid") or "") or None
            if not room_id and did:
                room_id = did_to_room.get(did)
            model = str(device.get("model") or "")
            spec_type = str(device.get("spec_type") or "") or None
            if did and spec_type:
                self._device_spec_types[did] = spec_type
            icon_url = device_icons.icon_url_for_model(model) if model else None
            if model and model not in models_seen:
                models_seen.add(model)
                # Background download / refresh when product icon is missing
                device_icons.ensure_product_async(model, force=False)
            result.append(
                {
                    "id": did,
                    "name": str(device.get("name") or "Device"),
                    "model": model,
                    "online": bool(device.get("isOnline", device.get("online", True))),
                    "home_id": str(device.get("homeId") or device.get("home_id") or "") or None,
                    "room_id": room_id,
                    "icon_url": icon_url,
                    "raw": {
                        **device,
                        "_room_name": room_names.get(room_id or "", None),
                    },
                }
            )
        return result

    def _spec_type_for(self, did: str) -> Optional[str]:
        if did in self._device_spec_types:
            return self._device_spec_types[did]
        try:
            self.list_devices()
        except Exception:
            return None
        return self._device_spec_types.get(did)

    def _action_in_defs(self, did: str, siid: int, aiid: int) -> list[dict[str, Any]]:
        spec_type = self._spec_type_for(did)
        if not spec_type:
            return []
        spec = miot_spec.load_instance_spec(spec_type)
        if not spec:
            return []
        return miot_spec.action_in_defs(spec, siid, aiid)

    def list_scenes(self, home_id: Optional[str] = None) -> list[dict[str, Any]]:
        api = self.require_api()
        if home_id:
            scenes = api.get_scenes_list(home_id=home_id) or []
            return [
                {
                    "id": str(s.get("scene_id") or s.get("id") or ""),
                    "name": str(s.get("name") or "Scene"),
                    "home_id": home_id,
                    "raw": s,
                }
                for s in scenes
            ]

        all_scenes: list[dict[str, Any]] = []
        for home in self.list_homes():
            hid = home["id"]
            if not hid:
                continue
            scenes = api.get_scenes_list(home_id=hid) or []
            for scene in scenes:
                all_scenes.append(
                    {
                        "id": str(scene.get("scene_id") or scene.get("id") or ""),
                        "name": str(scene.get("name") or "Scene"),
                        "home_id": hid,
                        "raw": scene,
                    }
                )
        return all_scenes

    def run_scene(self, scene_id: str, home_id: Optional[str] = None) -> bool:
        api = self.require_api()
        if not home_id:
            for scene in self.list_scenes():
                if scene["id"] == scene_id:
                    home_id = scene.get("home_id")
                    break
        if not home_id:
            raise RuntimeError("home_id is required to run scene")
        return bool(api.run_scene(scene_id, home_id))

    def get_device(self, did: str, sleep_time: float = 0.0) -> mijiaDevice:
        api = self.require_api()
        return mijiaDevice(api, did=did, sleep_time=sleep_time)

    def _iter_unique_props(self, device: mijiaDevice) -> list[Any]:
        props: list[Any] = []
        seen: set[str] = set()
        for name, prop in device.prop_list.items():
            if "_" in name and name.replace("_", "-") in device.prop_list:
                continue
            if name in seen:
                continue
            seen.add(name)
            props.append((name, prop))
        return props

    def _prop_meta(
        self,
        name: str,
        prop: Any,
        access_index: Optional[dict[tuple[int, int], dict[str, Any]]] = None,
    ) -> dict[str, Any]:
        rw = getattr(prop, "rw", "") or ""
        if isinstance(rw, list):
            rw = "".join(rw)
        fetchable = "r" in str(rw)
        method = getattr(prop, "method", None) or {}
        try:
            siid = int(method.get("siid")) if method.get("siid") is not None else None
            piid = int(method.get("piid")) if method.get("piid") is not None else None
        except (TypeError, ValueError):
            siid = piid = None
        if access_index and siid is not None and piid is not None:
            hit = access_index.get((siid, piid))
            if hit:
                if not rw:
                    rw = hit.get("rw") or rw
                fetchable = bool(hit.get("fetchable"))
        return {
            "name": name,
            "desc": getattr(prop, "desc", name),
            "type": getattr(prop, "type", "string"),
            "rw": rw,
            "range": getattr(prop, "range", None),
            "value_list": getattr(prop, "value_list", None),
            "fetchable": fetchable,
        }

    def _access_index_for_device(self, device: mijiaDevice) -> dict[tuple[int, int], dict[str, Any]]:
        did = str(getattr(device, "did", "") or "")
        model = str(getattr(device, "model", "") or "")
        spec_type = self._spec_type_for(did) if did else None
        if not spec_type:
            spec_type = str(getattr(device, "spec_type", "") or "") or None
        if not spec_type and model:
            try:
                from . import miot_catalog

                cached = miot_catalog.load_product_spec(model) or {}
                urn = str((cached.get("spec") or {}).get("urn") or "")
                if not urn:
                    versions = cached.get("versions") or []
                    if versions:
                        urn = str((versions[0] or {}).get("urn") or "")
                if urn:
                    spec_type = urn
                    if did:
                        self._device_spec_types[did] = urn
            except Exception:
                spec_type = None
        if not spec_type:
            return {}
        spec = miot_spec.load_instance_spec(spec_type)
        if not spec:
            return {}
        return miot_spec.build_prop_access_index(spec)

    def get_snapshot(self, did: str) -> dict[str, Any]:
        """Return a small, template-friendly state payload quickly."""
        device = self.get_device(did, sleep_time=0.0)
        model = str(getattr(device, "model", "") or "").lower()
        name = str(getattr(device, "name", "") or "")

        kind = "generic"
        if any(k in model for k in ("light", "lamp", "bulb", "yeelink")):
            kind = "light"
        elif "hipc.plug" in model:
            kind = "pc-boot"
        elif any(k in model for k in ("plug", "outlet", "socket", "cuco.plug")):
            kind = "plug"
        elif any(k in model for k in ("airp", "airpurifier", "air-purifier")):
            kind = "air-purifier"
        elif "vacuum" in model or "sweeper" in model:
            kind = "vacuum"

        wanted: list[str] = []
        if kind == "light":
            wanted = ["on", "brightness", "color-temperature", "color_temperature", "ct"]
        elif kind == "pc-boot":
            wanted = [
                "on",
                "status",
                "children-lock",
                "children_lock",
                "indicate-off",
                "indicate_off",
            ]
        elif kind == "plug":
            wanted = [
                "on",
                "on-2",
                "on_2",
                "electric-power",
                "electric_power",
                "power-consumption",
                "power_consumption",
                "on-8",
                "on_8",
                "duration",
                "left-time",
                "left_time",
                "status",
                "data-value",
                "data_value",
                "temperature",
            ]
        elif kind == "air-purifier":
            wanted = ["on", "mode", "pm2_5", "pm25", "temperature", "relative_humidity", "humidity"]
        else:
            wanted = ["on", "on-2", "brightness", "battery"]

        # Keep only props that exist on this device
        existing = []
        for prop_name in wanted:
            if prop_name in device.prop_list:
                existing.append(prop_name)
            elif prop_name.replace("_", "-") in device.prop_list:
                existing.append(prop_name.replace("_", "-"))

        # Unique preserve order
        seen: set[str] = set()
        prop_names: list[str] = []
        for n in existing:
            if n not in seen:
                seen.add(n)
                prop_names.append(n)

        values = self.get_props(did, prop_names) if prop_names else {}

        # Normalize switch
        switch_name = None
        switch_value = None
        for candidate in ("on", "on-2", "on_2"):
            if candidate in values:
                switch_name = candidate
                switch_value = bool(values[candidate])
                break
        if switch_name is None:
            switch_name = self.find_switch_prop(did)
            if switch_name:
                try:
                    got = self.get_props(did, [switch_name])
                    switch_value = bool(got.get(switch_name)) if switch_name in got else None
                    if switch_name in got:
                        values[switch_name] = got[switch_name]
                except Exception:
                    pass

        if kind == "plug":
            try:
                values.update(self.get_plug_power_cost(did, device=device))
            except Exception:
                pass

        return {
            "did": did,
            "name": name,
            "model": getattr(device, "model", None),
            "kind": kind,
            "switch": {"name": switch_name, "value": switch_value},
            "values": values,
        }

    def _power_cost_key(self, device: mijiaDevice) -> Optional[str]:
        for name in ("power-consumption", "power_consumption"):
            prop = device.prop_list.get(name)
            if prop is None:
                continue
            method = getattr(prop, "method", None)
            if isinstance(method, dict) and method.get("siid") is not None and method.get("piid") is not None:
                return f"{method['siid']}.{method['piid']}"
        return None

    @staticmethod
    def _parse_stat_value(raw: Any) -> Optional[float]:
        try:
            if isinstance(raw, str):
                parsed = json.loads(raw)
            else:
                parsed = raw
            if isinstance(parsed, list) and parsed:
                return float(parsed[0])
            return float(parsed)
        except (TypeError, ValueError, json.JSONDecodeError):
            return None

    def get_plug_power_cost(
        self,
        did: str,
        device: Optional[mijiaDevice] = None,
        ratio: float = 0.01,
    ) -> dict[str, Any]:
        """Daily / monthly energy from /v2/user/statistics (same source as Mi Home app)."""
        api = self.require_api()
        if device is None:
            device = self.get_device(did, sleep_time=0.0)
        key = self._power_cost_key(device)
        if not key:
            return {}

        now = int(time.time())
        day_start = now - 2 * 86400
        month_start = now - 31 * 86400
        today_kwh: Optional[float] = None
        month_kwh: Optional[float] = None

        try:
            days = api._request(
                "/v2/user/statistics",
                {
                    "did": did,
                    "data_type": "stat_day_v3",
                    "key": key,
                    "time_start": month_start,
                    "time_end": now,
                    "limit": 31,
                },
            )
            if isinstance(days, list) and days:
                # API returns newest first
                today_raw = self._parse_stat_value(days[0].get("value"))
                if today_raw is not None:
                    today_kwh = round(today_raw * ratio, 3)
                total = 0.0
                for item in days:
                    if not isinstance(item, dict):
                        continue
                    v = self._parse_stat_value(item.get("value"))
                    if v is not None:
                        total += v
                month_kwh = round(total * ratio, 3)
        except Exception:
            # Fallback: try month aggregate only
            try:
                months = api._request(
                    "/v2/user/statistics",
                    {
                        "did": did,
                        "data_type": "stat_month_v3",
                        "key": key,
                        "time_start": now - 400 * 86400,
                        "time_end": now,
                        "limit": 2,
                    },
                )
                if isinstance(months, list) and months:
                    # Prefer previous full month if current month looks tiny
                    raw = self._parse_stat_value(months[0].get("value"))
                    if len(months) > 1:
                        prev = self._parse_stat_value(months[1].get("value"))
                        if raw is not None and prev is not None and raw < prev * 0.2:
                            raw = prev
                    if raw is not None:
                        month_kwh = round(raw * ratio, 3)
            except Exception:
                pass

        # Ignore unused day_start (kept for clarity / future)
        _ = day_start

        out: dict[str, Any] = {}
        if today_kwh is not None:
            out["power_cost_today"] = today_kwh
        if month_kwh is not None:
            out["power_cost_month"] = month_kwh
        return out

    def _fetch_stat_map(
        self,
        did: str,
        key: str,
        data_type: str,
        time_start: int,
        time_end: int,
        limit: int,
        ratio: float,
    ) -> dict[int, float]:
        api = self.require_api()
        raw = api._request(
            "/v2/user/statistics",
            {
                "did": did,
                "data_type": data_type,
                "key": key,
                "time_start": time_start,
                "time_end": time_end,
                "limit": limit,
            },
        )
        result: dict[int, float] = {}
        if not isinstance(raw, list):
            return result
        for item in raw:
            if not isinstance(item, dict):
                continue
            try:
                ts = int(item.get("time") or 0)
            except (TypeError, ValueError):
                continue
            val = self._parse_stat_value(item.get("value"))
            if val is None:
                continue
            result[ts] = round(val * ratio, 4)
        return result

    def get_plug_power_history(
        self,
        did: str,
        period: str = "week",
        offset: int = 0,
        ratio: float = 0.01,
    ) -> dict[str, Any]:
        """
        Electricity history for charts.
        - week: 7 rolling days for selected window
        - month: each day of selected calendar month
        - year: each month of selected calendar year
        offset: 0=current, -1=previous period, ...
        """
        period = (period or "week").lower().strip()
        if period not in {"week", "month", "year"}:
            raise ValueError("period must be week|month|year")
        offset = int(offset or 0)

        device = self.get_device(did, sleep_time=0.0)
        key = self._power_cost_key(device)
        if not key:
            raise RuntimeError("No power-consumption property on this device")

        now = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        points: list[dict[str, Any]] = []
        start_dt: datetime
        end_dt: datetime
        label = ""

        if period == "week":
            # Rolling 7-day window ending today (offset shifts by weeks)
            end_dt = now + timedelta(days=offset * 7)
            start_dt = end_dt - timedelta(days=6)
            label = f"{start_dt.strftime('%m/%d')}-{end_dt.strftime('%m/%d')}"
            time_start = int((start_dt - timedelta(days=1)).timestamp())
            time_end = int((end_dt + timedelta(days=2)).timestamp())
            raw_map = self._fetch_stat_map(
                did, key, "stat_day_v3", time_start, time_end, 14, ratio
            )
            # Index by local date string
            by_day = {
                datetime.fromtimestamp(ts).strftime("%Y-%m-%d"): v for ts, v in raw_map.items()
            }
            cursor = start_dt
            while cursor <= end_dt:
                day_key = cursor.strftime("%Y-%m-%d")
                points.append(
                    {
                        "time": int(cursor.timestamp()),
                        "label": cursor.strftime("%m/%d"),
                        "value": by_day.get(day_key, 0.0),
                    }
                )
                cursor += timedelta(days=1)

        elif period == "month":
            # Calendar month shifted by offset
            y = now.year
            m = now.month + offset
            while m <= 0:
                m += 12
                y -= 1
            while m > 12:
                m -= 12
                y += 1
            start_dt = datetime(y, m, 1)
            if m == 12:
                end_dt = datetime(y + 1, 1, 1) - timedelta(days=1)
            else:
                end_dt = datetime(y, m + 1, 1) - timedelta(days=1)
            if end_dt > now and offset == 0:
                end_dt = now
            label = start_dt.strftime("%Y/%m")
            time_start = int((start_dt - timedelta(days=1)).timestamp())
            time_end = int((end_dt + timedelta(days=2)).timestamp())
            raw_map = self._fetch_stat_map(
                did, key, "stat_day_v3", time_start, time_end, 40, ratio
            )
            by_day = {
                datetime.fromtimestamp(ts).strftime("%Y-%m-%d"): v for ts, v in raw_map.items()
            }
            cursor = start_dt
            while cursor <= end_dt:
                day_key = cursor.strftime("%Y-%m-%d")
                points.append(
                    {
                        "time": int(cursor.timestamp()),
                        "label": cursor.strftime("%d"),
                        "value": by_day.get(day_key, 0.0),
                    }
                )
                cursor += timedelta(days=1)

        else:  # year
            y = now.year + offset
            start_dt = datetime(y, 1, 1)
            end_dt = datetime(y, 12, 1)
            label = str(y)
            time_start = int((start_dt - timedelta(days=2)).timestamp())
            time_end = int((datetime(y + 1, 1, 2)).timestamp())
            raw_map = self._fetch_stat_map(
                did, key, "stat_month_v3", time_start, time_end, 14, ratio
            )
            by_month = {
                datetime.fromtimestamp(ts).strftime("%Y-%m"): v for ts, v in raw_map.items()
            }
            for month in range(1, 13):
                if offset == 0 and month > now.month:
                    break
                cursor = datetime(y, month, 1)
                mk = cursor.strftime("%Y-%m")
                points.append(
                    {
                        "time": int(cursor.timestamp()),
                        "label": cursor.strftime("%m"),
                        "value": by_month.get(mk, 0.0),
                    }
                )

        total = round(sum(float(p["value"]) for p in points), 3)
        return {
            "did": did,
            "period": period,
            "offset": offset,
            "label": label,
            "start": int(start_dt.timestamp()),
            "end": int(end_dt.timestamp()),
            "unit": "kWh",
            "total": total,
            "points": points,
            "count": len(points),
        }

    def get_capabilities(self, did: str, include_values: bool = True) -> dict[str, Any]:
        device = self.get_device(did, sleep_time=0.0)
        access_index = self._access_index_for_device(device)
        properties = [
            self._prop_meta(name, prop, access_index)
            for name, prop in self._iter_unique_props(device)
        ]

        actions: list[dict[str, Any]] = []
        for name, act in getattr(device, "action_list", {}).items():
            method = getattr(act, "method", {}) or {}
            siid = method.get("siid")
            aiid = method.get("aiid")
            in_defs: list[dict[str, Any]] = []
            if siid is not None and aiid is not None:
                try:
                    in_defs = self._action_in_defs(did, int(siid), int(aiid))
                except Exception:
                    in_defs = []
            actions.append(
                {
                    "name": name,
                    "desc": getattr(act, "desc", name),
                    "siid": siid,
                    "aiid": aiid,
                    "in": in_defs,
                }
            )

        values: dict[str, Any] = {}
        if include_values:
            values = self._batch_get_values(device, properties)

        return {
            "did": did,
            "name": getattr(device, "name", None),
            "model": getattr(device, "model", None),
            "properties": properties,
            "actions": actions,
            "values": values,
        }

    def _batch_get_values(
        self,
        device: mijiaDevice,
        properties: list[dict[str, Any]],
        limit: int = 24,
    ) -> dict[str, Any]:
        """Fetch readable property values in one miot batch call (no 0.5s sleeps)."""
        api = self.require_api()
        requests: list[dict[str, Any]] = []
        name_by_key: dict[tuple[Any, Any], str] = {}

        priority = []
        rest = []
        for p in properties:
            fetchable = p.get("fetchable")
            if fetchable is False:
                continue
            if fetchable is not True and "r" not in str(p.get("rw", "")):
                continue
            name = str(p["name"])
            if name == "on" or name.startswith("on-") or name in {
                "brightness",
                "mode",
                "battery",
                "temperature",
                "relative_humidity",
                "humidity",
                "pm2_5",
                "pm25",
                "filter_life_level",
                "status",
                "battery-level",
                "fragrance-out-time",
                "idle-time",
                "light",
                # Speaker / media (oh2p etc.)
                "volume",
                "playing-state",
                "audio-id",
                "sleep-mode",
                "mute",
                "mute-2",
                "mute-4",
                "no-disturb",
            }:
                priority.append(p)
            else:
                rest.append(p)

        selected = (priority + rest)[:limit]
        for p in selected:
            name = str(p["name"])
            prop = device.prop_list.get(name)
            if prop is None:
                continue
            method = getattr(prop, "method", None)
            if not isinstance(method, dict):
                continue
            siid = method.get("siid")
            piid = method.get("piid")
            if siid is None or piid is None:
                continue
            req = {"did": device.did, "siid": siid, "piid": piid}
            requests.append(req)
            name_by_key[(siid, piid)] = name

        if not requests:
            return {}

        try:
            results = api.get_devices_prop(requests)
        except Exception:
            # Fallback: only fetch switch-like props one by one with no sleep
            values: dict[str, Any] = {}
            for p in priority[:6]:
                try:
                    values[str(p["name"])] = device.get(str(p["name"]))
                except Exception:
                    continue
            return values

        if isinstance(results, dict):
            results = [results]

        values = {}
        for item in results or []:
            if not isinstance(item, dict) or item.get("code", 0) != 0:
                continue
            key = (item.get("siid"), item.get("piid"))
            name = name_by_key.get(key)
            if name is not None and "value" in item:
                values[name] = item["value"]
        return values

    def find_switch_prop(self, did: str) -> Optional[str]:
        device = self.get_device(did, sleep_time=0.0)
        candidates: list[str] = []
        fallback: list[str] = []
        for name, prop in self._iter_unique_props(device):
            meta = self._prop_meta(name, prop)
            if meta["type"] != "bool" or "w" not in str(meta["rw"]):
                continue
            if name == "on" or name.startswith("on-") or name.startswith("on_"):
                candidates.append(name)
            else:
                fallback.append(name)
        return (candidates or fallback or [None])[0]

    def get_props(self, did: str, names: list[str]) -> dict[str, Any]:
        device = self.get_device(did, sleep_time=0.0)
        if not names:
            return {}
        # Prefer batch
        props_meta = []
        for name in names:
            prop = device.prop_list.get(name)
            if prop is None and name.replace("_", "-") in device.prop_list:
                name = name.replace("_", "-")
                prop = device.prop_list.get(name)
            if prop is None:
                continue
            props_meta.append(self._prop_meta(name, prop))
        return self._batch_get_values(device, props_meta, limit=len(props_meta) or 1)

    def set_prop(self, did: str, name: str, value: Any) -> bool:
        device = self.get_device(did, sleep_time=0.0)
        return bool(device.set(name, value))

    def run_action(self, did: str, name: str, params: Optional[list[Any]] = None) -> bool:
        device = self.get_device(did, sleep_time=0.0)
        if name not in getattr(device, "action_list", {}):
            raise ValueError(f"Unsupported action: {name}")

        act = device.action_list[name]
        method = getattr(act, "method", {}) or {}
        siid = method.get("siid")
        aiid = method.get("aiid")
        params = list(params or [])

        # Prefer Spec-defined `in` piids (fixes scale request-offline-data etc.)
        in_defs: list[dict[str, Any]] = []
        if siid is not None and aiid is not None:
            try:
                in_defs = self._action_in_defs(did, int(siid), int(aiid))
            except Exception:
                in_defs = []

        # XiaoAi speakers reject [{piid,value}] for text actions — cloud wants raw
        # `in`: ["今天天气怎么样", 0] (see mijiaAPI __main__ / mcp_server examples).
        if name in {"execute-text-directive", "play-text", "play-music"}:
            device.run_action(name, _in=self._speaker_action_in(params))
            ok = True
        elif in_defs:
            payload = miot_spec.build_action_in(in_defs, params)
            device.run_action(name, _in=payload)
            ok = True
        elif not params:
            device.run_action(name)
            ok = True
        else:
            device.run_action(name, value=params)
            ok = True

        # Music transport: Spec alone is flaky; reinforce via MiNA mediaplayer
        if name in {"play", "pause", "next", "previous", "stop"}:
            try:
                self._mina_player_op(did, name)
            except Exception:
                pass
        return ok

    @staticmethod
    def _speaker_action_in(params: list[Any]) -> list[Any]:
        """Coerce UI params to raw MiOT `in` values (bool → 0/1)."""
        out: list[Any] = []
        for v in params:
            if isinstance(v, bool):
                out.append(1 if v else 0)
            elif isinstance(v, str) and v.lower() in {"true", "false"}:
                out.append(1 if v.lower() == "true" else 0)
            else:
                out.append(v)
        return out

    def _mina_player_op(self, did: str, op: str) -> bool:
        api = self.require_api()
        auth = api.auth_data or {}
        raw = self._device_raw(did) or {}
        mac = str(raw.get("mac") or raw.get("macAddress") or "") or None
        mina_dev = mina_client.find_device(auth, miot_did=did, mac=mac)
        if not mina_dev:
            return False
        device_id = str(mina_dev.get("deviceID") or "")
        if not device_id:
            return False
        return mina_client.player_play_operation(auth, device_id, op)

    def list_consumables(self, home_id: Optional[str] = None) -> list[Any]:
        api = self.require_api()
        return api.get_consumable_items(home_id=home_id) or []

    def cloud_request(
        self,
        uri: str,
        data: dict[str, Any],
        extra_headers: Optional[dict[str, str]] = None,
    ) -> Any:
        """Signed mijia cloud POST (supports extra headers like MIOT-REQUEST-MODEL)."""
        api = self.require_api()
        api._refresh_token()
        # Local MITM (e.g. Reqable) often breaks the system trust store.
        _prepare_http_session(api)
        url = api.api_base_url + uri
        params: dict[str, Any] = {"data": json.dumps(data, separators=(",", ":"))}
        nonce = gen_nonce()
        signed_nonce = get_signed_nonce(api.auth_data["ssecurity"], nonce)
        params = generate_enc_params(
            uri, "POST", signed_nonce, nonce, params, api.auth_data["ssecurity"]
        )
        ret = api.session.post(url, data=params, headers=extra_headers or {})
        try:
            ret_data = json.loads(ret.text)
        except json.JSONDecodeError:
            ret_data = json.loads(decrypt(api.auth_data["ssecurity"], nonce, ret.text))
        if ret_data.get("code", 0) != 0 or "result" not in ret_data:
            raise APIError(
                ret_data.get("code", -1),
                ret_data.get("message", ret_data.get("msg", ret_data.get("desc", "未知错误"))),
            )
        return ret_data["result"]

    def _device_model(self, did: str) -> Optional[str]:
        for device in self.list_devices():
            if device.get("id") == did:
                model = str(device.get("model") or "").strip()
                return model or None
        return None

    def _device_raw(self, did: str) -> Optional[dict[str, Any]]:
        for device in self.list_devices():
            if device.get("id") == did:
                raw = device.get("raw")
                return raw if isinstance(raw, dict) else None
        return None

    def get_speaker_now_playing(self, did: str) -> dict[str, Any]:
        """Now-playing metadata from MiNA cloud (title/artist/cover), not MIoT Spec."""
        api = self.require_api()
        auth = api.auth_data or {}
        raw = self._device_raw(did) or {}
        mac = str(raw.get("mac") or raw.get("macAddress") or "") or None
        mina_dev = mina_client.find_device(auth, miot_did=did, mac=mac)
        if not mina_dev:
            return {
                "did": did,
                "available": False,
                "reason": "not_in_mina",
                "title": None,
                "artist": None,
            }
        device_id = str(mina_dev.get("deviceID") or "")
        if not device_id:
            return {
                "did": did,
                "available": False,
                "reason": "missing_device_id",
                "title": None,
                "artist": None,
            }

        info = mina_client.player_get_status(auth, device_id)
        detail = (
            info.get("play_song_detail")
            if isinstance(info.get("play_song_detail"), dict)
            else {}
        )
        audio_id = detail.get("audio_id") or detail.get("global_id")
        title = detail.get("title") or detail.get("name")
        song_meta: Optional[dict[str, Any]] = None
        resolve_error: Optional[str] = None
        if audio_id and not title:
            caps = mina_dev.get("capabilities") or {}
            use_aivs3 = bool(isinstance(caps, dict) and caps.get("ai_protocol_3_0"))
            try:
                song_meta = mina_client.resolve_song(
                    auth, str(audio_id), use_aivs3=use_aivs3
                )
            except Exception as exc:  # noqa: BLE001
                resolve_error = str(exc)

        payload = normalize_now_playing(info, song_meta, mina_device=mina_dev)
        payload.update(
            {
                "did": did,
                "available": True,
                "reason": None,
                "resolveError": resolve_error,
            }
        )
        return payload

    @staticmethod
    def _num(value: Any) -> Optional[float]:
        if value is None or value == "":
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def _normalize_scale_record(self, item: dict[str, Any]) -> Optional[dict[str, Any]]:
        raw_data = item.get("data")
        payload: dict[str, Any] = {}
        if isinstance(raw_data, str) and raw_data:
            try:
                parsed = json.loads(raw_data)
                if isinstance(parsed, dict):
                    payload = parsed
                    # Older records nest metrics under bodyResData
                    nested = payload.get("bodyResData")
                    if isinstance(nested, str):
                        try:
                            nested_obj = json.loads(nested)
                            if isinstance(nested_obj, dict):
                                for k, v in nested_obj.items():
                                    payload.setdefault(k, v)
                        except json.JSONDecodeError:
                            pass
                    elif isinstance(nested, dict):
                        for k, v in nested.items():
                            payload.setdefault(k, v)
            except json.JSONDecodeError:
                payload = {}
        elif isinstance(raw_data, dict):
            payload = raw_data

        weight = self._num(payload.get("weight"))
        if weight is None:
            return None

        user = payload.get("user") if isinstance(payload.get("user"), dict) else {}
        create_ms = item.get("createTime")
        try:
            create_ms = int(create_ms) if create_ms is not None else None
        except (TypeError, ValueError):
            create_ms = None
        if create_ms is None:
            t = payload.get("time")
            try:
                t_int = int(t) if t is not None else 0
                create_ms = t_int if t_int > 10_000_000_000 else t_int * 1000
            except (TypeError, ValueError):
                create_ms = 0

        return {
            "did": str(item.get("did") or ""),
            "model": str(item.get("model") or ""),
            "createTime": create_ms,
            "weight": weight,
            "bmi": self._num(payload.get("bmi")),
            "bodyFat": self._num(payload.get("bfp")),
            "muscleMass": self._num(payload.get("slm")),
            "bodyWater": self._num(payload.get("bwp")),
            "boneMass": self._num(payload.get("bmc")),
            "visceralFat": self._num(payload.get("vfl")),
            "proteinMass": self._num(payload.get("pm")),
            "proteinPercent": self._num(payload.get("pp")),
            "skeletalMuscle": self._num(payload.get("smm")),
            "bodyScore": self._num(payload.get("sbc")),
            "metabolicAge": self._num(payload.get("ma")),
            "bmr": self._num(payload.get("bmr")),
            "heartRate": self._num(payload.get("heartRate")),
            "idealWeight": self._num(payload.get("swt")),
            "userName": str(user.get("name") or "") or None,
            "height": self._num(user.get("height")),
            "reportFrom": str(payload.get("reportFrom") or "") or None,
        }

    def get_scale_history(
        self,
        did: str,
        model: Optional[str] = None,
        limit: int = 30,
    ) -> dict[str, Any]:
        """Fetch body-composition history from eco/scale cloud (not MIoT props)."""
        model = (model or self._device_model(did) or "").strip()
        if not model:
            raise RuntimeError("Scale model is required")

        api = self.require_api()
        uid = int(api.auth_data["userId"])
        headers = {"MIOT-REQUEST-MODEL": model}
        begin_ms = int(time.time() * 1000)
        records: list[dict[str, Any]] = []
        seen: set[int] = set()
        max_pages = 8

        for _ in range(max_pages):
            if len(records) >= limit:
                break
            raw = self.cloud_request(
                "/eco/scale/getData",
                {
                    "param": {"endTime": 1, "beginTime": begin_ms},
                    "model": model,
                    "uid": uid,
                    "did": 0,
                },
                extra_headers=headers,
            )
            if not isinstance(raw, list) or not raw:
                break

            page_oldest: Optional[int] = None
            for item in raw:
                if not isinstance(item, dict):
                    continue
                item_did = str(item.get("did") or "")
                if item_did and item_did != did:
                    continue
                normalized = self._normalize_scale_record(item)
                if not normalized:
                    continue
                ct = int(normalized["createTime"] or 0)
                if ct in seen:
                    continue
                seen.add(ct)
                records.append(normalized)
                if page_oldest is None or ct < page_oldest:
                    page_oldest = ct
                if len(records) >= limit:
                    break

            if page_oldest is None or page_oldest >= begin_ms:
                break
            begin_ms = page_oldest

        records.sort(key=lambda r: int(r.get("createTime") or 0), reverse=True)
        records = records[:limit]
        latest = records[0] if records else None
        return {
            "did": did,
            "model": model,
            "latest": latest,
            "records": records,
            "count": len(records),
        }

    @staticmethod
    def _ym_sports_week_bounds(now_ts: Optional[float] = None) -> tuple[int, int]:
        """Monday 00:00:00 – Sunday 23:59:59.999 in Asia/Shanghai (ms). type=1"""
        dt = datetime.fromtimestamp(now_ts or time.time(), _CST)
        monday = (dt - timedelta(days=dt.weekday())).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        end = monday + timedelta(days=7) - timedelta(milliseconds=1)
        return int(monday.timestamp() * 1000), int(end.timestamp() * 1000)

    @staticmethod
    def _ym_sports_month_bounds(now_ts: Optional[float] = None) -> tuple[int, int]:
        """Calendar month 1st 00:00:00 – last day 23:59:59.999 Asia/Shanghai. type=2"""
        dt = datetime.fromtimestamp(now_ts or time.time(), _CST)
        start = dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        if start.month == 12:
            nxt = start.replace(year=start.year + 1, month=1)
        else:
            nxt = start.replace(month=start.month + 1)
        end = nxt - timedelta(milliseconds=1)
        return int(start.timestamp() * 1000), int(end.timestamp() * 1000)

    @staticmethod
    def _ym_sports_year_bounds(now_ts: Optional[float] = None) -> tuple[int, int]:
        """Calendar year Jan 1 00:00:00 – Dec 31 23:59:59.999 Asia/Shanghai. type=3"""
        dt = datetime.fromtimestamp(now_ts or time.time(), _CST)
        start = dt.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
        end = start.replace(year=start.year + 1) - timedelta(milliseconds=1)
        return int(start.timestamp() * 1000), int(end.timestamp() * 1000)

    @staticmethod
    def _ym_sports_payload(
        *,
        uid: str,
        start_ms: int,
        end_ms: int,
        period_type: int = 1,
        next_key: str = "",
    ) -> dict[str, Any]:
        # type: 1=week, 2=month, 3=year (matches Mi Home ym-sports client)
        body: dict[str, Any] = {
            "startTime": int(start_ms),
            "endTime": int(end_ms),
            "type": int(period_type),
            "timezoneOffset": _ABWHEEL_TZ_OFFSET,
            "deviceType": _ABWHEEL_DEVICE_TYPE,
            "miId": str(uid),
        }
        if next_key:
            body["nextKey"] = next_key
        return body

    @staticmethod
    def _ym_sports_summary_nums(data: dict[str, Any]) -> dict[str, Any]:
        count = data.get("count")
        calory = data.get("calory")
        duration = data.get("duration")
        try:
            count_i = int(count) if count is not None else None
        except (TypeError, ValueError):
            count_i = None
        try:
            cal_f = float(calory) if calory is not None else None
        except (TypeError, ValueError):
            cal_f = None
        try:
            dur_i = int(duration) if duration is not None else None
        except (TypeError, ValueError):
            dur_i = None
        return {
            "count": count_i,
            "calories": round(cal_f, 1) if cal_f is not None else None,
            "durationSec": dur_i,
        }

    def _ym_sports_trend_points(self, items: Any) -> list[dict[str, Any]]:
        if not isinstance(items, list):
            return []
        out: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            date = item.get("date")
            if date is None:
                continue
            try:
                date_ms = int(date)
            except (TypeError, ValueError):
                continue
            nums = self._ym_sports_summary_nums(item)
            out.append(
                {
                    "date": date_ms,
                    "count": nums["count"] or 0,
                    "calories": nums["calories"] or 0,
                    "durationSec": nums["durationSec"] or 0,
                }
            )
        out.sort(key=lambda p: int(p["date"]))
        return out

    @staticmethod
    def _ym_sports_day_key(ms: int) -> str:
        dt = datetime.fromtimestamp(ms / 1000.0, _CST)
        return dt.strftime("%Y-%m-%d")

    @staticmethod
    def _ym_sports_month_key(ms: int) -> str:
        dt = datetime.fromtimestamp(ms / 1000.0, _CST)
        return dt.strftime("%Y-%m")

    def _ym_sports_fill_daily(
        self, start_ms: int, end_ms: int, sparse: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Fill every calendar day in [start, end] (CST); missing days → 0."""
        by_day = {self._ym_sports_day_key(int(p["date"])): p for p in sparse}
        start = datetime.fromtimestamp(start_ms / 1000.0, _CST).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        end = datetime.fromtimestamp(end_ms / 1000.0, _CST)
        out: list[dict[str, Any]] = []
        cur = start
        while cur <= end:
            key = cur.strftime("%Y-%m-%d")
            day_ms = int(cur.timestamp() * 1000)
            hit = by_day.get(key)
            out.append(
                {
                    "date": day_ms,
                    "count": int(hit["count"]) if hit else 0,
                    "calories": float(hit["calories"]) if hit else 0,
                    "durationSec": int(hit["durationSec"]) if hit else 0,
                }
            )
            cur += timedelta(days=1)
        return out

    def _ym_sports_fill_months(
        self, start_ms: int, sparse: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Fill 12 months of the year containing start_ms; missing → 0."""
        by_month = {self._ym_sports_month_key(int(p["date"])): p for p in sparse}
        year = datetime.fromtimestamp(start_ms / 1000.0, _CST).year
        out: list[dict[str, Any]] = []
        for month in range(1, 13):
            dt = datetime(year, month, 1, tzinfo=_CST)
            key = dt.strftime("%Y-%m")
            hit = by_month.get(key)
            out.append(
                {
                    "date": int(dt.timestamp() * 1000),
                    "count": int(hit["count"]) if hit else 0,
                    "calories": float(hit["calories"]) if hit else 0,
                    "durationSec": int(hit["durationSec"]) if hit else 0,
                }
            )
        return out

    def _ym_sports_bounds_with_offset(
        self, period: str, offset: int = 0
    ) -> tuple[int, int, int]:
        """Return (start_ms, end_ms, period_type) for week/month/year + offset."""
        offset = int(offset)
        now = datetime.now(_CST)
        if period == "week":
            monday = (now - timedelta(days=now.weekday())).replace(
                hour=0, minute=0, second=0, microsecond=0
            ) + timedelta(weeks=offset)
            end = monday + timedelta(days=7) - timedelta(milliseconds=1)
            return int(monday.timestamp() * 1000), int(end.timestamp() * 1000), 1
        if period == "month":
            y, m = now.year, now.month + offset
            while m > 12:
                y += 1
                m -= 12
            while m < 1:
                y -= 1
                m += 12
            start = datetime(y, m, 1, tzinfo=_CST)
            if m == 12:
                nxt = datetime(y + 1, 1, 1, tzinfo=_CST)
            else:
                nxt = datetime(y, m + 1, 1, tzinfo=_CST)
            end = nxt - timedelta(milliseconds=1)
            return int(start.timestamp() * 1000), int(end.timestamp() * 1000), 2
        # year
        start = datetime(now.year + offset, 1, 1, tzinfo=_CST)
        end = datetime(now.year + offset + 1, 1, 1, tzinfo=_CST) - timedelta(
            milliseconds=1
        )
        return int(start.timestamp() * 1000), int(end.timestamp() * 1000), 3

    @staticmethod
    def _ym_sports_period_label(period: str, start_ms: int, end_ms: int) -> str:
        s = datetime.fromtimestamp(start_ms / 1000.0, _CST)
        e = datetime.fromtimestamp(end_ms / 1000.0, _CST)
        if period == "week":
            return f"{s.month}/{s.day} – {e.month}/{e.day}"
        if period == "month":
            return f"{s.year}年{s.month}月"
        return f"{s.year}年"

    @staticmethod
    def _unwrap_ym_sports(result: Any) -> dict[str, Any]:
        """cloud_request returns outer result; ym-sports nests real payload in data."""
        if not isinstance(result, dict):
            return {}
        if isinstance(result.get("data"), dict):
            return result["data"]
        return result

    def _normalize_ym_sports_row(
        self, row: dict[str, Any], did: str
    ) -> Optional[dict[str, Any]]:
        device_id = str(row.get("deviceId") or "").strip()
        if device_id and device_id != did:
            return None
        index_time = row.get("indexTime")
        if index_time is None:
            return None
        try:
            start_ms = int(index_time)
        except (TypeError, ValueError):
            return None

        duration = row.get("duration")
        try:
            duration_s = int(duration) if duration is not None else None
        except (TypeError, ValueError):
            duration_s = None

        count = row.get("count")
        try:
            count_i = int(count) if count is not None else None
        except (TypeError, ValueError):
            count_i = None

        calory = row.get("calory")
        try:
            calories = float(calory) if calory is not None else None
        except (TypeError, ValueError):
            calories = None

        end_ms = start_ms + duration_s * 1000 if duration_s is not None else None
        return {
            "id": str(row.get("id") or start_ms),
            "did": device_id or did,
            "startTime": start_ms,
            "endTime": end_ms,
            "durationSec": duration_s,
            "count": count_i,
            "calories": calories,
            "category": _ABWHEEL_DEVICE_TYPE,
            "title": "健腹轮训练",
            "raw": row,
        }

    def get_abwheel_history(
        self,
        did: str,
        model: Optional[str] = None,
        days: int = 180,
        limit: int = 50,
    ) -> dict[str, Any]:
        """Ab-wheel workout history from eco/ym-sports (Mi Home HAW cloud)."""
        model = (model or self._device_model(did) or "xiaomi.abwheel.jfl001").strip()
        api = self.require_api()
        uid = str((api.auth_data or {}).get("userId") or "")
        if not uid:
            raise RuntimeError("Missing userId in auth data")

        headers = {
            "MIOT-REQUEST-MODEL": model,
            "miot-encrypt-algorithm": "ENCRYPT-RC4",
            "Accept-Encoding": "identity",
        }
        now_ms = int(time.time() * 1000)
        week_start, week_end = self._ym_sports_week_bounds()
        month_start, month_end = self._ym_sports_month_bounds()
        year_start, year_end = self._ym_sports_year_bounds()
        limit_n = max(1, min(int(limit), 100))

        totals_raw: dict[str, Any] = {}
        try:
            all_raw = self.cloud_request(
                "/eco/ym-sports/record/summaryAll",
                {
                    "timezoneOffset": _ABWHEEL_TZ_OFFSET,
                    "deviceType": _ABWHEEL_DEVICE_TYPE,
                    "miId": uid,
                },
                extra_headers=headers,
            )
            totals_raw = self._unwrap_ym_sports(all_raw)
        except Exception:
            totals_raw = {}

        earliest = totals_raw.get("earliestTime")
        try:
            earliest_ms = int(earliest) if earliest is not None else year_start
        except (TypeError, ValueError):
            earliest_ms = year_start
        # Prefer full history back to first workout (or at least current year).
        start_ms = min(
            earliest_ms,
            year_start,
            now_ms - max(1, min(int(days), 366)) * 86400 * 1000,
        )

        records: list[dict[str, Any]] = []
        seen: set[str] = set()
        next_key = ""
        for _ in range(24):
            if len(records) >= limit_n:
                break
            raw = self.cloud_request(
                "/eco/ym-sports/record/list",
                self._ym_sports_payload(
                    uid=uid, start_ms=start_ms, end_ms=now_ms, next_key=next_key
                ),
                extra_headers=headers,
            )
            data = self._unwrap_ym_sports(raw)
            rows = data.get("rows") if isinstance(data, dict) else None
            if not isinstance(rows, list) or not rows:
                break
            for row in rows:
                if not isinstance(row, dict):
                    continue
                normalized = self._normalize_ym_sports_row(row, did)
                if not normalized:
                    continue
                rid = str(normalized["id"])
                if rid in seen:
                    continue
                seen.add(rid)
                records.append(normalized)
                if len(records) >= limit_n:
                    break
            if not data.get("hasMore"):
                break
            next_key = str(data.get("nextKey") or "")
            if not next_key:
                break

        records.sort(key=lambda r: int(r.get("startTime") or 0), reverse=True)
        records = records[:limit_n]
        latest = records[0] if records else None

        def fetch_summary(start: int, end: int, period_type: int) -> dict[str, Any]:
            try:
                sum_raw = self.cloud_request(
                    "/eco/ym-sports/record/summary",
                    self._ym_sports_payload(
                        uid=uid,
                        start_ms=start,
                        end_ms=end,
                        period_type=period_type,
                    ),
                    extra_headers=headers,
                )
                return self._unwrap_ym_sports(sum_raw)
            except Exception:
                return {}

        def fill_from_rows(
            nums: dict[str, Any], rows: list[dict[str, Any]]
        ) -> dict[str, Any]:
            if nums["count"] is None:
                nums["count"] = sum(int(r.get("count") or 0) for r in rows) or None
            if nums["calories"] is None:
                cal = sum(float(r.get("calories") or 0) for r in rows)
                nums["calories"] = round(cal, 1) if cal else None
            if nums["durationSec"] is None:
                nums["durationSec"] = (
                    sum(int(r.get("durationSec") or 0) for r in rows) or None
                )
            return nums

        week_raw = fetch_summary(week_start, week_end, 1)
        month_raw = fetch_summary(month_start, month_end, 2)
        year_raw = fetch_summary(year_start, year_end, 3)

        week_rows = [
            r
            for r in records
            if week_start <= int(r.get("startTime") or 0) <= week_end
        ]
        month_rows = [
            r
            for r in records
            if month_start <= int(r.get("startTime") or 0) <= month_end
        ]
        year_rows = [
            r
            for r in records
            if year_start <= int(r.get("startTime") or 0) <= year_end
        ]
        week_nums = fill_from_rows(self._ym_sports_summary_nums(week_raw), week_rows)
        month_nums = fill_from_rows(self._ym_sports_summary_nums(month_raw), month_rows)
        year_nums = fill_from_rows(self._ym_sports_summary_nums(year_raw), year_rows)
        all_nums = self._ym_sports_summary_nums(totals_raw)

        trends = {
            "week": self._ym_sports_fill_daily(
                week_start,
                week_end,
                self._ym_sports_trend_points(week_raw.get("dailySumList")),
            ),
            "month": self._ym_sports_fill_daily(
                month_start,
                month_end,
                self._ym_sports_trend_points(month_raw.get("dailySumList")),
            ),
            "year": self._ym_sports_fill_months(
                year_start,
                self._ym_sports_trend_points(year_raw.get("monthSumList")),
            ),
        }

        best_count = self._normalize_ym_sports_row(
            totals_raw.get("optimumCount") or {}, did
        )
        best_calories = self._normalize_ym_sports_row(
            totals_raw.get("optimumCalory") or {}, did
        )
        best_duration = self._normalize_ym_sports_row(
            totals_raw.get("optimumDuration") or {}, did
        )

        return {
            "did": did,
            "model": model,
            "source": "ym-sports",
            "latest": latest,
            "records": records,
            "count": len(records),
            "summary": {
                "weekSessions": len(week_rows),
                "weekCount": week_nums["count"],
                "weekCalories": week_nums["calories"],
                "weekDurationSec": week_nums["durationSec"],
                "monthSessions": len(month_rows),
                "monthCount": month_nums["count"],
                "monthCalories": month_nums["calories"],
                "monthDurationSec": month_nums["durationSec"],
                "yearSessions": len(year_rows),
                "yearCount": year_nums["count"],
                "yearCalories": year_nums["calories"],
                "yearDurationSec": year_nums["durationSec"],
                "totalSessions": len(records) or None,
                "totalCount": all_nums["count"],
                "totalCalories": all_nums["calories"],
                "totalDurationSec": all_nums["durationSec"],
                "earliestTime": earliest_ms,
            },
            "trends": trends,
            "totals": {
                "count": all_nums["count"],
                "calories": all_nums["calories"],
                "durationSec": all_nums["durationSec"],
                "earliestTime": earliest_ms,
                "bestCount": best_count,
                "bestCalories": best_calories,
                "bestDuration": best_duration,
            },
        }

    # hipc.plug.m1 siid=3 piid=6 onoff-log value-list
    _PCBOOT_ONOFF_LOG: dict[int, dict[str, str]] = {
        1: {"key": "remoteOn", "title": "远程开机"},
        2: {"key": "remoteOff", "title": "远程关机"},
        3: {"key": "remoteReboot", "title": "远程重启"},
        4: {"key": "localOn", "title": "本地开机"},
        5: {"key": "localOff", "title": "本地关机"},
        6: {"key": "localReboot", "title": "本地重启"},
    }

    def get_pcboot_op_logs(
        self,
        did: str,
        model: Optional[str] = None,
        days: int = 180,
        limit: int = 50,
    ) -> dict[str, Any]:
        """Cloud operation log for HiPC boot card via /user/get_user_device_data (prop 3.6)."""
        model = (model or self._device_model(did) or "hipc.plug.m1").strip()
        api = self.require_api()
        _ = api  # ensure authenticated
        now = int(time.time())
        days_n = max(1, min(int(days), 366))
        limit_n = max(1, min(int(limit), 100))
        time_start = now - days_n * 86400
        headers = {
            "MIOT-REQUEST-MODEL": model,
            "miot-encrypt-algorithm": "ENCRYPT-RC4",
            "Accept-Encoding": "identity",
        }
        raw = self.cloud_request(
            "/user/get_user_device_data",
            {
                "did": str(did),
                "key": "3.6",
                "type": "prop",
                "time_start": time_start,
                "time_end": now,
                "limit": limit_n,
            },
            extra_headers=headers,
        )
        items = raw if isinstance(raw, list) else []
        records: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            code: Optional[int] = None
            value = item.get("value")
            if isinstance(value, list) and value:
                try:
                    code = int(value[0])
                except (TypeError, ValueError):
                    code = None
            elif isinstance(value, (int, float)):
                code = int(value)
            elif isinstance(value, str) and value:
                try:
                    parsed = json.loads(value)
                    if isinstance(parsed, list) and parsed:
                        code = int(parsed[0])
                    else:
                        code = int(parsed)
                except (TypeError, ValueError, json.JSONDecodeError):
                    code = None
            meta = self._PCBOOT_ONOFF_LOG.get(code or -1, {})
            try:
                ts = int(item.get("time") or 0)
            except (TypeError, ValueError):
                ts = 0
            # cloud uses seconds
            at_ms = ts * 1000 if ts < 10_000_000_000 else ts
            records.append(
                {
                    "id": f"{did}-{ts}-{code}",
                    "did": str(item.get("did") or did),
                    "at": at_ms,
                    "code": code,
                    "key": meta.get("key") or f"code-{code}",
                    "title": meta.get("title") or (f"状态 {code}" if code is not None else "未知操作"),
                    "source": "cloud",
                    "raw": item,
                }
            )
        records.sort(key=lambda r: int(r.get("at") or 0), reverse=True)
        return {
            "did": did,
            "model": model,
            "source": "get_user_device_data",
            "key": "3.6",
            "records": records,
            "count": len(records),
        }

    def get_abwheel_period(
        self,
        did: str,
        model: Optional[str] = None,
        period: str = "week",
        offset: int = 0,
    ) -> dict[str, Any]:
        """Period trend view (week/month/year) with full axis including zero days."""
        period = (period or "week").strip().lower()
        if period not in {"week", "month", "year"}:
            raise RuntimeError("period must be week, month, or year")
        model = (model or self._device_model(did) or "xiaomi.abwheel.jfl001").strip()
        api = self.require_api()
        uid = str((api.auth_data or {}).get("userId") or "")
        if not uid:
            raise RuntimeError("Missing userId in auth data")

        headers = {
            "MIOT-REQUEST-MODEL": model,
            "miot-encrypt-algorithm": "ENCRYPT-RC4",
            "Accept-Encoding": "identity",
        }
        start_ms, end_ms, period_type = self._ym_sports_bounds_with_offset(
            period, offset
        )
        try:
            raw = self.cloud_request(
                "/eco/ym-sports/record/summary",
                self._ym_sports_payload(
                    uid=uid,
                    start_ms=start_ms,
                    end_ms=end_ms,
                    period_type=period_type,
                ),
                extra_headers=headers,
            )
            data = self._unwrap_ym_sports(raw)
        except Exception:
            data = {}

        nums = self._ym_sports_summary_nums(data)
        if period == "year":
            points = self._ym_sports_fill_months(
                start_ms,
                self._ym_sports_trend_points(data.get("monthSumList")),
            )
        else:
            points = self._ym_sports_fill_daily(
                start_ms,
                end_ms,
                self._ym_sports_trend_points(data.get("dailySumList")),
            )

        # Prefer axis sum so empty weeks don't inherit a stale cloud total.
        axis_count = sum(int(p.get("count") or 0) for p in points)
        axis_cal = sum(float(p.get("calories") or 0) for p in points)
        axis_dur = sum(int(p.get("durationSec") or 0) for p in points)
        if axis_count or not nums["count"]:
            nums = {
                "count": axis_count or None,
                "calories": round(axis_cal, 1) if axis_cal else None,
                "durationSec": axis_dur or None,
            }

        return {
            "did": did,
            "model": model,
            "period": period,
            "offset": int(offset),
            "label": self._ym_sports_period_label(period, start_ms, end_ms),
            "startTime": start_ms,
            "endTime": end_ms,
            "summary": {
                "count": nums["count"],
                "calories": nums["calories"],
                "durationSec": nums["durationSec"],
            },
            "points": points,
        }


session = BridgeSession()
