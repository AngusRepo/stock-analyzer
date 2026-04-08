"""
d1_client.py — Direct Cloudflare D1 REST API client
2026-04-07 added

避免「dump CSV → 跑 script」的舊 pattern，讓 Optuna routes 直接從 D1 抓最新資料。

Cloudflare D1 REST API:
  POST https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{db_id}/query
  Auth: Authorization: Bearer {api_token}
  Body: { "sql": "...", "params": [...] }

Required env vars (set via Modal secret 'stockvision-cf'):
  CF_API_TOKEN
  CF_ACCOUNT_ID
  CF_D1_DB_ID
"""
from __future__ import annotations
import os
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

CF_API_TOKEN  = os.environ.get("CF_API_TOKEN", "")
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_D1_DB_ID   = os.environ.get("CF_D1_DB_ID", "")


def _check_env():
    missing = [k for k, v in [
        ("CF_API_TOKEN", CF_API_TOKEN),
        ("CF_ACCOUNT_ID", CF_ACCOUNT_ID),
        ("CF_D1_DB_ID", CF_D1_DB_ID),
    ] if not v]
    if missing:
        raise RuntimeError(
            f"Missing env vars for D1 client: {missing}. "
            f"Add to Modal secret 'stockvision-cf' or Cloud Run env."
        )


def query(sql: str, params: list[Any] | None = None, timeout: float = 60.0) -> list[dict]:
    """
    Execute SQL on D1 and return results as list of dict (rows).

    Args:
        sql: SQL query (use ? for parameters)
        params: parameter values
        timeout: HTTP timeout in seconds

    Returns:
        list of row dicts (column_name → value)

    Raises:
        RuntimeError: on API error or non-2xx response
    """
    _check_env()

    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}"
        f"/d1/database/{CF_D1_DB_ID}/query"
    )
    headers = {
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "application/json",
    }
    body = {"sql": sql}
    if params:
        body["params"] = params

    try:
        resp = httpx.post(url, headers=headers, json=body, timeout=timeout)
    except httpx.RequestError as e:
        raise RuntimeError(f"D1 query failed: network error: {e}") from e

    if resp.status_code != 200:
        raise RuntimeError(f"D1 query failed: HTTP {resp.status_code}: {resp.text[:300]}")

    data = resp.json()
    if not data.get("success"):
        raise RuntimeError(f"D1 query unsuccessful: {data.get('errors', data)}")

    # CF D1 response: {result: [{results: [...], success: true, meta: {...}}], success: true}
    result_list = data.get("result", [])
    if not result_list:
        return []
    return result_list[0].get("results", []) or []


def query_one(sql: str, params: list[Any] | None = None) -> dict | None:
    """Query and return first row (or None)."""
    rows = query(sql, params)
    return rows[0] if rows else None
