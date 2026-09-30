"""Load raw MIoT instance specs (with action `in` / `out` piids)."""

from __future__ import annotations

import json
import logging
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional

from .config import settings

logger = logging.getLogger(__name__)

_SPEC_DIR = settings.data_dir / "specs"
_SPEC_DIR.mkdir(parents=True, exist_ok=True)

_memory: dict[str, dict[str, Any]] = {}


def _cache_path(spec_type: str) -> Path:
    safe = spec_type.replace(":", "_").replace("/", "_")
    return _SPEC_DIR / f"{safe}.json"


def load_instance_spec(spec_type: str) -> Optional[dict[str, Any]]:
    if not spec_type:
        return None
    if spec_type in _memory:
        return _memory[spec_type]

    path = _cache_path(spec_type)
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            _memory[spec_type] = data
            return data
        except Exception:
            pass

    url = "https://miot-spec.org/miot-spec-v2/instance?type=" + urllib.parse.quote(
        spec_type,
        safe="",
    )
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "mi-home-pc-bridge/0.2"},
        )
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        _memory[spec_type] = data
        return data
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to load MIoT spec %s: %s", spec_type, exc)
        return None


def find_action(spec: dict[str, Any], siid: int, aiid: int) -> Optional[dict[str, Any]]:
    for svc in spec.get("services") or []:
        if int(svc.get("iid", -1)) != int(siid):
            continue
        for act in svc.get("actions") or []:
            if int(act.get("iid", -1)) == int(aiid):
                return {"service": svc, "action": act}
    return None


def find_property(service: dict[str, Any], piid: int) -> Optional[dict[str, Any]]:
    for prop in service.get("properties") or []:
        if int(prop.get("iid", -1)) == int(piid):
            return prop
    return None


def default_for_format(fmt: str) -> Any:
    f = (fmt or "").lower()
    if f.startswith("bool"):
        return False
    if f.startswith("string"):
        return ""
    if f.startswith("float"):
        return 0.0
    return 0


def short_name_from_urn(type_urn: str, fallback: str = "") -> str:
    parts = str(type_urn or "").split(":")
    # urn:miot-spec-v2:property:on:00000006:...  or urn:yunmai-spec:property:only-upload-count:...
    if len(parts) >= 4 and parts[2] in {"property", "action", "service", "event"}:
        return parts[3] or fallback
    return fallback or (parts[-1] if parts else "unknown")


def action_in_defs(spec: dict[str, Any], siid: int, aiid: int) -> list[dict[str, Any]]:
    """Return ordered input defs: [{piid, name, type, default}, ...]."""
    found = find_action(spec, siid, aiid)
    if not found:
        return []
    svc = found["service"]
    act = found["action"]
    defs: list[dict[str, Any]] = []
    for piid in act.get("in") or []:
        prop = find_property(svc, int(piid))
        fmt = str((prop or {}).get("format") or "uint8")
        type_urn = str((prop or {}).get("type") or "")
        short = short_name_from_urn(type_urn, f"piid-{piid}")
        desc = str((prop or {}).get("description") or short)
        defs.append(
            {
                "piid": int(piid),
                "name": short,
                "desc": desc,
                "format": fmt,
                "default": default_for_format(fmt),
            }
        )
    return defs


def build_action_in(
    defs: list[dict[str, Any]],
    params: Optional[list[Any]] = None,
) -> list[dict[str, Any]]:
    """Build MIoT action `in` payload [{piid, value}, ...]."""
    values = list(params or [])
    payload: list[dict[str, Any]] = []
    for i, item in enumerate(defs):
        if i < len(values):
            raw = values[i]
            # Allow already-shaped {piid, value}
            if isinstance(raw, dict) and "piid" in raw and "value" in raw:
                payload.append({"piid": int(raw["piid"]), "value": raw["value"]})
                continue
            value = raw
        else:
            value = item["default"]
        payload.append({"piid": int(item["piid"]), "value": value})
    return payload


def _access_to_rw(access: Any) -> str:
    """Map Spec access / gatt-access lists to mijia-style 'r'/'w'/'rw'."""
    if not access:
        return ""
    if isinstance(access, str):
        items = [access]
    elif isinstance(access, (list, tuple, set)):
        items = [str(x) for x in access]
    else:
        return ""
    lower = {x.lower() for x in items}
    rw = ""
    # notify-only still useful for UI status chips
    if "read" in lower or "notify" in lower:
        rw += "r"
    if "write" in lower:
        rw += "w"
    return rw


def can_batch_read(access: Any) -> bool:
    """True when cloud/GATT supports an explicit read (not notify-only)."""
    if not access:
        return False
    items = access if isinstance(access, (list, tuple, set)) else [access]
    return any(str(x).lower() == "read" for x in items)


def build_prop_access_index(spec: dict[str, Any]) -> dict[tuple[int, int], dict[str, Any]]:
    """
    (siid, piid) -> {rw, fetchable} using Spec `access`, falling back to `gatt-access`.
    BLE devices (e.g. bwj.diffuser) often leave access=[] and put rights on gatt-access.
    """
    index: dict[tuple[int, int], dict[str, Any]] = {}
    for svc in spec.get("services") or []:
        try:
            siid = int(svc.get("iid"))
        except (TypeError, ValueError):
            continue
        for prop in svc.get("properties") or []:
            try:
                piid = int(prop.get("iid"))
            except (TypeError, ValueError):
                continue
            access = prop.get("access") or []
            gatt = prop.get("gatt-access") or prop.get("gatt_access") or []
            rw = _access_to_rw(access) or _access_to_rw(gatt)
            fetchable = can_batch_read(access) or can_batch_read(gatt)
            index[(siid, piid)] = {"rw": rw, "fetchable": fetchable}
    return index
