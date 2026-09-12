"""Original bundle publisher against actual local schema; no remote I/O or NAV ROI."""
import json
import asyncio
from copy import deepcopy
import sqlite3

import pytest

from services import model_artifact_registry as registry
from test_active8_ensemble_bundle_promotion import _fixture
from test_nav_l3_adoption import ready, prepared, environment, SESSIONS


from nav_bundle_sqlite import SQLiteBundle


@pytest.fixture
def bundle(ready):
    db, ensemble, *_ = ready
    ensemble = db.query('SELECT * FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?', [ensemble['artifact_id']])[0]
    rows = db.query('SELECT * FROM model_artifact_registry WHERE training_run_id=?', [ensemble['training_run_id']])
    return db, rows, db.query('SELECT * FROM model_champion_pointers'), ensemble


def publish(bundle, **options):
    db, rows, pointers, ensemble = bundle
    options.setdefault('evaluation_business_date', SESSIONS[-1])
    return registry.run_active8_ensemble_bundle_promotion_controller(training_run_id=ensemble['training_run_id'],
        registry_rows=rows, d1_pointers=pointers, ensemble_rows=[ensemble], confirm=True, **options)


def state(db):
    return {table: db.query(f'SELECT * FROM {table} ORDER BY 1') for table in (
        'model_artifact_registry', 'model_champion_pointers', 'model_champion_history',
        'active8_ensemble_artifacts_v1', 'active8_ensemble_pointer_v1')}


def test_real_sql_commit_keeps_exact_base_and_ensemble_pointer(bundle):
    db, _, _, ensemble = bundle
    result = publish(bundle)
    assert result['readback_verified'] and db.batches == 1
    pointer = db.query('SELECT * FROM active8_ensemble_pointer_v1')[0]
    assert pointer['artifact_id'] == ensemble['artifact_id']
    assert len(db.query('SELECT * FROM model_champion_history WHERE retired_at IS NULL')) == len(json.loads(ensemble['payload_json'])['selected_models'])


def test_lost_commit_ack_retry_is_read_only_and_preserves_rollback_history(bundle):
    db, *_ = bundle
    db.lose_ack = True
    with pytest.raises(TimeoutError, match='commit_ack_lost'):
        publish(bundle)
    committed = state(db)
    result = publish(bundle)
    assert result['readback_verified'] and result['recovered_existing_commit'] is True
    assert db.batches == 1 and state(db) == committed


@pytest.mark.parametrize('mutation', [
    "UPDATE model_champion_pointers SET champion_artifact_id='concurrent',champion_version='newer' WHERE model_name='DLinear'",
    "UPDATE model_artifact_registry SET state='rejected' WHERE model_name='DLinear' AND training_run_id='fixture-cohort-candidate-v1'",
    "UPDATE active8_ensemble_artifacts_v1 SET state='rejected' WHERE training_run_id='fixture-cohort-candidate-v1'",
    "UPDATE active8_ensemble_artifacts_v1 SET payload_checksum=printf('%064d',9) WHERE training_run_id='fixture-cohort-candidate-v1'",
])
def test_concurrent_change_aborts_entire_original_batch(bundle, mutation):
    db, *_ = bundle
    after_other_writer = []
    def other_writer(conn):
        conn.execute(mutation)
        after_other_writer.append(state(db))
    db.before_batch = other_writer
    with pytest.raises((RuntimeError, sqlite3.DatabaseError)):
        publish(bundle)
    assert state(db) == after_other_writer[0]


def test_mid_batch_failure_rolls_back_all_pointers_registry_and_history(bundle):
    db, *_ = bundle
    before = state(db)
    db.fail_after_writes = 5
    with pytest.raises(RuntimeError, match='injected_mid_batch_failure'):
        publish(bundle)
    assert state(db) == before


def test_stale_selected_base_read_is_rejected_before_any_batch(bundle):
    db, *_ = bundle
    db.conn.execute("UPDATE model_artifact_registry SET checksum='different' WHERE model_name='DLinear' AND training_run_id='fixture-cohort-candidate-v1'")
    db.conn.commit()
    before = state(db)
    with pytest.raises(RuntimeError, match='active8_bundle'):
        publish(bundle)
    assert db.batches == 0 and state(db) == before


def test_already_current_bundle_with_corrupt_receipt_cannot_repair_itself_by_repromoting(bundle):
    db, *_ = bundle
    publish(bundle)
    db.conn.execute("UPDATE active8_ensemble_pointer_v1 SET promotion_evidence_json='{}'")
    db.conn.commit()
    before = state(db)
    with pytest.raises(RuntimeError, match='active8_bundle'):
        publish(bundle)
    assert db.batches == 1 and state(db) == before


