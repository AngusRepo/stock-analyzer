from __future__ import annotations

import argparse
import csv
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
ALPHA223_RUNNER = ROOT / "tools" / "finlab_alpha223_recursive_search.py"
DEFAULT_ALPHA223_JSON = (
    ROOT
    / "output"
    / "finlab_alpha223_recursive_search"
    / "alpha223_recursive_sii_20230101_20260615_seed42.json"
)
DEFAULT_OUTPUT_DIR = ROOT / "output" / "finlab_alpha223_robustness_oos_cost"

DEFAULT_CANDIDATES = [
    "pymoo_nsga3_novelty_0258",
    "pymoo_nsga3_novelty_0166",
    "pymoo_nsga3_novelty_0248",
    "pymoo_nsga3_novelty_0181",
    "pymoo_nsga3_novelty_0109",
]

DEFAULT_REMOVE_TARGETS = [
    "stock_tech_s11_gap_breakout_continuation_v1",
    "finlab_ai_skill_broker_accumulation_reclaim_v1",
    "breakout_vol_expansion_seed_v1",
    "stock_tech_s06_nr7_inside_bar_breakout_v1",
]


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot_load_module:{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


alpha223 = _load_module(ALPHA223_RUNNER, "stockvision_alpha223_robustness_runner")
miner = alpha223.miner
compare = alpha223.compare


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
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if math.isfinite(parsed) else default


def _progress(message: str) -> None:
    print(f"[alpha223-robust] {message}", file=sys.stderr, flush=True)


def _slice(frame: pd.DataFrame, start: str, end: str) -> pd.DataFrame:
    return frame.loc[pd.Timestamp(start) : pd.Timestamp(end)].copy()


def _turnover(weights: pd.DataFrame) -> pd.Series:
    return weights.diff().abs().sum(axis=1).fillna(weights.abs().sum(axis=1)) / 2.0


def _weights_from_position(pos: pd.DataFrame) -> pd.DataFrame:
    weights = pos.fillna(False).astype(float)
    counts = weights.sum(axis=1).replace(0, np.nan)
    return weights.div(counts, axis=0).fillna(0.0)


def _returns_from_position(pos: pd.DataFrame, close: pd.DataFrame, fee_tax_cost: float) -> pd.Series:
    aligned = close.reindex(index=pos.index, columns=pos.columns)
    daily_ret = aligned.pct_change(fill_method=None).fillna(0.0)
    weights = _weights_from_position(pos)
    gross = (weights.shift(1).fillna(0.0) * daily_ret).sum(axis=1)
    return gross - _turnover(weights) * fee_tax_cost


def _scenario_weights(strategy_ids: list[str], positions: dict[str, pd.DataFrame], close: pd.DataFrame) -> pd.DataFrame:
    weights = pd.DataFrame(0.0, index=close.index, columns=close.columns)
    sleeve_count = max(len(strategy_ids), 1)
    for sid in strategy_ids:
        pos = positions[sid].reindex(index=close.index, columns=close.columns).fillna(False).astype(float)
        counts = pos.sum(axis=1).replace(0, np.nan)
        weights = weights + pos.div(counts, axis=0).fillna(0.0) / sleeve_count
    return weights


def _scenario_union(strategy_ids: list[str], positions: dict[str, pd.DataFrame], close: pd.DataFrame) -> pd.DataFrame:
    union = pd.DataFrame(False, index=close.index, columns=close.columns)
    for sid in strategy_ids:
        union = union | positions[sid].reindex(index=close.index, columns=close.columns).fillna(False).astype(bool)
    return union


def _portfolio_returns(weights: pd.DataFrame, close: pd.DataFrame, fee_tax_cost: float) -> pd.Series:
    daily_ret = close.reindex(index=weights.index, columns=weights.columns).pct_change(fill_method=None).fillna(0.0)
    gross = (weights.shift(1).fillna(0.0) * daily_ret).sum(axis=1)
    return gross - _turnover(weights) * fee_tax_cost


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
    return float(clean.mean() / std * np.sqrt(252.0))


def _max_drawdown(returns: pd.Series) -> float:
    clean = returns.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    if clean.empty:
        return 0.0
    equity = (1.0 + clean).cumprod()
    return float((equity / equity.cummax() - 1.0).min())


def _monthly_hit_rate(returns: pd.Series) -> float | None:
    clean = returns.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    if clean.empty:
        return None
    monthly = (1.0 + clean).resample("ME").prod() - 1.0
    return _safe_float((monthly > 0).mean()) if not monthly.empty else None


def _worst_month(returns: pd.Series) -> float | None:
    clean = returns.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    if clean.empty:
        return None
    monthly = (1.0 + clean).resample("ME").prod() - 1.0
    return _safe_float(monthly.min())


def _metrics(returns: pd.Series) -> dict[str, Any]:
    return {
        "cagr": _cagr(returns),
        "sharpe": _sharpe(returns),
        "max_drawdown": _max_drawdown(returns),
        "total_return": float((1.0 + returns.fillna(0.0)).prod() - 1.0),
        "monthly_hit_rate": _monthly_hit_rate(returns),
        "worst_month": _worst_month(returns),
    }


def _position_stats(pos: pd.DataFrame) -> dict[str, Any]:
    counts = pos.fillna(False).astype(bool).sum(axis=1)
    weights = _weights_from_position(pos)
    return {
        "active_days": int((counts > 0).sum()),
        "avg_positions": _safe_float(counts.mean()),
        "max_positions": int(counts.max()) if len(counts) else 0,
        "latest_positions": int(counts.iloc[-1]) if len(counts) else 0,
        "avg_turnover": _safe_float(_turnover(weights).mean()),
    }


def _cell_jaccard(left: pd.DataFrame, right: pd.DataFrame) -> float:
    l = left.fillna(False).to_numpy(dtype=bool)
    r = right.reindex(index=left.index, columns=left.columns).fillna(False).to_numpy(dtype=bool)
    union = int(np.logical_or(l, r).sum())
    if union == 0:
        return 0.0
    return float(np.logical_and(l, r).sum() / union)


def _latest_jaccard(left: pd.DataFrame, right: pd.DataFrame) -> float:
    if left.empty or right.empty:
        return 0.0
    lset = set(left.columns[left.iloc[-1].to_numpy(dtype=bool)])
    rset = set(right.columns[right.iloc[-1].to_numpy(dtype=bool)])
    union = lset | rset
    return float(len(lset & rset) / len(union)) if union else 0.0


def _effective_positions(weights: pd.DataFrame) -> pd.Series:
    sq = (weights * weights).sum(axis=1).replace(0, np.nan)
    return (1.0 / sq).replace([np.inf, -np.inf], np.nan)


def _candidate_short_id(candidate_id: str) -> str:
    return "alpha223_" + str(candidate_id).split("_")[-1]


def _load_candidate_rows(path: Path, candidate_ids: list[str]) -> dict[str, dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows: dict[str, dict[str, Any]] = {}
    for row in payload.get("rows", []):
        cid = str(row.get("candidate_id") or "")
        if cid in candidate_ids:
            rows[cid] = row
    missing = [cid for cid in candidate_ids if cid not in rows]
    if missing:
        raise RuntimeError(f"missing_alpha223_candidates:{missing}")
    return rows


def _build_alpha223_args(args: argparse.Namespace) -> argparse.Namespace:
    return argparse.Namespace(
        factor_json=args.factor_json,
        feature_registry=args.feature_registry,
        monthly_mining_config=args.monthly_mining_config,
        similarity_contract=args.similarity_contract,
        similarity_pairs=args.similarity_pairs,
        finlab86_csv=args.finlab86_csv,
        active_spec_json=args.active_spec_json,
        base_results_csv=args.base_results_csv,
        start_date=args.start_date,
        end_date=args.end_date,
        train_start=args.start_date,
        train_end="2024-12-31",
        validation_start="2025-01-01",
        validation_end="2025-12-31",
        holdout_start="2026-01-01",
        holdout_end=args.end_date,
        universe=args.universe,
        top_k=args.top_k,
        max_symbols=0,
        min_factors=1,
        max_factors=8,
        fee_tax_cost=args.fee_tax_cost,
        seed=42,
        pbo_folds=8,
        resample=args.resample,
        position_limit=args.position_limit,
        trade_at_price=args.trade_at_price,
        output_dir=Path(args.output_dir),
        min_overlap_symbols=args.min_overlap_symbols,
        min_coverage=args.min_coverage,
        min_rank_std=args.min_rank_std,
        limit_finlab86=0,
        progress_every=10,
    )


def _build_universe(args: argparse.Namespace):
    _progress("building formal137 + FINLAB86 universe")
    alpha_args = _build_alpha223_args(args)
    close, tradable, values, meta, universe_info = alpha223._build_base_universe(alpha_args)
    formal_count = len(values)
    finlab86_rows = alpha223._read_finlab86(Path(args.finlab86_csv), 0)
    finlab86_info = alpha223._materialize_finlab86(
        rows=finlab86_rows,
        close=close,
        tradable=tradable,
        values=values,
        meta=meta,
        args=alpha_args,
    )
    return close, tradable, values, meta, {
        "formal137_mapped": formal_count,
        "finlab86_materialized": finlab86_info["materialized"],
        "combined_mapped": len(values),
        "formal_universe_info": {k: v for k, v in universe_info.items() if k != "factor_meta"},
    }


def _build_positions(
    candidate_rows: dict[str, dict[str, Any]],
    close: pd.DataFrame,
    tradable: pd.DataFrame,
    values: dict[str, pd.DataFrame],
    meta: dict[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, pd.DataFrame], dict[str, dict[str, Any]], dict[str, Any]]:
    alpha_args = _build_alpha223_args(args)
    active_positions, active_info, _active_returns = alpha223._load_active_positions(close, alpha_args)
    stock_tech_positions = _build_stock_tech_positions(close, args)
    positions: dict[str, pd.DataFrame] = {
        sid: pos.reindex(index=close.loc[args.start_date : args.end_date].index, columns=close.columns).fillna(False).astype(bool)
        for sid, pos in active_positions.items()
    }
    for sid, tech_pos in stock_tech_positions.items():
        if sid not in positions:
            continue
        active_days = int(positions[sid].sum(axis=1).gt(0).sum())
        if active_days == 0:
            positions[sid] = tech_pos.reindex(index=close.loc[args.start_date : args.end_date].index, columns=close.columns).fillna(False).astype(bool)
    metadata: dict[str, dict[str, Any]] = {
        sid: {"strategy_id": sid, "group": "active11", "name": sid}
        for sid in active_positions
    }
    for cid, row in candidate_rows.items():
        sid = _candidate_short_id(cid)
        pos = alpha223._position_for_row(
            row,
            values=values,
            meta=meta,
            close=close,
            tradable=tradable,
            args=alpha_args,
        )
        positions[sid] = pos.reindex(index=close.loc[args.start_date : args.end_date].index, columns=close.columns).fillna(False).astype(bool)
        metadata[sid] = {
            "strategy_id": sid,
            "candidate_id": cid,
            "group": "alpha223_candidate",
            "name": sid,
            "factor_ids": row.get("factor_ids"),
            "weights": row.get("weights"),
            "alpha223_score": row.get("alpha223_score"),
            "has_finlab86": row.get("has_finlab86"),
        }
    return positions, metadata, active_info


def _build_stock_tech_positions(close: pd.DataFrame, args: argparse.Namespace) -> dict[str, pd.DataFrame]:
    tech = compare._load_module(compare.TECH_RUNNER, "stockvision_alpha223_robustness_stock_tech")
    ns = argparse.Namespace(
        start_date=args.start_date,
        end_date=args.end_date,
        universe=args.universe,
        max_positions=args.top_k,
        position_limit=args.position_limit,
        trade_at_price=args.trade_at_price,
        resample="D",
        include_active_specs=False,
        active_spec_json=args.active_spec_json,
    )
    base = tech._build_base(ns)
    features = tech._feature_set(base)
    columns = list(close.columns)
    out: dict[str, pd.DataFrame] = {}
    active_stock_tech = set(_read_active_stock_tech_ids(Path(args.active_spec_json)))
    for build in tech._build_strategies(base, features):
        if build.strategy_id not in active_stock_tech:
            continue
        pos = (
            tech._rebalance_positions(build, columns, args.top_k)
            if build.monthly_rebalance
            else tech._event_positions(build, columns, args.top_k)
        )
        out[build.strategy_id] = pos.reindex(index=close.index, columns=columns).fillna(False).astype(bool)
    return out


def _read_active_stock_tech_ids(path: Path) -> list[str]:
    specs = json.loads(path.read_text(encoding="utf-8"))
    return [
        str(spec.get("id") or "")
        for spec in specs
        if str(spec.get("id") or "").startswith("stock_tech_") and str(spec.get("status") or "") == "active"
    ]


def _periods(args: argparse.Namespace) -> list[tuple[str, str, str]]:
    return [
        ("train_2023_2024", args.start_date, "2024-12-31"),
        ("oos_2025_2026", "2025-01-01", args.end_date),
        ("validation_2025", "2025-01-01", "2025-12-31"),
        ("holdout_2026_ytd", "2026-01-01", args.end_date),
        ("full_2023_2026", args.start_date, args.end_date),
        ("year_2023", "2023-01-01", "2023-12-31"),
        ("year_2024", "2024-01-01", "2024-12-31"),
        ("year_2025", "2025-01-01", "2025-12-31"),
        ("year_2026_ytd", "2026-01-01", args.end_date),
    ]


def _single_strategy_period_metrics(
    positions: dict[str, pd.DataFrame],
    metadata: dict[str, dict[str, Any]],
    close: pd.DataFrame,
    args: argparse.Namespace,
) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for label, start, end in _periods(args):
        close_slice = _slice(close, start, end)
        for sid, pos in positions.items():
            pos_slice = _slice(pos, start, end).reindex(index=close_slice.index, columns=close_slice.columns).fillna(False).astype(bool)
            returns = _returns_from_position(pos_slice, close_slice, args.fee_tax_cost)
            rows.append(
                {
                    "period": label,
                    "start_date": start,
                    "end_date": end,
                    **metadata[sid],
                    **_metrics(returns),
                    **_position_stats(pos_slice),
                }
            )
    return pd.DataFrame(rows)


def _cost_stress(
    positions: dict[str, pd.DataFrame],
    metadata: dict[str, dict[str, Any]],
    close: pd.DataFrame,
    args: argparse.Namespace,
) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    close_slice = _slice(close, args.start_date, args.end_date)
    for bps in args.extra_slippage_bps:
        cost = args.fee_tax_cost + float(bps) / 10000.0
        for sid, pos in positions.items():
            pos_slice = _slice(pos, args.start_date, args.end_date).reindex(index=close_slice.index, columns=close_slice.columns).fillna(False).astype(bool)
            returns = _returns_from_position(pos_slice, close_slice, cost)
            rows.append(
                {
                    "extra_slippage_bps": bps,
                    "total_fee_tax_cost": cost,
                    **metadata[sid],
                    **_metrics(returns),
                    **_position_stats(pos_slice),
                }
            )
    return pd.DataFrame(rows)


def _candidate_param_robustness(
    candidate_rows: dict[str, dict[str, Any]],
    close: pd.DataFrame,
    tradable: pd.DataFrame,
    values: dict[str, pd.DataFrame],
    meta: dict[str, Any],
    args: argparse.Namespace,
) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    base_alpha_args = _build_alpha223_args(args)
    close_slice = _slice(close, args.start_date, args.end_date)
    for resample in args.resample_variants:
        for top_k in args.top_k_variants:
            scenario_args = argparse.Namespace(**vars(base_alpha_args))
            scenario_args.resample = resample
            scenario_args.top_k = int(top_k)
            for cid, row in candidate_rows.items():
                sid = _candidate_short_id(cid)
                pos = alpha223._position_for_row(
                    row,
                    values=values,
                    meta=meta,
                    close=close,
                    tradable=tradable,
                    args=scenario_args,
                )
                pos = pos.reindex(index=close_slice.index, columns=close_slice.columns).fillna(False).astype(bool)
                returns = _returns_from_position(pos, close_slice, args.fee_tax_cost)
                rows.append(
                    {
                        "candidate_id": cid,
                        "strategy_id": sid,
                        "resample": resample,
                        "top_k": int(top_k),
                        **_metrics(returns),
                        **_position_stats(pos),
                    }
                )
    return pd.DataFrame(rows)


def _standalone_vs_active_summary(period_metrics: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    full = period_metrics[period_metrics["period"] == "full_2023_2026"].copy()
    for period, group in period_metrics.groupby("period"):
        active = group[group["group"] == "active11"]
        candidates = group[group["group"] == "alpha223_candidate"]
        if active.empty or candidates.empty:
            continue
        active_cagr_median = float(pd.to_numeric(active["cagr"], errors="coerce").median())
        active_sharpe_median = float(pd.to_numeric(active["sharpe"], errors="coerce").median())
        active_mdd_median = float(pd.to_numeric(active["max_drawdown"], errors="coerce").median())
        active_best_cagr = float(pd.to_numeric(active["cagr"], errors="coerce").max())
        active_best_sharpe = float(pd.to_numeric(active["sharpe"], errors="coerce").max())
        for _, cand in candidates.iterrows():
            rows.append(
                {
                    "period": period,
                    "strategy_id": cand["strategy_id"],
                    "candidate_id": cand.get("candidate_id"),
                    "cagr": cand["cagr"],
                    "sharpe": cand["sharpe"],
                    "max_drawdown": cand["max_drawdown"],
                    "delta_vs_active_median_cagr": cand["cagr"] - active_cagr_median,
                    "delta_vs_active_median_sharpe": cand["sharpe"] - active_sharpe_median,
                    "delta_vs_active_median_mdd": cand["max_drawdown"] - active_mdd_median,
                    "beats_active_best_cagr": cand["cagr"] > active_best_cagr,
                    "beats_active_best_sharpe": cand["sharpe"] > active_best_sharpe,
                }
            )
    return pd.DataFrame(rows).sort_values(["period", "delta_vs_active_median_sharpe"], ascending=[True, False])


def _portfolio_scenario_metrics(
    scenario_id: str,
    strategy_ids: list[str],
    positions: dict[str, pd.DataFrame],
    close_all: pd.DataFrame,
    *,
    start: str,
    end: str,
    fee_tax_cost: float,
    baseline_union: pd.DataFrame,
    baseline_returns: pd.Series,
    removed_id: str | None,
    added_id: str | None,
) -> dict[str, Any]:
    close = _slice(close_all, start, end)
    weights = _scenario_weights(strategy_ids, positions, close)
    union = _scenario_union(strategy_ids, positions, close)
    returns = _portfolio_returns(weights, close, fee_tax_cost)
    joined = pd.concat([returns, baseline_returns.reindex(returns.index)], axis=1).dropna()
    return_corr = _safe_float(joined.iloc[:, 0].corr(joined.iloc[:, 1])) if len(joined) > 2 else None
    return {
        "scenario_id": scenario_id,
        "period_start": start,
        "period_end": end,
        "removed_id": removed_id,
        "added_id": added_id,
        "strategy_count": len(strategy_ids),
        **_metrics(returns),
        "avg_daily_turnover": _safe_float(_turnover(weights).mean()),
        "avg_unique_positions": _safe_float(union.sum(axis=1).mean()),
        "latest_unique_positions": int(union.sum(axis=1).iloc[-1]) if len(union) else 0,
        "avg_effective_positions": _safe_float(_effective_positions(weights).mean()),
        "baseline_return_corr": return_corr,
        "baseline_all_period_jaccard": _cell_jaccard(union, baseline_union.loc[close.index]),
        "baseline_latest_jaccard": _latest_jaccard(union, baseline_union.loc[close.index]),
    }


def _portfolio_replacement(
    positions: dict[str, pd.DataFrame],
    metadata: dict[str, dict[str, Any]],
    close: pd.DataFrame,
    args: argparse.Namespace,
) -> pd.DataFrame:
    active_ids = sorted([sid for sid, row in metadata.items() if row["group"] == "active11"])
    candidate_ids = sorted([sid for sid, row in metadata.items() if row["group"] == "alpha223_candidate"])
    rows: list[dict[str, Any]] = []
    periods = [
        ("full_2023_2026", args.start_date, args.end_date, args.fee_tax_cost),
        ("oos_2025_2026", "2025-01-01", args.end_date, args.fee_tax_cost),
        ("full_2023_2026_cost_plus_50bps", args.start_date, args.end_date, args.fee_tax_cost + 0.005),
        ("full_2023_2026_cost_plus_100bps", args.start_date, args.end_date, args.fee_tax_cost + 0.010),
    ]
    for label, start, end, cost in periods:
        close_slice = _slice(close, start, end)
        baseline_weights = _scenario_weights(active_ids, positions, close_slice)
        baseline_union = _scenario_union(active_ids, positions, close_slice)
        baseline_returns = _portfolio_returns(baseline_weights, close_slice, cost)
        base_row = _portfolio_scenario_metrics(
            "baseline_active11",
            active_ids,
            positions,
            close,
            start=start,
            end=end,
            fee_tax_cost=cost,
            baseline_union=baseline_union,
            baseline_returns=baseline_returns,
            removed_id=None,
            added_id=None,
        )
        base_row["period"] = label
        rows.append(base_row)
        for removed_id in args.remove_targets:
            if removed_id not in active_ids:
                continue
            for added_id in candidate_ids:
                members = sorted([sid for sid in active_ids if sid != removed_id] + [added_id])
                row = _portfolio_scenario_metrics(
                    f"replace__{removed_id}__with__{added_id}",
                    members,
                    positions,
                    close,
                    start=start,
                    end=end,
                    fee_tax_cost=cost,
                    baseline_union=baseline_union,
                    baseline_returns=baseline_returns,
                    removed_id=removed_id,
                    added_id=added_id,
                )
                row["period"] = label
                rows.append(row)
    df = pd.DataFrame(rows)
    baseline = df[df["scenario_id"] == "baseline_active11"].set_index("period")
    for col in ["cagr", "sharpe", "max_drawdown", "avg_daily_turnover", "avg_unique_positions", "avg_effective_positions"]:
        df[f"delta_{col}"] = df.apply(lambda row: row[col] - baseline.loc[row["period"], col], axis=1)
    return df


def _replacement_decision_table(portfolio: pd.DataFrame) -> pd.DataFrame:
    full = portfolio[portfolio["period"] == "full_2023_2026"].copy()
    oos = portfolio[portfolio["period"] == "oos_2025_2026"].copy()
    cost50 = portfolio[portfolio["period"] == "full_2023_2026_cost_plus_50bps"].copy()
    cost100 = portfolio[portfolio["period"] == "full_2023_2026_cost_plus_100bps"].copy()
    rows: list[dict[str, Any]] = []
    for _, row in full[full["scenario_id"] != "baseline_active11"].iterrows():
        key = (row["removed_id"], row["added_id"])
        oos_row = oos[(oos["removed_id"] == key[0]) & (oos["added_id"] == key[1])]
        cost50_row = cost50[(cost50["removed_id"] == key[0]) & (cost50["added_id"] == key[1])]
        cost100_row = cost100[(cost100["removed_id"] == key[0]) & (cost100["added_id"] == key[1])]
        oos_d_sharpe = float(oos_row["delta_sharpe"].iloc[0]) if not oos_row.empty else np.nan
        cost50_d_cagr = float(cost50_row["delta_cagr"].iloc[0]) if not cost50_row.empty else np.nan
        cost100_d_cagr = float(cost100_row["delta_cagr"].iloc[0]) if not cost100_row.empty else np.nan
        pass_count = int(row["delta_cagr"] > 0) + int(row["delta_sharpe"] > 0) + int(row["delta_max_drawdown"] >= 0)
        pass_count += int(oos_d_sharpe > 0) + int(cost50_d_cagr > 0) + int(cost100_d_cagr > 0)
        decision = "reject"
        if pass_count >= 5 and row["delta_sharpe"] > 0 and oos_d_sharpe > 0 and cost50_d_cagr > 0:
            decision = "promote_replacement_candidate"
        elif pass_count >= 4 and row["delta_sharpe"] > 0:
            decision = "watchlist_replacement"
        rows.append(
            {
                "removed_id": key[0],
                "added_id": key[1],
                "decision": decision,
                "pass_count_6": pass_count,
                "full_delta_cagr": row["delta_cagr"],
                "full_delta_sharpe": row["delta_sharpe"],
                "full_delta_mdd": row["delta_max_drawdown"],
                "oos_delta_sharpe": oos_d_sharpe,
                "cost50_delta_cagr": cost50_d_cagr,
                "cost100_delta_cagr": cost100_d_cagr,
                "baseline_return_corr": row["baseline_return_corr"],
                "baseline_all_period_jaccard": row["baseline_all_period_jaccard"],
            }
        )
    out = pd.DataFrame(rows)
    return out.sort_values(
        ["decision", "pass_count_6", "full_delta_sharpe", "full_delta_cagr"],
        ascending=[True, False, False, False],
    )


def run(args: argparse.Namespace) -> dict[str, Any]:
    started = time.time()
    candidate_rows = _load_candidate_rows(Path(args.alpha223_json), args.candidate_ids)
    close, tradable, values, meta, universe = _build_universe(args)
    positions, metadata, active_info = _build_positions(candidate_rows, close, tradable, values, meta, args)
    close_slice = _slice(close, args.start_date, args.end_date)
    positions = {
        sid: pos.reindex(index=close_slice.index, columns=close_slice.columns).fillna(False).astype(bool)
        for sid, pos in positions.items()
    }
    period_metrics = _single_strategy_period_metrics(positions, metadata, close_slice, args)
    cost_stress = _cost_stress(positions, metadata, close_slice, args)
    param_robustness = _candidate_param_robustness(candidate_rows, close, tradable, values, meta, args)
    standalone_summary = _standalone_vs_active_summary(period_metrics)
    portfolio = _portfolio_replacement(positions, metadata, close_slice, args)
    replacement_decisions = _replacement_decision_table(portfolio)
    return {
        "schema_version": "stockvision-alpha223-robustness-oos-cost-v1",
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "allowed_use": "research_only",
        "decision_effect": "none",
        "runtime_seconds": round(time.time() - started, 3),
        "config": vars(args),
        "universe": universe,
        "active": active_info,
        "metadata": metadata,
        "tables": {
            "period_metrics": period_metrics,
            "cost_stress": cost_stress,
            "param_robustness": param_robustness,
            "standalone_summary": standalone_summary,
            "portfolio_replacement": portfolio,
            "replacement_decisions": replacement_decisions,
        },
    }


def _write_table(df: pd.DataFrame, path: Path) -> str:
    df.to_csv(path, index=False, encoding="utf-8-sig")
    return str(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Research-only robustness/OOS/cost stress for selected alpha223 strategies.")
    parser.add_argument("--alpha223-json", default=str(DEFAULT_ALPHA223_JSON))
    parser.add_argument("--candidate-ids", nargs="+", default=DEFAULT_CANDIDATES)
    parser.add_argument("--remove-targets", nargs="+", default=DEFAULT_REMOVE_TARGETS)
    parser.add_argument("--factor-json", default=str(ROOT / "worker" / ".tmp-test-run-codex" / "alphabuilders_factors_fresh.json"))
    parser.add_argument("--feature-registry", default=str(ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"))
    parser.add_argument("--monthly-mining-config", default=str(ROOT / "data" / "feature_registry" / "pymoo_monthly_mining_config_v1.json"))
    parser.add_argument("--similarity-contract", default=str(ROOT / "data" / "feature_registry" / "formal137_similarity_contract_v1.json"))
    parser.add_argument("--similarity-pairs", default=str(ROOT / "output" / "feature_universe_triage" / "formal137_pairwise_similarity_long_20260617.csv"))
    parser.add_argument("--finlab86-csv", default=str(ROOT / "output" / "feature_universe_triage" / "finlab701_recommended_keep_candidates.csv"))
    parser.add_argument("--active-spec-json", default=str(ROOT / "output" / "finlab_strategy_backtests" / "current_active_11_strategy_specs.json"))
    parser.add_argument("--base-results-csv", default=str(ROOT / "output" / "finlab_technical_strategy12_backtests" / "technical_strategy12_sii_otc_20230101_20260615_results.csv"))
    parser.add_argument("--start-date", default="2023-01-01")
    parser.add_argument("--end-date", default="2026-06-15")
    parser.add_argument("--universe", choices=["sii", "sii_otc"], default="sii")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--top-k-variants", type=int, nargs="+", default=[5, 10, 15])
    parser.add_argument("--resample", default="M")
    parser.add_argument("--resample-variants", nargs="+", default=["W-FRI", "M", "Q"])
    parser.add_argument("--position-limit", type=float, default=0.10)
    parser.add_argument("--trade-at-price", default="close")
    parser.add_argument("--fee-tax-cost", type=float, default=0.004425)
    parser.add_argument("--extra-slippage-bps", type=float, nargs="+", default=[0, 10, 25, 50, 100])
    parser.add_argument("--min-overlap-symbols", type=int, default=80)
    parser.add_argument("--min-coverage", type=float, default=0.15)
    parser.add_argument("--min-rank-std", type=float, default=0.01)
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    report = run(args)
    stem = f"alpha223_robustness_{args.universe}_{args.start_date}_{args.end_date}".replace("-", "")
    tables = report.pop("tables")
    paths = {
        "period_metrics_csv": _write_table(tables["period_metrics"], output_dir / f"{stem}_period_metrics.csv"),
        "cost_stress_csv": _write_table(tables["cost_stress"], output_dir / f"{stem}_cost_stress.csv"),
        "param_robustness_csv": _write_table(tables["param_robustness"], output_dir / f"{stem}_param_robustness.csv"),
        "standalone_summary_csv": _write_table(tables["standalone_summary"], output_dir / f"{stem}_standalone_summary.csv"),
        "portfolio_replacement_csv": _write_table(tables["portfolio_replacement"], output_dir / f"{stem}_portfolio_replacement.csv"),
        "replacement_decisions_csv": _write_table(tables["replacement_decisions"], output_dir / f"{stem}_replacement_decisions.csv"),
    }
    json_payload = {**report, "outputs": paths}
    json_path = output_dir / f"{stem}.json"
    summary_path = output_dir / f"{stem}_summary.json"
    json_path.write_text(json.dumps(json_payload, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    summary = {
        "json": str(json_path),
        **paths,
        "runtime_seconds": report["runtime_seconds"],
        "universe": report["universe"],
        "active": report["active"],
        "candidate_ids": args.candidate_ids,
        "remove_targets": args.remove_targets,
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
