"""
kv_pusher.py — 從 ML service 直接 push Optuna 結果到 Worker KV
2026-04-07 新增

統一 helper：取代「local JSON → 人工 wrangler kv put」流程

Worker endpoint: POST /api/admin/optuna-push
Auth: Bearer STOCKVISION_AUTH_TOKEN（與 Worker 共享）

Usage:
    from app.kv_pusher import push_optuna_result
    push_optuna_result(
        source="sltp",
        params={"sl_mult": 1.68, "tp_mult": 2.96, ...},
        meta={"n_trials": 200, "best_score": 0.83},
    )
"""
from __future__ import annotations
import os
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

WORKER_URL = os.environ.get("STOCKVISION_WORKER_URL", "https://stockvision-worker.angus-solo-dev.workers.dev")
AUTH_TOKEN = os.environ.get("STOCKVISION_AUTH_TOKEN", "")


def push_optuna_result(
    source: str,
    params: dict[str, Any],
    meta: dict[str, Any] | None = None,
    timeout: float = 30.0,
) -> dict:
    """
    Push Optuna search result to Worker KV.

    Args:
        source: 'barrier' | 'signal' | 'sltp' | 'conformal' | 'risk_params' | 'rrg' | 'feature_window' | 'regime'
        params: dict of param_name → value (snake_case 或 camelCase 都接受)
        meta:   optional metadata (n_trials, best_score, run_id, ...)

    Returns:
        Worker response dict ({success, source, updatedFields, audit_key} or {error, ...})

    Raises:
        RuntimeError: if Worker call fails
    """
    if not AUTH_TOKEN:
        raise RuntimeError(
            "STOCKVISION_AUTH_TOKEN env var not set. "
            "Set it in Cloud Run env: gcloud run services update ml-controller --set-env-vars STOCKVISION_AUTH_TOKEN=..."
        )

    url = f"{WORKER_URL.rstrip('/')}/api/admin/optuna-push"
    body = {"source": source, "params": params}
    if meta is not None:
        body["meta"] = meta

    headers = {
        "Authorization": f"Bearer {AUTH_TOKEN}",
        "Content-Type": "application/json",
    }

    logger.info(f"[KVPusher] Pushing {source} ({len(params)} params) to Worker...")

    try:
        resp = httpx.post(url, headers=headers, json=body, timeout=timeout)
    except httpx.RequestError as e:
        raise RuntimeError(f"Worker push failed: network error: {e}") from e

    if resp.status_code == 401:
        raise RuntimeError("Worker push failed: 401 Unauthorized (check STOCKVISION_AUTH_TOKEN)")
    if resp.status_code == 400:
        raise RuntimeError(f"Worker push failed: 400 Bad Request: {resp.text}")
    if resp.status_code == 501:
        # source not yet wired (deferred to Phase B/C)
        logger.warning(f"[KVPusher] {source} not yet wired in Worker: {resp.text}")
        return resp.json()
    if resp.status_code != 200:
        raise RuntimeError(f"Worker push failed: HTTP {resp.status_code}: {resp.text}")

    result = resp.json()
    logger.info(f"[KVPusher] {source} pushed OK: {result.get('updatedFields', [])} fields")
    return result


def push_or_log(source: str, params: dict, meta: dict | None = None) -> dict | None:
    """
    Wrapper that catches failures and logs instead of raising.
    Use when Optuna script should keep going even if KV push fails.
    """
    try:
        return push_optuna_result(source, params, meta)
    except Exception as e:
        logger.error(f"[KVPusher] Push failed (continuing anyway): {e}")
        return None
