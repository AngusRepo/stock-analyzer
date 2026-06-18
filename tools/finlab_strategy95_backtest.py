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


def _run_direction(
    *,
    ab: Any,
    factor_id: str,
    frame: pd.DataFrame,
    meta: dict[str, Any],
    direction: int,
    tradable: pd.DataFrame,
    args: argparse.Namespace,
) -> dict[str, Any]:
    direction_name = "declared_high" if direction > 0 else "declared_low"
    score = frame.replace([np.inf, -np.inf], np.nan) * float(direction)
    position = ab._top_k_position(score, args.top_k, tradable)
    row_id = f"strategy95_{factor_id}_{'high' if direction > 0 else 'low'}"
    row_meta = {
        "factor_id": factor_id,
        "source": meta.get("source"),
        "category": meta.get("category"),
        "direction_mode": "high" if direction > 0 else "low",
        "direction": direction,
        "declared_direction": meta.get("direction"),
        "is_declared_direction": int(np.sign(float(meta.get("direction") or 1.0)) == direction),
        "coverage": _safe_float(np.isfinite(frame.to_numpy(dtype=float, copy=False)).mean()),
    }
    return ab._run_sim(row_id, "strategy95_factor_single", row_meta, position, args)


def run(args: argparse.Namespace) -> dict[str, Any]:
    started = time.time()
    ab = _load_module(AB_RUNNER, "stockvision_strategy95_backtest_ab")
    overlap = _load_module(OVERLAP_RUNNER, "stockvision_strategy95_backtest_overlap")

    print(f"[strategy95-backtest] loading FinLab base data universe={args.universe}", file=sys.stderr, flush=True)
    base = ab._build_base_data(args.universe)
    close_all = base["close"].loc[: args.end_date]
    columns = close_all.columns.tolist()
    if args.max_symbols > 0:
        columns = columns[: args.max_symbols]
    index = overlap._common_index(close_all, args.start_date, args.end_date)
    close = close_all.reindex(index=index, columns=columns).astype(float)
    tradable = close.notna()

    print("[strategy95-backtest] building strategy factor pool", file=sys.stderr, flush=True)
    values, meta, info = overlap._build_strategy_factor_pool(
        base=base,
        factor_json=Path(args.factor_json),
        start_date=args.start_date,
        end_date=args.end_date,
        columns=columns,
    )

    results: list[dict[str, Any]] = []
    factor_ids = sorted(values.keys())
    for i, factor_id in enumerate(factor_ids, start=1):
        frame = values[factor_id]
        factor_meta = meta.get(factor_id, {})
        directions = (1, -1) if args.run_both_directions else (int(np.sign(float(factor_meta.get("direction") or 1.0))) or 1,)
        for direction in directions:
            results.append(
                _run_direction(
                    ab=ab,
                    factor_id=factor_id,
                    frame=frame,
                    meta=factor_meta,
                    direction=direction,
                    tradable=tradable,
                    args=args,
                )
            )
        if i % 20 == 0:
            print(f"[strategy95-backtest] simulated {i}/{len(factor_ids)} factors", file=sys.stderr, flush=True)

    best_by_factor: list[dict[str, Any]] = []
    declared_rows: list[dict[str, Any]] = []
    for factor_id in factor_ids:
        rows = [row for row in results if row.get("factor_id") == factor_id and row.get("status") == "ok"]
        if not rows:
            continue
        declared = [row for row in rows if row.get("is_declared_direction") == 1]
        if declared:
            declared_rows.append(dict(declared[0]))
        rows.sort(
            key=lambda row: (
                _safe_float(row.get("monthly_sharpe"), -999.0) or -999.0,
                _safe_float(row.get("cagr"), -999.0) or -999.0,
            ),
            reverse=True,
        )
        best = dict(rows[0])
        best["selection_note"] = "best_of_high_low_in_sample_research_only" if args.run_both_directions else "declared_direction_only"
        best_by_factor.append(best)

    best_by_factor.sort(
        key=lambda row: (
            _safe_float(row.get("monthly_sharpe"), -999.0) or -999.0,
            _safe_float(row.get("cagr"), -999.0) or -999.0,
        ),
        reverse=True,
    )
    declared_rows.sort(
        key=lambda row: (
            _safe_float(row.get("monthly_sharpe"), -999.0) or -999.0,
            _safe_float(row.get("cagr"), -999.0) or -999.0,
        ),
        reverse=True,
    )

    return {
        "schema_version": "stockvision-finlab-strategy95-backtest-v1",
        "config": {
            "universe": args.universe,
            "start_date": args.start_date,
            "end_date": args.end_date,
            "top_k": args.top_k,
            "resample": args.resample,
            "position_limit": args.position_limit,
            "trade_at_price": args.trade_at_price,
            "run_both_directions": args.run_both_directions,
            "note": "Research-only single-factor FinLab benchmark for 95 strategy factor pool. Not a production selector.",
        },
        "counts": {
            "dates": int(len(index)),
            "symbols": int(len(columns)),
            "factor_count": int(len(factor_ids)),
            "rows": int(len(results)),
            "ok": int(sum(1 for row in results if row.get("status") == "ok")),
            "not_mapped": int(sum(1 for row in results if row.get("status") == "not_mapped")),
            "no_signal": int(sum(1 for row in results if row.get("status") == "no_signal")),
            "sim_error": int(sum(1 for row in results if row.get("status") == "sim_error")),
        },
        "strategy_info": info,
        "results": results,
        "best_by_factor": best_by_factor,
        "declared_direction_rows": declared_rows,
        "elapsed_s": round(time.time() - started, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Research-only FinLab backtest for StockVision 95 strategy factor pool.")
    parser.add_argument("--factor-json", default=str(ROOT / "worker" / ".tmp-test-run-codex" / "alphabuilders_factors_fresh.json"))
    parser.add_argument("--start-date", default="2023-01-01")
    parser.add_argument("--end-date", default="2026-06-15")
    parser.add_argument("--universe", choices=["sii", "sii_otc"], default="sii")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--resample", default="M")
    parser.add_argument("--position-limit", type=float, default=0.10)
    parser.add_argument("--trade-at-price", default="close")
    parser.add_argument("--run-both-directions", action="store_true")
    parser.add_argument("--max-symbols", type=int, default=0)
    parser.add_argument("--output-dir", default=str(ROOT / "output" / "finlab_strategy95_backtests"))
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    report = run(args)
    suffix = "bothdir" if args.run_both_directions else "declared"
    stem = f"strategy95_factors_{args.universe}_{args.start_date}_{args.end_date}_top{args.top_k}_{suffix}".replace("-", "")
    json_path = output_dir / f"{stem}.json"
    rows_path = output_dir / f"{stem}_rows.csv"
    best_path = output_dir / f"{stem}_best.csv"
    declared_path = output_dir / f"{stem}_declared.csv"
    summary_path = output_dir / f"{stem}_summary.json"

    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    pd.DataFrame(report["results"]).to_csv(rows_path, index=False, encoding="utf-8-sig")
    pd.DataFrame(report["best_by_factor"]).to_csv(best_path, index=False, encoding="utf-8-sig")
    pd.DataFrame(report["declared_direction_rows"]).to_csv(declared_path, index=False, encoding="utf-8-sig")
    summary = {
        "json": str(json_path),
        "rows_csv": str(rows_path),
        "best_csv": str(best_path),
        "declared_csv": str(declared_path),
        "counts": report["counts"],
        "top_best_by_factor": report["best_by_factor"][:20],
        "top_declared_direction": report["declared_direction_rows"][:20],
        "elapsed_s": report["elapsed_s"],
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default))
    return 0 if report["counts"]["sim_error"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
