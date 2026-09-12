from __future__ import annotations
import copy
import json
from pathlib import Path
import pytest
from services.ensemble_qualification import assess_ensemble_qualifications, qualify_directional_signal
from services.active8_ensemble_artifact import payload_checksum
from services import model_artifact_registry as registry
from services.ensemble_v2 import attach_ensemble_v2
from test_active8_ensemble_artifact import _build, _rows
from test_active8_ensemble_bundle_promotion import _fixture, AtomicD1
from test_active8_cutover_contract import MODEL_SCORE_LINEAGE_SCHEMA_VERSION, MODEL_SCORE_SEMANTIC_VERSION, MODEL_TARGET_SEMANTIC_VERSION


def _signal_payload():
    return {
        "validation": {"decision": "PASS", "failed_gates": [], "validation_dates": 21, "spread_dates": 21,
                       "rank_ic_equal_date_market_lcb90": .04, "top_bottom_net_return_spread_lcb90": .003,
                       "buy_interval_empirical_coverage": .94, "strong_interval_empirical_coverage": .97,
                       "directional_evidence": {name: {"rows": 250, "dates": 12, "net_mean": .02, "date_net_mean_lcb90": .005}
                                                for name in ("BUY", "STRONG_BUY", "SELL", "STRONG_SELL")}},
        "fit": {"intercept": -.05, "coefficients": [.1] + [0.]*15},
        "signal_policy": {"buy_coverage": .9, "strong_coverage": .95},
        "calibration": {"absolute_residual_quantiles": {"0.9": .01, "0.95": .02}},
    }


def _resign(row, payload):
    payload["payload_checksum"] = payload_checksum({k:v for k,v in payload.items() if k != "payload_checksum"})
    row["payload_json"] = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    row["payload_checksum"] = payload["payload_checksum"]


def test_directional_block_does_not_prevent_new_artifact_ranking_promotion(monkeypatch):
    import services.active8_ensemble_artifact as builder
    monkeypatch.setattr(builder, "finite_sample_quantile", lambda *args: 1.0)
    artifact = _build(_rows())
    assert artifact["validation"]["decision"] == "PASS"
    assert artifact["validation"]["decision_scope"] == "ranking"
    assert artifact["validation"]["directional_signal_rows"] == 0
    assert artifact["validation"]["directional_decision"] == "BLOCKED"
    assert all(value is False for value in artifact["validation"]["final_fit_signal_reachability"].values())
    assert assess_ensemble_qualifications(artifact)["ranking"]["decision"] == "PASS"


def test_bad_calibration_does_not_turn_ranking_winner_into_failed_bundle(monkeypatch):
    import services.active8_ensemble_artifact as builder
    monkeypatch.setattr(builder, "finite_sample_quantile", lambda *args: 0.0)
    artifact = _build(_rows())
    qualification = assess_ensemble_qualifications(artifact)
    assert qualification["ranking"]["decision"] == "PASS"
    assert qualification["calibration"]["decision"] == "INSUFFICIENT"
    assert qualification["directional"]["decision"] == "BLOCKED"


def test_zero_signal_ranking_pass_cannot_publish_without_nav_authority(monkeypatch):
    rows, pointers, ensemble = _fixture()
    payload = json.loads(ensemble["payload_json"])
    payload["validation"]["directional_signal_rows"] = 0
    _resign(ensemble, payload)
    before = ensemble["payload_json"]
    db = AtomicD1(rows, ensemble)
    monkeypatch.setattr(registry, "d1_client", db)
    result = registry.run_active8_ensemble_bundle_promotion_controller(
        training_run_id="run-new", registry_rows=rows, d1_pointers=pointers, ensemble_rows=[ensemble], confirm=True)
    assert result["can_promote"] is False
    assert result["decision"] == "active8_new_publication_requires_daily_nav"
    assert assess_ensemble_qualifications(payload)["ranking"]["decision"] == "PASS"
    assert assess_ensemble_qualifications(payload)["directional"]["decision"] == "BLOCKED"
    assert ensemble["payload_json"] == before


def test_ranking_failure_still_blocks_atomic_promotion():
    rows, pointers, ensemble = _fixture()
    payload = json.loads(ensemble["payload_json"])
    payload["validation"]["rank_ic_equal_date_market_lcb90"] = -.01
    _resign(ensemble, payload)
    result = registry.run_active8_ensemble_bundle_promotion_controller(
        training_run_id="run-new", registry_rows=rows, d1_pointers=pointers, ensemble_rows=[ensemble])
    assert result["can_promote"] is False


