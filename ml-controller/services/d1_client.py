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
import random
import time
from typing import Any, Optional

try:
    import httpx
except ModuleNotFoundError:  # allow pure domain tests to import services without HTTP deps
    httpx = None

logger = logging.getLogger(__name__)

CF_API_TOKEN  = os.environ.get("CF_API_TOKEN", "")
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_D1_DB_ID   = os.environ.get("CF_D1_DB_ID", "")
WORKER_URL = os.environ.get("STOCKVISION_WORKER_URL", "").strip()
WORKER_AUTH = os.environ.get("STOCKVISION_AUTH_TOKEN", "").strip()
MAX_D1_RETRIES = int(os.environ.get("D1_CLIENT_MAX_RETRIES", "3"))
WORKER_QUERY_MAX_ROWS = max(1, min(int(os.environ.get("D1_WORKER_QUERY_MAX_ROWS", "250000") or "250000"), 250000))


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


def _sleep_before_retry(attempt: int) -> None:
    delay = min(0.5 * (2 ** attempt), 4.0) + random.uniform(0.0, 0.25)
    time.sleep(delay)


def _is_retryable_d1_response(status_code: int, text: str) -> bool:
    if status_code in {429, 500, 502, 503, 504}:
        return True
    lowered = (text or "").lower()
    return "d1 db is overloaded" in lowered or "requests queued for too long" in lowered


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
    last_error: RuntimeError | None = None
    max_attempts = max(1, MAX_D1_RETRIES + 1)

    for attempt in range(max_attempts):
        try:
            resp = httpx.post(url, headers=headers, json=body, timeout=timeout)
        except httpx.RequestError as e:
            last_error = RuntimeError(f"D1 request failed: network error: {e}")
            if attempt < max_attempts - 1:
                _sleep_before_retry(attempt)
                continue
            raise last_error from e

        if resp.status_code != 200:
            last_error = RuntimeError(f"D1 request failed: HTTP {resp.status_code}: {resp.text[:300]}")
            if _is_retryable_d1_response(resp.status_code, resp.text) and attempt < max_attempts - 1:
                logger.warning("[d1_client] retryable D1 response attempt=%s status=%s", attempt + 1, resp.status_code)
                _sleep_before_retry(attempt)
                continue
            raise last_error

        data = resp.json()
        if not data.get("success"):
            error_text = str(data.get("errors", data))
            last_error = RuntimeError(f"D1 request unsuccessful: {data.get('errors', data)}")
            if _is_retryable_d1_response(resp.status_code, error_text) and attempt < max_attempts - 1:
                logger.warning("[d1_client] retryable D1 payload error attempt=%s", attempt + 1)
                _sleep_before_retry(attempt)
                continue
            raise last_error
        return data

    raise last_error or RuntimeError("D1 request failed: exhausted retries")


def _post_raw(body: dict, timeout: float = 60.0) -> dict:
    """Internal: POST to D1 /raw endpoint.

    /raw supports a true batch body and avoids the legacy per-statement HTTP
    fallback when the Worker internal batch route is unavailable.
    """
    _check_env()
    if httpx is None:
        raise RuntimeError("D1 raw request failed: httpx not installed")
    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}"
        f"/d1/database/{CF_D1_DB_ID}/raw"
    )
    headers = {
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "application/json",
    }
    last_error: RuntimeError | None = None
    max_attempts = max(1, MAX_D1_RETRIES + 1)

    for attempt in range(max_attempts):
        try:
            resp = httpx.post(url, headers=headers, json=body, timeout=timeout)
        except httpx.RequestError as e:
            last_error = RuntimeError(f"D1 raw request failed: network error: {e}")
            if attempt < max_attempts - 1:
                _sleep_before_retry(attempt)
                continue
            raise last_error from e

        if resp.status_code != 200:
            last_error = RuntimeError(f"D1 raw request failed: HTTP {resp.status_code}: {resp.text[:300]}")
            if _is_retryable_d1_response(resp.status_code, resp.text) and attempt < max_attempts - 1:
                logger.warning("[d1_client] retryable D1 raw response attempt=%s status=%s", attempt + 1, resp.status_code)
                _sleep_before_retry(attempt)
                continue
            raise last_error

        data = resp.json()
        if not data.get("success"):
            error_text = str(data.get("errors", data))
            last_error = RuntimeError(f"D1 raw request unsuccessful: {data.get('errors', data)}")
            if _is_retryable_d1_response(resp.status_code, error_text) and attempt < max_attempts - 1:
                logger.warning("[d1_client] retryable D1 raw payload error attempt=%s", attempt + 1)
                _sleep_before_retry(attempt)
                continue
            raise last_error
        return data

    raise last_error or RuntimeError("D1 raw request failed: exhausted retries")


