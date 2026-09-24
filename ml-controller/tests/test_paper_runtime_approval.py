"""Exact Paper runtime reapproval; no model/risk drift or historical rewrite."""
from copy import deepcopy
from datetime import datetime, timezone
import json
import pytest
from services import active8_paper_admission as paper, active8_nav_adoption as authority
from services.paired_nav_journal import digest
from services.alpha_model_roster import LEGACY_MODELS
from test_active8_paper_admission import approved, publish, ready, prepared, environment, SESSIONS


def reseal(value):
    value['approval_checksum'] = digest({k:v for k,v in value.items() if k!='approval_checksum'})
    return value


def wrapper(admission, configuration):
    return reseal({'schema_version':paper.RUNTIME_SCHEMA, 'admission':deepcopy(admission),
        'scope':'paper', 'approved':True, 'maturity_transfer':False, 'efficacy_status':'unproven',
        'source_reference':'SYNTHETIC explicit operator approval',
        'approved_at':admission['approved_at'], 'configuration':deepcopy(configuration)})


def add_runtime_fields(configuration):
    configuration['l3_inference_source_identity'] = {
        'active8_paper_admission.py':'a'*64, 'active8_nav_adoption.py':'b'*64, 'other.py':'c'*64}
    policy = configuration['native_execution_policy']
    policy['execution_owner_version'] = 'native-paper-v1:'+'a'*64
    policy.setdefault('frozen_kv', {})['ml:adaptive_params'] = {
        'meta_layer':{'alpha_vote_models':list(LEGACY_MODELS), 'formal_layer3_slots':list(LEGACY_MODELS)},
        'bandit_context':{'ga_optimizer':{'runtime_role':'shadow_learning_context',
            'applies_to_trading_config':False, 'effect_policy':{'mutates_trading_config':False},
            'candidate_latest':{'validation':{'status':'old'}}, 'champion_release':{'id':'same'}}}}


@pytest.fixture
def runtime_pair():
    config={'trading_config':{'weight':.4}, 'risk_config':{'cap':.3},
        'allocator_source_identity':{'allocator':'a'*64},
        'native_execution_policy':{'schema_version':'paired-nav-execution-policy-v1',
            'variables':{'LIVE_EXECUTION_CLIENT_ENABLED':'0'}, 'account_id':1, 'kv_read_policy':{}}}
    add_runtime_fields(config)
    admission={'approved_at':'2026-09-21T12:00:00Z','configuration':config}
    current=deepcopy(config)
    current['native_execution_policy']['execution_owner_version']='native-paper-v1:'+'d'*64
    current['l3_inference_source_identity']['active8_nav_adoption.py']='e'*64
    current['native_execution_policy']['frozen_kv']['ml:adaptive_params']['bandit_context']['ga_optimizer']['candidate_latest']['validation']['status']='new'
    return admission, wrapper(admission,current)


def test_runtime_approval_requires_exact_operator_record(runtime_pair):
    admission,approval=runtime_pair
    assert paper.validate_runtime_approval(approval,admission)==approval
    approval['approved']=False
    with pytest.raises(RuntimeError,match='approval_invalid'):
        paper.validate_runtime_approval(reseal(approval),admission)


@pytest.mark.parametrize('fault',['trading','risk','allocator','other_source','unknown','live',
    'champion','ga_effect','future','maturity','checksum','original_admission'])
def test_runtime_approval_rejects_policy_or_authority_drift(runtime_pair,fault):
    admission,approval=runtime_pair
    config=approval['configuration']; native=config['native_execution_policy']
    if fault=='trading':config['trading_config']['weight']=.9
    elif fault=='risk':config['risk_config']['cap']=.9
    elif fault=='allocator':config['allocator_source_identity']['allocator']='f'*64
    elif fault=='other_source':config['l3_inference_source_identity']['other.py']='f'*64
    elif fault=='unknown':config['future_policy']=True
    elif fault=='live':native['variables']['LIVE_EXECUTION_CLIENT_ENABLED']='1'
    elif fault=='champion':native['frozen_kv']['ml:adaptive_params']['bandit_context']['ga_optimizer']['champion_release']['id']='different'
    elif fault=='ga_effect':native['frozen_kv']['ml:adaptive_params']['bandit_context']['ga_optimizer']['effect_policy']['mutates_trading_config']=True
    elif fault=='future':approval['approved_at']='2099-01-01T00:00:00Z'
    elif fault=='maturity':approval['maturity_transfer']=True
    elif fault=='original_admission':approval['admission']['approved_at']='2026-09-20T12:00:00Z'
    reseal(approval)
    if fault=='checksum':approval['approval_checksum']='f'*64
    with pytest.raises((RuntimeError,ValueError)):
        paper.validate_runtime_approval(approval,admission)


