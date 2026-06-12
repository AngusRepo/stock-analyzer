#!/usr/bin/env python3
"""Read-only XGBoost package-version OOS replay.

This script builds a small tabular price/volume feature set from the local
stock_prices CSV and evaluates the installed xgboost runtime with expanding
walk-forward folds. It does not write model artifacts or mutate production.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl


FEATURE_COLUMNS = [
    "ret_1",
    "ret_2",
    "ret_5",
    "ret_10",
    "ret_20",
    "ma_gap_5",
    "ma_gap_20",
    "volatility_10",
    "range_pct",
    "oc_ret",
    "volume_chg_5",
    "volume_z_20",
]


def rank_ic(pred: np.ndarray, actual: np.ndarray) -> float:
    pred = np.asarray(pred, dtype=float).reshape(-1)
    actual = np.asarray(actual, dtype=float).reshape(-1)
    mask = np.isfinite(pred) & np.isfinite(actual)
    pred = pred[mask]
    actual = actual[mask]
    if len(pred) < 2:
        return 0.0
    try:
        from scipy.stats import spearmanr

        value = spearmanr(pred, actual).correlation
        return float(value) if math.isfinite(float(value)) else 0.0
    except Exception:
        pred_rank = np.argsort(np.argsort(pred))
        actual_rank = np.argsort(np.argsort(actual))
        if np.std(pred_rank) == 0 or np.std(actual_rank) == 0:
            return 0.0
        return float(np.corrcoef(pred_rank, actual_rank)[0, 1])


def direction_accuracy(pred: np.ndarray, actual: np.ndarray) -> float:
    pred = np.asarray(pred, dtype=float).reshape(-1)
    actual = np.asarray(actual, dtype=float).reshape(-1)
    mask = np.isfinite(pred) & np.isfinite(actual) & (pred != 0) & (actual != 0)
    if not mask.any():
        return 0.0
    return float(np.mean(np.sign(pred[mask]) == np.sign(actual[mask])))


def build_dataset(csv_path: Path, *, top_symbols: int, max_rows: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, Any]]:
    raw = (
        pl.read_csv(csv_path, infer_schema_length=1000)
        .with_columns(
            pl.col("date").cast(pl.Utf8),
            pl.col("symbol").cast(pl.Utf8),
            pl.col("open").cast(pl.Float64),
            pl.col("high").cast(pl.Float64),
            pl.col("low").cast(pl.Float64),
            pl.col("close").cast(pl.Float64),
            pl.col("volume").cast(pl.Float64),
        )
        .filter((pl.col("close") > 0) & (pl.col("volume") > 0))
    )
    top = (
        raw.group_by("symbol")
        .agg(pl.col("volume").mean().alias("avg_volume"), pl.len().alias("rows"))
        .filter(pl.col("rows") >= 180)
        .sort(["avg_volume", "rows"], descending=[True, True])
        .head(top_symbols)
        .select("symbol")
    )
    df = raw.join(top, on="symbol", how="inner").sort(["symbol", "date"])
    df = df.with_columns(
        (pl.col("close") / pl.col("close").shift(1).over("symbol") - 1.0).alias("ret_1"),
        (pl.col("close") / pl.col("close").shift(2).over("symbol") - 1.0).alias("ret_2"),
        (pl.col("close") / pl.col("close").shift(5).over("symbol") - 1.0).alias("ret_5"),
        (pl.col("close") / pl.col("close").shift(10).over("symbol") - 1.0).alias("ret_10"),
        (pl.col("close") / pl.col("close").shift(20).over("symbol") - 1.0).alias("ret_20"),
        (pl.col("close") / pl.col("close").rolling_mean(5).over("symbol") - 1.0).alias("ma_gap_5"),
        (pl.col("close") / pl.col("close").rolling_mean(20).over("symbol") - 1.0).alias("ma_gap_20"),
        pl.col("close").pct_change().rolling_std(10).over("symbol").alias("volatility_10"),
        ((pl.col("high") - pl.col("low")) / pl.col("close")).alias("range_pct"),
        ((pl.col("close") - pl.col("open")) / pl.col("open")).alias("oc_ret"),
        (pl.col("volume") / pl.col("volume").rolling_mean(5).over("symbol") - 1.0).alias("volume_chg_5"),
        (
            (pl.col("volume") - pl.col("volume").rolling_mean(20).over("symbol"))
            / (pl.col("volume").rolling_std(20).over("symbol") + 1.0)
        ).alias("volume_z_20"),
        (pl.col("close").shift(-5).over("symbol") / pl.col("close") - 1.0).alias("target_fwd_ret_5"),
    )
    df = df.select(["date", "symbol", *FEATURE_COLUMNS, "target_fwd_ret_5"]).drop_nulls()
    if len(df) > max_rows:
        keep = np.linspace(0, len(df) - 1, max_rows).astype(int)
        df = df[keep.tolist()]
    df = df.sort(["date", "symbol"])
    X = df.select(FEATURE_COLUMNS).to_numpy().astype(np.float32)
    y = df.select("target_fwd_ret_5").to_numpy().reshape(-1).astype(np.float32)
    dates = df.select("date").to_numpy().reshape(-1)
    report = {
        "csv_path": str(csv_path),
        "rows": int(len(y)),
        "symbols": int(df.select("symbol").n_unique()),
        "features": len(FEATURE_COLUMNS),
        "start_date": str(df.select(pl.col("date").min()).item()),
        "end_date": str(df.select(pl.col("date").max()).item()),
        "top_symbols": top_symbols,
        "max_rows": max_rows,
    }
    return X, y, dates, report


def make_folds(dates: np.ndarray, *, folds: int, min_train_dates: int) -> list[tuple[np.ndarray, np.ndarray, str, str]]:
    unique_dates = np.array(sorted({str(v) for v in dates.tolist()}))
    if len(unique_dates) < min_train_dates + folds * 5:
        return []
    test_dates = unique_dates[min_train_dates:]
    blocks = np.array_split(test_dates, folds)
    result: list[tuple[np.ndarray, np.ndarray, str, str]] = []
    date_str = np.asarray([str(v) for v in dates.tolist()])
    for block in blocks:
        if len(block) < 5:
            continue
        train_mask = date_str < block[0]
        test_mask = np.isin(date_str, block)
        train_idx = np.where(train_mask)[0]
        test_idx = np.where(test_mask)[0]
        if len(train_idx) >= 500 and len(test_idx) >= 100:
            result.append((train_idx, test_idx, str(block[0]), str(block[-1])))
    return result


def run_benchmark(args: argparse.Namespace) -> dict[str, Any]:
    started_at = time.time()
    import xgboost as xgb

    X, y, dates, data_report = build_dataset(Path(args.csv), top_symbols=args.top_symbols, max_rows=args.max_rows)
    folds = make_folds(dates, folds=args.folds, min_train_dates=args.min_train_dates)
    if not folds:
        return {
            "status": "blocked",
            "candidate_id": args.candidate_id,
            "blockers": ["insufficient_rows_for_walk_forward_folds"],
            "xgboost_version": xgb.__version__,
            "data_slice_report": data_report,
        }

    fold_metrics: list[dict[str, Any]] = []
    for fold_id, (train_idx, test_idx, start_date, end_date) in enumerate(folds):
        model = xgb.XGBRegressor(
            objective="reg:squarederror",
            n_estimators=args.n_estimators,
            max_depth=args.max_depth,
            learning_rate=args.learning_rate,
            subsample=0.8,
            colsample_bytree=0.8,
            reg_alpha=0.0,
            reg_lambda=1.0,
            tree_method="hist",
            n_jobs=args.n_jobs,
            random_state=args.seed,
            verbosity=0,
        )
        model.fit(X[train_idx], y[train_idx])
        pred = model.predict(X[test_idx])
        fold_metrics.append({
            "fold_id": f"xgboost_v{xgb.__version__}_fold_{fold_id}",
            "start_date": start_date,
            "end_date": end_date,
            "train_rows": int(len(train_idx)),
            "test_rows": int(len(test_idx)),
            "oos_ic": rank_ic(pred, y[test_idx]),
            "direction_accuracy": direction_accuracy(pred, y[test_idx]),
        })

    ics = [float(row["oos_ic"]) for row in fold_metrics]
    return {
        "status": "available",
        "candidate_id": args.candidate_id,
        "xgboost_version": xgb.__version__,
        "fold_metrics": fold_metrics,
        "oos_ic_mean": round(float(np.mean(ics)), 6),
        "oos_ic_median": round(float(np.median(ics)), 6),
        "live_ic_proxy_last_fold": round(float(ics[-1]), 6),
        "pbo": round(sum(1 for value in ics if value <= 0.0) / len(ics), 6),
        "direction_accuracy_mean": round(float(np.mean([row["direction_accuracy"] for row in fold_metrics])), 6),
        "latency_sec": round(max(0.0, time.time() - started_at), 3),
        "data_slice_report": data_report,
        "production_mutation_allowed": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only XGBoost package-version OOS replay")
    parser.add_argument("--csv", default="../scripts/data/stock_prices.csv")
    parser.add_argument("--candidate-id", default="XGBoost")
    parser.add_argument("--top-symbols", type=int, default=128)
    parser.add_argument("--max-rows", type=int, default=80000)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--min-train-dates", type=int, default=252)
    parser.add_argument("--n-estimators", type=int, default=200)
    parser.add_argument("--max-depth", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=0.05)
    parser.add_argument("--n-jobs", type=int, default=4)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    print(json.dumps(run_benchmark(args), ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
