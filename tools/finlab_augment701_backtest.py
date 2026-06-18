from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "data" / "finlab_research" / "api_fields.json"


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
    return out if math.isfinite(out) else default


def _df(frame: Any) -> pd.DataFrame:
    out = pd.DataFrame(frame).copy()
    out.index = pd.to_datetime(out.index, errors="coerce")
    out = out.loc[out.index.notna()]
    out = out.sort_index()
    out.columns = [str(col).strip() for col in out.columns]
    return out


def _common_stock_columns(close: pd.DataFrame, universe: str) -> list[str]:
    from finlab import data

    sec = pd.DataFrame(data.get("security_categories"))
    sec["symbol"] = sec["symbol"].astype(str).str.strip()
    sec["market"] = sec["market"].astype(str).str.lower().str.strip()
    allowed_markets = ["sii"] if universe == "sii" else ["sii", "otc"]
    allowed = set(sec.loc[sec["market"].isin(allowed_markets) & sec["symbol"].str.fullmatch(r"\d{4}"), "symbol"])
    return [col for col in close.columns if col in allowed]


def _load_base(universe: str, end_date: str) -> tuple[pd.DataFrame, list[str]]:
    from finlab import data

    close_all = _df(data.get("price:收盤價")).loc[:end_date]
    columns = _common_stock_columns(close_all, universe)
    return close_all.reindex(columns=columns), columns


def _top_k_position(score: pd.DataFrame, top_k: int, tradable: pd.DataFrame) -> pd.DataFrame:
    score = score.where(tradable)
    rank = score.rank(axis=1, ascending=False, method="first")
    return (rank <= top_k).fillna(False)


def _extract_report(row_id: str, kind: str, meta: dict[str, Any], position: pd.DataFrame, report: Any, elapsed_s: float) -> dict[str, Any]:
    stats = report.get_stats()
    metrics = report.get_metrics()
    trades = report.get_trades()
    counts = position.sum(axis=1)
    return {
        "id": row_id,
        "kind": kind,
        **meta,
        "status": "ok",
        "elapsed_s": round(elapsed_s, 3),
        "cagr": _safe_float(stats.get("cagr")),
        "benchmark_alpha": _safe_float((metrics.get("profitability") or {}).get("alpha")),
        "benchmark_beta": _safe_float((metrics.get("profitability") or {}).get("beta")),
        "total_return": _safe_float(stats.get("total_return")),
        "max_drawdown": _safe_float(stats.get("max_drawdown")),
        "monthly_sharpe": _safe_float(stats.get("monthly_sharpe")),
        "monthly_sortino": _safe_float(stats.get("monthly_sortino")),
        "calmar": _safe_float(stats.get("calmar")),
        "win_ratio": _safe_float(stats.get("win_ratio")),
        "avg_n_stock": _safe_float((metrics.get("profitability") or {}).get("avgNStock")),
        "max_n_stock": _safe_float((metrics.get("profitability") or {}).get("maxNStock")),
        "trade_count": int(len(trades)),
        "match_days": int((counts > 0).sum()),
        "avg_daily_matches": _safe_float(counts.mean()),
        "max_daily_matches": int(counts.max()) if len(counts) else 0,
        "latest_matches": int(counts.iloc[-1]) if len(counts) else 0,
    }


def _run_sim(row_id: str, kind: str, meta: dict[str, Any], position: pd.DataFrame, args: argparse.Namespace) -> dict[str, Any]:
    from finlab.backtest import sim

    t0 = time.time()
    counts = position.sum(axis=1)
    if int(counts.sum()) == 0:
        return {
            "id": row_id,
            "kind": kind,
            **meta,
            "status": "no_signal",
            "elapsed_s": round(time.time() - t0, 3),
            "match_days": int((counts > 0).sum()),
            "avg_daily_matches": _safe_float(counts.mean()),
            "max_daily_matches": int(counts.max()) if len(counts) else 0,
            "latest_matches": int(counts.iloc[-1]) if len(counts) else 0,
        }
    try:
        report = sim(
            position,
            resample=args.resample,
            trade_at_price=args.trade_at_price,
            position_limit=float(args.position_limit),
            fee_ratio=0.001425,
            tax_ratio=0.003,
            name=row_id[:80],
            upload=False,
            fast_mode=True,
            notification_enable=False,
        )
        return _extract_report(row_id, kind, meta, position, report, time.time() - t0)
    except Exception as exc:
        return {
            "id": row_id,
            "kind": kind,
            **meta,
            "status": "sim_error",
            "error": f"{type(exc).__name__}: {exc}",
            "elapsed_s": round(time.time() - t0, 3),
            "match_days": int((counts > 0).sum()),
            "avg_daily_matches": _safe_float(counts.mean()),
            "max_daily_matches": int(counts.max()) if len(counts) else 0,
            "latest_matches": int(counts.iloc[-1]) if len(counts) else 0,
        }


