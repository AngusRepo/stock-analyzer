from copy import deepcopy
import hashlib,io
from types import SimpleNamespace
import numpy as np
import pytest
from services import l4_distribution as dist
from services import l4_p6_weights as weights
from services.l4_p6_bundle import assemble
from services.l4_distribution_runtime import run,native_features
from services.l4_distribution_lifecycle import prepare_paper_release,P6_ACCEPTANCE_CHECKS
from services.alpha_model_roster import TIMEXER_MODELS
from services.l4_forward_refresh import NATIVE_POOL
from test_l4_p6_bundle import fixture as bundle_args
from test_l4_distribution_runtime import fixture,prediction,IDENTITY


def setup():
    args=bundle_args();args['l3_identity']=IDENTITY
    raw=args['load_bytes'](args['results'][0]['weights'])
    with np.load(io.BytesIO(raw),allow_pickle=False) as saved:arrays={k:saved[k].copy() for k in saved.files}
    arrays['m0_l0_weight'][dist.feature_names(TIMEXER_MODELS).index('LightGBM_rank'),0]=1.;arrays['m0_l1_weight'][0,0]=.02
    data=io.BytesIO();np.savez_compressed(data,**arrays);raw=data.getvalue()
    for seed in args['results']:seed['weights'].update(sha256=hashlib.sha256(raw).hexdigest(),bytes=len(raw))
    args['load_bytes']=lambda ref:raw
    bundle=assemble(**args);rows,policy,history=fixture();day='2026-10-19'
    policy.update(scope='private_research',artifact=bundle)
    policy['runtime'].update(signal_date=day)
    policy['runtime']['account']['signal_date']=day
    allrows=[*rows,dict(rows[0],symbol='D')];predictions={};features=[]
    for i,row in enumerate(allrows):
        p=prediction();p['ensemble_v2']['model_order']=list(TIMEXER_MODELS)
        p['rank_scores']={n:.2+.2*i for n in TIMEXER_MODELS}
        p['model_score_lineage']['raw_scores']={n:.2+.2*i for n in TIMEXER_MODELS}
        predictions[row['symbol']]=p
        features.append(dict(symbol=row['symbol'],features=native_features(row,p,IDENTITY)))
    policy['runtime']['predictions']={r['symbol']:predictions[r['symbol']] for r in rows}
    policy['runtime']['p6_native_pool']=dict(signal_date=day,l3_identity=IDENTITY,pool_contract=NATIVE_POOL,
        feature_rows=features,features_checksum=dist.digest(features),eligible_symbols=[r['symbol'] for r in features],
        coverage_exclusions=[],l3_training_label_known_max='2026-10-01')
    return rows,policy,history,args['load_bytes']


def test_real_p6_inference_reaches_allocator_without_legacy_A(monkeypatch):
    rows,policy,history,loader=setup()
    def forbidden(*a,**kw):raise AssertionError('legacy three-head/baseline used')
    monkeypatch.setattr('services.l4_distribution_runtime.predict',forbidden)
    monkeypatch.setattr('services.l4_distribution_runtime.attach_baseline',forbidden)
    result=run(rows,policy,return_history=history,private_research=True,p6_weight_loader=loader)
    plan=result[0]['_l4_portfolio_plan']
    assert plan['p6_projection']['source_pool_size']==4 and plan['p6_projection']['gain_loss_A_used'] is False
    assert plan['input_attribution']['model_feature_count']==31
    assert plan['targets']['C']['distribution']['expected_return_semantic']=='five_session_relative_pool_decimal'
    assert result[0]['alpha_allocation']['expected_return_semantic']=='five_session_relative_pool_decimal'
    assert plan['forbidden_buys']==['A']
    assert dist.digest({k:v for k,v in plan.items() if k!='plan_id'})==plan['plan_id']


@pytest.mark.parametrize('change',['missing_pool','stale_routed','unreleased'])
def test_formal_release_or_matching_pool_required(change):
    rows,policy,history,loader=setup()
    if change=='missing_pool':del policy['runtime']['p6_native_pool']
    elif change=='stale_routed':policy['runtime']['predictions']['B']['rank_scores']['LightGBM']=.99
    else:policy['scope']='paper'
    with pytest.raises(ValueError):run(rows,policy,return_history=history,private_research=True,p6_weight_loader=loader)


def test_R32_engineering_evidence_required_without_faking_legacy_baseline():
    rows,policy,history,loader=setup();bundle=policy['artifact']
    receipt=dict(schema_version='l4-paper-acceptance-v1',model_checksum=bundle['model_checksum'],
        l3_identity_checksum=dist.digest(IDENTITY),feature_schema=bundle['feature_schema'],
        checks=dict.fromkeys(P6_ACCEPTANCE_CHECKS,True),source_evidence_checksum='c'*64,
        acceptance_mode='p6_r32_paper',efficacy_status='inner_only_outer_unproven',
        inner_report_checksum=bundle['model']['inner_report']['checksum'],
        experiment_authorization=dict(scope='paper',approved=True,model_checksum=bundle['model_checksum'],source_reference='test-only'))
    assert 'native_l3_baseline_preserved' not in receipt['checks']
    released=prepare_paper_release(bundle,receipt,signal_date='2026-10-19')
    policy.update(scope='paper',artifact=released)
    assert run(rows,policy,return_history=history,p6_weight_loader=loader)[0]['_l4_portfolio_plan']['execution_scope']=='paper'
    for field in P6_ACCEPTANCE_CHECKS:
        bad=deepcopy(receipt);bad['checks'][field]=False
        with pytest.raises(ValueError,match='evidence_incomplete'):prepare_paper_release(bundle,bad,signal_date='2026-10-19')


def test_weight_read_pins_generation_and_content():
    _,policy,_,loader=setup();ref=policy['artifact']['model']['seeds'][0]['weights'];raw=loader(ref)
    def blob(path,**kwargs):
        assert path==ref['path'] and kwargs=={'generation':123}
        def reload(**kw):assert kw['if_generation_match']==123
        def download(**kw):assert kw['if_generation_match']==123;return raw
        return SimpleNamespace(size=ref['bytes'],generation=123,metadata={'sha256':ref['sha256']},reload=reload,download_as_bytes=download)
    assert weights.read(SimpleNamespace(blob=blob),ref)==raw
    with pytest.raises(ValueError):weights.read(SimpleNamespace(blob=blob),{**ref,'generation':'0'})
