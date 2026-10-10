"""Engineering verification only: no fits, Modal calls, or production writes."""
from copy import deepcopy
from pathlib import Path
import json
import numpy as np
import pytest
from services import l4_distribution as native, l4_tabpack_median as median, l4_tabpack_weights as weights
from services.l4_tabpack_budget_protocol import RECIPE, SEEDS, validate_run
from test_l4_distribution import constant_model, features
from test_l4_tabpack_monthly import Bucket
from test_active8_paper_admission import approved, publish, ready, prepared, environment, SESSIONS


def test_actual_upstream_factory_only_changes_search_count_for_each_seed():
    from app.l4_tabpack_official import make_config, verify_source
    root = Path(__file__).resolve().parents[2] / 'ml-service/vendor/tabpack'
    verify_source(root)
    official = make_config(root, root/'unused')
    for seed in SEEDS:
        config = make_config(root, root/'unused', recipe=RECIPE, seed=seed)
        expected = {**official, 'seed':seed, 'n_models':16}
        assert config == expected
        assert config['online_ensembles']['greedy']['options']['max_ensemble_size'] == 32
        assert config['optimizer'] == {'type':'MuonAdamWPack', 'shared_step':True}


@pytest.mark.parametrize('recipe,seed', [(RECIPE,45),(RECIPE,True),('unknown',42),('three-head-oof-official-tabpack-v2',43)])
def test_unknown_recipe_or_seed_rejected(recipe,seed):
    with pytest.raises(ValueError):validate_run(recipe,seed)


@pytest.mark.parametrize('fault',['optimizer','patience','ensemble','epochs','sampler','width','amp'])
def test_completed_receipt_rejects_changed_official_core(fault):
    from app.l4_tabpack_official import make_config
    from services.l4_tabpack_budget_protocol import validate_result
    root=Path(__file__).resolve().parents[2]/'ml-service/vendor/tabpack'
    config=make_config(root,root/'unused',recipe=RECIPE,seed=42)
    result={'config':config,'training_recipe':RECIPE,'seed':42,'training_completed':True,
            'configuration_overrides':{'n_models':16}}
    validate_result(result,recipe=RECIPE,seed=42)
    if fault=='optimizer':config['optimizer']['type']='AdamWPack'
    elif fault=='patience':config['patience']=5
    elif fault=='ensemble':config['online_ensembles']['greedy']['options']['max_ensemble_size']=16
    elif fault=='epochs':config['n_epochs']=30
    elif fault=='sampler':config['sampler']['space']['model']['n_blocks'][-1]=3
    elif fault=='width':config['model']['d_block']=128
    elif fault=='amp':config['amp_dtype']='float32'
    with pytest.raises(ValueError,match='core_configuration_changed'):
        validate_result(result,recipe=RECIPE,seed=42)


def fixture(monkeypatch):
    from test_paper_single_b_tabpack import residual
    anchor = constant_model()
    members, archives = [], {}
    # Different slopes make the middle seed change by symbol.
    for seed,slope,bias in zip(SEEDS,(1.,-1.,0.),(0.,1.,.3),strict=True):
        value = residual(anchor)
        sha = str(seed%10)*64
        value.update(schema_version=weights.SCHEMA, residual_mean=0., residual_scale=1.,
            weights={'path':weights.PREFIX+sha+'.npz','sha256':sha,'bytes':100},
            members=[{'member_id':15,'step':2,'depth':1,'weight':1.}])
        value['provenance'].update(seed=seed,training_recipe=RECIPE,n_models=16,
            selection_rule='official_online_greedy_validation_only',
            checkpoint_sha256=sha,upstream_commit='05a89e21b955f12de84889d662e15ca534019aaa',
            partition_checksum='a'*64,source_rows_checksum='b'*64)
        arrays={'m0_l0_weight':np.zeros((34,384),np.float32),'m0_l0_bias':np.zeros(384,np.float32),
                'm0_l1_weight':np.zeros((384,1),np.float32),'m0_l1_bias':np.asarray([bias],np.float32)}
        arrays['m0_l0_weight'][anchor['recipe']['names'].index('LightGBM_raw'),0]=1.
        arrays['m0_l1_weight'][0,0]=slope
        archives[sha]=arrays
        value['payload_checksum']=native.digest({k:v for k,v in value.items() if k!='payload_checksum'})
        members.append({'seed':seed,'model':value})
    monkeypatch.setattr(weights,'load',lambda ref:archives[ref['sha256']])
    return anchor,median.ensemble(anchor,members)


