"""MiNA (XiaoAi speaker cloud) client for now-playing metadata.

MIoT Spec for speakers only exposes playing-state / audio-id. Song title,
artist, cover come from api2.mina.mi.com using a micoapi serviceToken derived
from the same Xiaomi account passToken used by mijiaAPI.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import random
import string
import threading
import time
from typing import Any, Optional
from urllib import parse

import requests

logger = logging.getLogger(__name__)

ACCOUNT_BASE = "https://account.xiaomi.com"
MINA_BASE = "https://api2.mina.mi.com"
SID_MICOAPI = "micoapi"

UA_LOGIN = (
    "APP/com.xiaomi.mihome APPV/8.0.0 iosPassportSDK/3.9.0 iOS/14.4 MK/iPhone"
)
UA_MINA = (
    "MiHome/6.0.103 (com.xiaomi.mihome; build:6.0.103.1; iOS 14.4.0) "
    "Alamofire/6.0.103 MICO/iOSApp/appStore/6.0.103"
)

_TOKEN_TTL_SEC = 6 * 60 * 60
_DEVICE_TTL_SEC = 5 * 60
_SONG_TTL_SEC = 10 * 60


def _random_id(n: int = 30) -> str:
    return "".join(random.choices(string.ascii_letters + string.digits, k=n))


def _parse_account_json(text: str) -> dict[str, Any]:
    if text.startswith("&&&START&&&"):
        text = text[11:]
    return json.loads(text) if text else {}


class MinaClient:
    """Sync MiNA helper bound to one Xiaomi account auth blob."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._user_id: Optional[str] = None
        self._service_token: Optional[str] = None
        self._token_at: float = 0.0
        self._devices: list[dict[str, Any]] = []
        self._devices_at: float = 0.0
        self._song_cache: dict[str, tuple[float, dict[str, Any]]] = {}

    def clear(self) -> None:
        with self._lock:
            self._user_id = None
            self._service_token = None
            self._token_at = 0.0
            self._devices = []
            self._devices_at = 0.0
            self._song_cache.clear()

    def ensure_token(self, auth_data: dict[str, Any], force: bool = False) -> None:
        with self._lock:
            uid = str(auth_data.get("userId") or "")
            if (
                not force
                and self._service_token
                and self._user_id == uid
                and (time.time() - self._token_at) < _TOKEN_TTL_SEC
            ):
                return
            if not uid or not auth_data.get("passToken"):
                raise RuntimeError("Mi account passToken missing; re-login required")
            token = self._login_micoapi(auth_data)
            self._user_id = uid
            self._service_token = token
            self._token_at = time.time()
            self._devices = []
            self._devices_at = 0.0

    def _login_micoapi(self, auth_data: dict[str, Any]) -> str:
        user_id = str(auth_data["userId"])
        device_id = str(auth_data.get("deviceId") or _random_id(16))
        cookies = {
            "sdkVersion": "3.9",
            "deviceId": device_id,
            "userId": user_id,
            "passToken": auth_data["passToken"],
        }
        headers = {"User-Agent": UA_LOGIN}
        r = requests.get(
            f"{ACCOUNT_BASE}/pass/serviceLogin?sid={SID_MICOAPI}&_json=true",
            cookies=cookies,
            headers=headers,
            timeout=20,
        )
        resp = _parse_account_json(r.text)
        if resp.get("code") != 0:
            raise RuntimeError(
                f"micoapi serviceLogin failed: {resp.get('code')} "
                f"{resp.get('desc') or resp.get('description')}"
            )
        location = resp["location"]
        nonce = resp["nonce"]
        ssecurity = resp["ssecurity"]
        nsec = f"nonce={nonce}&{ssecurity}"
        client_sign = base64.b64encode(hashlib.sha1(nsec.encode()).digest()).decode()
        r2 = requests.get(
            f"{location}&clientSign={parse.quote(client_sign)}",
            cookies=cookies,
            headers=headers,
            timeout=20,
            allow_redirects=True,
        )
        service_token = r2.cookies.get("serviceToken")
        if not service_token:
            raise RuntimeError("micoapi serviceToken missing after login")
        return service_token

    def _cookies(self) -> dict[str, str]:
        if not self._user_id or not self._service_token:
            raise RuntimeError("MiNA not authenticated")
        return {"userId": self._user_id, "serviceToken": self._service_token}

    def _request(
        self,
        method: str,
        path: str,
        data: Optional[dict[str, Any]] = None,
        *,
        auth_data: Optional[dict[str, Any]] = None,
        retry: bool = True,
    ) -> dict[str, Any]:
        url = MINA_BASE + path
        headers = {"User-Agent": UA_MINA}
        payload = dict(data or {})
        payload.setdefault("requestId", "app_ios_" + _random_id(30))
        try:
            if method.upper() == "GET":
                r = requests.get(
                    url,
                    params=payload,
                    cookies=self._cookies(),
                    headers=headers,
                    timeout=20,
                )
            else:
                r = requests.post(
                    url,
                    data=payload,
                    cookies=self._cookies(),
                    headers=headers,
                    timeout=20,
                )
        except requests.RequestException as exc:
            raise RuntimeError(f"MiNA request failed: {exc}") from exc

        if r.status_code == 401 and retry and auth_data:
            self.ensure_token(auth_data, force=True)
            return self._request(method, path, data, auth_data=auth_data, retry=False)

        try:
            body = r.json()
        except ValueError as exc:
            raise RuntimeError(f"MiNA bad JSON ({r.status_code}): {r.text[:200]}") from exc

        code = body.get("code", -1)
        if code != 0:
            msg = str(body.get("message") or body.get("msg") or body)
            if retry and auth_data and ("auth" in msg.lower() or code in {401, 1002}):
                self.ensure_token(auth_data, force=True)
                return self._request(method, path, data, auth_data=auth_data, retry=False)
            raise RuntimeError(f"MiNA error {code}: {msg}")
        return body

    def device_list(self, auth_data: dict[str, Any], force: bool = False) -> list[dict[str, Any]]:
        self.ensure_token(auth_data)
        with self._lock:
            if (
                not force
                and self._devices
                and (time.time() - self._devices_at) < _DEVICE_TTL_SEC
            ):
                return list(self._devices)
        body = self._request(
            "GET",
            "/admin/v2/device_list",
            {"master": 0},
            auth_data=auth_data,
        )
        devices = body.get("data") or []
        if not isinstance(devices, list):
            devices = []
        with self._lock:
            self._devices = devices
            self._devices_at = time.time()
        return list(devices)

    def find_device(
        self,
        auth_data: dict[str, Any],
        *,
        miot_did: str,
        mac: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        devices = self.device_list(auth_data)
        did = str(miot_did)
        mac_n = (mac or "").replace(":", "").lower()
        for d in devices:
            if not isinstance(d, dict):
                continue
            if str(d.get("miotDID") or "") == did:
                return d
            if mac_n:
                dmac = str(d.get("mac") or "").replace(":", "").lower()
                if dmac and dmac == mac_n:
                    return d
        return None

    def player_get_status(
        self,
        auth_data: dict[str, Any],
        device_id: str,
    ) -> dict[str, Any]:
        self.ensure_token(auth_data)
        body = self._request(
            "POST",
            "/remote/ubus",
            {
                "deviceId": device_id,
                "message": json.dumps({"media": "app_ios"}, separators=(",", ":")),
                "method": "player_get_play_status",
                "path": "mediaplayer",
            },
            auth_data=auth_data,
        )
        data = body.get("data") or {}
        info = data.get("info") if isinstance(data, dict) else None
        if isinstance(info, str):
            try:
                info = json.loads(info)
            except json.JSONDecodeError:
                info = {"raw": info}
        if not isinstance(info, dict):
            info = {}
        return info

    def player_play_operation(
        self,
        auth_data: dict[str, Any],
        device_id: str,
        action: str,
    ) -> bool:
        """MiNA mediaplayer play/pause/stop/next/prev."""
        self.ensure_token(auth_data)
        op = action.strip().lower()
        # Spec names → ubus actions
        if op == "play":
            ubus_action = "play"
        elif op == "pause":
            ubus_action = "pause"
        elif op in {"stop", "stop-alarm"}:
            ubus_action = "stop"
        elif op == "next":
            ubus_action = "next"
        elif op == "previous":
            ubus_action = "prev"
        else:
            return False
        body = self._request(
            "POST",
            "/remote/ubus",
            {
                "deviceId": device_id,
                "message": json.dumps(
                    {"action": ubus_action, "media": "app_ios"},
                    separators=(",", ":"),
                ),
                "method": "player_play_operation",
                "path": "mediaplayer",
            },
            auth_data=auth_data,
        )
        return body.get("code", 0) == 0

    def resolve_song(
        self,
        auth_data: dict[str, Any],
        audio_id: str,
        *,
        use_aivs3: bool = False,
    ) -> Optional[dict[str, Any]]:
        mid = str(audio_id or "").strip()
        if not mid:
            return None
        with self._lock:
            cached = self._song_cache.get(mid)
            if cached and (time.time() - cached[0]) < _SONG_TTL_SEC:
                return dict(cached[1])

        self.ensure_token(auth_data)
        path = "/aivs3/audio/info" if use_aivs3 else "/music/song_info"
        key = "audioIdList" if use_aivs3 else "songIdList"
        try:
            body = self._request(
                "POST",
                path,
                {key: json.dumps([mid], separators=(",", ":"))},
                auth_data=auth_data,
            )
        except RuntimeError:
            if use_aivs3:
                body = self._request(
                    "POST",
                    "/music/song_info",
                    {"songIdList": json.dumps([mid], separators=(",", ":"))},
                    auth_data=auth_data,
                )
            else:
                raise

        items = body.get("data") or []
        if not isinstance(items, list) or not items:
            return None
        song = items[0] if isinstance(items[0], dict) else None
        if not song:
            return None
        with self._lock:
            self._song_cache[mid] = (time.time(), dict(song))
        return dict(song)


mina_client = MinaClient()


def normalize_now_playing(
    info: dict[str, Any],
    song: Optional[dict[str, Any]] = None,
    *,
    mina_device: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Flatten MiNA play status + optional song_info into a UI-friendly payload."""
    detail = info.get("play_song_detail") if isinstance(info.get("play_song_detail"), dict) else {}
    merged: dict[str, Any] = {}
    if isinstance(song, dict):
        merged.update(song)
    if isinstance(detail, dict):
        merged.update({k: v for k, v in detail.items() if v not in (None, "")})

    title = merged.get("title") or merged.get("name") or merged.get("songName") or None
    artist = (
        merged.get("artist")
        or merged.get("artistName")
        or merged.get("singer")
        or None
    )
    album = merged.get("album") or merged.get("albumName") or None
    cover = merged.get("cover") or merged.get("coverURL") or merged.get("cover_url") or None
    # Electron CSP allows https: images only (not arbitrary http: CDNs)
    if isinstance(cover, str) and cover.startswith("http://"):
        cover = "https://" + cover[len("http://") :]
    audio_id = (
        merged.get("audio_id")
        or merged.get("audioId")
        or merged.get("global_id")
        or merged.get("songID")
        or None
    )

    status = info.get("status")
    try:
        status_i = int(status) if status is not None else None
    except (TypeError, ValueError):
        status_i = None

    duration_ms: Optional[int] = None
    position_ms: Optional[int] = None
    if "duration" in merged:
        try:
            d = float(merged["duration"])
            # song_info returns seconds; play_song_detail uses ms
            duration_ms = int(d if d > 10000 else d * 1000)
        except (TypeError, ValueError):
            pass
    if "position" in merged:
        try:
            position_ms = int(merged["position"])
        except (TypeError, ValueError):
            pass

    playing_label = {0: "idle", 1: "playing", 2: "paused"}.get(status_i or -1)

    return {
        "source": "mina",
        "minaDeviceId": (mina_device or {}).get("deviceID"),
        "hardware": (mina_device or {}).get("hardware"),
        "presence": (mina_device or {}).get("presence"),
        "status": status_i,
        "playing": status_i == 1,
        "paused": status_i == 2,
        "state": playing_label,
        "volume": info.get("volume"),
        "mediaType": info.get("media_type"),
        "loopType": info.get("loop_type"),
        "audioId": str(audio_id) if audio_id is not None else None,
        "title": str(title).strip() if title else None,
        "artist": str(artist).strip() if artist else None,
        "album": str(album).strip() if album else None,
        "coverUrl": str(cover).strip() if cover else None,
        "durationMs": duration_ms,
        "positionMs": position_ms,
        "cpName": merged.get("cpDisplayName") or merged.get("cpName"),
    }
