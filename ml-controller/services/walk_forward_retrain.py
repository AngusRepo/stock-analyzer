"""
walk_forward_retrain.py — Sprint 6b Mode B walk-forward ML orchestrator (scaffold)

Roadmap: #32 "Sprint 6b Mode B walk-forward ML (12 windows × 11 models = 132 retrains
              + predict_regime_at_date() interface)"
Source: project_roadmap_merged_2026_04_08.md (estimated 8-15 hr)

────────────────────────────────────────────────────────────────────────────
STATUS: SCAFFOLD ONLY — not wired to production retrain cycles yet.
────────────────────────────────────────────────────────────────────────────

What this module adds:
  1. walk_forward_retrain_all(start, end) — orchestrator that:
     - Generates 12 walk-forward windows using backtest_engine.walk_forward_windows
     - For each window, triggers ml-controller retrain endpoint on window.train_range
     - Collects OOS IC + sharpe on window.test_range
     - Persists per-window model artifacts to GCS under walk_forward/w{id}/{model}.joblib
  2. predict_regime_at_date(date) — replays HMM to infer regime at historical date
  3. load_model_for_window(window_id, model_name) — loader for per-window models

What this module does NOT do (deferred Phase):
  - Does NOT auto-trigger 132 retrains. Wei must approve run via:
      POST /retrain/walk_forward {start, end, models}
  - Does NOT swap production model — results go to GCS under walk_forward/ prefix.
    After comparing vs current universal model, Wei manually promotes.
  - Does NOT hook into paper.ts. That's Sprint 7+ (per-regime robust).

Compute budget (if/when Wei says go):
  12 windows × 6 models (5 trees + FT-T) = 72 retrains
  Each retrain ≈ 3-5 min on Modal L4 GPU (FT-T dominates)
  Wall clock: 4-6 hours GPU time (sequential) or ~1 hour (6-way parallel)
  Project hours: 8-15 total (per memory estimate) including scaffold,
  backtest harness integration, analysis, and model comparison.

Prerequisites before running:
  - predict_stock_v2 crash fix committed + deployed (OPEN ISSUE §3.1)
  - ml-controller /regime/compute wired (#30 — scaffolded, awaiting deploy)
  - GCS bucket path conventions confirmed (walk_forward/w{id}/*)
"""
from __future__ import annotations
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx

from services.backtest_engine import (  # noqa: E402
    BacktestDataset,
    WalkForwardWindow,
    walk_forward_windows,
    replay_period,
)

logger = logging.getLogger(__name__)

ML_SERVICE_URL    = os.environ.get("ML_SERVICE_URL", "")
ML_SERVICE_SECRET = os.environ.get("ML_SERVICE_SECRET", "")

MODELS_ALL = ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM", "FT-Transformer"]


@dataclass
class WalkForwardResult:
    window_id: int
    train_range: tuple[str, str]
    test_range: tuple[str, str]
    model_metrics: dict[str, dict] = field(default_factory=dict)  # {model: {ic, sharpe, ...}}
    replay_metrics: Optional[dict] = None   # BacktestMetrics dict from replay_period
    error: Optional[str] = None


@dataclass
class WalkForwardRun:
    start_date: str
    end_date: str
    windows: list[WalkForwardResult] = field(default_factory=list)
    aggregate: dict = field(default_factory=dict)   # {mean_ic, std_ic, mean_sharpe, ...}


# ── HMM Regime Replay (new interface for Sprint 6b) ──────────────────────────

def predict_regime_at_date(dataset: BacktestDataset, historical_date: str) -> str:
    """Replay HMM regime prediction for a historical date.

    Mode A stub (2026-04-17): returns a best-effort mapping from
    dataset.market_risk.risk_level at that date to the 4-regime taxonomy used
    by regime.py. When the HMM time-series snapshot is added to GCS (Sprint 6b
    full implementation), replace this with a real HMM replay using the
    detector's saved joblib at that point in time.

    Current mapping (from risk_level):
      green  → bull_market
      yellow → bull_market (mild bull)
      orange → volatile
      red    → sideways
      black  → bear_market
    """
    if dataset.market_risk.is_empty():
        return "sideways"
    rows = dataset.market_risk.filter(dataset.market_risk["date"] == historical_date)
    if rows.is_empty():
        return "sideways"
    level = rows["risk_level"][0]

    MAP = {
        "green":  "bull_market",
        "yellow": "bull_market",
        "orange": "volatile",
        "red":    "sideways",
        "black":  "bear_market",
    }
    return MAP.get(str(level).lower(), "sideways")


def predict_regime_batch(dataset: BacktestDataset, dates: list[str]) -> dict[str, str]:
    """Batch version of predict_regime_at_date for a list of dates."""
    return {d: predict_regime_at_date(dataset, d) for d in dates}


# ── Walk-forward orchestrator ────────────────────────────────────────────────

