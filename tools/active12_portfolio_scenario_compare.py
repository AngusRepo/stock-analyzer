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
ROBUSTNESS = ROOT / "tools" / "finlab_alpha223_robustness_oos_cost.py"
DEFAULT_OUT_DIR = ROOT / "output" / "strategy_promotion_preflight" / "portfolio_scenarios"

FUSED_SOURCE_IDS = [
    "alphabuilders_multifactor_revenue_quality_momentum_v1",
    "breakout_vol_expansion_seed_v1",
    "trend_following_seed_v1",
]
BROKER_RECLAIM_ID = "finlab_ai_skill_broker_accumulation_reclaim_v1"
FUSED_ID = "trend_quality_breakout_fused_v1"
S11_ID = "stock_tech_s11_gap_breakout_continuation_v1"
ALPHA_IDS = ["alpha223_0248", "alpha223_0109", "alpha223_0166"]
EXTENSION_ALPHA_IDS = ["alpha223_0285", "alpha223_0283", "alpha223_0009"]
FINAL_EXTENSION_ALPHA_IDS = ["alpha223_0283", "alpha223_0009"]
FINAL_RETIRE_IDS = [*FUSED_SOURCE_IDS, BROKER_RECLAIM_ID, S11_ID]
S_FAMILY_REPLACE_TARGET_IDS = [
    "stock_tech_s04_ma_deduct_turn_breakout_v1",
    "stock_tech_s11_gap_breakout_continuation_v1",
    "defensive_accumulation_seed_v1",
]
EXTENSION_SCENARIO_ID = "Candidate11_noBroker_replace_S04_S11_defensive_with_0285_0283_0009"
FINAL_ACTIVE12_SCENARIO_ID = "FinalActive12_retire_trio_Broker_S11_add_fused_0248_0109_0166_0283_0009"
NEW_IDS = [FUSED_ID, *ALPHA_IDS, *EXTENSION_ALPHA_IDS]

