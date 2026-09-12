"""Distinct ensemble cohorts may reuse base models; history still binds each adoption."""
from copy import deepcopy
import hashlib
import json
import sqlite3

import pytest

from services import model_artifact_registry as registry
from test_active8_bundle_transaction import bundle, publish, state
from test_nav_l3_adoption import ready, prepared, environment, SESSIONS


@pytest.mark.parametrize('mutation', [
    "DELETE FROM model_champion_history WHERE model_name='DLinear'",
    "UPDATE model_champion_pointers SET promotion_evidence_json='{}' WHERE model_name='DLinear'",
    "UPDATE active8_ensemble_pointer_v1 SET promotion_evidence_json='{}'",
    "UPDATE model_artifact_registry SET checksum='changed' WHERE model_name='DLinear' AND training_run_id='fixture-cohort-candidate-v1'",
    "UPDATE active8_ensemble_artifacts_v1 SET payload_json='{}' WHERE state='production'",
])
def test_post_commit_readback_cannot_call_missing_history_complete(bundle, monkeypatch, mutation):
    db, *_ = bundle
    original = db.atomic_batch_execute
    def lose_history(statements, **kwargs):
        result = original(statements, **kwargs)
        db.conn.execute(mutation)
        db.conn.commit()
        return result
    monkeypatch.setattr(db, 'atomic_batch_execute', lose_history)
    with pytest.raises(RuntimeError, match='active8_bundle'):
        publish(bundle)


@pytest.mark.parametrize('prepared', [{'shared_bases': True}], indirect=True)
@pytest.mark.parametrize('collision', [False, True])
def test_second_cohort_reusing_bases_has_distinct_history_and_preserves_base_rollback(bundle, monkeypatch, collision):
    from services.active8_bundle_transaction import prepare_bundle_transaction
    db, rows, _, candidate = bundle
    first = db.query("SELECT * FROM active8_ensemble_artifacts_v1 WHERE state='production'")[0]
    payload = json.loads(first['payload_json'])
    selected = sorted(payload['selected_models'])
    assert first['base_artifact_set_checksum'] == candidate['base_artifact_set_checksum']
    # Fixed historical baseline state, not a new write through the retired
    # offline authorization path. Original recovery validates the seeded state.
    receipt = {'schema_version': 'active8-ensemble-atomic-promotion-evidence-v1',
        'training_run_id': first['training_run_id'], 'ensemble_artifact_id': first['artifact_id'],
        'ensemble_payload_checksum': first['payload_checksum'],
        'base_artifact_set_checksum': first['base_artifact_set_checksum'],
        'selected_models': selected, 'validation': payload['validation']}
    encoded = json.dumps(receipt, sort_keys=True)
    earlier = '2026-09-06T08:00:00+00:00'
    db.conn.execute('UPDATE active8_ensemble_pointer_v1 SET promotion_evidence_json=?,promoted_at=?', [encoded, earlier])
    for row in rows:
        name = row['model_name']
        db.conn.execute('UPDATE model_champion_pointers SET promotion_evidence_json=?,promoted_at=?,rollback_artifact_id=?,rollback_version=? WHERE model_name=?',
            [encoded, earlier, 'ancestor:' + name, 'ancestor-version', name])
        db.insert('model_champion_history', {'event_id': f"champion:{name}:{row['version']}:{first['payload_checksum']}",
            'model_name': name, 'version': row['version'], 'artifact_id': row['artifact_id'],
            'effective_at': earlier, 'retired_at': None, 'source': 'model_champion_history',
            'evidence_grade': 'exact', 'evidence_json': encoded})
    db.conn.commit()
    first_pointers = {p['model_name']: p for p in db.query('SELECT * FROM model_champion_pointers')}
    recovered = prepare_bundle_transaction(query=db.query, by_model={r['model_name']: r for r in rows},
        supplied_pointers=list(first_pointers.values()), ensemble_row=first, selected_models=selected)
    assert recovered['recovered_existing_commit']
    if collision:
        # Deliberately faulty publication clock collides with old history. It
        # must roll back, never drop history via ON CONFLICT DO NOTHING.
        monkeypatch.setattr(registry, '_now_iso', lambda: earlier)
        before = state(db)
        with pytest.raises(sqlite3.IntegrityError):
            publish(bundle)
        assert state(db) == before
        return
    result = publish(bundle)  # Actual original ten-session NAV review, not fake PASS.
    assert result['readback_verified'] and result['ensemble_artifact_id'] == candidate['artifact_id']
    for pointer in db.query('SELECT * FROM model_champion_pointers'):
        previous = first_pointers[pointer['model_name']]
        assert pointer['champion_artifact_id'] == previous['champion_artifact_id']
        assert pointer['rollback_artifact_id'] == previous['rollback_artifact_id']
        assert pointer['rollback_version'] == previous['rollback_version']
    histories = db.query('SELECT * FROM model_champion_history')
    assert len(histories) == 2 * len(selected)
    assert len({h['event_id'] for h in histories}) == len(histories)
    assert sum(h['retired_at'] is None for h in histories) == len(selected)
    for history in histories:
        assert json.loads(history['evidence_json'])['ensemble_payload_checksum'] in history['event_id']
    before = state(db)
    retry = publish(bundle)
    assert retry['recovered_existing_commit'] and state(db) == before


def test_recovery_uses_row_identity_not_unspecified_sql_result_order(bundle, monkeypatch):
    db, *_ = bundle
    publish(bundle)
    before = state(db)
    original = db.query
    counts = {}
    def unordered(sql, params=None):
        rows = original(sql, params)
        counts[sql] = counts.get(sql, 0) + 1
        return rows[::-1] if counts[sql] % 2 else rows
    monkeypatch.setattr(db, 'query', unordered)
    assert publish(bundle)['recovered_existing_commit']
    monkeypatch.setattr(db, 'query', original)
    assert state(db) == before and db.batches == 1
