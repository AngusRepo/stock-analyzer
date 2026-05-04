"""
ML Model Pool management endpoints (Plan A).

2026-04-19 Stage 0.x bootstrap:
  POST /model_pool/train_dlinear   -> train universal DLinear from D1 close

Future ML_POOL Stage 1+:
  GET  /model_pool/status           -> read model_pool.json
  POST /model_pool/promote/{name}   -> manual challenger -> active
  POST /model_pool/retire/{name}    -> manual active -> retired
  POST /model_pool/promote_check    -> apply lifecycle transitions in model_pool.json
"""
from __future__ import annotations
import logging
import os
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import modal_client
from services.d1_client import query as d1_query
from services import discord_alert  # 2026-04-19 Stage 5
from services.lifecycle_promotion_gate import apply_promotion_gate_to_actions

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/model_pool", tags=["model_pool"])


def _bucket_name() -> str:
    name = os.environ.get("GCS_BUCKET_NAME", "").strip()
    if not name:
        raise HTTPException(status_code=500, detail="GCS_BUCKET_NAME not configured")
    return name


def _bucket_uri(path: str) -> str:
    return f"gs://{_bucket_name()}/{path.lstrip('/')}"


def _model_artifact_path(model_name: str, version: str) -> str:
    if model_name == "KalmanFilter":
        return f"per_stock_state_space/kalman/hyperparams_{version}.json"
    if model_name == "MarkovSwitching":
        return f"per_stock_state_space/markov_switching/hyperparams_{version}.json"
    if model_name in {"ResidualMLP", "GNN"}:
        ext = "joblib" if model_name == "ResidualMLP" else "json"
        folder = model_name.lower().replace("-", "_")
        return f"experimental_shadow/{folder}/{version}.{ext}"
    ext_map = {
        "XGBoost": "joblib",
        "CatBoost": "joblib",
        "ExtraTrees": "joblib",
        "LightGBM": "joblib",
        "FT-Transformer": "joblib",
        "Chronos": "json",
        "DLinear": "pt",
        "PatchTST": "pt",
    }
    ext = ext_map.get(model_name)
    if ext is None:
        raise HTTPException(status_code=400, detail=f"Unknown model {model_name}")
    folder = model_name.lower().replace("-", "_")
    return f"universal/{folder}/{version}.{ext}"


def _model_metadata_path(model_name: str, version: str) -> str:
    if model_name in {"KalmanFilter", "MarkovSwitching"}:
        return _model_artifact_path(model_name, version)
    folder = model_name.lower().replace("-", "_")
    return f"universal/{folder}/metadata_{version}.json"


def _metadata_summary(raw: dict) -> dict:
    keep = (
        "version",
        "model_name",
        "trained_at",
        "saved_at",
        "feature_count",
        "selected_feature_count",
        "feature_selection",
        "best_params",
        "metrics",
        "dataset_snapshot",
        "train_range",
        "validation_range",
        "feature_policy",
        "artifact_schema",
        "schema_hash",
        "model_pool_version",
    )
    summary = {key: raw[key] for key in keep if key in raw}
    feature_names = raw.get("feature_names")
    if isinstance(feature_names, list):
        summary["feature_name_count"] = len(feature_names)
    return summary


def _ic_coverage(diagnostics: dict) -> float | None:
    raw_rows = diagnostics.get("raw_rows")
    production_rows = diagnostics.get("production_rows")
    try:
        raw = float(raw_rows)
        production = float(production_rows)
    except (TypeError, ValueError):
        return None
    if raw <= 0:
        return None
    return round(production / raw, 4)


def _lifecycle_diagnosis(
    *,
    model_name: str,
    entry: dict,
    metadata_exists: bool,
    metadata: dict | None,
) -> dict:
    diagnostics = entry.get("last_ic_diagnostics") or {}
    root_cause = entry.get("last_ic_root_cause")
    error = entry.get("last_ic_error")
    sample_count = int(entry.get("last_ic_sample_count") or 0)
    metadata_feature_count = None
    if isinstance(metadata, dict):
        metadata_feature_count = metadata.get("feature_count") or metadata.get("feature_name_count")

    blockers: list[str] = []
    if not metadata_exists:
        blockers.append("metadata_missing")
    if error:
        blockers.append(str(error))
    if root_cause and root_cause != "ok":
        blockers.append(str(root_cause))
    if sample_count <= 0:
        blockers.append("ic_sample_missing")
    if model_name == "FT-Transformer" and metadata_exists and not metadata_feature_count:
        blockers.append("ft_feature_metadata_missing")

    if not blockers:
        status = "ok"
        reason = "IC, samples, metadata are present."
    elif "metadata_missing" in blockers or "ft_feature_metadata_missing" in blockers:
        status = "artifact_mismatch"
        reason = "Artifact metadata is missing or incomplete; train/serve schema cannot be audited."
    elif "prediction_missing" in blockers:
        status = "prediction_missing"
        reason = "No prediction rows were found for this model in the IC lookback window."
    elif "outcome_missing" in blockers:
        status = "outcome_missing"
        reason = "Prediction rows exist but verified outcome labels are missing."
    elif "ranking_signal_missing" in blockers:
        status = "ranking_signal_missing"
        reason = "Prediction rows exist but forecast_data.rank_score is missing."
    elif "coverage_low" in blockers:
        status = "coverage_low"
        reason = "Model has too few production samples to compute stable IC."
    else:
        status = "warn"
        reason = "Lifecycle evidence is incomplete; inspect diagnostics."

    return {
        "status": status,
        "reason": reason,
        "blockers": blockers,
        "coverage": _ic_coverage(diagnostics),
        "sample_count": sample_count,
        "root_cause": root_cause,
        "error": error,
        "metadata_feature_count": metadata_feature_count,
    }


def _build_lifecycle_review_packet(
    *,
    actions: list[dict],
    promotion_gate: dict | None,
    shadow_ab_by_model: dict | None,
    paper_order_ab_by_model: dict | None,
) -> dict:
    promote_like = [a for a in actions if str(a.get("transition") or "").startswith("promote")]
    blocked = [a for a in actions if a.get("transition") == "promote_blocked"]
    return {
        "summary": {
            "actions": len(actions),
            "promote_candidates": len(promote_like),
            "blocked_promotions": len(blocked),
            "gate_decision": (promotion_gate or {}).get("decision"),
            "gate_passed": (promotion_gate or {}).get("passed"),
        },
        "required_evidence": {
            "ic": "challenger.ic_4w_avg must beat active by policy margin",
            "pbo": "promotion_gate must include PBO evidence",
            "monte_carlo": "promotion_gate must include Monte Carlo evidence",
            "deflated_sharpe": "promotion gate policy evaluates risk-adjusted evidence when available",
            "shadow_ab": "shadow prediction evidence must pass when require_shadow_ab=true",
            "paper_order_ab": "paper order AB evidence must pass when require_paper_order_ab=true",
        },
        "promotion_gate": promotion_gate,
        "shadow_ab_by_model": shadow_ab_by_model or {},
        "paper_order_ab_by_model": paper_order_ab_by_model or {},
        "blocked": [
            {
                "model": a.get("model"),
                "reason": a.get("reason"),
                "preconditions_failed": a.get("preconditions_failed") or [],
            }
            for a in blocked
        ],
    }


# ---------------------------------------------------------------------------
# DLinear universal training
# ---------------------------------------------------------------------------


class TrainDLinearRequest(BaseModel):
    """One-shot universal DLinear training request."""
    lookback_days: int = 365            # how much close history to use per stock
    min_history_days: int = 90          # skip stocks with < N days history
    max_stocks: int = 1500              # cap to avoid Modal payload bloat
    seq_len: int = 60
    pred_len: int = 5
    kernel: int = 25
    n_epochs: int = 30
    batch_size: int = 256
    lr: float = 1e-3
    val_ratio: float = 0.15
    version: str = "v1"
    confirm: bool = False               # explicit guard (training overwrites GCS)


