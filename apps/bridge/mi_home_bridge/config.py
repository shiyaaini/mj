from __future__ import annotations

import sys
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Bridge package root: apps/bridge/mi_home_bridge -> apps/bridge
_BRIDGE_ROOT = Path(__file__).resolve().parent.parent


def _default_data_dir() -> Path:
    """Writable cache for icons / Specs. Packaged Electron sets MI_HOME_DATA_DIR."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "data"
    return _BRIDGE_ROOT / "data"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MI_HOME_", env_file=".env", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 8787
    # Auth stays in user config; product icons / Specs live under Bridge data_dir
    auth_path: Path = Path.home() / ".config" / "mi-home-pc" / "auth.json"
    """Server-side cache for icons / catalog Specs / instance Specs (not user home)."""
    data_dir: Path = _default_data_dir()
    mock_mode: bool = False


settings = Settings()
settings.auth_path.parent.mkdir(parents=True, exist_ok=True)
settings.data_dir.mkdir(parents=True, exist_ok=True)
(settings.data_dir / "icons" / "meta").mkdir(parents=True, exist_ok=True)
(settings.data_dir / "icons" / "files").mkdir(parents=True, exist_ok=True)
(settings.data_dir / "catalog" / "products").mkdir(parents=True, exist_ok=True)
(settings.data_dir / "specs").mkdir(parents=True, exist_ok=True)
