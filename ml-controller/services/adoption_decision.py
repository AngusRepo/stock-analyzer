"""Research-only adoption decision normalizer.

This service turns benchmark evidence into one of:
replace, accelerated_replace_review, fuse, enhance, hold_paper_validation, or reject.

It never mutates production. Baseline retirement is only a review candidate
after replacement evidence and either L10 paper-trading validation or an
explicit accelerated historical replay gate passes.
"""

from __future__ import annotations

from typing import Any


SCHEMA_VERSION = "adoption-decision-packet-v1"


def _decision(report: dict[str, Any]) -> dict[str, Any]:
    raw = report.get("decision")
    return raw if isinstance(raw, dict) else {}


def _clean_text(value: object, default: str = "") -> str:
    text = str(value or "").strip()
    return text or default


def _ladder_index(packet: dict[str, Any] | None) -> int:
    if not isinstance(packet, dict):
        return -1
    try:
        return int(packet.get("current_level_index"))
    except (TypeError, ValueError):
        return -1


def _upstream_mutation_flag(report: dict[str, Any], ladder: dict[str, Any] | None) -> bool:
    report_decision = _decision(report)
    ladder_decision = _decision(ladder or {})
    return bool(report_decision.get("production_mutation_allowed")) or bool(ladder_decision.get("production_mutation_allowed"))


def _replacement_requested(report: dict[str, Any]) -> bool:
    decision = _decision(report)
    return any(
        bool(decision.get(key))
        for key in (
            "eligible_to_replace_predict_then_optimize",
            "eligible_to_replace_rank_topk",
            "eligible_to_replace_baseline",
        )
    )


def _fuse_requested(report: dict[str, Any]) -> bool:
    decision = _decision(report)
    return bool(decision.get("eligible_to_fuse"))


def _enhance_requested(report: dict[str, Any]) -> bool:
    decision = _decision(report)
    return any(
        bool(decision.get(key))
        for key in (
            "eligible_to_attach_uncertainty_overlay",
            "eligible_for_research_fusion",
        )
    )


def _accelerated_historical_replacement_requested(report: dict[str, Any]) -> bool:
    decision = _decision(report)
    return bool(decision.get("accelerated_historical_replacement_allowed"))


def _material_deltas(report: dict[str, Any]) -> dict[str, Any]:
    decision = _decision(report)
    keep = [
        "sharpe_delta",
        "max_drawdown_delta",
        "turnover_delta",
        "historical_replay_days",
        "accuracy_delta",
        "transition_recall_delta",
        "brier_delta",
    ]
    return {key: decision.get(key) for key in keep if key in decision}


def _baseline_retirement(status: str, baseline_id: str) -> dict[str, Any]:
    if status != "retirement_candidate":
        return {
            "status": "keep",
            "target": baseline_id,
            "required_before_delete": [],
        }
    return {
        "status": "retirement_candidate",
        "target": baseline_id,
        "required_before_delete": [
            "wei_manual_approval",
            "parallel_readback_same_dates",
            "delete_after_parallel_readback",
            "rollback_path_documented",
            "obsidian_decision_note",
        ],
    }


def build_adoption_decision_packet(
    *,
    candidate_id: str,
    candidate_type: str,
    baseline_id: str,
    benchmark_report: dict[str, Any],
    validation_ladder_packet: dict[str, Any] | None = None,
) -> dict[str, Any]:
    benchmark_report = benchmark_report if isinstance(benchmark_report, dict) else {}
    validation_ladder_packet = validation_ladder_packet if isinstance(validation_ladder_packet, dict) else {}
    blockers: list[str] = []
    if str(benchmark_report.get("status") or "").lower() == "blocked":
        blockers.append("benchmark_report_blocked")
    if _upstream_mutation_flag(benchmark_report, validation_ladder_packet):
        blockers.append("upstream_report_mutation_flag_invalid")

    ladder_idx = _ladder_index(validation_ladder_packet)
    replacement = _replacement_requested(benchmark_report)
    fuse = _fuse_requested(benchmark_report)
    enhance = _enhance_requested(benchmark_report)
    accelerated = _accelerated_historical_replacement_requested(benchmark_report)

    action = "reject"
    baseline_retirement_status = "keep"
    integration_mode = "none"
    ready_for_review = False

    if not blockers:
        if replacement:
            if ladder_idx >= 10:
                action = "replace"
                baseline_retirement_status = "retirement_candidate"
                integration_mode = "replace_baseline_after_review"
                ready_for_review = True
            elif accelerated and ladder_idx >= 9:
                action = "accelerated_replace_review"
                baseline_retirement_status = "retirement_candidate"
                integration_mode = "accelerated_historical_replace_after_review"
                ready_for_review = True
            else:
                action = "hold_paper_validation"
                blockers.append("validation_ladder_l10_required_for_replacement")
                integration_mode = "keep_shadow_until_l10"
        elif fuse:
            if ladder_idx >= 7:
                action = "fuse"
                integration_mode = "enhance_existing_baseline"
                ready_for_review = ladder_idx >= 9
            else:
                action = "hold_paper_validation"
                blockers.append("validation_ladder_l7_required_for_fusion")
                integration_mode = "keep_research_only"
        elif enhance:
            action = "enhance"
            integration_mode = "context_or_risk_overlay"
            ready_for_review = True
        else:
            blockers.append("no_positive_adoption_signal")

    if "benchmark_report_blocked" in blockers or "upstream_report_mutation_flag_invalid" in blockers:
        action = "reject"
        baseline_retirement_status = "keep"
        integration_mode = "none"
        ready_for_review = False

    return {
        "schema_version": SCHEMA_VERSION,
        "decision_effect": "adoption_decision_only",
        "candidate_id": _clean_text(candidate_id),
        "candidate_type": _clean_text(candidate_type, "unknown"),
        "baseline_id": _clean_text(baseline_id, "unknown"),
        "blockers": blockers,
        "evidence_summary": {
            "benchmark_schema_version": benchmark_report.get("schema_version"),
            "validation_ladder_level": validation_ladder_packet.get("current_level"),
            "validation_ladder_index": ladder_idx,
            "material_deltas": _material_deltas(benchmark_report),
        },
        "integration_plan": {
            "mode": integration_mode,
            "requires_manual_approval": action in {"replace", "accelerated_replace_review", "fuse"},
            "dry_run_only": True,
        },
        "baseline_retirement": _baseline_retirement(baseline_retirement_status, _clean_text(baseline_id, "unknown")),
        "decision": {
            "action": action,
            "ready_for_wei_review": ready_for_review,
            "production_mutation_allowed": False,
            "commit_allowed": False,
            "deploy_allowed": False,
            "retrain_allowed": False,
            "trade_allowed": False,
        },
    }
