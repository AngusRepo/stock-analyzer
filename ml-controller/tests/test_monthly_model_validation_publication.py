"""ML publication uses offline evidence; daily account outcomes cannot veto it."""
import asyncio
import json
from types import SimpleNamespace
import pytest
from routers import model_pool
from services import model_artifact_registry as registry
from services import trading_config_loader, active8_nav_adoption
from test_nav_l3_promotion_entrypoints import offline_bundle, request
from test_active8_bundle_transaction import state


@pytest.fixture
def model_bundle(offline_bundle, monkeypatch):
    db, *_ = offline_bundle
    monkeypatch.setattr(model_pool, 'LEARNING_D1_CLIENT', db)
    monkeypatch.setattr(trading_config_loader, 'load_merged_trading_config_with_contract',
                        lambda: SimpleNamespace(config={}))
    def forbidden(*args, **kwargs):
        raise AssertionError('daily NAV consulted for ML promotion')
    monkeypatch.setattr(active8_nav_adoption, 'prepare_nav_adoption', forbidden)
    return offline_bundle


def publish(bundle, **kwargs):
    return asyncio.run(model_pool.artifact_registry_active8_bundle_promotion_controller(request(bundle, **kwargs)))


@pytest.mark.parametrize('day', [None, '2026-08-27'])
def test_original_route_to_atomic_sql_to_serving_without_nav(model_bundle, day):
    db, _, _, ensemble = model_bundle
    result=publish(model_bundle, evaluation_business_date=day)
    assert result['can_promote'] and result['readback_verified']
    assert result['promotion_scope']=='model_validation' and db.batches==1
    receipt=json.loads(db.query('SELECT * FROM active8_ensemble_pointer_v1')[0]['promotion_evidence_json'])
    assert receipt['publication_basis']=='model_validation'
    assert 'nav_validation' not in receipt
    serving=registry.load_active8_ensemble_serving_bundle()
    assert serving['status']=='production' and serving['artifact_id']==ensemble['artifact_id']


def test_strong_pass_does_not_skip_incomplete_bundle(model_bundle):
    db,*_=model_bundle
    db.conn.execute("UPDATE model_artifact_registry SET state='offline_strong_pass' WHERE training_run_id='run-new' AND model_name!='PatchTST'")
    db.conn.execute("DELETE FROM model_artifact_registry WHERE model_name='LightGBM' AND training_run_id='run-new'")
    db.conn.commit();before=state(db)
    result=publish(model_bundle)
    assert result['decision']=='active8_bundle_incomplete' and db.batches==0 and state(db)==before


def test_failed_selected_model_cannot_use_daily_date_to_bypass(model_bundle):
    db,*_=model_bundle
    db.conn.execute("UPDATE model_artifact_registry SET state='offline_failed' WHERE model_name='LightGBM' AND training_run_id='run-new'")
    db.conn.commit();before=state(db)
    result=publish(model_bundle,evaluation_business_date='2026-08-27')
    assert not result['can_promote'] and 'base_artifact_contract:LightGBM' in result['blockers']
    assert db.batches==0 and state(db)==before


def test_model_commit_lost_reply_recovers_without_second_write(model_bundle):
    db,*_=model_bundle;db.lose_ack=True
    from fastapi import HTTPException
    with pytest.raises(HTTPException): publish(model_bundle)
    before=state(db);result=publish(model_bundle)
    assert result['recovered_existing_commit'] and result['readback_verified']
    assert db.batches==1 and state(db)==before


def test_model_midbatch_failure_rolls_back(model_bundle):
    db,*_=model_bundle;before=state(db);db.fail_after_writes=5
    from fastapi import HTTPException
    with pytest.raises(HTTPException): publish(model_bundle)
    assert state(db)==before


def test_auto_promote_calls_model_bundle_and_reads_back(model_bundle, monkeypatch):
    db,rows,*_=model_bundle
    # Exercise the actual queue projection, including its cohort identity.
    db.conn.execute("UPDATE model_artifact_registry SET live_gate_status='multi_evidence_passed' WHERE training_run_id='run-new' AND model_name!='PatchTST'")
    db.conn.commit()
    monkeypatch.setattr(model_pool.discord_alert,'alert_lifecycle',lambda *a,**kw:None)
    result=asyncio.run(model_pool.artifact_registry_auto_promote(model_pool.AutoPromotionRequest(confirm=True)))
    assert result['promoted']==7 and result['readback_verified'] and db.batches==1
    assert result['results'][0]['promotion_scope']=='model_validation'


