"""
routers/model_pool.py — ML Model Pool management endpoints (Plan A).

2026-04-19 Stage 0.x bootstrap:
  POST /model_pool/train_dlinear   — train universal DLinear from D1 close

Future ML_POOL Stage 1+:
  GET  /model_pool/status          — read model_pool.json
  POST /model_pool/promote/{name}  — manual challenger → active
  POST /model_pool/retire/{name}   — manual active → retired
  GET  /model_pool/lifecycle/{name} — model_lifecycle_events history
"""
from __future__ import annotations
import logging
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import modal_client
from services.d1_client import query as d1_query
from services import discord_alert  # 2026-04-19 Stage 5

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/model_pool", tags=["model_pool"])


# ─────────────────────────────────────────────────────────────────────────────
# DLinear universal training
# ─────────────────────────────────────────────────────────────────────────────


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
    NULL + ≥min_history_days history), forwards to Modal train function,
    returns saved GCS paths + training metadata.
    """
    if not req.confirm:
        raise HTTPException(
            status_code=400,
            detail="train_dlinear requires confirm=true — overwrites "
                   f"gs://stockvision-models/universal/dlinear/{req.version}.pt",
        )

    t0 = time.time()
    tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
    end_date = tw_now.date().isoformat()
    start_date = (
        datetime.fromisoformat(end_date) - timedelta(days=req.lookback_days)
    ).date().isoformat()

    # ── 1. Pull close per stock (single GROUP_CONCAT-free query, in-Python group) ──
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
            detail=f"0 stocks with ≥{req.min_history_days}d history in window",
        )

    logger.info(
        f"[ModelPool] DLinear train candidates: {len(series_close)} stocks "
        f"(window {start_date}~{end_date}, min_history={req.min_history_days})"
    )

    # ── 2. Modal training ────────────────────────────────────────────────────
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


# ─────────────────────────────────────────────────────────────────────────────
# Status / read-only (placeholders for ML_POOL Stage 1+)
# ─────────────────────────────────────────────────────────────────────────────


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
            detail="train_patchtst requires confirm=true — overwrites "
                   f"gs://stockvision-models/universal/patchtst/{req.version}.pt",
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
            detail=f"0 stocks with ≥{req.min_history_days}d history in window",
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


# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: Challenger registration / discard (manual triggers; auto-register
# on retrain success will be wired in Stage 4 promote-gate work)
# ─────────────────────────────────────────────────────────────────────────────


class RegisterChallengerRequest(BaseModel):
    model_name: str            # one of MANAGED_MODELS keys
    version: str               # e.g. "v2" — must differ from active
    confirm: bool = False


@router.post("/register_challenger")
async def register_challenger(req: RegisterChallengerRequest):
    """Mark a model version as challenger (shadow mode).

    Caller must have already trained + saved the artifact at the implied
    GCS path (universal/{model_lower}/v{N}.{ext}). This endpoint only
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

    bucket = storage.Client().bucket("stockvision-models")
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

    # Determine extension (mirror MANAGED_MODELS)
    ext_map = {
        "XGBoost": "joblib", "CatBoost": "joblib", "ExtraTrees": "joblib",
        "LightGBM": "joblib", "FT-Transformer": "joblib",
        "Chronos": "json", "DLinear": "pt", "PatchTST": "pt",
    }
    ext = ext_map.get(req.model_name, "joblib")
    folder = req.model_name.lower().replace("-", "_")
    target_path = f"universal/{folder}/{req.version}.{ext}"

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
    bucket = storage.Client().bucket("stockvision-models")
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


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Weekly IC tracker (cron-driven)
# ─────────────────────────────────────────────────────────────────────────────


class ComputeWeeklyICRequest(BaseModel):
    lookback_days: int = 7              # Friday cron rolls last 7 days of verified rows
    history_max: int = 26               # cap weekly_ic array (~6 months rolling)
    min_samples: int = 50               # IC noise floor — skip if fewer obs/model
    update_pool: bool = True            # write back to model_pool.json


