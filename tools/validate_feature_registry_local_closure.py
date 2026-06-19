from __future__ import annotations

import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "feature_registry"
OUTPUT_DIR = ROOT / "output" / "feature_universe_triage"
REPORT_PATH = OUTPUT_DIR / "feature_registry_local_closure_20260617.json"


FILES = {
    "registry": DATA_DIR / "unified_feature_registry_v1.json",
    "similarity": DATA_DIR / "formal137_similarity_contract_v1.json",
    "feature_views": DATA_DIR / "feature_view_contract_v1.json",
    "strategy_refs": DATA_DIR / "strategy_feature_ref_contract_v1.json",
    "ml_selection": DATA_DIR / "ml_feature_selection_contract_v1.json",
    "ml_migration_preflight": DATA_DIR / "ml_feature_migration_preflight_v1.json",
    "monthly_config": DATA_DIR / "pymoo_monthly_mining_config_v1.json",
    "promotion": DATA_DIR / "alpha_mining_promotion_contract_v1.json",
    "pairwise": OUTPUT_DIR / "formal137_pairwise_similarity_long_20260617.csv",
    "materialization_audit": OUTPUT_DIR / "unified137_materialization_audit_sii_20230101_20260615.json",
    "similarity_pairwise_source": OUTPUT_DIR / "unified179_pairwise_similarity_long_20260617.csv",
    "similarity_backtest_source": OUTPUT_DIR / "unified179_feature_backtest_report_20260617.csv",
    "strategy_spec_source": ROOT / "worker" / "src" / "lib" / "strategySpec.ts",
    "alpha_miner_migration": ROOT / "worker" / "migration_strategy_registry_alpha_miner_2026_06_17.sql",
    "strategy_mining_ledger_migration": ROOT / "worker" / "migration_strategy_mining_ledger_2026_06_18.sql",
    "ml_feature_cols_source": ROOT / "ml-service" / "app" / "features" / "__init__.py",
}

DERIVED_DEPENDENCIES = {
    "similarity": ["registry", "similarity_pairwise_source", "similarity_backtest_source"],
    "feature_views": ["registry", "similarity"],
    "strategy_refs": ["registry", "strategy_spec_source", "alpha_miner_migration"],
    "ml_selection": ["registry", "feature_views", "similarity", "ml_feature_cols_source"],
    "ml_migration_preflight": ["registry", "feature_views", "similarity", "ml_selection", "materialization_audit"],
    "promotion": [
        "registry",
        "monthly_config",
        "similarity",
        "pairwise",
        "strategy_refs",
        "ml_selection",
        "alpha_miner_migration",
        "strategy_mining_ledger_migration",
    ],
}


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise RuntimeError(f"missing_file:{path}")
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise RuntimeError(f"invalid_json_object:{path}")
    return data


def _check(condition: bool, reason: str, errors: list[str]) -> None:
    if not condition:
        errors.append(reason)


def _count_features(registry: dict[str, Any], key: str) -> int:
    return int(sum(1 for row in registry.get("features", []) if isinstance(row, dict) and row.get(key)))


def _artifact_fresh(artifact: Path, source: Path) -> bool:
    if not artifact.exists() or not source.exists():
        return False
    return artifact.stat().st_mtime + 1e-6 >= source.stat().st_mtime


def _derived_freshness_errors() -> tuple[list[str], dict[str, Any]]:
    errors: list[str] = []
    summary: dict[str, Any] = {}
    for artifact_name, dependency_names in DERIVED_DEPENDENCIES.items():
        artifact = FILES[artifact_name]
        stale_against: list[str] = []
        missing_dependencies: list[str] = []
        for dependency_name in dependency_names:
            dependency = FILES[dependency_name]
            if not dependency.exists():
                missing_dependencies.append(dependency_name)
                continue
            if not _artifact_fresh(artifact, dependency):
                stale_against.append(dependency_name)
        fresh = artifact.exists() and not stale_against and not missing_dependencies
        summary[artifact_name] = {
            "fresh": fresh,
            "stale_against": stale_against,
            "missing_dependencies": missing_dependencies,
        }
        if missing_dependencies:
            errors.append(f"{artifact_name}_missing_freshness_dependencies:{','.join(missing_dependencies)}")
        if stale_against:
            errors.append(f"{artifact_name}_artifact_older_than:{','.join(stale_against)}")
    return errors, summary


def _same_path(left: str | None, right: Path) -> bool:
    if not left:
        return False
    try:
        return Path(left).resolve() == right.resolve()
    except OSError:
        return False


