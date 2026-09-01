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
import json
import os
import logging
import random
import time
from typing import Any, Optional

from services.allocator_contract_guard import allocator_contract_guard_enabled

try:
    import httpx
except ModuleNotFoundError:  # allow pure domain tests to import services without HTTP deps
    httpx = None

logger = logging.getLogger(__name__)


class WorkerD1BatchValidationError(RuntimeError):
    """Worker rejected the batch contract; raw REST must not bypass it."""

class D1DurableBatchRetryRequired(RuntimeError):
    """Both true batch transports failed; the owning job must retry idempotently."""


CF_API_TOKEN  = os.environ.get("CF_API_TOKEN", "")
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_D1_DB_ID   = os.environ.get("CF_D1_DB_ID", "")
WORKER_URL = os.environ.get("STOCKVISION_WORKER_URL", "").strip()
STRATEGY_MINING_D1_WORKER_ONLY = os.environ.get(
    "STRATEGY_MINING_D1_WORKER_ONLY", ""
).strip().lower() in {"1", "true", "yes", "on"}
WORKER_AUTH = (
    os.environ.get("STRATEGY_MINING_CALLBACK_TOKEN", "").strip()
    if STRATEGY_MINING_D1_WORKER_ONLY
    else os.environ.get("STOCKVISION_AUTH_TOKEN", "").strip()
)
MAX_D1_RETRIES = int(os.environ.get("D1_CLIENT_MAX_RETRIES", "3"))


def _env_truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _first_sql_token(sql: str) -> str:
    text = (sql or "").strip()
    while text.startswith("--"):
        line_end = text.find("\n")
        if line_end < 0:
            return ""
        text = text[line_end + 1 :].strip()
    return (text.split(None, 1)[0] if text else "").lower()


def _is_mutating_sql(sql: str) -> bool:
    return _first_sql_token(sql) in {
        "alter",
        "create",
        "delete",
        "drop",
        "insert",
        "replace",
        "truncate",
        "update",
        "vacuum",
    }


def _noop_write_meta(changes: int = 1) -> dict:
    changes = max(0, int(changes or 0))
    return {
        "changes": changes,
        "rows_written": changes,
        "duration": 0,
        "timings": {"sql_duration_ms": 0},
        "allocator_contract_noop": True,
    }


def _check_env(database_id: str | None = None):
    resolved_database_id = (database_id or CF_D1_DB_ID).strip()
    missing = [k for k, v in [
        ("CF_API_TOKEN", CF_API_TOKEN),
        ("CF_ACCOUNT_ID", CF_ACCOUNT_ID),
        ("CF_D1_DB_ID", resolved_database_id),
    ] if not v]
    if missing:
        raise RuntimeError(
            f"Missing env vars for D1 client: {missing}. Set in Cloud Run env."
        )


def _sleep_before_retry(attempt: int) -> None:
    delay = min(0.5 * (2 ** attempt), 4.0) + random.uniform(0.0, 0.25)
    time.sleep(delay)


def _is_retryable_d1_response(status_code: int, text: str) -> bool:
    if status_code == 401:
        try:
            payload = json.loads(text or "{}")
        except (TypeError, ValueError):
            return False
        errors = payload.get("errors") if isinstance(payload, dict) else None
        return isinstance(errors, list) and any(
            isinstance(error, dict) and error.get("code") == 10000
            for error in errors
        )
    if status_code in {429, 500, 502, 503, 504}:
        return True
    lowered = (text or "").lower()
    return "d1 db is overloaded" in lowered or "requests queued for too long" in lowered


def _post(body: dict, timeout: float = 60.0, database_id: str | None = None) -> dict:
    """Internal: POST to D1 /query endpoint, return parsed JSON."""
    resolved_database_id = (database_id or CF_D1_DB_ID).strip()
    _check_env(resolved_database_id)
    if httpx is None:
        raise RuntimeError("D1 request failed: httpx not installed")
    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}"
        f"/d1/database/{resolved_database_id}/query"
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


