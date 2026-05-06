from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

WORKER_URL_ENV = "STOCKVISION_WORKER_URL"
WORKER_AUTH_TOKEN_ENV = "STOCKVISION_AUTH_TOKEN"


class WorkerConfigClientError(RuntimeError):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def worker_url() -> str:
    url = (os.environ.get(WORKER_URL_ENV) or "").strip()
    if not url:
        raise RuntimeError(f"{WORKER_URL_ENV} not set")
    return url.rstrip("/")


def worker_auth_headers(headers: dict[str, str] | None = None) -> dict[str, str]:
    merged = {
        "Authorization": f"Bearer {os.environ.get(WORKER_AUTH_TOKEN_ENV, '')}",
        "Content-Type": "application/json",
    }
    if headers:
        merged.update(headers)
    return merged


async def worker_fetch(
    path: str,
    method: str = "GET",
    json_body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Controller-side Worker admin client."""
    import httpx

    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.request(
            method,
            worker_url() + path,
            headers=worker_auth_headers(headers),
            json=json_body,
        )
    if response.status_code >= 400:
        raise WorkerConfigClientError(response.status_code, f"Worker {method} {path}: {response.text[:200]}")
    data = response.json()
    return data if isinstance(data, dict) else {}


def load_active_trading_config(timeout: float = 10.0) -> dict[str, Any]:
    """Best-effort active trading config loader for offline-tolerant jobs."""
    if not os.environ.get(WORKER_AUTH_TOKEN_ENV):
        return {}
    try:
        import httpx

        response = httpx.get(
            f"{worker_url()}/api/admin/config",
            headers=worker_auth_headers(),
            timeout=timeout,
        )
        if response.status_code != 200:
            logger.warning("[worker_config_client] config fetch failed: HTTP %s", response.status_code)
            return {}
        data = response.json()
        return data if isinstance(data, dict) else {}
    except Exception as exc:  # pragma: no cover - defensive network fallback
        logger.warning("[worker_config_client] config fetch failed: %s", exc)
        return {}
