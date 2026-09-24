"""Real SQLite publisher + frozen inference. Synthetic data, no financial evidence."""
from copy import deepcopy
import json
import pytest
from services import active8_nav_adoption as authority, active8_paper_admission as paper
from services import model_artifact_registry as registry, model_serving_resolver as resolver
from services.paired_nav_journal import digest
from services.l4_distribution_lifecycle import prepare_paper_release, ACCEPTANCE_CHECKS
from services import l4_distribution as l4
from services.l4_allocation_contract import initial_paper_constraints, native_opb_policy
from services.l4_distribution_runtime import distribution_policy_identity
from services.strategy_ab import SCHEMA, RECIPES, FEE_TERMS
from test_nav_l3_adoption import ready, prepared, environment, SESSIONS
from test_l4_distribution import constant_model


@pytest.fixture
def approved(ready, monkeypatch):
    client,row,_,_,current=ready
    artifact=json.loads(row['payload_json'])
    identity={'schema_version':'paired-nav-formal-ml-baseline-v1',**{k:row[k] for k in
        ('artifact_id','cohort_id','payload_checksum','base_artifact_set_checksum')}}
    pointer=client.query('SELECT * FROM active8_ensemble_pointer_v1')[0]
    baseline_identity={'schema_version':'paired-nav-formal-ml-baseline-v1',**{k:pointer[k] for k in
        ('artifact_id','cohort_id','payload_checksum','base_artifact_set_checksum')}}
    model=constant_model()
    candidate={'schema_version':l4.SCHEMA,'feature_schema':l4.FEATURE_SCHEMA,'label_schema':l4.LABEL_SCHEMA,
        'horizon_sessions':5,'l3_identity':identity,'model':model,'model_checksum':digest(model),
        'training_label_known_max':'2026-08-01'}
    acceptance={'schema_version':'l4-paper-acceptance-v1','model_checksum':candidate['model_checksum'],
        'l3_identity_checksum':digest(identity),'feature_schema':l4.FEATURE_SCHEMA,
        'checks':{k:True for k in ACCEPTANCE_CHECKS},'source_evidence_checksum':'c'*64,
        'acceptance_mode':'paper_experiment','efficacy_status':'unproven',
        'experiment_authorization':{'scope':'paper','approved':True,'source_reference':'SYNTHETIC TEST',
            'model_checksum':candidate['model_checksum']}}
    release=prepare_paper_release(candidate,acceptance,signal_date=SESSIONS[-1])
    baseline={'fees':{'commission':.001,'tax':.003},'position':{'maxPositions':2,'maxPctOfPortfolio':.3},'ranking':{'enabled':True}}
    constraints=initial_paper_constraints(baseline)
    policy={'scope':'paper','artifact':release,'constraints':constraints,'opb':native_opb_policy(constraints)}
    policy['opb']['approved_policy_identity']=distribution_policy_identity(policy,identity)
    from services.paired_nav_strategy_bundle import SCHEMA as BUNDLE_SCHEMA
    bundle={'schema_version':BUNDLE_SCHEMA,'comparison_unit':'complete_l3_l4_strategy',
        'declared_signal_date':SESSIONS[-1],'baseline_l3_identity':baseline_identity,'candidate_l3_identity':identity,
        'baseline_trading_config':baseline,'candidate_trading_config':{**baseline,'l4Distribution':policy},
        'source_evidence_checksum':'c'*64,'production_effect':False,
        'strategy_ab':{'schema_version':SCHEMA,'role':'A','recipe':RECIPES['A'],'experiment_id':'a'*64,'fee_terms':deepcopy(FEE_TERMS)}}
    bundle['bundle_checksum']=digest(bundle)
    current['trading_config']=deepcopy(bundle['candidate_trading_config'])
    approval={'schema_version':paper.SCHEMA,'scope':'paper','approved':True,'efficacy_status':'unproven',
        'nav_gate_role':'performance_review_after_paper_admission','source_reference':'SYNTHETIC TEST ONLY',
        'approved_at':'2026-09-21T12:00:00Z','business_date':SESSIONS[-1],
        'strategy_bundle':bundle,'configuration':deepcopy(current)}
    approval['admission_checksum']=digest(approval)
    from services import kv_client, trading_config_loader
    from types import SimpleNamespace
    monkeypatch.setattr(kv_client,'get_json',lambda key,**kw:deepcopy(approval) if key==paper.KEY else None)
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',lambda:SimpleNamespace(config=deepcopy(current['trading_config'])))
    return ready,approval


def publish(approved):
    (client,row,*_),approval=approved
    return registry.run_active8_ensemble_bundle_promotion_controller(training_run_id=row['training_run_id'],
        registry_rows=client.query('SELECT * FROM model_artifact_registry WHERE training_run_id=?',[row['training_run_id']]),
        d1_pointers=client.query('SELECT * FROM model_champion_pointers'),
        ensemble_artifact_id=row['artifact_id'],ensemble_payload_checksum=row['payload_checksum'],
        evaluation_business_date=SESSIONS[-1],paper_admission=approval,confirm=True)


