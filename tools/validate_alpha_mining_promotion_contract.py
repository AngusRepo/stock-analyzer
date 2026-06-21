from __future__ import annotations

import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "data" / "feature_registry" / "alpha_mining_promotion_contract_v1.json"


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise RuntimeError(f"missing_contract:{path}")
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise RuntimeError(f"invalid_contract:{path}")
    return data


def _assert(condition: bool, reason: str, errors: list[str]) -> None:
    if not condition:
        errors.append(reason)


def _source_path(value: Any) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        return None
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def validate(contract: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    feature_policy = contract.get("feature_pool_policy") if isinstance(contract.get("feature_pool_policy"), dict) else {}
    monthly = contract.get("monthly_search_policy") if isinstance(contract.get("monthly_search_policy"), dict) else {}
    guardrails = contract.get("promotion_guardrails") if isinstance(contract.get("promotion_guardrails"), dict) else {}
    ledger = contract.get("ledger_contract") if isinstance(contract.get("ledger_contract"), dict) else {}
    seed = contract.get("current_explicit_seed") if isinstance(contract.get("current_explicit_seed"), dict) else {}
    lifecycle = contract.get("promotion_lifecycle") if isinstance(contract.get("promotion_lifecycle"), list) else []
    lifecycle_states = {str(row.get("state")) for row in lifecycle if isinstance(row, dict)}
    evidence = set(str(x) for x in contract.get("required_evidence") or [])
    source_contracts = contract.get("source_contracts") if isinstance(contract.get("source_contracts"), dict) else {}

    _assert(contract.get("schema_version") == "stockvision-alpha-mining-promotion-contract-v1", "schema_version_mismatch", errors)
    _assert(contract.get("decision_effect") == "governance_contract_only", "contract_must_not_have_runtime_effect", errors)
    _assert(feature_policy.get("formal_pool") == "137 = 69 core_prior + 68 evidence_watch", "formal_pool_must_be_137", errors)
    _assert(feature_policy.get("lineage_only") and "179" in str(feature_policy.get("lineage_only")), "179_must_be_lineage_only", errors)
    _assert(monthly.get("cadence") == "monthly", "cadence_must_be_monthly", errors)
    _assert(monthly.get("requires_finlab_backtest") is True, "finlab_backtest_required", errors)
    _assert(monthly.get("algorithm") == "pymoo", "algorithm_must_be_pymoo", errors)
    _assert(monthly.get("factor_universe") == "unified_registry_v1", "factor_universe_must_be_unified_registry", errors)
    _assert(bool(monthly.get("adaptive_controller")), "adaptive_controller_required", errors)
    _assert(guardrails.get("no_direct_daily_buy_path") is True, "no_direct_daily_buy_path_required", errors)
    _assert(guardrails.get("no_top_k_fallback") is True, "no_top_k_fallback_required", errors)
    _assert(guardrails.get("no_new_selector") is True, "no_new_selector_required", errors)
    _assert(guardrails.get("no_201_or_179_feature_soup") is True, "no_201_or_179_feature_soup_required", errors)
    _assert(
        guardrails.get("explicit_wei_approval_required_for_production") is True,
        "explicit_wei_approval_required_for_production",
        errors,
    )
    _assert({"research_candidate", "challenger_candidate", "paper_active", "production", "retired"} <= lifecycle_states, "lifecycle_incomplete", errors)
    _assert(len(seed.get("seeded_strategy_ids") or []) == 3, "current_seed_must_have_3_mined_strategies", errors)
    required_evidence = {
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
    }
    _assert(required_evidence <= evidence, "required_evidence_incomplete", errors)
    ledger_tables = set(str(item) for item in ledger.get("tables") or [])
    _assert({
        "strategy_mining_runs",
        "strategy_mining_candidates",
        "strategy_backtest_results",
        "active_strategy_backtest_results",
        "strategy_similarity_matrix",
        "strategy_promotion_ledger",
    } <= ledger_tables, "strategy_mining_ledger_tables_incomplete", errors)
    _assert(ledger.get("real_trading_effect") == "none", "strategy_mining_ledger_must_have_no_real_trading_effect", errors)
    if CONTRACT_PATH.exists():
        contract_mtime = CONTRACT_PATH.stat().st_mtime
        for name, raw_path in source_contracts.items():
            source_path = _source_path(raw_path)
            _assert(source_path is not None and source_path.exists(), f"source_contract_missing:{name}", errors)
            if source_path is not None and source_path.exists():
                _assert(contract_mtime + 1e-6 >= source_path.stat().st_mtime, f"promotion_contract_stale_against:{name}", errors)

    return {
        "status": "pass" if not errors else "fail",
        "errors": errors,
        "lifecycle_states": sorted(lifecycle_states),
        "required_evidence_count": len(evidence),
        "seeded_strategy_ids": seed.get("seeded_strategy_ids") or [],
    }


def main() -> int:
    result = validate(_load_json(CONTRACT_PATH))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