@router.post("/train_dlinear")
async def train_dlinear(req: TrainDLinearRequest):
    """One-shot universal DLinear training.

    Loads close prices for up to max_stocks tradable stocks (delisted_date
    NULL + min_history_days history), forwards to Modal train function,
    returns saved GCS paths + training metadata.
    """
    if not req.confirm:
        raise HTTPException(
            status_code=400,
            detail="train_dlinear requires confirm=true -> overwrites " + _bucket_uri(f"universal/dlinear/{req.version}.pt"),
        )

    t0 = time.time()
    tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
    end_date = tw_now.date().isoformat()
    start_date = (
        datetime.fromisoformat(end_date) - timedelta(days=req.lookback_days)
    ).date().isoformat()

    # 1. Pull close per stock (single GROUP_CONCAT-free query, in-Python group)
    # Query all (symbol, date, close) within lookback for tradable stocks,
    # group in Python to avoid SQLite GROUP_CONCAT row limits.
    sql = """
        SELECT s.symbol, sp.date, sp.close
        FROM stocks s
        JOIN stock_prices sp ON sp.stock_id = s.id
        WHERE s.delisted_date IS NULL
          AND s.sector IS NOT NULL AND s.sector != ''
          AND sp.date >= ? AND sp.date <= ?
          AND sp.close IS NOT NULL
        ORDER BY s.symbol, sp.date
    """
    rows = d1_query(sql, [start_date, end_date])
    if not rows:
        raise HTTPException(status_code=400, detail=f"No close rows in {start_date}~{end_date}")

    by_symbol: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        try:
            by_symbol[r["symbol"]].append(float(r["close"]))
        except (TypeError, ValueError):
            continue

    # Filter by min history; cap to max_stocks
    eligible = [(sym, prices) for sym, prices in by_symbol.items() if len(prices) >= req.min_history_days]
    eligible.sort(key=lambda x: -len(x[1]))  # longest history first
    eligible = eligible[: req.max_stocks]

    series_close = [prices for _, prices in eligible]
    if not series_close:
        raise HTTPException(
            status_code=400,
            detail=f"0 stocks with >= {req.min_history_days}d history in window",
        )

    logger.info(
        f"[ModelPool] DLinear train candidates: {len(series_close)} stocks "
        f"(window {start_date}~{end_date}, min_history={req.min_history_days})"
    )

    # 2. Modal training
    try:
        result = await modal_client.train_dlinear_universal(
            series_close=series_close,
            seq_len=req.seq_len,
            pred_len=req.pred_len,
            kernel=req.kernel,
            n_epochs=req.n_epochs,
            batch_size=req.batch_size,
            lr=req.lr,
            val_ratio=req.val_ratio,
            version=req.version,
        )
    except Exception as e:
        logger.error(f"[ModelPool] DLinear train Modal call failed: {e}")
        raise HTTPException(status_code=500, detail=f"Modal call failed: {e}")

    if result.get("error"):
        return {
            "status": "error",
            "error": result.get("error"),
            "trace": (result.get("trace") or "")[:500],
            "input_stocks": len(series_close),
            "elapsed_s": round(time.time() - t0, 1),
        }

    md = result.get("metadata", {})
    return {
        "status": "success",
        "version": result.get("version"),
        "saved": result.get("saved"),
        "input_stocks": len(series_close),
        "lookback_window": [start_date, end_date],
        "min_history_days": req.min_history_days,
        "best_val_loss": md.get("best_val_loss"),
        "val_dir_accuracy": md.get("val_dir_accuracy"),
        "n_train_windows": md.get("n_train_windows"),
        "n_val_windows": md.get("n_val_windows"),
        "training_elapsed_s": md.get("elapsed_s"),
        "total_elapsed_s": round(time.time() - t0, 1),
    }


# ---------------------------------------------------------------------------
# Status / read-only (placeholders for ML_POOL Stage 1+)
# ---------------------------------------------------------------------------


# 2026-04-19 ML_POOL Stage 0.3: PatchTST universal training (parallel structure to DLinear)


class TrainPatchTSTRequest(BaseModel):
    lookback_days: int = 365
    min_history_days: int = 90
    max_stocks: int = 1500
    seq_len: int = 60
    pred_len: int = 5
    patch_len: int = 12
    stride: int = 12
    d_model: int = 128
    n_heads: int = 8
    n_layers: int = 3
    dropout: float = 0.1
    n_epochs: int = 30
    batch_size: int = 256
    lr: float = 5e-4
    weight_decay: float = 1e-5
    val_ratio: float = 0.15
    version: str = "v1"
    confirm: bool = False


@router.post("/train_patchtst")
async def train_patchtst(req: TrainPatchTSTRequest):
    """One-shot universal PatchTST training. Mirrors /train_dlinear pipeline."""
    if not req.confirm:
        raise HTTPException(
            status_code=400,
            detail="train_patchtst requires confirm=true -> overwrites " + _bucket_uri(f"universal/patchtst/{req.version}.pt"),
        )

    t0 = time.time()
    tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
    end_date = tw_now.date().isoformat()
    start_date = (
        datetime.fromisoformat(end_date) - timedelta(days=req.lookback_days)
    ).date().isoformat()

    sql = """
        SELECT s.symbol, sp.date, sp.close
        FROM stocks s
        JOIN stock_prices sp ON sp.stock_id = s.id
        WHERE s.delisted_date IS NULL
          AND s.sector IS NOT NULL AND s.sector != ''
          AND sp.date >= ? AND sp.date <= ?
          AND sp.close IS NOT NULL
        ORDER BY s.symbol, sp.date
    """
    rows = d1_query(sql, [start_date, end_date])
    if not rows:
        raise HTTPException(status_code=400, detail=f"No close rows in {start_date}~{end_date}")

    by_symbol: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        try:
            by_symbol[r["symbol"]].append(float(r["close"]))
        except (TypeError, ValueError):
            continue

    eligible = [(sym, prices) for sym, prices in by_symbol.items() if len(prices) >= req.min_history_days]
    eligible.sort(key=lambda x: -len(x[1]))
    eligible = eligible[: req.max_stocks]
    series_close = [prices for _, prices in eligible]
    if not series_close:
        raise HTTPException(
            status_code=400,
            detail=f"0 stocks with >= {req.min_history_days}d history in window",
        )

    logger.info(
        f"[ModelPool] PatchTST train candidates: {len(series_close)} stocks "
        f"(window {start_date}~{end_date}, min_history={req.min_history_days})"
    )

    try:
        result = await modal_client.train_patchtst_universal(
            series_close=series_close,
            seq_len=req.seq_len,
            pred_len=req.pred_len,
            patch_len=req.patch_len,
            stride=req.stride,
            d_model=req.d_model,
            n_heads=req.n_heads,
            n_layers=req.n_layers,
            dropout=req.dropout,
            n_epochs=req.n_epochs,
            batch_size=req.batch_size,
            lr=req.lr,
            weight_decay=req.weight_decay,
            val_ratio=req.val_ratio,
            version=req.version,
        )
    except Exception as e:
        logger.error(f"[ModelPool] PatchTST train Modal call failed: {e}")
        raise HTTPException(status_code=500, detail=f"Modal call failed: {e}")

    if result.get("error"):
        return {
            "status": "error",
            "error": result.get("error"),
            "trace": (result.get("trace") or "")[:500],
            "input_stocks": len(series_close),
            "elapsed_s": round(time.time() - t0, 1),
        }

    md = result.get("metadata", {})
    return {
        "status": "success",
        "version": result.get("version"),
        "saved": result.get("saved"),
        "input_stocks": len(series_close),
        "lookback_window": [start_date, end_date],
        "min_history_days": req.min_history_days,
        "best_val_loss": md.get("best_val_loss"),
        "val_dir_accuracy": md.get("val_dir_accuracy"),
        "n_train_windows": md.get("n_train_windows"),
        "n_val_windows": md.get("n_val_windows"),
        "training_elapsed_s": md.get("elapsed_s"),
        "total_elapsed_s": round(time.time() - t0, 1),
    }