def seal(value):
    for member in value['members']:
        m=member['model'];m['payload_checksum']=native.digest({k:v for k,v in m.items() if k!='payload_checksum'})
    value['payload_checksum']=native.digest({k:v for k,v in value.items() if k!='payload_checksum'})


def test_actual_predict_median_changes_seed_by_symbol_and_preserves_anchor(monkeypatch):
    anchor,value=fixture(monkeypatch)
    rows=[{'features':features(x)} for x in (.1,.5,.9)]
    model={**anchor,'residual_tabpack':value}
    out=native.predict(rows,model)
    assert [p['residual_ev_correction'] for p in out]==pytest.approx([.3,.5,.3])
    assert [p['expected_return_gross'] for p in out]==pytest.approx([.29,.49,.29])
    assert native.predict(rows[::-1],model)==out[::-1]
    assert native.predict([],model)==[]
    for row,p in zip(rows,out,strict=True):
        assert native.predict([row],model)==[p]


@pytest.mark.parametrize('fault',['missing','duplicate','order','partition','recipe','source','width','seed','known','scale','member64'])
def test_median_rejects_partial_or_mixed_pack(monkeypatch,fault):
    anchor,value=fixture(monkeypatch);member=value['members'][1];m=member['model'];p=m['provenance']
    if fault=='missing':value['members'].pop()
    elif fault=='duplicate':value['members'][1]=deepcopy(value['members'][0])
    elif fault=='order':value['members'].reverse()
    elif fault=='partition':p['partition_checksum']='c'*64
    elif fault=='recipe':p['training_recipe']='three-head-oof-official-tabpack-v2'
    elif fault=='source':p['source_rows_checksum']='c'*64
    elif fault=='width':m['members'][0]['depth']=4
    elif fault=='seed':p['seed']=44
    elif fault=='known':m['training_label_known_max']='2026-08-02'
    elif fault=='scale':m['residual_scale']=2.
    elif fault=='member64':m['members'][0]['member_id']=63
    seal(value)
    with pytest.raises(ValueError):median.validate(value,anchor_model=anchor)


def test_sequential_dispatch_waits_and_does_not_repeat_completed_seed(monkeypatch):
    from services import l4_tabpack_dispatch as single, l4_tabpack_median_dispatch as group
    bucket=Bucket();calls=[];finished=set();builds=[]
    def dispatch(b,key,build,*,recipe,seed):
        calls.append(seed)
        if seed not in finished:return {'status':'pending','run_key':key}
        payload={**build(),'run_key':key,'training_recipe':recipe,'seed':seed}
        path=str(seed)+'.json';bucket.saved[path]=json.dumps({'challenger_training_source':payload}).encode()
        return {'status':'validated','artifact_path':path}
    monkeypatch.setattr(single,'dispatch',dispatch)
    monkeypatch.setattr(group,'finalize',lambda *args:{'status':'validated','promoted':False})
    def build():builds.append(1);return {'as_of':'2026-10-10'}
    assert group.dispatch(bucket,'a'*64,build)['current_seed']==42
    assert calls==[42]
    finished.add(42);calls.clear()
    assert group.dispatch(bucket,'a'*64,build)['current_seed']==43
    assert calls==[42,43]
    finished.add(43);calls.clear()
    assert group.dispatch(bucket,'a'*64,build)['current_seed']==44
    assert calls==[42,43,44] and len(builds)==1
    finished.add(44)
    assert group.dispatch(bucket,'a'*64,build)['status']=='validated'


def test_failed_seed_never_advances_or_retries(monkeypatch):
    from services import l4_tabpack_dispatch as single, l4_tabpack_median_dispatch as group
    bucket=Bucket();calls=[]
    def fail(*a,**kw):calls.append(kw['seed']);return {'status':'failed'}
    monkeypatch.setattr(single,'dispatch',fail)
    assert group.dispatch(bucket,'b'*64,lambda:{})['status']=='failed'
    assert group.dispatch(bucket,'b'*64,lambda:pytest.fail('retry'))['status']=='failed'
    assert calls==[42]


