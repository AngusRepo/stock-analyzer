import asyncio
from pathlib import Path

from routers.research_benchmark import (
    CodeRetirementInventoryRequest,
    research_code_retirement_inventory_dry_run,
)
from services.code_retirement_inventory import build_code_retirement_inventory


REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "ml-controller" / "tests" / "fixtures" / "code_retirement_inventory"


def _replace_packet():
    return {
        "candidate_id": "signature-transformer-v1",
        "baseline_id": "predict_then_optimize",
        "baseline_retirement": {
            "status": "retirement_candidate",
            "target": "predict_then_optimize",
        },
        "decision": {
            "action": "replace",
            "production_mutation_allowed": False,
        },
    }


def test_code_retirement_inventory_counts_runtime_references_and_ignores_excluded_dirs():
    fixture_root = FIXTURES / "runtime_refs"

    inventory = build_code_retirement_inventory(
        adoption_decision_packet=_replace_packet(),
        repo_root=str(fixture_root),
        candidate_paths=["services/predict_then_optimize.py"],
        owner_tokens=["predict_then_optimize"],
        parallel_readback_passed=True,
        rollback_path="services/direct_allocation_benchmark.py",
    )

    item = inventory["items"][0]
    assert inventory["schema_version"] == "code-retirement-inventory-v1"
    assert inventory["filesystem_mutation_allowed"] is False
    assert inventory["destructive_action_executed"] is False
    assert item["path"] == "services/predict_then_optimize.py"
    assert item["runtime_references"] == 1
    assert item["reference_paths"] == ["routers/live.py"]
    assert item["parallel_readback_passed"] is True


def test_code_retirement_inventory_auto_discovers_candidate_paths_from_owner_tokens():
    fixture_root = FIXTURES / "auto_discover"

    packet = {
        **_replace_packet(),
        "candidate_id": "sparse-tangent-v1",
        "baseline_id": "rank_topk",
        "baseline_retirement": {"status": "retirement_candidate", "target": "rank_topk"},
    }
    inventory = build_code_retirement_inventory(
        adoption_decision_packet=packet,
        repo_root=str(fixture_root),
        owner_tokens=["rank_topk"],
        parallel_readback_passed=False,
        rollback_path="services/portfolio_allocation.py",
    )

    assert [item["path"] for item in inventory["items"]] == ["services/rank_topk_allocator.py"]
    assert inventory["items"][0]["runtime_references"] == 1
    assert inventory["items"][0]["reference_paths"] == ["tests/test_rank_topk.py"]


def test_code_retirement_inventory_skips_paths_outside_repo():
    fixture_root = FIXTURES / "runtime_refs"
    outside = FIXTURES / "outside.py"

    inventory = build_code_retirement_inventory(
        adoption_decision_packet=_replace_packet(),
        repo_root=str(fixture_root),
        candidate_paths=[str(outside)],
        owner_tokens=["predict_then_optimize"],
    )

    assert inventory["items"] == []
    assert inventory["skipped_paths"] == [str(outside)]


def test_code_retirement_inventory_research_route_is_non_mutating():
    fixture_root = FIXTURES / "runtime_refs"

    response = asyncio.run(research_code_retirement_inventory_dry_run(
        CodeRetirementInventoryRequest(
            adoption_decision_packet=_replace_packet(),
            repo_root=str(fixture_root),
            candidate_paths=["services/predict_then_optimize.py"],
            owner_tokens=["predict_then_optimize"],
            parallel_readback_passed=False,
            rollback_path="services/direct_allocation_benchmark.py",
        )
    ))

    assert response["decision_effect"] == "retirement_inventory_only"
    assert response["filesystem_mutation_allowed"] is False
    assert response["destructive_action_executed"] is False