# ---------------------------------------------------------------------------
# Stage 3: Challenger registration / discard (manual triggers; auto-register
# on retrain success will be wired in Stage 4 promote-gate work)
# ---------------------------------------------------------------------------


class RegisterChallengerRequest(BaseModel):
    model_name: str            # one of MANAGED_MODELS keys
    version: str               # e.g. "v2" -> must differ from active
    confirm: bool = False


@router.post("/register_challenger")
async def register_challenger(req: RegisterChallengerRequest):
    """Mark a model version as challenger (shadow mode).

    Caller must have already trained + saved the artifact at the implied
    GCS path. This endpoint only
    writes the bookkeeping entry to model_pool.json so predict_stock_v2
    knows to also load + inference with the challenger.

    Inference behavior after registration:
      - Active version still drives ensemble vote (status_filter=1.0)
      - Challenger predicts in parallel; result written to D1 as
        model_name='{name}::challenger'
      - Stage 4 promote gate compares challenger vs active weekly_ic
    """
    if not req.confirm:
        raise HTTPException(status_code=400, detail="register_challenger requires confirm=true")
    import json as _json
    from datetime import datetime, timezone
    from google.cloud import storage

    bucket = storage.Client().bucket(_bucket_name())
    pool_blob = bucket.blob("universal/model_pool.json")
    if not pool_blob.exists():
        raise HTTPException(status_code=400, detail="model_pool.json not initialized; run /init first")
    pool = _json.loads(pool_blob.download_as_text())
    entry = pool.get("models", {}).get(req.model_name)
    if not entry:
        raise HTTPException(status_code=400, detail=f"{req.model_name} not in pool")
    if entry.get("version") == req.version:
        raise HTTPException(
            status_code=400,
            detail=f"{req.model_name} active is already {req.version}; challenger must differ",
        )

    target_path = _model_artifact_path(req.model_name, req.version)

    # Verify artifact exists at expected path
    if not bucket.blob(target_path).exists():
        raise HTTPException(
            status_code=400,
            detail=f"Challenger artifact missing at {target_path}; train it first",
        )

    today = datetime.now(timezone.utc).date().isoformat()
    entry["challenger"] = {
        "version": req.version,
        "gcs_path": target_path,
        "shadow_since": today,
        "weekly_ic": [],
        "ic_4w_avg": None,
        "consecutive_negative_weeks": 0,
    }
    pool["last_updated"] = datetime.now(timezone.utc).isoformat()
    pool_blob.upload_from_string(_json.dumps(pool, indent=2, ensure_ascii=False), content_type="application/json")

    # Stage 5 alert (graceful no-op if DISCORD_WEBHOOK_URL absent)
    try:
        discord_alert.alert_lifecycle(
            event="register",
            model_name=req.model_name,
            from_status=None, to_status=f"challenger:{req.version}",
            reason=f"New shadow version registered. Active stays {entry.get('version')}.",
            metrics={"gcs_path": target_path, "shadow_since": today},
        )
    except Exception as _e:
        logger.debug(f"[ModelPool] register alert skipped: {_e}")
    return {"status": "registered", "model": req.model_name, "challenger": entry["challenger"]}


class DiscardChallengerRequest(BaseModel):
    model_name: str
    confirm: bool = False


@router.post("/discard_challenger")
async def discard_challenger(req: DiscardChallengerRequest):
    """Remove challenger entry (used for rollback or Stage 4 retire-not-promote)."""
    if not req.confirm:
        raise HTTPException(status_code=400, detail="discard_challenger requires confirm=true")
    import json as _json
    from datetime import datetime, timezone
    from google.cloud import storage
    bucket = storage.Client().bucket(_bucket_name())
    pool_blob = bucket.blob("universal/model_pool.json")
    if not pool_blob.exists():
        raise HTTPException(status_code=400, detail="model_pool.json not initialized")
    pool = _json.loads(pool_blob.download_as_text())
    entry = pool.get("models", {}).get(req.model_name)
    if not entry:
        raise HTTPException(status_code=400, detail=f"{req.model_name} not in pool")
    removed = entry.pop("challenger", None)
    pool["last_updated"] = datetime.now(timezone.utc).isoformat()
    pool_blob.upload_from_string(_json.dumps(pool, indent=2, ensure_ascii=False), content_type="application/json")
    try:
        if removed:
            discord_alert.alert_lifecycle(
                event="discard",
                model_name=req.model_name,
                from_status=f"challenger:{removed.get('version')}",
                to_status=None,
                reason="Manual discard or Stage 4 retire-not-promote.",
                metrics={"weekly_ic_count": len(removed.get("weekly_ic") or []),
                          "ic_4w_avg": removed.get("ic_4w_avg")},
            )
    except Exception as _e:
        logger.debug(f"[ModelPool] discard alert skipped: {_e}")
    return {"status": "discarded", "model": req.model_name, "removed": removed}


# ---------------------------------------------------------------------------
# Stage 2: Weekly IC tracker (cron-driven)
# ---------------------------------------------------------------------------


class ComputeWeeklyICRequest(BaseModel):
    lookback_days: int = 7              # Friday cron rolls last 7 days of verified rows
    history_max: int = 26               # cap weekly_ic array (~6 months rolling)
    min_samples: int = 50               # IC noise floor -> skip if fewer obs/model
    update_pool: bool = True            # write back to model_pool.json
    append_history: bool = True         # false = rolling refresh only; do not append weekly lifecycle history