def _load_augment_fields() -> list[dict[str, Any]]:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    rows = catalog.get("fields") or []
    return [row for row in rows if row.get("adoption_mode") == "augment"]


def _materialize_field(
    row: dict[str, Any],
    *,
    close: pd.DataFrame,
    columns: list[str],
    args: argparse.Namespace,
) -> tuple[pd.DataFrame | None, dict[str, Any]]:
    from finlab import data

    api_key = str(row.get("api_key") or "")
    audit = {
        "api_key": api_key,
        "namespace": row.get("namespace"),
        "field": row.get("field"),
        "group": row.get("group"),
        "dataset_lane": row.get("dataset_lane"),
        "market": row.get("market"),
        "adoption_priority": row.get("adoption_priority"),
        "stockvision_use": row.get("stockvision_use"),
    }
    try:
        raw = data.get(api_key)
        if hasattr(raw, "deadline"):
            raw = raw.deadline()
        frame = _df(raw)
    except Exception as exc:
        audit.update({"status": "materialize_error", "error": f"{type(exc).__name__}: {exc}"})
        return None, audit

    if frame.empty:
        audit.update({"status": "empty"})
        return None, audit

    overlap_cols = [col for col in columns if col in frame.columns]
    audit["raw_rows"] = int(frame.shape[0])
    audit["raw_cols"] = int(frame.shape[1])
    audit["overlap_cols"] = int(len(overlap_cols))
    if len(overlap_cols) < args.min_overlap_symbols:
        audit.update({"status": "context_only_or_not_stock_panel"})
        return None, audit

    aligned = frame.reindex(columns=columns).reindex(close.index).ffill()
    aligned = aligned.replace([np.inf, -np.inf], np.nan)
    aligned = aligned.apply(pd.to_numeric, errors="coerce")
    window = aligned.loc[args.start_date:args.end_date]
    coverage = float(np.isfinite(window.to_numpy(dtype=float, copy=False)).mean()) if window.size else 0.0
    rank_std = float(window.rank(axis=1, pct=True).std(axis=1).mean()) if window.size else 0.0
    audit["coverage"] = coverage
    audit["avg_rank_std"] = rank_std
    if coverage < args.min_coverage:
        audit.update({"status": "low_coverage"})
        return None, audit
    if not math.isfinite(rank_std) or rank_std < args.min_rank_std:
        audit.update({"status": "no_cross_section_signal"})
        return None, audit
    audit.update({"status": "backtestable"})
    return window, audit


