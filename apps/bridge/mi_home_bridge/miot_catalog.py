"""Bulk catalog crawl from home.miot-spec.com (icons + Spec presets)."""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional

from . import device_icons, miot_spec
from .config import settings

logger = logging.getLogger(__name__)

HOME_URL = "https://home.miot-spec.com/"
USER_AGENT = "mi-home-pc-bridge/0.2"
CATALOG_VERSION = 1
PRODUCT_SPEC_VERSION = 1

_ROOT = settings.data_dir / "catalog"
_PRODUCTS_DIR = _ROOT / "products"
_ROOT.mkdir(parents=True, exist_ok=True)
_PRODUCTS_DIR.mkdir(parents=True, exist_ok=True)

_INDEX_PATH = _ROOT / "index.json"
_STATUS_PATH = _ROOT / "sync_status.json"

# Keep requests gentle — avoid bans, but faster archive pace
_CRAWL_PAGE_DELAY = 0.5
_ICON_DELAY = 0.4
_SPEC_DELAY = 0.6
_DEFAULT_ICON_WORKERS = 1
_DEFAULT_SPEC_WORKERS = 1

_PAGE_JSON_RE = re.compile(
    r'<script data-page="app" type="application/json">(.*?)</script>',
    re.DOTALL,
)

_status_lock = threading.Lock()
_job_lock = threading.Lock()
_job_thread: Optional[threading.Thread] = None

def _http_get_text(url: str, timeout: float = 25) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _page_props(url: str) -> dict[str, Any]:
    text = _http_get_text(url)
    match = _PAGE_JSON_RE.search(text)
    if not match:
        raise RuntimeError(f"No embedded JSON at {url}")
    return json.loads(match.group(1)).get("props") or {}


def _safe_model(model: str) -> str:
    return re.sub(r"[^\w.\-]+", "_", (model or "").strip())


def product_spec_path(model: str) -> Path:
    return _PRODUCTS_DIR / f"{_safe_model(model)}.json"


def load_index() -> dict[str, Any]:
    if not _INDEX_PATH.exists():
        return {"version": CATALOG_VERSION, "categories": [], "products": {}, "updated_at": 0}
    try:
        data = json.loads(_INDEX_PATH.read_text(encoding="utf-8"))
        if not isinstance(data.get("products"), dict):
            data["products"] = {}
        return data
    except Exception:
        return {"version": CATALOG_VERSION, "categories": [], "products": {}, "updated_at": 0}


def save_index(data: dict[str, Any]) -> None:
    data = {
        **data,
        "version": CATALOG_VERSION,
        "updated_at": int(time.time()),
        "count": len(data.get("products") or {}),
    }
    _INDEX_PATH.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def get_status() -> dict[str, Any]:
    with _status_lock:
        return dict(_read_status_unlocked())


def _read_status_unlocked() -> dict[str, Any]:
    if _STATUS_PATH.exists():
        try:
            return json.loads(_STATUS_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "running": False,
        "phase": "idle",
        "message": "",
        "progress": 0,
        "total": 0,
        "icons_ok": 0,
        "icons_failed": 0,
        "specs_ok": 0,
        "specs_failed": 0,
        "started_at": None,
        "finished_at": None,
        "error": None,
    }


def _set_status(**patch: Any) -> dict[str, Any]:
    with _status_lock:
        cur = _read_status_unlocked()
        cur.update(patch)
        _STATUS_PATH.write_text(json.dumps(cur, ensure_ascii=False, indent=2), encoding="utf-8")
        return dict(cur)


def list_categories() -> list[dict[str, str]]:
    props = _page_props(HOME_URL)
    out: list[dict[str, str]] = []
    for item in props.get("categories") or []:
        slug = str(item.get("slug") or "").strip()
        if not slug:
            continue
        out.append(
            {
                "slug": slug,
                "label": str(item.get("label") or slug),
                "href": str(item.get("href") or f"/s/{slug}"),
            }
        )
    return out


def _normalize_listing_item(item: dict[str, Any], category: str) -> Optional[dict[str, Any]]:
    attrs = item.get("attrs") or {}
    model = str(item.get("model") or attrs.get("model") or "").strip()
    if not model:
        return None
    icon = str(attrs.get("icon_real") or attrs.get("icon") or "").strip()
    name = str(item.get("name") or attrs.get("name") or "")
    brand = str(item.get("brandName") or attrs.get("brand_name") or "")
    return {
        "model": model,
        "name": name,
        "brand": brand,
        "category": category,
        "icon": icon,
        "pd_id": item.get("pdId") or attrs.get("pd_id"),
        "id": item.get("id"),
    }


