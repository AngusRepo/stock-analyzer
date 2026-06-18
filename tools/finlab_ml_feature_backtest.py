from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
AB_RUNNER = ROOT / "tools" / "finlab_alphabuilders_factor_backtest.py"
OVERLAP_RUNNER = ROOT / "tools" / "feature_strategy_overlap_numeric.py"


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot_load_module:{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _json_default(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return None if not np.isfinite(value) else float(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return str(value)


def _safe_float(value: Any, default: float | None = None) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if np.isfinite(out) else default


def _feature_group(name: str) -> str:
    lower = name.lower()
    if lower.startswith(("return", "volatility", "rsi", "macd", "bb_", "ma", "keltner", "k", "imax", "imin", "imxd", "beta", "rsqr", "resi", "cnt", "vstd", "wvma", "corr", "cord", "vwap", "linear_factor")):
        return "price_technical"
    if any(token in lower for token in ("chip", "foreign", "dealer", "institutional", "margin", "short", "retail")):
        return "chip_margin_flow"
    if any(token in lower for token in ("market_", "us_", "advance", "bull_", "adl_", "limit_")):
        return "market_regime"
    if any(token in lower for token in ("sentiment", "ptt")):
        return "sentiment"
    if any(token in lower for token in ("revenue",)):
        return "fundamental_revenue"
    if any(token in lower for token in ("sector", "market_cap", "avg_volume")):
        return "sector_metadata"
    return "other"


def _run_feature_direction(
    *,
    ab: Any,
    feature: str,
    frame: pd.DataFrame,
    direction: int,
    close: pd.DataFrame,
    tradable: pd.DataFrame,
    args: argparse.Namespace,
) -> dict[str, Any]:
    score = frame.replace([np.inf, -np.inf], np.nan) * float(direction)
    position = ab._top_k_position(score, args.top_k, tradable)
    direction_name = "high" if direction > 0 else "low"
    row_id = f"ml106_{feature}_{direction_name}"
    meta = {
        "feature_id": feature,
        "feature_group": _feature_group(feature),
        "direction_mode": direction_name,
        "direction": direction,
        "coverage": _safe_float(np.isfinite(frame.to_numpy(dtype=float, copy=False)).mean()),
        "avg_rank_std": _safe_float(score.rank(axis=1, pct=True).std(axis=1).mean()),
    }
    return ab._run_sim(row_id, "ml_feature_single", meta, position, args)


def run(args: argparse.Namespace) -> dict[str, Any]:
    started = time.time()
    ab = _load_module(AB_RUNNER, "stockvision_ml_feature_backtest_ab")
    overlap = _load_module(OVERLAP_RUNNER, "stockvision_ml_feature_backtest_overlap")

    print(f"[ml-feature-backtest] loading FinLab base data universe={args.universe}", file=sys.stderr, flush=True)
    base = ab._build_base_data(args.universe)
    close_all = base["close"].loc[: args.end_date]
    columns = close_all.columns.tolist()
    if args.max_symbols > 0:
        columns = columns[: args.max_symbols]

    index = overlap._common_index(close_all, args.start_date, args.end_date)
    close = close_all.reindex(index=index, columns=columns).astype(float)
    tradable = close.notna()

    print(f"[ml-feature-backtest] building ML FEATURE_COLS pool", file=sys.stderr, flush=True)
    ml_values, feature_names = overlap._build_ml_feature_pool(
        base=base,
        start_date=args.start_date,
        end_date=args.end_date,
        columns=columns,
    )

    results: list[dict[str, Any]] = []
    for i, feature in enumerate(feature_names, start=1):
        frame = ml_values.get(feature)
        if frame is None:
            results.append({
                "id": f"ml106_{feature}",
                "kind": "ml_feature_single",
                "feature_id": feature,
                "feature_group": _feature_group(feature),
                "status": "not_mapped",
            })
            continue
        for direction in (1, -1) if args.run_both_directions else (1,):
            row = _run_feature_direction(
                ab=ab,
                feature=feature,
                frame=frame,
                direction=direction,
                close=close,
                tradable=tradable,
                args=args,
            )
            results.append(row)
        if i % 20 == 0:
            print(f"[ml-feature-backtest] simulated {i}/{len(feature_names)} features", file=sys.stderr, flush=True)

    best_by_feature: list[dict[str, Any]] = []
    for feature in feature_names:
        rows = [row for row in results if row.get("feature_id") == feature and row.get("status") == "ok"]
        if not rows:
            continue
        rows.sort(
            key=lambda row: (
                _safe_float(row.get("monthly_sharpe"), -999.0) or -999.0,
                _safe_float(row.get("cagr"), -999.0) or -999.0,
            ),
            reverse=True,
        )
        best = dict(rows[0])
        best["selection_note"] = "best_of_high_low_in_sample_research_only" if args.run_both_directions else "high_only"
        best_by_feature.append(best)

    best_by_feature.sort(
        key=lambda row: (
            _safe_float(row.get("monthly_sharpe"), -999.0) or -999.0,
            _safe_float(row.get("cagr"), -999.0) or -999.0,
        ),
        reverse=True,
    )

    return {
        "schema_version": "stockvision-finlab-ml-feature-backtest-v1",
        "config": {
            "universe": args.universe,
            "start_date": args.start_date,
            "end_date": args.end_date,
            "top_k": args.top_k,
            "resample": args.resample,
            "position_limit": args.position_limit,
            "trade_at_price": args.trade_at_price,
            "run_both_directions": args.run_both_directions,
            "max_symbols": args.max_symbols,
            "note": "Research-only single-factor FinLab benchmark for ML FEATURE_COLS. Not a production selector.",
        },
        "counts": {
            "dates": int(len(index)),
            "symbols": int(len(columns)),
            "feature_count": int(len(feature_names)),
            "rows": int(len(results)),
            "ok": int(sum(1 for row in results if row.get("status") == "ok")),
            "not_mapped": int(sum(1 for row in results if row.get("status") == "not_mapped")),
            "no_signal": int(sum(1 for row in results if row.get("status") == "no_signal")),
            "sim_error": int(sum(1 for row in results if row.get("status") == "sim_error")),
        },
        "results": results,
        "best_by_feature": best_by_feature,
        "elapsed_s": round(time.time() - started, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Research-only FinLab backtest for StockVision ML FEATURE_COLS.")
    parser.add_argument("--start-date", default="2023-01-01")
    parser.add_argument("--end-date", default="2026-06-15")
    parser.add_argument("--universe", choices=["sii", "sii_otc"], default="sii")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--resample", default="M")
    parser.add_argument("--position-limit", type=float, default=0.10)
    parser.add_argument("--trade-at-price", default="close")
    parser.add_argument("--run-both-directions", action="store_true")
    parser.add_argument("--max-symbols", type=int, default=0)
    parser.add_argument("--output-dir", default=str(ROOT / "output" / "finlab_ml_feature_backtests"))
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    report = run(args)
    suffix = "bothdir" if args.run_both_directions else "high"
    stem = f"ml106_features_{args.universe}_{args.start_date}_{args.end_date}_top{args.top_k}_{suffix}".replace("-", "")
    json_path = output_dir / f"{stem}.json"
    rows_path = output_dir / f"{stem}_rows.csv"
    best_path = output_dir / f"{stem}_best.csv"
    summary_path = output_dir / f"{stem}_summary.json"

    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    pd.DataFrame(report["results"]).to_csv(rows_path, index=False, encoding="utf-8-sig")
    pd.DataFrame(report["best_by_feature"]).to_csv(best_path, index=False, encoding="utf-8-sig")
    summary = {
        "json": str(json_path),
        "rows_csv": str(rows_path),
        "best_csv": str(best_path),
        "counts": report["counts"],
        "top_best_by_feature": report["best_by_feature"][:20],
        "elapsed_s": report["elapsed_s"],
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default))
    return 0 if report["counts"]["sim_error"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
