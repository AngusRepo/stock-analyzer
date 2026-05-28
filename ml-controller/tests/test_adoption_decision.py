import asyncio

from routers.research_benchmark import (
    AdoptionDecisionRequest,
    research_adoption_decision_dry_run,
)
from services.adoption_decision import build_adoption_decision_packet


def _l10_packet():
    return {
        "schema_version": "validation-ladder-packet-v1",
        "current_level": "L10_paper_trading",
        "current_level_index": 10,
        "decision": {
            "ready_for_wei_review": True,
            "eligible_for_production_allocation_review": True,
            "production_mutation_allowed": False,
        },
    }


def _direct_allocation_win():
    return {
        "schema_version": "direct-allocation-benchmark-v1",
        "decision_effect": "benchmark_gate_only",
        "status": "ready_for_review",
        "baseline": {"method": "predict_then_optimize"},
        "challenger": {"method": "signature_informed_transformer_direct_allocation"},
        "decision": {
            "eligible_to_replace_predict_then_optimize": True,
            "production_mutation_allowed": False,
            "sharpe_delta": 1.24,
            "max_drawdown_delta": -0.03,
            "turnover_delta": 0.05,
        },
    }


def test_adoption_decision_marks_baseline_retirement_only_when_replacement_and_l10_pass():
    packet = build_adoption_decision_packet(
        candidate_id="signature-transformer-v1",
        candidate_type="portfolio_allocation",
        baseline_id="predict_then_optimize",
        benchmark_report=_direct_allocation_win(),
        validation_ladder_packet=_l10_packet(),
    )

    assert packet["schema_version"] == "adoption-decision-packet-v1"
    assert packet["decision"]["action"] == "replace"
    assert packet["decision"]["ready_for_wei_review"] is True
    assert packet["decision"]["production_mutation_allowed"] is False
    assert packet["baseline_retirement"]["status"] == "retirement_candidate"
    assert packet["baseline_retirement"]["target"] == "predict_then_optimize"
    assert "delete_after_parallel_readback" in packet["baseline_retirement"]["required_before_delete"]


def test_adoption_decision_holds_replacement_when_validation_ladder_not_l10():
    ladder = {**_l10_packet(), "current_level": "L9_reality_check", "current_level_index": 9}

    packet = build_adoption_decision_packet(
        candidate_id="signature-transformer-v1",
        candidate_type="portfolio_allocation",
        baseline_id="predict_then_optimize",
        benchmark_report=_direct_allocation_win(),
        validation_ladder_packet=ladder,
    )

    assert packet["decision"]["action"] == "hold_paper_validation"
    assert packet["baseline_retirement"]["status"] == "keep"
    assert "validation_ladder_l10_required_for_replacement" in packet["blockers"]


def test_adoption_decision_allows_accelerated_historical_replacement_at_l9():
    ladder = {**_l10_packet(), "current_level": "L9_reality_check", "current_level_index": 9}
    report = _direct_allocation_win()
    report["decision"] = {
        **report["decision"],
        "accelerated_historical_replacement_allowed": True,
        "historical_replay_days": 180,
    }

    packet = build_adoption_decision_packet(
        candidate_id="signature-transformer-v1",
        candidate_type="portfolio_allocation",
        baseline_id="predict_then_optimize",
        benchmark_report=report,
        validation_ladder_packet=ladder,
    )

    assert packet["decision"]["action"] == "accelerated_replace_review"
    assert packet["decision"]["ready_for_wei_review"] is True
    assert packet["integration_plan"]["mode"] == "accelerated_historical_replace_after_review"
    assert packet["baseline_retirement"]["status"] == "retirement_candidate"
    assert packet["decision"]["production_mutation_allowed"] is False


def test_adoption_decision_fuses_jepa_without_retiring_current_regime():
    packet = build_adoption_decision_packet(
        candidate_id="jepa-market-state-v1",
        candidate_type="market_state",
        baseline_id="market_regime_state",
        benchmark_report={
            "schema_version": "market-state-benchmark-v1",
            "decision_effect": "benchmark_gate_only",
            "status": "ready_for_review",
            "decision": {
                "eligible_to_fuse": True,
                "production_mutation_allowed": False,
                "accuracy_delta": 0.12,
                "transition_recall_delta": 0.20,
            },
        },
        validation_ladder_packet={"current_level_index": 9, "decision": {"production_mutation_allowed": False}},
    )

    assert packet["decision"]["action"] == "fuse"
    assert packet["integration_plan"]["mode"] == "enhance_existing_baseline"
    assert packet["baseline_retirement"]["status"] == "keep"


def test_adoption_decision_rejects_mutating_or_blocked_reports():
    packet = build_adoption_decision_packet(
        candidate_id="bad-candidate",
        candidate_type="unknown",
        baseline_id="current",
        benchmark_report={
            "schema_version": "portfolio-allocation-benchmark-v1",
            "status": "blocked",
            "decision": {
                "eligible_to_replace_rank_topk": True,
                "production_mutation_allowed": True,
            },
            "blockers": ["future_leakage_detected"],
        },
        validation_ladder_packet=_l10_packet(),
    )

    assert packet["decision"]["action"] == "reject"
    assert "benchmark_report_blocked" in packet["blockers"]
    assert "upstream_report_mutation_flag_invalid" in packet["blockers"]
    assert packet["baseline_retirement"]["status"] == "keep"


def test_adoption_decision_research_route_is_non_mutating():
    response = asyncio.run(research_adoption_decision_dry_run(
        AdoptionDecisionRequest(
            candidate_id="signature-transformer-v1",
            candidate_type="portfolio_allocation",
            baseline_id="predict_then_optimize",
            benchmark_report=_direct_allocation_win(),
            validation_ladder_packet=_l10_packet(),
        )
    ))

    assert response["decision_effect"] == "adoption_decision_only"
    assert response["decision"]["production_mutation_allowed"] is False