def crawl_category(slug: str, *, cat_index: int = 0, cat_total: int = 1) -> list[dict[str, Any]]:
    """Paginate /s/{slug} and return normalized products."""
    products: list[dict[str, Any]] = []
    page = 1
    last_page = 1
    while page <= last_page:
        url = f"https://home.miot-spec.com/s/{urllib.parse.quote(slug)}?page={page}"
        props = _page_props(url)
        results = props.get("results") or {}
        last_page = int(results.get("last_page") or 1)
        for raw in results.get("data") or []:
            row = _normalize_listing_item(raw, slug)
            if row:
                products.append(row)
        _set_status(
            phase="crawl",
            message=f"Crawling {slug} page {page}/{last_page} ({cat_index + 1}/{cat_total})",
            progress=cat_index,
            total=cat_total,
        )
        page += 1
        time.sleep(_CRAWL_PAGE_DELAY)
    return products


def crawl_catalog(
    *,
    force: bool = False,
    download_icons: bool = False,
) -> dict[str, Any]:
    """
    Crawl all category listings into catalog/index.json.
    If download_icons=True, download each category's icons right after listing
    so apps/bridge/data/icons/files grows continuously (resume-friendly).
    """
    existing = load_index()
    age = time.time() - int(existing.get("updated_at") or 0)
    if (
        existing.get("products")
        and not force
        and age < 7 * 24 * 3600
        and int(existing.get("count") or len(existing.get("products") or {})) > 100
    ):
        _set_status(
            phase="crawl_done",
            message=f"Using cached catalog index ({len(existing.get('products') or {})} models)",
            progress=1,
            total=1,
        )
        return existing

    _set_status(phase="crawl", message="Fetching category list…", progress=0, total=0, error=None)
    categories = list_categories()
    products: dict[str, dict[str, Any]] = dict(existing.get("products") or {}) if not force else {}
    for i, cat in enumerate(categories):
        slug = cat["slug"]
        try:
            rows = crawl_category(slug, cat_index=i, cat_total=len(categories))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Category crawl failed %s: %s", slug, exc)
            continue
        batch: dict[str, dict[str, Any]] = {}
        for row in rows:
            model = row["model"]
            prev = products.get(model)
            if not prev:
                products[model] = row
                batch[model] = row
            else:
                if not prev.get("icon") and row.get("icon"):
                    prev["icon"] = row["icon"]
                if not prev.get("name") and row.get("name"):
                    prev["name"] = row["name"]
                # Still try icon if missing on disk
                batch[model] = products[model]
        save_index(
            {
                "version": CATALOG_VERSION,
                "categories": categories,
                "products": products,
            }
        )
        if download_icons and batch:
            _set_status(
                phase="icons",
                message=f"Downloading icons for category {slug}…",
                progress=i,
                total=len(categories),
            )
            sync_icons(batch, force=False)
        time.sleep(_CRAWL_PAGE_DELAY)

    data = {
        "version": CATALOG_VERSION,
        "categories": categories,
        "products": products,
    }
    save_index(data)
    _set_status(
        phase="crawl_done",
        message=f"Catalog index: {len(products)} models",
        progress=len(categories),
        total=len(categories),
    )
    return data


def sync_icons(
    products: dict[str, dict[str, Any]],
    *,
    force: bool = False,
    workers: int = _DEFAULT_ICON_WORKERS,
) -> dict[str, int]:
    """Download icons one-by-one with delay; skip already-cached unless force."""
    items = [
        (m, p)
        for m, p in sorted(products.items(), key=lambda x: x[0])
        if (p.get("icon") or "").strip()
    ]
    total = len(items)
    ok = 0
    failed = 0
    skipped = 0
    _set_status(
        phase="icons",
        message="Downloading icons (rate-limited, resume-friendly)…",
        progress=0,
        total=total,
        icons_ok=0,
        icons_failed=0,
    )

    done = 0
    for model, row in items:
        already = (not force) and device_icons.resolve_icon_file(model) is not None
        if already:
            ok += 1
            skipped += 1
            done += 1
            if done % 50 == 0 or done == total:
                _set_status(
                    phase="icons",
                    message=f"Icons {done}/{total} (skipped cached {skipped})",
                    progress=done,
                    total=total,
                    icons_ok=ok,
                    icons_failed=failed,
                )
            continue

        try:
            meta = device_icons.cache_icon_from_url(
                model,
                str(row.get("icon") or ""),
                name=str(row.get("name") or ""),
                brand=str(row.get("brand") or ""),
                force=force,
            )
            if meta and device_icons.resolve_icon_file(model):
                ok += 1
            else:
                failed += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("Icon sync failed %s: %s", model, exc)
            failed += 1
        done += 1
        if done % 5 == 0 or done == total:
            _set_status(
                phase="icons",
                message=f"Icons {done}/{total} (skipped cached {skipped})",
                progress=done,
                total=total,
                icons_ok=ok,
                icons_failed=failed,
            )
        time.sleep(_ICON_DELAY)
    return {"ok": ok, "failed": failed, "total": total, "skipped": skipped}


