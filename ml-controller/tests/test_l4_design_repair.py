from copy import deepcopy
import numpy as np
import pytest
from services.l4_distribution import digest, predict
from services.l4_l3_baseline import native_baseline, validate_baseline, attach_baseline
from services.l4_incremental_acceptance import build_comparison, validate_comparison
from services.l4_prediction_evaluation import evaluate_predictions
from services.l4_distribution_lifecycle import prepare_paper_release
from test_l4_distribution_runtime import prediction, IDENTITY, bundle, fixture
from test_l4_distribution import features, constant_model
from l4_comparison_fixture import comparison


def baseline(value):
    p=prediction();p['ensemble_v2'].update(ml_expected_net_return=value,forecast_return_5bar=value)
    return native_baseline(p,IDENTITY)


@pytest.mark.parametrize('value',[-.02,-.0018,0.,.001,.03])
def test_l3_mean_is_preserved_without_rank_conversion_and_cost_applied_once(value):
    b=baseline(value)
    assert b['expected_return_net']==value
    assert b['expected_return_gross']==pytest.approx(value+.0018)
    assert b['probability_positive_net_return']==.5
    output=predict([{'features':features()}],constant_model())[0]
    attributed=attach_baseline(output,b)
    assert attributed['expected_return_gross']==output['expected_return_gross']
    assert attributed['mean_policy']=='independent_three_head'
    assert attributed['l4_minus_l3_expected_gross']==pytest.approx(output['expected_return_gross']-value-.0018)


@pytest.mark.parametrize('field,value',[
    ('forecast_horizon_bars',1),('target_semantic_version','unknown'),
    ('forecast_return_5bar_source','rank_alias'),('ml_expected_net_return',None),
    ('ml_expected_net_return',True),('forecast_return_5bar',.123),
    ('probability_positive_net_return',1.1),('artifact_checksum','forged')])
def test_native_baseline_rejects_semantic_alias_and_identity_errors(field,value):
    p=prediction();p['ensemble_v2'][field]=value
    with pytest.raises(ValueError):native_baseline(p,IDENTITY)


def test_baseline_packet_cannot_be_mutated_or_have_cost_added_twice():
    b=baseline(.01);b['expected_return_gross']+=.0018
    with pytest.raises(ValueError,match='value_mismatch'):validate_baseline(b)
    b=baseline(.01);b['artifact_id']='other'
    with pytest.raises(ValueError,match='checksum'):validate_baseline(b)


def recalc(result,candidate):
    return build_comparison(result['runs'],result['protocol'],candidate_model_checksum=candidate['model_checksum'],
        l3_identity_checksum=digest(candidate['l3_identity']))


def test_candidate_beats_incumbent_but_loses_to_l3_is_rejected():
    candidate=bundle();r=comparison(candidate)
    r['runs']['l3_same_allocator']['daily_nav'][0].update(nav=103.,cash=51.5,holdings_market_value=51.5)
    result=recalc(r,candidate)
    assert result['net_return_improvement']['incumbent']>0
    assert result['net_return_improvement']['l3_same_allocator']<0
    assert result['passes'] is False
    with pytest.raises(ValueError,match='acceptance_failed'):validate_comparison(result,candidate)
    receipt=deepcopy(candidate['release']['validation_receipt']);receipt['paired_account_comparison']=result
    with pytest.raises(ValueError,match='acceptance_failed'):prepare_paper_release(candidate,receipt,signal_date='2026-09-11')


@pytest.mark.parametrize('key',['allocator_checksum','opb_protocol_checksum','execution_checksum','pool_checksum','initial_account_checksum','costs_checksum','risk_constraints_checksum'])
def test_inconsistent_inputs_cannot_masquerade_as_same_allocator(key):
    candidate=bundle();r=comparison(candidate);r['runs']['l3_same_allocator'][key]='f'*64
    with pytest.raises(ValueError,match='mismatch'):recalc(r,candidate)


