from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "tools" / "build_ml_feature_migration_preflight.py"
CONTRACT = ROOT / "data" / "feature_registry" / "ml_feature_migration_preflight_v1.json"
ML_SELECTION = ROOT / "data" / "feature_registry" / "ml_feature_selection_contract_v1.json"


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot_load_module:{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _assert(condition: bool, reason: str, errors: list[str]) -> None:
    if not condition:
        errors.append(reason)


def main() -> int:
    builder = _load_module(BUILDER, "stockvision_ml_feature_migration_preflight_builder")
    builder.main()
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    ml_selection = json.loads(ML_SELECTION.read_text(encoding="utf-8"))
    errors: list[str] = []

    policy = contract.get("policy") or {}
    counts = contract.get("counts") or {}
    gates = contract.get("gate_status") or {}
    migration_ids = contract.get("migration_candidates") or []
    expected_ids = ml_selection.get("formal137_not_in_current_feature_cols") or []

    _assert(contract.get("schema_version") == "stockvision-ml-feature-migration-preflight-v1", "invalid_schema_version", errors)
    _assert(contract.get("decision_effect") == "local_validation_only", "preflight_must_be_local_validation_only", errors)
    _assert(policy.get("runtime_feature_schema") == "formal137", "runtime_schema_not_formal137", errors)
    _assert(policy.get("no_direct_unmanaged_feature_append") is True, "unmanaged_feature_append_not_blocked", errors)
    _assert(policy.get("no_silent_106_fallback") is True, "silent_106_fallback_not_blocked", errors)
    _assert(policy.get("retrain_required_before_activation") is True, "retrain_not_required_before_activation", errors)
    _assert(policy.get("release_gate_required_before_activation") is True, "release_gate_not_required_before_activation", errors)
    _assert(policy.get("explicit_approval_marker") == "approved_in_session_2026_06_19", "formal137_cutover_approval_marker_missing", errors)
    _assert(int(counts.get("migration_candidate_count") or 0) == len(expected_ids), "migration_candidate_count_mismatch", errors)
    _assert(len(migration_ids) == len(expected_ids), "migration_candidate_rows_mismatch", errors)
    _assert(int(counts.get("materialization_blocker_count") or 0) == 0, "materialization_blockers_present", errors)
    _assert(counts.get("materialization_audit_fresh") is True, "materialization_audit_not_fresh", errors)
    _assert(counts.get("materialization_contract_ready") is True, "materialization_contract_not_ready", errors)
    _assert(gates.get("no_unmapped_current_feature_cols") == "pass", "unmapped_current_feature_cols", errors)
    _assert(gates.get("direct_finlab_materialization_ready") == "pass", "direct_finlab_materialization_not_ready", errors)
    _assert(gates.get("materialization_audit_fresh") == "pass", "materialization_audit_fresh_gate_failed", errors)
    _assert(gates.get("materialization_contract_ready") == "pass", "materialization_contract_ready_gate_failed", errors)
    _assert(gates.get("similarity_contract_ready") == "pass", "similarity_contract_not_ready", errors)
    _assert(gates.get("no_201_invariant") == "pass", "no_201_invariant_failed", errors)
    _assert(gates.get("production_activation") == "pass", "production_activation_not_ready", errors)

    status = "pass" if not errors else "fail"
    print(json.dumps({
        "status": status,
        "errors": errors,
        "counts": counts,
        "gate_status": gates,
    }, ensure_ascii=False, indent=2))
    return 0 if status == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
