"""
kv_pusher.py — Push Optuna 結果到 Worker KV (Cloud Run version)
2026-04-07 Phase 1.6

呼叫 Worker /api/admin/optuna-push endpoint
Required env vars (Cloud Run):
  STOCKVISION_AUTH_TOKEN — Worker 共享 token
  STOCKVISION_WORKER_URL — Worker URL（fallback default 寫死）
"""
from __future__ import annotations
import os
import logging
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

WORKER_URL = os.environ.get("STOCKVISION_WORKER_URL", "").strip() or "http://127.0.0.1:8787"
AUTH_TOKEN = os.environ.get("STOCKVISION_AUTH_TOKEN", "")


def _with_optuna_run_context(meta: dict[str, Any] | None) -> dict[str, Any] | None:
    merged = dict(meta or {})
    context = {
        "run_id": os.environ.get("OPTUNA_RUN_ID", "").strip(),
        "cadence": os.environ.get("OPTUNA_CADENCE", "").strip(),
        "run_date": os.environ.get("OPTUNA_RUN_DATE", "").strip(),
    }
    for key, value in context.items():
        if value and not merged.get(key):
            merged[key] = value
    return merged or None


def _retry_delay(base_delay_seconds: float, attempt: int) -> float:
    return max(0.0, base_delay_seconds) * (2 ** max(0, attempt - 1))


def push_optuna_result(
    source: str,
    params: dict[str, Any],
    meta: dict[str, Any] | None = None,
    timeout: float = 30.0,
    max_attempts: int | None = None,
    retry_delay_seconds: float | None = None,
) -> dict:
    """
    Push Optuna search result to Worker KV.

    source: 'barrier' | 'signal' | 'sltp' | 'conformal' | 'risk_params' | 'rrg' | 'feature_window' | 'regime'
    """
    if not AUTH_TOKEN:
        raise RuntimeError("STOCKVISION_AUTH_TOKEN env var not set in Cloud Run")

    url = f"{WORKER_URL.rstrip('/')}/api/admin/optuna-push"
    body: dict = {"source": source, "params": params}
    enriched_meta = _with_optuna_run_context(meta)
    if enriched_meta is not None:
        body["meta"] = enriched_meta

    headers = {
        "Authorization": f"Bearer {AUTH_TOKEN}",
        "Content-Type": "application/json",
    }

    logger.info(f"[KVPusher] Pushing {source} ({len(params)} params)...")

    attempts = max(1, int(max_attempts or os.environ.get("WORKER_PUSH_MAX_ATTEMPTS", "3") or 3))
    delay_seconds = float(
        retry_delay_seconds
        if retry_delay_seconds is not None
        else os.environ.get("WORKER_PUSH_RETRY_DELAY_SECONDS", "2")
        or 2
    )

    resp: httpx.Response | None = None
    last_error: httpx.RequestError | None = None
    for attempt in range(1, attempts + 1):
        try:
            resp = httpx.post(url, headers=headers, json=body, timeout=timeout)
            break
        except httpx.RequestError as e:
            last_error = e
            if attempt >= attempts:
                break
            wait_s = _retry_delay(delay_seconds, attempt)
            logger.warning(
                "[KVPusher] %s push network error on attempt %s/%s: %s; retrying in %.1fs",
                source,
                attempt,
                attempts,
                e,
                wait_s,
            )
            if wait_s > 0:
                time.sleep(wait_s)

    if resp is None:
        raise RuntimeError(
            f"Worker push failed after {attempts} attempts: network error: {last_error}"
        ) from last_error

    if resp.status_code == 401:
        raise RuntimeError("Worker push failed: 401 Unauthorized")
    if resp.status_code == 400:
        raise RuntimeError(f"Worker push failed: 400 Bad Request: {resp.text}")
    if resp.status_code == 501:
        logger.warning(f"[KVPusher] {source} not yet wired: {resp.text}")
        return resp.json()
    if resp.status_code != 200:
        raise RuntimeError(f"Worker push failed: HTTP {resp.status_code}: {resp.text}")

    result = resp.json()
    logger.info(f"[KVPusher] {source} pushed OK: {len(result.get('updatedFields', []))} fields")
    return result
