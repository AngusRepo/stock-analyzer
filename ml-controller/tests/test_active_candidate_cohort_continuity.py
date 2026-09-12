import asyncio
from unittest.mock import AsyncMock
import pytest
from routers import walk_forward as wf
from services.expected_return_candidate_forward_evaluator import active_locked_candidate_lane


def lane_rows(sql, params):
    assert params == ["2026-09-09"]
    assert "training_data.trained_until') =" not in sql
    return [{"artifact_id": "locked-l4", "model_name": "l4_alpha_ev",
             "training_run_id": "active8_oof:old-cohort", "source_run_date": "2026-08-30",
             "artifact_trained_until": "2026-08-18", "state": "shadowing",
             "offline_gate_decision": "FAIL", "offline_gate_failed_gates": '["walk_forward_not_stable"]'}]


def test_active_lane_resolves_original_cohort_despite_new_base():
    assert active_locked_candidate_lane(lane_rows, "2026-09-09")["cohort_id"] == "old-cohort"


@pytest.mark.parametrize("cached", [False, True])
def test_rollover_continues_exact_original_lane_without_training(monkeypatch, cached):
    evaluation = {"status": "evaluated", "candidate_artifact_ids": {"l4_alpha_ev": "locked-l4"},
                  "gates": {"l4_alpha_ev": {"evaluated_as_of_date": "2026-09-09",
                                            "evaluation_cohort_id": "old-cohort", "evaluable_date_count": 7}},
                  "promotion_ready": False}
    result = {"receipt": {"evidence_closure": {"candidate_forward_evaluation": evaluation}}} if cached else {"candidate_forward_evaluation": evaluation}
    resume = AsyncMock(return_value=result)
    monkeypatch.setattr(wf, "run_walk_forward_oof_lifecycle", resume)
    def forbidden():
        raise AssertionError("new cohort features must not evaluate original candidate")
    actual = asyncio.run(wf._evaluate_active_candidate_on_original_cohort(
        request_cohort_id="new-cohort", business_date="2026-09-09",
        query_fn=lane_rows, evaluate_current=forbidden))
    req = resume.call_args.args[0]
    assert req.expected_cohort_id == "old-cohort"
    assert req.continuation_only and not req.dispatch_full_fit and not req.promote
    assert actual["evaluation_cohort_id"] == "old-cohort"
    assert actual["gates"]["l4_alpha_ev"]["evaluable_date_count"] == 7


@pytest.mark.parametrize("defect", ["identity", "date", "cohort", "retry"])
def test_rollover_cannot_close_from_stale_or_unrelated_evidence(monkeypatch, defect):
    gate = {"evaluated_as_of_date": "2026-09-09", "evaluation_cohort_id": "old-cohort"}
    ids = {"l4_alpha_ev": "locked-l4"}
    if defect == "identity": ids["l4_alpha_ev"] = "other"
    if defect == "date": gate["evaluated_as_of_date"] = "2026-09-08"
    if defect == "cohort": gate["evaluation_cohort_id"] = "new-cohort"
    monkeypatch.setattr(wf, "run_walk_forward_oof_lifecycle", AsyncMock(return_value={
        "dependency_retry_required": defect == "retry",
        "candidate_forward_evaluation": {"status": "evaluated", "candidate_artifact_ids": ids,
                                         "gates": {"l4_alpha_ev": gate}}}))
    actual = asyncio.run(wf._evaluate_active_candidate_on_original_cohort(
        request_cohort_id="new-cohort", business_date="2026-09-09", query_fn=lane_rows,
        evaluate_current=lambda: None))
    assert actual["status"] == "active_candidate_original_cohort_pending"
    assert not actual["promotion_ready"]


def test_same_cohort_does_not_recurse(monkeypatch):
    resume = AsyncMock()
    monkeypatch.setattr(wf, "run_walk_forward_oof_lifecycle", resume)
    result = asyncio.run(wf._evaluate_active_candidate_on_original_cohort(
        request_cohort_id="old-cohort", business_date="2026-09-09", query_fn=lane_rows,
        evaluate_current=lambda: {"status": "evaluated"}))
    assert result["status"] == "evaluated"
    resume.assert_not_called()


@pytest.mark.parametrize("observed,freeze,decision,retry", [
    ("2026-09-01", "2026-08-30", "PENDING", True),
    ("2026-09-02", "2026-08-30", "PENDING", False),
    ("2026-09-01", "2026-09-09", "PENDING", False),
    ("2026-09-01", "2026-08-30", "FAIL", False),
])
def test_mature_frontier_is_not_execution_success(observed, freeze, decision, retry):
    from services.expected_return_candidate_forward_evaluator import candidate_forward_frontier
    evidence = {"candidate_source_run_date": freeze, "gates": {"l4_alpha_ev": {
        "decision": decision, "artifact_trained_until": "2026-08-18", "prediction_date_max": observed}}}
    assert candidate_forward_frontier(evidence, expected_prediction_date="2026-09-02",
                                      business_date="2026-09-09")["retry_required"] is retry