@router.post("/compute_weekly_ic")
async def compute_weekly_ic(req: ComputeWeeklyICRequest):
    """Compute Spearman IC per managed model from last lookback_days of
    verified predictions, append to model_pool.json weekly_ic, recompute
    ic_4w_avg, increment consecutive_negative_weeks if IC<0.

    Reads:
      D1 predictions WHERE
        model_name IN (8 managed model names)
        AND verified_at IS NOT NULL
        AND generated_at >= datetime('now','-7 days')

    Writes:
      gs://stockvision-models/universal/model_pool.json
        models[name].weekly_ic.append(this_week_ic)
        models[name].ic_4w_avg = mean(weekly_ic[-4:])
        models[name].consecutive_negative_weeks (incr if < 0 else 0)

    NOTE: Stage 4 promote/demote logic reads these accumulated metrics; Stage 2
    only WRITES the metrics. Decay/promotion threshold logic stays separate.
    """
    import json as _json
    from datetime import datetime, timezone
    import math
    from google.cloud import storage

    t0 = time.time()
    managed_models = ("XGBoost", "CatBoost", "ExtraTrees", "LightGBM", "FT-Transformer",
                      "Chronos", "DLinear", "PatchTST")
    # Stage 3: also track challenger rows (model_name='{name}::challenger')
    challenger_models = tuple(f"{n}::challenger" for n in managed_models)
    all_tracked = managed_models + challenger_models

    # ── 1. Pull verified per-model rows from D1 ──────────────────────────────
    placeholders = ",".join(["?"] * len(all_tracked))
    sql = f"""
        SELECT model_name, direction_accuracy, actual_return_pct, generated_at
        FROM predictions
        WHERE model_name IN ({placeholders})
          AND actual_return_pct IS NOT NULL
          AND verified_at IS NOT NULL
          AND generated_at >= datetime('now', ?)
    """
    rows = d1_query(sql, [*all_tracked, f"-{req.lookback_days} days"])
    by_model: dict[str, list[tuple[float, float]]] = {n: [] for n in all_tracked}
    for r in rows:
        try:
            score = float(r["direction_accuracy"])
            actual = float(r["actual_return_pct"])
        except (TypeError, ValueError):
            continue
        if math.isnan(score) or math.isnan(actual):
            continue
        by_model[r["model_name"]].append((score, actual))

    # ── 2. Spearman IC per model ─────────────────────────────────────────────
    def _spearman(pairs: list[tuple[float, float]]) -> float | None:
        n = len(pairs)
        if n < 2:
            return None
        # Rank both arrays (average rank for ties — stats.spearmanr equivalent)
        xs = [p[0] for p in pairs]
        ys = [p[1] for p in pairs]
        x_rank = _rank_avg_ties(xs)
        y_rank = _rank_avg_ties(ys)
        # Pearson on ranks = Spearman
        mx = sum(x_rank) / n
        my = sum(y_rank) / n
        num = sum((x_rank[i] - mx) * (y_rank[i] - my) for i in range(n))
        denx = math.sqrt(sum((x - mx) ** 2 for x in x_rank))
        deny = math.sqrt(sum((y - my) ** 2 for y in y_rank))
        if denx == 0 or deny == 0:
            return None
        return num / (denx * deny)

    per_model_ic: dict[str, dict] = {}
    for name in all_tracked:
        pairs = by_model[name]
        if len(pairs) < req.min_samples:
            per_model_ic[name] = {"status": "insufficient_samples", "n_samples": len(pairs)}
            continue
        ic = _spearman(pairs)
        per_model_ic[name] = {
            "status": "computed",
            "ic": round(ic, 6) if ic is not None else None,
            "n_samples": len(pairs),
        }

    # ── 3. Update model_pool.json ────────────────────────────────────────────
    # Active rows update entry.weekly_ic; challenger rows update
    # entry.challenger.weekly_ic (separate IC history per shadow version).
    pool_changes: dict[str, dict] = {}
    if req.update_pool:
        try:
            bucket = storage.Client().bucket("stockvision-models")
            pool_blob = bucket.blob("universal/model_pool.json")
            if pool_blob.exists():
                pool = _json.loads(pool_blob.download_as_text())
                changed = False
                for tracked_name in all_tracked:
                    info = per_model_ic.get(tracked_name, {})
                    ic = info.get("ic")
                    if ic is None:
                        continue
                    is_challenger = tracked_name.endswith("::challenger")
                    base_name = tracked_name.replace("::challenger", "")
                    entry = pool.get("models", {}).get(base_name)
                    if not entry:
                        continue
                    target = entry.get("challenger") if is_challenger else entry
                    if target is None:
                        continue  # Challenger IC found in D1 but pool entry has no challenger registered
                    target.setdefault("weekly_ic", [])
                    target["weekly_ic"].append(ic)
                    if len(target["weekly_ic"]) > req.history_max:
                        target["weekly_ic"] = target["weekly_ic"][-req.history_max:]
                    last4 = target["weekly_ic"][-4:]
                    target["ic_4w_avg"] = round(sum(last4) / len(last4), 6)
                    if ic < 0:
                        target["consecutive_negative_weeks"] = (target.get("consecutive_negative_weeks") or 0) + 1
                    else:
                        target["consecutive_negative_weeks"] = 0
                    pool_changes[tracked_name] = {
                        "ic": ic,
                        "ic_4w_avg": target["ic_4w_avg"],
                        "consecutive_negative_weeks": target["consecutive_negative_weeks"],
                        "history_len": len(target["weekly_ic"]),
                    }
                    changed = True
                if changed:
                    pool["last_updated"] = datetime.now(timezone.utc).isoformat()
                    pool_blob.upload_from_string(
                        _json.dumps(pool, indent=2, ensure_ascii=False),
                        content_type="application/json",
                    )
        except Exception as e:
            logger.error(f"[ModelPool] weekly_ic pool update failed: {e}")
            return {"status": "error", "error": f"pool_update_failed: {e}", "per_model_ic": per_model_ic}

    # ── 4. Stage 5 alerts: weekly summary + decay-detection per-event ────────
    # Decay rules (per ML_POOL_ARCHITECTURE.md, NOT auto-flipping status —
    # Stage 4 promote gate will own the actual transitions):
    #   active model w/ consecutive_negative_weeks ≥ 3 → 🟡 demote candidate
    #   degraded model w/ consecutive_negative_weeks ≥ 6 → 🔴 retire candidate
    #   degraded model w/ last 2 ic > 0 → 🔵 recovery candidate
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

    Fires advisory notifications only — does NOT mutate model_pool.json status.
    Stage 4 promote/demote gate owns actual lifecycle transitions.
    """
    import json as _json
    from google.cloud import storage
    bucket = storage.Client().bucket("stockvision-models")
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
                reason=f"IC 連 {neg} 週 < 0 (4w_avg={ic_4w})",
                metrics={"consecutive_negative_weeks": neg, "ic_4w_avg": ic_4w,
                          "note": "Advisory — Stage 4 will own actual transition"},
            )
        # Degraded model showing 6-week extended decay
        elif target_status == "degraded" and neg >= 6:
            discord_alert.alert_lifecycle(
                event="retire",
                model_name=base_name,
                from_status="degraded", to_status="retired (CANDIDATE)",
                reason=f"IC 連 {neg} 週 < 0 (4w_avg={ic_4w})",
                metrics={"consecutive_negative_weeks": neg, "ic_4w_avg": ic_4w,
                          "note": "Advisory — Stage 4 will own actual transition"},
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
                    reason=f"IC 連 2 週 > 0 (recent={wkly[-2]:.4f}, {wkly[-1]:.4f})",
                    metrics={"recent_2_weeks": [round(wkly[-2], 4), round(wkly[-1], 4)],
                              "ic_4w_avg": ic_4w,
                              "note": "Advisory — Stage 4 will own actual transition"},
                )


def _rank_avg_ties(xs: list[float]) -> list[float]:
    """Rank xs ascending with average-rank tie handling (stats.rankdata equivalent)."""
    n = len(xs)
    indexed = sorted(range(n), key=lambda i: xs[i])
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        # Group ties
        while j + 1 < n and xs[indexed[j + 1]] == xs[indexed[i]]:
            j += 1
        avg = (i + j + 2) / 2.0  # 1-indexed average
        for k in range(i, j + 1):
            ranks[indexed[k]] = avg
        i = j + 1
    return ranks


# ─────────────────────────────────────────────────────────────────────────────
# Stage 4: Promote / demote / retire / recovery gate (lifecycle owner)
# ─────────────────────────────────────────────────────────────────────────────


class PromoteCheckRequest(BaseModel):
    apply: bool = False                # False = dry-run report only
    min_shadow_weeks: int = 4          # required shadow duration
    promote_margin: float = 0.01       # challenger 4w IC > active 4w IC + margin
    demote_consec_weeks: int = 3       # active → degraded threshold
    retire_consec_weeks: int = 6       # degraded → retired threshold
    recovery_consec_pos_weeks: int = 2 # degraded → active threshold


@router.post("/promote_check")
async def promote_check(req: PromoteCheckRequest):
    """Stage 4: scan model_pool.json for lifecycle transitions.

    Checks (per ML_POOL_ARCHITECTURE.md + 4-state machine):
      Challenger → Active (promote):
        1. shadow_since older than min_shadow_weeks
        2. challenger.ic_4w_avg > active.ic_4w_avg + promote_margin
        3. challenger.ic_4w_avg > 0
        4. family balance preserved (≥3 feature + ≥2 time-series active)
      Active → Degraded (demote):
        consecutive_negative_weeks >= demote_consec_weeks
      Degraded → Retired (retire):
        consecutive_negative_weeks >= retire_consec_weeks
      Degraded → Active (recovery):
        last recovery_consec_pos_weeks weeks all > 0

    Returns: {actions: [...], applied: bool, audit: {...}}
    Each action has dry-run preview UNLESS req.apply=True; then mutates pool.
    Stage 5 alerts fire on actual transitions (apply=True path).
    """
    import json as _json
    from datetime import datetime, timezone, date as _date
    from google.cloud import storage

    bucket = storage.Client().bucket("stockvision-models")
    pool_blob = bucket.blob("universal/model_pool.json")
    if not pool_blob.exists():
        raise HTTPException(status_code=400, detail="model_pool.json not initialized")
    pool = _json.loads(pool_blob.download_as_text())
    today = datetime.now(timezone.utc).date()
    today_iso = today.isoformat()

    # Family balance baseline: count current actives per family
    def _family_actives(p: dict) -> dict[str, int]:
        counts = {"feature": 0, "time_series": 0}
        for entry in p.get("models", {}).values():
            if entry.get("status") == "active":
                fam = entry.get("balance_family", "feature")
                counts[fam] = counts.get(fam, 0) + 1
        return counts
    MIN_PER_FAMILY = {"feature": 3, "time_series": 2}

    actions: list[dict] = []
    for name, entry in pool.get("models", {}).items():
        status = entry.get("status", "active")
        family = entry.get("balance_family", "feature")
        ic_4w = entry.get("ic_4w_avg")
        consec_neg = entry.get("consecutive_negative_weeks", 0) or 0
        weekly_ic = entry.get("weekly_ic") or []
        challenger = entry.get("challenger") or {}

        # ── Promote check (challenger → active) ─────────────────────────────
        if challenger:
            ch_4w = challenger.get("ic_4w_avg")
            shadow_since_str = challenger.get("shadow_since")
            ch_weekly = challenger.get("weekly_ic") or []
            preconds_failed = []
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
            if ch_4w is None:
                preconds_failed.append("challenger ic_4w_avg=null (need 4 wkly samples)")
            elif ch_4w <= 0:
                preconds_failed.append(f"challenger ic_4w_avg={ch_4w} ≤ 0")
            if ic_4w is not None and ch_4w is not None and ch_4w <= ic_4w + req.promote_margin:
                preconds_failed.append(
                    f"challenger {ch_4w} ≤ active {ic_4w} + margin {req.promote_margin}"
                )
            # Family balance: promotion replaces v_old with v_new (no count change)
            # so only check if current actives are already at minimum
            actives = _family_actives(pool)
            if actives.get(family, 0) < MIN_PER_FAMILY.get(family, 0):
                preconds_failed.append(
                    f"family balance: {family}={actives.get(family,0)} < min {MIN_PER_FAMILY[family]}"
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
                actions.append({
                    "model": name,
                    "transition": "promote_blocked",
                    "preconditions_failed": preconds_failed,
                    "ic_active_4w": ic_4w,
                    "ic_challenger_4w": ch_4w,
                })

        # ── Demote check (active → degraded) ────────────────────────────────
        if status == "active" and consec_neg >= req.demote_consec_weeks:
            actions.append({
                "model": name,
                "transition": "demote",
                "from": "active",
                "to": "degraded",
                "consecutive_negative_weeks": consec_neg,
                "reason": f"IC 連 {consec_neg} 週 < 0 (threshold={req.demote_consec_weeks})",
            })

        # ── Retire check (degraded → retired) ───────────────────────────────
        if status == "degraded" and consec_neg >= req.retire_consec_weeks:
            actions.append({
                "model": name,
                "transition": "retire",
                "from": "degraded",
                "to": "retired",
                "consecutive_negative_weeks": consec_neg,
                "reason": f"IC 連 {consec_neg} 週 < 0 (extended threshold={req.retire_consec_weeks})",
            })

        # ── Recovery check (degraded → active) ──────────────────────────────
        if status == "degraded" and len(weekly_ic) >= req.recovery_consec_pos_weeks:
            recent = weekly_ic[-req.recovery_consec_pos_weeks:]
            if all(w > 0 for w in recent):
                actions.append({
                    "model": name,
                    "transition": "recovery",
                    "from": "degraded",
                    "to": "active",
                    "recent_weeks_ic": recent,
                    "reason": f"IC 連 {req.recovery_consec_pos_weeks} 週 > 0",
                })

    # ── Apply transitions if requested ────────────────────────────────────
    applied_count = 0
    if req.apply:
        for action in actions:
            t = action["transition"]
            name = action["model"]
            entry = pool["models"][name]
            if t == "promote":
                # Move challenger → active; keep history of v_old as "retired" sub-entry
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
                try:
                    discord_alert.alert_lifecycle(
                        event="recovery", model_name=name,
                        from_status="degraded", to_status="active",
                        reason=action["reason"],
                        metrics={"recent_weeks_ic": action["recent_weeks_ic"]},
                    )
                except Exception as _e:
                    logger.debug(f"[Stage 4] recovery alert skipped: {_e}")
        if applied_count > 0:
            pool["last_updated"] = datetime.now(timezone.utc).isoformat()
            pool_blob.upload_from_string(
                _json.dumps(pool, indent=2, ensure_ascii=False),
                content_type="application/json",
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
            "demote_consec_weeks": req.demote_consec_weeks,
            "retire_consec_weeks": req.retire_consec_weeks,
            "recovery_consec_pos_weeks": req.recovery_consec_pos_weeks,
        },
    }


@router.get("/status")
async def status():
    """Read current model_pool.json from GCS."""
    try:
        import json as _json
        from google.cloud import storage
        bucket = storage.Client().bucket("stockvision-models")
        blob = bucket.blob("universal/model_pool.json")
        if not blob.exists():
            return {"status": "not_initialized", "note": "Run POST /model_pool/init first"}
        return _json.loads(blob.download_as_text())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"GCS read failed: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 bootstrap endpoints (versioning + state machine init)
# ─────────────────────────────────────────────────────────────────────────────


class MigrateLegacyRequest(BaseModel):
    dry_run: bool = True
    confirm: bool = False  # required when dry_run=False


@router.post("/migrate_legacy")
async def migrate_legacy(req: MigrateLegacyRequest):
    """Copy legacy flat-file GCS artifacts to versioned layout (universal/{model}/v1.{ext}).

    dry_run=True: report only.
    dry_run=False + confirm=true: actually copy. Originals kept (for predict
    fallback until model_pool.json is the canonical source). Stage 4 follow-up
    will deprecate originals after consumers migrate.
    """
    if not req.dry_run and not req.confirm:
        raise HTTPException(
            status_code=400,
            detail="Non-dry-run requires confirm=true (writes to GCS)",
        )
    # Inline import — avoid forcing controller container to load ml-service deps at startup
    import importlib
    import sys
    sys.path.insert(0, "/app")  # ensure ml-service modules importable when colocated
    try:
        from app import model_pool as _mp  # ml-service module
    except ImportError:
        # Fallback path for cases where ml-service modules not on PYTHONPATH:
        # do the bare migration via direct GCS calls
        return _inline_migrate_via_gcs(dry_run=req.dry_run)
    return _mp.migrate_legacy_to_versioned(dry_run=req.dry_run)


def _inline_migrate_via_gcs(dry_run: bool) -> dict:
    """Fallback if ml-service module isn't reachable: minimal inline copy."""
    from google.cloud import storage
    bucket = storage.Client().bucket("stockvision-models")
    legacy_to_versioned = {
        "universal/xgboost.joblib":          "universal/xgboost/v1.joblib",
        "universal/catboost.joblib":         "universal/catboost/v1.joblib",
        "universal/extratrees.joblib":       "universal/extratrees/v1.joblib",
        "universal/lightgbm.joblib":         "universal/lightgbm/v1.joblib",
        "universal/ft-transformer.joblib":   "universal/ft_transformer/v1.joblib",
        "universal/metadata_xgboost.json":          "universal/xgboost/metadata_v1.json",
        "universal/metadata_catboost.json":         "universal/catboost/metadata_v1.json",
        "universal/metadata_extratrees.json":       "universal/extratrees/metadata_v1.json",
        "universal/metadata_lightgbm.json":         "universal/lightgbm/metadata_v1.json",
        "universal/metadata_ft-transformer.json":   "universal/ft_transformer/metadata_v1.json",
    }
    actions = []
    for src, tgt in legacy_to_versioned.items():
        src_blob = bucket.blob(src)
        tgt_blob = bucket.blob(tgt)
        item = {"source": src, "target": tgt}
        if not src_blob.exists():
            actions.append({**item, "executed": False, "note": "source missing"})
            continue
        if tgt_blob.exists():
            actions.append({**item, "executed": False, "note": "target exists (skip)"})
            continue
        if dry_run:
            actions.append({**item, "executed": False, "note": "dry_run"})
            continue
        try:
            new = bucket.copy_blob(src_blob, bucket, tgt)
            actions.append({**item, "executed": True, "note": f"copied → {new.name}"})
        except Exception as e:
            actions.append({**item, "executed": False, "note": f"error: {e}"})
    return {"dry_run": dry_run, "actions": actions}


