from copy import deepcopy
import pytest
from services import l4_r2_daily_shadow as subject,l4_distribution as native
from test_l4_r2_shadow import ShadowTests
from test_l4_distribution_runtime import bundle as baseline_bundle
from services.l4_r2_identity import implementation_identity


def fixture(monkeypatch):
    test=ShadowTests();bundle=test.bundle();baseline=baseline_bundle()
    baseline['l3_identity']=bundle['l3_identity']
    bundle['head_policy']='causal_latest_known_anchor_same_identity_full_pool_whole_mature_dates'
    test.seal(bundle)
    rows=[dict(symbol=s,features={'example':i}) for i,s in enumerate(('A','B','C'))]
    snapshot=dict(signal_date='2026-10-15',snapshot_id='native',l3_identity=bundle['l3_identity'],
        feature_schema=bundle['feature_schema'],feature_rows=rows,features_checksum=native.digest(rows),
        eligible_symbols=['A','B','C'],original_sha256='d'*64)
    anchor=dict(model_checksum='e'*64,training_label_known_max='2026-10-13')
    policy=dict(schema_version='l4-r2-forward-evaluation-policy-v1',model_checksum=bundle['payload_checksum'],
        implementation_checksum=implementation_identity()['checksum'],
        baseline_model_checksum=baseline['model_checksum'],required_mature_days=20,head_policy=bundle['head_policy'],
        risk_horizon_sessions=5,automatic_promotion=False,cost_policy_checksum='a'*64,allocation_policy_checksum='b'*64)
    policy.update(first_signal_date='2026-10-15',last_inspected_signal_date='2026-10-14',
        uncertainty={'method':'paired_five_session_moving_block','replicates':5000,'seed':42,'confidence':.95},
        acceptance='manual_review_of_precommitted_metrics_no_automatic_promotion')
    monkeypatch.setattr(subject,'predict',lambda rows,**kw:[dict(symbol=r['symbol'],relative_mu=i*.01) for i,r in enumerate(rows)])
    monkeypatch.setattr(native,'predict',lambda rows,model:[dict(expected_return_gross=(i+1)*.03) for i,r in enumerate(rows)])
    return snapshot,dict(bundle=bundle,baseline=baseline,anchor=anchor,policy=policy,load_bytes=lambda ref:None)


def test_same_full_pool_old_new_alignment_and_frozen_neural_weights(monkeypatch):
    snapshot,options=fixture(monkeypatch);before=deepcopy(options['bundle'])
    result=subject.score_snapshot(snapshot,**options)
    assert [r['symbol'] for r in result['forecasts']]==['A','B','C']
    assert [r['baseline_relative'] for r in result['forecasts']]==pytest.approx([-.03,0,.03])
    assert options['bundle']==before
    assert not result['neural_network_updated'] and not result['promoted']


@pytest.mark.parametrize('field,value',[('required_mature_days',19),('risk_horizon_sessions',1),
    ('model_checksum','x'),('baseline_model_checksum','x'),('automatic_promotion',True),('implementation_checksum','f'*64)])
def test_changed_evaluation_contract_cannot_share_same_observation(monkeypatch,field,value):
    snapshot,options=fixture(monkeypatch);options['policy'][field]=value
    with pytest.raises(ValueError,match='policy_binding|evaluation_policy|implementation_changed'):subject.score_snapshot(snapshot,**options)


def test_modified_projection_rejected(monkeypatch):
    snapshot,options=fixture(monkeypatch);snapshot['feature_rows'][0]['features']['example']=99
    with pytest.raises(ValueError,match='projection_changed'):subject.score_snapshot(snapshot,**options)
