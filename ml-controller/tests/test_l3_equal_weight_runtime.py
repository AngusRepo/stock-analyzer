from copy import deepcopy
import hashlib

import pytest

from services import l3_equal_weight as eq
from services import l3_equal_weight_bundle as bundle_owner
from services import l4_distribution as old_model
from services import l4_distribution_runtime as runtime
from test_l4_distribution_runtime import fixture as original_fixture


def fixture():
    rows, policy, history = original_fixture()
    ranks = [dict(symbol=s, ranks={m:r for m in eq.MODELS}, availability={m:True for m in eq.MODELS})
             for s,r in [('A',.1),('B',.5),('C',.9)]]
    train = [{**deepcopy(r), 'gross_return':y, 'label_known_date':'2026-09-10', 'prediction_kind':'oof'}
             for r,y in zip(ranks,[-.04,0.,.04])]
    calibration = eq.fit_calibration([dict(date='2026-09-01',rows=train)], source_sha256='a'*64,
        pool_contract='fixture-L2-v1',signal_date_max='2026-09-01',label_known_at_max='2026-09-10')
    bases = {m:dict(version='test-only',checksum=hashlib.sha256(m.encode()).hexdigest(),
        training_label_known_max='2026-09-10') for m in eq.MODELS}
    identity = {**policy['runtime']['l3_identity'], 'base_artifact_set_checksum':eq.digest(bases)}
    model = dict(schema_version=bundle_owner.MODEL_SCHEMA,recipe_version=eq.RECIPE,
        model_order=list(eq.MODELS),feature_names=list(bundle_owner.FEATURE_NAMES),base_artifacts=bases,
        calibration=calibration)
    artifact = dict(schema_version=old_model.SCHEMA,feature_schema=bundle_owner.FEATURE_SCHEMA,
        label_schema=old_model.LABEL_SCHEMA,horizon_sessions=5,l3_identity=identity,
        training_label_known_max='2026-09-10',model=model,model_checksum=eq.digest(model))
    predictions = {r['symbol']:dict(r33_rank_evidence=dict(recipe=eq.RECIPE,signal_date='2026-09-11',
        l3_identity=identity,ranks=r['ranks'],availability=r['availability'])) for r in ranks}
    snapshot = dict(schema_version='r33-attested-rank-pool-v1',signal_date='2026-09-11',
        l3_identity=identity,model_order=list(eq.MODELS),pool_contract='fixture-L2-v1',rank_rows=ranks,
        predictions_checksum=eq.digest(predictions))
    snapshot['checksum']=eq.digest(snapshot)
    policy.update(scope='private_research',artifact=artifact)
    policy['runtime'].update(l3_identity=identity,predictions=predictions,r33_rank_pool=snapshot)
    return rows,policy,history


def run(rows, policy, history):
    return runtime.run(rows,policy,return_history=history,private_research=True)


def test_actual_common_allocation_path_does_not_call_any_old_forecast_owner(monkeypatch):
    rows,policy,history=fixture()
    def forbidden(*args,**kwargs):
        raise AssertionError('old learned forecast owner called')
    monkeypatch.setattr(runtime,'native_features',forbidden)
    monkeypatch.setattr(runtime,'predict',forbidden)
    monkeypatch.setattr(old_model,'predict',forbidden)
    out=run(rows,policy,history)
    plan=out[0]['_l4_portfolio_plan']
    assert plan['r33_projection']['denominator_models']==7
    assert plan['proof']['evaluated_candidate_count']==3
    assert plan['targets']['A']['distribution']['expected_return_gross']<0
    assert plan['targets']['C']['distribution']['expected_return_gross']>0
    assert all(r['alpha_allocation']['expected_return_source']==bundle_owner.MODEL_SCHEMA for r in out)
    assert plan['input_attribution']['model_feature_count']==14


def test_missing_sequence_keeps_candidate_and_fixed_seven_denominator():
    rows,policy,history=fixture()
    pool=policy['runtime']['r33_rank_pool'];rank=pool['rank_rows'][2]
    rank['availability']['TimeXer']=False;rank['ranks']['TimeXer']=None
    # Fixture intentionally shares the same producer packet; reseal after edit.
    predictions=policy['runtime']['predictions']
    pool['predictions_checksum']=eq.digest(predictions)
    pool['checksum']=eq.digest({k:v for k,v in pool.items() if k!='checksum'})
    plan=run(rows,policy,history)[0]['_l4_portfolio_plan']
    forecast=plan['targets']['C']['distribution']
    assert forecast['rank_score']==pytest.approx((6*.9+.5)/7)
    assert forecast['neutral_rank_contributions']['TimeXer']==0
    assert plan['prediction_coverage']['available']==3
    assert plan['prediction_coverage']['unavailable']=={}


@pytest.mark.parametrize('change',['pool_membership','pool_changed','identity_changed','base_set_changed','calibration_changed'])
def test_tampered_bundle_or_rank_pool_is_rejected(change):
    rows,policy,history=fixture()
    if change=='pool_membership':policy['runtime']['r33_rank_pool']['rank_rows'].pop()
    if change=='pool_changed':policy['runtime']['r33_rank_pool']['pool_contract']='different'
    if change=='identity_changed':policy['runtime']['l3_identity']['payload_checksum']='b'*64
    if change=='base_set_changed':policy['artifact']['model']['base_artifacts'].pop('GNN')
    if change=='calibration_changed':policy['artifact']['model']['calibration']['linear_b']*=2
    with pytest.raises(ValueError):
        run(rows,policy,history)


def test_candidate_without_real_paper_release_is_not_formal_admission():
    rows,policy,history=fixture();policy['scope']='paper'
    with pytest.raises(ValueError,match='paper_release_missing'):
        runtime.run(rows,policy,return_history=history)
