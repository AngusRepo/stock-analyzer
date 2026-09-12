from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from services import recommendation_service as reco
from services.ensemble_v2 import attach_ensemble_v2
from services.active8_score_semantics import (
    MODEL_SCORE_LINEAGE_SCHEMA_VERSION, MODEL_SCORE_SEMANTIC_VERSION, MODEL_TARGET_SEMANTIC_VERSION,
)
from test_recommendation_provenance import _screener_rec, _payload, _l4_alpha_ev


def prediction(advice):
    artifact = json.loads((Path(__file__).parent / 'fixtures/active8_ensemble_20260909.json').read_text(encoding='utf-8'))
    pools = {n: {'serving_artifact_id': a['artifact_id'], 'version': a['version'],
                 'checksum': a['checksum'], 'serving_eligible': True} for n,a in artifact['base_artifacts'].items()}
    pred = {'rank_scores': {n: .6 for n in artifact['model_order']},
            'model_score_lineage': {'schema_version': MODEL_SCORE_LINEAGE_SCHEMA_VERSION,
                 'semantic_version': MODEL_SCORE_SEMANTIC_VERSION,
                 'target_semantic_version': MODEL_TARGET_SEMANTIC_VERSION,
                 'complete': True, 'blockers': []}}
    attach_ensemble_v2(pred, artifact, pools)
    # Vary advice only: identical prediction evidence and downstream EV.
    pred['ensemble_v2'].update(signal=advice, unqualified_signal=advice, advisory_signal=advice)
    pred['ensemble_v2']['l4_alpha_ev'] = _l4_alpha_ev(.03)
    return pred


@pytest.mark.parametrize('advice', ['BUY', 'STRONG_BUY', 'HOLD', 'SELL', 'STRONG_SELL', 'NO_SIGNAL'])
def test_filter_family_sparse_and_writer_keep_advice_separate(advice, monkeypatch):
    pred = prediction(advice)
    before = copy.deepcopy(pred['ensemble_v2'])
    rows, removed = reco.filter_and_score_recommendations(
        [_screener_rec('2330')], {'2330': pred}, [_payload('2330')])
    assert removed == 0 and len(rows) == 1
    assert rows[0]['has_buy_signal'] == 0
    rows = reco.apply_core_family_evidence(rows, {'2330':pred},
        require_lifecycle_weights=True, require_complete_active_models=True)
    assert len(rows) == 1 and rows[0]['core_family_evidence']['formal_model_contract_passed']
    rows = reco.apply_sparse_tangent_allocation(rows, {'enabled':True},
        alpha_policy={'allocation': {'engine':'sparse_tangent_inverse_risk', 'controller':'SparseTangent'}})
    assert rows[0]['signal'] == 'BUY' and rows[0]['has_buy_signal'] == 1
    assert rows[0]['score_components']['mlAdvisory']['signal'] == advice
    assert rows[0]['alpha_allocation']['expected_return_owner'] == 'l4_alpha_ev'
    assert pred['ensemble_v2']['artifact_checksum'] == before['artifact_checksum']
    captured=[]
    monkeypatch.setattr(reco, '_filter_to_existing_recommendation_seed_rows', lambda rows, date: rows)
    monkeypatch.setattr(reco, '_delete_stale_recommendation_rows', lambda *a: None)
    monkeypatch.setattr(reco.CORE_D1_CLIENT, 'batch_execute', lambda statements: captured.extend(statements) or len(statements))
    assert reco.update_recommendations_in_d1(rows, '2026-04-22') == 1
    json_values=[]
    for value in captured[0][1]:
        if isinstance(value, str) and value.startswith('{'):
            json_values.append(json.loads(value))
    scores=next(v for v in json_values if v.get('version') == 'score_v2')
    assert scores['mlAdvisory']['signal'] == advice
    assert scores['mlAdvisory']['role'] == 'advisory_only'


def test_allocation_disabled_cannot_publish_raw_ml_buy():
    rows=[{'symbol':'AAA', 'signal':'BUY', 'has_buy_signal':1,
           'alpha_allocation':{'selected':True, 'allocation_weight':1.0}, 'score_components':{}}]
    result=reco.apply_sparse_tangent_allocation(rows, {'enabled':False})[0]
    assert result['signal']=='HOLD' and result['has_buy_signal']==0
    assert result['alpha_allocation']['selected'] is False
    assert result['score_components']['mlAdvisory']['signal']=='BUY'


@pytest.mark.parametrize('failure', ['missing_family', 'risk', 'research', 'negative_ev', 'missing_ev'])
def test_advice_cannot_bypass_structure_risk_or_valid_ev(failure):
    from test_allocator_direction_authority import _formal_l4_row, _l4_alpha_ev
    row = _formal_l4_row('AAA')
    if failure == 'missing_family': row['score_components'].pop('coreFamilyEvidence')
    elif failure == 'risk': row['alpha_context'] = {'risk_overlay': {'skip': True}}
    elif failure == 'research': row['eligible_for_pending_buy'] = False
    elif failure == 'negative_ev': row['l4_alpha_ev'] = _l4_alpha_ev(-.01)
    else: row.pop('l4_alpha_ev')
    result = reco._apply_sparse_tangent_buy_selection([row], {},
        {'allocation': {'controller': 'SparseTangent'}}, confidence_floor=.6, return_history={})[0]
    assert result['has_buy_signal'] == 0
    assert result['alpha_allocation']['selected'] is False
