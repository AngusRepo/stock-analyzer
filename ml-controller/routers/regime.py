"""
regime.py — Market regime compute + KV push endpoint

POST /regime/compute
  1. Fetch latest market_env from Worker D1
  2. Call ml-service /regime/current (HMM predict)
  3. Push result to Worker KV via push_optuna_result(source='regime', ...)

Trigger: Worker cron `50 10 * * 1-5` (18:50 TW) — after adapt, before EOD
Design: memory/project_regime_pipeline_broken.md (Sprint 4-2 revisit / 2026-04-17 #30)
"""
from __future__ import annotations

import os
import logging
from datetime import datetime, timezone, timedelta

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.kv_pusher import push_optuna_result

logger = logging.getLogger("regime")
router = APIRouter()

TW_TZ = timezone(timedelta(hours=8))

ML_SERVICE_URL    = os.environ.get("ML_SERVICE_URL", "")
ML_SERVICE_SECRET = os.environ.get("ML_SERVICE_SECRET", "")
CF_ACCOUNT_ID     = os.environ.get("CF_ACCOUNT_ID", "619a83ac9f20847d9e2f2920823b727d")
CF_D1_DB_ID       = os.environ.get("CF_D1_DB_ID",   "6401a5f6-5767-4fa8-a1a7-ec8d4739ac79")
CF_API_TOKEN      = os.environ.get("CF_API_TOKEN",   "")

D1_API = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_D1_DB_ID}/query"


class RegimeComputeRequest(BaseModel):
    force_retrain: bool = False       # retrain HMM from history before predict
    history_days: int = 180           # window for market_env history pull


async def _fetch_market_env(client: httpx.AsyncClient, history_days: int) -> dict:
    """Pull last N days market_env from D1 → shape expected by regime.py."""
    if not CF_API_TOKEN:
        raise HTTPException(status_code=500, detail="CF_API_TOKEN not set in ml-controller env")

    sql = (
        "SELECT date, market_return_1d, market_return_5d, risk_score, market_bias_20d "
        "FROM market_env_history "
        "WHERE date >= date('now', ?) "
        "ORDER BY date ASC"
    )
    resp = await client.post(
        D1_API,
        json={"sql": sql, "params": [f"-{history_days} days"]},
        headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"},
        timeout=30.0,
    )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"D1 market_env fetch failed: HTTP {resp.status_code}")
    data = resp.json()
    if not data.get("success"):
        raise HTTPException(status_code=502, detail="D1 query returned success=false")
    results = data.get("result", [])
    rows = results[0].get("results", []) if results else []
    if not rows:
        raise HTTPException(status_code=404, detail="No market_env rows in D1")

    # Shape into {history: {date: {...}}} expected by regime.build_market_feature_matrix
    history = {r["date"]: r for r in rows}
    latest = rows[-1]
    return {"history": history, **latest}


@router.post("/regime/compute")
async def regime_compute(req: RegimeComputeRequest = RegimeComputeRequest()):
    """Compute current market regime via ml-service HMM, push label to Worker KV ml:regime.

    Response:
      {
        "regime_label_en": "bull_market|volatile|sideways|bear_market",
        "regime_index":    int,
        "kv_push_ok":      bool,
        "computed_at":     ISO8601,
      }
    """
    if not ML_SERVICE_URL:
        raise HTTPException(status_code=500, detail="ML_SERVICE_URL not set")

    logger.info(f"[Regime] compute start (force_retrain={req.force_retrain})")

    async with httpx.AsyncClient() as client:
        market_env = await _fetch_market_env(client, req.history_days)

        headers = {"Content-Type": "application/json"}
        if ML_SERVICE_SECRET:
            headers["X-Service-Token"] = ML_SERVICE_SECRET
        resp = await client.post(
            f"{ML_SERVICE_URL}/regime/current",
            headers=headers,
            json={"market_env": market_env, "force_retrain": req.force_retrain},
            timeout=120.0,
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"ml-service /regime/current HTTP {resp.status_code}: {resp.text[:200]}")

        info = resp.json()
        label_en  = info.get("regime_label_en", "sideways")
        reg_idx   = int(info.get("regime_index", 2))
        hmm_state = info.get("hmm_state", -1)
        label_zh  = info.get("label_zh", "")

    # Push to Worker KV — source='regime' → worker case handles ml:regime write
    kv_push_ok = False
    try:
        result = push_optuna_result(
            source="regime",
            params={
                "label":               label_en,
                "regime_index":        reg_idx,
                "hmm_state":           hmm_state,
                "label_zh":            label_zh,
                "consensus_threshold": info.get("consensus_threshold", 0.60),
                "weight_multipliers":  info.get("weight_multipliers", {}),
            },
            meta={"computed_at": info.get("computed_at", datetime.now(TW_TZ).isoformat())},
        )
        kv_push_ok = bool(result.get("success", False))
    except Exception as e:
        logger.error(f"[Regime] KV push failed: {e}")
        # Don't raise — we want to return the regime info even if KV push fails

    logger.info(f"[Regime] compute done: {label_en} (idx={reg_idx}) kv_push_ok={kv_push_ok}")

    return {
        "regime_label_en": label_en,
        "regime_index":    reg_idx,
        "hmm_state":       hmm_state,
        "label_zh":        label_zh,
        "kv_push_ok":      kv_push_ok,
        "computed_at":     info.get("computed_at", datetime.now(TW_TZ).isoformat()),
    }
