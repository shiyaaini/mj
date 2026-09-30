"""Copy product icon cache into PyInstaller output for packaging."""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_ICONS = ROOT / "data" / "icons"
DST_DATA = ROOT / "dist" / "mi-home-bridge" / "data"
DST_ICONS = DST_DATA / "icons"


def main() -> int:
    exe = ROOT / "dist" / "mi-home-bridge" / "mi-home-bridge.exe"
    if not exe.exists():
        print(f"[pack-data] missing frozen exe: {exe}", file=sys.stderr)
        return 1

    DST_DATA.mkdir(parents=True, exist_ok=True)

    if not SRC_ICONS.exists():
        print(f"[pack-data] skip: no icons at {SRC_ICONS}")
        return 0

    if DST_ICONS.exists():
        shutil.rmtree(DST_ICONS)

    print(f"[pack-data] copying icons -> {DST_ICONS}")
    shutil.copytree(
        SRC_ICONS,
        DST_ICONS,
        ignore=shutil.ignore_patterns("*.tmp", "*.partial", ".gitkeep"),
    )

    files = sum(1 for p in DST_ICONS.rglob("*") if p.is_file())
    size_mb = sum(p.stat().st_size for p in DST_ICONS.rglob("*") if p.is_file()) / (1024 * 1024)
    print(f"[pack-data] done: {files} files, {size_mb:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