def load_product_spec(model: str) -> Optional[dict[str, Any]]:
    path = product_spec_path(model)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def ensure_product_spec(model: str, *, force: bool = False) -> Optional[dict[str, Any]]:
    """Fetch /spec/{model} tree + urn and cache as preset; also seed miot_spec instance."""
    model = (model or "").strip()
    if not model:
        return None
    existing = None if force else load_product_spec(model)
    if existing and existing.get("version") == PRODUCT_SPEC_VERSION and existing.get("tree"):
        return existing

    full = device_icons.fetch_product_page_full(model)
    product = full.get("product") or {}
    spec = full.get("spec") or {}
    tree = full.get("tree") or {}
    versions = full.get("versions") or []
    urn = str(spec.get("urn") or "")
    if not urn and versions:
        urn = str((versions[0] or {}).get("urn") or "")

    # Seed instance Spec cache used by Bridge capabilities/actions
    if urn:
        try:
            miot_spec.load_instance_spec(urn)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Instance spec seed failed %s: %s", urn, exc)

    # Keep icon meta in sync when product page has icon
    icon = str(product.get("icon") or "").strip()
    if icon:
        device_icons.cache_icon_from_url(
            model,
            icon,
            name=str(product.get("name") or ""),
            brand=str(product.get("brand") or ""),
            force=False,
        )

    payload = {
        "version": PRODUCT_SPEC_VERSION,
        "model": model,
        "updated_at": int(time.time()),
        "source_url": full.get("source_url") or "",
        "product": {
            "name": product.get("name") or "",
            "model": product.get("model") or model,
            "brand": product.get("brand") or "",
            "icon": icon,
            "href": product.get("href") or "",
            "pluginDownloadHref": product.get("pluginDownloadHref") or "",
        },
        "spec": {"urn": urn, "model": spec.get("model") or model, "version": spec.get("version")},
        "versions": versions,
        "tree": tree,
        # zh labels only — enough for preset UI; full i18n blob is huge
        "i18n_zh": (full.get("i18n") or {}).get("zh_cn") or {},
    }
    path = product_spec_path(model)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return payload


def sync_specs(
    models: list[str],
    *,
    force: bool = False,
    workers: int = _DEFAULT_SPEC_WORKERS,
) -> dict[str, int]:
    """Fetch Spec pages serially; skip already-cached Specs unless force."""
    total = len(models)
    ok = 0
    failed = 0
    skipped = 0
    _set_status(
        phase="specs",
        message="Caching technical specs (rate-limited, resume-friendly)…",
        progress=0,
        total=total,
        specs_ok=0,
        specs_failed=0,
    )

    done = 0
    for model in models:
        existing = None if force else load_product_spec(model)
        if existing and existing.get("version") == PRODUCT_SPEC_VERSION and existing.get("tree"):
            ok += 1
            skipped += 1
            done += 1
            if done % 50 == 0 or done == total:
                _set_status(
                    phase="specs",
                    message=f"Specs {done}/{total} (skipped cached {skipped})",
                    progress=done,
                    total=total,
                    specs_ok=ok,
                    specs_failed=failed,
                )
            continue

        try:
            data = ensure_product_spec(model, force=force)
            if data and data.get("tree"):
                ok += 1
            else:
                failed += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("Spec sync failed %s: %s", model, exc)
            failed += 1
        done += 1
        if done % 3 == 0 or done == total:
            _set_status(
                phase="specs",
                message=f"Specs {done}/{total} (skipped cached {skipped})",
                progress=done,
                total=total,
                specs_ok=ok,
                specs_failed=failed,
            )
        time.sleep(_SPEC_DELAY)
    return {"ok": ok, "failed": failed, "total": total, "skipped": skipped}