@router.post("/compute_weekly_ic")
async def compute_weekly_ic(req: ComputeWeeklyICRequest):
    """Compute Spearman IC per managed model from last lookback_days of
    verified predictions, append to model_pool.json weekly_ic, recompute
    ic_4w_avg, increment consecutive_negative_weeks if IC<0.

    Reads:
      D1 predictions WHERE
        model_name IN (8 alpha prediction models + shadow challenger rows)
        AND verified_at IS NOT NULL
        AND prediction business date >= date('now','-7 days')

    Writes:
      gs://<configured bucket>/universal/model_pool.json
        models[name].weekly_ic.append(this_week_ic)
        models[name].ic_4w_avg = mean(weekly_ic[-4:])
        models[name].consecutive_negative_weeks (incr if < 0 else 0)

    NOTE: Stage 4 promote/demote logic reads these accumulated metrics; Stage 2
    only WRITES the metrics. Decay/promotion threshold logic stays separate.
    """
    import json as _json
    from datetime import datetime, timezone
    from google.cloud import storage
    from services.model_ic_tracker import (
        apply_weekly_ic_to_pool,
        compute_weekly_ic_from_rows,
        tracked_model_names,
    )

    t0 = time.time()
    all_tracked = tracked_model_names()

    # 1. Pull broad per-model rows from D1. The domain service classifies
    # missing verification/outcome/rank-signal root causes instead of letting SQL
    # hide them behind a generic insufficient_samples result.
    placeholders = ",".join(["?"] * len(all_tracked))
    sql = f"""
        SELECT model_name, direction_accuracy, forecast_data, actual_return_pct, verified_at, prediction_date
        FROM predictions
        WHERE model_name IN ({placeholders})
          AND date(prediction_date) >= date('now', ?)
    """
    rows = d1_query(sql, [*all_tracked, f"-{req.lookback_days} days"])
    per_model_ic = compute_weekly_ic_from_rows(rows, min_samples=req.min_samples, all_tracked=all_tracked)

    # 3. Update model_pool.json.
    # Active rows update entry.weekly_ic; challenger rows update
    # entry.challenger.weekly_ic (separate IC history per shadow version).
    pool_changes: dict[str, dict] = {}
    if req.update_pool:
        try:
            bucket = storage.Client().bucket(_bucket_name())
            pool_blob = bucket.blob("universal/model_pool.json")
            if pool_blob.exists():
                pool = _json.loads(pool_blob.download_as_text())
                pool_changes, changed = apply_weekly_ic_to_pool(
                    pool,
                    per_model_ic,
                    history_max=req.history_max,
                    append_history=req.append_history,
                )
                if changed:
                    pool["last_updated"] = datetime.now(timezone.utc).isoformat()
                    pool_blob.upload_from_string(
                        _json.dumps(pool, indent=2, ensure_ascii=False),
                        content_type="application/json",
                    )
        except Exception as e:
            logger.error(f"[ModelPool] weekly_ic pool update failed: {e}")
            return {"status": "error", "error": f"pool_update_failed: {e}", "per_model_ic": per_model_ic}

    # 4. Stage 5 alerts: weekly summary + decay-detection per-event
    # Decay rules (per ML_POOL_ARCHITECTURE.md, NOT auto-flipping status;
    # Stage 4 promote gate owns the actual transitions):
    #   active model with consecutive_negative_weeks >= 3 -> demote candidate
    #   degraded model with consecutive_negative_weeks >= 6 -> retire candidate
    #   degraded model with last 2 ic > 0 -> recovery candidate
    try:
        if discord_alert.is_enabled():
            discord_alert.alert_weekly_ic_summary(per_model_ic, pool_changes)
            # Per-model decay alerts (only when pool was updated)
            if req.update_pool and pool_changes:
                _emit_decay_alerts(pool_changes)
    except Exception as _e:
        logger.warning(f"[ModelPool] Stage 5 alerts failed (non-fatal): {_e}")

    return {
        "status": "ok",
        "lookback_days": req.lookback_days,
        "n_rows_total": len(rows),
        "per_model_ic": per_model_ic,
        "pool_updates": pool_changes if req.update_pool else None,
        "elapsed_s": round(time.time() - t0, 1),
    }


def _emit_decay_alerts(pool_changes: dict) -> None:
    """Inspect ic_4w_avg + consecutive_negative_weeks and fire candidate alerts.

    Fires advisory notifications only; does NOT mutate model_pool.json status.
    Stage 4 promote/demote gate owns actual lifecycle transitions.
    """
    import json as _json
    from google.cloud import storage
    bucket = storage.Client().bucket(_bucket_name())
    pool_blob = bucket.blob("universal/model_pool.json")
    if not pool_blob.exists():
        return
    pool = _json.loads(pool_blob.download_as_text())
    for tracked_name, change in pool_changes.items():
        is_challenger = tracked_name.endswith("::challenger")
        base_name = tracked_name.replace("::challenger", "")
        entry = pool.get("models", {}).get(base_name)
        if not entry:
            continue
        target_status = entry.get("status", "active")
        if is_challenger:
            target_status = "challenger"
        neg = change.get("consecutive_negative_weeks", 0) or 0
        ic_4w = change.get("ic_4w_avg")
        # Active model showing 3-week decay
        if target_status == "active" and neg >= 3:
            discord_alert.alert_lifecycle(
                event="demote",
                model_name=base_name,
                from_status="active", to_status="degraded (CANDIDATE)",
                reason=f"IC was negative for {neg} consecutive weeks (4w_avg={ic_4w})",
                metrics={"consecutive_negative_weeks": neg, "ic_4w_avg": ic_4w,
                          "note": "Advisory only; Stage 4 owns the actual transition"},
            )
        # Degraded model showing 6-week extended decay
        elif target_status == "degraded" and neg >= 6:
            discord_alert.alert_lifecycle(
                event="retire",
                model_name=base_name,
                from_status="degraded", to_status="retired (CANDIDATE)",
                reason=f"IC was negative for {neg} consecutive weeks (4w_avg={ic_4w})",
                metrics={"consecutive_negative_weeks": neg, "ic_4w_avg": ic_4w,
                          "note": "Advisory only; Stage 4 owns the actual transition"},
            )
        # Degraded recovery: last 2 weeks > 0 (read direct weekly_ic since
        # consecutive_negative_weeks resets to 0 on first positive)
        elif target_status == "degraded":
            wkly = (entry.get("weekly_ic") or []) if not is_challenger else \
                   (entry.get("challenger", {}).get("weekly_ic") or [])
            if len(wkly) >= 2 and wkly[-1] > 0 and wkly[-2] > 0:
                discord_alert.alert_lifecycle(
                    event="recovery",
                    model_name=base_name,
                    from_status="degraded", to_status="active (CANDIDATE)",
                    reason=f"IC stayed positive for 2 consecutive weeks (recent={wkly[-2]:.4f}, {wkly[-1]:.4f})",
                    metrics={"recent_2_weeks": [round(wkly[-2], 4), round(wkly[-1], 4)],
                              "ic_4w_avg": ic_4w,
                              "note": "Advisory only; Stage 4 owns the actual transition"},
                )


# ---------------------------------------------------------------------------
# Stage 6: State-space hyperparams pool (KalmanFilter / MarkovSwitching)
# ---------------------------------------------------------------------------


_DEFAULT_STATE_SPACE = {
    "KalmanFilter": {
        "process_noise": 1e-4,
        "observation_noise": 1e-2,
        "init_cov_scale": 1.0,
        "smoothing": False,
    },
    "MarkovSwitching": {
        "n_regimes": 2,
        "transition_prior": 0.95,
        "switching_vol": True,
        "ar_order": 1,
    },
}


class PutStateSpaceHyperparamsRequest(BaseModel):
    model_name: str           # 'KalmanFilter' or 'MarkovSwitching'
    hyperparams: dict
    version: str = "v1"
    confirm: bool = False


@router.post("/state_space/put_hyperparams")
async def put_state_space_hyperparams(req: PutStateSpaceHyperparamsRequest):
    """Stage 6.1: persist shared hyperparams for a state-space model.

    State-space models can't be 'universal' (each stock needs own state),
    but hyperparameters CAN be shared. This endpoint writes the pool's
    canonical hyperparams JSON to GCS at:
      per_stock_state_space/{kalman|markov_switching}/hyperparams_v{N}.json

    Used by:
      - Initial bootstrap (Stage 6.1, manual put with default values)
      - Future Stage 6.3 Optuna search (writes search-optimal values)
      - Stage 4 promote_check via challenger registration
    """
    if not req.confirm:
        raise HTTPException(status_code=400, detail="put_state_space_hyperparams requires confirm=true")
    if req.model_name not in _DEFAULT_STATE_SPACE:
        raise HTTPException(status_code=400, detail=f"{req.model_name} is not a state-space model; expected one of {list(_DEFAULT_STATE_SPACE)}")
    expected = set(_DEFAULT_STATE_SPACE[req.model_name].keys())
    missing = expected - set(req.hyperparams.keys())
    if missing:
        raise HTTPException(status_code=400, detail=f"Missing keys for {req.model_name}: {sorted(missing)}")

    import json as _json
    from datetime import datetime, timezone
    from google.cloud import storage
    bucket = storage.Client().bucket(_bucket_name())
    folder = "kalman" if req.model_name == "KalmanFilter" else "markov_switching"
    path = f"per_stock_state_space/{folder}/hyperparams_{req.version}.json"
    payload = dict(req.hyperparams)
    payload["_meta"] = {
        "model": req.model_name,
        "version": req.version,
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "schema_version": "1.0",
    }
    bucket.blob(path).upload_from_string(
        _json.dumps(payload, indent=2, ensure_ascii=False),
        content_type="application/json",
    )
    logger.info(f"[Stage 6] put_hyperparams saved {path}")
    return {"status": "ok", "path": path, "hyperparams": payload}