def query(sql: str, params: list[Any] | None = None, timeout: float = 60.0) -> list[dict]:
    """Read query — returns list of row dicts."""
    if WORKER_URL and WORKER_AUTH:
        try:
            return _worker_query(sql, params, timeout=timeout)
        except RuntimeError as e:
            logger.warning("[d1_client] worker query failed, falling back to D1 REST query: %s", e)

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
    if WORKER_URL and WORKER_AUTH:
        try:
            return _worker_execute(sql, params, timeout=timeout)
        except RuntimeError as e:
            logger.warning("[d1_client] worker execute failed, falling back to D1 REST query: %s", e)

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
    chunk_size: int = 250,
) -> dict:
    """Execute multiple INSERT/UPDATE/DELETE statements.

    Prefer the Worker internal D1 binding endpoint, which uses `env.DB.batch()`
    and is a real Cloudflare-side batch. Fall back to the legacy REST loop only
    when the Worker route is not configured or temporarily fails.

    Args:
        statements: list of (sql, params) tuples
        timeout: per-statement timeout

    Returns:
        {'total': N, 'success_count': K, 'error_count': E, 'changes_total': M}
    """
    if not statements:
        return {"total": 0, "success_count": 0, "error_count": 0, "changes_total": 0}

    if WORKER_URL and WORKER_AUTH:
        try:
            return _worker_batch_execute(statements, timeout=timeout, chunk_size=chunk_size)
        except RuntimeError as e:
            logger.warning("[d1_client] worker batch failed, falling back to D1 raw batch: %s", e)

    try:
        return _raw_batch_execute(statements, timeout=timeout, chunk_size=chunk_size)
    except RuntimeError as e:
        logger.warning("[d1_client] D1 raw batch failed, falling back to REST loop: %s", e)

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
        "mode": "rest_loop_fallback",
    }


def _raw_batch_execute(
    statements: list[tuple[str, list[Any]]],
    timeout: float = 30.0,
    chunk_size: int = 250,
) -> dict:
    if not statements:
        return {"total": 0, "success_count": 0, "error_count": 0, "changes_total": 0, "mode": "d1_raw_batch"}

    total = 0
    success_count = 0
    error_count = 0
    changes_total = 0
    first_error: str | None = None
    rows_read_total = 0
    rows_written_total = 0
    sql_duration_ms_total = 0.0
    chunk = max(1, min(int(chunk_size or 250), 500))

    for i in range(0, len(statements), chunk):
        part = statements[i:i + chunk]
        data = _post_raw(
            {
                "batch": [
                    {"sql": sql, "params": params or []}
                    for sql, params in part
                ]
            },
            timeout=timeout,
        )
        results = data.get("result") or []
        total += len(part)
        for idx, item in enumerate(results):
            if item.get("success", True):
                success_count += 1
            else:
                error_count += 1
                if first_error is None:
                    first_error = str(item)
            meta = item.get("meta") or {}
            changes_total += int(meta.get("changes") or 0)
            rows_read_total += int(meta.get("rows_read") or 0)
            rows_written_total += int(meta.get("rows_written") or 0)
            timings = meta.get("timings") or {}
            sql_duration_ms_total += float(timings.get("sql_duration_ms") or meta.get("duration") or 0)
        if len(results) < len(part):
            missing = len(part) - len(results)
            error_count += missing
            if first_error is None:
                first_error = f"D1 raw batch returned {len(results)}/{len(part)} result items"

    return {
        "total": total,
        "success_count": success_count,
        "error_count": error_count,
        "changes_total": changes_total,
        "first_error": first_error,
        "partial_failure": error_count > 0 and success_count > 0,
        "mode": "d1_raw_batch",
        "chunk_size": chunk,
        "chunk_count": (len(statements) + chunk - 1) // chunk,
        "rows_read_total": rows_read_total,
        "rows_written_total": rows_written_total,
        "sql_duration_ms_total": round(sql_duration_ms_total, 3),
    }