def test_missing_l3_legacy_claim_and_tampering_fail_closed():
    candidate=bundle();r=comparison(candidate)
    with pytest.raises(ValueError,match='l3_comparison_missing'):validate_comparison({'complete':True,'candidate_net_return':99},candidate)
    r['metrics']['candidate']['net_return']=99
    with pytest.raises(ValueError,match='tampered'):validate_comparison(r,candidate)
    r=comparison(candidate);del r['runs']['l3_same_allocator']
    with pytest.raises(ValueError,match='required'):recalc(r,candidate)


@pytest.mark.parametrize('field,value',[('holdout_usage','reused_diagnostic'),('selection_frozen_before','2026-08-20'),('preselection',True)])
def test_selection_protocol_cannot_promote_reused_or_leaking_tests(field,value):
    candidate=bundle();r=comparison(candidate);r['protocol'][field]=value
    with pytest.raises(ValueError):recalc(r,candidate)


def test_cash_marked_holdings_not_cumulative_predicted_ev_and_no_boolean_nav():
    candidate=bundle();r=comparison(candidate)
    r['runs']['candidate']['daily_nav'][0]['cash']+=1
    with pytest.raises(ValueError,match='accounting'):recalc(r,candidate)
    r=comparison(candidate);r['runs']['candidate']['initial_nav']=True
    with pytest.raises(ValueError):recalc(r,candidate)


def test_date_equal_error_decomposition_and_correct_probability_events():
    rows=[]
    for day,ys in [('2026-08-20',[-.01,.001,.02]),('2026-08-21',[-.04,.01])]:
        for i,y in enumerate(ys):
            rows.append({'date':day,'symbol':str(i),'gross_return':y,'features':features(),
                         'l3_baseline':baseline(y-.0018)})
    out=predict(rows,constant_model());r=evaluate_predictions(rows,out)
    assert r['rows']==5 and r['metrics']['l3']['mse']<1e-30
    assert r['metrics']['l3']['daily_rank_ic']==pytest.approx(1)
    for key in ('l3','l4','zero'):
        metric=r['metrics'][key]
        assert metric['mse']==pytest.approx(metric['date_mean_error_squared']+metric['within_date_error_variance'])
    assert r['metrics']['l4']['rank_ic_undefined_dates']==2
    assert r['probability_events_compared_directly'] is False
    assert r['daily'][0]['l3_net_positive']['brier']==.25
    bad=deepcopy(out);bad[0]['expected_return_gross']+=.01
    with pytest.raises(ValueError,match='incoherent'):evaluate_predictions(rows,bad)
    with pytest.raises(ValueError,match='pool_mismatch'):evaluate_predictions(rows,out[:-1])


def test_refresh_rejects_missing_baseline_before_any_fit(monkeypatch):
    from services import l4_distribution_lifecycle as life
    from services.l4_distribution import FEATURE_SCHEMA
    rows=[{'date':'2026-08-20','symbol':'A','features':features()}]
    receipt={'schema_version':'l4-native-oof-dataset-v1','rows_checksum':digest(rows),
        'feature_schema':FEATURE_SCHEMA,'parent_l3_identity':IDENTITY}
    monkeypatch.setattr(life,'fit_candidate',lambda *a,**k:pytest.fail('must validate baseline before fitting'))
    with pytest.raises(ValueError,match='baseline_semantic_mismatch'):
        life.refresh_candidate(rows,dataset_receipt=receipt,l3_identity=IDENTITY,as_of='2026-09-11',cadence='weekly')


@pytest.mark.parametrize('field',['native_l3_baseline_preserved','incremental_comparison_contract'])
def test_old_engineering_acceptance_cannot_be_reused_after_design_repair(field):
    candidate=bundle();receipt=deepcopy(candidate['release']['validation_receipt']);del receipt['checks'][field]
    with pytest.raises(ValueError,match='acceptance_evidence_incomplete'):
        prepare_paper_release(candidate,receipt,signal_date='2026-09-11')
