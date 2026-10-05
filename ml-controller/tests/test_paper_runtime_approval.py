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


def test_exact_odd_lot_quote_age_change_requires_signed_operator_declaration(runtime_pair):
    admission, approval = runtime_pair
    approval['configuration']['native_execution_policy']['variables'][
        'FINLAB_L5_ODD_LOT_MAX_QUOTE_AGE_MS'] = '10000'
    reseal(approval)
    with pytest.raises(RuntimeError, match='approval_policy_changed'):
        paper.validate_runtime_approval(approval, admission)

    approval['approved_execution_policy_change'] = deepcopy(paper.ODD_LOT_QUOTE_AGE_CHANGE)
    reseal(approval)
    assert paper.validate_runtime_approval(approval, admission) == approval

    approval['configuration']['native_execution_policy']['variables'][
        'FINLAB_L5_ODD_LOT_MAX_QUOTE_AGE_MS'] = '20000'
    reseal(approval)
    with pytest.raises(RuntimeError, match='policy_change_invalid'):
        paper.validate_runtime_approval(approval, admission)


def test_odd_lot_change_cannot_hide_another_execution_policy_change(runtime_pair):
    admission, approval = runtime_pair
    variables = approval['configuration']['native_execution_policy']['variables']
    variables['FINLAB_L5_ODD_LOT_MAX_QUOTE_AGE_MS'] = '10000'
    variables['FINLAB_L5_MAX_SPREAD_PCT'] = '0.01'
    approval['approved_execution_policy_change'] = deepcopy(paper.ODD_LOT_QUOTE_AGE_CHANGE)
    reseal(approval)
    with pytest.raises(RuntimeError, match='approval_policy_changed'):
        paper.validate_runtime_approval(approval, admission)


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


@pytest.mark.parametrize('fault', [None, 'missing_declaration', 'unknown_source', 'wrong_previous',
                                  'another_source', 'risk', 'maturity', 'declaration'])
def test_performance_release_reapproval_is_exact_and_preserves_policy(runtime_pair, fault):
    admission, approval = runtime_pair
    before, after = admission['configuration'], approval['configuration']
    for section, sources in paper.PERFORMANCE_SOURCE_CHANGE['sources'].items():
        for name, transition in sources.items():
            before[section][name] = transition['previous']
            after[section][name] = transition['approved']
    approval['admission'] = deepcopy(admission)
    approval['approved_source_change'] = deepcopy(paper.PERFORMANCE_SOURCE_CHANGE)
    if fault == 'missing_declaration':
        approval.pop('approved_source_change')
    elif fault == 'unknown_source':
        after['l3_inference_source_identity']['paired_nav_strategy_bundle.py'] = 'f' * 64
    elif fault == 'wrong_previous':
        before['allocator_source_identity']['paired_nav_collection.py'] = 'f' * 64
        approval['admission'] = deepcopy(admission)
    elif fault == 'another_source':
        after['allocator_source_identity']['allocator'] = 'f' * 64
    elif fault == 'risk':
        after['risk_config']['cap'] = .9
    elif fault == 'maturity':
        approval['maturity_transfer'] = True
    elif fault == 'declaration':
        approval['approved_source_change']['sources']['allocator_source_identity'][
            'paired_nav_collection.py']['approved'] = 'f' * 64
    reseal(approval)
    original = deepcopy(approval)
    if fault is None:
        assert paper.validate_runtime_approval(approval, admission) == original
        assert approval == original
    else:
        with pytest.raises(RuntimeError):
            paper.validate_runtime_approval(approval, admission)


@pytest.mark.parametrize('fault', [None, 'missing_declaration', 's12_enabled', 'different_owner',
                                  'prior_owner', 'another_flag'])
def test_or15_parity_approval_only_accepts_exact_current_worker_settings(runtime_pair, fault):
    admission, approval = runtime_pair
    prior = admission['configuration']['native_execution_policy']['variables']
    current = approval['configuration']['native_execution_policy']['variables']
    prior['S12_INTRADAY_PRIMARY_OWNER_ENABLED'] = '1'
    current.update(paper.PAPER_ENTRY_OWNER_CHANGE['approved'])
    approval['approved_paper_entry_owner_change'] = deepcopy(paper.PAPER_ENTRY_OWNER_CHANGE)
    if fault == 'missing_declaration':
        approval.pop('approved_paper_entry_owner_change')
    elif fault == 's12_enabled':
        current['S12_INTRADAY_PRIMARY_OWNER_ENABLED'] = '1'
    elif fault == 'different_owner':
        current['PAPER_INTRADAY_ENTRY_OWNER'] = 'unknown'
    elif fault == 'prior_owner':
        prior['PAPER_INTRADAY_ENTRY_OWNER'] = 'another-policy'
    elif fault == 'another_flag':
        current['S12_INTRADAY_GATE_MODE'] = 'different'
    approval['admission'] = deepcopy(admission)
    reseal(approval)
    if fault is None:
        assert paper.validate_runtime_approval(approval, admission) == approval
    else:
        with pytest.raises(RuntimeError):
            paper.validate_runtime_approval(approval, admission)


