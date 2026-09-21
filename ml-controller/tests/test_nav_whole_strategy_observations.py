"""Synthetic protocol tests only. No NAV evidence, model, or release artifact is published."""
from copy import deepcopy
import json
import pytest
from services import active8_nav_adoption as authority,model_serving_resolver as resolver
from services.active8_nav_inference import execution_artifacts,_InferenceGrant,_INFERENCE_SEAL,permits_inference
from services.ensemble_v2 import ensemble_artifact_id,validate_active8_ensemble_candidate
from services.paired_nav_journal import digest
from services.paired_nav_strategy_bundle import SCHEMA,validate_strategy_bundle
from services.l4_allocation_contract import initial_paper_constraints,native_opb_policy
from services.l4_distribution_lifecycle import prepare_paper_release,ACCEPTANCE_CHECKS
from services.l4_distribution_runtime import distribution_policy_identity
from services import l4_distribution as l4
from test_paired_nav_l3_candidate import fixed_artifact
from test_l4_distribution import constant_model


def fixture(observation_state='offline_failed'):
    artifact=fixed_artifact('whole-candidate')
    selected=['LightGBM','TabM','GNN','PatchTST']
    artifact['selected_models']=selected
    artifact['excluded_models']=[n for n in artifact['model_order'] if n not in selected]
    artifact['base_artifacts']={n:artifact['observation_artifacts'][n] for n in selected}
    artifact['base_artifact_set_checksum']=digest(artifact['base_artifacts'])
    for i,n in enumerate(artifact['model_order']):
        if n not in selected:artifact['fit']['coefficients'][i]=0.
    artifact['payload_checksum']=digest({k:v for k,v in artifact.items() if k!='payload_checksum'})
    validate_active8_ensemble_candidate(artifact)
    identity={'schema_version':'paired-nav-formal-ml-baseline-v1','artifact_id':ensemble_artifact_id(artifact),**{k:artifact[k] for k in ('cohort_id','payload_checksum','base_artifact_set_checksum')}}
    model=constant_model()
    candidate={'schema_version':l4.SCHEMA,'feature_schema':l4.FEATURE_SCHEMA,'label_schema':l4.LABEL_SCHEMA,'horizon_sessions':5,'l3_identity':identity,'model':model,'model_checksum':digest(model),'training_label_known_max':'2026-08-01'}
    acceptance={'schema_version':'l4-paper-acceptance-v1','model_checksum':candidate['model_checksum'],'l3_identity_checksum':digest(identity),'feature_schema':l4.FEATURE_SCHEMA,'checks':{k:True for k in ACCEPTANCE_CHECKS},'source_evidence_checksum':'c'*64,'acceptance_mode':'paper_experiment','efficacy_status':'unproven','experiment_authorization':{'scope':'paper','approved':True,'source_reference':'SYNTHETIC UNIT TEST ONLY','model_checksum':candidate['model_checksum']}}
    release=prepare_paper_release(candidate,acceptance,signal_date='2026-09-11')
    baseline={'fees':{'commission':.001,'tax':.003},'position':{'maxPositions':2,'maxPctOfPortfolio':.3},'ranking':{'enabled':True}}
    constraints=initial_paper_constraints(baseline)
    policy={'scope':'paper','artifact':release,'constraints':constraints,'opb':native_opb_policy(constraints)}
    policy['opb']['approved_policy_identity']=distribution_policy_identity(policy,identity)
    old={**identity,'artifact_id':'incumbent','payload_checksum':'d'*64}
    bundle={'schema_version':SCHEMA,'comparison_unit':'complete_l3_l4_strategy','declared_signal_date':'2026-09-11','baseline_l3_identity':old,'candidate_l3_identity':identity,'baseline_trading_config':baseline,'candidate_trading_config':{**baseline,'l4Distribution':policy},'source_evidence_checksum':'c'*64,'production_effect':False}
    bundle['bundle_checksum']=digest(bundle)
    validate_strategy_bundle(bundle,signal_date='2026-09-11')
    receipt={'nav_configuration':{'trading_config':baseline,'formal_baseline_identity':old,'strategy_bundle':bundle},'nav_validation':{'as_of_date':'2026-09-11'}}
    rows=[];pointers=[]
    for name,identifier in artifact['observation_artifacts'].items():
        metadata={'target_semantic_version':resolver.LABEL_SCHEMA_VERSION,'feature_semantic_version':resolver.FORMAL_FEATURE_SEMANTIC_VERSION,'graph_context':{'semantic_version':resolver.FORMAL_GNN_GRAPH_SEMANTIC_VERSION},'seq_len':64,'pred_len':5,'rank_ic_semantic_version':resolver.FORMAL_RANK_IC_SEMANTIC_VERSION}
        row={**identifier,'model_name':name,'state':'production' if name in selected else observation_state,'offline_gate_decision':'PASS' if observation_state=='offline_passed_weak' else 'FAIL','training_run_id':'test','artifact_path':name+'.'+resolver.ARTIFACT_EXTENSIONS[name],'metadata_path':name+'.json','offline_evidence_json':json.dumps({'registration':{'metadata':metadata}})}
        rows.append(row)
        pointers.append({'model_name':name,'champion_artifact_id':identifier['artifact_id'] if name in selected else 'old:'+name,'champion_version':identifier['version'] if name in selected else 'old','promotion_evidence_json':json.dumps(receipt) if name in selected else '{}','rolling_ic':99.})
    # Unit scope: construct the INTERNAL sealed type; original review verification
    # is exercised separately by test_nav_l3_serving/frozen_inference.
    grant=authority._ServingGrant(json.dumps(artifact),json.dumps(receipt),json.dumps({r['model_name']:authority._base_source(r) for r in rows}),'[]','2026-09-11T14:00:00Z','2026-09-11T13:00:00Z',authority._SERVING_SEAL)
    return artifact,receipt,rows,pointers,grant


