from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
COMPARE_RUNNER = ROOT / "tools" / "finlab_active_candidate_strategy_compare.py"
TECH_RUNNER = ROOT / "tools" / "finlab_technical_strategy12_backtest.py"
DEFAULT_ACTIVE_SPEC_JSON = ROOT / "output" / "finlab_strategy_backtests" / "current_active_11_strategy_specs.json"
DEFAULT_BASE_RESULTS = (
    ROOT
    / "output"
    / "finlab_active_candidate_strategy_compare"
    / "active11_candidate12_sii_otc_20200101_20260615_base_finlab_results.csv"
)

S2_ID = "stock_tech_s02_52w_dual_momentum_v1"
TREND_FOLLOWING_ID = "trend_following_seed_v1"
BREAKOUT_VOL_ID = "breakout_vol_expansion_seed_v1"
TREND_BUCKETS = {"trend_following", "breakout_vol_expansion"}


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


def _safe_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _slice(frame: pd.DataFrame, start: str, end: str) -> pd.DataFrame:
    return frame.loc[pd.Timestamp(start) : pd.Timestamp(end)].copy()


def _turnover(weights: pd.DataFrame) -> pd.Series:
    return weights.diff().abs().sum(axis=1).fillna(weights.abs().sum(axis=1)) / 2.0


def _cagr(returns: pd.Series) -> float:
    clean = returns.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    if clean.empty:
        return 0.0
    total = float((1.0 + clean).prod())
    if total <= 0:
        return -1.0
    years = max(len(clean) / 252.0, 1e-9)
    return float(total ** (1.0 / years) - 1.0)


def _sharpe(returns: pd.Series) -> float:
    clean = returns.replace([np.inf, -np.inf], np.nan).dropna()
    if clean.empty:
        return 0.0
    std = float(clean.std(ddof=0))
    if std <= 1e-12:
        return 0.0
    return float(clean.mean() / std * np.sqrt(252))


def _max_drawdown(returns: pd.Series) -> float:
    clean = returns.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    if clean.empty:
        return 0.0
    equity = (1.0 + clean).cumprod()
    return float((equity / equity.cummax() - 1.0).min())


def _monthly_worst(returns: pd.Series) -> float | None:
    clean = returns.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    if clean.empty:
        return None
    monthly = (1.0 + clean).resample("ME").prod() - 1.0
    return _safe_float(monthly.min())


def _monthly_hit_rate(returns: pd.Series) -> float | None:
    clean = returns.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    if clean.empty:
        return None
    monthly = (1.0 + clean).resample("ME").prod() - 1.0
    return _safe_float((monthly > 0).mean()) if not monthly.empty else None


def _scenario_union_position(
    strategy_ids: list[str],
    positions: dict[str, pd.DataFrame],
    close: pd.DataFrame,
) -> pd.DataFrame:
    union = pd.DataFrame(False, index=close.index, columns=close.columns)
    for sid in strategy_ids:
        pos = positions[sid].reindex(index=close.index, columns=close.columns).fillna(False).astype(bool)
        union = union | pos
    return union


def _scenario_weights(
    strategy_ids: list[str],
    positions: dict[str, pd.DataFrame],
    close: pd.DataFrame,
) -> pd.DataFrame:
    weights = pd.DataFrame(0.0, index=close.index, columns=close.columns)
    sleeve_count = max(len(strategy_ids), 1)
    for sid in strategy_ids:
        pos = positions[sid].reindex(index=close.index, columns=close.columns).fillna(False).astype(float)
        counts = pos.sum(axis=1).replace(0, np.nan)
        sleeve_weights = pos.div(counts, axis=0).fillna(0.0)
        weights = weights + sleeve_weights / sleeve_count
    return weights


def _portfolio_returns(weights: pd.DataFrame, close: pd.DataFrame, fee_tax_cost: float) -> pd.Series:
    daily_ret = close.reindex(index=weights.index, columns=weights.columns).pct_change(fill_method=None).fillna(0.0)
    held = weights.shift(1).fillna(0.0)
    gross = (held * daily_ret).sum(axis=1)
    return gross - _turnover(weights) * fee_tax_cost


