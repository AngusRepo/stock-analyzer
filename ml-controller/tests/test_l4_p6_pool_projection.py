from copy import deepcopy
import numpy as np
import pytest
from services import l4_p6_pool_projection as owner
from services.l4_distribution import digest


def fixture(monkeypatch):
    rows=[dict(symbol=s,features={'feature':i}) for i,s in enumerate(('a','b','c','d'))]
    snapshot=dict(signal_date='2026-10-19',l3_identity={'artifact_id':'frozen'},pool_contract=owner.NATIVE_POOL,
        feature_rows=rows,features_checksum=digest(rows),eligible_symbols=['a','b','c','d'],coverage_exclusions=[],
        l3_training_label_known_max='2026-10-01')
    c=dict(schema_version='p6-frozen-oof-calibration-v1',scope='full_classified_candidate_pool',
        outer_updates_allowed=False,outer_data_used=False,refit_predictions_used=False,
        label_known_at_max='2026-10-01',linear_b=.4)
    c['checksum']=digest(c)
    def infer(rows,**kw):
        assert [r['symbol'] for r in rows]==['a','b','c','d']
        scores=np.array([-.03,-.01,.01,.05]);centered=scores-scores.mean()
        return dict(score=scores,relative_score=centered,z=centered/scores.std(),
            p_loss=np.array([.7,.6,.4,.2]),seed_input_matrix_checksums={'42':'x'})
    monkeypatch.setattr(owner,'predict',infer)
    args=dict(identity=snapshot['l3_identity'],signal_date='2026-10-19',model_checksum='a'*64,
        seeds=[],head={},calibration=c,calibration_kind='linear',load_bytes=None)
    return snapshot,args


def test_routed_subset_keeps_full_pool_center_and_z(monkeypatch):
    snapshot,args=fixture(monkeypatch)
    _,full,proof=owner.project(snapshot,**args,symbols=['a','b','c','d'])
    rows,subset,subset_proof=owner.project(snapshot,**args,symbols=['d','c'])
    assert subset['c']==full['c'] and subset['d']==full['d']
    assert subset_proof==proof and proof['source_pool_size']==4
    assert subset['d']['expected_return_gross']==pytest.approx(.018)
    assert sum(r['expected_return_gross'] for r in subset.values())>0
    assert [r['symbol'] for r in rows]==['d','c']
    _,raw,_=owner.project(snapshot,**{**args,'calibration_kind':'raw'},symbols=['d'])
    assert raw['d']['z']==subset['d']['z']
    assert raw['d']['expected_return_gross']==pytest.approx(.045)


def test_missing_pool_wrong_identity_and_reestimated_calibration_rejected(monkeypatch):
    snapshot,args=fixture(monkeypatch)
    for change in ({'features_checksum':'wrong'},{'eligible_symbols':['a','b']},
        {'coverage_exclusions':['c']},{'l3_identity':{'artifact_id':'new'}},
        {'l3_training_label_known_max':'2026-10-19'}):
        with pytest.raises(ValueError):owner.project({**snapshot,**change},**args,symbols=['a'])
    for symbols in (['missing'],['a','a']):
        with pytest.raises(ValueError):owner.project(snapshot,**args,symbols=symbols)
    for field in ('outer_updates_allowed','outer_data_used','refit_predictions_used'):
        c=deepcopy(args['calibration']);c[field]=True;c['checksum']=digest({k:v for k,v in c.items() if k!='checksum'})
        with pytest.raises(ValueError):owner.project(snapshot,**{**args,'calibration':c},symbols=['a'])
    with pytest.raises(ValueError):owner.project(snapshot,**{**args,'calibration_kind':'eb'},symbols=['a'])