@router.get("/state_space/hyperparams/{model_name}")
async def get_state_space_hyperparams(model_name: str, version: str = "v1"):
    """Read state-space hyperparams (or default if no GCS file)."""
    if model_name not in _DEFAULT_STATE_SPACE:
        raise HTTPException(status_code=400, detail=f"{model_name} is not a state-space model")
    import json as _json
    from google.cloud import storage
    bucket = storage.Client().bucket(_bucket_name())
    folder = "kalman" if model_name == "KalmanFilter" else "markov_switching"
    blob = bucket.blob(f"per_stock_state_space/{folder}/hyperparams_{version}.json")
    if not blob.exists():
        return {"status": "default", "model": model_name, "version": version,
                "hyperparams": _DEFAULT_STATE_SPACE[model_name],
                "note": "no GCS file; serving in-code defaults"}
    return {"status": "loaded", "model": model_name, "version": version,
            "hyperparams": _json.loads(blob.download_as_text())}


# ---------------------------------------------------------------------------
# Stage 4: Promote / demote / retire / recovery gate (lifecycle owner)
# ---------------------------------------------------------------------------


class PromoteCheckRequest(BaseModel):
    apply: bool = False                # False = dry-run report only
    confirm: bool = False              # required with apply=true
    min_shadow_weeks: int = 4          # required shadow duration
    promote_margin: float = 0.01       # challenger 4w IC > active 4w IC + margin
    min_challenger_ic: float = 0.0     # challenger must beat this floor
    discard_failed_challenger: bool = True
    demote_consec_weeks: int = 3       # active -> degraded threshold
    retire_consec_weeks: int = 6       # degraded -> retired threshold
    recovery_consec_pos_weeks: int = 2 # degraded -> active threshold
    require_promotion_gate: bool = True
    promotion_gate_source: str = "backtest"
    promotion_gate_pbo_source: str | None = None
    require_shadow_ab: bool = True
    shadow_ab_lookback_days: int = 90
    require_paper_order_ab: bool = True
    paper_order_ab_lookback_days: int = 90