def test_release_approval_stages_without_overwriting_current_key(runtime_pair, monkeypatch):
    admission, approval = runtime_pair
    from services import kv_client
    old = deepcopy(approval)
    staged = reseal({**deepcopy(approval), 'source_reference': 'new exact release'})
    records = {paper.KEY: admission, paper.RUNTIME_KEY: old}
    monkeypatch.setattr(kv_client, 'get_json', lambda key, **kw: deepcopy(records.get(key)))
    assert paper.verify_active_approval(admission) == old
    records[paper.RUNTIME_RELEASE_KEY] = staged
    assert paper.verify_active_approval(admission) == staged
    assert records[paper.RUNTIME_KEY] == old
    records[paper.RUNTIME_RELEASE_KEY]['approved'] = False
    with pytest.raises(RuntimeError, match='approval_invalid'):
        paper.verify_active_approval(admission)


def test_supplemental_approval_cannot_override_original_revocation(runtime_pair,monkeypatch):
    admission,approval=runtime_pair
    from services import kv_client
    monkeypatch.setattr(kv_client,'get_json',lambda key,**kw:None if key==paper.KEY else approval)
    with pytest.raises(RuntimeError,match='missing_changed_or_revoked'):
        paper.verify_active_approval(admission)


@pytest.mark.parametrize('fault', [None, 'missing', 'old_source', 'new_source', 'another_source', 'risk', 'live', 'declaration'])
def test_paid_provider_reapproval_accepts_only_reviewed_source_transition(runtime_pair, fault):
    admission, approval = runtime_pair
    before, after = admission['configuration'], approval['configuration']
    for section, sources in paper.PAID_PROVIDER_SOURCE_CHANGE['sources'].items():
        for name, transition in sources.items():
            before[section][name] = transition['previous']
            after[section][name] = transition['approved']
    approval['approved_paid_provider_source_change'] = deepcopy(paper.PAID_PROVIDER_SOURCE_CHANGE)
    if fault == 'missing': approval.pop('approved_paid_provider_source_change')
    elif fault == 'old_source': before['allocator_source_identity']['recommendation_service.py'] = 'f'*64
    elif fault == 'new_source': after['l3_inference_source_identity']['recommendation_service.py'] = 'f'*64
    elif fault == 'another_source': after['allocator_source_identity']['allocator'] = 'f'*64
    elif fault == 'risk': after['risk_config']['cap'] = .9
    elif fault == 'live': after['native_execution_policy']['variables']['LIVE_EXECUTION_CLIENT_ENABLED'] = '1'
    elif fault == 'declaration': approval['approved_paid_provider_source_change']['scope'] = 'live'
    approval['admission'] = deepcopy(admission)
    reseal(approval)
    if fault is None:
        original = deepcopy(approval)
        assert paper.validate_runtime_approval(approval, admission) == original
        assert approval == original
    else:
        with pytest.raises(RuntimeError): paper.validate_runtime_approval(approval, admission)


def test_paid_provider_release_staging_preserves_old_swing_key_and_revocation(runtime_pair, monkeypatch):
    admission, approval = runtime_pair
    from services import kv_client
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER', 'premarket_once_v1')
    old = deepcopy(approval)
    staged = reseal({**deepcopy(approval), 'source_reference': 'new exact provider release'})
    records = {paper.KEY: admission, paper.SWING_RUNTIME_RELEASE_KEY: old}
    monkeypatch.setattr(kv_client, 'get_json', lambda key, **kw: deepcopy(records.get(key)))
    assert paper.verify_active_approval(admission) == old
    records[paper.PAID_PROVIDER_RUNTIME_RELEASE_KEY] = staged
    assert paper.verify_active_approval(admission) == staged
    assert records[paper.SWING_RUNTIME_RELEASE_KEY] == old
    records[paper.PAID_PROVIDER_RUNTIME_RELEASE_KEY]['approved'] = False
    with pytest.raises(RuntimeError, match='approval_invalid'): paper.verify_active_approval(admission)


