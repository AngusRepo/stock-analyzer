"""R33 release roster after 2026-11-07: four cross-sectional families, no sequence family.

The G5 #3 cohort put TimeXer / PatchTST / iTransformer at OOF rank IC ~0 while the trees, TabM and GNN
passed CPCV; Wei removed the three for the November release. A four-model cohort must get its own id
(the seven-model cohort's write-once OOF checks and fold artifacts stay where they are), and the tail
guard must not hard-gate a family that is no longer trained.
"""
from services.alpha_model_roster import R33_MODELS, model_order, validate_order
from services.active8_release_model_profiles import model_profiles
from services.formal_feature_contract import R33_PROFILE
from services import r33_oof_checks
from services.r33_isotonic_calibration import MODELS
import routers.walk_forward as wf


def test_r33_roster_is_the_four_cross_sectional_families():
    assert R33_MODELS == ("LightGBM", "ExtraTrees", "TabM", "GNN")
    assert set(model_profiles(schema_version=R33_PROFILE)) == set(R33_MODELS)
    assert model_order(model_profiles(schema_version=R33_PROFILE), complete=True) == R33_MODELS
    assert model_order(R33_MODELS, complete=True) == R33_MODELS and validate_order(R33_MODELS) == R33_MODELS


def test_calibration_pool_and_tail_guard_follow_the_roster():
    assert MODELS == R33_MODELS
    assert r33_oof_checks.TAIL_GUARD_HARD == ("TabM",) and r33_oof_checks.TAIL_GUARD_POLICY == "v5"


def test_r33_cohort_id_carries_the_roster_tag():
    assert wf.R33_ROSTER_COHORT_TAG == "core4"


def test_release_execution_scope_has_no_group_or_target_for_an_unrostered_family():
    from services.active8_release_training_contract import (
        RELEASE_ARTIFACT_LIFECYCLE_TARGETS, RELEASE_TRAIN_GROUPS, normalize_release_execution_scope,
        release_execution_scope)
    from services.alpha_model_roster import LEGACY_MODELS, TIMEXER_MODELS

    assert release_execution_scope(R33_MODELS) == (("tree",), ("GNN", "TabM"))
    assert release_execution_scope(LEGACY_MODELS) == (RELEASE_TRAIN_GROUPS, RELEASE_ARTIFACT_LIFECYCLE_TARGETS)
    assert release_execution_scope(TIMEXER_MODELS) == (("tree", "timexer", "patchtst"), RELEASE_ARTIFACT_LIFECYCLE_TARGETS)
    groups, targets = normalize_release_execution_scope([], [], model_profile_schema_version=R33_PROFILE)
    assert (groups, targets) == (["tree"], ["GNN", "TabM"])


def test_full_fit_plan_dispatches_only_the_four_r33_trainers(monkeypatch):
    manifest = {"model_profile_schema_version": R33_PROFILE, "model_set": list(R33_MODELS),
                "aggregate": {"full_fit_eligible_models": list(R33_MODELS)}}
    monkeypatch.setattr(wf, "build_oof_full_fit_feature_consensus", lambda m: {"status": "not_ready"})
    plan = wf.build_oof_full_fit_dispatch_plan(manifest)
    assert plan["train_model_groups"] == ["tree"]
    assert plan["artifact_lifecycle_targets"] == ["GNN", "TabM"]
    assert plan["tree_models"] == ["ExtraTrees", "LightGBM"]
    assert plan["release_models"] == sorted(R33_MODELS)