def run_full_sync(
    *,
    icons: bool = True,
    specs: bool = True,
    force: bool = False,
    models: Optional[list[str]] = None,
) -> dict[str, Any]:
    """
    Crawl catalog index, download icons, optionally cache Spec presets.
    If models is provided, skip crawl and only sync those models' icons/specs
    (still useful for account devices); for full site pass models=None.
    """
    _set_status(
        running=True,
        phase="start",
        message="Starting catalog sync…",
        progress=0,
        total=0,
        icons_ok=0,
        icons_failed=0,
        specs_ok=0,
        specs_failed=0,
        started_at=int(time.time()),
        finished_at=None,
        error=None,
    )
    try:
        if models:
            index = load_index()
            products = {
                m: (index.get("products") or {}).get(m)
                or {"model": m, "name": "", "brand": "", "icon": "", "category": ""}
                for m in models
                if m
            }
            # Fill missing icons via product page when not in index
            for m, row in list(products.items()):
                if not row.get("icon"):
                    try:
                        info = device_icons.fetch_product_page(m)
                        row["icon"] = info.get("icon") or ""
                        row["name"] = row.get("name") or info.get("name") or ""
                        row["brand"] = row.get("brand") or info.get("brand") or ""
                    except Exception:
                        pass
        else:
            # Crawl categories; download icons per category so files/ grows early
            index = crawl_catalog(force=force, download_icons=icons)
            products = index.get("products") or {}

        icon_stats = {"ok": 0, "failed": 0, "total": 0, "skipped": 0}
        if icons:
            # Resume pass: fill any icons missed during crawl
            icon_stats = sync_icons(products, force=force)

        spec_stats = {"ok": 0, "failed": 0, "total": 0, "skipped": 0}
        if specs:
            model_list = sorted(products.keys())
            spec_stats = sync_specs(model_list, force=force)

        result = {
            "ok": True,
            "products": len(products),
            "icons": icon_stats,
            "specs": spec_stats,
        }
        _set_status(
            running=False,
            phase="done",
            message=(
                f"Done: {len(products)} products, "
                f"icons {icon_stats.get('ok')}/{icon_stats.get('total')}, "
                f"specs {spec_stats.get('ok')}/{spec_stats.get('total')}"
            ),
            progress=len(products),
            total=len(products),
            finished_at=int(time.time()),
            icons_ok=icon_stats.get("ok", 0),
            icons_failed=icon_stats.get("failed", 0),
            specs_ok=spec_stats.get("ok", 0),
            specs_failed=spec_stats.get("failed", 0),
        )
        return result
    except Exception as exc:  # noqa: BLE001
        logger.exception("Catalog sync failed")
        _set_status(
            running=False,
            phase="error",
            message=str(exc),
            error=str(exc),
            finished_at=int(time.time()),
        )
        raise


def start_full_sync_async(
    *,
    icons: bool = True,
    specs: bool = True,
    force: bool = False,
    models: Optional[list[str]] = None,
) -> dict[str, Any]:
    global _job_thread
    with _job_lock:
        if _job_thread and _job_thread.is_alive():
            return {"started": False, "message": "Sync already running", "status": get_status()}

        def _run() -> None:
            try:
                run_full_sync(icons=icons, specs=specs, force=force, models=models)
            except Exception:
                pass

        _job_thread = threading.Thread(target=_run, name="miot-catalog-sync", daemon=True)
        _job_thread.start()
        return {"started": True, "message": "Catalog sync started", "status": get_status()}


def list_products(
    *,
    q: str = "",
    category: str = "",
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    index = load_index()
    products = list((index.get("products") or {}).values())
    qn = q.strip().lower()
    cat = category.strip().lower()
    if cat:
        products = [p for p in products if str(p.get("category") or "").lower() == cat]
    if qn:
        products = [
            p
            for p in products
            if qn in str(p.get("model") or "").lower()
            or qn in str(p.get("name") or "").lower()
            or qn in str(p.get("brand") or "").lower()
        ]
    products.sort(key=lambda p: str(p.get("model") or ""))
    total = len(products)
    slice_ = products[offset : offset + max(0, limit)]
    for row in slice_:
        model = str(row.get("model") or "")
        row["icon_url"] = device_icons.icon_url_for_model(model)
        row["spec_cached"] = product_spec_path(model).exists()
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "products": slice_,
        "index_updated_at": index.get("updated_at"),
        "categories": index.get("categories") or [],
    }