def test_real_queue_preserves_exact_training_run_id():
    from test_model_artifact_registry import _oof_full_fit_release_row, _champion_row
    candidate = {**_oof_full_fit_release_row(), 'training_run_id': 'exact-monthly-cohort'}
    queue = registry.build_promotion_queue(
        [candidate, _champion_row(target_semantic_version=None)],
        champion_versions={'XGBoost': 'vOld'})
    assert len(queue['queue']) == 1
    assert queue['queue'][0]['training_run_id'] == 'exact-monthly-cohort'


def test_real_queue_limit_cannot_hide_second_eligible_cohort(model_bundle, monkeypatch):
    db, rows, *_ = model_bundle
    db.conn.execute("UPDATE model_artifact_registry SET live_gate_status='multi_evidence_passed' WHERE training_run_id='run-new' AND model_name!='PatchTST'")
    db.insert('model_artifact_registry', {**rows[0], 'artifact_id': 'other-cohort-model',
        'version': 'v-other', 'training_run_id': 'run-other',
        'live_gate_status': 'multi_evidence_passed'})
    db.conn.commit()
    before = state(db)
    monkeypatch.setattr(model_pool.discord_alert, 'alert_lifecycle', lambda *a, **kw: None)
    result = asyncio.run(model_pool.artifact_registry_auto_promote(
        model_pool.AutoPromotionRequest(confirm=True, max_candidates=1)))
    assert result['promoted'] == 0 and db.batches == 0 and state(db) == before
    assert result['results'][0]['decision'] == 'active8_exact_training_run_required'
    assert result['results'][0]['training_run_ids'] == ['run-new', 'run-other']


@pytest.mark.parametrize('selection_decision', ['PASS', 'FAIL'])
def test_offline_monthly_same_target_does_not_require_daily_evidence(selection_decision):
    from test_model_artifact_registry import _oof_full_fit_release_row, _champion_row
    candidate = _oof_full_fit_release_row(selection_decision=selection_decision)
    champion = _champion_row(target_semantic_version=registry.ACTIVE8_TARGET_SEMANTIC_VERSION)
    blockers = registry._offline_oof_full_fit_release_blockers(
        candidate, champion_artifact=champion, model_validation_publication=True,
        blockers=[{'code': 'live_ic_not_ready'}, {'code': 'candidate_sample_window_too_short'},
                  {'code': 'release_training_config_attestation_missing_or_invalid'}])
    codes = {item['code'] for item in blockers}
    assert 'oof_release_requires_semantic_bootstrap' not in codes
    assert 'live_ic_not_ready' not in codes and 'candidate_sample_window_too_short' not in codes
    assert 'release_training_config_attestation_missing_or_invalid' in codes
    assert ('cohort_model_selection_pbo_failed' in codes) == (selection_decision == 'FAIL')


def test_model_queue_preview_uses_same_authority_as_publisher(model_bundle, monkeypatch):
    observed = []
    def queue(rows, **options):
        observed.append(options)
        return {'queue': []}
    monkeypatch.setattr(model_pool, 'build_promotion_queue', queue)
    model_pool._artifact_registry_promotion_queue_snapshot()
    asyncio.run(model_pool.artifact_registry_auto_promote(model_pool.AutoPromotionRequest(confirm=True)))
    assert len(observed) == 2 and all(item['model_validation_publication'] is True for item in observed)


def test_stale_base_change_aborts_atomic_commit(model_bundle):
    db,*_=model_bundle;observed=[]
    def other_writer(conn):
        conn.execute("UPDATE model_champion_pointers SET champion_version='concurrent' WHERE model_name='LightGBM'")
        observed.append(state(db))
    db.before_batch=other_writer
    from fastapi import HTTPException
    with pytest.raises(HTTPException): publish(model_bundle)
    assert state(db)==observed[0]


def test_ensemble_failed_evidence_blocks_even_with_strong_base(model_bundle):
    db,*_=model_bundle
    db.conn.execute("UPDATE active8_ensemble_artifacts_v1 SET validation_decision='FAIL'")
    db.conn.commit();before=state(db)
    result=publish(model_bundle)
    assert not result['can_promote'] and result['decision']=='active8_ensemble_candidate_not_promotion_grade'
    assert state(db)==before and db.batches==0


def test_paired_l4_identity_guard_remains(model_bundle,monkeypatch):
    db,*_=model_bundle;before=state(db)
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',
                        lambda:SimpleNamespace(config={'l4Distribution':{'artifact':{}}}))
    result=publish(model_bundle)
    assert not result['can_promote'] and result['decision'].startswith('paired_l4_required:')
    assert state(db)==before and db.batches==0