FUSED_TERMS = [
    ("l1_closeAboveMa60Pct", 0.20),
    ("l1_volumeExpansion20", 0.20),
    ("l1_return20d", 0.16),
    ("l1_bbBandwidthPct", 0.14),
    ("l1_monthlyRevenueYoY", 0.16),
    ("l1_monthlyRevenueMoM", 0.14),
]


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot_load_module:{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


robust = _load_module(ROBUSTNESS, "stockvision_active12_portfolio_robustness")


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


def _read_active_ids(path: Path) -> list[str]:
    specs = json.loads(path.read_text(encoding="utf-8-sig"))
    return [
        str(spec.get("id") or "")
        for spec in specs
        if str(spec.get("status") or "") == "active" and spec.get("id")
    ]


def _rank_pct(frame: pd.DataFrame) -> pd.DataFrame:
    return frame.replace([np.inf, -np.inf], np.nan).rank(axis=1, pct=True)


def _value(values: dict[str, pd.DataFrame], factor_id: str, close: pd.DataFrame) -> pd.DataFrame:
    frame = values.get(factor_id)
    if frame is None:
        raise RuntimeError(f"fused_factor_missing:{factor_id}")
    return frame.reindex(index=close.index, columns=close.columns)


def _rebalance_topk(score: pd.DataFrame, top_k: int, resample: str) -> pd.DataFrame:
    ranked = score.rank(axis=1, ascending=False, method="first")
    daily = ranked.le(top_k) & score.notna()
    return robust.alpha223.miner._rebalance_position(daily, resample).fillna(False).astype(bool)


def _build_fused_position(
    *,
    close: pd.DataFrame,
    tradable: pd.DataFrame,
    values: dict[str, pd.DataFrame],
    args: argparse.Namespace,
) -> pd.DataFrame:
    weighted = pd.DataFrame(0.0, index=close.index, columns=close.columns)
    weight_sum = 0.0
    for factor_id, weight in FUSED_TERMS:
        weighted = weighted + _rank_pct(_value(values, factor_id, close)) * float(weight)
        weight_sum += float(weight)
    score = weighted / weight_sum
    revenue_yoy = _value(values, "l1_monthlyRevenueYoY", close)
    macd = _value(values, "l1_macdHist", close)
    squeeze_release = _value(values, "l1_squeezeRelease", close)
    dsl_any = revenue_yoy.ge(0) | macd.ge(0) | squeeze_release.ge(1)
    eligible = score.where(dsl_any & tradable.reindex(index=close.index, columns=close.columns).fillna(False))
    raw = _rebalance_topk(eligible.loc[: args.end_date], args.top_k, args.resample)
    return raw.loc[args.start_date : args.end_date].reindex(
        index=close.loc[args.start_date : args.end_date].index,
        columns=close.columns,
    ).fillna(False).astype(bool)


def _scenario_members(active_ids: list[str]) -> dict[str, list[str]]:
    candidate12 = [sid for sid in active_ids if sid not in set(FUSED_SOURCE_IDS)]
    candidate12 = [*candidate12, FUSED_ID, *ALPHA_IDS]
    candidate11 = [sid for sid in candidate12 if sid != BROKER_RECLAIM_ID]
    final_active12 = [sid for sid in active_ids if sid not in set(FINAL_RETIRE_IDS)]
    final_active12 = [*final_active12, FUSED_ID, *ALPHA_IDS, *FINAL_EXTENSION_ALPHA_IDS]
    replacement = [
        sid for sid in candidate11 if sid not in set(S_FAMILY_REPLACE_TARGET_IDS)
    ]
    replacement = [*replacement, *EXTENSION_ALPHA_IDS]
    return {
        "Baseline_current_active11": active_ids,
        "Candidate12_keep_BrokerReclaim": candidate12,
        "Candidate11_noBroker": candidate11,
        FINAL_ACTIVE12_SCENARIO_ID: final_active12,
        EXTENSION_SCENARIO_ID: replacement,
    }


def _cell_jaccard(left: pd.DataFrame, right: pd.DataFrame) -> float | None:
    left_arr = left.fillna(False).to_numpy(dtype=bool)
    right_arr = right.reindex(index=left.index, columns=left.columns).fillna(False).to_numpy(dtype=bool)
    union = int(np.logical_or(left_arr, right_arr).sum())
    inter = int(np.logical_and(left_arr, right_arr).sum())
    return None if union == 0 else inter / union


def _latest_jaccard(left: pd.DataFrame, right: pd.DataFrame) -> float | None:
    left = left.fillna(False).astype(bool)
    right = right.reindex(index=left.index, columns=left.columns).fillna(False).astype(bool)
    if left.empty:
        return None
    left_latest = set(left.columns[left.iloc[-1].to_numpy(dtype=bool)])
    right_latest = set(right.columns[right.iloc[-1].to_numpy(dtype=bool)])
    union = left_latest | right_latest
    return None if not union else len(left_latest & right_latest) / len(union)


def _phi_corr(left: pd.DataFrame, right: pd.DataFrame) -> float | None:
    left_arr = left.fillna(False).to_numpy(dtype=bool).reshape(-1).astype(float)
    right_arr = right.reindex(index=left.index, columns=left.columns).fillna(False).to_numpy(dtype=bool).reshape(-1).astype(float)
    if left_arr.std() <= 1e-12 or right_arr.std() <= 1e-12:
        return None
    return _safe_float(np.corrcoef(left_arr, right_arr)[0, 1])


def _returns(weights: pd.DataFrame, close: pd.DataFrame, fee_tax_cost: float) -> pd.Series:
    daily_ret = close.reindex(index=weights.index, columns=weights.columns).pct_change(fill_method=None).fillna(0.0)
    held = weights.shift(1).fillna(0.0)
    gross = (held * daily_ret).sum(axis=1)
    return gross - robust._turnover(weights) * fee_tax_cost


def _metrics_for_scenario(
    *,
    scenario_id: str,
    period: str,
    start: str,
    end: str,
    cost_bps: float,
    members: list[str],
    positions: dict[str, pd.DataFrame],
    close_all: pd.DataFrame,
    baseline_union: pd.DataFrame,
    baseline_returns: pd.Series,
    fee_tax_cost: float,
) -> dict[str, Any]:
    close = robust._slice(close_all, start, end)
    weights = robust._scenario_weights(members, positions, close)
    union = robust._scenario_union(members, positions, close)
    returns = _returns(weights, close, fee_tax_cost + cost_bps / 10000.0)
    joined = pd.concat([returns, baseline_returns.reindex(returns.index)], axis=1).dropna()
    counts = union.sum(axis=1)
    row = {
        "scenario_id": scenario_id,
        "period": period,
        "period_start": start,
        "period_end": end,
        "strategy_count": len(members),
        "extra_slippage_bps": cost_bps,
        **robust._metrics(returns),
        "avg_daily_turnover": _safe_float(robust._turnover(weights).mean()),
        "avg_unique_positions": _safe_float(counts.mean()),
        "latest_unique_positions": int(counts.iloc[-1]) if len(counts) else 0,
        "avg_effective_positions": _safe_float(robust._effective_positions(weights).mean()),
        "baseline_return_corr": _safe_float(joined.iloc[:, 0].corr(joined.iloc[:, 1])) if len(joined) > 2 else None,
        "baseline_all_period_jaccard": _cell_jaccard(union, baseline_union.loc[close.index]),
        "baseline_latest_jaccard": _latest_jaccard(union, baseline_union.loc[close.index]),
        "baseline_position_phi_corr": _phi_corr(union, baseline_union.loc[close.index]),
    }
    return row


def _pairwise_rows(ids: list[str], positions: dict[str, pd.DataFrame], close: pd.DataFrame, fee_tax_cost: float) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    returns = {
        sid: robust.alpha223.miner._portfolio_returns(
            positions[sid].reindex(index=close.index, columns=close.columns).fillna(False).astype(bool),
            close,
            fee_tax_cost=fee_tax_cost,
        )
        for sid in ids
        if sid in positions
    }
    for i, left in enumerate(ids):
        for right in ids[i + 1 :]:
            if left not in positions or right not in positions:
                continue
            left_pos = positions[left].reindex(index=close.index, columns=close.columns).fillna(False).astype(bool)
            right_pos = positions[right].reindex(index=close.index, columns=close.columns).fillna(False).astype(bool)
            joined = pd.concat([returns[left], returns[right]], axis=1).dropna()
            rows.append({
                "strategy_a": left,
                "strategy_b": right,
                "return_corr": _safe_float(joined.iloc[:, 0].corr(joined.iloc[:, 1])) if len(joined) > 2 else None,
                "all_period_jaccard": _cell_jaccard(left_pos, right_pos),
                "latest_jaccard": _latest_jaccard(left_pos, right_pos),
                "position_phi_corr": _phi_corr(left_pos, right_pos),
                "a_latest": int(left_pos.sum(axis=1).iloc[-1]) if len(left_pos) else 0,
                "b_latest": int(right_pos.sum(axis=1).iloc[-1]) if len(right_pos) else 0,
            })
    return rows


def run(args: argparse.Namespace) -> dict[str, Any]:
    started = time.time()
    candidate_rows = robust._load_candidate_rows(Path(args.alpha223_json), args.candidate_ids)
    close, tradable, values, meta, universe = robust._build_universe(args)
    positions, metadata, active_info = robust._build_positions(candidate_rows, close, tradable, values, meta, args)
    close_slice = robust._slice(close, args.start_date, args.end_date)
    positions = {
        sid: pos.reindex(index=close_slice.index, columns=close_slice.columns).fillna(False).astype(bool)
        for sid, pos in positions.items()
    }
    positions[FUSED_ID] = _build_fused_position(close=close, tradable=tradable, values=values, args=args)
    metadata[FUSED_ID] = {
        "strategy_id": FUSED_ID,
        "group": "fused_candidate",
        "name": FUSED_ID,
        "factor_ids": [factor_id for factor_id, _weight in FUSED_TERMS],
        "selected_variant": "trend_quality_breakout_fused_weighted_score_v1",
    }

    active_ids = _read_active_ids(Path(args.active_spec_json))
    members = _scenario_members(active_ids)
    missing = sorted({sid for ids in members.values() for sid in ids if sid not in positions})
    if missing:
        raise RuntimeError(f"scenario_position_missing:{missing}")

    periods = [
        ("full_2023_2026", args.start_date, args.end_date),
        ("train_2023_2024", args.start_date, "2024-12-31"),
        ("validation_2025", "2025-01-01", "2025-12-31"),
        ("holdout_2026_ytd", "2026-01-01", args.end_date),
    ]
    costs = [0.0, 50.0, 100.0]
    scenario_rows: list[dict[str, Any]] = []
    comparison_baseline_id = str(getattr(args, "comparison_baseline_scenario_id", "") or "Baseline_current_active11")
    if comparison_baseline_id not in members:
        raise RuntimeError(f"comparison_baseline_scenario_missing:{comparison_baseline_id}")
    for period, start, end in periods:
        for cost_bps in costs:
            close_period = robust._slice(close_slice, start, end)
            baseline_weights = robust._scenario_weights(members[comparison_baseline_id], positions, close_period)
            baseline_union = robust._scenario_union(members[comparison_baseline_id], positions, close_period)
            baseline_returns = _returns(baseline_weights, close_period, args.fee_tax_cost + cost_bps / 10000.0)
            for scenario_id, scenario_members in members.items():
                row = _metrics_for_scenario(
                    scenario_id=scenario_id,
                    period=period,
                    start=start,
                    end=end,
                    cost_bps=cost_bps,
                    members=scenario_members,
                    positions=positions,
                    close_all=close_slice,
                    baseline_union=baseline_union,
                    baseline_returns=baseline_returns,
                    fee_tax_cost=args.fee_tax_cost,
                )
                row["comparison_baseline_scenario_id"] = comparison_baseline_id
                scenario_rows.append(row)

    scenario_df = pd.DataFrame(scenario_rows)
    baseline = scenario_df[scenario_df["scenario_id"] == comparison_baseline_id].set_index(["period", "extra_slippage_bps"])
    for col in ["cagr", "sharpe", "max_drawdown", "total_return", "avg_daily_turnover", "avg_unique_positions", "avg_effective_positions"]:
        scenario_df[f"delta_{col}"] = scenario_df.apply(
            lambda row: row[col] - baseline.loc[(row["period"], row["extra_slippage_bps"]), col],
            axis=1,
        )

    focus_ids = [
        *FUSED_SOURCE_IDS,
        *S_FAMILY_REPLACE_TARGET_IDS,
        BROKER_RECLAIM_ID,
        FUSED_ID,
        *ALPHA_IDS,
        *EXTENSION_ALPHA_IDS,
    ]
    pairwise = pd.DataFrame(_pairwise_rows(focus_ids, positions, close_slice, args.fee_tax_cost))
    standalone_rows = []
    for sid in focus_ids:
        if sid not in positions:
            continue
        pos = positions[sid].reindex(index=close_slice.index, columns=close_slice.columns).fillna(False).astype(bool)
        ret = robust.alpha223.miner._portfolio_returns(pos, close_slice, fee_tax_cost=args.fee_tax_cost)
        standalone_rows.append({
            "strategy_id": sid,
            **metadata.get(sid, {}),
            **robust._metrics(ret),
            **robust._position_stats(pos),
        })
    standalone = pd.DataFrame(standalone_rows)
    return {
        "schema_version": "stockvision-active12-portfolio-scenario-compare-v1",
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "allowed_use": "research_only",
        "decision_effect": "none",
        "runtime_seconds": round(time.time() - started, 3),
        "config": vars(args),
        "universe": universe,
        "active_info": active_info,
        "comparison_baseline_scenario_id": comparison_baseline_id,
        "scenario_members": members,
        "tables": {
            "scenario_metrics": scenario_df,
            "pairwise_focus": pairwise,
            "standalone_focus": standalone,
        },
    }


def _write_table(df: pd.DataFrame, path: Path) -> str:
    df.to_csv(path, index=False, encoding="utf-8-sig")
    return str(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare active11, active12, and active11-noBroker portfolio scenarios.")
    parser.add_argument("--alpha223-json", default=str(robust.DEFAULT_ALPHA223_JSON))
    parser.add_argument(
        "--candidate-ids",
        nargs="+",
        default=[
            "pymoo_nsga3_novelty_0248",
            "pymoo_nsga3_novelty_0109",
            "pymoo_nsga3_novelty_0166",
            "pymoo_nsga3_novelty_0285",
            "pymoo_nsga3_novelty_0283",
            "pymoo_nsga3_novelty_0009",
        ],
    )
    parser.add_argument("--comparison-baseline-scenario-id", default="Baseline_current_active11")
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
    parser.add_argument("--resample", default="M")
    parser.add_argument("--position-limit", type=float, default=0.10)
    parser.add_argument("--trade-at-price", default="close")
    parser.add_argument("--fee-tax-cost", type=float, default=0.004425)
    parser.add_argument("--min-overlap-symbols", type=int, default=80)
    parser.add_argument("--min-coverage", type=float, default=0.15)
    parser.add_argument("--min-rank-std", type=float, default=0.01)
    parser.add_argument("--output-dir", default=str(DEFAULT_OUT_DIR))
    args = parser.parse_args()

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = run(args)
    stem = f"active12_portfolio_scenarios_{args.universe}_{args.start_date}_{args.end_date}".replace("-", "")
    tables = report.pop("tables")
    paths = {
        "scenario_metrics_csv": _write_table(tables["scenario_metrics"], out_dir / f"{stem}_metrics.csv"),
        "pairwise_focus_csv": _write_table(tables["pairwise_focus"], out_dir / f"{stem}_pairwise_focus.csv"),
        "standalone_focus_csv": _write_table(tables["standalone_focus"], out_dir / f"{stem}_standalone_focus.csv"),
    }
    payload = {**report, "outputs": paths}
    json_path = out_dir / f"{stem}.json"
    summary_path = out_dir / f"{stem}_summary.json"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    full = tables["scenario_metrics"][
        (tables["scenario_metrics"]["period"] == "full_2023_2026")
        & (tables["scenario_metrics"]["extra_slippage_bps"] == 0.0)
    ]
    summary = {
        "json": str(json_path),
        **paths,
        "runtime_seconds": report["runtime_seconds"],
        "scenario_members": report["scenario_members"],
        "full_2023_2026_cost0": full.to_dict("records"),
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
