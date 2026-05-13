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
from services.payload_builder import load_market_env
from dataclasses import asdict

logger = logging.getLogger("regime")
router = APIRouter()

TW_TZ = timezone(timedelta(hours=8))

ML_SERVICE_URL    = os.environ.get("ML_SERVICE_URL", "")
ML_SERVICE_SECRET = os.environ.get("ML_SERVICE_SECRET", "")


class RegimeComputeRequest(BaseModel):
    force_retrain: bool = False       # retrain HMM from history before predict
    run_date: str | None = None       # business date from Worker chain; do not infer during backfills


def _extract_regime_surface(info: dict) -> dict:
    raw = (
        info.get("regime_surface")
        or info.get("regime_probabilities")
        or info.get("probabilities")
        or info.get("state_probabilities")
        or {}
    )
    if isinstance(raw, list):
        labels = ["bull_market", "volatile", "sideways", "bear_market"]
        raw = {label: raw[idx] for idx, label in enumerate(labels) if idx < len(raw)}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, float] = {}
    for key, value in raw.items():
        try:
            prob = float(value)
        except (TypeError, ValueError):
            continue
        if prob >= 0:
            out[str(key)] = prob
    return out


def _fetch_market_env_via_payload_builder(run_date: str | None = None) -> dict:
    """Use payload_builder.load_market_env which already knows the canonical
    D1 schema (market_risk + stock_prices TAIEX history + ETF 0050 fallback).
    Saves re-implementing the query here.
    """
    effective_date = run_date or datetime.now(TW_TZ).strftime("%Y-%m-%d")
    market_env, _, _, _, _ = load_market_env(effective_date)
    env_dict = asdict(market_env)
    env_dict["requested_run_date"] = effective_date
    return env_dict


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

    try:
        market_env = _fetch_market_env_via_payload_builder(req.run_date)
    except Exception as e:
        logger.error(f"[Regime] load_market_env failed: {e}")
        raise HTTPException(status_code=502, detail=f"load_market_env failed: {e}")

    if not market_env.get("history"):
        raise HTTPException(status_code=404, detail="market_env has empty history")

    async with httpx.AsyncClient() as client:
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
        regime_surface = _extract_regime_surface(info)

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
                "regime_surface":      regime_surface,
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
        "regime_surface":  regime_surface,
        "kv_push_ok":      kv_push_ok,
        "computed_at":     info.get("computed_at", datetime.now(TW_TZ).isoformat()),
        "run_date":        market_env.get("requested_run_date"),
    }
