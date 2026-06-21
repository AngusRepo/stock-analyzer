from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "stockvision-formal137-p0-p10-local-closure-validator-v1"

BASELINE_PATH = Path("output/formal137_repair/formal137_20260618_regression_baseline.json")
FEATURE_CONTRACT_PATH = Path("data/feature_registry/formal137_production_feature_contract_v1.json")
PARITY_CONTRACT_PATH = Path("output/formal137_repair/formal137_20260618_local_prod_parity_contract.json")
CUTOVER_CHECKLIST_PATH = Path("output/formal137_repair/formal137_p0_p10_cutover_checklist.json")
UNIFIED_REGISTRY_PATH = Path("data/feature_registry/unified_feature_registry_v1.json")
STRATEGY_REF_CONTRACT_PATH = Path("data/feature_registry/strategy_feature_ref_contract_v1.json")
STRATEGY_SUMMARY_PATH = Path("output/strategy_diversity_20260618/strategy_summary_2026-06-18.csv")
STRATEGY_PAIRWISE_PATH = Path("output/strategy_diversity_20260618/strategy_pairwise_jaccard_corr_2026-06-18.csv")
RESEARCH_BACKTEST_PATH = Path("output/strategy_diversity_20260618/strategy_mining_backtests_2026-06-17.csv")
ACTIVE_BACKTEST_SUMMARY_PATH = Path("output/finlab_strategy_backtests/finlab_strategy_spec_active11_20230101_20260615_summary.json")

CRITICAL_FEATURES = {
    "KLOW2",
    "KSFT",
    "KSFT2",
    "CNTD_20",
    "CNTN_20",
    "margin_balance",
    "us_sentiment_score",
    "l1_monthlyRevenueMoM",
    "ma10_bias",
    "return_5d",
}


def _read_text(root: Path, rel_path: str | Path) -> str:
    return (root / rel_path).read_text(encoding="utf-8", errors="ignore")


def _load_json(root: Path, rel_path: str | Path) -> Any:
    return json.loads((root / rel_path).read_text(encoding="utf-8-sig"))