@pytest.mark.parametrize('mutation', [
    "UPDATE model_champion_pointers SET champion_artifact_id='concurrent' WHERE model_name='DLinear'",
    "UPDATE model_champion_history SET retired_at='2026-09-10' WHERE model_name='DLinear'",
    "UPDATE model_champion_history SET evidence_json='{}' WHERE model_name='DLinear'",
    "UPDATE model_artifact_registry SET state='archived' WHERE model_name='DLinear' AND training_run_id='fixture-cohort-candidate-v1'",
])
def test_retry_does_not_restore_changed_base_pointer_or_repair_incomplete_history(bundle, mutation):
    db, *_ = bundle
    publish(bundle)
    db.conn.execute(mutation)
    db.conn.commit()
    before = state(db)
    with pytest.raises(RuntimeError, match='active8_bundle'):
        publish(bundle)
    assert db.batches == 1 and state(db) == before


def test_concurrent_ensemble_owner_cannot_be_overwritten(bundle):
    db, _, _, ensemble = bundle
    other = {**ensemble, 'artifact_id': 'another:bundle', 'cohort_id': 'another-cohort',
             'payload_checksum': 'd' * 64, 'state': 'production', 'production_effect': 1}
    db.insert('active8_ensemble_artifacts_v1', other)
    db.conn.commit()
    after_other_writer = []
    def other_writer(conn):
        conn.execute('UPDATE active8_ensemble_pointer_v1 SET artifact_id=?,cohort_id=?,payload_checksum=?,base_artifact_set_checksum=?,promotion_reason=? WHERE singleton_id=1',
            [other['artifact_id'], other['cohort_id'], other['payload_checksum'], other['base_artifact_set_checksum'], 'concurrent_other_owner'])
        after_other_writer.append(state(db))
    db.before_batch = other_writer
    with pytest.raises(sqlite3.DatabaseError):
        publish(bundle)
    assert state(db) == after_other_writer[0]


def test_explicit_ensemble_identity_selects_exact_cohort_and_exact_base_not_latest_rows(bundle):
    db, rows, pointers, ensemble = bundle
    other = deepcopy(ensemble)
    other.update(artifact_id='other:ensemble', cohort_id='other:cohort', payload_checksum='e' * 64)
    db.insert('active8_ensemble_artifacts_v1', other)
    alternate_base = {**rows[0], 'artifact_id': 'other:base', 'version': 'v-other'}
    db.insert('model_artifact_registry', alternate_base)
    db.conn.commit()
    result = registry.run_active8_ensemble_bundle_promotion_controller(training_run_id=ensemble['training_run_id'],
        registry_rows=[alternate_base, *rows], d1_pointers=pointers,
        ensemble_artifact_id=ensemble['artifact_id'], ensemble_payload_checksum=ensemble['payload_checksum'],
        evaluation_business_date=SESSIONS[-1], confirm=True)
    assert result['ensemble_artifact_id'] == ensemble['artifact_id'] and result['readback_verified']
    assert db.query('SELECT state FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?', [other['artifact_id']]) == [{'state': 'candidate'}]
    assert db.query('SELECT state FROM model_artifact_registry WHERE artifact_id=?', ['other:base']) == [{'state': alternate_base['state']}]


@pytest.mark.parametrize('identity', [
    {'ensemble_artifact_id': 'unknown'},
    {'ensemble_payload_checksum': 'a' * 64},
    {'ensemble_artifact_id': 'unknown', 'ensemble_payload_checksum': 'a' * 64},
])
def test_incomplete_or_missing_exact_identity_never_falls_back_to_other_candidate(bundle, identity):
    db, *_ = bundle
    before = state(db)
    result = publish(bundle, **identity)
    assert result['can_promote'] is False
    assert db.batches == 0 and state(db) == before


def test_original_endpoint_uses_complete_run_query_and_recovers_committed_receipt(bundle, monkeypatch):
    from routers import model_pool
    db, _, _, ensemble = bundle
    monkeypatch.setattr(model_pool, 'LEARNING_D1_CLIENT', db)
    monkeypatch.setattr(model_pool, 'list_artifact_registry', lambda **kw: pytest.fail('global latest-N is not a cohort inventory'))
    publish(bundle)  # Original NAV commit; no-date API recovers its immutable historical review.
    request = model_pool.Active8BundlePromotionControllerRequest(training_run_id=ensemble['training_run_id'], confirm=True,
        ensemble_artifact_id=ensemble['artifact_id'], ensemble_payload_checksum=ensemble['payload_checksum'])
    result = asyncio.run(model_pool.artifact_registry_active8_bundle_promotion_controller(request))
    assert result['readback_verified'] and result['ensemble_artifact_id'] == ensemble['artifact_id']
    before = state(db)
    recovered = asyncio.run(model_pool.artifact_registry_active8_bundle_promotion_controller(request))
    assert recovered['readback_verified'] and recovered['recovered_existing_commit']
    assert state(db) == before and db.batches == 1
