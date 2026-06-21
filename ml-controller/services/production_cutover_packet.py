from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "stockvision-production-cutover-packet-v1"

DEFAULT_LOCAL_AUDIT_PATH = "ml-service/benchmark_results/local_prod_ready_audit_20260618.json"

REQUIRED_EVIDENCE_FILES = (
    DEFAULT_LOCAL_AUDIT_PATH,
    "ml-service/benchmark_results/adaptive_meta_policy_replay_20260605_20260611.json",
    "ml-service/benchmark_results/linucb_multiplier_replay_20260605_20260611.json",
    "ml-service/benchmark_results/production_cutover_remote_preflight_20260618.json",
    "output/feature_universe_triage/feature_registry_local_closure_20260617.json",
    "output/feature_universe_triage/unified137_materialization_audit_sii_20230101_20260615.json",
    "output/feature_universe_triage/alpha_mining_similarity_novelty_validation_20260618.json",
    "output/feature_universe_triage/monthly_pymoo_runtime_contract_validation_20260618.json",
    "data/feature_registry/unified_feature_registry_v1.json",
    "data/feature_registry/feature_view_contract_v1.json",
    "data/feature_registry/ml_feature_selection_contract_v1.json",
    "data/feature_registry/ml_feature_migration_preflight_v1.json",
    "data/feature_registry/strategy_feature_ref_contract_v1.json",
    "data/feature_registry/alpha_mining_promotion_contract_v1.json",
    "data/feature_registry/pymoo_monthly_mining_config_v1.json",
    "data/feature_registry/formal137_similarity_contract_v1.json",
    "worker/migration_strategy_registry_alpha_miner_2026_06_17.sql",
    "worker/migration_strategy_mining_ledger_2026_06_18.sql",
)

APPROVAL_REQUIRED_ACTIONS = (
    {
        "id": "deploy_worker_and_frontend",
        "approval_gate": "wei_explicit_approval_required",
        "mutation_scope": "Cloudflare Worker / frontend production deploy",
    },
    {
        "id": "deploy_ml_controller_strategy_mining_route",
        "approval_gate": "wei_explicit_approval_required",
        "mutation_scope": "Cloud Run ml-controller revision with /strategy_mining/monthly_pymoo/run",
    },
    {
        "id": "apply_strategy_registry_alpha_miner_migration",
        "approval_gate": "wei_explicit_approval_required",
        "mutation_scope": "Cloudflare D1 strategy_spec_registry seed/update for alpha miner strategy rows",
    },
    {
        "id": "apply_strategy_mining_ledger_migration",
        "approval_gate": "wei_explicit_approval_required",
        "mutation_scope": "Cloudflare D1 strategy mining ledger table creation",
    },
    {
        "id": "sync_gcp_scheduler_manifest",
        "approval_gate": "wei_explicit_approval_required",
        "mutation_scope": "GCP Scheduler production job create/update",
    },
    {
        "id": "write_or_promote_gcs_model_artifacts",
        "approval_gate": "wei_explicit_approval_required",
        "mutation_scope": "GCS model artifact write or champion artifact promotion",
    },
    {
        "id": "update_model_pool_champion_pointers",
        "approval_gate": "wei_explicit_approval_required",
        "mutation_scope": "production model_pool champion pointer update",
    },
    {
        "id": "remove_challenger_pointers_after_approved_cutover",
        "approval_gate": "wei_explicit_approval_required",
        "mutation_scope": "production challenger/shadow pointer cleanup",
    },
    {
        "id": "enable_strategy_mining_execution_env",
        "approval_gate": "wei_explicit_approval_required",
        "mutation_scope": "STRATEGY_MINING_EXECUTION_ENABLED=1 and STRATEGY_MINING_BACKEND=modal production env binding",
    },
    {
        "id": "feature_selection_retrain_release",
        "approval_gate": "wei_explicit_approval_required",
        "mutation_scope": "production ML feature schema retrain/release on the active formal137 artifact schema",
    },
)