def test_budget_gpu_interruption_never_refits_same_provider_input(monkeypatch):
    from app import l4_tabpack_stages as stage
    bucket=Bucket();bucket.list_blobs=lambda **kw:iter([])
    payload={'expected_source_sha':'a'*40,'run_key':'b'*64,'training_recipe':RECIPE,'seed':42}
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA','a'*40)
    owner={'function_call_id':'same','input_id':'same'}
    monkeypatch.setattr(stage,'_stage_owner',lambda:owner)
    bucket.saved[stage._root(payload)+'gpu_claim.json']=json.dumps({'owner':owner,'payload_checksum':native.digest(payload)}).encode()
    monkeypatch.setattr(stage,'gpu_stage',lambda *a,**kw:pytest.fail('must not refit'))
    with pytest.raises(ValueError,match='interruption_requires_review'):
        stage.run_stage(payload,'gpu',bucket=bucket)


def test_candidate_recipe_override_does_not_change_serving_mode():
    from services.paper_strategy_mode import refresh_family, MLP_MODE
    config={'l4Distribution':{'operating_mode':MLP_MODE,'candidate_model_family':'tabpack_median16'}}
    assert refresh_family(config)=='tabpack_median16'
    assert config['l4Distribution']['operating_mode']==MLP_MODE


def test_median_serving_mode_requires_exact_schema(monkeypatch):
    from services.paper_strategy_mode import TABPACK_MEDIAN_MODE, refresh_family, validate_model_mode
    anchor,value=fixture(monkeypatch)
    policy={'operating_mode':TABPACK_MEDIAN_MODE,'artifact':{'model':{**anchor,'residual_tabpack':value}}}
    assert refresh_family({'l4Distribution':policy})=='tabpack_median16'
    validate_model_mode(policy)
    policy['artifact']['model']['residual_tabpack']=value['members'][0]['model']
    with pytest.raises(ValueError,match='core16_median_required'):validate_model_mode(policy)


def test_interrupted_group_preparation_is_terminal_not_monthly_poll(monkeypatch):
    from services import l4_tabpack_median_dispatch as group
    bucket=Bucket();key='d'*64
    bucket.saved[group.PREFIX+key+'/prepare_claim.json']=b'{}'
    result=group.dispatch(bucket,key,lambda:pytest.fail('duplicate preparation'))
    assert result['status']=='failed' and result['dependency_retry_required'] is False
    assert result['retry_requires_review'] is True


def test_complete_median_is_persisted_and_reusable_without_training(monkeypatch):
    from services import l4_tabpack_median_dispatch as group
    from services.l4_monthly_closure import completed_candidate
    from test_l4_distribution_runtime import IDENTITY
    from test_l4_design_repair import baseline
    anchor_model,median_model=fixture(monkeypatch)
    anchor={'schema_version':native.SCHEMA,'feature_schema':native.FEATURE_SCHEMA,
        'label_schema':native.LABEL_SCHEMA,'horizon_sessions':5,'l3_identity':IDENTITY,
        'model':anchor_model,'model_checksum':native.digest(anchor_model),'training_label_known_max':'2026-08-01',
        'cadence':'monthly','evaluation':{'dates':['2026-09-01']},
        'training_source':{'source_manifest_checksum':'f'*64}}
    rows=[{'date':'2026-09-01','symbol':str(i),'features':features(x),'gross_return':x/10,
           'l3_baseline':baseline(.01)} for i,x in enumerate((.1,.5,.9))]
    bucket=Bucket();bucket.saved['anchor']=json.dumps(anchor).encode();bucket.saved['rows']=json.dumps(rows).encode()
    source={'run_key':'a'*64,'training_recipe':group.RECIPE,'anchor_path':'anchor',
        'anchor_checksum':native.digest(anchor),'dataset_path':'rows','rows_checksum':native.digest(rows),'as_of':'2026-10-10'}
    candidates=[{**deepcopy(anchor),'model':{**deepcopy(anchor_model),'residual_tabpack':m['model']},
                 'export_verification':{'fixture_only':True}} for m in median_model['members']]
    result=group.finalize(bucket,source,candidates)
    assert result['status']=='validated' and result['promoted'] is False
    assert group.dispatch(bucket,'a'*64,lambda:pytest.fail('must not train'))==result
    assert completed_candidate(bucket,'a'*64,identity=IDENTITY,manifest_checksum='f'*64,
        as_of='2026-10-10',expected_family='tabpack_median16')==result
    with pytest.raises(ValueError,match='family_mismatch'):
        completed_candidate(bucket,'a'*64,identity=IDENTITY,manifest_checksum='f'*64,
            as_of='2026-10-10',expected_family='tabpack')


