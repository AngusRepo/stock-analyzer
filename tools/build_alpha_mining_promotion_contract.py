from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
REGISTRY_PATH = ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"
MONTHLY_CONFIG_PATH = ROOT / "data" / "feature_registry" / "pymoo_monthly_mining_config_v1.json"
SIMILARITY_CONTRACT_PATH = ROOT / "data" / "feature_registry" / "formal137_similarity_contract_v1.json"
PAIRWISE_PATH = ROOT / "output" / "feature_universe_triage" / "formal137_pairwise_similarity_long_20260617.csv"
STRATEGY_REF_CONTRACT_PATH = ROOT / "data" / "feature_registry" / "strategy_feature_ref_contract_v1.json"
ML_FEATURE_SELECTION_CONTRACT_PATH = ROOT / "data" / "feature_registry" / "ml_feature_selection_contract_v1.json"
MINED_MIGRATION_PATH = ROOT / "worker" / "migration_strategy_registry_alpha_miner_2026_06_17.sql"
LEDGER_MIGRATION_PATH = ROOT / "worker" / "migration_strategy_mining_ledger_2026_06_18.sql"
OUTPUT_PATH = ROOT / "data" / "feature_registry" / "alpha_mining_promotion_contract_v1.json"


def _rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT.resolve()).as_posix()


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise RuntimeError(f"invalid_json_object:{path}")
    return data


def _selector_role_counts(registry: dict[str, Any]) -> dict[str, int]:
    features = registry.get("features") or []
    counts: dict[str, int] = {}
    for row in features:
        if not isinstance(row, dict):
            continue
        role = str(row.get("selector_role") or "unknown")
        counts[role] = counts.get(role, 0) + 1
    return counts


def _seeded_alpha_miner_strategies() -> list[str]:
    if not MINED_MIGRATION_PATH.exists():
        return []
    text = MINED_MIGRATION_PATH.read_text(encoding="utf-8")
    ids = re.findall(r"'(alpha_miner_pymoo_nsga3_novelty_[0-9]+)'", text)
    return sorted(set(ids))