def test_paper_publication_has_no_nav_pass_and_reaches_original_frozen_path(approved,monkeypatch):
    (client,row,*_),approval=approved
    reviews=client.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id')
    result=publish(approved)
    assert result['promotion_scope']=='paper_experiment' and result['readback_verified']
    assert 'nav_validation' not in result and result['efficacy_status']=='unproven'
    assert authority.load_committed_nav_publication(query=client.query) is None
    assert client.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id')==reviews
    from graphs import daily_pipeline_v2 as graph
    monkeypatch.setattr(graph,'LEARNING_D1_CLIENT',client)
    pool=resolver.load_d1_champion_pool(sidecar_models=())
    assert len(pool['models'])==8 and all(m['serving_eligible'] for m in pool['models'].values())
    artifact=graph._load_active8_ensemble_snapshot(pool)
    manifest,checksum=graph._build_pipeline_modal_serving_manifest(pool,
        registry_rows=graph._pipeline_modal_registry_identity_rows(pool),active8_ensemble=artifact)
    action=manifest['active8_action_authority']
    assert action['mode']=='paper_ensemble' and action['paper_buy_authorized'] is True
    assert action['buy_authorized'] is False and action['live_buy_authorized'] is False
    assert graph._active8_evidence_only_from_manifest(manifest) is False
    from app.serving_resolver import build_pool_from_frozen_manifest
    remote=build_pool_from_frozen_manifest(manifest,expected_digest=checksum)
    assert remote['active8_action_authority']==action
    forged=deepcopy(manifest)
    forged['active8_action_authority'].update(mode='production_ensemble',buy_authorized=True)
    with pytest.raises(RuntimeError,match='paper_scope_mismatch'):
        graph._active8_evidence_only_from_manifest(forged)
    with pytest.raises(Exception,match='paper_scope_mismatch'):
        build_pool_from_frozen_manifest(forged,expected_digest=graph._pipeline_modal_canonical_digest(forged))

    from services.paired_nav_collection import baseline_model_identity
    assert baseline_model_identity(manifest)['payload_checksum']==row['payload_checksum']
    assert publish(approved)['recovered_existing_commit'] is True and client.batches==1


@pytest.mark.parametrize('fault',['revoked','config','receipt','base'])
def test_paper_cannot_serve_after_authority_drift(approved,monkeypatch,fault):
    (client,row,_,_,current),approval=approved
    publish(approved)
    if fault=='revoked':
        from services import kv_client
        monkeypatch.setattr(kv_client,'get_json',lambda *a,**kw:None)
    elif fault=='config':current['risk_config']['changed']=True
    elif fault=='receipt':client.conn.execute("UPDATE active8_ensemble_pointer_v1 SET promotion_evidence_json='{}'")
    else:client.conn.execute("UPDATE model_artifact_registry SET checksum='bad' WHERE training_run_id=?",[row['training_run_id']])
    with pytest.raises((RuntimeError,ValueError)):
        resolver.load_d1_champion_pool(sidecar_models=())


@pytest.mark.parametrize('fault',['live','unapproved','wrong_A','missing_check','checksum'])
def test_unqualified_paper_request_cannot_publish(approved,fault):
    (client,row,*_),approval=approved
    if fault=='live':approval['configuration']['native_execution_policy']['variables']['LIVE_EXECUTION_CLIENT_ENABLED']='1'
    elif fault=='unapproved':approval['approved']=False
    elif fault=='wrong_A':
        tag=approval['strategy_bundle']['strategy_ab'];tag.update(role='B',recipe=RECIPES['B'])
        b=approval['strategy_bundle'];b['bundle_checksum']=digest({k:v for k,v in b.items() if k!='bundle_checksum'})
    elif fault=='missing_check':approval['strategy_bundle']['candidate_trading_config']['l4Distribution']['artifact']['release']['validation_receipt']['checks']['same_costs']=False
    if fault!='checksum':approval['admission_checksum']=digest({k:v for k,v in approval.items() if k!='admission_checksum'})
    else:approval['admission_checksum']='e'*64
    with pytest.raises((RuntimeError,ValueError)):
        publish(approved)
    assert client.batches==0


def test_model_pool_reads_verified_paper_members_without_forging_nav(approved):
    (client, row, *_), approval = approved
    publish(approved)
    pointers_before = client.query('SELECT * FROM active8_ensemble_pointer_v1')
    bundle = registry.load_active8_ensemble_serving_bundle()
    assert bundle['status'] == 'production'
    assert bundle['adoption_basis'] == 'paper_experiment_unproven'
    assert bundle['paper_buy_authorized'] is True and bundle['live_buy_authorized'] is False
    assert 'nav_decision_checksum' not in bundle
    assert bundle['base_artifacts'] == json.loads(row['payload_json'])['base_artifacts']
    assert len(bundle['serving_artifacts']) == 8
    from routers import model_pool
    result = model_pool._artifact_registry_champion_pointers_snapshot()
    assert result['ready_count'] == result['model_count'] == 8
    assert client.query('SELECT * FROM active8_ensemble_pointer_v1') == pointers_before
    approval['approved'] = False
    blocked = registry.load_active8_ensemble_serving_bundle()
    assert blocked['production_effect'] is False
    assert blocked['status'] == 'invalid_bundle'
