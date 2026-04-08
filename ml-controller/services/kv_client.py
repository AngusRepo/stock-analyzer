"""
kv_client.py — Direct Cloudflare KV REST API client (read-only)
2026-04-07 LangGraph A+B refactor

ml-controller LangGraph V2 needs to read KV keys directly:
  - ml:adaptive_params
  - trading:config
  - us:leading:{date}

Required env vars (Cloud Run):
  CF_API_TOKEN          (already exists, reuse from d1_client)
  CF_ACCOUNT_ID         (already exists)
  CF_KV_NAMESPACE_ID    (NEW — must be set in Cloud Run env)
"""
from __future__ import annotations
import os
import json
import logging
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

CF_API_TOKEN       = os.environ.get("CF_API_TOKEN", "")
CF_ACCOUNT_ID      = os.environ.get("CF_ACCOUNT_ID", "")
CF_KV_NAMESPACE_ID = os.environ.get("CF_KV_NAMESPACE_ID", "")


def _check_env():
    missing = [k for k, v in [
        ("CF_API_TOKEN", CF_API_TOKEN),
        ("CF_ACCOUNT_ID", CF_ACCOUNT_ID),
        ("CF_KV_NAMESPACE_ID", CF_KV_NAMESPACE_ID),
    ] if not v]
    if missing:
        raise RuntimeError(
            f"Missing env vars for KV client: {missing}. Set in Cloud Run env."
        )


def get(key: str, timeout: float = 30.0) -> Optional[str]:
    """
    Read raw string from KV. Returns None if key not found.
    """
    _check_env()
    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}"
        f"/storage/kv/namespaces/{CF_KV_NAMESPACE_ID}/values/{key}"
    )
    headers = {"Authorization": f"Bearer {CF_API_TOKEN}"}
    try:
        resp = httpx.get(url, headers=headers, timeout=timeout)
    except httpx.RequestError as e:
        logger.warning(f"[KV] Get failed: {key}: {e}")
        return None
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        logger.warning(f"[KV] Get HTTP {resp.status_code} for {key}: {resp.text[:200]}")
        return None
    return resp.text


def get_json(key: str, default: Any = None, timeout: float = 30.0) -> Any:
    """Read KV value as parsed JSON. Returns default if key missing or unparseable."""
    raw = get(key, timeout=timeout)
    if raw is None:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        logger.warning(f"[KV] Failed to parse JSON for {key}: {e}")
        return default