def _run_field_directions(
    *,
    api_key: str,
    frame: pd.DataFrame,
    audit: dict[str, Any],
    tradable: pd.DataFrame,
    args: argparse.Namespace,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for direction in (1, -1) if args.run_both_directions else (1,):
        direction_name = "high" if direction > 0 else "low"
        score = frame.replace([np.inf, -np.inf], np.nan) * float(direction)
        position = _top_k_position(score, args.top_k, tradable)
        safe_id = api_key.replace(":", "_").replace("/", "_").replace("\\", "_")[:90]
        meta = {
            **audit,
            "direction_mode": direction_name,
            "direction": direction,
        }
        out.append(_run_sim(f"finlab701_{safe_id}_{direction_name}", "finlab701_single", meta, position, args))
    return out


def run(args: argparse.Namespace) -> dict[str, Any]:
    started = time.time()
    close_all, columns = _load_base(args.universe, args.end_date)
    if args.max_symbols > 0:
        columns = columns[: args.max_symbols]
    close = close_all.reindex(columns=columns).loc[args.start_date:args.end_date].astype(float)
    tradable = close.notna()

    fields = _load_augment_fields()
    if args.limit_fields > 0:
        fields = fields[: args.limit_fields]

    audits: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    backtestable_count = 0
    for idx, row in enumerate(fields, start=1):
        frame, audit = _materialize_field(row, close=close_all.reindex(columns=columns), columns=columns, args=args)
        audits.append(audit)
        if frame is not None:
            backtestable_count += 1
            results.extend(_run_field_directions(api_key=str(row.get("api_key") or ""), frame=frame, audit=audit, tradable=tradable, args=args))
        if idx % args.progress_every == 0:
            print(
                f"[finlab701] processed={idx}/{len(fields)} backtestable={backtestable_count} results={len(results)}",
                file=sys.stderr,
                flush=True,
            )

    best_by_field: list[dict[str, Any]] = []
    for api_key in sorted({row.get("api_key") for row in audits if row.get("api_key")}):
        rows = [row for row in results if row.get("api_key") == api_key and row.get("status") == "ok"]
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
        best_by_field.append(best)
    best_by_field.sort(
        key=lambda row: (
            _safe_float(row.get("monthly_sharpe"), -999.0) or -999.0,
            _safe_float(row.get("cagr"), -999.0) or -999.0,
        ),
        reverse=True,
    )

    status_counts: dict[str, int] = {}
    lane_counts: dict[str, int] = {}
    for audit in audits:
        status = str(audit.get("status") or "unknown")
        lane = str(audit.get("dataset_lane") or "unknown")
        status_counts[status] = status_counts.get(status, 0) + 1
        lane_counts[f"{lane}:{status}"] = lane_counts.get(f"{lane}:{status}", 0) + 1

    return {
        "schema_version": "stockvision-finlab-augment701-backtest-v1",
        "config": {
            "universe": args.universe,
            "start_date": args.start_date,
            "end_date": args.end_date,
            "top_k": args.top_k,
            "resample": args.resample,
            "position_limit": args.position_limit,
            "trade_at_price": args.trade_at_price,
            "run_both_directions": args.run_both_directions,
            "min_overlap_symbols": args.min_overlap_symbols,
            "min_coverage": args.min_coverage,
            "min_rank_std": args.min_rank_std,
            "note": "Research-only benchmark for FinLab augment fields. Context/global fields are audited but not forced into stock selector backtests.",
        },
        "counts": {
            "fields_input": int(len(fields)),
            "symbols": int(len(columns)),
            "dates": int(close.shape[0]),
            "status_counts": status_counts,
            "lane_status_counts": lane_counts,
            "result_rows": int(len(results)),
            "ok": int(sum(1 for row in results if row.get("status") == "ok")),
            "no_signal": int(sum(1 for row in results if row.get("status") == "no_signal")),
            "sim_error": int(sum(1 for row in results if row.get("status") == "sim_error")),
        },
        "audits": audits,
        "results": results,
        "best_by_field": best_by_field,
        "elapsed_s": round(time.time() - started, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Research-only FinLab augment 701 field audit/backtest.")
    parser.add_argument("--start-date", default="2023-01-01")
    parser.add_argument("--end-date", default="2026-06-15")
    parser.add_argument("--universe", choices=["sii", "sii_otc"], default="sii")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--resample", default="M")
    parser.add_argument("--position-limit", type=float, default=0.10)
    parser.add_argument("--trade-at-price", default="close")
    parser.add_argument("--run-both-directions", action="store_true")
    parser.add_argument("--min-overlap-symbols", type=int, default=30)
    parser.add_argument("--min-coverage", type=float, default=0.20)
    parser.add_argument("--min-rank-std", type=float, default=1e-4)
    parser.add_argument("--limit-fields", type=int, default=0)
    parser.add_argument("--max-symbols", type=int, default=0)
    parser.add_argument("--progress-every", type=int, default=25)
    parser.add_argument("--output-dir", default=str(ROOT / "output" / "finlab_augment701_backtests"))
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    report = run(args)
    suffix = "bothdir" if args.run_both_directions else "high"
    stem = f"finlab701_{args.universe}_{args.start_date}_{args.end_date}_top{args.top_k}_{suffix}".replace("-", "")
    json_path = output_dir / f"{stem}.json"
    audits_path = output_dir / f"{stem}_audits.csv"
    rows_path = output_dir / f"{stem}_rows.csv"
    best_path = output_dir / f"{stem}_best.csv"
    summary_path = output_dir / f"{stem}_summary.json"

    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    pd.DataFrame(report["audits"]).to_csv(audits_path, index=False, encoding="utf-8-sig")
    pd.DataFrame(report["results"]).to_csv(rows_path, index=False, encoding="utf-8-sig")
    pd.DataFrame(report["best_by_field"]).to_csv(best_path, index=False, encoding="utf-8-sig")
    summary = {
        "json": str(json_path),
        "audits_csv": str(audits_path),
        "rows_csv": str(rows_path),
        "best_csv": str(best_path),
        "counts": report["counts"],
        "top_best_by_field": report["best_by_field"][:30],
        "elapsed_s": report["elapsed_s"],
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default))
    return 0 if report["counts"]["sim_error"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
