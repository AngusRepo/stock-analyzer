from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import pandas as pd

import finlab_alpha223_recursive_search as search


ROOT = Path(__file__).resolve().parents[1]


def _selected_rows(report: dict, args: argparse.Namespace) -> list[dict]:
    rows = [row for row in report.get("rows", []) if row.get("status") == "ok"]
    if args.candidate_id:
        wanted = set(args.candidate_id)
        return [row for row in rows if row.get("candidate_id") in wanted]

    def ok(row: dict) -> bool:
        full = row.get("full") or {}
        return (
            float(full.get("cagr") or 0.0) >= args.min_cagr
            and float(full.get("sharpe") or 0.0) >= args.min_sharpe
            and float(row.get("max_active_abs_return_corr") or 999.0) <= args.max_corr
            and float(row.get("max_active_all_period_jaccard") or 999.0) <= args.max_jaccard
        )

    filtered = [row for row in rows if ok(row)]
    return sorted(
        filtered,
        key=lambda row: (
            float(row.get("max_active_abs_return_corr") or 999.0),
            -float((row.get("full") or {}).get("sharpe") or 0.0),
            -float((row.get("full") or {}).get("cagr") or 0.0),
        ),
    )[: args.top_n]


def run(args: argparse.Namespace) -> dict:
    report = json.loads(Path(args.report_json).read_text(encoding="utf-8"))
    selected = _selected_rows(report, args)
    if not selected:
        return {"selected_count": 0, "confirm": []}

    base_args = argparse.Namespace(
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
        train_start="2023-01-01",
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
        fee_tax_cost=0.004425,
        seed=42,
        pbo_folds=8,
        resample=args.resample,
        position_limit=args.position_limit,
        trade_at_price=args.trade_at_price,
        output_dir=args.output_dir,
        limit_finlab86=0,
        min_overlap_symbols=80,
        min_coverage=0.15,
        min_rank_std=0.01,
        progress_every=10,
    )
    close, tradable, values, meta, universe_info = search._build_base_universe(base_args)
    finlab86_rows = search._read_finlab86(Path(args.finlab86_csv), 0)
    finlab86_info = search._materialize_finlab86(
        rows=finlab86_rows,
        close=close,
        tradable=tradable,
        values=values,
        meta=meta,
        args=base_args,
    )
    confirm_args = argparse.Namespace(
        resample=args.resample,
        trade_at_price=args.trade_at_price,
        position_limit=args.position_limit,
    )
    ab = search.miner._load_module(search.miner.AB_RUNNER, "stockvision_alpha223_existing_confirm_ab")
    confirms = []
    for row in selected:
        pos = search._position_for_row(row, values=values, meta=meta, close=close, tradable=tradable, args=base_args)
        confirm = ab._run_sim(
            row_id=f"alpha223_{row['candidate_id']}",
            kind="alpha223_low_corr_confirm",
            meta={
                "candidate_id": row["candidate_id"],
                "factor_ids": row.get("factor_ids"),
                "weights": row.get("weights"),
                "alpha223_score": row.get("alpha223_score"),
                "proxy_full_cagr": (row.get("full") or {}).get("cagr"),
                "proxy_full_sharpe": (row.get("full") or {}).get("sharpe"),
                "max_active_abs_return_corr": row.get("max_active_abs_return_corr"),
                "max_active_all_period_jaccard": row.get("max_active_all_period_jaccard"),
                "has_finlab86": row.get("has_finlab86"),
            },
            position=pos,
            args=confirm_args,
        )
        confirms.append(confirm)
    return {
        "selected_count": len(selected),
        "universe": {
            "formal137_mapped": len([fid for fid, item in meta.items() if item.source != "finlab701_research_supplement"]),
            "finlab86_materialized": finlab86_info["materialized"],
            "combined_mapped": len(values),
        },
        "selected": selected,
        "confirm": confirms,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Confirm selected alpha223 candidates from an existing search report.")
    parser.add_argument("--report-json", default=str(ROOT / "output" / "finlab_alpha223_recursive_search" / "alpha223_recursive_sii_20230101_20260615_seed42.json"))
    parser.add_argument("--factor-json", default=str(ROOT / "worker" / ".tmp-test-run-codex" / "alphabuilders_factors_fresh.json"))
    parser.add_argument("--feature-registry", default=str(ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"))
    parser.add_argument("--monthly-mining-config", default=str(ROOT / "data" / "feature_registry" / "pymoo_monthly_mining_config_v1.json"))
    parser.add_argument("--similarity-contract", default=str(ROOT / "data" / "feature_registry" / "formal137_similarity_contract_v1.json"))
    parser.add_argument("--similarity-pairs", default=str(ROOT / "output" / "feature_universe_triage" / "formal137_pairwise_similarity_long_20260617.csv"))
    parser.add_argument("--finlab86-csv", default=str(ROOT / "output" / "feature_universe_triage" / "finlab701_recommended_keep_candidates.csv"))
    parser.add_argument("--active-spec-json", default=str(ROOT / "output" / "finlab_strategy_backtests" / "current_active_11_strategy_specs.json"))
    parser.add_argument("--base-results-csv", default=str(ROOT / "output" / "finlab_technical_strategy12_backtests" / "technical_strategy12_sii_otc_20230101_20260615_results.csv"))
    parser.add_argument("--candidate-id", action="append", default=[])
    parser.add_argument("--min-cagr", type=float, default=0.20)
    parser.add_argument("--min-sharpe", type=float, default=1.00)
    parser.add_argument("--max-corr", type=float, default=0.71)
    parser.add_argument("--max-jaccard", type=float, default=0.03)
    parser.add_argument("--top-n", type=int, default=12)
    parser.add_argument("--start-date", default="2023-01-01")
    parser.add_argument("--end-date", default="2026-06-15")
    parser.add_argument("--universe", choices=["sii", "sii_otc"], default="sii")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--resample", default="M")
    parser.add_argument("--position-limit", type=float, default=0.10)
    parser.add_argument("--trade-at-price", default="close")
    parser.add_argument("--output-dir", default=str(ROOT / "output" / "finlab_alpha223_recursive_search"))
    parser.add_argument("--output-csv", default=str(ROOT / "output" / "finlab_alpha223_recursive_search" / "alpha223_low_corr_finlab_confirm.csv"))
    parser.add_argument("--output-json", default=str(ROOT / "output" / "finlab_alpha223_recursive_search" / "alpha223_low_corr_finlab_confirm.json"))
    args = parser.parse_args()
    result = run(args)
    Path(args.output_json).write_text(json.dumps(result, ensure_ascii=False, indent=2, default=search._json_default), encoding="utf-8")
    pd.DataFrame(result.get("confirm") or []).to_csv(args.output_csv, index=False, encoding="utf-8-sig")
    print(json.dumps({"output_json": args.output_json, "output_csv": args.output_csv, "selected_count": result.get("selected_count"), "universe": result.get("universe")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