@router.post("/promote_check")
async def promote_check(req: PromoteCheckRequest):
    """Stage 4: scan model_pool.json for lifecycle transitions.

    Checks (per ML_POOL_ARCHITECTURE.md + 4-state machine):
      Challenger -> Active (promote):
        1. shadow_since older than min_shadow_weeks
        2. challenger.ic_4w_avg > active.ic_4w_avg + promote_margin
        3. challenger.ic_4w_avg > 0
        4. family balance preserved (feature + time-series active minimums)
      Active -> Degraded (demote):
        consecutive_negative_weeks >= demote_consec_weeks
      Degraded -> Retired (retire):
        consecutive_negative_weeks >= retire_consec_weeks
      Degraded -> Active (recovery):
        last recovery_consec_pos_weeks weeks all > 0

    Returns: {actions: [...], applied: bool, audit: {...}}
    Each action has dry-run preview UNLESS req.apply=True; then mutates pool.
    Stage 5 alerts fire on actual transitions (apply=True path).
    """
    if req.apply and not req.confirm:
        raise HTTPException(status_code=400, detail="apply=true requires confirm=true")

    import json as _json
    from datetime import datetime, timezone, date as _date
    from google.cloud import storage

    bucket = storage.Client().bucket(_bucket_name())
    pool_blob = bucket.blob("universal/model_pool.json")
    if not pool_blob.exists():
        raise HTTPException(status_code=400, detail="model_pool.json not initialized")
    pool = _json.loads(pool_blob.download_as_text())
    today = datetime.now(timezone.utc).date()
    today_iso = today.isoformat()

    # Family balance baseline: count current active alpha predictors per family.
    def _family_actives(p: dict) -> dict[str, int]:
        counts = {"feature": 0, "time_series": 0}
        for entry in p.get("models", {}).values():
            if entry.get("status") == "active":
                fam = entry.get("balance_family", "feature")
                counts[fam] = counts.get(fam, 0) + 1
        return counts
    MIN_PER_FAMILY = {"feature": 3, "time_series": 2}
    projected_actives = _family_actives(pool)

    actions: list[dict] = []
    for name, entry in pool.get("models", {}).items():
        status = entry.get("status", "active")
        family = entry.get("balance_family", "feature")
        ic_4w = entry.get("ic_4w_avg")
        consec_neg = entry.get("consecutive_negative_weeks", 0) or 0
        weekly_ic = entry.get("weekly_ic") or []
        challenger = entry.get("challenger") or {}

        # Promote check (challenger -> active)
        if challenger:
            ch_4w = challenger.get("ic_4w_avg")
            shadow_since_str = challenger.get("shadow_since")
            ch_weekly = challenger.get("weekly_ic") or []
            preconds_failed = []
            shadow_age_days = 0
            if not shadow_since_str:
                preconds_failed.append("missing shadow_since")
            else:
                try:
                    shadow_age_days = (today - _date.fromisoformat(shadow_since_str)).days
                except ValueError:
                    shadow_age_days = 0
                    preconds_failed.append("invalid shadow_since")
                if shadow_age_days < req.min_shadow_weeks * 7:
                    preconds_failed.append(
                        f"shadow_age={shadow_age_days}d < {req.min_shadow_weeks}w"
                    )
            if len(ch_weekly) < req.min_shadow_weeks:
                preconds_failed.append(
                    f"challenger weekly_ic samples={len(ch_weekly)} < {req.min_shadow_weeks}"
                )
            if ch_4w is None:
                preconds_failed.append("challenger ic_4w_avg=null (need 4 wkly samples)")
            elif ch_4w <= req.min_challenger_ic:
                preconds_failed.append(f"challenger ic_4w_avg={ch_4w} <= floor {req.min_challenger_ic}")
            if ic_4w is not None and ch_4w is not None and ch_4w <= ic_4w + req.promote_margin:
                preconds_failed.append(
                    f"challenger {ch_4w} <= active {ic_4w} + margin {req.promote_margin}"
                )

            if not preconds_failed:
                actions.append({
                    "model": name,
                    "transition": "promote",
                    "from": f"active:{entry.get('version')} + challenger:{challenger.get('version')}",
                    "to": f"active:{challenger.get('version')} + retired:{entry.get('version')}",
                    "ic_active_4w": ic_4w,
                    "ic_challenger_4w": ch_4w,
                    "margin": ch_4w - (ic_4w if ic_4w is not None else 0),
                    "reason": "All promote preconditions satisfied",
                })
            else:
                discard_reason = None
                has_mature_shadow = (
                    shadow_since_str
                    and shadow_age_days >= req.min_shadow_weeks * 7
                    and len(ch_weekly) >= req.min_shadow_weeks
                    and ch_4w is not None
                )
                if req.discard_failed_challenger and has_mature_shadow:
                    if ch_4w <= req.min_challenger_ic:
                        discard_reason = (
                            f"challenger ic_4w_avg={ch_4w} <= floor {req.min_challenger_ic}"
                        )
                    elif ic_4w is not None and ch_4w + req.promote_margin < ic_4w:
                        discard_reason = (
                            f"challenger {ch_4w} trails active {ic_4w} by more than margin {req.promote_margin}"
                        )

                if discard_reason:
                    actions.append({
                        "model": name,
                        "transition": "discard_challenger",
                        "from": f"challenger:{challenger.get('version')}",
                        "to": None,
                        "reason": discard_reason,
                        "ic_active_4w": ic_4w,
                        "ic_challenger_4w": ch_4w,
                        "weekly_ic_count": len(ch_weekly),
                    })
                else:
                    actions.append({
                        "model": name,
                        "transition": "promote_blocked",
                        "preconditions_failed": preconds_failed,
                        "ic_active_4w": ic_4w,
                        "ic_challenger_4w": ch_4w,
                    })

        # Demote check (active -> degraded)
        if status == "active" and consec_neg >= req.demote_consec_weeks:
            min_active = MIN_PER_FAMILY.get(family, 0)
            if projected_actives.get(family, 0) - 1 < min_active:
                actions.append({
                    "model": name,
                    "transition": "demote_blocked",
                    "from": "active",
                    "to": "degraded",
                    "consecutive_negative_weeks": consec_neg,
                    "reason": (
                        f"family balance guard: {family} active count would become "
                        f"{projected_actives.get(family, 0) - 1} < min {min_active}"
                    ),
                })
            else:
                projected_actives[family] = projected_actives.get(family, 0) - 1
                actions.append({
                    "model": name,
                    "transition": "demote",
                    "from": "active",
                    "to": "degraded",
                    "consecutive_negative_weeks": consec_neg,
                    "reason": f"IC has been negative for {consec_neg} weeks (threshold={req.demote_consec_weeks})",
                })

        # Retire check (degraded -> retired)
        if status == "degraded" and consec_neg >= req.retire_consec_weeks:
            actions.append({
                "model": name,
                "transition": "retire",
                "from": "degraded",
                "to": "retired",
                "consecutive_negative_weeks": consec_neg,
                "reason": f"IC has been negative for {consec_neg} weeks (extended threshold={req.retire_consec_weeks})",
            })

        # Recovery check (degraded -> active)
        if status == "degraded" and len(weekly_ic) >= req.recovery_consec_pos_weeks:
            recent = weekly_ic[-req.recovery_consec_pos_weeks:]
            if all(w > 0 for w in recent):
                actions.append({
                    "model": name,
                    "transition": "recovery",
                    "from": "degraded",
                    "to": "active",
                    "recent_weeks_ic": recent,
                    "reason": f"IC stayed positive for {req.recovery_consec_pos_weeks} consecutive weeks",
                })

    promotion_gate = None
    has_promote_action = any(a.get("transition") == "promote" for a in actions)
    shadow_ab_by_model = None
    paper_order_ab_by_model = None
    if has_promote_action and req.require_promotion_gate:
        try:
            from services.promotion_service import evaluate_latest_promotion_gate

            promotion_gate = evaluate_latest_promotion_gate(
                source=req.promotion_gate_source,
                pbo_source=req.promotion_gate_pbo_source,
            )
        except Exception as e:
            logger.exception("[Stage 4] promotion gate evaluation failed")
            promotion_gate = {
                "decision": "FAIL",
                "passed": False,
                "failed_gates": ["promotion_gate_exception"],
                "warnings": [str(e)],
            }
    if has_promote_action and req.require_shadow_ab:
        try:
            from services.shadow_ab_service import load_shadow_ab_by_model

            shadow_ab_by_model = load_shadow_ab_by_model(lookback_days=req.shadow_ab_lookback_days)
        except Exception as e:
            logger.exception("[Stage 4] shadow AB evidence load failed")
            shadow_ab_by_model = {}
            if promotion_gate is None:
                promotion_gate = {
                    "decision": "PASS",
                    "passed": True,
                    "failed_gates": [],
                    "warnings": [str(e)],
                }
    if has_promote_action and req.require_paper_order_ab:
        try:
            from services.paper_order_ab_service import load_paper_order_ab_by_model

            paper_order_ab_by_model = load_paper_order_ab_by_model(lookback_days=req.paper_order_ab_lookback_days)
        except Exception as e:
            logger.exception("[Stage 4] paper-order AB evidence load failed")
            paper_order_ab_by_model = {}
            if promotion_gate is None:
                promotion_gate = {
                    "decision": "PASS",
                    "passed": True,
                    "failed_gates": [],
                    "warnings": [str(e)],
                }
    if has_promote_action and (req.require_promotion_gate or req.require_shadow_ab or req.require_paper_order_ab):
        actions = apply_promotion_gate_to_actions(
            actions,
            promotion_gate,
            require_gate=req.require_promotion_gate,
            require_shadow_ab=req.require_shadow_ab,
            shadow_ab_by_model=shadow_ab_by_model,
            require_paper_order_ab=req.require_paper_order_ab,
            paper_order_ab_by_model=paper_order_ab_by_model,
        )

    # Apply transitions if requested
    applied_count = 0
    if req.apply:
        audit_events = pool.setdefault("lifecycle_events", [])

        def _audit(action: dict, from_status: str | None, to_status: str | None) -> None:
            audit_events.append({
                "at": datetime.now(timezone.utc).isoformat(),
                "model": action["model"],
                "transition": action["transition"],
                "from": from_status,
                "to": to_status,
                "reason": action.get("reason"),
                "metrics": {
                    k: action.get(k)
                    for k in (
                        "ic_active_4w",
                        "ic_challenger_4w",
                        "margin",
                        "consecutive_negative_weeks",
                        "recent_weeks_ic",
                        "weekly_ic_count",
                    )
                    if k in action
                },
            })
            if len(audit_events) > 200:
                del audit_events[:-200]

        for action in actions:
            t = action["transition"]
            name = action["model"]
            entry = pool["models"][name]
            if t == "promote":
                # Move challenger -> active; keep history of v_old as "retired" sub-entry
                ch = entry["challenger"]
                _retired_history = entry.setdefault("retired_versions", [])
                _retired_history.append({
                    "version": entry["version"],
                    "retired_at": today_iso,
                    "weekly_ic_at_retire": entry.get("weekly_ic", []).copy(),
                    "ic_4w_avg_at_retire": entry.get("ic_4w_avg"),
                })
                entry["version"] = ch["version"]
                entry["gcs_path"] = ch["gcs_path"]
                entry["promoted_at"] = today_iso
                entry["weekly_ic"] = ch.get("weekly_ic", []).copy()
                entry["ic_4w_avg"] = ch.get("ic_4w_avg")
                entry["consecutive_negative_weeks"] = ch.get("consecutive_negative_weeks", 0)
                entry["status"] = "active"
                entry.pop("challenger", None)
                entry.pop("degraded_since", None)
                applied_count += 1
                _audit(action, action["from"], action["to"])
                try:
                    discord_alert.alert_lifecycle(
                        event="promote", model_name=name,
                        from_status=action["from"], to_status=action["to"],
                        reason=action["reason"],
                        metrics={"ic_active_4w": action["ic_active_4w"],
                                  "ic_challenger_4w": action["ic_challenger_4w"],
                                  "margin": action["margin"]},
                    )
                except Exception as _e:
                    logger.debug(f"[Stage 4] promote alert skipped: {_e}")
            elif t == "demote":
                entry["status"] = "degraded"
                entry["degraded_since"] = today_iso
                applied_count += 1
                _audit(action, "active", "degraded")
                try:
                    discord_alert.alert_lifecycle(
                        event="demote", model_name=name,
                        from_status="active", to_status="degraded",
                        reason=action["reason"],
                        metrics={"consecutive_negative_weeks": action["consecutive_negative_weeks"]},
                    )
                except Exception as _e:
                    logger.debug(f"[Stage 4] demote alert skipped: {_e}")
            elif t == "retire":
                entry["status"] = "retired"
                entry["retired_at"] = today_iso
                applied_count += 1
                _audit(action, "degraded", "retired")
                try:
                    discord_alert.alert_lifecycle(
                        event="retire", model_name=name,
                        from_status="degraded", to_status="retired",
                        reason=action["reason"],
                        metrics={"consecutive_negative_weeks": action["consecutive_negative_weeks"]},
                    )
                except Exception as _e:
                    logger.debug(f"[Stage 4] retire alert skipped: {_e}")
            elif t == "recovery":
                entry["status"] = "active"
                entry.pop("degraded_since", None)
                applied_count += 1
                _audit(action, "degraded", "active")
                try:
                    discord_alert.alert_lifecycle(
                        event="recovery", model_name=name,
                        from_status="degraded", to_status="active",
                        reason=action["reason"],
                        metrics={"recent_weeks_ic": action["recent_weeks_ic"]},
                    )
                except Exception as _e:
                    logger.debug(f"[Stage 4] recovery alert skipped: {_e}")
            elif t == "discard_challenger":
                removed = entry.pop("challenger", None)
                applied_count += 1
                _audit(action, action.get("from"), None)
                try:
                    discord_alert.alert_lifecycle(
                        event="discard",
                        model_name=name,
                        from_status=action.get("from"),
                        to_status=None,
                        reason=action["reason"],
                        metrics={
                            "ic_active_4w": action.get("ic_active_4w"),
                            "ic_challenger_4w": action.get("ic_challenger_4w"),
                            "weekly_ic_count": action.get("weekly_ic_count"),
                            "removed_version": (removed or {}).get("version"),
                        },
                    )
                except Exception as _e:
                    logger.debug(f"[Stage 4] discard alert skipped: {_e}")
        if applied_count > 0:
            pool["last_updated"] = datetime.now(timezone.utc).isoformat()
            pool_blob.upload_from_string(
                _json.dumps(pool, indent=2, ensure_ascii=False),
                content_type="application/json",
            )

    lifecycle_review_packet = _build_lifecycle_review_packet(
        actions=actions,
        promotion_gate=promotion_gate,
        shadow_ab_by_model=shadow_ab_by_model,
        paper_order_ab_by_model=paper_order_ab_by_model,
    )

    return {
        "status": "ok",
        "dry_run": not req.apply,
        "actions_count": len(actions),
        "applied_count": applied_count,
        "actions": actions,
        "thresholds": {
            "min_shadow_weeks": req.min_shadow_weeks,
            "promote_margin": req.promote_margin,
            "min_challenger_ic": req.min_challenger_ic,
            "discard_failed_challenger": req.discard_failed_challenger,
            "demote_consec_weeks": req.demote_consec_weeks,
            "retire_consec_weeks": req.retire_consec_weeks,
            "recovery_consec_pos_weeks": req.recovery_consec_pos_weeks,
            "require_promotion_gate": req.require_promotion_gate,
            "promotion_gate_source": req.promotion_gate_source,
            "promotion_gate_pbo_source": req.promotion_gate_pbo_source,
            "require_shadow_ab": req.require_shadow_ab,
            "shadow_ab_lookback_days": req.shadow_ab_lookback_days,
            "require_paper_order_ab": req.require_paper_order_ab,
            "paper_order_ab_lookback_days": req.paper_order_ab_lookback_days,
        },
        "promotion_gate": promotion_gate,
        "shadow_ab_by_model": shadow_ab_by_model,
        "paper_order_ab_by_model": paper_order_ab_by_model,
        "lifecycle_review_packet": lifecycle_review_packet,
    }


