from copy import deepcopy
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-service"))
sys.path.insert(0, str(ROOT / "ml-controller"))

from app.model_validation import build_model_cpcv_evidence as ml_build
from services.model_cpcv_evidence import build_model_cpcv_evidence as controller_build, review_model_tail_evidence
from services.model_validation_policy import resolve_model_validation_policy

MODELS = ("LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN", "TimeXer", "PatchTST", "iTransformer")


@pytest.mark.parametrize("name", ("model_validation_policy.py", "model_tail_validation.py"))
def test_packaged_rules_are_identical(name):
    assert (ROOT / "ml-service/app" / name).read_bytes() == (ROOT / "ml-controller/services" / name).read_bytes()


@pytest.mark.parametrize("model", MODELS)
def test_all_eight_require_existing_tail_rule(model):
    guard = resolve_model_validation_policy(model_name=model, stage="promotion")["cpcv"]["tail_fold_guard"]
    assert guard["enabled"] is True
    assert guard["required_for_serving_promotion"] is True
    assert (guard["tail_folds"], guard["confidence_level"], guard["min_date_clusters"]) == (3, 0.90, 10)


def folds_for(case):
    values = [0.10, 0.12, 0.11, 0.09, 0.04, 0.02, -0.01]
    daily = [-0.04, -0.03, -0.02, -0.03] if case == "negative" else [-0.04, 0.03, -0.03, 0.03]
    rows = []
    for index, value in enumerate(values):
        row = {"fold_id": index + 1, "oos_ic": value, "test_rows": 1000, "coverage": 1.0}
        if index >= 4 and case != "missing":
            row["date_cluster_ics"] = [{"date": f"2026-07-{(index-4)*4+j+1:02d}", "rank_ic": v} for j, v in enumerate(daily)]
        rows.append(row)
    return rows


@pytest.mark.parametrize("model", MODELS)
@pytest.mark.parametrize("case", ("negative", "uncertain", "missing"))
def test_tail_decision_is_identical_across_actual_builders(model, case):
    rows = folds_for(case)
    before = deepcopy(rows)
    packets = [build(model=model, fold_metrics=rows, stage="promotion") for build in (ml_build, controller_build)]
    assert rows == before
    for key in ("tail_fold_stats", "failed_gates", "warning_gates", "decision", "serving_disposition"):
        assert packets[0][key] == packets[1][key]
    if case == "negative":
        assert "cpcv_tail_oos_ic" in packets[0]["failed_gates"]
    elif case == "missing":
        assert "cpcv_tail_uncertainty_evidence" in packets[0]["failed_gates"]
    else:
        assert packets[0]["serving_disposition"] == "DEGRADED"
        assert "cpcv_tail_oos_ic_uncertain" in packets[0]["warning_gates"]
    assert packets[1]["fold_metrics"] == before


def test_historical_review_does_not_mutate_or_erase_prior_failures():
    packet = ml_build(model="LightGBM", fold_metrics=folds_for("uncertain"), stage="promotion")
    packet["policy"]["tail_fold_guard"]["enabled"] = False
    packet["policy"]["tail_fold_guard"]["required_for_serving_promotion"] = False
    packet["failed_gates"] = ["cpcv_coverage"]
    original = deepcopy(packet)
    review = review_model_tail_evidence("LightGBM", packet)
    assert packet == original
    assert review["decision"] == "FAIL"
    assert "cpcv_coverage" in review["failed_gates"]
    assert review["production_effect"] is False
    for key, value in original["policy"]["tail_fold_guard"].items():
        if key not in ("enabled", "required_for_serving_promotion"):
            assert review["tail_fold_guard"][key] == value


def test_missing_review_is_explicit_not_pass():
    assert review_model_tail_evidence("GNN", {})["status"] == "evidence_missing"


def test_selection_review_preserves_immutable_evidence_and_identity():
    from services.model_artifact_registry import _with_tail_review

    evidence = ml_build(model="LightGBM", fold_metrics=folds_for("uncertain"), stage="promotion")
    row = {"model_name": "LightGBM", "artifact_id": "id", "version": "sealed", "state": "production",
           "offline_evidence_json": {"registration": {"oof_promotion_evidence": evidence}}}
    before = deepcopy(row)
    annotated = _with_tail_review(row)
    assert row == before
    assert {k: v for k, v in annotated.items() if k != "cpcv_tail_review"} == before
    assert annotated["cpcv_tail_review"]["serving_disposition"] == "DEGRADED"