def _effective_positions(weights: pd.DataFrame) -> pd.Series:
    sq = (weights * weights).sum(axis=1).replace(0, np.nan)
    return (1.0 / sq).replace([np.inf, -np.inf], np.nan)


def _position_overlap(left: pd.DataFrame, right: pd.DataFrame) -> dict[str, Any]:
    left = left.fillna(False).astype(bool)
    right = right.reindex(index=left.index, columns=left.columns).fillna(False).astype(bool)
    left_latest = set(left.columns[left.iloc[-1].to_numpy(dtype=bool)])
    right_latest = set(right.columns[right.iloc[-1].to_numpy(dtype=bool)])
    latest_union = left_latest | right_latest
    latest_inter = left_latest & right_latest
    left_flat = left.to_numpy(dtype=bool).reshape(-1)
    right_flat = right.to_numpy(dtype=bool).reshape(-1)
    flat_union = int(np.logical_or(left_flat, right_flat).sum())
    flat_inter = int(np.logical_and(left_flat, right_flat).sum())
    try:
        phi = float(np.corrcoef(left_flat.astype(float), right_flat.astype(float))[0, 1])
    except Exception:
        phi = float("nan")
    return {
        "latest_jaccard": len(latest_inter) / len(latest_union) if latest_union else None,
        "all_period_jaccard": flat_inter / flat_union if flat_union else None,
        "position_phi_corr": _safe_float(phi),
        "latest_intersection_count": len(latest_inter),
        "latest_union_count": len(latest_union),
        "all_period_intersection_cells": flat_inter,
        "all_period_union_cells": flat_union,
    }


def _metrics_for_scenario(
    scenario_id: str,
    strategy_ids: list[str],
    positions: dict[str, pd.DataFrame],
    close_all: pd.DataFrame,
    *,
    start: str,
    end: str,
    fee_tax_cost: float,
    baseline_union: pd.DataFrame | None,
    baseline_returns: pd.Series | None,
    removed_id: str | None,
) -> dict[str, Any]:
    close = _slice(close_all, start, end)
    sliced_positions = {
        sid: _slice(positions[sid], start, end).reindex(index=close.index, columns=close.columns).fillna(False).astype(bool)
        for sid in strategy_ids
    }
    weights = _scenario_weights(strategy_ids, sliced_positions, close)
    union = _scenario_union_position(strategy_ids, sliced_positions, close)
    returns = _portfolio_returns(weights, close, fee_tax_cost)
    counts = union.sum(axis=1)
    overlap = _position_overlap(union, baseline_union.loc[close.index] if baseline_union is not None else union)
    joined = pd.concat([returns, baseline_returns.reindex(returns.index) if baseline_returns is not None else returns], axis=1).dropna()
    return_corr = _safe_float(joined.iloc[:, 0].corr(joined.iloc[:, 1])) if len(joined) > 2 else None
    return {
        "scenario_id": scenario_id,
        "period_start": start,
        "period_end": end,
        "removed_id": removed_id,
        "added_id": S2_ID if removed_id else None,
        "strategy_count": len(strategy_ids),
        "portfolio_cagr": _cagr(returns),
        "portfolio_sharpe": _sharpe(returns),
        "portfolio_MOD": _max_drawdown(returns),
        "portfolio_total_return": float((1.0 + returns.fillna(0.0)).prod() - 1.0),
        "worst_month": _monthly_worst(returns),
        "monthly_hit_rate": _monthly_hit_rate(returns),
        "avg_daily_turnover": _safe_float(_turnover(weights).mean()),
        "avg_gross_exposure": _safe_float(weights.sum(axis=1).mean()),
        "latest_gross_exposure": _safe_float(weights.sum(axis=1).iloc[-1]) if len(weights) else None,
        "avg_unique_positions": _safe_float(counts.mean()),
        "latest_unique_positions": int(counts.iloc[-1]) if len(counts) else 0,
        "avg_effective_positions": _safe_float(_effective_positions(weights).mean()),
        "baseline_return_corr": return_corr,
        "baseline_latest_jaccard": overlap["latest_jaccard"],
        "baseline_all_period_jaccard": overlap["all_period_jaccard"],
        "baseline_position_phi_corr": overlap["position_phi_corr"],
    }


def _replace_once(active_ids: list[str], removed_id: str) -> list[str]:
    return sorted([sid for sid in active_ids if sid != removed_id] + [S2_ID])


