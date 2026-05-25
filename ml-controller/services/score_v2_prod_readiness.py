"""Score V2 production-readiness aggregation.

This module is intentionally pure/read-only: callers pass existing preflight
reports and it returns the remaining approval/readback blockers.
"""

from __future__ import annotations

from typing import Any


SCHEMA_VERSION = "score-v2-prod-readiness-v1"


PHASES = tuple(range(0, 9))


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if str(item).strip()]


def _decision(report: dict[str, Any]) -> str:
    return str(report.get("decision") or "").strip().upper()


def _gate(report: dict[str, Any]) -> dict[str, Any]:
    rollout_gate = report.get("rollout_gate")
    return rollout_gate if isinstance(rollout_gate, dict) else {}


def _int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _fundamental_live_next_action(
    *,
    migration_decision: str,
    fundamental_rows: int,
) -> str:
    if migration_decision == "ALREADY_APPLIED" and fundamental_rows > 0:
        return "deploy_controller_score_v2_path_and_rerun_daily_recommendations_after_wei_approval"
    if migration_decision == "SCHEMA_APPLIED_WAITING_DATA":
        return "materialize_canonical_fundamental_features_after_approval"
    return "apply_and_materialize_fundamental_quality_after_wei_approval"


def _add_blocker(
    blockers: list[dict[str, Any]],
    *,
    phase: int,
    blocker_id: str,
    severity: str,
    summary: str,
    next_action: str,
    requires_approval: bool = False,
    evidence: dict[str, Any] | None = None,
) -> None:
    blockers.append({
        "phase": phase,
        "id": blocker_id,
        "severity": severity,
        "summary": summary,
        "next_action": next_action,
        "requires_wei_approval": requires_approval,
        "evidence": evidence or {},
    })


def _phase_status(blockers: list[dict[str, Any]], phase: int) -> str:
    phase_blockers = [item for item in blockers if item["phase"] == phase]
    if not phase_blockers:
        return "ready"
    if any(item["severity"] == "block" for item in phase_blockers):
        return "blocked"
    if any(item["requires_wei_approval"] for item in phase_blockers):
        return "approval_required"
    return "pending_readback"