@router.get("/status")
async def status():
    """Read current model_pool.json from GCS."""
    try:
        import json as _json
        from google.cloud import storage
        bucket = storage.Client().bucket(_bucket_name())
        blob = bucket.blob("universal/model_pool.json")
        if not blob.exists():
            return {"status": "not_initialized", "note": "Run POST /model_pool/init first"}
        return _json.loads(blob.download_as_text())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"GCS read failed: {e}")


@router.get("/lineage")
async def lineage():
    """Return model_pool lineage pointers plus recent lifecycle events."""
    try:
        import json as _json
        from google.cloud import storage

        bucket = storage.Client().bucket(_bucket_name())
        pool_blob = bucket.blob("universal/model_pool.json")
        if not pool_blob.exists():
            return {"status": "not_initialized", "models": {}, "events": []}

        pool = _json.loads(pool_blob.download_as_text())
        out: dict[str, dict] = {}
        for name, entry in (pool.get("models") or {}).items():
            version = entry.get("version")
            artifact_path = entry.get("gcs_path") or (version and _model_artifact_path(name, version))
            metadata_path = _model_metadata_path(name, version) if version else None
            metadata = None
            metadata_exists = False
            if metadata_path:
                metadata_blob = bucket.blob(metadata_path)
                metadata_exists = metadata_blob.exists()
                if metadata_exists:
                    try:
                        metadata = _metadata_summary(_json.loads(metadata_blob.download_as_text()))
                    except Exception as e:
                        metadata = {"read_error": str(e)}

            challenger = entry.get("challenger")
            challenger_out = None
            if challenger:
                ch_version = challenger.get("version")
                ch_metadata_path = _model_metadata_path(name, ch_version) if ch_version else None
                ch_metadata_exists = False
                ch_metadata = None
                if ch_metadata_path:
                    ch_metadata_blob = bucket.blob(ch_metadata_path)
                    ch_metadata_exists = ch_metadata_blob.exists()
                    if ch_metadata_exists:
                        try:
                            ch_metadata = _metadata_summary(_json.loads(ch_metadata_blob.download_as_text()))
                        except Exception as e:
                            ch_metadata = {"read_error": str(e)}
                challenger_out = {
                    "version": ch_version,
                    "status": "challenger",
                    "gcs_path": challenger.get("gcs_path"),
                    "metadata_path": ch_metadata_path,
                    "metadata_exists": ch_metadata_exists,
                    "metadata": ch_metadata,
                    "shadow_since": challenger.get("shadow_since"),
                    "rolling_ic": challenger.get("rolling_ic"),
                    "weekly_ic": challenger.get("weekly_ic") or [],
                    "ic_4w_avg": challenger.get("ic_4w_avg"),
                    "last_ic_status": challenger.get("last_ic_status"),
                    "last_ic_root_cause": challenger.get("last_ic_root_cause"),
                    "last_ic_sample_count": challenger.get("last_ic_sample_count") or 0,
                    "last_ic_diagnostics": challenger.get("last_ic_diagnostics") or {},
                    "last_ic_score_sources": challenger.get("last_ic_score_sources") or {},
                    "last_ic_by_segment": challenger.get("last_ic_by_segment") or {},
                    "last_ic_error": challenger.get("last_ic_error"),
                    "lifecycle_diagnosis": _lifecycle_diagnosis(
                        model_name=name,
                        entry=challenger,
                        metadata_exists=ch_metadata_exists,
                        metadata=ch_metadata,
                    ),
                }

            out[name] = {
                "status": entry.get("status"),
                "version": version,
                "balance_family": entry.get("balance_family"),
                "model_type": entry.get("model_type"),
                "gcs_path": artifact_path,
                "artifact_uri": _bucket_uri(artifact_path) if artifact_path else None,
                "metadata_path": metadata_path,
                "metadata_exists": metadata_exists,
                "metadata": metadata,
                "rolling_ic": entry.get("rolling_ic"),
                "weekly_ic": entry.get("weekly_ic") or [],
                "ic_4w_avg": entry.get("ic_4w_avg"),
                "last_ic_status": entry.get("last_ic_status"),
                "last_ic_root_cause": entry.get("last_ic_root_cause"),
                "last_ic_sample_count": entry.get("last_ic_sample_count") or 0,
                "last_ic_diagnostics": entry.get("last_ic_diagnostics") or {},
                "last_ic_score_sources": entry.get("last_ic_score_sources") or {},
                "last_ic_by_segment": entry.get("last_ic_by_segment") or {},
                "last_ic_error": entry.get("last_ic_error"),
                "lifecycle_diagnosis": _lifecycle_diagnosis(
                    model_name=name,
                    entry=entry,
                    metadata_exists=metadata_exists,
                    metadata=metadata,
                ),
                "consecutive_negative_weeks": entry.get("consecutive_negative_weeks") or 0,
                "challenger": challenger_out,
            }

        return {
            "status": "ok",
            "schema_version": pool.get("schema_version"),
            "last_updated": pool.get("last_updated"),
            "models": out,
            "state_overlays": pool.get("state_overlays") or {},
            "meta_optimizers": pool.get("meta_optimizers") or {},
            "events": (pool.get("lifecycle_events") or [])[-100:],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"GCS lineage read failed: {e}")


