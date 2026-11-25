"""Producer of the three feature-triage tables that had no producer in the repo.

  output/feature_universe_triage/finlab701_triage_best_by_field.csv
  output/feature_universe_triage/finlab701_recommended_keep_candidates.csv
  output/feature_universe_triage/strategy95_vs_ml106_full_mapping.csv

They were committed in 05b5cfbc as hand-run outputs. The rules below were recovered from those files.
On the committed 20230101_20260615 inputs the two finlab701 tables are reproduced byte-for-byte
(--check --tables finlab701). The strategy95 mapping matches on the 80 factors that have a row in the
committed strategy95 backtest; the other 15 l1_* factors have no committed backtest row, so that table
can only be rebuilt after the strategy95 backtest is re-run on the same window as the overlap run.

finlab701 (one row per field, from the augment701 best-direction CSV, in its order):
  pass gate        monthly_sharpe >= 1.2, cagr >= 0.2, max_drawdown >= -0.18, coverage >= 0.6
  duplicate        same (direction_mode, monthly_sharpe, cagr, max_drawdown, total_return, trade_count) as an
                   earlier row; that earlier row is duplicate_metric_signature_of
  decision         fail gate -> drop_or_context_only; else duplicate -> dedupe_duplicate_metric_signature;
                   else chips group -> keep_as_chip_candidate; else keep_as_transform_candidate_not_raw_selector
  strength_bucket  fail gate -> weak; else monthly_sharpe >= 1.5 and cagr >= 0.3 -> very_strong; else strong
  recommended keep = keep_as_chip_candidate + keep_as_transform_candidate_not_raw_selector

strategy95 vs ml106 (one row per strategy factor of the overlap run, sorted by factor id):
  overlap_tier     from the nearest ML feature's |rank corr| and the overlap run's thresholds
  action           high -> dedupe_or_keep_as_alias; medium -> keep_but_cluster_with_ml_neighbor when the
                   strategy factor's best monthly_sharpe >= 1.0, else watch_or_strategy_only; low ->
                   candidate_add_to_shared_pool when that sharpe >= 0.8, else watch_or_strategy_only
  A strategy factor without a strategy95 backtest row fails the build (no silent "watch" default).

The window comes from the monthly mining config (research_protocol.feature_triage_window).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from feature_triage_window import ROOT, triage_paths, triage_window, window_stem  # noqa: E402

TRIAGE_DIR = ROOT / "output" / "feature_universe_triage"
FINLAB701_TRIAGE = TRIAGE_DIR / "finlab701_triage_best_by_field.csv"
FINLAB701_KEEP = TRIAGE_DIR / "finlab701_recommended_keep_candidates.csv"
STRATEGY95_MAPPING = TRIAGE_DIR / "strategy95_vs_ml106_full_mapping.csv"

FINLAB701_COLUMNS = [
    "api_key", "namespace", "field", "group", "dataset_lane", "direction_mode", "monthly_sharpe", "cagr",
    "max_drawdown", "coverage", "avg_rank_std", "trade_count", "benchmark_beta",
]
FINLAB701_GATE = {"monthly_sharpe": 1.2, "cagr": 0.2, "max_drawdown": -0.18, "coverage": 0.6}
FINLAB701_VERY_STRONG = {"monthly_sharpe": 1.5, "cagr": 0.3}
FINLAB701_SIGNATURE = ["direction_mode", "monthly_sharpe", "cagr", "max_drawdown", "total_return", "trade_count"]
CHIP_GROUP = "chips / institutional flow"
KEEP_DECISIONS = {"keep_as_chip_candidate", "keep_as_transform_candidate_not_raw_selector"}

MEDIUM_KEEP_SHARPE = 1.0
LOW_ADD_SHARPE = 0.8


def _read(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(f"triage_input_missing:{path}")
    return pd.read_csv(path, encoding="utf-8-sig", float_precision="round_trip")


def build_finlab701(best: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    out = best[FINLAB701_COLUMNS].copy()
    out["trade_count"] = out["trade_count"].astype(float)
    passed = (
        (best["monthly_sharpe"] >= FINLAB701_GATE["monthly_sharpe"])
        & (best["cagr"] >= FINLAB701_GATE["cagr"])
        & (best["max_drawdown"] >= FINLAB701_GATE["max_drawdown"])
        & (best["coverage"] >= FINLAB701_GATE["coverage"])
    )
    first_by_signature: dict[tuple, str] = {}
    duplicate_of: list[str] = []
    for _, row in best.iterrows():
        signature = tuple(row[col] for col in FINLAB701_SIGNATURE)
        if any(pd.isna(value) for value in signature):
            duplicate_of.append("")
            continue
        duplicate_of.append(first_by_signature.get(signature, ""))
        first_by_signature.setdefault(signature, row["api_key"])
    out["duplicate_metric_signature_of"] = duplicate_of
    decisions, buckets = [], []
    for ok, dup, group, sharpe, cagr in zip(passed, duplicate_of, best["group"], best["monthly_sharpe"], best["cagr"]):
        if not ok:
            decisions.append("drop_or_context_only")
            buckets.append("weak")
            continue
        if dup:
            decisions.append("dedupe_duplicate_metric_signature")
        elif group == CHIP_GROUP:
            decisions.append("keep_as_chip_candidate")
        else:
            decisions.append("keep_as_transform_candidate_not_raw_selector")
        very = sharpe >= FINLAB701_VERY_STRONG["monthly_sharpe"] and cagr >= FINLAB701_VERY_STRONG["cagr"]
        buckets.append("very_strong" if very else "strong")
    out["decision"] = decisions
    out["strength_bucket"] = buckets
    keep = out[out["decision"].isin(KEEP_DECISIONS)].reset_index(drop=True)
    return out.reset_index(drop=True), keep


def _overlap_tier(abs_corr: float, high: float, medium: float) -> str:
    if abs_corr >= high:
        return "high_duplicate_ge_0_8" if high == 0.8 else f"high_duplicate_ge_{high}".replace(".", "_")
    if abs_corr >= medium:
        return "medium_related_0_4_0_8" if (medium, high) == (0.4, 0.8) else f"medium_related_{medium}_{high}".replace(".", "_")
    return "low_novel_lt_0_4" if medium == 0.4 else f"low_novel_lt_{medium}".replace(".", "_")


def _action(tier: str, strategy_sharpe: float) -> str:
    if tier.startswith("high_"):
        return "dedupe_or_keep_as_alias"
    if tier.startswith("medium_"):
        return "keep_but_cluster_with_ml_neighbor" if strategy_sharpe >= MEDIUM_KEEP_SHARPE else "watch_or_strategy_only"
    return "candidate_add_to_shared_pool" if strategy_sharpe >= LOW_ADD_SHARPE else "watch_or_strategy_only"


def build_strategy95_mapping(
    nearest: pd.DataFrame, strategy_best: pd.DataFrame, ml_best: pd.DataFrame, overlap_params: dict
) -> pd.DataFrame:
    high = float(overlap_params.get("high_overlap_threshold", 0.8))
    medium = float(overlap_params.get("medium_overlap_threshold", 0.4))
    strategy = strategy_best.set_index("factor_id")
    ml = ml_best.set_index("feature_id")
    missing_strategy = sorted(set(nearest["strategy_factor"]) - set(strategy.index))
    missing_ml = sorted(set(nearest["ml_feature"]) - set(ml.index))
    if missing_strategy or missing_ml:
        raise ValueError(
            "strategy95_mapping_inputs_incomplete:"
            f"strategy95_best_missing={missing_strategy}:ml106_best_missing={missing_ml}"
        )
    rows = []
    for _, near in nearest.sort_values("strategy_factor").iterrows():
        s = strategy.loc[near["strategy_factor"]]
        m = ml.loc[near["ml_feature"]]
        tier = _overlap_tier(float(near["abs_rank_corr"]), high, medium)
        rows.append({
            "strategy_factor": near["strategy_factor"],
            "strategy_source": near["strategy_source"],
            "strategy_category": near["strategy_category"],
            "nearest_ml106_feature": near["ml_feature"],
            "nearest_abs_rank_corr": near["abs_rank_corr"],
            "overlap_tier": tier,
            "strategy_best_direction": s["direction_mode"],
            "strategy_declared_direction": s["declared_direction"],
            "strategy_is_declared_direction": s["is_declared_direction"],
            "strategy_best_sharpe": s["monthly_sharpe"],
            "strategy_best_cagr": s["cagr"],
            "strategy_best_mdd": s["max_drawdown"],
            "strategy_mean_ic_5d": near["strategy_mean_ic"],
            "ml106_feature_best_direction": m["direction_mode"],
            "ml106_feature_best_sharpe": m["monthly_sharpe"],
            "ml106_feature_best_cagr": m["cagr"],
            "ml106_feature_best_mdd": m["max_drawdown"],
            "ml106_mean_ic_5d": near["ml_mean_ic"],
            "action": _action(tier, float(s["monthly_sharpe"])),
        })
    return pd.DataFrame(rows)


def _emit(frame: pd.DataFrame, path: Path, *, check: bool) -> bool:
    text = frame.to_csv(index=False, lineterminator="\n")
    if check:
        current = path.read_text(encoding="utf-8-sig") if path.exists() else None
        same = current == text
        print(f"[triage-tables] {'match' if same else 'DIFFERS'}: {path.relative_to(ROOT)}")
        return same
    path.write_text(text, encoding="utf-8-sig")
    print(f"[triage-tables] wrote {path.relative_to(ROOT)} rows={len(frame)}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--window-start", default="")
    parser.add_argument("--window-end", default="")
    parser.add_argument("--universe", default="sii")
    parser.add_argument("--tables", choices=["all", "finlab701", "strategy95"], default="all")
    parser.add_argument("--check", action="store_true", help="compare with the committed tables, write nothing")
    args = parser.parse_args()
    start, end = triage_window()
    start, end = args.window_start or start, args.window_end or end
    paths = triage_paths(window_stem(start, end), universe=args.universe)
    # Every table is built before any is written, so a failing input never leaves a partial rebuild.
    outputs: list[tuple[pd.DataFrame, Path]] = []
    if args.tables in ("all", "finlab701"):
        triage, keep = build_finlab701(_read(paths["augment701_best"]))
        outputs += [(triage, FINLAB701_TRIAGE), (keep, FINLAB701_KEEP)]
    if args.tables in ("all", "strategy95"):
        overlap = json.loads(paths["overlap_json"].read_text(encoding="utf-8-sig"))
        mapping = build_strategy95_mapping(
            _read(paths["overlap_nearest"]),
            _read(paths["strategy95_best"]),
            _read(paths["ml106_best"]),
            overlap.get("parameters") or {},
        )
        outputs.append((mapping, STRATEGY95_MAPPING))
    ok = True
    for frame, path in outputs:
        ok &= _emit(frame, path, check=args.check)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
