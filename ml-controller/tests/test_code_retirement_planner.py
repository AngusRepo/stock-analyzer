import asyncio

from routers.research_benchmark import (
    CodeRetirementPlanRequest,
    research_code_retirement_plan_dry_run,
)
from services.code_retirement_planner import build_code_retirement_plan


def _replace_adoption_packet():
    return {
        "schema_version": "adoption-decision-packet-v1",
        "candidate_id": "signature-transformer-v1",
        "candidate_type": "portfolio_allocation",
        "baseline_id": "predict_then_optimize",
        "baseline_retirement": {
            "status": "retirement_candidate",
            "target": "predict_then_optimize",
            "required_before_delete": [
                "wei_manual_approval",
                "parallel_readback_same_dates",
                "delete_after_parallel_readback",
                "rollback_path_documented",
                "obsidian_decision_note",
            ],
        },
        "decision": {
            "action": "replace",
            "ready_for_wei_review": True,
            "production_mutation_allowed": False,
        },
    }


def test_code_retirement_plan_marks_delete_ready_only_after_replace_and_parallel_readback():
    plan = build_code_retirement_plan(
        adoption_decision_packet=_replace_adoption_packet(),
        code_inventory=[
            {
                "path": "ml-controller/services/legacy_predict_then_optimize.py",
                "owner": "predict_then_optimize",
                "replacement_owner": "signature-transformer-v1",
                "parallel_readback_passed": True,
                "runtime_references": 0,
                "rollback_path": "ml-controller/services/direct_allocation_benchmark.py",
            }
        ],
    )

    item = plan["items"][0]
    assert plan["schema_version"] == "code-retirement-plan-v1"
    assert plan["decision_effect"] == "retirement_plan_only"
    assert plan["filesystem_mutation_allowed"] is False
    assert plan["requires_wei_approval"] is True
    assert item["action"] == "delete_ready_after_wei_approval"
    assert item["blockers"] == []
    assert item["replacement_owner"] == "signature-transformer-v1"


def test_code_retirement_plan_keeps_baseline_for_fusion_adoption():
    fusion_packet = {
        **_replace_adoption_packet(),
        "candidate_id": "jepa-market-state-v1",
        "baseline_id": "market_regime_state",
        "baseline_retirement": {"status": "keep", "target": "market_regime_state"},
        "decision": {
            "action": "fuse",
            "ready_for_wei_review": True,
            "production_mutation_allowed": False,
        },
    }

    plan = build_code_retirement_plan(
        adoption_decision_packet=fusion_packet,
        code_inventory=[
            {
                "path": "ml-controller/services/market_regime_service.py",
                "owner": "market_regime_state",
                "replacement_owner": "jepa-market-state-v1",
                "parallel_readback_passed": True,
                "runtime_references": 0,
                "rollback_path": "ml-controller/services/market_regime_service.py",
            }
        ],
    )

    item = plan["items"][0]
    assert item["action"] == "keep"
    assert "adoption_action_does_not_retire_baseline" in item["blockers"]
    assert plan["summary"]["delete_ready_count"] == 0


def test_code_retirement_plan_blocks_runtime_references_and_missing_readback():
    plan = build_code_retirement_plan(
        adoption_decision_packet=_replace_adoption_packet(),
        code_inventory=[
            {
                "path": "ml-controller/services/predict_then_optimize.py",
                "owner": "predict_then_optimize",
                "replacement_owner": "signature-transformer-v1",
                "parallel_readback_passed": False,
                "runtime_references": 2,
                "rollback_path": "",
            }
        ],
    )

    item = plan["items"][0]
    assert item["action"] == "keep_until_readback"
    assert "runtime_references_still_present" in item["blockers"]
    assert "parallel_readback_missing" in item["blockers"]
    assert "rollback_path_missing" in item["blockers"]


def test_code_retirement_plan_research_route_is_non_mutating():
    response = asyncio.run(research_code_retirement_plan_dry_run(
        CodeRetirementPlanRequest(
            adoption_decision_packet=_replace_adoption_packet(),
            code_inventory=[
                {
                    "path": "ml-controller/services/legacy_predict_then_optimize.py",
                    "owner": "predict_then_optimize",
                    "replacement_owner": "signature-transformer-v1",
                    "parallel_readback_passed": True,
                    "runtime_references": 0,
                    "rollback_path": "ml-controller/services/direct_allocation_benchmark.py",
                }
            ],
        )
    ))

    assert response["decision_effect"] == "retirement_plan_only"
    assert response["destructive_action_executed"] is False
