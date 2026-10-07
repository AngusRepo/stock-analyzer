"""Synthetic engineering tests, never efficacy/release evidence."""
from copy import deepcopy
from types import SimpleNamespace
import numpy as np
import pytest

from services.l4_distribution import digest, predict
from services.l4_residual_mlp import SCHEMA as SINGLE, OUTPUTS
from services.l4_mlp_median import SEEDS, SCHEMA, validate
from services.l4_mlp_export import ensemble
from services.paper_strategy_mode import MLP_MODE, single_b_policy, disabled_receipt, valid_disabled_receipt
from services.l4_distribution_lifecycle import prepare_paper_release
from test_l4_distribution import constant_model, features
from test_l4_distribution_runtime import fixture as runtime_fixture
from test_paper_single_b_tabpack import released


def member(anchor,seed,bias):
    shapes={'input.weight':(128,34),'input.bias':(128,), 'output.weight':(1,128),'output.bias':(1,)}
    for block in range(3):
        prefix=f'blocks.{block}.transform.'
        shapes.update({prefix+'0.weight':(128,),prefix+'0.bias':(128,),
            prefix+'1.weight':(128,128),prefix+'1.bias':(128,),
            prefix+'4.weight':(128,128),prefix+'4.bias':(128,)})
    state={key:np.zeros(shape,dtype=np.float32).tolist() for key,shape in shapes.items()}
    state['input.weight'][0][anchor['recipe']['names'].index('LightGBM_raw')]=1
    state['output.weight'][0][0]=1
    state['output.bias']=[bias]
    value={'schema_version':SINGLE,'inputs':34,'width':128,'blocks':3,'output':'scalar_ev_correction',
        'anchor_model_checksum':digest(anchor),'training_label_known_max':'2026-08-01','residual_scale':.1,
        'recipe':{'native':deepcopy(anchor['recipe']),'head_names':OUTPUTS,'mean':[0.]*4,'scale':[1.]*4},'state':state}
    value['payload_checksum']=digest(value)
    return {'seed':seed,'model':value,'provenance':{'seed':seed,'checkpoint_sha256':str(seed%10)*64,
        'training_receipt_sha256':'a'*64,'partition_sha256':'b'*64}}


def model():
    anchor=constant_model()
    members=[member(anchor,s,b) for s,b in zip(SEEDS,(-.2,.1,.9),strict=True)]
    return {**anchor,'residual_mlp':ensemble(anchor,members)}


def reseal(m):
    for v in m['residual_mlp']['members']:
        v['model']['payload_checksum']=digest({k:x for k,x in v['model'].items() if k!='payload_checksum'})
    r=m['residual_mlp'];r['payload_checksum']=digest({k:x for k,x in r.items() if k!='payload_checksum'})


def full_release(candidate):
    candidate=deepcopy(candidate)
    candidate['model'].pop('residual_tabpack',None)
    candidate['model'].pop('residual_mlp',None)
    candidate=released(candidate)
    candidate['model']=model();candidate['model_checksum']=digest(candidate['model'])
    receipt=deepcopy(candidate['release']['validation_receipt']);receipt['model_checksum']=candidate['model_checksum']
    receipt['experiment_authorization']['model_checksum']=candidate['model_checksum']
    return prepare_paper_release(candidate,receipt,signal_date='2026-09-21')


def test_real_feature_dependent_median_not_mean_or_singleton():
    m=model();rows=[{'features':features(v)} for v in (.1,.5,.9)]
    out=predict(rows,m)
    for p in out:
        deltas=list(p['residual_member_corrections'].values())
        assert p['residual_ev_correction']==pytest.approx(np.median(deltas),abs=1e-8)
        assert abs(p['residual_ev_correction']-np.mean(deltas))>.001
    assert len(set(p['expected_return_gross'] for p in out))==3
    assert predict(rows[::-1],m)==out[::-1]
    for row,p in zip(rows,out):
        assert predict([row],m)[0]['expected_return_gross']==pytest.approx(p['expected_return_gross'],abs=1e-7)
    half=deepcopy(m);half['residual_mlp']['residual_multiplier']=.5;reseal(half)
    assert [p['residual_ev_correction'] for p in predict(rows,half)]==pytest.approx([p['residual_ev_correction']*.5 for p in out])


