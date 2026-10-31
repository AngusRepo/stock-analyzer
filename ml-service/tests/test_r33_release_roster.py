"""R33 seven-model roster: no hardcoded eight-model/XGBoost assumptions on the release path."""
from __future__ import annotations

import json

import numpy as np
import pytest

from app.oof_challengers import challenger_metric, normalize_challengers
from app.purged_cv import purged_explicit_walk_forward_indices
from app.training_finalizer import reduce_tree_model_child_results
from app.training_policy import build_group_train_payload, build_tree_model_child_payloads

R33_TREES = ["LightGBM", "ExtraTrees"]


def test_old_tree_payloads_are_byte_identical_without_tree_models():
    base = {"run_id": "r1", "candidate_type": "oof_full_fit_release"}
    group = build_group_train_payload(base, "tree")
    assert group["models_filter"] == ["LightGBM", "XGBoost", "ExtraTrees"]
    children = build_tree_model_child_payloads(base)
    assert list(children) == ["LightGBM", "XGBoost", "ExtraTrees"]
    assert all(c["tree_split_parent_models"] == ["LightGBM", "XGBoost", "ExtraTrees"] for c in children.values())
    assert "tree_models" not in group


def test_r33_tree_models_narrow_the_tree_group_and_children():
    base = {"run_id": "r1", "tree_models": R33_TREES}
    assert build_group_train_payload(base, "tree")["models_filter"] == R33_TREES
    children = build_tree_model_child_payloads(base)
    assert list(children) == R33_TREES
    assert children["ExtraTrees"]["tree_split_parent_models"] == R33_TREES
    with pytest.raises(ValueError, match="tree_models_outside_tree_family"):
        build_group_train_payload({"tree_models": ["TabM"]}, "tree")


def _child(name):
    return {"results": {name: {"ic": 0.1}}, "ic_tracking": {name: {"passed": True}}}


def test_reducer_requires_only_the_dispatched_tree_models():
    r33 = reduce_tree_model_child_results({m: _child(m) for m in R33_TREES}, required_models=R33_TREES)
    assert not [e for e in r33["child_errors"] if "missing_tree_models" in e["error"]]
    legacy = reduce_tree_model_child_results({m: _child(m) for m in R33_TREES})
    assert {"model": "tree", "error": "missing_tree_models:XGBoost"} in legacy["child_errors"]


def test_forward_source_contract_follows_the_window_roster():
    from app.oof_forward_source_contract import assess_fold_forward_sources
    sha = "a" * 64
    metrics = {m: {"status": "ready", "oof_artifact": f"p/{m}", "artifact_checksum": sha}
               for m in ("LightGBM", "ExtraTrees", "TabM", "GNN")}
    window = {"window_id": 1, "model_metrics": metrics,
              "model_coverage": {"active8_models": ["LightGBM", "ExtraTrees", "TabM", "GNN", "PatchTST", "iTransformer", "TimeXer"]}}
    reasons = assess_fold_forward_sources(window, cohort_id="c")["reasons"]
    assert not any("XGBoost" in r for r in reasons)
    legacy = dict(window)
    legacy.pop("model_coverage")
    assert any("core_oof_metric_not_ready:XGBoost" == r for r in assess_fold_forward_sources(legacy, cohort_id="c")["reasons"])


def test_purged_split_attests_the_latest_training_label():
    dates = np.array(["2026-01-0%d" % d for d in range(1, 10)])
    known = np.array(["2026-01-0%d" % min(d + 2, 9) for d in range(1, 10)])
    _, _, meta = purged_explicit_walk_forward_indices(
        dates, train_start="2026-01-01", train_end="2026-01-06", test_start="2026-01-07", test_end="2026-01-09",
        label_horizon_days=2, label_known_dates=known)
    assert meta["train_label_known_max"] < "2026-01-07"
    _, _, approx = purged_explicit_walk_forward_indices(
        dates, train_start="2026-01-01", train_end="2026-01-06", test_start="2026-01-07", test_end="2026-01-09",
        label_horizon_days=2)
    assert "train_label_known_max" not in approx  # legacy approximation metadata unchanged