def _load_csv(root: Path, rel_path: str | Path) -> list[dict[str, str]]:
    with (root / rel_path).open("r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _check(checks: list[dict[str, Any]], check_id: str, passed: bool, detail: str, **extra: Any) -> None:
    row = {"id": check_id, "status": "pass" if passed else "fail", "detail": detail}
    row.update(extra)
    checks.append(row)


def _float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _extract_weighted_feature_refs(thresholds: dict[str, Any]) -> set[str]:
    refs: set[str] = set()
    feature_refs = thresholds.get("featureRefs") if isinstance(thresholds.get("featureRefs"), dict) else {}
    weighted = feature_refs.get("weightedScore") if isinstance(feature_refs.get("weightedScore"), dict) else {}
    for term in weighted.get("terms") or []:
        if isinstance(term, dict) and term.get("featureRef"):
            refs.add(str(term["featureRef"]))
    return refs


def _research_factor_sets(rows: list[dict[str, str]]) -> dict[tuple[str, ...], list[str]]:
    grouped: dict[tuple[str, ...], list[str]] = {}
    for row in rows:
        try:
            factors = json.loads(row.get("factor_ids_json") or "[]")
        except json.JSONDecodeError:
            factors = []
        key = tuple(sorted(str(factor) for factor in factors))
        grouped.setdefault(key, []).append(str(row.get("candidate_id") or ""))
    return grouped


def build_report(root: Path) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    baseline = _load_json(root, BASELINE_PATH)
    feature_contract = _load_json(root, FEATURE_CONTRACT_PATH)
    parity_contract = _load_json(root, PARITY_CONTRACT_PATH)
    cutover = _load_json(root, CUTOVER_CHECKLIST_PATH)
    registry = _load_json(root, UNIFIED_REGISTRY_PATH)
    strategy_ref_contract = _load_json(root, STRATEGY_REF_CONTRACT_PATH)
    strategy_rows = _load_csv(root, STRATEGY_SUMMARY_PATH)
    pair_rows = _load_csv(root, STRATEGY_PAIRWISE_PATH)
    research_rows = _load_csv(root, RESEARCH_BACKTEST_PATH)

    # P0 baseline freeze.
    _check(
        checks,
        "p0:baseline_non_mutating",
        baseline.get("decision_effect") == "local_regression_baseline_only"
        and baseline.get("production_mutation_allowed") is False
        and baseline.get("replay_rerun_allowed") is False,
        "2026-06-18 baseline is frozen as local regression evidence only",
    )
    strategy_by_id = {row.get("strategy_id"): row for row in strategy_rows}
    _check(
        checks,
        "p0:active_11_strategy_summary_baseline",
        len(strategy_rows) == 11
        and all(int(row.get("universe_rows") or 0) == 513 for row in strategy_rows)
        and int(strategy_by_id.get("alpha_miner_pymoo_nsga3_novelty_0081", {}).get("matched_symbols") or -1) == 0
        and int(strategy_by_id.get("alpha_miner_pymoo_nsga3_novelty_0187", {}).get("matched_symbols") or -1) == 117
        and int(strategy_by_id.get("alpha_miner_pymoo_nsga3_novelty_0193", {}).get("matched_symbols") or -1) == 396,
        "active 11 match baseline captures the known pre-repair drift state",
    )
    jaccards = [_float(row.get("jaccard")) for row in pair_rows]
    _check(
        checks,
        "p0:active_11_pairwise_baseline",
        len(pair_rows) == 55
        and abs((sum(jaccards) / max(1, len(jaccards))) - 0.1478) <= 0.0002
        and abs(max(jaccards) - 0.5356) <= 0.0002,
        "active 11 pairwise Jaccard baseline is fixed",
    )
    duplicate_sets = {key: ids for key, ids in _research_factor_sets(research_rows).items() if len(ids) > 1}
    _check(
        checks,
        "p0:research_8_backtest_duplicate_baseline",
        len(research_rows) == 8
        and any(set(ids) >= {
            "strategy-mining-2026-06-17-20260618191715__pymoo_nsga3_novelty_0260",
            "strategy-mining-2026-06-17-20260618191715__pymoo_nsga3_novelty_0108",
        } for ids in duplicate_sets.values()),
        "research 8 baseline preserves the 0260/0108 exact factor-set duplicate as regression evidence",
    )

    # P1 formal137 feature contract.
    features = registry.get("features") if isinstance(registry.get("features"), list) else []
    eligible = [f for f in features if isinstance(f, dict) and f.get("eligible_for_alpha_mining") is True]
    origin_counts: dict[str, int] = {}
    for feature in eligible:
        origin = str(feature.get("origin_pool") or "")
        origin_counts[origin] = origin_counts.get(origin, 0) + 1
    _check(
        checks,
        "p1:formal137_pool_counts",
        len(eligible) == 137
        and origin_counts.get("strategy95") == 89
        and origin_counts.get("ml106") == 48
        and origin_counts.get("finlab701", 0) == 0,
        "formal137 remains 89 strategy95 + 48 ml106; finlab701 is not alpha-mining eligible",
        origin_counts=origin_counts,
    )
    registry_ids = {str(feature.get("feature_id")) for feature in features if isinstance(feature, dict)}
    research_feature_ids = {
        factor
        for key in _research_factor_sets(research_rows)
        for factor in key
    }
    active_weighted_refs: set[str] = set()
    for row in strategy_rows:
        try:
            thresholds = json.loads(row.get("thresholds_json") or "{}")
        except json.JSONDecodeError:
            thresholds = {}
        active_weighted_refs |= _extract_weighted_feature_refs(thresholds)
    ghost_features = sorted((research_feature_ids | active_weighted_refs | CRITICAL_FEATURES) - registry_ids)
    _check(
        checks,
        "p1:no_ghost_features",
        not ghost_features
        and not strategy_ref_contract.get("blockers")
        and strategy_ref_contract.get("counts", {}).get("blockers") == 0,
        "active/research factor refs all resolve to unified_feature_registry_v1 or approved runtime gates",
        ghost_features=ghost_features,
    )
    contract_features = feature_contract.get("critical_runtime_features") if isinstance(feature_contract.get("critical_runtime_features"), list) else []
    contract_ids = {str(row.get("feature_id")) for row in contract_features if isinstance(row, dict)}
    _check(
        checks,
        "p1:critical_runtime_path_contract",
        CRITICAL_FEATURES.issubset(contract_ids)
        and feature_contract.get("source_of_truth") == str(UNIFIED_REGISTRY_PATH).replace("\\", "/")
        and feature_contract.get("runtime_path_policy", {}).get("required_feature_missing_policy") == "fail_closed_no_match_missing_required_factor",
        "formal137 production feature contract declares raw/normalized paths and missing-policy for critical features",
    )

    market_screener = _read_text(root, "worker/src/lib/marketScreener.ts")
    strategy_spec = _read_text(root, "worker/src/lib/strategySpec.ts")

    # P2 materialization.
    _check(
        checks,
        "p2:daily_materialization_critical_factor_signals",
        all(token in market_screener for token in [
            "KLOW2: kLow2",
            "KSFT: kSft",
            "KSFT2: kSft2",
            "CNTN_20: cntn20",
            "CNTD_20: cntd20",
            "advance_ratio: advanceRatio",
            "us_sentiment_score: usSentimentScore",
            "monthlyRevenueMoM",
            "ma10_bias",
            "return_5d",
        ]),
        "daily screener source materializes promoted formal137 strategy factorSignals",
    )
    _check(
        checks,
        "p2:coverage_gate_contract",
        parity_contract.get("factor_coverage_gate", {}).get("required_feature_coverage_min") == 0.95
        and parity_contract.get("factor_coverage_gate", {}).get("missing_reason_required") is True,
        "2026-06-18 parity contract requires >95% coverage and traceable missing reasons",
    )

    # P3 normalization parity.
    _check(
        checks,
        "p3:no_raw_margin_or_constant_sentiment_scoring",
        "function marginBalanceFeatureRefValue" in strategy_spec
        and "function usSentimentScoreFeatureRefValue" in strategy_spec
        and "if (featureRef === 'margin_balance') return marginBalanceFeatureRefValue(raw)" in strategy_spec
        and "if (featureRef === 'us_sentiment_score') return usSentimentScoreFeatureRefValue(raw)" in strategy_spec
        and "margin_balance: ['marginBalance'" not in strategy_spec
        and "us_sentiment_score: ['factorSignals.us_sentiment_score'" not in strategy_spec,
        "production scorer rejects raw margin_balance and constant raw us_sentiment_score for featureRef scoring",
    )
    _check(
        checks,
        "p3:margin_normalized_alias_materialization",
        all(token in market_screener for token in [
            "formal137MarginBalanceRank",
            "margin_balance_rank",
            "marginBalanceRank",
            "margin_balance_normalized",
        ]),
        "FinLab-style normalization exposes formal137 margin-balance rank aliases",
    )

    # P4 scorer fail-closed.
    _check(
        checks,
        "p4:required_feature_missing_fail_closed",
        "function missingRequiredFeatureRefs" in strategy_spec
        and "strategy_spec_missing_required_feature_refs" in strategy_spec
        and "if (value == null) return false" in strategy_spec
        and "if (value == null || weight <= 0) continue" not in strategy_spec,
        "weightedScore required factors fail closed instead of reweighting partial evidence",
    )

    # P5 parity harness.
    _check(
        checks,
        "p5:local_prod_parity_harness_contract",
        parity_contract.get("production_replay_executed") is False
        and parity_contract.get("requires_wei_approval_before_replay") is True
        and set(parity_contract.get("target_strategies_first_wave") or []) == {
            "alpha_miner_pymoo_nsga3_novelty_0081",
            "alpha_miner_pymoo_nsga3_novelty_0187",
            "alpha_miner_pymoo_nsga3_novelty_0193",
        }
        and parity_contract.get("parity_thresholds", {}).get("matched_symbols_jaccard_min") == 0.99,
        "parity harness is scoped to 6/18, starts with 0081/0187/0193, then active 11",
    )

    # P6 active/research backtest schema semantics.
    migration = _read_text(root, "worker/migration_strategy_mining_ledger_2026_06_18.sql")
    active_summary = _load_json(root, ACTIVE_BACKTEST_SUMMARY_PATH)
    _check(
        checks,
        "p6:active_backtest_schema_separated",
        "CREATE TABLE IF NOT EXISTS active_strategy_backtest_results" in migration
        and "strategy_scope TEXT NOT NULL DEFAULT 'active'" in migration
        and "CREATE TABLE IF NOT EXISTS strategy_backtest_results" in migration
        and int(active_summary.get("strategy_count") or 0) == 11,
        "active 11 backtest result scope is separated from research candidate finlab_confirm_top_n ledger",
    )

    # P7 dedupe and promotion gate.
    mining_job = _read_text(root, "ml-controller/strategy_mining_job_main.py")
    promotion_contract = _load_json(root, "data/feature_registry/alpha_mining_promotion_contract_v1.json")
    _check(
        checks,
        "p7:research_candidate_dedupe_before_backtest_persist",
        "def _deduped_finlab_confirm" in mining_job
        and "for confirm in _deduped_finlab_confirm(report):" in mining_job,
        "monthly research backtest persist dedupes exact factor-set candidates before writing finlab_confirm rows",
    )
    _check(
        checks,
        "p7:promotion_pending_review_no_real_trading",
        "auto_research_gate_passed_pending_review" in mining_job
        and "real_trading_effect TEXT NOT NULL DEFAULT 'none'" in migration
        and promotion_contract.get("ledger_contract", {}).get("real_trading_effect") == "none",
        "promotion gate only writes pending-review challenger packets with real_trading_effect=none",
    )

    # P8 diversity propagation.
    recommendation_service = _read_text(root, "ml-controller/services/recommendation_service.py")
    funnel = _read_text(root, "worker/src/lib/screenerFunnelEvidence.ts")
    recommendation_context = _read_text(root, "worker/src/lib/recommendationContext.ts")
    _check(
        checks,
        "p8:l2_l3_l4_diversity_diagnostics",
        all(token in funnel for token in [
            "tree_family_correlation_cap_l2_coarse",
            "l2_model_family_correlation_cap",
            "strategy_family_retention_report_v1",
            "diversity_loss_report_scope",
        ])
        and all(token in recommendation_service for token in [
            "allocation_capacity",
            "sector_concentration_cap",
            "strategy_concentration_cap",
            "family_concentration_cap",
            "l3_to_l4_sparse_allocation_capacity_and_concentration",
        ])
        and all(token in recommendation_context for token in [
            "allocation_capacity",
            "sector_concentration_cap",
            "strategy_concentration_cap",
            "family_concentration_cap",
        ]),
        "L1->L4 diversity loss is visible through L2 cap, L3 retention, and L4 capacity/concentration diagnostics",
    )

    # P9 observability/run-id chain.
    admin_routes = _read_text(root, "worker/src/routes/adminControlRoutes.ts")
    scheduler_logger = _read_text(root, "worker/src/lib/schedulerRunLogger.ts")
    pipeline_job = _read_text(root, "ml-controller/pipeline_job_main.py")
    modal_client = _read_text(root, "ml-controller/services/modal_client.py")
    strategy_learning = _read_text(root, "worker/src/lib/strategyLearning.ts")
    _check(
        checks,
        "p9:run_id_observability_chain_contract",
        all(token in scheduler_logger for token in ["run_id?: string", "cron:log:${task}:${today}", "run_id: result.run_id"])
        and all(token in admin_routes for token in ["run_id: callbackRunId", "runId: callbackRunId"])
        and all(token in pipeline_job for token in ["run_id", "run_pipeline_v2", "producer_run_id=run_id"])
        and "strategy_mining_research" in modal_client
        and "INSERT OR REPLACE INTO strategy_decision_log" in strategy_learning
        and "sparse_diagnostics" in recommendation_service,
        "run_id is carried through Worker KV/D1 callbacks, Cloud Run, Modal strategy mining, decision log, and allocation diagnostics",
    )

    # P10 cutover order and forbidden actions.
    _check(
        checks,
        "p10:cutover_order_and_forbidden_actions",
        cutover.get("production_mutation_allowed") is False
        and cutover.get("required_order", [])[:3] == [
            "local_unit_fixture_pass",
            "2026_06_18_local_prod_parity_report_pass",
            "active_11_research_8_diversity_backtest_comparison_report_pass",
        ]
        and {"deploy", "production_replay_job", "commit", "push", "retrain", "real_trading"}.issubset(
            set(cutover.get("forbidden_without_explicit_wei_approval") or [])
        ),
        "cutover checklist preserves local-first order and blocks deploy/replay/commit/push/retrain without Wei approval",
    )

    failed = [row for row in checks if row["status"] != "pass"]
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "pass" if not failed else "fail",
        "local_closure": "done" if not failed else "blocked",
        "local_prod_ready": "done" if not failed else "blocked",
        "production_mutation_allowed": False,
        "promotion_allowed": False,
        "checks": checks,
        "failed_checks": failed,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=".", help="Repo root")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    report = build_report(Path(args.repo).resolve())
    print(json.dumps(report, ensure_ascii=False, indent=2 if args.pretty else None))
    return 0 if report["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
