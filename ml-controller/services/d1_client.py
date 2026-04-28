"""
d1_client.py — Direct Cloudflare D1 REST API client
2026-04-07 Phase 1.6 (Cloud Run version)

跟 ml-service 版相同邏輯，差別在於 Cloud Run 已有 CF env vars，不需要 Modal secret
Required env vars (Cloud Run env):
  CF_API_TOKEN
  CF_ACCOUNT_ID
  CF_D1_DB_ID
"""
from __future__ import annotations
import os
import logging
from typing import Any, Optional

try:
    import httpx
except ModuleNotFoundError:  # allow pure domain tests to import services without HTTP deps
    httpx = None

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
            f"Missing env vars for D1 client: {missing}. Set in Cloud Run env."
        )


def _post(body: dict, timeout: float = 60.0) -> dict:
    """Internal: POST to D1 /query endpoint, return parsed JSON."""
    _check_env()
    if httpx is None:
        raise RuntimeError("D1 request failed: httpx not installed")
    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}"
        f"/d1/database/{CF_D1_DB_ID}/query"
    )
    headers = {
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "application/json",
    }
    try:
        resp = httpx.post(url, headers=headers, json=body, timeout=timeout)
    except httpx.RequestError as e:
        raise RuntimeError(f"D1 request failed: network error: {e}") from e
    if resp.status_code != 200:
        raise RuntimeError(f"D1 request failed: HTTP {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    if not data.get("success"):
        raise RuntimeError(f"D1 request unsuccessful: {data.get('errors', data)}")
    return data


def query(sql: str, params: list[Any] | None = None, timeout: float = 60.0) -> list[dict]:
    """Read query — returns list of row dicts."""
    body: dict = {"sql": sql}
    if params:
        body["params"] = params
    data = _post(body, timeout=timeout)
    result_list = data.get("result", [])
    if not result_list:
        return []
    return result_list[0].get("results", []) or []


def execute(sql: str, params: list[Any] | None = None, timeout: float = 60.0) -> dict:
    """
    Write statement (INSERT/UPDATE/DELETE) — returns meta dict.
    CF D1 REST API uses same /query endpoint for read & write.

    Returns:
        {
          'success': True,
          'meta': {'changes': int, 'last_row_id': int, 'duration': float, ...},
          'results': []  # empty for write
        }
    """
    body: dict = {"sql": sql}
    if params:
        body["params"] = params
    data = _post(body, timeout=timeout)
    result_list = data.get("result", [])
    if not result_list:
        return {"success": True, "meta": {}}
    return {
        "success": True,
        "meta": result_list[0].get("meta", {}),
        "results": result_list[0].get("results", []),
    }


def batch_execute(
    statements: list[tuple[str, list[Any]]],
    timeout: float = 30.0,
) -> dict:
    """
    Execute multiple INSERT/UPDATE/DELETE statements sequentially.

    CF D1 REST API /query endpoint only accepts single statement body
    (object with sql + params), NOT array. So we loop one-by-one.
    For true atomic batching CF has a separate transactions API but
    it's behind a different binding type.

    Args:
        statements: list of (sql, params) tuples
        timeout: per-statement timeout

    Returns:
        {'total': N, 'success_count': K, 'error_count': E, 'changes_total': M}
    """
    if not statements:
        return {"total": 0, "success_count": 0, "error_count": 0, "changes_total": 0}

    success_count = 0
    error_count = 0
    total_changes = 0
    first_error: Optional[str] = None

    for i, (sql, params) in enumerate(statements):
        try:
            r = execute(sql, params, timeout=timeout)
            success_count += 1
            total_changes += (r.get("meta") or {}).get("changes", 0) or 0
        except RuntimeError as e:
            error_count += 1
            if first_error is None:
                first_error = str(e)
            # Continue on error — don't fail whole batch for one bad row
            logger.warning(f"[d1_client] batch_execute statement {i} failed: {e}")

    if error_count > 0:
        logger.warning(
            f"[d1_client] batch_execute: {error_count}/{len(statements)} failed. "
            f"First error: {first_error}"
        )

    return {
        "total": len(statements),
        "success_count": success_count,
        "error_count": error_count,
        "changes_total": total_changes,
        "first_error": first_error,
        "partial_failure": error_count > 0 and success_count > 0,
    }
