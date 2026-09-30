"""Download & cache product icons / params from home.miot-spec.com."""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional

from .config import settings

logger = logging.getLogger(__name__)

SPEC_PAGE_BASE = "https://home.miot-spec.com/spec/"
USER_AGENT = "mi-home-pc-bridge/0.2"
META_VERSION = 1
# Soft-refresh product meta/icon from network after this age (seconds)
STALE_SECONDS = 7 * 24 * 3600

_ROOT = settings.data_dir / "icons"
_META_DIR = _ROOT / "meta"
_FILE_DIR = _ROOT / "files"
_ROOT.mkdir(parents=True, exist_ok=True)
_META_DIR.mkdir(parents=True, exist_ok=True)
_FILE_DIR.mkdir(parents=True, exist_ok=True)

# Polite pacing for miot-spec / CDN (avoid IP blocks)
_MIN_REQUEST_INTERVAL = 0.35
_last_request_at = 0.0
_request_lock = threading.Lock()


def _pace_requests() -> None:
    global _last_request_at
    with _request_lock:
        now = time.monotonic()
        wait = _MIN_REQUEST_INTERVAL - (now - _last_request_at)
        if wait > 0:
            time.sleep(wait)
        _last_request_at = time.monotonic()


_memory: dict[str, dict[str, Any]] = {}
_inflight: set[str] = set()
_lock = threading.Lock()

_PAGE_JSON_RE = re.compile(
    r'<script data-page="app" type="application/json">(.*?)</script>',
    re.DOTALL,
)


def _safe_model(model: str) -> str:
    return re.sub(r"[^\w.\-]+", "_", (model or "").strip())


def meta_path(model: str) -> Path:
    return _META_DIR / f"{_safe_model(model)}.json"


def icon_file_path(model: str, ext: str = ".png") -> Path:
    safe = _safe_model(model)
    if not ext.startswith("."):
        ext = f".{ext}"
    return _FILE_DIR / f"{safe}{ext}"


def local_icon_url(model: str) -> str:
    """Bridge-relative URL served to the desktop client."""
    return f"/models/{urllib.parse.quote(model, safe='')}/icon"


def load_meta(model: str) -> Optional[dict[str, Any]]:
    if not model:
        return None
    if model in _memory:
        return _memory[model]
    path = meta_path(model)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("version") != META_VERSION:
            return None
        _memory[model] = data
        return data
    except Exception:
        return None


def _save_meta(model: str, data: dict[str, Any]) -> dict[str, Any]:
    data = {**data, "version": META_VERSION, "model": model, "updated_at": int(time.time())}
    path = meta_path(model)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    _memory[model] = data
    return data


def _http_get(url: str, timeout: float = 15) -> bytes:
    _pace_requests()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_product_page(model: str) -> dict[str, Any]:
    """Parse embedded product JSON from home.miot-spec.com/spec/{model}."""
    full = fetch_product_page_full(model)
    product = full.get("product") or {}
    return {
        "name": str(product.get("name") or ""),
        "model": str(product.get("model") or model),
        "brand": str(product.get("brand") or ""),
        "icon": str(product.get("icon") or "").strip(),
        "href": str(product.get("href") or ""),
        "plugin_download_href": str(product.get("pluginDownloadHref") or ""),
        "source_url": full.get("source_url") or "",
    }


def fetch_product_page_full(model: str) -> dict[str, Any]:
    """Full product page props: product, spec urn, tree, i18n, versions."""
    url = SPEC_PAGE_BASE + urllib.parse.quote(model, safe=".")
    text = _http_get(url).decode("utf-8", errors="replace")
    match = _PAGE_JSON_RE.search(text)
    if not match:
        raise RuntimeError(f"No embedded product JSON for {model}")
    payload = json.loads(match.group(1))
    props = payload.get("props") or {}
    product = props.get("product") or {}
    if not product:
        raise RuntimeError(f"Empty product for {model}")
    return {
        "source_url": url,
        "product": product,
        "spec": props.get("spec") or {},
        "tree": props.get("tree") or {},
        "i18n": props.get("i18n") or {},
        "versions": props.get("versions") or [],
    }


def cache_icon_from_url(
    model: str,
    icon_url: str,
    *,
    name: str = "",
    brand: str = "",
    force: bool = False,
    extra: Optional[dict[str, Any]] = None,
) -> Optional[dict[str, Any]]:
    """
    Cache an icon when the CDN URL is already known (catalog listing),
    without re-fetching the product HTML page.
    """
    model = (model or "").strip()
    icon_url = (icon_url or "").strip()
    if not model or not icon_url:
        return load_meta(model)

    existing = load_meta(model)
    has_file = resolve_icon_file(model) is not None
    if (
        existing
        and has_file
        and not force
        and existing.get("icon") == icon_url
        and not is_stale(existing)
    ):
        return existing

    local_name: Optional[str] = None
    try:
        if force or not has_file or (existing or {}).get("icon") != icon_url:
            path = _download_icon_file(model, icon_url)
            local_name = path.name
        else:
            found = resolve_icon_file(model)
            local_name = found.name if found else None
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to download icon for %s: %s", model, exc)
        found = resolve_icon_file(model)
        local_name = found.name if found else (existing or {}).get("local_file")

    payload: dict[str, Any] = {
        "name": name or (existing or {}).get("name") or "",
        "brand": brand or (existing or {}).get("brand") or "",
        "icon": icon_url,
        "href": (existing or {}).get("href") or f"/p/{model}",
        "plugin_download_href": (existing or {}).get("plugin_download_href") or "",
        "source_url": (existing or {}).get("source_url") or "",
        "local_file": local_name,
    }
    if extra:
        payload.update(extra)
    return _save_meta(model, payload)