def _post_raw(body: dict, timeout: float = 60.0, database_id: str | None = None) -> dict:
    """Internal: POST to D1 /raw endpoint.

    /raw supports a true batch body and avoids the legacy per-statement HTTP
    fallback when the Worker internal batch route is unavailable.
    """
    resolved_database_id = (database_id or CF_D1_DB_ID).strip()
    _check_env(resolved_database_id)
    if httpx is None:
        raise RuntimeError("D1 raw request failed: httpx not installed")
    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}"
        f"/d1/database/{resolved_database_id}/raw"
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
    if allocator_contract_guard_enabled() and _is_mutating_sql(sql):
        logger.warning("[AllocatorContractGuard] D1 mutation passed to query() was no-op: %s", _first_sql_token(sql))
        return []
    """Read query — returns list of row dicts."""
    if STRATEGY_MINING_D1_WORKER_ONLY:
        result = _worker_strategy_mining_statement(sql, params or [], timeout=timeout)
        return result.get("results", []) or []
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
    if allocator_contract_guard_enabled():
        logger.warning("[AllocatorContractGuard] D1 execute() no-op: %s", _first_sql_token(sql))
        return {"success": True, "meta": _noop_write_meta(1), "results": []}
    if STRATEGY_MINING_D1_WORKER_ONLY:
        result = _worker_strategy_mining_statement(sql, params or [], timeout=timeout)
        return {
            "success": bool(result.get("success", True)),
            "meta": result.get("meta", {}) or {},
            "results": result.get("results", []) or [],
        }
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
    and is a real Cloudflare-side batch. The D1 raw batch endpoint is the
    secondary transport. Both failures are surfaced for durable job retry;
    production never degrades into per-statement HTTP writes.

    Args:
        statements: list of (sql, params) tuples
        timeout: per-statement timeout

    Returns:
        {'total': N, 'success_count': K, 'error_count': E, 'changes_total': M}
    """
    if not statements:
        return {"total": 0, "success_count": 0, "error_count": 0, "changes_total": 0}

    if allocator_contract_guard_enabled():
        total = len(statements)
        logger.warning("[AllocatorContractGuard] D1 batch_execute() no-op statements=%s", total)
        return {
            "total": total,
            "success_count": total,
            "error_count": 0,
            "changes_total": total,
            "first_error": None,
            "partial_failure": False,
            "mode": "allocator_contract_noop",
            "rows_written_total": total,
            "sql_duration_ms_total": 0,
        }

    worker_error: RuntimeError | None = None
    if WORKER_URL and WORKER_AUTH:
        try:
            return _worker_batch_execute(statements, timeout=timeout, chunk_size=chunk_size)
        except WorkerD1BatchValidationError:
            raise
        except RuntimeError as e:
            worker_error = e
            action = "failing closed" if STRATEGY_MINING_D1_WORKER_ONLY else "falling back to D1 raw batch"
            logger.warning("[d1_client] worker batch failed, %s: %s", action, e)

    if STRATEGY_MINING_D1_WORKER_ONLY:
        detail = f"worker={worker_error or 'not_configured'}; worker_only=true; statements={len(statements)}"
        raise D1DurableBatchRetryRequired(detail) from worker_error

    try:
        return _raw_batch_execute(statements, timeout=timeout, chunk_size=chunk_size)
    except RuntimeError as e:
        detail = (
            f"worker={worker_error or 'not_configured'}; raw={e}; "
            f"statements={len(statements)}"
        )
        logger.error("[d1_client] durable batch retry required: %s", detail)
        raise D1DurableBatchRetryRequired(detail) from e


def atomic_batch_execute(
    statements: list[tuple[str, list[Any]]],
    timeout: float = 30.0,
) -> dict:
    """Execute one fail-closed D1 batch without per-statement fallback.

    Promotion pointers must move as one cohort. The ordinary batch helper is
    intentionally resilient across the Worker and raw D1 batch transports,
    but neither path falls back to independent per-statement REST writes.
    """
    if not statements:
        return {
            "total": 0,
            "success_count": 0,
            "error_count": 0,
            "changes_total": 0,
            "mode": "atomic_empty",
            "atomic": True,
        }
    if len(statements) > 500:
        raise RuntimeError(f"Atomic D1 batch exceeds 500 statements: {len(statements)}")
    if allocator_contract_guard_enabled():
        raise RuntimeError("Atomic D1 batch cannot run while allocator contract guard is enabled")
    if not WORKER_URL or not WORKER_AUTH:
        raise RuntimeError("Atomic D1 batch requires the Worker D1 binding endpoint")

    result = _worker_batch_execute(
        statements,
        timeout=timeout,
        chunk_size=len(statements),
    )
    if (
        int(result.get("success_count") or 0) != len(statements)
        or int(result.get("error_count") or 0) != 0
        or bool(result.get("partial_failure"))
    ):
        raise RuntimeError(f"Atomic D1 batch did not fully commit: {result}")
    return {**result, "atomic": True}


def _raw_batch_execute(
    statements: list[tuple[str, list[Any]]],
    timeout: float = 30.0,
    chunk_size: int = 250,
    database_id: str | None = None,
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
            database_id=database_id,
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


def _worker_batch_execute(
    statements: list[tuple[str, list[Any]]],
    timeout: float = 30.0,
    chunk_size: int = 250,
) -> dict:
    if not statements:
        return {"total": 0, "success_count": 0, "error_count": 0, "changes_total": 0, "mode": "worker_d1_batch"}
    if httpx is None:
        raise RuntimeError("Worker D1 batch failed: httpx not installed")

    path = (
        "/api/internal/strategy-mining/d1"
        if STRATEGY_MINING_D1_WORKER_ONLY
        else "/api/internal/d1/batch"
    )
    url = f"{WORKER_URL.rstrip('/')}{path}"
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
        if resp.status_code in {400, 422}:
            raise WorkerD1BatchValidationError(
                f"Worker D1 batch validation failed: HTTP {resp.status_code}: {resp.text[:300]}"
            )
        if resp.status_code != 200:
            raise RuntimeError(f"Worker D1 batch failed: HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        if not data.get("ok"):
            raise RuntimeError(f"Worker D1 batch unsuccessful: {data}")
        total += int(data["total"]) if data.get("total") is not None else len(part)
        success_count += int(data["success_count"]) if data.get("success_count") is not None else len(part)
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


def _worker_strategy_mining_statement(
    sql: str,
    params: list[Any],
    *,
    timeout: float,
) -> dict:
    if not WORKER_URL or not WORKER_AUTH:
        raise RuntimeError("Strategy mining D1 gateway requires Worker URL and dedicated callback token")
    if httpx is None:
        raise RuntimeError("Strategy mining D1 gateway failed: httpx not installed")
    url = f"{WORKER_URL.rstrip('/')}/api/internal/strategy-mining/d1"
    try:
        resp = httpx.post(
            url,
            headers={"Authorization": f"Bearer {WORKER_AUTH}", "Content-Type": "application/json"},
            json={"statements": [{"sql": sql, "params": params or []}], "max_statements": 1},
            timeout=timeout,
        )
    except httpx.RequestError as exc:
        raise RuntimeError(f"Strategy mining D1 gateway network error: {exc}") from exc
    if resp.status_code != 200:
        raise RuntimeError(f"Strategy mining D1 gateway HTTP {resp.status_code}: {resp.text[:300]}")
    payload = resp.json()
    results = payload.get("results") or []
    if not payload.get("ok") or len(results) != 1:
        raise RuntimeError(f"Strategy mining D1 gateway invalid response: {payload}")
    return results[0]