REMOTE_PREFLIGHT_CHECKS = (
    {
        "id": "scheduler_actual_matches_manifest",
        "check_type": "remote_read_only",
        "expected": "weekly-optuna, monthly-optuna, monthly-strategy-mining, optuna-queue, adaptive-meta-policy-replay, linucb-multiplier-replay exist in GCP Scheduler",
    },
    {
        "id": "d1_strategy_mining_ledger_tables_exist",
        "check_type": "remote_read_only",
        "expected": "strategy_mining_runs, strategy_mining_candidates, strategy_backtest_results, active_strategy_backtest_results, strategy_similarity_matrix, strategy_promotion_ledger exist in remote D1 after approved migration apply",
    },
    {
        "id": "ml_controller_strategy_mining_route_ready",
        "check_type": "remote_read_only",
        "expected": "/strategy_mining/monthly_pymoo/run returns preflight_ready or blocked without allowing production mutation",
    },
    {
        "id": "strategy_mining_execution_env_gated",
        "check_type": "remote_read_only",
        "expected": "STRATEGY_MINING_EXECUTION_ENABLED=false until Wei approval; true is expected after approved strategy-mining execution cutover",
    },
    {
        "id": "sequence_artifacts_are_neuralforecast_zip",
        "check_type": "remote_read_only",
        "expected": "PatchTST and iTransformer production artifact slots point to NeuralForecast-backed zip artifacts",
    },
    {
        "id": "timesfm_active_slot_uses_25_config",
        "check_type": "remote_read_only",
        "expected": "TimesFM production slot config references google/timesfm-2.5-200m-pytorch and max_context >= 1024",
    },
    {
        "id": "active9_model_pool_has_no_retired_champion",
        "check_type": "remote_read_only",
        "expected": "production model_pool champion set contains only the active-9 ML families",
    },
    {
        "id": "challenger_cleanup_scope_is_explicit",
        "check_type": "remote_read_only",
        "expected": "shadow/challenger rows are removed only after approved champion cutover evidence is captured",
    },
)

LOCAL_AUDIT_SELF_REFRESH_CHECK_IDS = {
    "roadmap:p12:production_cutover_packet_artifact_fresh",
    "roadmap:p2:alpha_mining_similarity_validation_artifact_fresh",
    "roadmap:p8:monthly_pymoo_runtime_contract_validation_artifact_fresh",
}

FEATURE_REGISTRY_CLOSURE_DEPENDENCIES = (
    "data/feature_registry/unified_feature_registry_v1.json",
    "data/feature_registry/formal137_similarity_contract_v1.json",
    "data/feature_registry/feature_view_contract_v1.json",
    "data/feature_registry/strategy_feature_ref_contract_v1.json",
    "data/feature_registry/ml_feature_selection_contract_v1.json",
    "data/feature_registry/ml_feature_migration_preflight_v1.json",
    "data/feature_registry/alpha_mining_promotion_contract_v1.json",
    "output/feature_universe_triage/unified137_materialization_audit_sii_20230101_20260615.json",
)

MATERIALIZATION_DEPENDENCIES = (
    "data/feature_registry/unified_feature_registry_v1.json",
)

ACTIVE_STRATEGY_BASELINE_DIR = "output/finlab_strategy_backtests"
ACTIVE_STRATEGY_SPEC_EXPORTER = "tools/export_active_strategy_specs_from_d1.py"
ACTIVE_STRATEGY_BACKTEST_TOOL = "tools/finlab_strategy_spec_backtest.py"

ALPHA_MINING_SIMILARITY_AUDIT_CHECK_IDS = (
    "roadmap:p2:alpha_mining_similarity_matrix_only_fail_closed",
    "roadmap:p2:alpha_mining_no_self_similarity_fill",
    "roadmap:p2:alpha_mining_similarity_validator",
    "roadmap:p2:alpha_mining_similarity_validation_artifact",
    "roadmap:p2:alpha_mining_similarity_validation_artifact_fresh",
)

