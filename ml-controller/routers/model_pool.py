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

    # ── 1. Pull verified per-model rows from D1 ──────────────────────────────
    placeholders = ",".join(["?"] * len(managed_models))
    sql = f"""
        SELECT model_name, direction_accuracy, actual_return_pct, generated_at
        FROM predictions
        WHERE model_name IN ({placeholders})
          AND actual_return_pct IS NOT NULL
          AND verified_at IS NOT NULL
          AND generated_at >= datetime('now', ?)
    """
    rows = d1_query(sql, [*managed_models, f"-{req.lookback_days} days"])
    by_model: dict[str, list[tuple[float, float]]] = {n: [] for n in managed_models}
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
    for name in managed_models:
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
    pool_changes: dict[str, dict] = {}
    if req.update_pool:
        try:
            bucket = storage.Client().bucket("stockvision-models")
            pool_blob = bucket.blob("universal/model_pool.json")
            if pool_blob.exists():
                pool = _json.loads(pool_blob.download_as_text())
                changed = False
                for name in managed_models:
                    info = per_model_ic.get(name, {})
                    ic = info.get("ic")
                    if ic is None:
                        continue
                    entry = pool.get("models", {}).get(name)
                    if not entry:
                        continue
                    entry.setdefault("weekly_ic", [])
                    entry["weekly_ic"].append(ic)
                    if len(entry["weekly_ic"]) > req.history_max:
                        entry["weekly_ic"] = entry["weekly_ic"][-req.history_max:]
                    last4 = entry["weekly_ic"][-4:]
                    entry["ic_4w_avg"] = round(sum(last4) / len(last4), 6)
                    if ic < 0:
                        entry["consecutive_negative_weeks"] = (entry.get("consecutive_negative_weeks") or 0) + 1
                    else:
                        entry["consecutive_negative_weeks"] = 0
                    pool_changes[name] = {
                        "ic": ic,
                        "ic_4w_avg": entry["ic_4w_avg"],
                        "consecutive_negative_weeks": entry["consecutive_negative_weeks"],
                        "history_len": len(entry["weekly_ic"]),
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

    return {
        "status": "ok",
        "lookback_days": req.lookback_days,
        "n_rows_total": len(rows),
        "per_model_ic": per_model_ic,
        "pool_updates": pool_changes if req.update_pool else None,
        "elapsed_s": round(time.time() - t0, 1),
    }


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