def test_real_legacy_bundle_keeps_forecasts_and_checksum_but_marks_policy_blocked():
    path = Path(__file__).parent/'fixtures/active8_ensemble_20260909.json'
    artifact = json.loads(path.read_text(encoding='utf-8'))
    before = copy.deepcopy(artifact)
    pool = {name: {"serving_artifact_id": row["artifact_id"], "version": row["version"],
                   "checksum": row["checksum"], "serving_eligible": True} for name,row in artifact["base_artifacts"].items()}
    prediction = {"rank_scores": {name: 1.0 for name in artifact['model_order']},
                  "model_score_lineage": {"schema_version": MODEL_SCORE_LINEAGE_SCHEMA_VERSION,
                                          "semantic_version": MODEL_SCORE_SEMANTIC_VERSION,
                                          "target_semantic_version": MODEL_TARGET_SEMANTIC_VERSION,
                                          "complete": True, "blockers": []}}
    attach_ensemble_v2(prediction, artifact, pool)
    result = prediction['ensemble_v2']
    assert result['formal_model_input_contract']['complete']
    assert result['forecast_pct'] is not None and result['probability_positive_net_return'] is not None
    assert result['signal'] == 'HOLD' and result['signal_status'] == 'policy_blocked'
    assert 'signal_unreachable' in result['signal_blockers']
    assert result['qualifications']['ranking']['decision'] == 'PASS'
    assert artifact == before


def test_per_direction_qualification_and_genuine_market_hold():
    payload = _signal_payload()
    assert qualify_directional_signal('HOLD', payload)['signal_status'] == 'market_hold'
    assert qualify_directional_signal('BUY', payload)['signal'] == 'BUY'
    payload['validation']['directional_evidence']['STRONG_BUY']['rows'] = 0
    assert qualify_directional_signal('STRONG_BUY', payload)['signal'] == 'BUY'
    payload['validation']['directional_evidence']['BUY']['rows'] = 0
    assert qualify_directional_signal('BUY', payload)['signal_status'] == 'policy_blocked'
    assert qualify_directional_signal('SELL', payload)['signal'] == 'SELL'


@pytest.mark.parametrize('mutation', ['missing', 'few_dates', 'negative_edge', 'unreachable', 'nonfinite'])
def test_directional_failures_never_degrade_ranking(mutation):
    payload = _signal_payload()
    if mutation == 'missing': payload['validation'].pop('directional_evidence')
    elif mutation == 'few_dates': payload['validation']['directional_evidence']['BUY']['dates'] = 1
    elif mutation == 'negative_edge': payload['validation']['directional_evidence']['BUY']['date_net_mean_lcb90'] = -.01
    elif mutation == 'unreachable': payload['calibration']['absolute_residual_quantiles']['0.9'] = .5
    else: payload['calibration']['absolute_residual_quantiles']['0.9'] = float('nan')
    result = assess_ensemble_qualifications(payload)
    assert result['ranking']['decision'] == 'PASS'
    assert result['directional']['signals']['BUY']['decision'] == 'BLOCKED'


def test_modal_controller_qualification_modules_are_identical():
    root = Path(__file__).resolve().parents[2]
    assert (root/'ml-controller/services/ensemble_qualification.py').read_bytes() == (root/'ml-service/app/ensemble_qualification.py').read_bytes()


def test_recommendation_cannot_use_raw_buy_to_bypass_directional_qualification():
    from services.recommendation_service import _formal_ml_buy_admission, _ml_edge_policy_evidence
    q = assess_ensemble_qualifications(_signal_payload())
    q['directional']['allowed_signals'] = []
    edge = _ml_edge_policy_evidence({'ensemble_v2': {'artifact_checksum': 'a'*64, 'signal':'BUY',
        'probability_positive_net_return': .7, 'validation': {'decision':'PASS'},
        'qualifications': q, 'signal_status':'policy_blocked', 'signal_blockers':['signal_unreachable']}})
    row = {'score_components': {'mlEdgePolicy':edge, 'coreFamilyEvidence': {
        'active_family_count':3, 'formal_model_contract_passed':True, 'evidence_status':'sufficient_family_breadth'}}}
    allowed, evidence = _formal_ml_buy_admission(row)
    assert allowed is False and evidence['direction_qualified'] is False
    assert evidence['signal_blockers'] == ['signal_unreachable']