MONTHLY_PYMOO_RUNTIME_AUDIT_CHECK_IDS = (
    "roadmap:p8:monthly_alpha_miner_cli_defaults_pymoo_only",
    "roadmap:p8:monthly_pymoo_runtime_contract_validation_artifact",
    "roadmap:p8:monthly_pymoo_runtime_contract_validation_artifact_fresh",
)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _resolve(root: Path, rel_path: str) -> Path:
    path = Path(rel_path)
    return path if path.is_absolute() else root / path


def _repo_rel(root: Path, path: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def _latest_by_mtime(paths: list[Path]) -> Path | None:
    return max(paths, key=lambda path: path.stat().st_mtime) if paths else None


def _safe_json_path(path: Path | None) -> tuple[Any | None, str | None]:
    if path is None or not path.exists():
        return None, None
    try:
        return _read_json(path), None
    except (OSError, json.JSONDecodeError) as exc:
        return None, type(exc).__name__


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _active_strategy_baseline_context(root: Path) -> dict[str, Any]:
    output_dir = _resolve(root, ACTIVE_STRATEGY_BASELINE_DIR)
    export_summary_path = _latest_by_mtime(list(output_dir.glob("current_active_*_strategy_specs_summary.json")))
    export_summary, export_summary_error = _safe_json_path(export_summary_path)
    strategy_count = _safe_int((export_summary or {}).get("strategy_count")) if isinstance(export_summary, dict) else 0

    spec_path: Path | None = None
    if isinstance(export_summary, dict):
        spec_rel = str(export_summary.get("json") or "").strip()
        if spec_rel:
            spec_path = _resolve(root, spec_rel)
    if spec_path is None and strategy_count > 0:
        spec_path = output_dir / f"current_active_{strategy_count}_strategy_specs.json"

    backtest_summary_path: Path | None = None
    if strategy_count > 0:
        backtest_summary_path = _latest_by_mtime(list(output_dir.glob(f"finlab_strategy_spec_active{strategy_count}_*_summary.json")))
    if backtest_summary_path is None:
        backtest_summary_path = _latest_by_mtime(list(output_dir.glob("finlab_strategy_spec_active*_summary.json")))

    backtest_json_path: Path | None = None
    if backtest_summary_path is not None:
        backtest_json_path = Path(str(backtest_summary_path).removesuffix("_summary.json") + ".json")

    return {
        "exporter_path": _resolve(root, ACTIVE_STRATEGY_SPEC_EXPORTER),
        "backtest_tool_path": _resolve(root, ACTIVE_STRATEGY_BACKTEST_TOOL),
        "export_summary_path": export_summary_path,
        "export_summary": export_summary if isinstance(export_summary, dict) else {},
        "export_summary_error": export_summary_error,
        "strategy_count": strategy_count,
        "spec_path": spec_path,
        "backtest_summary_path": backtest_summary_path,
        "backtest_json_path": backtest_json_path,
    }


def _dynamic_inventory_row(root: Path, row_id: str, path: Path | None, missing_pattern: str) -> dict[str, Any]:
    return {
        "id": row_id,
        "path": _repo_rel(root, path) if path is not None else missing_pattern,
        "required": True,
        "dynamic": True,
        "exists": bool(path is not None and path.exists()),
    }


def _active_strategy_baseline_inventory(root: Path) -> list[dict[str, Any]]:
    ctx = _active_strategy_baseline_context(root)
    return [
        _dynamic_inventory_row(root, "active_strategy_spec_exporter_source", ctx["exporter_path"], ACTIVE_STRATEGY_SPEC_EXPORTER),
        _dynamic_inventory_row(root, "active_strategy_backtest_tool_source", ctx["backtest_tool_path"], ACTIVE_STRATEGY_BACKTEST_TOOL),
        _dynamic_inventory_row(
            root,
            "active_strategy_spec_export_summary",
            ctx["export_summary_path"],
            f"{ACTIVE_STRATEGY_BASELINE_DIR}/current_active_*_strategy_specs_summary.json",
        ),
        _dynamic_inventory_row(
            root,
            "active_strategy_spec_json",
            ctx["spec_path"],
            f"{ACTIVE_STRATEGY_BASELINE_DIR}/current_active_*_strategy_specs.json",
        ),
        _dynamic_inventory_row(
            root,
            "active_strategy_finlab_backtest_summary",
            ctx["backtest_summary_path"],
            f"{ACTIVE_STRATEGY_BASELINE_DIR}/finlab_strategy_spec_active*_summary.json",
        ),
        _dynamic_inventory_row(
            root,
            "active_strategy_finlab_backtest_json",
            ctx["backtest_json_path"],
            f"{ACTIVE_STRATEGY_BASELINE_DIR}/finlab_strategy_spec_active*.json",
        ),
    ]


def _evidence_inventory(root: Path) -> list[dict[str, Any]]:
    inventory: list[dict[str, Any]] = []
    for rel_path in REQUIRED_EVIDENCE_FILES:
        path = _resolve(root, rel_path)
        inventory.append({
            "path": rel_path,
            "required": True,
            "exists": path.exists(),
        })
    inventory.extend(_active_strategy_baseline_inventory(root))
    return inventory


def _safe_json(root: Path, rel_path: str) -> dict[str, Any]:
    path = _resolve(root, rel_path)
    if not path.exists():
        return {}
    data = _read_json(path)
    return data if isinstance(data, dict) else {}


def _artifact_fresh(root: Path, artifact_rel: str, dependency_rels: tuple[str, ...]) -> tuple[bool, list[str]]:
    artifact = _resolve(root, artifact_rel)
    if not artifact.exists():
        return False, [artifact_rel]
    stale_against: list[str] = []
    artifact_mtime = artifact.stat().st_mtime
    for dependency_rel in dependency_rels:
        dependency = _resolve(root, dependency_rel)
        if not dependency.exists() or artifact_mtime + 1e-6 < dependency.stat().st_mtime:
            stale_against.append(dependency_rel)
    return not stale_against, stale_against


def _all_derived_fresh(local_closure: dict[str, Any]) -> bool:
    derived = ((local_closure.get("counts") or {}).get("derived_artifact_freshness") or {})
    return bool(derived) and all(
        isinstance(row, dict) and row.get("fresh") is True
        for row in derived.values()
    )


def _promotion_sources_fresh(root: Path, promotion: dict[str, Any]) -> tuple[bool, list[str]]:
    source_contracts = promotion.get("source_contracts") if isinstance(promotion.get("source_contracts"), dict) else {}
    promotion_path = _resolve(root, "data/feature_registry/alpha_mining_promotion_contract_v1.json")
    if not promotion_path.exists():
        return False, ["data/feature_registry/alpha_mining_promotion_contract_v1.json"]
    stale_against: list[str] = []
    promotion_mtime = promotion_path.stat().st_mtime
    for name, raw_path in source_contracts.items():
        if not isinstance(raw_path, str) or not raw_path.strip():
            stale_against.append(str(name))
            continue
        source_path = Path(raw_path)
        if not source_path.is_absolute():
            source_path = root / source_path
        if not source_path.exists() or promotion_mtime + 1e-6 < source_path.stat().st_mtime:
            stale_against.append(str(name))
    return not stale_against, stale_against


def _freshness_detail(root: Path, path: Path | None, dependencies: tuple[str, ...]) -> dict[str, Any]:
    if path is None:
        return {"fresh": False, "stale_against": ["missing_artifact"]}
    fresh, stale_against = _artifact_fresh(root, _repo_rel(root, path), dependencies)
    return {"fresh": fresh, "stale_against": stale_against}


def _active_strategy_baseline_health(root: Path) -> dict[str, Any]:
    ctx = _active_strategy_baseline_context(root)
    errors: list[str] = []
    detail: dict[str, Any] = {
        "strategy_count": ctx["strategy_count"],
        "exporter_path": _repo_rel(root, ctx["exporter_path"]),
        "backtest_tool_path": _repo_rel(root, ctx["backtest_tool_path"]),
        "export_summary_path": _repo_rel(root, ctx["export_summary_path"]) if ctx["export_summary_path"] is not None else None,
        "spec_path": _repo_rel(root, ctx["spec_path"]) if ctx["spec_path"] is not None else None,
        "backtest_summary_path": _repo_rel(root, ctx["backtest_summary_path"]) if ctx["backtest_summary_path"] is not None else None,
        "backtest_json_path": _repo_rel(root, ctx["backtest_json_path"]) if ctx["backtest_json_path"] is not None else None,
    }

    exporter_path = ctx["exporter_path"]
    if not exporter_path.exists():
        errors.append("missing_active_strategy_spec_exporter")
    else:
        exporter_text = exporter_path.read_text(encoding="utf-8", errors="ignore")
        exporter_markers = (
            "read_only_d1_export",
            "production_mutation_allowed",
            "strategy_spec_registry",
            "SELECT_ACTIVE_STRATEGIES_SQL_ONE_LINE",
        )
        if not all(marker in exporter_text for marker in exporter_markers):
            errors.append("active_strategy_spec_exporter_missing_readonly_markers")

    if not ctx["backtest_tool_path"].exists():
        errors.append("missing_active_strategy_backtest_tool")

    export_summary = ctx["export_summary"]
    if ctx["export_summary_error"]:
        errors.append(f"active_strategy_export_summary_json_error:{ctx['export_summary_error']}")
    if not export_summary:
        errors.append("missing_active_strategy_export_summary")
    else:
        if export_summary.get("decision_effect") != "read_only_d1_export" or export_summary.get("production_mutation_allowed") is not False:
            errors.append("active_strategy_export_summary_not_readonly")
        if _safe_int(export_summary.get("strategy_count")) <= 0:
            errors.append("active_strategy_export_summary_empty")
        if export_summary.get("errors"):
            errors.append("active_strategy_export_summary_has_errors")

    specs, spec_error = _safe_json_path(ctx["spec_path"])
    if spec_error:
        errors.append(f"active_strategy_spec_json_error:{spec_error}")
    if not isinstance(specs, list):
        errors.append("active_strategy_spec_json_missing_or_not_list")
    else:
        if len(specs) != ctx["strategy_count"]:
            errors.append("active_strategy_spec_json_count_mismatch")
        clean_arrays = all(
            isinstance(spec, dict)
            and isinstance(spec.get("supportedRegimes"), list)
            and isinstance(spec.get("riskNotes"), list)
            for spec in specs
        )
        if not clean_arrays:
            errors.append("active_strategy_spec_json_array_shape_invalid")

    backtest_summary, backtest_summary_error = _safe_json_path(ctx["backtest_summary_path"])
    if backtest_summary_error:
        errors.append(f"active_strategy_backtest_summary_json_error:{backtest_summary_error}")
    if not isinstance(backtest_summary, dict):
        errors.append("missing_active_strategy_backtest_summary")
    else:
        ok = _safe_int(backtest_summary.get("ok"))
        no_signal = _safe_int(backtest_summary.get("no_signal"))
        unsupported_feature = _safe_int(backtest_summary.get("unsupported_feature"))
        detail.update({
            "backtest_ok": ok,
            "backtest_no_signal": no_signal,
            "backtest_unsupported_feature": unsupported_feature,
            "backtest_errors": backtest_summary.get("errors") or [],
        })
        if _safe_int(backtest_summary.get("strategy_count")) != ctx["strategy_count"]:
            errors.append("active_strategy_backtest_count_mismatch")
        if ok + no_signal + unsupported_feature != ctx["strategy_count"] or backtest_summary.get("errors"):
            errors.append("active_strategy_backtest_not_accounted_or_has_errors")

    backtest_json, backtest_json_error = _safe_json_path(ctx["backtest_json_path"])
    if backtest_json_error:
        errors.append(f"active_strategy_backtest_json_error:{backtest_json_error}")
    if backtest_json is None:
        errors.append("missing_active_strategy_backtest_json")

    spec_rel = _repo_rel(root, ctx["spec_path"]) if ctx["spec_path"] is not None else ""
    detail["freshness"] = {
        "export_summary": _freshness_detail(root, ctx["export_summary_path"], (ACTIVE_STRATEGY_SPEC_EXPORTER,)),
        "spec_json": _freshness_detail(root, ctx["spec_path"], (ACTIVE_STRATEGY_SPEC_EXPORTER,)),
        "backtest_summary": _freshness_detail(root, ctx["backtest_summary_path"], tuple(
            dep for dep in (spec_rel, ACTIVE_STRATEGY_BACKTEST_TOOL) if dep
        )),
        "backtest_json": _freshness_detail(root, ctx["backtest_json_path"], tuple(
            dep for dep in (spec_rel, ACTIVE_STRATEGY_BACKTEST_TOOL) if dep
        )),
    }
    stale_freshness = [
        name
        for name, row in detail["freshness"].items()
        if not row.get("fresh")
    ]
    if stale_freshness:
        errors.append(f"active_strategy_baseline_stale:{','.join(stale_freshness)}")

    detail["errors"] = errors
    return {
        "id": "active_strategy_baseline_export_and_backtest",
        "passed": not errors,
        "detail": detail,
    }


def _local_audit_check_group_health(
    audit: dict[str, Any],
    *,
    group_id: str,
    expected_check_ids: tuple[str, ...],
    description: str,
) -> dict[str, Any]:
    checks = audit.get("checks") if isinstance(audit.get("checks"), list) else []
    by_id = {
        str(row.get("id")): row
        for row in checks
        if isinstance(row, dict) and row.get("id")
    }
    missing = [check_id for check_id in expected_check_ids if check_id not in by_id]
    failed = [
        check_id
        for check_id in expected_check_ids
        if check_id in by_id and by_id[check_id].get("status") != "pass"
    ]
    return {
        "id": group_id,
        "passed": not missing and not failed,
        "detail": {
            "description": description,
            "expected_check_ids": list(expected_check_ids),
            "missing_check_ids": missing,
            "failed_check_ids": failed,
            "statuses": {
                check_id: (by_id.get(check_id) or {}).get("status")
                for check_id in expected_check_ids
            },
        },
    }


def _evidence_health(root: Path, audit: dict[str, Any]) -> list[dict[str, Any]]:
    local_closure = _safe_json(root, "output/feature_universe_triage/feature_registry_local_closure_20260617.json")
    materialization = _safe_json(root, "output/feature_universe_triage/unified137_materialization_audit_sii_20230101_20260615.json")
    migration = _safe_json(root, "data/feature_registry/ml_feature_migration_preflight_v1.json")
    promotion = _safe_json(root, "data/feature_registry/alpha_mining_promotion_contract_v1.json")
    feature_refs = _safe_json(root, "data/feature_registry/strategy_feature_ref_contract_v1.json")
    closure_fresh, closure_stale_against = _artifact_fresh(
        root,
        "output/feature_universe_triage/feature_registry_local_closure_20260617.json",
        FEATURE_REGISTRY_CLOSURE_DEPENDENCIES,
    )
    materialization_fresh, materialization_stale_against = _artifact_fresh(
        root,
        "output/feature_universe_triage/unified137_materialization_audit_sii_20230101_20260615.json",
        MATERIALIZATION_DEPENDENCIES,
    )
    migration_gates = migration.get("gate_status") or {}
    promotion_fresh, promotion_stale_against = _promotion_sources_fresh(root, promotion)
    health = [
        {
            "id": "feature_registry_local_closure_pass",
            "passed": (
                local_closure.get("status") == "pass"
                and closure_fresh
                and _all_derived_fresh(local_closure)
            ),
            "detail": {
                "status": local_closure.get("status"),
                "feature_views": ((local_closure.get("counts") or {}).get("feature_view_counts") or {}),
                "strategy_count": (local_closure.get("counts") or {}).get("strategy_count"),
                "artifact_fresh": closure_fresh,
                "stale_against": closure_stale_against,
                "derived_artifact_freshness": ((local_closure.get("counts") or {}).get("derived_artifact_freshness") or {}),
            },
        },
        {
            "id": "unified137_materialization_pass",
            "passed": materialization.get("pass") is True and materialization_fresh,
            "detail": {
                "mapped_factor_count": (materialization.get("counts") or {}).get("mapped_factor_count"),
                "zero_coverage_count": (materialization.get("counts") or {}).get("zero_coverage_count"),
                "very_low_coverage_count": (materialization.get("counts") or {}).get("very_low_coverage_count"),
                "artifact_fresh": materialization_fresh,
                "stale_against": materialization_stale_against,
            },
        },
        {
            "id": "ml_feature_migration_preflight_ready",
            "passed": (
                migration.get("status") == "preflight_ready"
                and migration_gates.get("materialization_audit_fresh") == "pass"
                and migration_gates.get("materialization_contract_ready") == "pass"
            ),
            "detail": {
                "status": migration.get("status"),
                "production_activation": migration_gates.get("production_activation"),
                "migration_candidate_count": (migration.get("counts") or {}).get("migration_candidate_count"),
                "materialization_blocker_count": (migration.get("counts") or {}).get("materialization_blocker_count"),
                "materialization_audit_fresh": migration_gates.get("materialization_audit_fresh"),
                "materialization_contract_ready": migration_gates.get("materialization_contract_ready"),
            },
        },
        {
            "id": "alpha_mining_promotion_contract_governance_only",
            "passed": promotion.get("decision_effect") == "governance_contract_only" and promotion_fresh,
            "detail": {
                "decision_effect": promotion.get("decision_effect"),
                "monthly_cadence": (promotion.get("monthly_search_policy") or {}).get("cadence"),
                "requires_finlab_backtest": (promotion.get("monthly_search_policy") or {}).get("requires_finlab_backtest"),
                "source_contracts_fresh": promotion_fresh,
                "stale_against": promotion_stale_against,
            },
        },
        {
            "id": "strategy_feature_refs_no_blockers",
            "passed": ((feature_refs.get("counts") or {}).get("blockers") == 0),
            "detail": {
                "strategies": (feature_refs.get("counts") or {}).get("strategies"),
                "refs": (feature_refs.get("counts") or {}).get("refs"),
                "blockers": (feature_refs.get("counts") or {}).get("blockers"),
            },
        },
    ]
    health.append(_active_strategy_baseline_health(root))
    health.append(_local_audit_check_group_health(
        audit,
        group_id="local_audit_alpha_mining_similarity_fail_closed_gates",
        expected_check_ids=ALPHA_MINING_SIMILARITY_AUDIT_CHECK_IDS,
        description="local audit proves alpha mining novelty uses formal137 matrix-only fail-closed similarity",
    ))
    health.append(_local_audit_check_group_health(
        audit,
        group_id="local_audit_monthly_pymoo_runtime_contract_gates",
        expected_check_ids=MONTHLY_PYMOO_RUNTIME_AUDIT_CHECK_IDS,
        description="local audit proves monthly strategy mining uses pymoo-only runtime contract and durable validation artifact",
    ))
    return health


def _local_gate(audit: dict[str, Any], audit_path: str) -> dict[str, Any]:
    failed_checks = audit.get("failed_checks") or []
    failed_check_ids = {
        str(row.get("id") if isinstance(row, dict) else row)
        for row in failed_checks
    }
    self_refresh_only = bool(failed_check_ids) and failed_check_ids.issubset(LOCAL_AUDIT_SELF_REFRESH_CHECK_IDS)
    normal_passed = (
        audit.get("local_closure") == "done"
        and audit.get("local_prod_ready") == "done"
        and len(failed_checks) == 0
    )
    passed = normal_passed or self_refresh_only
    return {
        "audit_path": audit_path,
        "local_closure": audit.get("local_closure"),
        "local_prod_ready": audit.get("local_prod_ready"),
        "failed_check_count": len(failed_checks),
        "self_refresh_only": self_refresh_only,
        "passed": passed,
    }


def build_production_cutover_packet(
    repo_root: Path | None = None,
    local_audit_path: str = DEFAULT_LOCAL_AUDIT_PATH,
) -> dict[str, Any]:
    root = repo_root or _repo_root()
    audit_file = _resolve(root, local_audit_path)
    audit_exists = audit_file.exists()
    audit = _read_json(audit_file) if audit_exists else {}

    local_gate = _local_gate(audit, local_audit_path)
    evidence = _evidence_inventory(root)
    evidence_ready = all(item["exists"] for item in evidence)
    evidence_health = _evidence_health(root, audit)
    evidence_health_ready = all(item["passed"] for item in evidence_health)
    remote_preflight = _safe_json(root, "ml-service/benchmark_results/production_cutover_remote_preflight_20260618.json")
    remote_preflight_summary = remote_preflight.get("summary") if isinstance(remote_preflight.get("summary"), dict) else {}
    audit_is_non_mutating = (
        audit.get("promotion_allowed") is False
        and audit.get("production_mutation_allowed") is False
    )
    ready_for_review = bool(
        audit_exists
        and local_gate["passed"]
        and evidence_ready
        and evidence_health_ready
        and audit_is_non_mutating
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "cutover_ready_for_review": ready_for_review,
        "production_mutation_allowed": False,
        "actions_allowed_without_wei_approval": [],
        "local_gate": local_gate,
        "evidence_inventory": evidence,
        "evidence_health": evidence_health,
        "remote_preflight_summary": remote_preflight_summary,
        "remote_cutover_complete": bool(remote_preflight_summary.get("remote_cutover_complete")),
        "approval_required_actions": list(APPROVAL_REQUIRED_ACTIONS),
        "remote_preflight_checks": list(REMOTE_PREFLIGHT_CHECKS),
        "blocked_reason": None if ready_for_review else {
            "audit_exists": audit_exists,
            "local_gate_passed": local_gate["passed"],
            "evidence_ready": evidence_ready,
            "evidence_health_ready": evidence_health_ready,
            "audit_is_non_mutating": audit_is_non_mutating,
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the StockVision production cutover packet.")
    parser.add_argument("--repo", default=str(_repo_root()))
    parser.add_argument(
        "--output",
        default=str(_repo_root() / "ml-service/benchmark_results/production_cutover_packet_20260618.json"),
    )
    parser.add_argument("--local-audit-path", default=DEFAULT_LOCAL_AUDIT_PATH)
    args = parser.parse_args(argv)

    packet = build_production_cutover_packet(Path(args.repo), args.local_audit_path)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(packet, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "output": str(output_path),
        "cutover_ready_for_review": packet.get("cutover_ready_for_review"),
        "remote_cutover_complete": packet.get("remote_cutover_complete"),
        "production_mutation_allowed": packet.get("production_mutation_allowed"),
        "evidence_health_ready": all(row.get("passed") is True for row in packet.get("evidence_health") or []),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
