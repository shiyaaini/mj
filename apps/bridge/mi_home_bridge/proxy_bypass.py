"""Clear inherited HTTP(S) proxy env so Bridge talks to Mi Cloud / local
services directly. System proxies (Clash / Reqable / corporate) often break
localhost or MITM TLS for mijiaAPI.
"""

from __future__ import annotations

import os

_PROXY_KEYS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "FTP_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "ftp_proxy",
)


def apply_proxy_bypass() -> None:
    for key in _PROXY_KEYS:
        os.environ.pop(key, None)

    extras = ("127.0.0.1", "localhost", "::1", "api.mijia.tech", "*.mijia.tech", "*.mi.com")
    existing = os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or ""
    parts = [p.strip() for p in existing.split(",") if p.strip()]
    for item in extras:
        if item not in parts:
            parts.append(item)
    merged = ",".join(parts)
    os.environ["NO_PROXY"] = merged
    os.environ["no_proxy"] = merged