# ---------------------------------------------------------------------------
# Stage 1 bootstrap endpoints (versioning + state machine init)
# ---------------------------------------------------------------------------


class MigrateLegacyRequest(BaseModel):
    dry_run: bool = True
    confirm: bool = False  # required when dry_run=False


@router.post("/migrate_legacy")
async def migrate_legacy(req: MigrateLegacyRequest):
    """Deprecated bootstrap endpoint.

    Production artifacts are now model_pool/versioned-only. Keeping a live
    copy-from-flat-file path would reintroduce split-brain model ownership.
    """
    raise HTTPException(
        status_code=410,
        detail="legacy model artifact migration is disabled; model_pool.json is the canonical owner",
    )


def _inline_migrate_via_gcs(dry_run: bool) -> dict:
    """Disabled with /migrate_legacy; kept only to avoid import-time breakage."""
    raise HTTPException(
        status_code=410,
        detail="legacy model artifact migration is disabled",
    )


class InitPoolRequest(BaseModel):
    confirm: bool = False
    overwrite: bool = False  # if model_pool.json already exists


@router.post("/init")
async def init_pool(req: InitPoolRequest):
    """Initialize model_pool.json with all managed models as 'active' v1.

    Idempotent unless overwrite=true. Should run AFTER /migrate_legacy so
    versioned paths exist for the entries this writes.
    """
    if not req.confirm:
        raise HTTPException(
            status_code=400,
            detail="init requires confirm=true (writes model_pool.json to GCS)",
        )
    import json as _json
    from google.cloud import storage
    bucket = storage.Client().bucket(_bucket_name())
    pool_blob = bucket.blob("universal/model_pool.json")
    if pool_blob.exists() and not req.overwrite:
        existing = _json.loads(pool_blob.download_as_text())
        return {
            "status": "exists",
            "note": "model_pool.json already initialized; pass overwrite=true to replace",
            "model_count": len(existing.get("models", {})),
            "last_updated": existing.get("last_updated"),
        }

    # Inline default pool (mirrors ml-service app/model_pool.py:init_default_pool
    # without forcing module import here to keep ml-controller decoupled).
    from datetime import datetime, timezone
    today = datetime.now(timezone.utc).date().isoformat()
    iso_now = datetime.now(timezone.utc).isoformat()
    managed = [
        # (name, model_type, balance_family, ext)
        ("XGBoost",         "feature",                "feature",     "joblib"),
        ("CatBoost",        "feature",                "feature",     "joblib"),
        ("ExtraTrees",      "feature",                "feature",     "joblib"),
        ("LightGBM",        "feature",                "feature",     "joblib"),
        ("FT-Transformer",  "feature",                "feature",     "joblib"),
        ("Chronos",         "time_series_foundation", "time_series", "json"),
        ("DLinear",         "time_series_learnable",  "time_series", "pt"),
        ("PatchTST",        "time_series_learnable",  "time_series", "pt"),
    ]
    shadow_managed = [
        # (name, model_type, balance_family, ext)
        ("ResidualMLP", "experimental_mlp", "experimental", "joblib"),
        ("GNN", "experimental_graph", "experimental", "json"),
    ]
    state_overlays = ["KalmanFilter", "MarkovSwitching"]
    models = {}
    for name, mt, bf, _ext in managed:
        models[name] = {
            "status": "active",
            "version": "v1",
            "gcs_path": _model_artifact_path(name, "v1"),
            "model_type": mt,
            "balance_family": bf,
            "promoted_at": today,
            "shadow_since": None,
            "degraded_since": None,
            "retired_at": None,
            "weekly_ic": [],
            "ic_4w_avg": None,
            "consecutive_negative_weeks": 0,
        }
    shadow_models = {}
    for name, mt, bf, _ext in shadow_managed:
        shadow_models[name] = {
            "status": "challenger",
            "version": "v1",
            "gcs_path": _model_artifact_path(name, "v1"),
            "model_type": mt,
            "balance_family": bf,
            "vote_weight": 0.0,
            "shadow_since": today,
            "weekly_ic": [],
            "ic_4w_avg": None,
            "note": "Experimental alpha challenger; shadow predicts but does not vote.",
        }
    overlays = {}
    for name in state_overlays:
        overlays[name] = {
            "status": "active",
            "version": "v1",
            "gcs_path": _model_artifact_path(name, "v1"),
            "model_type": "state_space_overlay",
            "balance_family": "state_space",
            "role": "regime_risk_overlay",
            "promoted_at": today,
            "note": "State-space overlay only; excluded from alpha vote, IC, and challenger promotion.",
        }
    meta_optimizers = {
        "GAOptimizer": {
            "layer": "meta_optimizer",
            "status": "learning",
            "version": "v1",
            "scope": "ensemble_weights,strategy_params,risk_params",
            "model_type": "meta_optimizer",
            "balance_family": "optimizer",
            "direct_prediction": False,
            "created_at": today,
            "learning_mode": "direct",
            "apply_gate": "walk_forward+pbo+transaction_cost_sensitivity",
            "note": "Optimizer layer only; learns policy/search state directly and never votes as a predictor.",
        }
    }
    pool = {
        "schema_version": "1.0",
        "last_updated": iso_now,
        "models": models,
        "shadow_models": shadow_models,
        "state_overlays": overlays,
        "meta_optimizers": meta_optimizers,
    }
    pool_blob.upload_from_string(
        _json.dumps(pool, indent=2, ensure_ascii=False),
        content_type="application/json",
    )
    return {
        "status": "initialized",
        "model_count": len(models),
        "shadow_model_count": len(shadow_models),
        "state_overlay_count": len(overlays),
        "meta_optimizer_count": len(meta_optimizers),
        "last_updated": iso_now,
    }


# ---------------------------------------------------------------------------
# Chronos config marker (foundation model, no weights, just a version stub)
# ---------------------------------------------------------------------------


class WriteChronosConfigRequest(BaseModel):
    version: str = "v2"
    model_id: str = "amazon/chronos-2"
    horizon_default: int = 5
    num_samples_default: int = 20
    confirm: bool = False


@router.post("/write_chronos_config")
async def write_chronos_config(req: WriteChronosConfigRequest):
    """Write Chronos version config to GCS (foundation model, no weights).

    Stage 1 needs every managed model to have an artifact at its versioned
    path so model_pool.json entries stay valid. For Chronos the artifact is
    a config JSON capturing which HuggingFace model_id is in production.
    """
    if not req.confirm:
        raise HTTPException(status_code=400, detail="write_chronos_config requires confirm=true")
    import json as _json
    from datetime import datetime, timezone
    from google.cloud import storage
    bucket = storage.Client().bucket(_bucket_name())
    cfg = {
        "version": req.version,
        "model_id": req.model_id,
        "horizon_default": req.horizon_default,
        "num_samples_default": req.num_samples_default,
        "strategy": "Chronos-2 production replacement; zero-shot plus optional LoRA member",
        "saved_at": datetime.now(timezone.utc).isoformat(),
    }
    path = f"universal/chronos/{req.version}.json"
    bucket.blob(path).upload_from_string(
        _json.dumps(cfg, indent=2), content_type="application/json"
    )
    return {"status": "written", "path": path, "config": cfg}


