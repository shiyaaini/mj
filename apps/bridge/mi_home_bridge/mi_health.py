"""Xiaomi Mi Health (hlth.io.mi.com) client — sport / fitness cloud data."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import struct
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import quote, urlencode

import requests

logger = logging.getLogger(__name__)

ACCOUNT_BASE = "https://account.xiaomi.com"
HEALTH_BASE = "https://hlth.io.mi.com"
SID = "miothealth"
LOGIN_PREFIX = "&&&START&&&"
_TOKEN_TTL_SEC = 6 * 60 * 60


def _rc4_crypt(key: bytes, payload: bytes) -> bytes:
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) % 256
        s[i], s[j] = s[j], s[i]
    i = j = 0

    def next_byte() -> int:
        nonlocal i, j
        i = (i + 1) % 256
        j = (j + s[i]) % 256
        s[i], s[j] = s[j], s[i]
        return s[(s[i] + s[j]) % 256]

    for _ in range(1024):
        next_byte()
    return bytes(b ^ next_byte() for b in payload)


def _gen_nonce() -> bytes:
    raw = bytearray(os.urandom(8))
    raw.extend(struct.pack(">I", int(time.time() // 60)))
    return bytes(raw)


def _gen_signed_nonce(ssecurity: bytes, nonce: bytes) -> bytes:
    return hashlib.sha256(ssecurity + nonce).digest()


def _gen_signature(method: str, path: str, values: dict[str, str], signed_nonce: bytes) -> str:
    base = method + "&" + path + "&data=" + values["data"]
    if "rc4_hash__" in values:
        base += "&rc4_hash__=" + values["rc4_hash__"]
    base += "&" + base64.b64encode(signed_nonce).decode()
    return base64.b64encode(hashlib.sha1(base.encode()).digest()).decode()


def _parse_login(text: str) -> dict[str, Any]:
    if text.startswith(LOGIN_PREFIX):
        text = text[len(LOGIN_PREFIX) :]
    return json.loads(text) if text else {}


class MiHealthClient:
    """Sync client for Mi Health cloud (miothealth)."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._user_id: Optional[str] = None
        self._cookie: Optional[str] = None
        self._ssecurity: Optional[bytes] = None
        self._token_at: float = 0.0

    def clear(self) -> None:
        with self._lock:
            self._user_id = None
            self._cookie = None
            self._ssecurity = None
            self._token_at = 0.0

    def ensure_session(self, auth_data: dict[str, Any], force: bool = False) -> None:
        with self._lock:
            uid = str(auth_data.get("userId") or "")
            if (
                not force
                and self._cookie
                and self._ssecurity
                and self._user_id == uid
                and (time.time() - self._token_at) < _TOKEN_TTL_SEC
            ):
                return
            if not uid or not auth_data.get("passToken"):
                raise RuntimeError("Mi account passToken missing; re-login required")
            cookie, ssecurity = self._login(uid, str(auth_data["passToken"]))
            self._user_id = uid
            self._cookie = cookie
            self._ssecurity = ssecurity
            self._token_at = time.time()

    def _login(self, user_id: str, pass_token: str) -> tuple[str, bytes]:
        r = requests.get(
            f"{ACCOUNT_BASE}/pass/serviceLogin?_json=true&sid={SID}",
            headers={"Cookie": f"userId={user_id}; passToken={pass_token}"},
            timeout=20,
        )
        payload = _parse_login(r.text)
        if "ssecurity" not in payload or "location" not in payload:
            raise RuntimeError(
                f"miothealth login failed: {payload.get('code')} "
                f"{payload.get('desc') or payload.get('description')}"
            )
        ssecurity_b64 = payload["ssecurity"]
        nsec = f"nonce={payload['nonce']}&{ssecurity_b64}"
        client_sign = base64.b64encode(hashlib.sha1(nsec.encode()).digest()).decode()
        loc = requests.get(
            f"{payload['location']}&clientSign={quote(client_sign)}",
            timeout=20,
            allow_redirects=False,
        )
        try:
            cookie_list = loc.raw.headers.getlist("Set-Cookie")  # type: ignore[attr-defined]
        except Exception:
            cookie_list = []
        if not cookie_list:
            # Fallback: single header
            raw = loc.headers.get("Set-Cookie") or ""
            cookie_list = [c.strip() for c in raw.split(",") if "=" in c]
        parts = [c.split(";", 1)[0] for c in cookie_list if c]
        cookie = "; ".join(parts)
        if "serviceToken=" not in cookie:
            raise RuntimeError("miothealth serviceToken missing after login")
        return cookie, base64.b64decode(ssecurity_b64)

    def request(
        self,
        api_path: str,
        payload: dict[str, Any],
        *,
        auth_data: dict[str, Any],
        retry: bool = True,
    ) -> dict[str, Any]:
        self.ensure_session(auth_data)
        assert self._cookie and self._ssecurity
        form = {"data": json.dumps(payload, separators=(",", ":"))}
        nonce = _gen_nonce()
        signed = _gen_signed_nonce(self._ssecurity, nonce)
        form["rc4_hash__"] = _gen_signature("POST", api_path, form, signed)
        encrypted = {
            k: base64.b64encode(_rc4_crypt(signed, v.encode())).decode()
            for k, v in form.items()
        }
        encrypted["signature"] = _gen_signature("POST", api_path, encrypted, signed)
        encrypted["_nonce"] = base64.b64encode(nonce).decode()
        try:
            resp = requests.post(
                HEALTH_BASE + api_path,
                data=urlencode(encrypted),
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Cookie": self._cookie,
                },
                timeout=30,
            )
        except requests.RequestException as exc:
            raise RuntimeError(f"Mi Health request failed: {exc}") from exc

        if resp.status_code in (401, 403) and retry:
            self.ensure_session(auth_data, force=True)
            return self.request(api_path, payload, auth_data=auth_data, retry=False)
        if resp.status_code != 200:
            raise RuntimeError(f"Mi Health HTTP {resp.status_code}: {resp.text[:160]}")

        try:
            plain = _rc4_crypt(signed, base64.b64decode(resp.text))
            body = json.loads(plain)
        except Exception as exc:
            raise RuntimeError(f"Mi Health decode failed: {exc}") from exc

        if body.get("code", 0) != 0:
            msg = str(body.get("message") or body)
            if retry and ("auth" in msg.lower() or body.get("code") in {401, 403, -6}):
                self.ensure_session(auth_data, force=True)
                return self.request(api_path, payload, auth_data=auth_data, retry=False)
            raise RuntimeError(f"Mi Health error {body.get('code')}: {msg}")
        result = body.get("result")
        return result if isinstance(result, dict) else {}

    def get_sport_records(
        self,
        auth_data: dict[str, Any],
        *,
        days: int = 180,
        limit: int = 50,
        max_pages: int = 12,
    ) -> list[dict[str, Any]]:
        tz = timezone(timedelta(hours=8))
        end = datetime.now(tz)
        start = end - timedelta(days=max(1, min(days, 180)))
        start_time = int(start.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
        end_time = int(end.replace(hour=23, minute=59, second=59, microsecond=0).timestamp())

        items: list[dict[str, Any]] = []
        next_key: Optional[str] = None
        seen: set[str] = set()
        for _ in range(max_pages):
            payload: dict[str, Any] = {
                "start_time": start_time,
                "end_time": end_time,
                "limit": limit,
            }
            if next_key:
                payload["next_key"] = next_key
            result = self.request(
                "/app/v1/data/get_sport_records_by_time",
                payload,
                auth_data=auth_data,
            )
            page = result.get("sport_records") or []
            if isinstance(page, list):
                items.extend([x for x in page if isinstance(x, dict)])
            if not result.get("has_more") or not result.get("next_key"):
                break
            candidate = str(result.get("next_key"))
            if candidate in seen:
                break
            seen.add(candidate)
            next_key = candidate
        return items


mi_health_client = MiHealthClient()


def parse_sport_value(item: dict[str, Any]) -> dict[str, Any]:
    raw = item.get("value", {})
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw:
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def is_abwheel_record(item: dict[str, Any], did: str) -> bool:
    payload = parse_sport_value(item)
    item_did = str(item.get("did") or payload.get("did") or "").strip()
    if item_did and item_did == did:
        return True
    blob = " ".join(
        str(x or "")
        for x in (
            item.get("category"),
            item.get("key"),
            payload.get("sport_type"),
            payload.get("title"),
            payload.get("device_model"),
            payload.get("model"),
            payload.get("type"),
        )
    ).lower()
    return any(
        token in blob
        for token in (
            "abwheel",
            "ab_wheel",
            "ab-wheel",
            "ab wheel",
            "健腹",
            "abdominal",
            "jfl001",
        )
    )


def normalize_abwheel_record(item: dict[str, Any], did: str) -> Optional[dict[str, Any]]:
    payload = parse_sport_value(item)
    start_ts = payload.get("start_time") or item.get("time")
    if start_ts is None:
        return None
    try:
        start_i = int(start_ts)
    except (TypeError, ValueError):
        return None
    # health cloud uses seconds
    start_ms = start_i * 1000 if start_i < 10_000_000_000 else start_i

    duration_s = payload.get("duration")
    try:
        duration_s = int(duration_s) if duration_s is not None else None
    except (TypeError, ValueError):
        duration_s = None

    end_ts = payload.get("end_time")
    end_ms: Optional[int] = None
    if end_ts is not None:
        try:
            end_i = int(end_ts)
            end_ms = end_i * 1000 if end_i < 10_000_000_000 else end_i
        except (TypeError, ValueError):
            end_ms = None
    if end_ms is None and duration_s is not None:
        end_ms = start_ms + duration_s * 1000

    def num(key: str) -> Optional[float]:
        v = payload.get(key)
        if v is None or v == "":
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    count = payload.get("count") or payload.get("reps") or payload.get("exercise_count")
    try:
        count_i = int(count) if count is not None else None
    except (TypeError, ValueError):
        count_i = None

    calories = num("calories") or num("total_cal") or num("calorie")
    return {
        "id": str(item.get("time") or start_ms),
        "did": str(item.get("did") or payload.get("did") or did),
        "startTime": start_ms,
        "endTime": end_ms,
        "durationSec": duration_s,
        "count": count_i,
        "calories": calories,
        "category": item.get("category") or item.get("key") or payload.get("sport_type"),
        "title": payload.get("title") or payload.get("name"),
        "raw": payload,
    }