def test_full_diagnostics_preserve_three_head_distribution_and_native_baseline():
    from services.l4_prediction_evaluation import evaluate_predictions
    from test_l4_design_repair import baseline
    m=model();rows=[{'date':'2026-09-21','symbol':str(i),'features':features(v),
        'gross_return':v/10,'l3_baseline':baseline(.01)} for i,v in enumerate((.1,.5,.9))]
    report=evaluate_predictions(rows,predict(rows,m),model=m)
    assert 'three_head' in report['metrics'] and report['model_selection_performed'] is False


@pytest.mark.parametrize('fault',['missing','duplicate','order','anchor','recipe','provenance','future','weights','scale','lambda','checksum'])
def test_corruption_cannot_silently_use_two_seeds_or_anchor(fault):
    m=model();r=m['residual_mlp'];v=r['members'][1]
    if fault=='missing':r['members'].pop()
    if fault=='duplicate':r['members'][1]=deepcopy(r['members'][0])
    if fault=='order':r['members'].reverse()
    if fault=='anchor':v['model']['anchor_model_checksum']='c'*64
    if fault=='recipe':v['model']['recipe']['mean'][0]=1
    if fault=='provenance':v['provenance']['checkpoint_sha256']='bad'
    if fault=='future':v['model']['training_label_known_max']='2026-09-21'
    if fault=='weights':v['model']['state']['input.weight']=[]
    if fault=='scale':v['model']['recipe']['scale'][0]=0
    if fault=='lambda':r['residual_multiplier']=.75
    reseal(m)
    if fault=='checksum':r['payload_checksum']='c'*64
    with pytest.raises(ValueError):validate(r,anchor_model={k:m[k] for k in ('recipe','heads')},signal_date='2026-09-21')


def test_full_mode_keeps_account_opb_and_lineage_and_half_cannot_be_champion():
    from services.l4_distribution_runtime import run,distribution_policy_identity
    from services.l4_allocation_contract import native_opb_policy
    rows,p,h=runtime_fixture();p['artifact']=full_release(p['artifact'])
    p.update(operating_mode=MLP_MODE,strategy_role='B')
    p['runtime']['account'].update(active_plan_id='d'*64,available_cash=800000,
        holdings=[{'symbol':'H','market_value':200000}]);h['H']=h['A']
    account=deepcopy(p['runtime']['account'])
    p['opb']=native_opb_policy(p['constraints'])
    p['opb']['approved_policy_identity']=distribution_policy_identity(p,p['runtime']['l3_identity'])
    result=run(rows,p,return_history=h);plan=result[0]['_l4_portfolio_plan']
    assert plan['strategy_mode']==MLP_MODE and plan['parent_plan_id']=='d'*64
    assert plan['model_checksum']==p['artifact']['model_checksum']
    assert plan['proof']['preselection'] is False and plan['opb']['enabled'] is True
    assert plan['opb']['status']=='cold_start_base' and p['runtime']['account']==account
    receipt=single_b_policy({'l4Distribution':p},signal_date='2026-09-21')
    assert receipt['mode']==MLP_MODE and valid_disabled_receipt(disabled_receipt(receipt,signal_date='2026-09-21'))
    half=deepcopy(p);half['artifact']['model']['residual_mlp']['residual_multiplier']=.5
    with pytest.raises(ValueError,match='full_mlp_median_required'):
        single_b_policy({'l4Distribution':half},signal_date='2026-09-21')


def test_mlp_dispatch_claim_prevents_paid_retry(monkeypatch):
    from test_l4_tabpack_monthly import Bucket
    from services import modal_client,l4_mlp_dispatch as dispatch
    calls=[];bucket=Bucket()
    def spawn(payload):calls.append(payload);raise TimeoutError('lost ack')
    monkeypatch.setattr(modal_client,'_lookup',lambda name:SimpleNamespace(spawn=spawn) if name=='train_l4_mlp_median_candidate' else pytest.fail(name))
    with pytest.raises(TimeoutError):dispatch.dispatch(bucket,'a'*64,lambda:{})
    assert dispatch.dispatch(bucket,'a'*64,lambda:pytest.fail('cannot rebuild'))['status']=='pending'
    assert len(calls)==1 and calls[0]['training_recipe']==dispatch.RECIPE