def test_challengers_stay_outside_the_release_roster():
    assert normalize_challengers(["LGBMRanker", "LGBMRanker", ""], ["LightGBM"]) == ["LGBMRanker"]
    with pytest.raises(ValueError, match="oof_challenger_overlaps_release_roster:LightGBM"):
        normalize_challengers(["LightGBM"], ["LightGBM", "TabM"])
    ready = challenger_metric({"oos_ic": 0.02, "oof_artifact": {"path": "gs/x.npz", "payload_checksum": "b" * 64}})
    assert ready == {"status": "ready", "oos_ic": 0.02, "oof_artifact": "gs/x.npz", "artifact_checksum": "b" * 64}
    assert challenger_metric({"error": "boom"})["status"] == "failed"


def test_modal_release_path_derives_tree_roster_from_the_contract():
    source = open("modal_app.py", encoding="utf-8").read()
    assert 'release_tree_models = [m for m in TREE_MODEL_NAMES if m in verified_release_contract["models"]]' in source
    assert "required_models=list(child_payloads)" in source
    assert 'result["challenger_metrics"] = challenger_results' in source
    assert json.dumps(["XGBoost", "ExtraTrees", "LightGBM"]) not in source.split("def _oof_challenger_trainers", 1)[1][:200]


def test_r33_challenger_slots_resolve_from_w2_contract_with_import_guard(monkeypatch):
    import sys
    import types
    import modal_app
    from app.formal_feature_contract import EXO131_PROFILE, R33_PROFILE
    # Before PR #71: the contract module is absent, so R33 schedules no slot.
    monkeypatch.setitem(sys.modules, "app.challenger_models", None)
    assert modal_app._oof_challenger_slots(R33_PROFILE) == {}
    # With the contract (stub mirrors W2's LIFECYCLE_SLOTS shape): only R33 schedules the slot.
    slots = {"linear_neutral": {"modal_function": "train_linear_neutral_universal",
                                "payload_config": {"neutralization_exposures": "auto", "validation_folds": 8}}}
    monkeypatch.setitem(sys.modules, "app.challenger_models", types.SimpleNamespace(LIFECYCLE_SLOTS=slots))
    assert modal_app._oof_challenger_slots(R33_PROFILE) == slots
    assert modal_app._oof_challenger_slots(EXO131_PROFILE) == {}
    # The trainer resolves only when the Modal function exists in this app.
    monkeypatch.delattr(modal_app, "train_linear_neutral_universal", raising=False)
    assert modal_app._oof_challenger_trainers(slots) == {}
    trainer = object()
    monkeypatch.setattr(modal_app, "train_linear_neutral_universal", trainer, raising=False)
    resolved = modal_app._oof_challenger_trainers(slots)
    assert resolved == {"linear_neutral": (trainer, {"neutralization_exposures": "auto", "validation_folds": 8})}
    source = open("modal_app.py", encoding="utf-8").read()
    assert '{**train_payload, **slot_config, "oof_challenger": True}' in source  # auto slot: no model_name
    assert challenger_metric({"model": "LinearNeutralSize", "oof_artifact": {"path": "p", "payload_checksum": "c"}})["model"] == "LinearNeutralSize"


def test_r33_challenger_slots_match_w2_contract_when_present():
    try:
        from app.challenger_models import LIFECYCLE_SLOTS
    except ImportError:
        pytest.skip("PR #71 (app.challenger_models) not merged into this branch")
    import modal_app
    from app.formal_feature_contract import R33_PROFILE
    assert list(modal_app._oof_challenger_slots(R33_PROFILE)) == ["linear_neutral"] == list(LIFECYCLE_SLOTS)
    assert set(modal_app._oof_challenger_trainers(LIFECYCLE_SLOTS)) == {"linear_neutral"}
