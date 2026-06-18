from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.production_cutover_packet import build_production_cutover_packet, main


def _write(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")


def _set_mtime(path: Path, timestamp: float) -> None:
    os.utime(path, (timestamp, timestamp))


def _seed_ready_evidence(root: Path, audit_payload: dict[str, object] | None = None) -> None:
    audit = audit_payload or {
        "local_closure": "done",
        "local_prod_ready": "done",
        "failed_checks": [],
        "promotion_allowed": False,
        "production_mutation_allowed": False,
    }
    audit.setdefault("checks", [
        {"id": "roadmap:p2:alpha_mining_similarity_matrix_only_fail_closed", "status": "pass"},
        {"id": "roadmap:p2:alpha_mining_no_self_similarity_fill", "status": "pass"},
        {"id": "roadmap:p2:alpha_mining_similarity_validator", "status": "pass"},
        {"id": "roadmap:p2:alpha_mining_similarity_validation_artifact", "status": "pass"},
        {"id": "roadmap:p2:alpha_mining_similarity_validation_artifact_fresh", "status": "pass"},
        {"id": "roadmap:p8:monthly_alpha_miner_cli_defaults_pymoo_only", "status": "pass"},
        {"id": "roadmap:p8:monthly_pymoo_runtime_contract_validation_artifact", "status": "pass"},
        {"id": "roadmap:p8:monthly_pymoo_runtime_contract_validation_artifact_fresh", "status": "pass"},
    ])
    _write(
        root / "ml-service/benchmark_results/local_prod_ready_audit_20260618.json",
        json.dumps(audit),
    )
    _write(
        root / "ml-service/benchmark_results/adaptive_meta_policy_replay_20260605_20260611.json",
        json.dumps({"status": "fail", "production_effect": False}),
    )
    _write(
        root / "ml-service/benchmark_results/linucb_multiplier_replay_20260605_20260611.json",
        json.dumps({"status": "fail", "production_effect": False}),
    )
    _write(
        root / "ml-service/benchmark_results/production_cutover_remote_preflight_20260618.json",
        json.dumps({
            "decision_effect": "read_only_observation",
            "production_mutation_allowed": False,
            "summary": {
                "remote_cutover_complete": False,
                "incomplete_remote_check_ids": ["gcp_scheduler_monthly_strategy_mining"],
            },
        }),
    )
    _write(root / "data/feature_registry/unified_feature_registry_v1.json", json.dumps({"features": []}))
    _write(root / "data/feature_registry/feature_view_contract_v1.json", json.dumps({"status": "ok"}))
    _write(root / "data/feature_registry/ml_feature_selection_contract_v1.json", json.dumps({"status": "migration_required"}))
    _write(root / "data/feature_registry/pymoo_monthly_mining_config_v1.json", json.dumps({"schedule": {"cadence": "monthly"}}))
    _write(root / "data/feature_registry/formal137_similarity_contract_v1.json", json.dumps({"status": "ok"}))
    _write(
        root / "tools/export_active_strategy_specs_from_d1.py",
        "\n".join([
            "SELECT_ACTIVE_STRATEGIES_SQL_ONE_LINE = 'SELECT * FROM strategy_spec_registry'",
            "decision_effect = 'read_only_d1_export'",
            "production_mutation_allowed = False",
            "# strategy_spec_registry",
        ]),
    )
    _write(root / "tools/finlab_strategy_spec_backtest.py", "# active strategy FinLab backtest tool\n")
    active_specs = [
        {
            "id": f"active_strategy_{idx:02d}",
            "status": "active",
            "owner": "strategy",
            "ownerType": "strategy",
            "promotionStatus": "production",
            "supportedRegimes": ["bull", "neutral"],
            "riskNotes": ["fixture"],
        }
        for idx in range(11)
    ]
    _write(
        root / "output/finlab_strategy_backtests/current_active_11_strategy_specs.json",
        json.dumps(active_specs),
    )
    _write(
        root / "output/finlab_strategy_backtests/current_active_11_strategy_specs_summary.json",
        json.dumps({
            "schema_version": "stockvision-active-strategy-spec-export-v1",
            "decision_effect": "read_only_d1_export",
            "production_mutation_allowed": False,
            "strategy_count": 11,
            "json": "output/finlab_strategy_backtests/current_active_11_strategy_specs.json",
            "errors": [],
        }),
    )
    _write(
        root / "output/finlab_strategy_backtests/finlab_strategy_spec_active11_20230101_20260615.json",
        json.dumps({"strategy_count": 11, "rows": []}),
    )
    _write(
        root / "output/finlab_strategy_backtests/finlab_strategy_spec_active11_20230101_20260615_summary.json",
        json.dumps({
            "strategy_count": 11,
            "ok": 8,
            "no_signal": 3,
            "errors": [],
        }),
    )
    _write(root / "worker/migration_strategy_registry_alpha_miner_2026_06_17.sql", "-- alpha miner registry seed\n")
    _write(root / "worker/migration_strategy_mining_ledger_2026_06_18.sql", "-- strategy mining ledger\n")
    _write(
        root / "output/feature_universe_triage/unified137_materialization_audit_sii_20230101_20260615.json",
        json.dumps({
            "pass": True,
            "counts": {
                "mapped_factor_count": 137,
                "zero_coverage_count": 0,
                "very_low_coverage_count": 0,
            },
        }),
    )
    _write(
        root / "output/feature_universe_triage/alpha_mining_similarity_novelty_validation_20260618.json",
        json.dumps({
            "schema_version": "stockvision-alpha-mining-similarity-novelty-validation-v1",
            "status": "pass",
            "decision_effect": "local_validation_only",
            "method": "formal137_pairwise_abs_rank_corr_matrix_only_fail_closed",
            "cases": {
                "missing_pair_fail_closed": {
                    "max_similarity": 1.0,
                    "similarity_matrix_missing_internal_pairs": 1,
                },
            },
        }),
    )
    _write(
        root / "output/feature_universe_triage/monthly_pymoo_runtime_contract_validation_20260618.json",
        json.dumps({
            "schema_version": "stockvision-monthly-pymoo-runtime-contract-v1",
            "status": "pass",
            "decision_effect": "local_validation_only",
            "monthly_search_policy": {
                "cadence": "monthly",
                "algorithm": "pymoo",
                "requires_finlab_backtest": True,
            },
            "feature_pool": {
                "eligible_for_alpha_mining": 137,
                "expected_from_local_closure": 137,
            },
        }),
    )
    _write(
        root / "data/feature_registry/ml_feature_migration_preflight_v1.json",
        json.dumps({
            "status": "preflight_ready",
            "gate_status": {
                "materialization_audit_fresh": "pass",
                "materialization_contract_ready": "pass",
                "production_activation": "blocked_until_feature_selection_retrain_release_approval",
            },
            "counts": {
                "migration_candidate_count": 84,
                "materialization_blocker_count": 0,
            },
        }),
    )
    _write(
        root / "data/feature_registry/strategy_feature_ref_contract_v1.json",
        json.dumps({
            "counts": {
                "strategies": 11,
                "refs": 67,
                "blockers": 0,
            },
        }),
    )
    _write(
        root / "data/feature_registry/alpha_mining_promotion_contract_v1.json",
        json.dumps({
            "decision_effect": "governance_contract_only",
            "source_contracts": {
                "feature_registry": str(root / "data/feature_registry/unified_feature_registry_v1.json"),
                "monthly_mining_config": str(root / "data/feature_registry/pymoo_monthly_mining_config_v1.json"),
                "similarity_contract": str(root / "data/feature_registry/formal137_similarity_contract_v1.json"),
                "similarity_pairs": str(root / "output/feature_universe_triage/formal137_pairwise_similarity_long_20260617.csv"),
                "strategy_feature_ref_contract": str(root / "data/feature_registry/strategy_feature_ref_contract_v1.json"),
                "ml_feature_selection_contract": str(root / "data/feature_registry/ml_feature_selection_contract_v1.json"),
                "current_alpha_miner_seed_migration": str(root / "worker/migration_strategy_registry_alpha_miner_2026_06_17.sql"),
                "strategy_mining_ledger_migration": str(root / "worker/migration_strategy_mining_ledger_2026_06_18.sql"),
            },
            "monthly_search_policy": {
                "cadence": "monthly",
                "algorithm": "pymoo",
                "requires_finlab_backtest": True,
            },
        }),
    )
    _write(root / "output/feature_universe_triage/formal137_pairwise_similarity_long_20260617.csv", "feature_a,feature_b,abs_rank_corr\n")
    _write(root / "output/feature_universe_triage/unified179_pairwise_similarity_long_20260617.csv", "feature_a,feature_b,abs_rank_corr\n")
    _write(root / "output/feature_universe_triage/unified179_feature_backtest_report_20260617.csv", "feature_id,monthly_sharpe\n")
    _write(
        root / "output/feature_universe_triage/feature_registry_local_closure_20260617.json",
        json.dumps({
            "status": "pass",
            "counts": {
                "feature_view_counts": {
                    "strategy_view": 137,
                    "l1_25_view": 137,
                    "ple_router_view": 137,
                    "ml_training_view": 137,
                    "alpha_mining_view": 137,
                },
                "strategy_count": 11,
                "derived_artifact_freshness": {
                    "similarity": {"fresh": True},
                    "feature_views": {"fresh": True},
                    "strategy_refs": {"fresh": True},
                    "ml_selection": {"fresh": True},
                    "ml_migration_preflight": {"fresh": True},
                    "promotion": {"fresh": True},
                },
            },
        }),
    )
    now = time.time()
    source_paths = [
        root / "data/feature_registry/unified_feature_registry_v1.json",
        root / "data/feature_registry/pymoo_monthly_mining_config_v1.json",
        root / "output/feature_universe_triage/formal137_pairwise_similarity_long_20260617.csv",
        root / "output/feature_universe_triage/unified179_pairwise_similarity_long_20260617.csv",
        root / "output/feature_universe_triage/unified179_feature_backtest_report_20260617.csv",
        root / "worker/migration_strategy_registry_alpha_miner_2026_06_17.sql",
        root / "worker/migration_strategy_mining_ledger_2026_06_18.sql",
        root / "tools/export_active_strategy_specs_from_d1.py",
        root / "tools/finlab_strategy_spec_backtest.py",
    ]
    first_derivative_paths = [
        root / "output/feature_universe_triage/unified137_materialization_audit_sii_20230101_20260615.json",
        root / "data/feature_registry/formal137_similarity_contract_v1.json",
        root / "data/feature_registry/feature_view_contract_v1.json",
        root / "data/feature_registry/strategy_feature_ref_contract_v1.json",
        root / "data/feature_registry/ml_feature_selection_contract_v1.json",
        root / "output/finlab_strategy_backtests/current_active_11_strategy_specs.json",
        root / "output/finlab_strategy_backtests/current_active_11_strategy_specs_summary.json",
    ]
    second_derivative_paths = [
        root / "data/feature_registry/ml_feature_migration_preflight_v1.json",
        root / "data/feature_registry/alpha_mining_promotion_contract_v1.json",
        root / "output/feature_universe_triage/monthly_pymoo_runtime_contract_validation_20260618.json",
        root / "output/finlab_strategy_backtests/finlab_strategy_spec_active11_20230101_20260615.json",
        root / "output/finlab_strategy_backtests/finlab_strategy_spec_active11_20230101_20260615_summary.json",
    ]
    for path in source_paths:
        _set_mtime(path, now)
    for path in first_derivative_paths:
        _set_mtime(path, now + 10)
    for path in second_derivative_paths:
        _set_mtime(path, now + 20)
    _set_mtime(root / "output/feature_universe_triage/feature_registry_local_closure_20260617.json", now + 30)


def test_production_cutover_packet_is_ready_for_review_but_non_mutating(tmp_path):
    _seed_ready_evidence(tmp_path)

    packet = build_production_cutover_packet(tmp_path)

    assert packet["cutover_ready_for_review"] is True
    assert packet["production_mutation_allowed"] is False
    assert packet["actions_allowed_without_wei_approval"] == []
    assert packet["local_gate"]["passed"] is True
    assert packet["blocked_reason"] is None
    action_ids = {row["id"] for row in packet["approval_required_actions"]}
    assert "sync_gcp_scheduler_manifest" in action_ids
    assert "apply_strategy_mining_ledger_migration" in action_ids
    assert "enable_strategy_mining_execution_env" in action_ids
    assert "feature_selection_retrain_release" in action_ids
    assert "update_model_pool_champion_pointers" in action_ids
    assert all(row["passed"] for row in packet["evidence_health"])
    evidence = {row["id"]: row for row in packet["evidence_health"]}
    assert evidence["active_strategy_baseline_export_and_backtest"]["detail"]["strategy_count"] == 11
    assert evidence["active_strategy_baseline_export_and_backtest"]["detail"]["backtest_ok"] == 8
    assert evidence["local_audit_alpha_mining_similarity_fail_closed_gates"]["passed"] is True
    assert evidence["local_audit_monthly_pymoo_runtime_contract_gates"]["passed"] is True
    assert packet["remote_cutover_complete"] is False
    assert packet["remote_preflight_summary"]["incomplete_remote_check_ids"] == ["gcp_scheduler_monthly_strategy_mining"]


def test_production_cutover_packet_blocks_when_local_gate_is_not_done(tmp_path):
    _seed_ready_evidence(tmp_path, {
        "local_closure": "done",
        "local_prod_ready": "blocked",
        "failed_checks": [{"id": "runtime_pin:xgboost==3.2.0"}],
        "promotion_allowed": False,
        "production_mutation_allowed": False,
    })

    packet = build_production_cutover_packet(tmp_path)

    assert packet["cutover_ready_for_review"] is False
    assert packet["production_mutation_allowed"] is False
    assert packet["local_gate"]["passed"] is False
    assert packet["blocked_reason"]["local_gate_passed"] is False


def test_production_cutover_packet_allows_self_refresh_only_local_gate(tmp_path):
    _seed_ready_evidence(tmp_path, {
        "local_closure": "blocked",
        "local_prod_ready": "blocked",
        "failed_checks": [{"id": "roadmap:p12:production_cutover_packet_artifact_fresh"}],
        "promotion_allowed": False,
        "production_mutation_allowed": False,
    })

    packet = build_production_cutover_packet(tmp_path)

    assert packet["cutover_ready_for_review"] is True
    assert packet["local_gate"]["passed"] is True
    assert packet["local_gate"]["self_refresh_only"] is True
    assert packet["blocked_reason"] is None


def test_production_cutover_packet_blocks_when_evidence_is_missing(tmp_path):
    _write(
        tmp_path / "ml-service/benchmark_results/local_prod_ready_audit_20260618.json",
        json.dumps({
            "local_closure": "done",
            "local_prod_ready": "done",
            "failed_checks": [],
            "promotion_allowed": False,
            "production_mutation_allowed": False,
        }),
    )

    packet = build_production_cutover_packet(tmp_path)

    assert packet["cutover_ready_for_review"] is False
    assert packet["blocked_reason"]["evidence_ready"] is False


def test_production_cutover_packet_blocks_stale_feature_registry_closure(tmp_path):
    _seed_ready_evidence(tmp_path)
    closure_path = tmp_path / "output/feature_universe_triage/feature_registry_local_closure_20260617.json"
    registry_path = tmp_path / "data/feature_registry/unified_feature_registry_v1.json"
    now = time.time()
    _set_mtime(closure_path, now - 60)
    _set_mtime(registry_path, now)

    packet = build_production_cutover_packet(tmp_path)

    evidence = {row["id"]: row for row in packet["evidence_health"]}
    assert packet["cutover_ready_for_review"] is False
    assert evidence["feature_registry_local_closure_pass"]["passed"] is False
    assert "data/feature_registry/unified_feature_registry_v1.json" in evidence["feature_registry_local_closure_pass"]["detail"]["stale_against"]


def test_production_cutover_packet_cli_writes_output_with_freshness_detail(tmp_path):
    _seed_ready_evidence(tmp_path)
    output = tmp_path / "packet.json"

    exit_code = main(["--repo", str(tmp_path), "--output", str(output)])

    packet = json.loads(output.read_text(encoding="utf-8"))
    evidence = {row["id"]: row for row in packet["evidence_health"]}
    assert exit_code == 0
    assert output.exists()
    assert packet["cutover_ready_for_review"] is True
    assert evidence["feature_registry_local_closure_pass"]["detail"]["artifact_fresh"] is True
    assert evidence["alpha_mining_promotion_contract_governance_only"]["detail"]["source_contracts_fresh"] is True