@pytest.mark.parametrize('observation_state',['offline_failed','offline_passed_weak'])
def test_whole_strategy_projects_all_eight_without_changing_l3_weights_or_pointers(observation_state):
    artifact,receipt,rows,pointers,grant=fixture(observation_state);before=deepcopy([artifact,rows,pointers])
    assert len(execution_artifacts(artifact,receipt))==8 and len(artifact['selected_models'])==4
    pool=resolver.build_pool_from_champion_pointers(pointers=pointers,artifacts=rows,sidecar_models=(),nav_grant=grant)
    assert all(p['serving_eligible'] for p in pool['models'].values())
    for name,p in pool['models'].items():
        assert p['version']=='whole-candidate'
        if name not in artifact['selected_models']:
            assert p['serving_owner']=='committed_whole_strategy_observation'
            assert p['rolling_ic'] is None
            assert p['offline_gate_decision']==('PASS' if observation_state=='offline_passed_weak' else 'FAIL')
    assert [artifact,rows,pointers]==before
    observation=next(r for r in rows if r['model_name']=='XGBoost')
    assert resolver._artifact_block_reason(observation,model_name='XGBoost',artifact_role='direct_alpha')=='artifact_state_'+observation_state
    inference=_InferenceGrant(artifact['payload_checksum'],json.dumps(artifact['observation_artifacts']),'c'*64,_INFERENCE_SEAL)
    assert permits_inference(inference,artifact=artifact,pool_models=pool['models'])
    pool['models']['XGBoost']['checksum']='sha256:'+'f'*64
    assert not permits_inference(inference,artifact=artifact,pool_models=pool['models'])


@pytest.mark.parametrize('fault',['checksum','metadata','archived','missing'])
def test_observation_drift_never_uses_old_pointer_as_fallback(fault):
    artifact,receipt,rows,pointers,grant=fixture()
    r=next(r for r in rows if r['model_name']=='XGBoost')
    if fault=='checksum':r['checksum']='sha256:'+'e'*64
    elif fault=='metadata':r['offline_evidence_json']='{}'
    elif fault=='archived':r['state']='archived'
    else:rows.remove(r)
    p=resolver.build_pool_from_champion_pointers(pointers=pointers,artifacts=rows,sidecar_models=(),nav_grant=grant)['models']['XGBoost']
    assert p['serving_eligible'] is False and p['version']=='whole-candidate'


def test_l3_only_receipt_never_gains_observation_authority():
    artifact,receipt,*_=fixture();del receipt['nav_configuration']['strategy_bundle']
    assert execution_artifacts(artifact,receipt)==artifact['base_artifacts']
    artifact['payload_checksum']='e'*64
    _,whole,*_=fixture()
    with pytest.raises(ValueError,match='observation_identity_mismatch'):
        execution_artifacts(artifact,whole)
    with pytest.raises(ValueError,match='grant_not_original'):
        resolver.build_pool_from_champion_pointers(pointers=[],artifacts=[],nav_grant=whole)