def test_shared_preparation_reuses_exact_arrays_without_fitting(monkeypatch):
    from app import l4_tabpack_stages as stage, l4_tabpack_data as data
    monkeypatch.setattr(data,'prepare',lambda *a,**kw:pytest.fail('must not refit anchor'))
    bucket=Bucket();base={'expected_source_sha':'a'*40,'run_key':'b'*64,'training_recipe':RECIPE,'seed':42}
    raw=b'fixture arrays';ref=stage._object(bucket,stage._root(base),'prepared.npz',raw)
    stage._seal(bucket,stage._root(base)+'prepared.json',{'payload':base,'arrays':ref,'recipe':{},'evidence':{'seed':42}})
    bucket.saved[stage._root(base)+'completed.json']=json.dumps({'status':'validated','run_key':'b'*64}).encode()
    next_payload={**base,'run_key':'c'*64,'seed':43,'shared_prepared_run_key':'b'*64}
    result=stage.prepare_stage(next_payload,bucket)
    assert bucket.saved[result['arrays']['path']]==raw and result['evidence']['seed']==43
    with pytest.raises(ValueError,match='source_mismatch'):
        stage.prepare_stage({**next_payload,'as_of':'changed'},bucket)


def test_real_local_packet_and_sqlite_publisher_accept_exact_median(approved,monkeypatch):
    from services.l4_distribution_lifecycle import prepare_paper_release
    from services.l4_release_packet import prepare_packet
    from services.l4_distribution_runtime import distribution_policy_identity
    from services.paper_strategy_mode import TABPACK_MEDIAN_MODE
    from services.strategy_ab import TABPACK_SCHEMA, TABPACK_RECIPE
    (_,_,_,_,current),admission=approved
    bundle=admission['strategy_bundle'];policy=bundle['candidate_trading_config']['l4Distribution']
    anchor,value=fixture(monkeypatch)
    candidate=deepcopy(policy['artifact'])
    assert candidate['model']==anchor
    candidate['model']['residual_tabpack']=value;candidate['model_checksum']=native.digest(candidate['model'])
    acceptance=deepcopy(candidate['release']['validation_receipt'])
    acceptance['model_checksum']=candidate['model_checksum']
    acceptance['experiment_authorization']['model_checksum']=candidate['model_checksum']
    evidence={'scope':'native_engineering_paper_execution','complete':True,'opb_policy':deepcopy(policy['opb'])}
    evidence['opb_policy']['approved_policy_identity']=distribution_policy_identity(
        {'artifact':candidate,'constraints':policy['constraints'],'opb':evidence['opb_policy']},candidate['l3_identity'])
    acceptance['source_evidence_checksum']=native.digest(evidence)
    candidate.pop('release')
    cfg=deepcopy(bundle['candidate_trading_config'])
    packet=prepare_packet(current_config=cfg,candidate=candidate,acceptance=acceptance,
        source_evidence=evidence,l3_identity=candidate['l3_identity'],constraints=policy['constraints'],
        signal_date=SESSIONS[-1],current_l3_identity=candidate['l3_identity'],current_plan_id='d'*64)
    # Exercise the real packet path before the existing SQLite atomic publisher.
    next_config=packet['next_config']
    assert next_config['l4Distribution']['operating_mode']==TABPACK_MEDIAN_MODE
    policy['artifact']=prepare_paper_release(candidate,acceptance,signal_date=SESSIONS[-1])
    policy.update(operating_mode=TABPACK_MEDIAN_MODE,strategy_role='B')
    policy['opb']['approved_policy_identity']=distribution_policy_identity(policy,policy['artifact']['l3_identity'])
    bundle['strategy_ab'].update(schema_version=TABPACK_SCHEMA,role='B',recipe=TABPACK_RECIPE)
    bundle['bundle_checksum']=native.digest({k:v for k,v in bundle.items() if k!='bundle_checksum'})
    current['trading_config']=deepcopy(bundle['candidate_trading_config'])
    admission['configuration']=deepcopy(current)
    admission['admission_checksum']=native.digest({k:v for k,v in admission.items() if k!='admission_checksum'})
    result=publish(approved)
    assert result['promotion_scope']=='paper_experiment' and result['readback_verified']
    assert result['efficacy_status']=='unproven'
