"""Archive all product icons + Spec trees from home.miot-spec.com.

Stores under apps/bridge/data/ (server-side):
  - catalog/index.json
  - catalog/products/{model}.json   (Spec tree + product meta)
  - icons/files/{model}.png
  - specs/{urn}.json                (instance Spec)

Rate-limited and resume-friendly: re-run anytime to continue.

Usage:
  cd apps/bridge
  .venv\\Scripts\\python.exe -m mi_home_bridge.archive_catalog
  .venv\\Scripts\\python.exe -m mi_home_bridge.archive_catalog --icons-only
  .venv\\Scripts\\python.exe -m mi_home_bridge.archive_catalog --force
"""

from __future__ import annotations

import argparse
import json
import sys
import time


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Archive miot-spec.com icons + Specs")
    parser.add_argument("--icons-only", action="store_true", help="Skip Spec pages")
    parser.add_argument("--specs-only", action="store_true", help="Skip icon files")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-crawl index and re-download even if cached",
    )
    parser.add_argument(
        "--poll",
        type=float,
        default=30.0,
        help="Seconds between status prints while running (0 = no poll loop)",
    )
    args = parser.parse_args(argv)

    from mi_home_bridge import miot_catalog
    from mi_home_bridge.config import settings

    print(f"data_dir: {settings.data_dir}")
    print(f"source:   https://home.miot-spec.com/")
    print("Starting full-site archive (rate-limited, resumable)…", flush=True)

    started = miot_catalog.start_full_sync_async(
        icons=not args.specs_only,
        specs=not args.icons_only,
        force=args.force,
        models=None,
    )
    print(json.dumps(started, ensure_ascii=False, indent=2), flush=True)

    if args.poll <= 0:
        return 0

    # Keep process alive until background job finishes
    while True:
        time.sleep(args.poll)
        st = miot_catalog.get_status()
        print(
            f"[{st.get('phase')}] {st.get('message')} "
            f"progress={st.get('progress')}/{st.get('total')} "
            f"icons_ok={st.get('icons_ok')} specs_ok={st.get('specs_ok')} "
            f"running={st.get('running')}",
            flush=True,
        )
        if not st.get("running"):
            print("FINAL:", json.dumps(st, ensure_ascii=False, indent=2), flush=True)
            return 1 if st.get("phase") == "error" else 0


if __name__ == "__main__":
    sys.exit(main())