def validate() -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    for name, path in FILES.items():
        _check(path.exists(), f"missing_{name}:{path}", errors)
    freshness_errors, derived_freshness = _derived_freshness_errors()
    errors.extend(freshness_errors)

    registry = _load_json(FILES["registry"])
    similarity = _load_json(FILES["similarity"])
    feature_views = _load_json(FILES["feature_views"])
    strategy_refs = _load_json(FILES["strategy_refs"])
    ml_selection = _load_json(FILES["ml_selection"])
    ml_migration_preflight = _load_json(FILES["ml_migration_preflight"])
    monthly_config = _load_json(FILES["monthly_config"])
    promotion = _load_json(FILES["promotion"])
    materialization = _load_json(FILES["materialization_audit"])

    registry_features = registry.get("features") or []
    formal_count = _count_features(registry, "eligible_for_alpha_mining")
    view_summary = feature_views.get("summary") or {}
    view_counts = view_summary.get("view_counts") or {}
    strategy_counts = strategy_refs.get("counts") or {}
    ml_counts = ml_selection.get("counts") or {}
    ml_preflight_counts = ml_migration_preflight.get("counts") or {}
    ml_preflight_gates = ml_migration_preflight.get("gate_status") or {}
    ml_preflight_policy = ml_migration_preflight.get("policy") or {}
    similarity_counts = similarity.get("counts") or {}
    monthly_defaults = monthly_config.get("defaults") or {}
    schedule = monthly_config.get("schedule") or {}
    promotion_guards = promotion.get("promotion_guardrails") or {}
    materialization_counts = materialization.get("counts") or {}
    materialization_date_range = materialization.get("date_range") or {}
    materialization_fresh = _artifact_fresh(FILES["materialization_audit"], FILES["registry"])

    _check(len(registry_features) >= 137, "registry_feature_count_too_low", errors)
    _check(formal_count == 137, f"formal_alpha_mining_count_expected_137_actual_{formal_count}", errors)
    _check(similarity_counts.get("formal_features") == 137, "similarity_formal_features_not_137", errors)
    _check(int(similarity_counts.get("pair_rows") or 0) > 0, "similarity_pair_rows_missing", errors)
    _check(view_summary.get("no_201_invariant_pass") is True, "feature_views_no_201_invariant_failed", errors)
    _check(all(int(value) == 137 for value in view_counts.values()), "not_all_feature_views_have_137_candidates", errors)
    _check(int(strategy_counts.get("strategies") or 0) == 11, "strategy_ref_strategy_count_not_11", errors)
    _check(int(strategy_counts.get("blockers") or 0) == 0, "strategy_ref_blockers_present", errors)
    _check(int(ml_counts.get("feature_cols") or 0) == 137, "ml_current_feature_cols_not_137", errors)
    _check(int(ml_counts.get("formal137_ml_training_view") or 0) == 137, "ml_training_view_not_137", errors)
    _check(int(ml_counts.get("feature_cols_mapped_to_formal137") or 0) == 137, "ml_feature_cols_not_fully_mapped_to_formal137", errors)
    _check(int(ml_counts.get("feature_cols_not_mapped_to_formal137") or 0) == 0, "ml_feature_cols_unmapped_to_formal137", errors)
    _check(int(ml_counts.get("formal137_not_in_current_feature_cols") or 0) == 0, "ml_formal137_not_in_current_feature_cols_present", errors)
    _check(ml_migration_preflight.get("status") == "preflight_ready", "ml_feature_migration_preflight_not_ready", errors)
    _check(ml_migration_preflight.get("decision_effect") == "local_validation_only", "ml_feature_migration_preflight_has_runtime_effect", errors)
    _check(int(ml_preflight_counts.get("migration_candidate_count") or 0) == int(ml_counts.get("formal137_not_in_current_feature_cols") or 0), "ml_feature_migration_candidate_count_mismatch", errors)
    _check(int(ml_preflight_counts.get("materialization_blocker_count") or 0) == 0, "ml_feature_migration_materialization_blockers_present", errors)
    _check(ml_preflight_gates.get("production_activation") == "pass", "ml_feature_migration_activation_not_pass", errors)
    _check(ml_preflight_policy.get("runtime_feature_schema") == "formal137", "ml_feature_migration_runtime_schema_not_formal137", errors)
    _check(ml_preflight_policy.get("no_direct_unmanaged_feature_append") is True, "ml_feature_migration_allows_unmanaged_append", errors)
    _check(ml_preflight_policy.get("no_silent_106_fallback") is True, "ml_feature_migration_allows_silent_106_fallback", errors)
    _check(ml_preflight_policy.get("explicit_wei_approval_for_current_cutover") == "approved_in_session_2026_06_19", "ml_feature_migration_current_cutover_not_approved", errors)
    _check(monthly_defaults.get("factor_universe") == "unified_registry_v1", "monthly_factor_universe_not_unified_registry", errors)
    _check(monthly_defaults.get("algorithm") == "pymoo", "monthly_algorithm_not_pymoo", errors)
    _check(schedule.get("cadence") == "monthly", "monthly_cadence_not_monthly", errors)
    _check(schedule.get("requires_finlab_backtest") is True, "monthly_finlab_backtest_not_required", errors)
    _check(promotion.get("decision_effect") == "governance_contract_only", "promotion_contract_has_runtime_effect", errors)
    _check(promotion_guards.get("no_direct_daily_buy_path") is True, "promotion_allows_direct_daily_buy_path", errors)
    _check(promotion_guards.get("explicit_wei_approval_required_for_production") is True, "promotion_missing_explicit_wei_approval", errors)
    _check(materialization.get("pass") is True, "materialization_audit_failed", errors)
    _check(materialization.get("schema_version") == "stockvision-unified137-materialization-audit-v1", "materialization_schema_version_mismatch", errors)
    _check(_same_path(materialization.get("registry"), FILES["registry"]), "materialization_registry_path_mismatch", errors)
    _check(materialization_fresh, "materialization_artifact_older_than_registry", errors)
    _check(materialization_date_range.get("start_date") == "2023-01-01", "materialization_start_date_mismatch", errors)
    _check(materialization_date_range.get("end_date") == "2026-06-15", "materialization_end_date_mismatch", errors)
    _check(materialization_date_range.get("universe") == "sii", "materialization_universe_mismatch", errors)
    _check(int(materialization_date_range.get("max_symbols") or 0) == 0, "materialization_max_symbols_mismatch", errors)
    _check(int(materialization_counts.get("eligible_for_alpha_mining") or 0) == formal_count, "materialization_eligible_count_mismatch", errors)
    _check(int(materialization_counts.get("mapped_factor_count") or 0) == 137, "materialization_mapped_factor_count_not_137", errors)
    _check(int(materialization_counts.get("missing_expected_count") or 0) == 0, "materialization_missing_expected_present", errors)
    _check(int(materialization_counts.get("zero_coverage_count") or 0) == 0, "materialization_zero_coverage_present", errors)

    if int(similarity_counts.get("similarity_refresh_required") or 0) > 0:
        warnings.append(f"similarity_refresh_required={similarity_counts.get('similarity_refresh_required')}")
    if ml_preflight_gates.get("production_activation") != "pass":
        warnings.append("formal137_production_activation_not_pass")
    if int(materialization_counts.get("very_low_coverage_count") or 0) > 0:
        warnings.append(f"materialization_very_low_coverage={materialization_counts.get('very_low_coverage_count')}")

    result = {
        "schema_version": "stockvision-feature-registry-local-closure-v1",
        "status": "pass" if not errors else "fail",
        "errors": errors,
        "warnings": warnings,
        "counts": {
            "registry_features": len(registry_features),
            "formal_alpha_mining_features": formal_count,
            "similarity_pair_rows": similarity_counts.get("pair_rows"),
            "similarity_refresh_required": similarity_counts.get("similarity_refresh_required"),
            "feature_view_counts": view_counts,
            "strategy_count": strategy_counts.get("strategies"),
            "strategy_ref_blockers": strategy_counts.get("blockers"),
            "ml_feature_cols_current": ml_counts.get("feature_cols"),
            "ml_training_view_candidates": ml_counts.get("formal137_ml_training_view"),
            "ml_formal137_not_in_current_feature_cols": ml_counts.get("formal137_not_in_current_feature_cols"),
            "ml_migration_preflight_status": ml_migration_preflight.get("status"),
            "ml_migration_materialization_blockers": ml_preflight_counts.get("materialization_blocker_count"),
            "ml_migration_production_activation": ml_preflight_gates.get("production_activation"),
            "monthly_algorithm": monthly_defaults.get("algorithm"),
            "monthly_cadence": schedule.get("cadence"),
            "promotion_seeded_strategies": (promotion.get("current_explicit_seed") or {}).get("seeded_strategy_ids"),
            "materialization_mapped_factor_count": materialization_counts.get("mapped_factor_count"),
            "materialization_artifact_fresh": materialization_fresh,
            "materialization_runtime_seconds": materialization.get("runtime_seconds"),
            "materialization_zero_coverage_count": materialization_counts.get("zero_coverage_count"),
            "materialization_very_low_coverage_count": materialization_counts.get("very_low_coverage_count"),
            "materialization_very_low_coverage": materialization.get("very_low_coverage"),
            "derived_artifact_freshness": derived_freshness,
        },
        "decision_effect": "local_validation_only",
    }
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> int:
    result = validate()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