def _worker_query(sql: str, params: list[Any] | None = None, timeout: float = 60.0) -> list[dict]:
    if httpx is None:
        raise RuntimeError("Worker D1 query failed: httpx not installed")
    if not WORKER_URL or not WORKER_AUTH:
        raise RuntimeError("Worker D1 query failed: STOCKVISION_WORKER_URL/STOCKVISION_AUTH_TOKEN not configured")

    url = f"{WORKER_URL.rstrip('/')}/api/internal/d1/query"
    headers = {
        "Authorization": f"Bearer {WORKER_AUTH}",
        "Content-Type": "application/json",
    }
    body = {"sql": sql, "params": params or [], "max_rows": WORKER_QUERY_MAX_ROWS}
    try:
        resp = httpx.post(url, headers=headers, json=body, timeout=timeout)
    except httpx.RequestError as e:
        raise RuntimeError(f"Worker D1 query failed: network error: {e}") from e
    if resp.status_code != 200:
        raise RuntimeError(f"Worker D1 query failed: HTTP {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    if not data.get("ok"):
        raise RuntimeError(f"Worker D1 query unsuccessful: {data}")
    return data.get("results") or []


def _worker_execute(sql: str, params: list[Any] | None = None, timeout: float = 60.0) -> dict:
    result = _worker_batch_execute([(sql, params or [])], timeout=timeout, chunk_size=1)
    if int(result.get("error_count") or 0) > 0:
        raise RuntimeError(f"Worker D1 execute unsuccessful: {result.get('first_error') or result}")
    return {
        "success": True,
        "meta": {"changes": int(result.get("changes_total") or 0)},
        "results": [],
        "mode": result.get("mode", "worker_d1_batch"),
    }


def _worker_batch_execute(
    statements: list[tuple[str, list[Any]]],
    timeout: float = 30.0,
    chunk_size: int = 250,
) -> dict:
    if not statements:
        return {"total": 0, "success_count": 0, "error_count": 0, "changes_total": 0, "mode": "worker_d1_batch"}
    if httpx is None:
        raise RuntimeError("Worker D1 batch failed: httpx not installed")

    url = f"{WORKER_URL.rstrip('/')}/api/internal/d1/batch"
    headers = {
        "Authorization": f"Bearer {WORKER_AUTH}",
        "Content-Type": "application/json",
    }

    total = 0
    success_count = 0
    error_count = 0
    changes_total = 0
    first_error: str | None = None
    chunk = max(1, min(int(chunk_size or 250), 500))

    for i in range(0, len(statements), chunk):
        part = statements[i:i + chunk]
        body = {
            "statements": [{"sql": sql, "params": params or []} for sql, params in part],
            "max_statements": chunk,
        }
        try:
            resp = httpx.post(url, headers=headers, json=body, timeout=timeout)
        except httpx.RequestError as e:
            raise RuntimeError(f"Worker D1 batch failed: network error: {e}") from e
        if resp.status_code != 200:
            raise RuntimeError(f"Worker D1 batch failed: HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        if not data.get("ok"):
            raise RuntimeError(f"Worker D1 batch unsuccessful: {data}")
        total += int(data.get("total") or len(part))
        success_count += int(data.get("success_count") or len(part))
        error_count += int(data.get("error_count") or 0)
        changes_total += int(data.get("changes_total") or 0)
        if data.get("first_error") and first_error is None:
            first_error = str(data["first_error"])

    return {
        "total": total,
        "success_count": success_count,
        "error_count": error_count,
        "changes_total": changes_total,
        "first_error": first_error,
        "partial_failure": error_count > 0 and success_count > 0,
        "mode": "worker_d1_batch",
        "chunk_size": chunk,
    }
