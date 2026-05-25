"""
regime.py — Market regime compute + KV push endpoint

POST /regime/compute
  1. Fetch latest market_env from Worker D1
  2. Call ml-service /regime/current (HMM predict)
  3. Push result to Worker KV via push_optuna_result(source='regime', ...)
     Worker writes market_regime_state and mirrors legacy ml:regime keys during migration.

Trigger: Worker cron `50 10 * * 1-5` (18:50 TW) — after adapt, before EOD
Design: memory/project_regime_pipeline_broken.md (Sprint 4-2 revisit / 2026-04-17 #30)
"""
from __future__ import annotations

import os
import logging
import time
from datetime import datetime, timezone, timedelta

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import modal_client
from services.kv_pusher import push_optuna_result
from services.market_regime_evidence import build_regime_evidence_pack
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
    history_days: int | None = None   # accepted for Worker contract compatibility; load_market_env owns the canonical window


class RegimeComputeRunRequest(RegimeComputeRequest):
    run_id: str | None = None
    callback_task: str = "regime-compute"
    trigger_source: str = "manual"
    trigger_id: str | None = None
    prev_label: str | None = None


def _truthy(value: str | None, *, default: bool = False) -> bool:
    if value is None or not str(value).strip():
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on", "enabled", "modal"}


def _regime_compute_executor() -> str:
    raw = (
        os.environ.get("REGIME_COMPUTE_EXECUTOR")
        or os.environ.get("HMM_REGIME_COMPUTE_EXECUTOR")
        or ""
    ).strip().lower()
    if raw:
        return raw
    return "modal" if _truthy(os.environ.get("REGIME_COMPUTE_MODAL_ENABLED")) else "cloud_run"


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


def build_regime_compute_modal_payload(req: RegimeComputeRunRequest) -> dict:
    run_date = req.run_date or datetime.now(TW_TZ).strftime("%Y-%m-%d")
    run_id = req.run_id or f"regime-compute-{run_date}-{int(time.time())}"
    return {
        "executor": "modal",
        "source": "regime_compute",
        "run_id": run_id,
        "run_date": run_date,
        "force_retrain": bool(req.force_retrain),
        "history_days": req.history_days,
        "callback_task": req.callback_task or "regime-compute",
        "trigger_source": req.trigger_source or "manual",
        "trigger_id": req.trigger_id or run_id,
        "prev_label": req.prev_label,
        "quality_contract": {
            "market_env_history_reduced": False,
            "hmm_regime_logic_reduced": False,
            "kv_push_preserved": True,
            "regime_shift_detection_preserved": True,
            "production_config_mutated": False,
        },
    }


@router.post("/regime/compute/run")
async def regime_compute_run(req: RegimeComputeRunRequest = RegimeComputeRunRequest()):
    """Spawn detached HMM regime compute and close via Worker scheduler callback.

    This route exists to move request waiting out of Cloud Run. It is env-gated;
    the synchronous /regime/compute route remains the rollback owner.
    """
    executor = _regime_compute_executor()
    if executor != "modal":
        raise HTTPException(
            status_code=409,
            detail="REGIME_COMPUTE_EXECUTOR=modal or REGIME_COMPUTE_MODAL_ENABLED=1 required",
        )

    payload = build_regime_compute_modal_payload(req)
    try:
        result = await modal_client.spawn_regime_compute(payload)
    except Exception as exc:
        logger.exception("[Regime] Modal regime_compute spawn failed")
        raise HTTPException(status_code=502, detail=f"Modal regime_compute spawn failed: {exc}") from exc
    return {
        **result,
        "run_id": payload["run_id"],
        "run_date": payload["run_date"],
        "trigger_source": payload["trigger_source"],
        "callback_task": payload["callback_task"],
    }


@router.post("/regime/compute")
async def regime_compute(req: RegimeComputeRequest = RegimeComputeRequest()):
    """Compute current market regime via ml-service HMM and push Worker market_regime_state.

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

    evidence_pack = build_regime_evidence_pack(market_env, raw_label=label_en)
    effective_label = evidence_pack["effective_label"]

    # Push to Worker KV — source='regime' → worker writes market_regime_state plus legacy mirrors
    kv_push_ok = False
    try:
        result = push_optuna_result(
            source="regime",
            params={
                "label":               effective_label,
                "raw_label":           label_en,
                "regime_index":        reg_idx,
                "hmm_state":           hmm_state,
                "label_zh":            label_zh,
                "regime_surface":      regime_surface,
                "consensus_threshold": info.get("consensus_threshold", 0.60),
                "weight_multipliers":  info.get("weight_multipliers", {}),
                "regime_evidence":     evidence_pack,
                "transition_guard":    evidence_pack["transition_guard"],
                "monitors":            evidence_pack["monitors"],
            },
            meta={
                "computed_at": info.get("computed_at", datetime.now(TW_TZ).isoformat()),
                "run_date": market_env.get("requested_run_date"),
            },
        )
        kv_push_ok = bool(result.get("success", False))
    except Exception as e:
        logger.error(f"[Regime] KV push failed: {e}")
        # Don't raise — we want to return the regime info even if KV push fails

    logger.info(f"[Regime] compute done: raw={label_en} effective={effective_label} (idx={reg_idx}) kv_push_ok={kv_push_ok}")

    return {
        "regime_label_en": effective_label,
        "raw_regime_label_en": label_en,
        "regime_index":    reg_idx,
        "hmm_state":       hmm_state,
        "label_zh":        label_zh,
        "regime_surface":  regime_surface,
        "regime_evidence": evidence_pack,
        "transition_guard": evidence_pack["transition_guard"],
        "monitors":        evidence_pack["monitors"],
        "kv_push_ok":      kv_push_ok,
        "computed_at":     info.get("computed_at", datetime.now(TW_TZ).isoformat()),
        "run_date":        market_env.get("requested_run_date"),
    }
