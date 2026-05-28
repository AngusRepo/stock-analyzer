"""
walk_forward_retrain.py — Sprint 6b Mode B walk-forward ML orchestrator (REAL)

Roadmap: #32 "Sprint 6b Mode B walk-forward ML (12 windows × 11 models = 132 retrains
              + predict_regime_at_date() interface)"
Sources:
  - project_roadmap_merged_2026_04_08.md (estimated 8-15 hr)
  - project_backtest_engine_design_rationale.md (Mode A vs Mode B deviations)

Design
──────
For each walk-forward window (~12 windows for 1y data with 60d train + 30d test):
  1. Train HMM on market_env history up to window.train_end (no future leak)
     → save to GCS walk_forward/w{id}/hmm_detector.joblib
  2. Train 5 ML models on stock data with dates in [train_start, train_end]
     → save to GCS walk_forward/w{id}/{model}.joblib
  3. Evaluate on OOS [test_start, test_end] → per-window IC

Produces per-window model bank + HMM snapshots. Downstream consumers:
  - predict_regime_at_date(date) — real HMM replay for backtest Mode B
  - Per-regime robust Optuna (#33) — uses predict_regime_at_date for minimax
  - Champion-Challenger pool (ML_POOL_ARCHITECTURE) — aggregate metrics decide
    whether to promote per-window models to production

Compute
───────
12 windows × (tree [CPU] + FT-T [GPU]) = 24 Modal jobs
With tree max_containers=3 and FT-T max_containers=2 parallel, wall clock:
  ~12 × max(tree_time_per_window, ftt_time_per_window) / parallel_factor
  ≈ 12 × 15min / 2 ≈ 90 min if parallel
  Sequential fallback: 12 × 15min = 3 hr

HMM training is fast (~1 min per window on CPU, max_containers=3).
"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta, timezone
from typing import Optional, Any

import httpx

from services.backtest_engine import (  # noqa: E402
    BacktestDataset,
    WalkForwardWindow,
    walk_forward_windows,
)
from services.payload_builder import load_market_env
from services import modal_client

logger = logging.getLogger(__name__)

ML_SERVICE_URL    = os.environ.get("ML_SERVICE_URL", "")
ML_SERVICE_SECRET = os.environ.get("ML_SERVICE_SECRET", "")

MODELS_ALL = ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM"]


@dataclass
class WalkForwardWindowResult:
    window_id: int
    train_range: tuple[str, str]
    test_range: tuple[str, str]
    hmm_result: Optional[dict] = None
    tree_result: Optional[dict] = None
    ftt_result: Optional[dict] = None
    model_metrics: dict[str, dict] = field(default_factory=dict)
    error: Optional[str] = None


@dataclass
class WalkForwardRun:
    start_date: str
    end_date: str
    train_window_days: int
    test_window_days: int
    windows: list[WalkForwardWindowResult] = field(default_factory=list)
    aggregate: dict = field(default_factory=dict)


# ══════════════════════════════════════════════════════════════════════════════
# HMM Regime replay (real implementation)
# ══════════════════════════════════════════════════════════════════════════════

# In-process cache of loaded HMM detectors keyed by window_id
_HMM_CACHE: dict[int, Any] = {}
_WINDOW_INDEX: Optional[list[WalkForwardWindow]] = None


def _get_bucket():
    """Lazy GCS bucket init — copy of model_store._get_bucket pattern."""
    try:
        from google.cloud import storage
    except ImportError:
        logger.warning("[WalkForward] google-cloud-storage not installed")
        return None
    bucket_name = os.environ.get("GCS_BUCKET_NAME", "").strip()
    if not bucket_name:
        logger.warning("[WalkForward] GCS_BUCKET_NAME not set")
        return None
    try:
        client = storage.Client()
        return client.bucket(bucket_name)
    except Exception as e:
        logger.warning(f"[WalkForward] GCS init failed: {e}")
        return None


def _load_hmm_for_window(window_id: int):
    """Load per-window HMM detector from GCS walk_forward/w{id}/.

    Caches in-process to avoid repeated downloads when replaying many dates.
    Returns None if no snapshot exists for that window.
    """
    if window_id in _HMM_CACHE:
        return _HMM_CACHE[window_id]

    bucket = _get_bucket()
    if bucket is None:
        return None

    try:
        import io
        import joblib
        prefix = f"walk_forward/w{window_id}"
        blob = bucket.blob(f"{prefix}/hmm_detector.joblib")
        if not blob.exists():
            _HMM_CACHE[window_id] = None
            return None
        buf = io.BytesIO()
        blob.download_to_file(buf)
        buf.seek(0)
        detector = joblib.load(buf)
        _HMM_CACHE[window_id] = detector
        logger.info(f"[WalkForward] Loaded HMM for window {window_id} from {prefix}")
        return detector
    except Exception as e:
        logger.warning(f"[WalkForward] HMM load failed w{window_id}: {e}")
        _HMM_CACHE[window_id] = None
        return None


def _index_windows(dataset: BacktestDataset,
                   train_window_days: int = 60,
                   test_window_days: int = 30) -> list[WalkForwardWindow]:
    """Build the same window index that walk-forward retrain used.

    Cached at module level so predict_regime_at_date() doesn't rebuild per call.
    """
    global _WINDOW_INDEX
    if _WINDOW_INDEX is not None:
        return _WINDOW_INDEX
    _WINDOW_INDEX = walk_forward_windows(
        trading_days=dataset.trading_days,
        train_window_days=train_window_days,
        test_window_days=test_window_days,
    )
    return _WINDOW_INDEX


def _find_window_for_date(date: str, windows: list[WalkForwardWindow]) -> Optional[WalkForwardWindow]:
    """Find the walk-forward window whose test_range covers `date`.

    If no test_range covers it, fall back to the most recent window whose
    train_end < date (the most recent HMM snapshot before the date).

    Returns None if no suitable window found (e.g., date before any window).
    """
    # Prefer test_range match (the intended evaluation regime)
    for w in windows:
        if w.test_start <= date <= w.test_end:
            return w
    # Fallback: most recent window trained entirely before `date`
    before = [w for w in windows if w.train_end < date]
    return before[-1] if before else None


def _filter_market_env_by_end_date(market_env: dict, end_date: str) -> dict:
    """Return a copy of market_env with history truncated to dates <= end_date.

    Used to feed HMM training without future leak.
    """
    hist = market_env.get("history", {})
    filtered = {d: v for d, v in hist.items() if d <= end_date}
    if not filtered:
        return market_env
    # latest row for 'current features' context
    latest_date = max(filtered.keys())
    latest = filtered[latest_date]
    return {"history": filtered, **latest}


def predict_regime_at_date(
    dataset: BacktestDataset,
    historical_date: str,
    train_window_days: int = 60,
    test_window_days: int = 30,
) -> str:
    """Predict regime at a historical date using per-window HMM snapshots.

    Real Mode B implementation:
      1. Find the walk-forward window whose test_range covers `date`
         (or the most recent window trained before `date`)
      2. Load that window's HMM from GCS walk_forward/w{id}/
      3. Build market features for `date` from dataset.market_risk
      4. Predict regime

    Falls back to `sideways` if no HMM snapshot or features available.

    English label mapping (from regime.py _REGIME_INDEX_TO_EN):
      0 → bull_market  |  1 → volatile  |  2 → sideways  |  3 → bear_market
    """
    windows = _index_windows(dataset, train_window_days, test_window_days)
    if not windows:
        return "sideways"
    w = _find_window_for_date(historical_date, windows)
    if w is None:
        return "sideways"
    detector = _load_hmm_for_window(w.window_id)
    if detector is None:
        return "sideways"

    # Build market feature vector for this date from dataset.market_risk
    if dataset.market_risk.is_empty():
        return "sideways"
    rows = dataset.market_risk.filter(dataset.market_risk["date"] == historical_date)
    if rows.is_empty():
        return "sideways"

    import numpy as np
    row = {k: rows[k][0] for k in rows.columns}
    twii_close = float(row.get("twii_close") or 0)

    # Need prev1 and prev5 for 1d/5d returns — query dataset
    all_dates = dataset.market_risk.sort("date")
    date_col = all_dates["date"].to_list()
    try:
        idx = date_col.index(historical_date)
    except ValueError:
        return "sideways"
    prev1_close = float(all_dates["twii_close"][idx - 1]) if idx >= 1 else twii_close
    prev5_close = float(all_dates["twii_close"][idx - 5]) if idx >= 5 else twii_close

    ret_1d = (twii_close - prev1_close) / prev1_close if prev1_close else 0.0
    ret_5d = (twii_close - prev5_close) / prev5_close if prev5_close else 0.0
    risk_score = float(row.get("risk_score") or 50) / 100
    market_bias_20d = float(row.get("twii_bias") or 0)

    # Same 6-feature shape as regime.get_current_market_features
    cur_feat = np.array([
        ret_1d,
        ret_5d,
        risk_score,
        market_bias_20d,
        abs(ret_1d),
        abs(ret_1d),   # 3d vol placeholder — single-date context only
    ], dtype=float)

    # regime.py REGIME_INDEX_TO_EN mapping (duplicated here to avoid ml-service import)
    REGIME_EN = {0: "bull_market", 1: "volatile", 2: "sideways", 3: "bear_market"}
    try:
        info = detector.predict_regime(cur_feat)
        reg_idx = int(info.get("regime_index", 2))
        return REGIME_EN.get(reg_idx, "sideways")
    except Exception as e:
        logger.warning(f"[WalkForward] predict_regime crashed at {historical_date}: {e}")
        return "sideways"


def predict_regime_batch(
    dataset: BacktestDataset,
    dates: list[str],
    train_window_days: int = 60,
    test_window_days: int = 30,
) -> dict[str, str]:
    """Batch variant of predict_regime_at_date."""
    return {
        d: predict_regime_at_date(dataset, d, train_window_days, test_window_days)
        for d in dates
    }


def clear_hmm_cache():
    """Reset the in-process HMM cache — useful after retraining windows."""
    global _HMM_CACHE, _WINDOW_INDEX
    _HMM_CACHE = {}
    _WINDOW_INDEX = None


# ══════════════════════════════════════════════════════════════════════════════
# Walk-forward orchestrator (real — triggers Modal jobs)
# ══════════════════════════════════════════════════════════════════════════════

async def _train_one_window(
    window: WalkForwardWindow,
    market_env: dict,
    models: list[str],
    batch_count: int,
) -> WalkForwardWindowResult:
    """Execute full pipeline for one window: HMM → tree train → FT-T train.

    Tree and FT-T are spawned in parallel (two separate Modal containers).
    HMM is trained first because it's fast and later windows may not need
    re-training if the market_env hasn't changed much.
    """
    models = [model for model in models if model != "FT-Transformer"]
    result = WalkForwardWindowResult(
        window_id=window.window_id,
        train_range=(window.train_start, window.train_end),
        test_range=(window.test_start, window.test_end),
    )

    # Step 1: HMM (CPU, fast)
    try:
        filtered_env = _filter_market_env_by_end_date(market_env, window.train_end)
        hmm_payload = {
            "window_id": window.window_id,
            "train_end": window.train_end,
            "market_env": filtered_env,
        }
        result.hmm_result = await modal_client._modal_train_wf_hmm_window(hmm_payload)
        if result.hmm_result.get("error"):
            logger.warning(f"[WalkForward] w{window.window_id} HMM error: {result.hmm_result['error']}")
    except Exception as e:
        logger.error(f"[WalkForward] w{window.window_id} HMM crashed: {e}")
        result.error = f"hmm: {e}"
        return result

    # Step 2 & 3: Tree + FT-T in parallel
    train_payload = {
        "window_id": window.window_id,
        "train_start": window.train_start,
        "train_end": window.train_end,
        "test_start": window.test_start,
        "test_end": window.test_end,
        "batch_count": batch_count,
        "skip_feature_pool": False,
    }

    need_tree = any(m in models for m in ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM"])
    need_ftt = "FT-Transformer" in models

    tasks = []
    if need_tree:
        tasks.append(("tree", modal_client._modal_train_wf_tree_window(dict(train_payload))))
    if need_ftt:
        ftt_payload = dict(train_payload)
        ftt_payload["skip_feature_pool"] = True
        tasks.append(("ftt", modal_client._modal_train_wf_ftt_window(ftt_payload)))

    # Run both concurrently
    if tasks:
        raw_results = await asyncio.gather(*[t[1] for t in tasks], return_exceptions=True)
        for (kind, _), r in zip(tasks, raw_results):
            if isinstance(r, BaseException):
                logger.error(f"[WalkForward] w{window.window_id} {kind} crashed: {r}")
                if kind == "tree":
                    result.tree_result = {"error": f"exception: {r}"}
                else:
                    result.ftt_result = {"error": f"exception: {r}"}
            else:
                if kind == "tree":
                    result.tree_result = r
                else:
                    result.ftt_result = r

    # Consolidate per-model metrics
    for partial in (result.tree_result or {}, result.ftt_result or {}):
        if not partial or partial.get("error"):
            continue
        for model_name, model_info in (partial.get("results") or {}).items():
            if model_info.get("skipped") or model_info.get("error"):
                continue
            result.model_metrics[model_name] = {
                "oos_ic": model_info.get("oos_ic"),
                "train_samples": model_info.get("train"),
                "test_samples": model_info.get("test"),
            }

    return result


async def run_walk_forward(
    dataset: BacktestDataset,
    start_date: str,
    end_date: str,
    train_window_days: int = 60,
    test_window_days: int = 30,
    models: Optional[list[str]] = None,
    batch_count: int = 5,
    dry_run: bool = True,
    concurrent_windows: int = 2,
) -> WalkForwardRun:
    """Real walk-forward orchestrator — triggers Modal retrains per window.

    concurrent_windows: how many windows to train concurrently (bounded by Modal
                       max_containers — tree=3, ftt=2). Default 2 to respect
                       FT-T's tighter cap.
    """
    models = [model for model in (models or MODELS_ALL) if model != "FT-Transformer"]
    trading_days = [d for d in dataset.trading_days if start_date <= d <= end_date]
    if len(trading_days) < train_window_days + test_window_days:
        raise ValueError(
            f"Timerange {start_date}..{end_date} too short: {len(trading_days)} days, "
            f"need ≥{train_window_days + test_window_days}"
        )

    windows = walk_forward_windows(
        trading_days=trading_days,
        train_window_days=train_window_days,
        test_window_days=test_window_days,
    )
    logger.info(
        f"[WalkForward] {len(windows)} windows × {len(models)} models "
        f"= {len(windows) * len(models)} retrains (dry_run={dry_run})"
    )

    run = WalkForwardRun(
        start_date=start_date,
        end_date=end_date,
        train_window_days=train_window_days,
        test_window_days=test_window_days,
    )

    if dry_run:
        run.windows = [
            WalkForwardWindowResult(
                window_id=w.window_id,
                train_range=(w.train_start, w.train_end),
                test_range=(w.test_start, w.test_end),
            )
            for w in windows
        ]
        run.aggregate = {
            "dry_run": True,
            "planned_windows": len(windows),
            "planned_retrains": len(windows) * len(models),
            "estimated_gpu_wall_clock_hours": len(windows) * 15 / 60 / max(1, concurrent_windows),
        }
        return run

    # Load market_env ONCE at end_date — subsequent windows filter by their own train_end
    try:
        run_date = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
        me, _, _, _, _ = load_market_env(run_date)
        market_env = asdict(me)
    except Exception as e:
        raise RuntimeError(f"load_market_env failed: {e}") from e

    # Drive windows with bounded concurrency
    semaphore = asyncio.Semaphore(concurrent_windows)

    async def _bounded(w: WalkForwardWindow):
        async with semaphore:
            return await _train_one_window(w, market_env, models, batch_count)

    results = await asyncio.gather(
        *[_bounded(w) for w in windows],
        return_exceptions=True,
    )

    # Normalize results
    for w, r in zip(windows, results):
        if isinstance(r, BaseException):
            run.windows.append(WalkForwardWindowResult(
                window_id=w.window_id,
                train_range=(w.train_start, w.train_end),
                test_range=(w.test_start, w.test_end),
                error=f"async: {r}",
            ))
        else:
            run.windows.append(r)

    # Clear cache so subsequent predict_regime_at_date picks up fresh HMMs
    clear_hmm_cache()

    # Aggregate IC stats per model
    run.aggregate = _aggregate_run(run)
    return run


# ══════════════════════════════════════════════════════════════════════════════
# Analysis / aggregation
# ══════════════════════════════════════════════════════════════════════════════

def _aggregate_run(run: WalkForwardRun) -> dict:
    """Per-model IC statistics across windows + comparison anchor."""
    import numpy as np

    per_model: dict[str, list[float]] = {}
    n_errors = 0
    for wr in run.windows:
        if wr.error and not wr.model_metrics:
            n_errors += 1
            continue
        for name, m in wr.model_metrics.items():
            ic = m.get("oos_ic")
            if ic is None:
                continue
            per_model.setdefault(name, []).append(float(ic))

    summary = {}
    for name, ics in per_model.items():
        if not ics:
            continue
        arr = np.asarray(ics, dtype=float)
        summary[name] = {
            "n_windows": len(arr),
            "mean_ic": float(arr.mean()),
            "std_ic": float(arr.std()),
            "min_ic": float(arr.min()),
            "max_ic": float(arr.max()),
            "positive_share": float((arr > 0).mean()),
            "ic_per_window": arr.tolist(),
        }

    return {
        "n_windows_total": len(run.windows),
        "n_windows_errored": n_errors,
        "per_model": summary,
    }


def build_report(run: WalkForwardRun, current_universal_ic: Optional[dict] = None) -> str:
    """Markdown report comparing walk-forward per-model IC vs current universal.

    current_universal_ic: optional legacy report-only comparison data. It must
    not feed serving weights or model lifecycle decisions.
    """
    lines = [
        f"# Walk-Forward ML Run Report",
        f"",
        f"**Range**: `{run.start_date}` → `{run.end_date}`",
        f"**Windows**: {len(run.windows)} "
        f"(train={run.train_window_days}d / test={run.test_window_days}d)",
        f"",
    ]

    agg = run.aggregate
    if not agg.get("per_model"):
        lines.append("*No successful windows — check individual errors.*")
        return "\n".join(lines)

    lines.extend([
        f"## Per-model IC statistics",
        f"",
        f"| Model | n_windows | mean IC | std | min | max | %positive | Univ. IC | Δ |",
        f"|---|---|---|---|---|---|---|---|---|",
    ])
    for name, stats in sorted(agg["per_model"].items()):
        univ_ic = (current_universal_ic or {}).get(name, {}).get("oos_ic")
        delta = ""
        if univ_ic is not None:
            delta = f"{stats['mean_ic'] - univ_ic:+.4f}"
            univ_cell = f"{univ_ic:.4f}"
        else:
            univ_cell = "—"
        lines.append(
            f"| {name} | {stats['n_windows']} | "
            f"{stats['mean_ic']:.4f} | {stats['std_ic']:.4f} | "
            f"{stats['min_ic']:.4f} | {stats['max_ic']:.4f} | "
            f"{stats['positive_share']:.0%} | {univ_cell} | {delta} |"
        )

    lines.extend([
        f"",
        f"## Per-window IC (detailed)",
        f"",
    ])
    for wr in run.windows:
        metrics_str = ", ".join(
            f"{k}={v.get('oos_ic'):+.4f}" for k, v in wr.model_metrics.items() if v.get("oos_ic") is not None
        ) or "(no metrics)"
        err = f" ERROR={wr.error}" if wr.error else ""
        lines.append(
            f"- **w{wr.window_id}** train={wr.train_range[0]}..{wr.train_range[1]} "
            f"test={wr.test_range[0]}..{wr.test_range[1]} → {metrics_str}{err}"
        )

    return "\n".join(lines)


def persist_run_to_gcs(run: WalkForwardRun, extra: Optional[dict] = None) -> Optional[str]:
    """Upload run JSON to GCS walk_forward/runs/{start}_{end}.json.
    Returns the GCS path or None on failure.
    """
    bucket = _get_bucket()
    if bucket is None:
        return None
    try:
        import json
        path = f"walk_forward/runs/{run.start_date}_{run.end_date}.json"
        payload = {
            "start_date": run.start_date,
            "end_date": run.end_date,
            "train_window_days": run.train_window_days,
            "test_window_days": run.test_window_days,
            "windows": [
                {
                    "window_id": w.window_id,
                    "train_range": w.train_range,
                    "test_range": w.test_range,
                    "model_metrics": w.model_metrics,
                    "hmm_saved": (w.hmm_result or {}).get("saved", False),
                    "error": w.error,
                }
                for w in run.windows
            ],
            "aggregate": run.aggregate,
        }
        if extra:
            payload["extra"] = extra
        bucket.blob(path).upload_from_string(
            json.dumps(payload, indent=2, default=str),
            content_type="application/json",
        )
        logger.info(f"[WalkForward] Run persisted → gs://{bucket.name}/{path}")
        return path
    except Exception as e:
        logger.warning(f"[WalkForward] persist_run_to_gcs failed: {e}")
        return None


def load_current_universal_ic() -> dict:
    """Load legacy universal/ic_tracking.json for report-only comparison."""
    bucket = _get_bucket()
    if bucket is None:
        return {}
    try:
        import json
        blob = bucket.blob("universal/ic_tracking.json")
        if not blob.exists():
            return {}
        data = json.loads(blob.download_as_text())
        return data.get("models", {}) or {}
    except Exception as e:
        logger.warning(f"[WalkForward] load_current_universal_ic failed: {e}")
        return {}


# ══════════════════════════════════════════════════════════════════════════════
# Per-window model loader (for Mode B backtest)
# ══════════════════════════════════════════════════════════════════════════════

def load_model_for_window(window_id: int, model_name: str):
    """Load a per-window model from GCS walk_forward/w{id}/.

    Returns (model, metadata) or (None, None).
    Thin wrapper around ml-service model_store API (duplicated here for
    backtest use from ml-controller without ml-service dep).
    """
    bucket = _get_bucket()
    if bucket is None:
        return None, None
    try:
        import io
        import json
        import joblib
        prefix = f"walk_forward/w{window_id}"
        model_key = model_name.lower().replace(" ", "_")
        blob = bucket.blob(f"{prefix}/{model_key}.joblib")
        meta_blob = bucket.blob(f"{prefix}/metadata_{model_key}.json")
        if not blob.exists() or not meta_blob.exists():
            return None, None
        buf = io.BytesIO()
        blob.download_to_file(buf)
        buf.seek(0)
        model = joblib.load(buf)
        metadata = json.loads(meta_blob.download_as_text())
        return model, metadata
    except Exception as e:
        logger.warning(f"[WalkForward] load_model_for_window w{window_id}/{model_name}: {e}")
        return None, None