class InitPoolRequest(BaseModel):
    confirm: bool = False
    overwrite: bool = False  # if model_pool.json already exists


@router.post("/init")
async def init_pool(req: InitPoolRequest):
    """Initialize model_pool.json with all 8 universal models as 'active' v1.

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
    bucket = storage.Client().bucket("stockvision-models")
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
    # without forcing module import here — keep ml-controller decoupled).
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
    models = {}
    for name, mt, bf, ext in managed:
        folder = name.lower().replace("-", "_")
        models[name] = {
            "status": "active",
            "version": "v1",
            "gcs_path": f"universal/{folder}/v1.{ext}",
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
    pool = {
        "schema_version": "1.0",
        "last_updated": iso_now,
        "models": models,
    }
    pool_blob.upload_from_string(
        _json.dumps(pool, indent=2, ensure_ascii=False),
        content_type="application/json",
    )
    return {"status": "initialized", "model_count": len(models), "last_updated": iso_now}


# ─────────────────────────────────────────────────────────────────────────────
# Chronos config marker (foundation model — no weights, just a version stub)
# ─────────────────────────────────────────────────────────────────────────────


class WriteChronosConfigRequest(BaseModel):
    version: str = "v1"
    model_id: str = "amazon/chronos-t5-tiny"
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
    bucket = storage.Client().bucket("stockvision-models")
    cfg = {
        "version": req.version,
        "model_id": req.model_id,
        "horizon_default": req.horizon_default,
        "num_samples_default": req.num_samples_default,
        "strategy": "zero-shot foundation, no training",
        "saved_at": datetime.now(timezone.utc).isoformat(),
    }
    path = f"universal/chronos/{req.version}.json"
    bucket.blob(path).upload_from_string(
        _json.dumps(cfg, indent=2), content_type="application/json"
    )
    return {"status": "written", "path": path, "config": cfg}