def build_contract() -> dict[str, Any]:
    registry = _load_json(REGISTRY_PATH)
    monthly_config = _load_json(MONTHLY_CONFIG_PATH)
    similarity_contract = _load_json(SIMILARITY_CONTRACT_PATH)
    role_counts = _selector_role_counts(registry)
    defaults = monthly_config.get("defaults") if isinstance(monthly_config.get("defaults"), dict) else {}
    schedule = monthly_config.get("schedule") if isinstance(monthly_config.get("schedule"), dict) else {}

    return {
        "schema_version": "stockvision-alpha-mining-promotion-contract-v1",
        "owner": "alpha_mining_research",
        "decision_effect": "governance_contract_only",
        "source_contracts": {
            "feature_registry": _rel(REGISTRY_PATH),
            "monthly_mining_config": _rel(MONTHLY_CONFIG_PATH),
            "similarity_contract": _rel(SIMILARITY_CONTRACT_PATH),
            "similarity_pairs": _rel(PAIRWISE_PATH),
            "strategy_feature_ref_contract": _rel(STRATEGY_REF_CONTRACT_PATH),
            "ml_feature_selection_contract": _rel(ML_FEATURE_SELECTION_CONTRACT_PATH),
            "current_alpha_miner_seed_migration": _rel(MINED_MIGRATION_PATH),
            "strategy_mining_ledger_migration": _rel(LEDGER_MIGRATION_PATH),
        },
        "feature_pool_policy": {
            "formal_pool": "137 = 69 core_prior + 68 evidence_watch",
            "selector_role_counts": role_counts,
            "eligible_for_alpha_mining": int(
                sum(1 for row in registry.get("features", []) if isinstance(row, dict) and row.get("eligible_for_alpha_mining"))
            ),
            "core_prior": "Can seed challenger evidence directly when FinLab and walk-forward evidence pass.",
            "evidence_watch": "Can enter pymoo combinations with lower prior; cannot directly seed challenger without a passing mined combo.",
            "drop_research_candidate": "Excluded from selector, ML, PLE and alpha mining candidate paths.",
            "lineage_only": "179 is historical lineage only; monthly mining must use the formal 137 pool.",
        },
        "monthly_search_policy": {
            "cadence": schedule.get("cadence", "monthly"),
            "recommended_window": schedule.get("recommended_window"),
            "requires_finlab_backtest": bool(schedule.get("requires_finlab_backtest")),
            "algorithm": defaults.get("algorithm"),
            "factor_universe": defaults.get("factor_universe"),
            "initial_defaults": {
                "min_factors": defaults.get("min_factors"),
                "max_factors": defaults.get("max_factors"),
                "pymoo_population": defaults.get("pymoo_population"),
                "pymoo_generations": defaults.get("pymoo_generations"),
                "finlab_confirm_top_n": defaults.get("finlab_confirm_top_n"),
            },
            "adaptive_controller": monthly_config.get("adaptive_controller"),
            "novelty_contract": {
                "base": "Jaccard factor-set novelty",
                "adjusted": "formal137 pairwise abs rank corr penalty/bonus",
                "high_duplicate_floor": (similarity_contract.get("policy") or {}).get("duplicate_levels", {}).get("high_duplicate"),
                "related_cluster_floor": (similarity_contract.get("policy") or {}).get("duplicate_levels", {}).get("related_cluster"),
            },
        },
        "promotion_lifecycle": [
            {
                "state": "research_candidate",
                "owner": "alpha_mining_research",
                "entry": "Generated by monthly pymoo NSGA-III + novelty from formal feature pool.",
                "decision_effect": "none",
                "allowed_writes": ["research artifact", "summary report"],
            },
            {
                "state": "challenger_candidate",
                "owner": "strategy_governance",
                "entry": "Representative mined family has passing FinLab confirm, PBO/deflated Sharpe, novelty telemetry and walk-forward evidence.",
                "decision_effect": "research registry only",
                "allowed_writes": ["promotion packet", "D1 research/challenger metadata"],
            },
            {
                "state": "paper_active",
                "owner": "strategy_governance",
                "entry": "Requires explicit Wei approval after challenger packet review.",
                "decision_effect": "paper/live-observe evidence only",
                "allowed_writes": ["paper/replay evidence"],
            },
            {
                "state": "production",
                "owner": "strategy_registry",
                "entry": "Requires explicit Wei approval, migration/registry write, and clean rollback path.",
                "decision_effect": "L1 strategy labeler active spec",
                "allowed_writes": ["strategy_spec_registry"],
            },
            {
                "state": "retired",
                "owner": "strategy_governance",
                "entry": "Triggered by degradation, high overlap with stronger strategy, stale evidence, or explicit Wei decision.",
                "decision_effect": "removed from runtime active strategy set",
                "allowed_writes": ["strategy_spec_registry"],
            },
        ],
        "required_evidence": [
            "finlab_confirm_backtest",
            "walk_forward_validation",
            "pbo",
            "deflated_sharpe_probability",
            "formal137_similarity_novelty",
            "strategy_feature_ref_validation",
            "l1_5_diversity_compare",
            "l2_l3_retention_compare",
            "l4_buy_stability_compare",
            "live_vs_backtest_divergence_after_observe",
        ],
        "promotion_guardrails": {
            "no_direct_daily_buy_path": True,
            "no_top_k_fallback": True,
            "no_new_selector": True,
            "no_201_or_179_feature_soup": True,
            "explicit_wei_approval_required_for_production": True,
            "d1_strategy_registry_is_source_of_truth_after_seed": True,
            "strategy_code_bootstrap_limit": "D1 strategy_spec_registry is the runtime source-of-truth; DEFAULT_STRATEGY_SPECS is bootstrap seed only and must not serve as runtime fallback.",
        },
        "ledger_contract": {
            "migration": _rel(LEDGER_MIGRATION_PATH),
            "tables": [
                "strategy_mining_runs",
                "strategy_mining_candidates",
                "strategy_backtest_results",
                "active_strategy_backtest_results",
                "strategy_similarity_matrix",
                "strategy_promotion_ledger",
            ],
            "decision_effect": "research_and_governance_until_explicit_production_promotion",
            "real_trading_effect": "none",
        },
        "current_explicit_seed": {
            "seeded_strategy_ids": _seeded_alpha_miner_strategies(),
            "source": _rel(MINED_MIGRATION_PATH),
            "note": "Current 3 mined strategies were handled as explicitly approved 2026-06-17 seed; future monthly mined strategies must follow this contract.",
        },
    }


def main() -> int:
    contract = build_contract()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(contract, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "status": "ok",
        "path": str(OUTPUT_PATH),
        "seeded_strategy_count": len(contract["current_explicit_seed"]["seeded_strategy_ids"]),
        "required_evidence_count": len(contract["required_evidence"]),
        "monthly_cadence": contract["monthly_search_policy"]["cadence"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