def test_ga_recovery_staging_preserves_paid_provider_release_and_revocation(runtime_pair, monkeypatch):
    admission, approval = runtime_pair
    from services import kv_client
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER', 'premarket_once_v1')
    old = deepcopy(approval)
    staged = reseal({**deepcopy(approval), 'source_reference': 'exact merged GA recovery'})
    records = {paper.KEY: admission, paper.PAID_PROVIDER_RUNTIME_RELEASE_KEY: old}
    monkeypatch.setattr(kv_client, 'get_json', lambda key, **kw: deepcopy(records.get(key)))
    assert paper.verify_active_approval(admission) == old
    records[paper.GA_RECOVERY_RUNTIME_RELEASE_KEY] = staged
    assert paper.verify_active_approval(admission) == staged
    assert records[paper.PAID_PROVIDER_RUNTIME_RELEASE_KEY] == old
    records[paper.GA_RECOVERY_RUNTIME_RELEASE_KEY]['approved'] = False
    with pytest.raises(RuntimeError, match='approval_invalid'):
        paper.verify_active_approval(admission)


def test_monthly_recovery_preserves_tabpack_key_and_revocation(runtime_pair, monkeypatch):
    admission, approval = runtime_pair
    from services import kv_client
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER', 'premarket_once_v1')
    old = deepcopy(approval)
    staged = reseal({**deepcopy(approval), 'source_reference': 'exact monthly source recovery'})
    records = {paper.KEY: admission, paper.TABPACK_RUNTIME_RELEASE_KEY: old}
    monkeypatch.setattr(kv_client, 'get_json', lambda key, **kw: deepcopy(records.get(key)))
    assert paper.verify_active_approval(admission) == old
    records[paper.MONTHLY_RECOVERY_RUNTIME_RELEASE_KEY] = staged
    assert paper.verify_active_approval(admission) == staged
    assert records[paper.TABPACK_RUNTIME_RELEASE_KEY] == old
    records[paper.MONTHLY_RECOVERY_RUNTIME_RELEASE_KEY]['approved'] = False
    with pytest.raises(RuntimeError, match='approval_invalid'):
        paper.verify_active_approval(admission)


def test_tabpack_evaluation_preserves_monthly_key_and_revocation(runtime_pair, monkeypatch):
    admission, approval = runtime_pair
    from services import kv_client
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER', 'premarket_once_v1')
    old = deepcopy(approval)
    staged = reseal({**deepcopy(approval), 'source_reference': 'exact monthly source recovery'})
    records = {paper.KEY: admission, paper.MONTHLY_RECOVERY_RUNTIME_RELEASE_KEY: old}
    monkeypatch.setattr(kv_client, 'get_json', lambda key, **kw: deepcopy(records.get(key)))
    assert paper.verify_active_approval(admission) == old
    records[paper.TABPACK_EVALUATION_RUNTIME_RELEASE_KEY] = staged
    assert paper.verify_active_approval(admission) == staged
    assert records[paper.MONTHLY_RECOVERY_RUNTIME_RELEASE_KEY] == old
    records[paper.TABPACK_EVALUATION_RUNTIME_RELEASE_KEY]['approved'] = False
    with pytest.raises(RuntimeError, match='approval_invalid'):
        paper.verify_active_approval(admission)


def test_entry_visibility_preserves_evaluation_key_and_revocation(runtime_pair, monkeypatch):
    admission, approval = runtime_pair
    from services import kv_client
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER', 'premarket_once_v1')
    old = deepcopy(approval)
    staged = reseal({**deepcopy(approval), 'source_reference': 'entry visibility supplemental identity'})
    records = {paper.KEY: admission, paper.TABPACK_EVALUATION_RUNTIME_RELEASE_KEY: old}
    monkeypatch.setattr(kv_client, 'get_json', lambda key, **kw: deepcopy(records.get(key)))
    assert paper.verify_active_approval(admission) == old
    records[paper.ENTRY_UI_RUNTIME_RELEASE_KEY] = staged
    assert paper.verify_active_approval(admission) == staged
    assert records[paper.TABPACK_EVALUATION_RUNTIME_RELEASE_KEY] == old
    records[paper.ENTRY_UI_RUNTIME_RELEASE_KEY]['approved'] = False
    with pytest.raises(RuntimeError, match='approval_invalid'):
        paper.verify_active_approval(admission)
