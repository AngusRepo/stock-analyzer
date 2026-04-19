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


@router.get("/status")
async def status():
    """Read current model_pool.json from GCS. Placeholder until Stage 1 lands."""
    try:
        import json as _json
        from google.cloud import storage
        bucket = storage.Client().bucket("stockvision-models")
        blob = bucket.blob("universal/model_pool.json")
        if not blob.exists():
            return {"status": "not_initialized", "note": "model_pool.json not yet created (ML_POOL Stage 1+)"}
        return _json.loads(blob.download_as_text())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"GCS read failed: {e}")
