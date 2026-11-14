"""K20 Slice A S3/S4: serving and cutover read the roster from the sealed object, not this checkout.

A published ensemble/bundle whose model_order differs from R33_MODELS still validates and
serves; the meta_layer roster echo is dropped from grant comparisons (Q7 A); the B-1 serving
curve sanity and the v3 OOF checks receipt fail closed. Synthetic fixtures only."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from services import r33_isotonic_calibration as calibration
from services import r33_rank_pool as rank_pool
from services.alpha_model_roster import R33_MODELS, TIMEXER_MODELS, is_r33_roster, model_order, validate_r33_roster
from services.r33_crossfit_serving import ESTIMATOR, SANITY_SCHEMA, serving_curve_sanity
from services.r33_ensemble import build_ensemble, validate_ensemble

ROOT = Path(__file__).resolve().parents[2]
THREE = ("LightGBM", "TabM", "GNN")
DAY = "2026-11-17"
SOURCE = "5" * 64


@pytest.mark.parametrize("roster", [("GNN",), THREE, R33_MODELS,
                                    tuple(n for n in TIMEXER_MODELS if n != "XGBoost")])
def test_any_canonical_subset_is_an_r33_roster(roster):
    assert validate_r33_roster(list(roster)) == roster and is_r33_roster(roster)


@pytest.mark.parametrize("roster", [(), ("GNN", "LightGBM"), ("LightGBM", "DLinear"), ("TabM", "TabM"),
                                    ("LightGBM", "Unknown"), "LightGBM", None, ("LightGBM", "XGBoost"),
                                    TIMEXER_MODELS])
def test_a_roster_out_of_slot_order_with_dlinear_repeats_or_empty_is_refused(roster):
    with pytest.raises(ValueError, match="alpha_roster_r33_order_invalid"):
        validate_r33_roster(roster)


def test_legacy_complete_stays_exact_and_only_r33_callers_resolve_a_roster_subset():
    assert model_order(set(TIMEXER_MODELS), complete=True) == TIMEXER_MODELS
    assert model_order(set(R33_MODELS), complete=True) == R33_MODELS
    # Legacy callers (no r33=) keep the exact eight-model / R33_MODELS match.
    for subset in ({"GNN", "LightGBM"}, {"LightGBM"}, set(THREE)):
        with pytest.raises(ValueError, match="alpha_roster_requires_exactly_eight_models"):
            model_order(subset, complete=True)
    # R33 call sites check the published object's own roster with validate_r33_roster instead.
    assert validate_r33_roster(THREE) == THREE
    with pytest.raises(ValueError):
        model_order({"DLinear", "LightGBM", "Unknown"}, complete=True)
    # A partial eight-model set (it holds XGBoost) stays fail-closed, as before Slice A.
    for missing in ("GNN", "TimeXer", "LightGBM"):
        with pytest.raises(ValueError, match="alpha_roster_requires_exactly_eight_models"):
            model_order(set(TIMEXER_MODELS) - {missing}, complete=True)
    with pytest.raises(ValueError, match="alpha_roster_requires_exactly_eight_models"):
        model_order({"LightGBM", "XGBoost"}, complete=True)


def test_ml_service_and_ml_controller_rosters_are_one_file():
    controller = (ROOT / "ml-controller/services/alpha_model_roster.py").read_bytes()
    service = (ROOT / "ml-service/app/alpha_model_roster.py").read_bytes()
    assert hashlib.sha256(controller).hexdigest() == hashlib.sha256(service).hexdigest()


def _calibration(monkeypatch, roster):
    monkeypatch.setattr(calibration, "MODELS", roster)   # what a cohort trained on another roster sealed
    blocks = calibration.pava([-1.0, -0.2, 0.3, 1.0], [-0.01, 0.0, 0.004, 0.01], [1, 1, 1, 1])
    payload = calibration.build_payload(blocks=blocks, variant="mean_z", horizon_sessions=5,
                                        inputs={"estimator": ESTIMATOR, "source_calibration_checksum": SOURCE},
                                        diagnostics={})
    monkeypatch.setattr(calibration, "MODELS", R33_MODELS)
    return payload


def _ensemble(monkeypatch, roster):
    return build_ensemble(
        cohort_id="c1", base_artifacts={m: {"artifact_id": f"{m}:c1", "version": f"{m}-v1", "checksum": "a" * 64}
                                        for m in roster},
        source_bundle={"path": "r33/monthly_candidates/c1/bundle.json", "sha256": "d" * 64, "manifest_checksum": "f" * 64,
                       "oof_checks_checksum": "c" * 64, "source_calibration_checksum": SOURCE},
        serving_calibration=_calibration(monkeypatch, roster),
        validation={"decision": "PASS", "oof_checks_status": "pass", "pit_certified": True,
                    "pit_certification_sha256": "9" * 64})


def test_a_three_model_object_validates_rank_pools_and_projects_under_the_four_model_checkout(monkeypatch):
    from services.active8_score_semantics import MODEL_SCORE_LINEAGE_SCHEMA_VERSION, MODEL_TARGET_SEMANTIC_VERSION
    from services import l3_equal_weight_bundle as bundle_owner
    from services.r33_calibration_job import POOL_SOURCE
    assert THREE != R33_MODELS
    ensemble = _ensemble(monkeypatch, THREE)
    assert tuple(ensemble["model_order"]) == THREE
    validate_ensemble(ensemble)
    rng = np.random.default_rng(3)
    symbols = [str(3000 + i) for i in range(10)]
    predictions = {s: {"model_score_lineage": {
        "schema_version": MODEL_SCORE_LINEAGE_SCHEMA_VERSION, "target_semantic_version": MODEL_TARGET_SEMANTIC_VERSION,
        "run_date": DAY, "model_order": list(THREE), "raw_scores": {m: float(rng.normal()) for m in THREE},
        "artifact_versions": {m: f"{m}-v1" for m in THREE}}} for s in symbols}
    identity = {"schema_version": "paired-nav-formal-ml-baseline-v1",
                **{k: ensemble[k] for k in rank_pool.IDENTITY_FIELDS}}
    pool = (symbols, {"source": POOL_SOURCE, "signal_date": DAY, "screener_run_id": "run-1",
                      "membership_sha256": "p" * 64})
    snapshot = rank_pool.build_rank_pool(signal_date=DAY, pool=pool, predictions=predictions, holdings=[],
                                         ensemble=ensemble, l3_identity=identity)
    assert snapshot["model_order"] == list(THREE) and set(snapshot["coverage"]["by_model"]) == set(THREE)
    evidence = predictions[symbols[0]]["r33_rank_evidence"]
    assert set(evidence["z"]) == set(THREE)
    bundle = bundle_owner.build_bundle(l3_identity=identity, ensemble=ensemble, training_label_known_max="2026-11-10")
    assert list(bundle["model"]["feature_names"]) == list(bundle_owner.feature_names(THREE))
    assert bundle["model"]["feature_names"][-1] == "score" and len(bundle["model"]["feature_names"]) == 2 * len(THREE) + 1
    bundle_owner.validate(bundle, l3_identity=identity, signal_date=DAY)
    forged = deepcopy(bundle)
    forged["model"]["feature_names"] = list(bundle_owner.feature_names(R33_MODELS))
    with pytest.raises((RuntimeError, ValueError)):
        bundle_owner.validate(forged, l3_identity=identity, signal_date=DAY)


def test_an_ensemble_whose_artifacts_differ_from_its_roster_is_refused(monkeypatch):
    ensemble = _ensemble(monkeypatch, THREE)
    broken = deepcopy(ensemble)
    broken["base_artifacts"]["ExtraTrees"] = {"artifact_id": "ExtraTrees:c1", "version": "v", "checksum": "a" * 64}
    with pytest.raises((RuntimeError, ValueError)):
        validate_ensemble(broken)


def test_the_cohort_tag_follows_the_roster():
    from routers.walk_forward import R33_ROSTER_COHORT_TAG, r33_roster_cohort_tag
    assert r33_roster_cohort_tag(("LightGBM", "ExtraTrees", "TabM", "GNN")) == "core4"
    tag = r33_roster_cohort_tag(THREE)
    assert tag == "r" + hashlib.sha256(",".join(THREE).encode()).hexdigest()[:8] and tag != "core4"
    assert R33_ROSTER_COHORT_TAG == r33_roster_cohort_tag(R33_MODELS)
    with pytest.raises(ValueError):
        r33_roster_cohort_tag(("GNN", "LightGBM"))


def _configuration(alpha_vote, slots, **meta):
    return {"trading_config": {"x": 1}, "risk_config": {},
            "native_execution_policy": {"frozen_kv": {"ml:adaptive_params": {"meta_layer": {
                "alpha_vote_models": alpha_vote, "formal_layer3_slots": slots, "confidence_delta": 0.1, **meta}}}}}


def test_without_roster_echo_drops_only_the_two_echo_fields():
    from services.active8_paper_admission import runtime_configuration_identity, without_roster_echo
    eight, four = list(TIMEXER_MODELS), list(R33_MODELS)
    granted, current = _configuration(eight, eight), _configuration(four, four)
    assert without_roster_echo(granted) == without_roster_echo(current)
    assert granted["native_execution_policy"]["frozen_kv"]["ml:adaptive_params"]["meta_layer"]["alpha_vote_models"] == eight
    assert runtime_configuration_identity(granted) == runtime_configuration_identity(current)
    other = _configuration(four, four, confidence_delta=0.2)
    assert without_roster_echo(other) != without_roster_echo(current)
    assert without_roster_echo({"trading_config": {}}) == {"trading_config": {}}


def test_verify_serving_configuration_ignores_the_echo_but_not_other_drift(monkeypatch):
    from services import active8_nav_adoption
    from services.active8_paper_admission import verify_serving_configuration
    eight, four = list(TIMEXER_MODELS), list(R33_MODELS)
    granted = _configuration(eight, eight)
    approval = {"configuration": granted}
    current = {"value": _configuration(four, four)}
    monkeypatch.setattr(active8_nav_adoption, "current_execution_configuration", lambda: deepcopy(current["value"]))
    assert verify_serving_configuration({"configuration": {}}, approval) == current["value"]
    current["value"] = _configuration(four, four, pf_quality_mult=2)
    with pytest.raises(RuntimeError, match="active8_nav_current_configuration_changed_or_unverified"):
        verify_serving_configuration({"configuration": {}}, approval)


def _table(scores, excess, days=8):
    n = len(scores)
    per = n // days
    return {"score": np.asarray(scores, float), "excess": np.asarray(excess, float),
            "day_rows": {f"2026-10-{i + 1:02d}": np.arange(i * per, (i + 1) * per) for i in range(days)}}


def _serving(blocks_y):
    blocks = calibration.pava([-1.0, -0.2, 0.3, 1.0], list(blocks_y), [1, 1, 1, 1])
    return calibration.build_payload(blocks=blocks, variant="mean_z", horizon_sessions=5,
                                     inputs={"estimator": ESTIMATOR, "source_calibration_checksum": SOURCE},
                                     diagnostics={})


def test_b1_sanity_passes_a_table_whose_buys_clear_the_cost():
    rng = np.random.default_rng(0)
    scores = np.tile([-1.0, -0.2, 0.3, 1.0], 40)
    excess = np.where(scores > 0.5, 0.02, -0.005) + rng.normal(0, 0.001, len(scores))
    payload = _serving([-0.01, 0.0, 0.004, 0.02])
    result = serving_curve_sanity(payload, table=_table(scores, excess), round_trip_cost=0.00585)
    assert result["schema_version"] == SANITY_SCHEMA and result["passed"] is True and result["reasons"] == []
    assert result["serving_table_checksum"] == payload["payload_checksum"] and result["in_sample"] is True
    json.dumps(result)


def test_b1_sanity_fails_when_the_top_block_or_the_realized_line_is_below_cost():
    scores = np.tile([-1.0, -0.2, 0.3, 1.0], 40)
    low = serving_curve_sanity(_serving([-0.01, 0.0, 0.001, 0.004]), table=_table(scores, np.full(len(scores), 0.01)),
                               round_trip_cost=0.00585)
    assert low["passed"] is False and "top_block_not_above_cost" in low["reasons"]
    losing = serving_curve_sanity(_serving([-0.01, 0.0, 0.004, 0.02]), table=_table(scores, np.full(len(scores), -0.01)),
                                  round_trip_cost=0.00585)
    assert losing["passed"] is False
    assert {"realized_excess_lower_bound_not_positive", "net_of_cost_lower_bound_not_positive"} <= set(losing["reasons"])
    with pytest.raises(ValueError, match="r33_round_trip_cost_invalid"):
        serving_curve_sanity(_serving([-0.01, 0.0, 0.004, 0.02]), table=_table(scores, scores), round_trip_cost=0)


def _oof_report(schema, *, gates=("crossfit_above_cost", "net_of_cost"), gate_cost=True):
    report = {"result": {"schema_version": schema, "checks": {"inversion": {"gates": dict.fromkeys(gates, True)}}}}
    if gate_cost:
        report["gate_cost"] = {"round_trip_cost": 0.00585}
    raw = json.dumps(report).encode()
    return raw, {"oof_checks": {"checksum": hashlib.sha256(raw).hexdigest()}}


def test_the_cutover_admits_only_the_sealed_v3_oof_checks_receipt():
    from services import r33_switch
    from services.r33_oof_checks import SCHEMA
    raw, bundle = _oof_report(SCHEMA)
    assert r33_switch.check_oof_checks_report(raw, bundle)["result"]["schema_version"] == SCHEMA
    with pytest.raises(RuntimeError, match="oof_checks_not_the_sealed_receipt"):
        r33_switch.check_oof_checks_report(raw + b" ", bundle)
    for stale in (_oof_report("r33-oof-checks-v2"), _oof_report(SCHEMA, gates=("crossfit_above_cost",)),
                  _oof_report(SCHEMA, gate_cost=False)):
        with pytest.raises(RuntimeError, match="oof_checks_schema_stale"):
            r33_switch.check_oof_checks_report(*stale)


def test_the_release_identity_covers_the_roster_owner():
    from services.paired_nav_recommendation_path import recommendation_source_identity
    assert "alpha_model_roster.py" in recommendation_source_identity()
