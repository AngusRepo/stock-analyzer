from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
TECH_RUNNER = ROOT / "tools" / "finlab_technical_strategy12_backtest.py"
DEFAULT_BASE_RESULTS = (
    ROOT
    / "output"
    / "finlab_technical_strategy12_backtests"
    / "technical_strategy12_sii_otc_20230101_20260615_results.csv"
)
DEFAULT_ACTIVE_SPEC_JSON = ROOT / "output" / "finlab_strategy_backtests" / "current_active_11_strategy_specs.json"

S2_ID = "stock_tech_s02_52w_dual_momentum_v1"
S8_ID = "stock_tech_s08_rsi2_bull_mean_reversion_v1"
S12_ID = "stock_tech_s12_multitimeframe_smc_reclaim_v1"
TREND_BUCKETS = {"trend_following", "breakout_vol_expansion"}


def _json_default(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return None if not np.isfinite(value) else float(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, (pd.Series, pd.DataFrame)):
        return value.to_dict()
    return str(value)


def _safe_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot_load_module:{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _norm_id(strategy_id: str) -> str:
    return str(strategy_id).strip()


def _period_rows(start: str, end: str, include_yearly: bool) -> list[tuple[str, str, str]]:
    rows = [
        ("2020_2022", "2020-01-01", "2022-12-31"),
        ("2023_2026", "2023-01-01", end),
        ("2020_2026", "2020-01-01", end),
    ]
    if include_yearly:
        start_year = pd.Timestamp(start).year
        end_ts = pd.Timestamp(end)
        for year in range(start_year, end_ts.year + 1):
            rows.append((str(year), f"{year}-01-01", min(pd.Timestamp(f"{year}-12-31"), end_ts).strftime("%Y-%m-%d")))
    return rows


def _slice_frame(frame: pd.DataFrame, start: str, end: str) -> pd.DataFrame:
    return frame.loc[pd.Timestamp(start) : pd.Timestamp(end)].copy()


def _position_counts(pos: pd.DataFrame) -> pd.Series:
    return pos.fillna(False).astype(bool).sum(axis=1)


def _turnover(weights: pd.DataFrame) -> pd.Series:
    return weights.diff().abs().sum(axis=1).fillna(weights.abs().sum(axis=1)) / 2.0


def _weights_from_position(pos: pd.DataFrame, exposure: pd.Series | None = None) -> pd.DataFrame:
    weights = pos.fillna(False).astype(float)
    row_sums = weights.sum(axis=1).replace(0, np.nan)
    weights = weights.div(row_sums, axis=0).fillna(0.0)
    if exposure is not None:
        weights = weights.mul(exposure.reindex(weights.index).fillna(1.0), axis=0)
    return weights


def _returns_from_position(
    pos: pd.DataFrame,
    close: pd.DataFrame,
    *,
    fee_tax_cost: float,
    exposure: pd.Series | None = None,
) -> pd.Series:
    aligned_close = close.reindex(index=pos.index, columns=pos.columns)
    daily_ret = aligned_close.pct_change(fill_method=None).fillna(0.0)
    weights = _weights_from_position(pos, exposure)
    held = weights.shift(1).fillna(0.0)
    gross = (held * daily_ret).sum(axis=1)
    return gross - _turnover(weights) * fee_tax_cost


def _max_drawdown(returns: pd.Series) -> float:
    clean = returns.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    if clean.empty:
        return 0.0
    equity = (1.0 + clean).cumprod()
    return float((equity / equity.cummax() - 1.0).min())


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
    if monthly.empty:
        return None
    return _safe_float((monthly > 0).mean())


def _return_metrics(
    strategy_id: str,
    pos: pd.DataFrame,
    close: pd.DataFrame,
    *,
    fee_tax_cost: float,
    exposure: pd.Series | None = None,
) -> dict[str, Any]:
    pos = pos.reindex(index=close.index, columns=close.columns).fillna(False)
    returns = _returns_from_position(pos, close, fee_tax_cost=fee_tax_cost, exposure=exposure)
    counts = _position_counts(pos)
    weights = _weights_from_position(pos, exposure)
    return {
        "strategy_id": strategy_id,
        "proxy_cagr": _cagr(returns),
        "proxy_sharpe": _sharpe(returns),
        "proxy_MOD": _max_drawdown(returns),
        "proxy_total_return": float((1.0 + returns.fillna(0.0)).prod() - 1.0),
        "proxy_worst_month": _monthly_worst(returns),
        "proxy_monthly_hit_rate": _monthly_hit_rate(returns),
        "active_days": int((counts > 0).sum()),
        "avg_positions": _safe_float(counts.mean()),
        "max_positions": int(counts.max()) if len(counts) else 0,
        "latest_positions": int(counts.iloc[-1]) if len(counts) else 0,
        "avg_turnover": _safe_float(_turnover(weights).mean()),
    }


@dataclass(frozen=True)
class StrategyMeta:
    strategy_id: str
    group: str
    status: str
    name: str
    family_id: str
    alpha_bucket: str


def _metadata_from_build(build: Any) -> StrategyMeta:
    return StrategyMeta(
        strategy_id=build.strategy_id,
        group="candidate_stock_tech12",
        status="candidate",
        name=build.name,
        family_id=build.family_id,
        alpha_bucket=build.alpha_bucket,
    )


def _metadata_from_spec(spec: dict[str, Any]) -> StrategyMeta:
    return StrategyMeta(
        strategy_id=str(spec.get("id") or ""),
        group="active_strategy_spec",
        status=str(spec.get("status") or "active"),
        name=str(spec.get("name") or ""),
        family_id=str(spec.get("familyId") or ""),
        alpha_bucket=str(spec.get("alphaBucket") or ""),
    )


def _build_positions(args: argparse.Namespace, tech: Any) -> tuple[dict[str, pd.DataFrame], dict[str, StrategyMeta], pd.DataFrame, list[str]]:
    base = tech._build_base(args)
    features = tech._feature_set(base)
    close = base["close"]
    columns = list(close.columns)
    positions: dict[str, pd.DataFrame] = {}
    metadata: dict[str, StrategyMeta] = {}

    for build in tech._build_strategies(base, features):
        pos = tech._rebalance_positions(build, columns, args.max_positions) if build.monthly_rebalance else tech._event_positions(build, columns, args.max_positions)
        positions[build.strategy_id] = pos.reindex(index=close.index, columns=columns).fillna(False).astype(bool)
        metadata[build.strategy_id] = _metadata_from_build(build)

    active_positions, active_specs, active_warnings = tech._active_spec_positions(base, args)
    for spec in active_specs:
        sid = str(spec.get("id") or "")
        if not sid or sid not in active_positions:
            continue
        positions[sid] = active_positions[sid].reindex(index=close.index, columns=columns).fillna(False).astype(bool)
        metadata[sid] = _metadata_from_spec(spec)

    metadata[S12_ID] = StrategyMeta(
        strategy_id=S12_ID,
        group="candidate_stock_tech12",
        status="candidate",
        name="S12 multi-timeframe SMC reclaim",
        family_id="SMC_STRUCTURE_RECLAIM",
        alpha_bucket="breakout_vol_expansion",
    )
    return positions, metadata, close, active_warnings


def _load_base_finlab_results(path: Path, metadata: dict[str, StrategyMeta]) -> pd.DataFrame:
    if not path.exists():
        rows = []
        for meta in metadata.values():
            rows.append(
                {
                    "strategy_id": meta.strategy_id,
                    "strategy_group": meta.group,
                    "name": meta.name,
                    "family_id": meta.family_id,
                    "alpha_bucket": meta.alpha_bucket,
                    "status": "missing_base_finlab_result",
                }
            )
        return pd.DataFrame(rows)
    rows = pd.read_csv(path, encoding="utf-8-sig")
    rows["strategy_id"] = rows["strategy_id"].astype(str)
    return rows


def _period_metrics(
    positions: dict[str, pd.DataFrame],
    metadata: dict[str, StrategyMeta],
    close: pd.DataFrame,
    args: argparse.Namespace,
) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for label, start, end in _period_rows(args.robustness_start_date, args.end_date, args.include_yearly):
        close_slice = _slice_frame(close, start, end)
        for sid, pos in positions.items():
            meta = metadata[sid]
            pos_slice = _slice_frame(pos, start, end).reindex(index=close_slice.index, columns=close_slice.columns).fillna(False)
            row = _return_metrics(sid, pos_slice, close_slice, fee_tax_cost=args.fee_tax_cost)
            rows.append(
                {
                    "period": label,
                    "start_date": start,
                    "end_date": end,
                    "group": meta.group,
                    "status": meta.status,
                    "name": meta.name,
                    "family_id": meta.family_id,
                    "alpha_bucket": meta.alpha_bucket,
                    **row,
                }
            )
    rows.append(
        {
            "period": "daily_proxy_unsupported",
            "start_date": args.robustness_start_date,
            "end_date": args.end_date,
            "group": metadata[S12_ID].group,
            "status": metadata[S12_ID].status,
            "strategy_id": S12_ID,
            "name": metadata[S12_ID].name,
            "family_id": metadata[S12_ID].family_id,
            "alpha_bucket": metadata[S12_ID].alpha_bucket,
            "reason": "requires_intraday_15m_1h_4h_replay",
        }
    )
    return pd.DataFrame(rows)


def _cost_stress(
    positions: dict[str, pd.DataFrame],
    metadata: dict[str, StrategyMeta],
    close: pd.DataFrame,
    args: argparse.Namespace,
) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    close_slice = _slice_frame(close, args.base_start_date, args.end_date)
    for bps in args.extra_slippage_bps:
        cost = args.fee_tax_cost + bps / 10000.0
        for sid, pos in positions.items():
            meta = metadata[sid]
            pos_slice = _slice_frame(pos, args.base_start_date, args.end_date).reindex(index=close_slice.index, columns=close_slice.columns).fillna(False)
            rows.append(
                {
                    "extra_slippage_bps": bps,
                    "total_proxy_turnover_cost": cost,
                    "group": meta.group,
                    "status": meta.status,
                    "name": meta.name,
                    "family_id": meta.family_id,
                    "alpha_bucket": meta.alpha_bucket,
                    **_return_metrics(sid, pos_slice, close_slice, fee_tax_cost=cost),
                }
            )
    return pd.DataFrame(rows)


def _pairwise(
    positions: dict[str, pd.DataFrame],
    metadata: dict[str, StrategyMeta],
    close: pd.DataFrame,
    args: argparse.Namespace,
    tech: Any,
) -> pd.DataFrame:
    start, end = args.base_start_date, args.end_date
    close_slice = _slice_frame(close, start, end)
    pos_slice = {
        sid: _slice_frame(pos, start, end).reindex(index=close_slice.index, columns=close_slice.columns).fillna(False).astype(bool)
        for sid, pos in positions.items()
    }
    returns = {
        sid: _returns_from_position(pos, close_slice, fee_tax_cost=args.fee_tax_cost)
        for sid, pos in pos_slice.items()
    }
    rows = tech._pairwise(pos_slice, returns)
    for row in rows:
        left = metadata[row["left_id"]]
        right = metadata[row["right_id"]]
        row["left_group"] = left.group
        row["right_group"] = right.group
        row["left_alpha_bucket"] = left.alpha_bucket
        row["right_alpha_bucket"] = right.alpha_bucket
        row["left_family_id"] = left.family_id
        row["right_family_id"] = right.family_id
    return pd.DataFrame(rows)


def _base_metric_map(base_results: pd.DataFrame) -> dict[str, dict[str, Any]]:
    return {
        _norm_id(row["strategy_id"]): row.to_dict()
        for _, row in base_results.iterrows()
        if str(row.get("strategy_id", "")).strip()
    }


def _s2_focus(
    metadata: dict[str, StrategyMeta],
    base_results: pd.DataFrame,
    pairwise: pd.DataFrame,
    period_metrics: pd.DataFrame,
    cost_stress: pd.DataFrame,
) -> pd.DataFrame:
    base = _base_metric_map(base_results)
    trend_owner_ids = [
        sid
        for sid, meta in metadata.items()
        if meta.group == "active_strategy_spec" and meta.alpha_bucket in TREND_BUCKETS
    ]
    rows: list[dict[str, Any]] = []
    for active_id in sorted(trend_owner_ids):
        pair = pairwise[
            ((pairwise["left_id"] == S2_ID) & (pairwise["right_id"] == active_id))
            | ((pairwise["left_id"] == active_id) & (pairwise["right_id"] == S2_ID))
        ]
        pair_row = pair.iloc[0].to_dict() if not pair.empty else {}
        active_base = base.get(active_id, {})
        s2_base = base.get(S2_ID, {})
        active_full = period_metrics[(period_metrics["period"] == "2020_2026") & (period_metrics["strategy_id"] == active_id)]
        s2_full = period_metrics[(period_metrics["period"] == "2020_2026") & (period_metrics["strategy_id"] == S2_ID)]
        active_50 = cost_stress[(cost_stress["strategy_id"] == active_id) & (cost_stress["extra_slippage_bps"] == 50)]
        s2_50 = cost_stress[(cost_stress["strategy_id"] == S2_ID) & (cost_stress["extra_slippage_bps"] == 50)]
        rows.append(
            {
                "candidate_id": S2_ID,
                "active_owner_id": active_id,
                "active_owner_name": metadata[active_id].name,
                "active_owner_bucket": metadata[active_id].alpha_bucket,
                "active_owner_family": metadata[active_id].family_id,
                "return_corr": pair_row.get("return_corr"),
                "latest_jaccard": pair_row.get("latest_jaccard"),
                "all_period_jaccard": pair_row.get("all_period_jaccard"),
                "position_phi_corr": pair_row.get("position_phi_corr"),
                "s2_finlab_cagr": s2_base.get("cagr"),
                "active_finlab_cagr": active_base.get("cagr"),
                "delta_finlab_cagr": _safe_float(s2_base.get("cagr")) - _safe_float(active_base.get("cagr")) if _safe_float(s2_base.get("cagr")) is not None and _safe_float(active_base.get("cagr")) is not None else None,
                "s2_finlab_sharpe": s2_base.get("monthly_sharpe"),
                "active_finlab_sharpe": active_base.get("monthly_sharpe"),
                "s2_finlab_MOD": s2_base.get("MOD"),
                "active_finlab_MOD": active_base.get("MOD"),
                "s2_proxy_2020_2026_cagr": s2_full["proxy_cagr"].iloc[0] if not s2_full.empty else None,
                "active_proxy_2020_2026_cagr": active_full["proxy_cagr"].iloc[0] if not active_full.empty else None,
                "s2_cost50_proxy_cagr": s2_50["proxy_cagr"].iloc[0] if not s2_50.empty else None,
                "active_cost50_proxy_cagr": active_50["proxy_cagr"].iloc[0] if not active_50.empty else None,
            }
        )
    return pd.DataFrame(rows)


def _s8_inverse_filter(
    positions: dict[str, pd.DataFrame],
    metadata: dict[str, StrategyMeta],
    close: pd.DataFrame,
    args: argparse.Namespace,
) -> pd.DataFrame:
    if S8_ID not in positions:
        return pd.DataFrame()
    rows: list[dict[str, Any]] = []
    close_slice = _slice_frame(close, args.base_start_date, args.end_date)
    s8_pos = _slice_frame(positions[S8_ID], args.base_start_date, args.end_date).reindex(index=close_slice.index, columns=close_slice.columns).fillna(False).astype(bool)
    s8_returns = _returns_from_position(s8_pos, close_slice, fee_tax_cost=args.fee_tax_cost)
    inverse_returns = -s8_returns
    rows.append(
        {
            "test_type": "inverse_position_proxy",
            "target_strategy_id": S8_ID,
            "target_name": metadata[S8_ID].name,
            "base_strategy_id": S8_ID,
            "proxy_cagr": _cagr(inverse_returns),
            "proxy_sharpe": _sharpe(inverse_returns),
            "proxy_MOD": _max_drawdown(inverse_returns),
            "proxy_total_return": float((1.0 + inverse_returns.fillna(0.0)).prod() - 1.0),
            "note": "Return sign inversion only; not a real shorting or borrow-cost simulation.",
        }
    )
    s8_any = (_position_counts(s8_pos) > 0).astype(float)
    risk_off_exposure = pd.Series(np.where(s8_any > 0, 0.5, 1.0), index=s8_any.index)
    targets = [
        sid
        for sid, meta in metadata.items()
        if sid in positions and (meta.group == "active_strategy_spec" and meta.alpha_bucket in TREND_BUCKETS)
        or sid in {
            "stock_tech_s01_55d_trend_volume_breakout_v1",
            S2_ID,
            "stock_tech_s04_ma_deduct_turn_breakout_v1",
            "stock_tech_s06_nr7_inside_bar_breakout_v1",
            "stock_tech_s11_gap_breakout_continuation_v1",
        }
    ]
    for sid in sorted(set(targets)):
        meta = metadata[sid]
        base_pos = _slice_frame(positions[sid], args.base_start_date, args.end_date).reindex(index=close_slice.index, columns=close_slice.columns).fillna(False).astype(bool)
        base = _return_metrics(sid, base_pos, close_slice, fee_tax_cost=args.fee_tax_cost)
        avoid_pos = base_pos & (~s8_pos)
        avoid = _return_metrics(sid, avoid_pos, close_slice, fee_tax_cost=args.fee_tax_cost)
        risk_off = _return_metrics(sid, base_pos, close_slice, fee_tax_cost=args.fee_tax_cost, exposure=risk_off_exposure)
        rows.append(
            {
                "test_type": "avoid_filter_same_symbol",
                "target_strategy_id": S8_ID,
                "target_name": metadata[S8_ID].name,
                "base_strategy_id": sid,
                "base_strategy_name": meta.name,
                "base_group": meta.group,
                "base_alpha_bucket": meta.alpha_bucket,
                "base_proxy_cagr": base["proxy_cagr"],
                "filtered_proxy_cagr": avoid["proxy_cagr"],
                "delta_proxy_cagr": avoid["proxy_cagr"] - base["proxy_cagr"],
                "base_proxy_sharpe": base["proxy_sharpe"],
                "filtered_proxy_sharpe": avoid["proxy_sharpe"],
                "delta_proxy_sharpe": avoid["proxy_sharpe"] - base["proxy_sharpe"],
                "base_proxy_MOD": base["proxy_MOD"],
                "filtered_proxy_MOD": avoid["proxy_MOD"],
                "delta_proxy_MOD": avoid["proxy_MOD"] - base["proxy_MOD"],
                "removed_position_cells": int(np.logical_and(base_pos.to_numpy(dtype=bool), s8_pos.to_numpy(dtype=bool)).sum()),
            }
        )
        rows.append(
            {
                "test_type": "risk_off_half_exposure_when_s8_any",
                "target_strategy_id": S8_ID,
                "target_name": metadata[S8_ID].name,
                "base_strategy_id": sid,
                "base_strategy_name": meta.name,
                "base_group": meta.group,
                "base_alpha_bucket": meta.alpha_bucket,
                "base_proxy_cagr": base["proxy_cagr"],
                "filtered_proxy_cagr": risk_off["proxy_cagr"],
                "delta_proxy_cagr": risk_off["proxy_cagr"] - base["proxy_cagr"],
                "base_proxy_sharpe": base["proxy_sharpe"],
                "filtered_proxy_sharpe": risk_off["proxy_sharpe"],
                "delta_proxy_sharpe": risk_off["proxy_sharpe"] - base["proxy_sharpe"],
                "base_proxy_MOD": base["proxy_MOD"],
                "filtered_proxy_MOD": risk_off["proxy_MOD"],
                "delta_proxy_MOD": risk_off["proxy_MOD"] - base["proxy_MOD"],
                "s8_any_days": int(s8_any.sum()),
            }
        )
    return pd.DataFrame(rows)


def _max_overlap_for(strategy_id: str, pairwise: pd.DataFrame, metadata: dict[str, StrategyMeta]) -> dict[str, Any]:
    pairs = pairwise[(pairwise["left_id"] == strategy_id) | (pairwise["right_id"] == strategy_id)].copy()
    if pairs.empty:
        return {}
    pairs["other_id"] = np.where(pairs["left_id"] == strategy_id, pairs["right_id"], pairs["left_id"])
    pairs["other_group"] = pairs["other_id"].map(lambda sid: metadata.get(str(sid), StrategyMeta(str(sid), "", "", "", "", "")).group)
    active_pairs = pairs[pairs["other_group"] == "active_strategy_spec"].copy()
    if active_pairs.empty:
        return {}
    for col in ("return_corr", "all_period_jaccard", "latest_jaccard"):
        active_pairs[col] = pd.to_numeric(active_pairs[col], errors="coerce")
    best_corr = active_pairs.sort_values("return_corr", ascending=False).head(1)
    best_jaccard = active_pairs.sort_values("all_period_jaccard", ascending=False).head(1)
    return {
        "max_active_return_corr_id": best_corr["other_id"].iloc[0] if not best_corr.empty else None,
        "max_active_return_corr": best_corr["return_corr"].iloc[0] if not best_corr.empty else None,
        "max_active_all_period_jaccard_id": best_jaccard["other_id"].iloc[0] if not best_jaccard.empty else None,
        "max_active_all_period_jaccard": best_jaccard["all_period_jaccard"].iloc[0] if not best_jaccard.empty else None,
    }


def _decision_table(
    metadata: dict[str, StrategyMeta],
    base_results: pd.DataFrame,
    pairwise: pd.DataFrame,
    period_metrics: pd.DataFrame,
    s8_tests: pd.DataFrame,
) -> pd.DataFrame:
    base = _base_metric_map(base_results)
    rows: list[dict[str, Any]] = []
    for sid, meta in sorted(metadata.items()):
        base_row = base.get(sid, {})
        full = period_metrics[(period_metrics["period"] == "2020_2026") & (period_metrics["strategy_id"] == sid)]
        proxy_cagr = full["proxy_cagr"].iloc[0] if not full.empty and "proxy_cagr" in full else None
        proxy_sharpe = full["proxy_sharpe"].iloc[0] if not full.empty and "proxy_sharpe" in full else None
        overlap = _max_overlap_for(sid, pairwise, metadata)
        action = "monitor"
        rationale = "current_active_owner"
        if sid == S12_ID:
            action = "intraday_required"
            rationale = "daily_ohlcv_not_valid_proxy"
        elif sid == S8_ID:
            inverse = s8_tests[s8_tests["test_type"] == "inverse_position_proxy"]
            inv_cagr = inverse["proxy_cagr"].iloc[0] if not inverse.empty else None
            action = "test_as_inverse_or_filter" if inv_cagr is not None and inv_cagr > 0 else "reject_or_filter_only"
            rationale = "base_long_negative; inverse/filter_test_required"
        elif meta.group == "candidate_stock_tech12":
            finlab_cagr = _safe_float(base_row.get("cagr"))
            finlab_sharpe = _safe_float(base_row.get("monthly_sharpe"))
            finlab_mod = _safe_float(base_row.get("MOD"))
            max_active_jaccard = _safe_float(overlap.get("max_active_all_period_jaccard"))
            high_overlap = max_active_jaccard is not None and max_active_jaccard >= 0.02
            if sid == S2_ID:
                action = "compare_before_replace"
                rationale = "strong_performance_but_high_active_trend_overlap"
            elif finlab_cagr is not None and finlab_sharpe is not None and finlab_mod is not None and proxy_cagr is not None and finlab_cagr >= 0.20 and finlab_sharpe >= 0.75 and finlab_mod >= -0.35 and proxy_cagr > 0 and not high_overlap:
                action = "materialized_score_priority"
                rationale = "strong_base_metrics_and_not_highly_redundant"
            elif finlab_cagr is not None and finlab_cagr > 0 and finlab_sharpe is not None and finlab_sharpe > 0 and proxy_cagr is not None and proxy_cagr > 0:
                action = "keep_candidate_more_evidence"
                rationale = "positive_but_needs_robustness_or_uniqueness"
            else:
                action = "reject_or_filter_only"
                rationale = "weak_or_negative_daily_proxy"
        rows.append(
            {
                "strategy_id": sid,
                "name": meta.name,
                "group": meta.group,
                "status": meta.status,
                "alpha_bucket": meta.alpha_bucket,
                "family_id": meta.family_id,
                "base_status": base_row.get("status"),
                "base_finlab_cagr": base_row.get("cagr"),
                "base_finlab_sharpe": base_row.get("monthly_sharpe"),
                "base_finlab_MOD": base_row.get("MOD"),
                "proxy_2020_2026_cagr": proxy_cagr,
                "proxy_2020_2026_sharpe": proxy_sharpe,
                **overlap,
                "recommended_action": action,
                "rationale": rationale,
            }
        )
    return pd.DataFrame(rows)


def run(args: argparse.Namespace) -> dict[str, Any]:
    started = time.time()
    if not hasattr(args, "start_date"):
        args.start_date = args.robustness_start_date
    tech = _load_module(TECH_RUNNER, "stockvision_finlab_technical_strategy12_compare_imported")
    positions, metadata, close, active_warnings = _build_positions(args, tech)
    base_results = _load_base_finlab_results(Path(args.base_results_csv), metadata)
    period_metrics = _period_metrics(positions, metadata, close, args)
    cost_stress = _cost_stress(positions, metadata, close, args)
    pairwise = _pairwise(positions, metadata, close, args, tech)
    s8_tests = _s8_inverse_filter(positions, metadata, close, args)
    s2_focus = _s2_focus(metadata, base_results, pairwise, period_metrics, cost_stress)
    decisions = _decision_table(metadata, base_results, pairwise, period_metrics, s8_tests)
    return {
        "schema_version": "stockvision-active-candidate-strategy-compare-v1",
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "allowed_use": "research_only",
        "decision_effect": "none",
        "config": {
            "base_start_date": args.base_start_date,
            "robustness_start_date": args.robustness_start_date,
            "end_date": args.end_date,
            "universe": args.universe,
            "fee_tax_cost": args.fee_tax_cost,
            "extra_slippage_bps": args.extra_slippage_bps,
            "active_spec_json": str(Path(args.active_spec_json)),
            "base_results_csv": str(Path(args.base_results_csv)),
            "legacy_retired_included": False,
        },
        "counts": {
            "active_strategy_spec": sum(1 for meta in metadata.values() if meta.group == "active_strategy_spec"),
            "candidate_stock_tech12": sum(1 for meta in metadata.values() if meta.group == "candidate_stock_tech12"),
            "daily_backtestable_positions": len(positions),
        },
        "active_warnings": active_warnings,
        "tables": {
            "base_results": base_results,
            "period_metrics": period_metrics,
            "cost_stress": cost_stress,
            "pairwise": pairwise,
            "s2_focus": s2_focus,
            "s8_tests": s8_tests,
            "decision_table": decisions,
        },
        "runtime_seconds": round(time.time() - started, 3),
    }


def _write_table(df: pd.DataFrame, path: Path) -> str:
    df.to_csv(path, index=False, encoding="utf-8-sig")
    return str(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare current active 11 StrategySpecs against stock technical candidate 12.")
    parser.add_argument("--base-start-date", default="2023-01-01")
    parser.add_argument("--robustness-start-date", default="2020-01-01")
    parser.add_argument("--end-date", default="2026-06-15")
    parser.add_argument("--universe", choices=["sii", "sii_otc"], default="sii_otc")
    parser.add_argument("--max-positions", type=int, default=10)
    parser.add_argument("--position-limit", type=float, default=0.10)
    parser.add_argument("--trade-at-price", default="open")
    parser.add_argument("--resample", default="D")
    parser.add_argument("--include-active-specs", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--active-spec-json", default=str(DEFAULT_ACTIVE_SPEC_JSON))
    parser.add_argument("--base-results-csv", default=str(DEFAULT_BASE_RESULTS))
    parser.add_argument("--fee-tax-cost", type=float, default=0.004425)
    parser.add_argument("--extra-slippage-bps", type=float, nargs="+", default=[0, 10, 25, 50])
    parser.add_argument("--include-yearly", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--output-dir", default=str(ROOT / "output" / "finlab_active_candidate_strategy_compare"))
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    report = run(args)
    stem = f"active11_candidate12_{args.universe}_{args.robustness_start_date}_{args.end_date}".replace("-", "")

    tables = report.pop("tables")
    paths = {
        "base_results_csv": _write_table(tables["base_results"], output_dir / f"{stem}_base_finlab_results.csv"),
        "period_metrics_csv": _write_table(tables["period_metrics"], output_dir / f"{stem}_period_metrics.csv"),
        "cost_stress_csv": _write_table(tables["cost_stress"], output_dir / f"{stem}_cost_stress.csv"),
        "pairwise_csv": _write_table(tables["pairwise"], output_dir / f"{stem}_pairwise.csv"),
        "s2_focus_csv": _write_table(tables["s2_focus"], output_dir / f"{stem}_s2_focus.csv"),
        "s8_tests_csv": _write_table(tables["s8_tests"], output_dir / f"{stem}_s8_inverse_filter.csv"),
        "decision_table_csv": _write_table(tables["decision_table"], output_dir / f"{stem}_decision_table.csv"),
    }
    report["outputs"] = paths
    json_path = output_dir / f"{stem}.json"
    summary_path = output_dir / f"{stem}_summary.json"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    summary = {
        "json": str(json_path),
        **paths,
        "counts": report["counts"],
        "runtime_seconds": report["runtime_seconds"],
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
