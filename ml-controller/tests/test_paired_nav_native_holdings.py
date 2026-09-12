"""Own held-stock forecasts use the original daily engine; synthetic inputs only."""
import asyncio
from copy import deepcopy

import pytest

from test_paired_nav_atomic_candidate import allocated, full_atomic, dispatched, environment, native_runner
from services.paired_nav_journal import digest, read_snapshot
from services.paired_native_models import atomic_model_context


@pytest.mark.parametrize('full_atomic', ['native_policy_holdings'], indirect=True)
def test_actual_holding_inference_preserves_selection_and_rejects_missing_or_borrowed_scope(allocated):
    db, graph, state = allocated
    context = read_snapshot(db.query,state['paired_nav_collection']['snapshot_id'])['payload']['content']
    prepared = context['atomic_recommendation_inputs']
    key = prepared['policy_population']['replacements'][0]['definition_checksum']
    definition = prepared['definitions'][key]
    scope = next(h for h in definition['holding_predictions'] if h['target_symbol']=='1001')
    assert scope['prediction']['stock_meta']['sector_peer_return_1d']==.075
    assert definition['predictions']['1000']['stock_meta']['sector_peer_return_1d']==.133333
    assert context['model_predictions']['1000']['stock_meta']['sector_peer_return_1d']==0
    model = atomic_model_context(context=context,prepared=prepared,definition_checksum=key)
    assert set(model['model_prediction_arms']['candidate']['predictions']) == {'1000','1001','1002','1003'}
    assert set(definition['predictions']) == {'1000','1002','1003'}
    for fault in ('missing', 'borrowed_reference', 'wrong_source'):
        bad = deepcopy(prepared)
        target = bad['definitions'][key]['holding_predictions']
        if fault=='missing':
            target.clear()
        elif fault=='borrowed_reference':
            target[0]['reference_key']=definition['inference_lineage']['baseline_key']
        else:
            target[0]['scope_checksum']='0'*64
        bad['input_hash']=digest({k:v for k,v in bad.items() if k!='input_hash'})
        with pytest.raises(ValueError,match='holding'):
            atomic_model_context(context=context,prepared=bad,definition_checksum=key)


@pytest.mark.parametrize('full_atomic', ['native_policy_holdings'], indirect=True)
def test_real_engine_checks_holding_scope_and_missing_result_is_not_formal_fallback(allocated):
    from app.paired_nav_atomic_inference import run_atomic_slates
    from test_paired_nav_atomic_dispatch import _compute
    db, graph, state = allocated
    request = asyncio.run(graph._build_pipeline_modal_prediction_payload(state,state_gcs_uri='gs://fixture/daily'))
    formal, _ = _compute(request)
    original = deepcopy(request)
    for fault in ('missing_scopes','wrong_reference','selected_target'):
        bad = deepcopy(request)
        packet = bad['paired_nav_atomic_slates']
        scope = packet['holding_evaluations'][0]
        if fault=='missing_scopes':
            del packet['holding_evaluations']
        elif fault=='wrong_reference':
            scope['reference_key']='0'*64
        else:
            scope['target_symbol']=packet['slates'][scope['reference_key']]['symbols'][0]
        packet['packet_checksum']=digest({k:v for k,v in packet.items() if k!='packet_checksum'})
        with pytest.raises(ValueError,match='atomic_inference_'):
            run_atomic_slates(bad,compute=lambda *_:pytest.fail('invalid scope reached model'),formal_bundle=formal)
    assert request==original
    response = formal['paired_nav_atomic_inference']
    holding = response['holding_evaluations'][0]
    del response['slates'][holding['slate_key']]
    child = deepcopy(state)
    child['modal_prediction_bundle']=formal
    output = asyncio.run(graph.node_l3_formal_predict(child))
    assert output['paired_nav_atomic_ml']['definitions'][holding['definition_checksum']]['status']=='incomplete'
    assert set(output['predictions'])=={'1000','1001','1003'}


def test_no_atomic_candidates_does_not_read_any_account_or_registry():
    from services.paired_nav_native_holdings import capture_native_holdings
    def forbidden(*args,**kwargs):
        pytest.fail('no candidate should need account or registry I/O')
    result = capture_native_holdings(signal_date='2026-09-07',definition_checksums=[],
        query=forbidden,writer=forbidden,paper_query=forbidden)
    assert result['definitions']=={} and result['initial_observation'] is None
    assert result['promotion_allowed'] is False and result['nav_maturity_credit']==0
