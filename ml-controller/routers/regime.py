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
import json
import logging
from datetime import datetime, timezone, timedelta
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import d1_client
from services.kv_pusher import push_optuna_result
from services.market_regime_evidence import build_regime_evidence_pack
from services.payload_builder import load_market_env
from dataclasses import asdict

logger = logging.getLogger("regime")
router = APIRouter()

TW_TZ = timezone(timedelta(hours=8))

ML_SERVICE_URL    = os.environ.get("ML_SERVICE_URL", "")
ML_SERVICE_SECRET = os.environ.get("ML_SERVICE_SECRET", "")
FINLAB_MACRO_CONTEXT_DATASETS = (
    "tw_business_indicators",
    "tw_total_pmi",
    "tw_total_nmi",
    "tw_monetary_aggregates",
)


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


def _to_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed and parsed not in (float("inf"), float("-inf")) else None


def _decode_metrics_json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _metric_field_entries(metrics: dict[str, Any]) -> list[dict[str, Any]]:
    fields = metrics.get("fields")
    if not isinstance(fields, dict):
        return []
    return [item for item in fields.values() if isinstance(item, dict)]


def _metric_field_value(entry: dict[str, Any] | None) -> float | None:
    return _to_float((entry or {}).get("value"))


def _first_metric_value(metrics: dict[str, Any]) -> float | None:
    for key in ("latest_signal_score", "latest_value", "value"):
        value = _to_float(metrics.get(key))
        if value is not None:
            return value
    for entry in _metric_field_entries(metrics):
        value = _metric_field_value(entry)
        if value is not None:
            return value
    return None


def _first_metric_date(metrics: dict[str, Any], fallback: str | None = None) -> str | None:
    value = metrics.get("latest_signal_date") or metrics.get("latest_date")
    if value:
        return str(value)[:10]
    for entry in _metric_field_entries(metrics):
        date = entry.get("date")
        if date:
            return str(date)[:10]
    return fallback[:10] if fallback else None


def _business_score_for_macro(signal: float | None) -> float | None:
    if signal is None:
        return None
    return max(-1.0, min(1.0, (signal - 31.0) / 14.0))


def _latest_finlab_macro_quality_rows(run_date: str) -> dict[str, dict[str, Any]]:
    placeholders = ",".join("?" for _ in FINLAB_MACRO_CONTEXT_DATASETS)
    rows = d1_client.query(
        f"""
        SELECT source, dataset, as_of_date, freshness_status, missing_rate,
               latest_materialization, metrics_json, created_at
          FROM source_quality_metrics
         WHERE source = 'finlab'
           AND dataset IN ({placeholders})
           AND (latest_materialization IS NULL OR substr(latest_materialization, 1, 10) <= ?)
         ORDER BY dataset ASC, latest_materialization DESC, as_of_date DESC, created_at DESC
         LIMIT ?
        """,
        [*FINLAB_MACRO_CONTEXT_DATASETS, run_date, len(FINLAB_MACRO_CONTEXT_DATASETS) * 5],
    )
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        dataset = str(row.get("dataset") or "")
        if dataset and dataset not in latest:
            latest[dataset] = row
    return latest


def _merge_macro_into_latest_history(env_dict: dict[str, Any], run_date: str) -> None:
    history = env_dict.get("history")
    if not isinstance(history, dict) or not history:
        return
    keys = [str(key) for key in history.keys() if str(key) <= run_date]
    if not keys:
        return
    latest_key = sorted(keys)[-1]
    row = history.get(latest_key)
    if not isinstance(row, dict):
        return
    for key in (
        "tw_business_signal",
        "business_indicator_score",
        "tw_business_leading_index",
        "tw_business_coincident_index",
        "pmi",
        "nmi",
        "m1b_yoy",
    ):
        if env_dict.get(key) is not None:
            row[key] = env_dict[key]
    if env_dict.get("tw_business_signal_date"):
        row["tw_business_signal_date"] = env_dict["tw_business_signal_date"]


def _enrich_market_env_with_finlab_macro_context(env_dict: dict[str, Any], run_date: str) -> dict[str, Any]:
    try:
        rows_by_dataset = _latest_finlab_macro_quality_rows(run_date)
    except Exception as exc:
        logger.warning("[Regime] FinLab macro context unavailable: %s", exc)
        return env_dict

    sources: dict[str, Any] = {}
    for dataset, row in rows_by_dataset.items():
        metrics = _decode_metrics_json(row.get("metrics_json"))
        sources[dataset] = {
            "as_of_date": row.get("as_of_date"),
            "latest_materialization": row.get("latest_materialization"),
            "freshness_status": row.get("freshness_status"),
        }
        if dataset == "tw_business_indicators":
            fields = _metric_field_entries(metrics)
            signal = _to_float(metrics.get("latest_signal_score")) or _metric_field_value(fields[0] if fields else None)
            signal_date = str(metrics.get("latest_signal_date") or row.get("latest_materialization") or "")[:10] or None
            leading = _metric_field_value(fields[1] if len(fields) > 1 else None)
            coincident = _metric_field_value(fields[2] if len(fields) > 2 else None)
            env_dict["tw_business_signal"] = signal
            env_dict["tw_business_signal_date"] = signal_date
            env_dict["business_indicator_score"] = _business_score_for_macro(signal)
            env_dict["tw_business_leading_index"] = leading
            env_dict["tw_business_coincident_index"] = coincident
        elif dataset == "tw_total_pmi":
            env_dict["pmi"] = _first_metric_value(metrics)
        elif dataset == "tw_total_nmi":
            env_dict["nmi"] = _first_metric_value(metrics)
        elif dataset == "tw_monetary_aggregates":
            env_dict["m1b_yoy"] = _first_metric_value(metrics)

    if sources:
        env_dict["finlab_macro_context_source"] = sources
        _merge_macro_into_latest_history(env_dict, run_date)
    return env_dict


def _fetch_market_env_via_payload_builder(run_date: str | None = None) -> dict:
    """Use payload_builder.load_market_env which already knows the canonical
    D1 schema (market_risk + stock_prices TAIEX history + ETF 0050 fallback).
    Saves re-implementing the query here.
    """
    effective_date = run_date or datetime.now(TW_TZ).strftime("%Y-%m-%d")
    market_env, _, _, _, _ = load_market_env(effective_date)
    env_dict = asdict(market_env)
    env_dict["requested_run_date"] = effective_date
    _enrich_market_env_with_finlab_macro_context(env_dict, effective_date)
    return env_dict


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