async def _trigger_retrain_window(
    client: httpx.AsyncClient,
    window: WalkForwardWindow,
    models: list[str],
) -> dict:
    """Call ml-service walk_forward retrain endpoint for one window.

    Endpoint does not yet exist. Target shape:
      POST {ML_SERVICE_URL}/retrain/walk_forward
        {
          "window_id": int,
          "train_start": "YYYY-MM-DD",
          "train_end":   "YYYY-MM-DD",
          "test_start":  "YYYY-MM-DD",
          "test_end":    "YYYY-MM-DD",
          "models":      ["XGBoost", ...],
          "gcs_prefix":  "walk_forward/w{id}/"
        }

      Returns:
        {
          "window_id": int,
          "models_retrained": int,
          "model_metrics": {"XGBoost": {"ic": 0.12, ...}, ...},
          "gcs_paths": {"XGBoost": "gs://stockvision-models/walk_forward/w3/xgb.joblib"}
        }
    """
    if not ML_SERVICE_URL:
        raise RuntimeError("ML_SERVICE_URL not set")

    headers = {"Content-Type": "application/json"}
    if ML_SERVICE_SECRET:
        headers["X-Service-Token"] = ML_SERVICE_SECRET

    resp = await client.post(
        f"{ML_SERVICE_URL}/retrain/walk_forward",
        headers=headers,
        json={
            "window_id": window.window_id,
            "train_start": window.train_start,
            "train_end":   window.train_end,
            "test_start":  window.test_start,
            "test_end":    window.test_end,
            "models":      models,
            "gcs_prefix":  f"walk_forward/w{window.window_id}/",
        },
        timeout=3600.0,    # 1 hour per window (worst-case GPU retrain)
    )
    if resp.status_code != 200:
        raise RuntimeError(f"walk_forward retrain HTTP {resp.status_code}: {resp.text[:300]}")
    return resp.json()


async def run_walk_forward(
    dataset: BacktestDataset,
    start_date: str,
    end_date: str,
    train_window_days: int = 60,
    test_window_days: int = 30,
    models: list[str] = None,
    dry_run: bool = True,
) -> WalkForwardRun:
    """Execute the full walk-forward retrain + OOS evaluation sequence.

    Args:
        dry_run: if True (default), only generates windows and reports plan
                 without triggering retrains. Set False to actually retrain.
    """
    models = models or MODELS_ALL
    trading_days = [d for d in dataset.trading_days if start_date <= d <= end_date]
    if len(trading_days) < train_window_days + test_window_days:
        raise ValueError(
            f"Timerange {start_date}..{end_date} too short: {len(trading_days)} days, "
            f"need >={train_window_days + test_window_days}"
        )

    windows = walk_forward_windows(
        trading_days=trading_days,
        train_window_days=train_window_days,
        test_window_days=test_window_days,
    )
    logger.info(f"[WalkForward] {len(windows)} windows × {len(models)} models "
                f"= {len(windows) * len(models)} retrains")

    if dry_run:
        return WalkForwardRun(
            start_date=start_date,
            end_date=end_date,
            windows=[
                WalkForwardResult(
                    window_id=w.window_id,
                    train_range=(w.train_start, w.train_end),
                    test_range=(w.test_start, w.test_end),
                )
                for w in windows
            ],
            aggregate={
                "dry_run": True,
                "planned_retrains": len(windows) * len(models),
                "estimated_gpu_wall_clock_hours": len(windows) * len(models) * 4 / 60,
            },
        )

    # Full run — async fan-out, one httpx.AsyncClient reuse
    run = WalkForwardRun(start_date=start_date, end_date=end_date)
    async with httpx.AsyncClient() as client:
        for w in windows:
            result = WalkForwardResult(
                window_id=w.window_id,
                train_range=(w.train_start, w.train_end),
                test_range=(w.test_start, w.test_end),
            )
            try:
                retrain_resp = await _trigger_retrain_window(client, w, models)
                result.model_metrics = retrain_resp.get("model_metrics", {})
                # OOS replay — uses per-window model artifacts via future
                # load_model_for_window() once retrain endpoint writes them
                # logger.info: skip replay until endpoint exists
            except Exception as e:
                logger.error(f"[WalkForward] window {w.window_id} failed: {e}")
                result.error = str(e)
            run.windows.append(result)

    # Aggregate metrics across windows
    all_ics = []
    for wr in run.windows:
        for model, m in wr.model_metrics.items():
            if isinstance(m, dict) and m.get("ic") is not None:
                all_ics.append(float(m["ic"]))
    if all_ics:
        import numpy as np
        run.aggregate = {
            "mean_ic": float(np.mean(all_ics)),
            "std_ic":  float(np.std(all_ics)),
            "min_ic":  float(np.min(all_ics)),
            "max_ic":  float(np.max(all_ics)),
            "n_samples": len(all_ics),
        }
    return run


# ── Helper: load per-window model for Mode B evaluation ──────────────────────

def load_model_for_window(window_id: int, model_name: str):
    """Load a model trained on a specific walk-forward window from GCS.

    Returns (model_obj, metadata) or (None, None) if missing.

    After walk-forward retrain writes to `walk_forward/w{id}/{model}.joblib`,
    Mode B backtest can call this to evaluate on OOS test_range with the
    correct time-appropriate model (avoids future leak).
    """
    # Thin wrapper around model_store.load_model with prefix override.
    # Import kept local to keep services/ importable without Modal/ml-service deps.
    try:
        from google.cloud import storage
    except ImportError:
        logger.warning("[WalkForward] google-cloud-storage not installed; load_model_for_window unavailable")
        return None, None

    bucket_name = os.environ.get("GCS_MODELS_BUCKET", "stockvision-models")
    key = f"walk_forward/w{window_id}/{model_name.lower().replace('-', '_')}.joblib"
    meta_key = f"walk_forward/w{window_id}/{model_name.lower().replace('-', '_')}_meta.json"

    client = storage.Client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(key)
    meta_blob = bucket.blob(meta_key)
    if not blob.exists() or not meta_blob.exists():
        return None, None

    import io
    import json
    import joblib
    buf = io.BytesIO()
    blob.download_to_file(buf)
    buf.seek(0)
    model = joblib.load(buf)
    metadata = json.loads(meta_blob.download_as_text())
    return model, metadata