def _weakest_trend_breakout_owner(base_results: pd.DataFrame, metadata: dict[str, Any]) -> str:
    active_trend_ids = [
        sid
        for sid, meta in metadata.items()
        if meta.group == "active_strategy_spec" and meta.alpha_bucket in TREND_BUCKETS
    ]
    rows = base_results[base_results["strategy_id"].isin(active_trend_ids)].copy()
    rows["cagr"] = pd.to_numeric(rows["cagr"], errors="coerce")
    rows = rows.dropna(subset=["cagr"]).sort_values("cagr", ascending=True)
    if rows.empty:
        raise RuntimeError("weakest_trend_breakout_owner_not_found")
    return str(rows.iloc[0]["strategy_id"])


def _write_markdown(
    path: Path,
    scenario_summary: pd.DataFrame,
    deltas: pd.DataFrame,
    removed_overlap: pd.DataFrame,
    scenario_members: dict[str, list[str]],
) -> None:
    def fmt(value: Any, floatfmt: str = ".4f") -> str:
        if value is None:
            return ""
        if isinstance(value, float):
            if not np.isfinite(value):
                return ""
            return format(value, floatfmt)
        return str(value)

    def markdown_table(df: pd.DataFrame, columns: list[str], floatfmt: str = ".4f") -> str:
        header = "| " + " | ".join(columns) + " |"
        sep = "| " + " | ".join("---" for _ in columns) + " |"
        rows = [
            "| " + " | ".join(fmt(row.get(col), floatfmt) for col in columns) + " |"
            for _, row in df[columns].iterrows()
        ]
        return "\n".join([header, sep, *rows])

    lines = [
        "# S2 Replacement Portfolio Experiment",
        "",
        "Portfolio construction: equal-weight strategy sleeves. Each sleeve equal-weights its selected stocks; scenarios replace one active sleeve with S2 instead of adding S2 as extra exposure.",
        "",
        "## Base Period Summary",
        "",
    ]
    base = scenario_summary[scenario_summary["period_label"] == "base_2023_2026"].copy()
    cols = [
        "scenario_id",
        "removed_id",
        "portfolio_cagr",
        "portfolio_sharpe",
        "portfolio_MOD",
        "avg_daily_turnover",
        "baseline_all_period_jaccard",
        "baseline_return_corr",
        "avg_unique_positions",
        "latest_unique_positions",
    ]
    lines.append(markdown_table(base, cols))
    lines.extend(["", "## Delta vs Baseline", ""])
    delta_cols = [
        "scenario_id",
        "period_label",
        "delta_cagr",
        "delta_sharpe",
        "delta_MOD",
        "delta_avg_daily_turnover",
        "baseline_all_period_jaccard",
        "baseline_return_corr",
    ]
    lines.append(markdown_table(deltas, delta_cols))
    lines.extend(["", "## S2 vs Removed Owner Overlap", ""])
    overlap_cols = [
        "scenario_id",
        "removed_id",
        "s2_vs_removed_return_corr",
        "s2_vs_removed_latest_jaccard",
        "s2_vs_removed_all_period_jaccard",
        "s2_vs_removed_position_phi_corr",
    ]
    lines.append(markdown_table(removed_overlap, overlap_cols))
    lines.extend(["", "## Scenario Members", ""])
    for scenario_id, members in scenario_members.items():
        lines.append(f"### {scenario_id}")
        lines.extend(f"- `{member}`" for member in members)
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def run(args: argparse.Namespace) -> dict[str, Any]:
    started = time.time()
    compare = _load_module(COMPARE_RUNNER, "stockvision_s2_replacement_compare")
    tech = _load_module(TECH_RUNNER, "stockvision_s2_replacement_tech")
    build_args = argparse.Namespace(
        start_date=args.robustness_start_date,
        base_start_date=args.base_start_date,
        robustness_start_date=args.robustness_start_date,
        end_date=args.end_date,
        universe=args.universe,
        max_positions=args.max_positions,
        position_limit=args.position_limit,
        trade_at_price=args.trade_at_price,
        resample=args.resample,
        include_active_specs=True,
        active_spec_json=args.active_spec_json,
        fee_tax_cost=args.fee_tax_cost,
        extra_slippage_bps=args.extra_slippage_bps,
        include_yearly=False,
        base_results_csv=args.base_results_csv,
    )
    positions, metadata, close, active_warnings = compare._build_positions(build_args, tech)
    base_results = pd.read_csv(args.base_results_csv, encoding="utf-8-sig")
    active_ids = sorted([sid for sid, meta in metadata.items() if meta.group == "active_strategy_spec"])
    missing = [sid for sid in active_ids + [S2_ID] if sid not in positions]
    if missing:
        raise RuntimeError(f"missing_positions:{missing}")

    weakest = _weakest_trend_breakout_owner(base_results, metadata)
    scenario_members: dict[str, list[str]] = {
        "baseline_active11": active_ids,
        "replace_trend_following_with_s2": _replace_once(active_ids, TREND_FOLLOWING_ID),
        "replace_breakout_vol_expansion_with_s2": _replace_once(active_ids, BREAKOUT_VOL_ID),
        "replace_weakest_trend_breakout_with_s2": _replace_once(active_ids, weakest),
    }
    removed_by_scenario = {
        "baseline_active11": None,
        "replace_trend_following_with_s2": TREND_FOLLOWING_ID,
        "replace_breakout_vol_expansion_with_s2": BREAKOUT_VOL_ID,
        "replace_weakest_trend_breakout_with_s2": weakest,
    }

    periods = [
        ("base_2023_2026", args.base_start_date, args.end_date, args.fee_tax_cost),
        ("robust_2020_2026", args.robustness_start_date, args.end_date, args.fee_tax_cost),
        ("base_2023_2026_cost_plus_50bps", args.base_start_date, args.end_date, args.fee_tax_cost + 0.005),
    ]
    rows: list[dict[str, Any]] = []
    baseline_cache: dict[tuple[str, str, float], tuple[pd.DataFrame, pd.Series]] = {}
    for period_label, start, end, cost in periods:
        close_slice = _slice(close, start, end)
        baseline_weights = _scenario_weights(scenario_members["baseline_active11"], positions, close_slice)
        baseline_union = _scenario_union_position(scenario_members["baseline_active11"], positions, close_slice)
        baseline_returns = _portfolio_returns(baseline_weights, close_slice, cost)
        baseline_cache[(start, end, cost)] = (baseline_union, baseline_returns)
        for scenario_id, members in scenario_members.items():
            baseline_union, baseline_returns = baseline_cache[(start, end, cost)]
            row = _metrics_for_scenario(
                scenario_id,
                members,
                positions,
                close,
                start=start,
                end=end,
                fee_tax_cost=cost,
                baseline_union=baseline_union,
                baseline_returns=baseline_returns,
                removed_id=removed_by_scenario[scenario_id],
            )
            row["period_label"] = period_label
            row["fee_tax_cost"] = cost
            rows.append(row)
    scenario_summary = pd.DataFrame(rows)

    baseline_by_period = scenario_summary[scenario_summary["scenario_id"] == "baseline_active11"].set_index("period_label")
    deltas = scenario_summary.copy()
    for metric in ("portfolio_cagr", "portfolio_sharpe", "portfolio_MOD", "avg_daily_turnover", "avg_unique_positions"):
        deltas[f"delta_{metric.removeprefix('portfolio_')}"] = deltas.apply(
            lambda row: row[metric] - baseline_by_period.loc[row["period_label"], metric],
            axis=1,
        )
    deltas = deltas.rename(columns={"delta_avg_daily_turnover": "delta_avg_daily_turnover"})

    close_base = _slice(close, args.base_start_date, args.end_date)
    removed_rows: list[dict[str, Any]] = []
    s2_pos = _slice(positions[S2_ID], args.base_start_date, args.end_date).reindex(index=close_base.index, columns=close_base.columns).fillna(False).astype(bool)
    s2_weights = _scenario_weights([S2_ID], {S2_ID: s2_pos}, close_base)
    s2_returns = _portfolio_returns(s2_weights, close_base, args.fee_tax_cost)
    for scenario_id, removed_id in removed_by_scenario.items():
        if not removed_id:
            continue
        removed_pos = _slice(positions[removed_id], args.base_start_date, args.end_date).reindex(index=close_base.index, columns=close_base.columns).fillna(False).astype(bool)
        removed_weights = _scenario_weights([removed_id], {removed_id: removed_pos}, close_base)
        removed_returns = _portfolio_returns(removed_weights, close_base, args.fee_tax_cost)
        overlap = _position_overlap(s2_pos, removed_pos)
        joined = pd.concat([s2_returns, removed_returns], axis=1).dropna()
        removed_rows.append(
            {
                "scenario_id": scenario_id,
                "removed_id": removed_id,
                "removed_name": metadata[removed_id].name,
                "removed_alpha_bucket": metadata[removed_id].alpha_bucket,
                "s2_vs_removed_return_corr": _safe_float(joined.iloc[:, 0].corr(joined.iloc[:, 1])) if len(joined) > 2 else None,
                "s2_vs_removed_latest_jaccard": overlap["latest_jaccard"],
                "s2_vs_removed_all_period_jaccard": overlap["all_period_jaccard"],
                "s2_vs_removed_position_phi_corr": overlap["position_phi_corr"],
            }
        )
    removed_overlap = pd.DataFrame(removed_rows)

    return {
        "schema_version": "stockvision-s2-replacement-portfolio-experiment-v1",
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "allowed_use": "research_only",
        "decision_effect": "none",
        "runtime_seconds": round(time.time() - started, 3),
        "config": vars(args),
        "weakest_trend_breakout_owner": weakest,
        "active_warnings": active_warnings,
        "scenario_members": scenario_members,
        "scenario_summary": scenario_summary,
        "deltas": deltas,
        "removed_overlap": removed_overlap,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Portfolio-level S2 replacement experiment for active trend/breakout owners.")
    parser.add_argument("--base-start-date", default="2023-01-01")
    parser.add_argument("--robustness-start-date", default="2020-01-01")
    parser.add_argument("--end-date", default="2026-06-15")
    parser.add_argument("--universe", choices=["sii", "sii_otc"], default="sii_otc")
    parser.add_argument("--max-positions", type=int, default=10)
    parser.add_argument("--position-limit", type=float, default=0.10)
    parser.add_argument("--trade-at-price", default="open")
    parser.add_argument("--resample", default="D")
    parser.add_argument("--active-spec-json", default=str(DEFAULT_ACTIVE_SPEC_JSON))
    parser.add_argument("--base-results-csv", default=str(DEFAULT_BASE_RESULTS))
    parser.add_argument("--fee-tax-cost", type=float, default=0.004425)
    parser.add_argument("--extra-slippage-bps", type=float, nargs="+", default=[0, 10, 25, 50])
    parser.add_argument("--output-dir", default=str(ROOT / "output" / "finlab_s2_replacement_portfolio_experiment"))
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    report = run(args)
    stem = f"s2_replacement_{args.universe}_{args.robustness_start_date}_{args.end_date}".replace("-", "")
    summary_csv = output_dir / f"{stem}_scenario_summary.csv"
    deltas_csv = output_dir / f"{stem}_deltas.csv"
    removed_overlap_csv = output_dir / f"{stem}_removed_overlap.csv"
    report_md = output_dir / f"{stem}_report.md"
    json_path = output_dir / f"{stem}.json"

    report["scenario_summary"].to_csv(summary_csv, index=False, encoding="utf-8-sig")
    report["deltas"].to_csv(deltas_csv, index=False, encoding="utf-8-sig")
    report["removed_overlap"].to_csv(removed_overlap_csv, index=False, encoding="utf-8-sig")
    _write_markdown(report_md, report["scenario_summary"], report["deltas"], report["removed_overlap"], report["scenario_members"])

    json_payload = {k: v for k, v in report.items() if not isinstance(v, pd.DataFrame)}
    json_payload["outputs"] = {
        "scenario_summary_csv": str(summary_csv),
        "deltas_csv": str(deltas_csv),
        "removed_overlap_csv": str(removed_overlap_csv),
        "report_md": str(report_md),
    }
    json_path.write_text(json.dumps(json_payload, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    summary = {
        "json": str(json_path),
        **json_payload["outputs"],
        "weakest_trend_breakout_owner": report["weakest_trend_breakout_owner"],
        "runtime_seconds": report["runtime_seconds"],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