def build_score_v2_prod_readiness_report(
    *,
    roadmap_status: dict[str, Any] | None = None,
    replay_gate_report: dict[str, Any] | None = None,
    contribution_readiness_report: dict[str, Any] | None = None,
    fundamental_migration_preflight_report: dict[str, Any] | None = None,
    news_theme_handoff_report: dict[str, Any] | None = None,
    deploy_gate_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Aggregate Score V2 production readiness from existing read-only reports."""

    roadmap_status = _as_dict(roadmap_status)
    replay_gate_report = _as_dict(replay_gate_report)
    contribution_readiness_report = _as_dict(contribution_readiness_report)
    fundamental_migration_preflight_report = _as_dict(fundamental_migration_preflight_report)
    news_theme_handoff_report = _as_dict(news_theme_handoff_report)
    deploy_gate_report = _as_dict(deploy_gate_report)

    blockers: list[dict[str, Any]] = []

    # Phase 0/1 are still only prod-ready when baseline/archive/backfill gates are
    # represented by evidence, not by roadmap prose.
    if not roadmap_status.get("source_of_truth_baseline_complete"):
        _add_blocker(
            blockers,
            phase=0,
            blocker_id="source_of_truth_baseline_incomplete",
            severity="warn",
            summary="R2 mirror inventory and a single exported score-path baseline are not complete.",
            next_action="export_archive_inventory_and_score_path_baseline",
            evidence={"roadmap": roadmap_status.get("phase_0")},
        )
    if not roadmap_status.get("finlab_daily_incremental_live"):
        _add_blocker(
            blockers,
            phase=1,
            blocker_id="finlab_daily_incremental_not_live",
            severity="warn",
            summary="FinLab daily backfill guard exists, but live scheduler/job has not been switched and read back.",
            next_action="run_finlab_backfill_job_preflight_then_apply_after_approval",
            evidence={"roadmap": roadmap_status.get("phase_1")},
        )

    if not roadmap_status.get("optuna_modal_live"):
        _add_blocker(
            blockers,
            phase=2,
            blocker_id="optuna_modal_not_live",
            severity="warn",
            summary="Modal per-regime path exists, but production env/callback/readback are not verified.",
            next_action="deploy_modal_optuna_path_after_approval_and_verify_7d_triggers",
            requires_approval=True,
            evidence={"roadmap": roadmap_status.get("phase_2")},
        )

    if not roadmap_status.get("technical_factor_validation_complete"):
        _add_blocker(
            blockers,
            phase=3,
            blocker_id="technical_factor_forward_validation_missing",
            severity="warn",
            summary="Technical V2 formulas are covered, but IC/forward return/MAE/MFE replay is not complete.",
            next_action="run_read_only_factor_validation_replay",
            evidence={"roadmap": roadmap_status.get("phase_3")},
        )

    migration_decision = _decision(fundamental_migration_preflight_report)
    fundamental_live_schema = _as_dict(fundamental_migration_preflight_report.get("live_schema"))
    fundamental_rows = _int(fundamental_live_schema.get("fundamental_total"))
    if migration_decision in {"", "BLOCK"}:
        _add_blocker(
            blockers,
            phase=5,
            blocker_id="fundamental_migration_preflight_blocked",
            severity="block",
            summary="canonical_fundamental_features migration is not ready to apply.",
            next_action="repair_fundamental_migration_preflight",
            evidence={
                "decision": migration_decision or None,
                "failed_checks": fundamental_migration_preflight_report.get("failed_checks"),
            },
        )
    elif migration_decision == "READY_TO_APPLY":
        _add_blocker(
            blockers,
            phase=5,
            blocker_id="fundamental_migration_requires_approval",
            severity="approval",
            summary="canonical_fundamental_features migration is valid but not applied in production.",
            next_action="apply_fundamental_migration_after_wei_approval",
            requires_approval=True,
            evidence={
                "decision": migration_decision,
                "apply_command_hint": fundamental_migration_preflight_report.get("apply_command_hint"),
                "readback_sql": fundamental_migration_preflight_report.get("readback_sql"),
            },
        )
    elif migration_decision == "SCHEMA_APPLIED_WAITING_DATA":
        _add_blocker(
            blockers,
            phase=5,
            blocker_id="fundamental_rows_not_materialized",
            severity="warn",
            summary="canonical_fundamental_features exists but has no usable rows.",
            next_action="materialize_canonical_fundamental_features_after_approval",
            requires_approval=True,
            evidence=fundamental_migration_preflight_report.get("live_schema") or {},
        )

    contribution_decision = _decision(contribution_readiness_report)
    contribution_causes = _string_list(contribution_readiness_report.get("root_causes"))
    if contribution_decision == "BLOCK":
        for cause in contribution_causes:
            phase = 5 if "fundamental" in cause else 6 if "news" in cause else 8
            _add_blocker(
                blockers,
                phase=phase,
                blocker_id=cause,
                severity="block",
                summary=f"Score V2 contribution readiness is blocked by {cause}.",
                next_action=(
                    _fundamental_live_next_action(
                        migration_decision=migration_decision,
                        fundamental_rows=fundamental_rows,
                    )
                    if phase == 5
                    else "deploy_news_theme_handoff_and_rerun_screener"
                    if phase == 6
                    else "repair_score_v2_contribution_readiness"
                ),
                requires_approval=phase in {5, 6},
                evidence={
                    "component_nonzero": contribution_readiness_report.get("component_nonzero"),
                    "latest_daily_date": contribution_readiness_report.get("latest_daily_date"),
                    "allowed_next_action": contribution_readiness_report.get("allowed_next_action"),
                },
            )

    news_decision = _decision(news_theme_handoff_report)
    if news_decision == "WAITING_DEPLOY":
        _add_blocker(
            blockers,
            phase=6,
            blocker_id="news_theme_waiting_deploy",
            severity="approval",
            summary="Repo contracts pass and live inputs exist, but production daily rows still have newsTheme=0.",
            next_action="deploy_worker_and_rerun_screener_after_wei_approval",
            requires_approval=True,
            evidence=news_theme_handoff_report.get("live_snapshot") or {},
        )
    elif news_decision == "BLOCK":
        _add_blocker(
            blockers,
            phase=6,
            blocker_id="news_theme_handoff_blocked",
            severity="block",
            summary="newsTheme handoff contract is blocked.",
            next_action="repair_news_theme_handoff_contract",
            evidence={
                "root_causes": news_theme_handoff_report.get("root_causes"),
                "contract_failures": news_theme_handoff_report.get("contract_failures"),
            },
        )

    if not roadmap_status.get("trading_plan_real_data_qa_complete"):
        _add_blocker(
            blockers,
            phase=7,
            blocker_id="trading_plan_real_data_qa_missing",
            severity="warn",
            summary="Trading-plan chart code exists, but real-data rendered QA/readback is not complete.",
            next_action="run_real_data_chart_qa_against_production_api",
            evidence={"roadmap": roadmap_status.get("phase_7")},
        )

    rollout_gate = _gate(replay_gate_report)
    rollout_decision = _decision(rollout_gate)
    if rollout_decision != "PASS":
        _add_blocker(
            blockers,
            phase=8,
            blocker_id="score_v2_rollout_gate_not_passed",
            severity="block",
            summary="Score V2 rollout gate has not passed.",
            next_action="rerun_rollout_gate_after_fundamental_and_news_readbacks",
            evidence={
                "decision": rollout_decision or None,
                "failed_gates": rollout_gate.get("failed_gates"),
            },
        )

    if not roadmap_status.get("dual_write_enabled"):
        _add_blocker(
            blockers,
            phase=8,
            blocker_id="dual_write_not_enabled",
            severity="approval",
            summary="score_v2_enabled=false dual-write has not been enabled/read back in production.",
            next_action="enable_dual_write_after_rollout_gate_passes",
            requires_approval=True,
        )
    if not roadmap_status.get("ranking_owner_cutover_complete"):
        _add_blocker(
            blockers,
            phase=8,
            blocker_id="ranking_owner_not_cutover",
            severity="approval",
            summary="pending-buy, paper, and recommendations are not cut over to Score V2 total as production owner.",
            next_action="cutover_ranking_owner_after_dual_write_observation",
            requires_approval=True,
        )
    if not roadmap_status.get("observation_window_complete"):
        _add_blocker(
            blockers,
            phase=8,
            blocker_id="observation_window_missing",
            severity="warn",
            summary="3-5 trading-day observation window is not complete.",
            next_action="observe_3_to_5_trading_days_after_cutover",
        )

    deploy_decision = _decision(deploy_gate_report)
    if deploy_gate_report and deploy_decision not in {"PASS", "WARN"}:
        _add_blocker(
            blockers,
            phase=8,
            blocker_id="deploy_gate_not_passed",
            severity="block",
            summary="Worker deploy gate did not pass.",
            next_action="repair_deploy_gate_before_production_mutation",
            evidence={
                "decision": deploy_decision,
                "status": deploy_gate_report.get("status"),
            },
        )

    severity_rank = {"block": 0, "approval": 1, "warn": 2}
    blockers.sort(key=lambda item: (severity_rank.get(item["severity"], 9), item["phase"], item["id"]))
    hard_blocks = [item for item in blockers if item["severity"] == "block"]
    approvals = [item for item in blockers if item["requires_wei_approval"]]
    warnings = [item for item in blockers if item["severity"] == "warn"]

    if hard_blocks:
        decision = "NOT_PROD_READY"
    elif approvals:
        decision = "READY_FOR_APPROVAL"
    elif warnings:
        decision = "READY_FOR_READBACK"
    else:
        decision = "PROD_READY"

    return {
        "schema_version": SCHEMA_VERSION,
        "mode": "read_only",
        "decision": decision,
        "prod_ready": decision == "PROD_READY",
        "phase_status": {
            f"phase_{phase}": _phase_status(blockers, phase)
            for phase in PHASES
        },
        "blockers": blockers,
        "hard_blockers": [item["id"] for item in hard_blocks],
        "approvals_required": [item["id"] for item in approvals],
        "warnings": [item["id"] for item in warnings],
        "next_approval_batch": [
            item for item in approvals
            if item["id"] in {
                "fundamental_migration_requires_approval",
                "canonical_fundamental_features_missing",
                "fundamental_quality_live_zero",
                "news_theme_waiting_deploy",
            }
        ],
    }