def _ext_from_url(url: str) -> str:
    path = urllib.parse.urlparse(url).path
    suffix = Path(path).suffix.lower()
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}:
        return suffix
    return ".png"


def _download_icon_file(model: str, icon_url: str) -> Path:
    body = _http_get(icon_url, timeout=20)
    ext = _ext_from_url(icon_url)
    safe = _safe_model(model)
    path = icon_file_path(model, ext)
    # Atomic write: keep old file until new bytes are in place (avoids GET miss gap)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(body)
    tmp.replace(path)
    for old in _FILE_DIR.glob(f"{safe}.*"):
        if old == path or old.suffix == ".tmp" or old.name.endswith(".tmp"):
            continue
        try:
            old.unlink()
        except OSError:
            pass
    return path


def resolve_icon_file(model: str) -> Optional[Path]:
    meta = load_meta(model)
    if not meta:
        return None
    stored = meta.get("local_file")
    if stored:
        path = Path(stored)
        if path.is_file():
            return path
        # Relative to files dir
        alt = _FILE_DIR / Path(stored).name
        if alt.is_file():
            return alt
    safe = _safe_model(model)
    matches = sorted(_FILE_DIR.glob(f"{safe}.*"))
    return matches[0] if matches else None


def is_stale(meta: Optional[dict[str, Any]]) -> bool:
    if not meta:
        return True
    updated = int(meta.get("updated_at") or 0)
    return (time.time() - updated) > STALE_SECONDS


def ensure_product(
    model: str,
    *,
    force: bool = False,
) -> Optional[dict[str, Any]]:
    """
    Ensure product meta + icon file exist for model.
    Re-fetches from network when force=True, missing, stale, or remote icon URL changed.
    """
    model = (model or "").strip()
    if not model:
        return None

    existing = load_meta(model)
    has_file = resolve_icon_file(model) is not None
    if existing and has_file and not force and not is_stale(existing):
        return existing

    try:
        product = fetch_product_page(model)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to fetch product for %s: %s", model, exc)
        return existing

    icon_url = product.get("icon") or ""
    local_name: Optional[str] = None
    if icon_url:
        try:
            if (
                force
                or not existing
                or existing.get("icon") != icon_url
                or not has_file
            ):
                path = _download_icon_file(model, icon_url)
                local_name = path.name
            else:
                found = resolve_icon_file(model)
                local_name = found.name if found else None
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to download icon for %s: %s", model, exc)
            found = resolve_icon_file(model)
            local_name = found.name if found else None
    elif existing:
        found = resolve_icon_file(model)
        local_name = found.name if found else existing.get("local_file")

    return _save_meta(
        model,
        {
            "name": product.get("name") or "",
            "brand": product.get("brand") or "",
            "icon": icon_url,
            "href": product.get("href") or "",
            "plugin_download_href": product.get("plugin_download_href") or "",
            "source_url": product.get("source_url") or "",
            "local_file": local_name,
        },
    )


def ensure_product_async(model: str, *, force: bool = False) -> None:
    model = (model or "").strip()
    if not model:
        return
    with _lock:
        if model in _inflight:
            return
        meta = load_meta(model)
        if (
            not force
            and meta
            and resolve_icon_file(model)
            and not is_stale(meta)
        ):
            return
        _inflight.add(model)

    def _run() -> None:
        try:
            ensure_product(model, force=force)
        finally:
            with _lock:
                _inflight.discard(model)

    threading.Thread(target=_run, name=f"icon-{model}", daemon=True).start()


def sync_models(models: list[str], *, force: bool = False) -> dict[str, Any]:
    """Download icons/params for a list of models (sequential)."""
    ok: list[str] = []
    failed: list[str] = []
    for model in sorted({m.strip() for m in models if m and m.strip()}):
        meta = ensure_product(model, force=force)
        if meta and (resolve_icon_file(model) or not meta.get("icon")):
            ok.append(model)
        else:
            failed.append(model)
    return {"ok": ok, "failed": failed, "count": len(ok)}


def product_dto(model: str) -> Optional[dict[str, Any]]:
    meta = load_meta(model)
    if not meta:
        return None
    has_file = resolve_icon_file(model) is not None
    return {
        "model": model,
        "name": meta.get("name") or "",
        "brand": meta.get("brand") or "",
        "icon": meta.get("icon") or "",
        "icon_url": local_icon_url(model) if has_file else None,
        "href": meta.get("href") or "",
        "plugin_download_href": meta.get("plugin_download_href") or "",
        "source_url": meta.get("source_url") or "",
        "updated_at": meta.get("updated_at"),
        "cached": has_file,
    }


def icon_url_for_model(model: str) -> Optional[str]:
    if resolve_icon_file(model):
        return local_icon_url(model)
    return None