def test_only_inactive_ga_candidate_metadata_is_projected(runtime_pair):
    admission,approval=runtime_pair
    config=approval['configuration']
    projected=paper.runtime_configuration_identity(config)
    ga=projected['native_execution_policy']['frozen_kv']['ml:adaptive_params']['bandit_context']['ga_optimizer']
    assert 'candidate_latest' not in ga and ga['champion_release']=={'id':'same'}
    original_ga=config['native_execution_policy']['frozen_kv']['ml:adaptive_params']['bandit_context']['ga_optimizer']
    assert 'candidate_latest' in original_ga
    original_ga['applies_to_trading_config']=True
    assert 'candidate_latest' in paper.runtime_configuration_identity(config)['native_execution_policy']['frozen_kv']['ml:adaptive_params']['bandit_context']['ga_optimizer']


def test_runtime_reapproval_restores_only_paper_and_keeps_publication_immutable(approved,monkeypatch):
    (client,row,_,_,current),admission=approved
    add_runtime_fields(current)
    admission['configuration']=deepcopy(current)
    admission['admission_checksum']=digest({k:v for k,v in admission.items() if k!='admission_checksum'})
    publish(approved)
    tables=('active8_ensemble_pointer_v1','model_champion_pointers','model_champion_history','paired_nav_review_records_v1')
    before={table:client.query('SELECT * FROM '+table) for table in tables}
    current['native_execution_policy']['execution_owner_version']='native-paper-v1:'+'d'*64
    current['l3_inference_source_identity']['active8_nav_adoption.py']='e'*64
    with pytest.raises(RuntimeError,match='configuration_changed'):
        authority.load_committed_nav_serving_grant(query=client.query)
    approval=wrapper(admission,current)
    from services import kv_client,model_serving_resolver as resolver
    monkeypatch.setattr(kv_client,'get_json',lambda key,**kwargs:deepcopy(admission if key==paper.KEY else approval))
    pool=resolver.load_d1_champion_pool(sidecar_models=())
    assert len(pool['models'])==8 and all(m['serving_eligible'] for m in pool['models'].values())
    from graphs import daily_pipeline_v2 as graph
    monkeypatch.setattr(graph,'LEARNING_D1_CLIENT',client)
    artifact=graph._load_active8_ensemble_snapshot(pool)
    manifest,checksum=graph._build_pipeline_modal_serving_manifest(pool,
        registry_rows=graph._pipeline_modal_registry_identity_rows(pool),active8_ensemble=artifact)
    action=manifest['active8_action_authority']
    assert action['mode']=='paper_ensemble' and action['paper_buy_authorized'] is True
    assert action['buy_authorized'] is False and action['live_buy_authorized'] is False
    assert authority.load_committed_nav_publication(query=client.query) is None
    assert {table:client.query('SELECT * FROM '+table) for table in tables}==before
    # Later inactive candidate diagnostics do not invalidate the approved runtime.
    ga=current['native_execution_policy']['frozen_kv']['ml:adaptive_params']['bandit_context']['ga_optimizer']
    ga['candidate_latest']['validation']['status']='later_observation'
    assert authority.load_committed_nav_serving_grant(query=client.query)
    current['risk_config']['unapproved_field']=True
    with pytest.raises(RuntimeError,match='configuration_changed'):
        authority.load_committed_nav_serving_grant(query=client.query)
    current['risk_config'].pop('unapproved_field')
    # A fully valid operator record changed during the read still rejects the grant.
    calls=[]
    def racing(key,**kwargs):
        if key==paper.KEY:return deepcopy(admission)
        calls.append(key)
        changed=deepcopy(approval)
        if len(calls)>1:changed['source_reference']='different operator record'
        return reseal(changed)
    monkeypatch.setattr(kv_client,'get_json',racing)
    with pytest.raises(RuntimeError,match='approval_changed'):
        authority.load_committed_nav_serving_grant(query=client.query)
    approval['approved']=False
    reseal(approval)
    monkeypatch.setattr(kv_client,'get_json',lambda key,**kw:deepcopy(admission if key==paper.KEY else approval))
    with pytest.raises(RuntimeError,match='approval_invalid'):
        authority.load_committed_nav_serving_grant(query=client.query)


def test_supplemental_approval_cannot_override_original_revocation(runtime_pair,monkeypatch):
    admission,approval=runtime_pair
    from services import kv_client
    monkeypatch.setattr(kv_client,'get_json',lambda key,**kw:None if key==paper.KEY else approval)
    with pytest.raises(RuntimeError,match='missing_changed_or_revoked'):
        paper.verify_active_approval(admission)
