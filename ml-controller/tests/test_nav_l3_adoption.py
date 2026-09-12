"""Original L3 NAV review to original publisher; isolated synthetic I/O, NOT ROI."""
from copy import deepcopy
from datetime import datetime
import json
import asyncio
import sqlite3

import pytest

from services import active8_nav_adoption as authority, model_artifact_registry as registry
from services.active8_ensemble_repository import _exact_artifact_row
from services.paired_nav_journal import digest
from test_paired_nav_l3_candidate import prepared
from test_paired_nav_candidate_collection import environment
from test_nav_l3_mature_evidence import build_mature_l3, stamp, SESSIONS
from nav_bundle_sqlite import SQLiteBundle


@pytest.fixture
def ready(prepared, monkeypatch, request):
    db, _, manifest, _, _ = prepared
    old = db.query('SELECT * FROM active8_ensemble_artifacts_v1', [])[0]
    artifact = json.loads(old['payload_json'])
    artifact['signal_policy']['net_return_zero_boundary'] = 0.0
    artifact['validation'].update(decision='FAIL', rank_ic_equal_date_market_lcb90=-.1,
        failed_gates=['chronological_validation_equal_date_market_rank_ic_lcb90_non_positive'])
    artifact.pop('payload_checksum')
    artifact['payload_checksum'] = digest(artifact)
    changed = _exact_artifact_row(artifact, training_run_id=old['training_run_id'], archive_uri=old['archive_uri'])
    db.conn.execute('UPDATE active8_ensemble_artifacts_v1 SET ' + ','.join(key + '=?' for key in changed) +
                    ' WHERE artifact_id=?', [*changed.values(), old['artifact_id']])
    db.conn.commit()
    nav, reviewed, plan = build_mature_l3(prepared, monkeypatch, with_environment=True,
                                        with_all_owners=getattr(request, 'param', False))
    assert nav['decision'] == 'PASS' and nav['evaluable_date_count'] == 10
    shared_ids = {item['artifact_id'] for item in artifact['observation_artifacts'].values()} & {
        item['artifact_id'] for item in manifest['active8_ensemble']['observation_artifacts'].values()}
    formal = _exact_artifact_row(manifest['active8_ensemble'],
        training_run_id=old['training_run_id'] if shared_ids else 'formal-run', archive_uri='test://formal')
    formal.update(state='production', production_effect=1)
    db.conn.execute('INSERT INTO active8_ensemble_artifacts_v1(' + ','.join(formal) + ') VALUES(' +
                    ','.join('?' for _ in formal) + ')', list(formal.values()))
    db.conn.execute('INSERT INTO active8_ensemble_pointer_v1(singleton_id,artifact_id,cohort_id,payload_checksum,base_artifact_set_checksum,promotion_reason) VALUES(1,?,?,?,?,?)',
        [formal[k] for k in ('artifact_id','cohort_id','payload_checksum','base_artifact_set_checksum')] + ['fixture-original'])
    client = SQLiteBundle()
    # Keep all original evidence. Add canonical model columns absent from the
    # older narrow EV fixture; independent transaction tests use full real DDL.
    existing = {r['name'] for r in db.query('PRAGMA table_info(model_artifact_registry)', [])}
    for column in client.query('PRAGMA table_info(model_artifact_registry)'):
        if column['name'] not in existing:
            db.conn.execute(f"ALTER TABLE model_artifact_registry ADD COLUMN {column['name']} {column['type']}")
    for table in ('model_champion_pointers','model_champion_history'):
        sql = client.query('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?', [table])[0]['sql']
        db.conn.executescript(sql)
    client.conn.close()
    client.conn = db.conn
    from services import model_serving_resolver as resolver
    for packet, state, run in ((artifact,'offline_failed',old['training_run_id']),
                               (manifest['active8_ensemble'],'production','formal-run')):
        for model, identity in packet['observation_artifacts'].items():
            effective_state = 'production' if identity['artifact_id'] in shared_ids else state
            effective_run = old['training_run_id'] if identity['artifact_id'] in shared_ids else run
            metadata = {'target_semantic_version': resolver.LABEL_SCHEMA_VERSION,
                'feature_semantic_version': resolver.FORMAL_FEATURE_SEMANTIC_VERSION,
                'graph_context': {'semantic_version': resolver.FORMAL_GNN_GRAPH_SEMANTIC_VERSION},
                'seq_len': 64, 'pred_len': 5, 'rank_ic_semantic_version': resolver.FORMAL_RANK_IC_SEMANTIC_VERSION}
            row = {**identity, 'model_name': model, 'state': effective_state, 'training_run_id': effective_run,
                'artifact_path': 'test://' + identity['artifact_id'] + '.' + resolver.ARTIFACT_EXTENSIONS[model],
                'metadata_path': 'test://metadata/' + identity['artifact_id'],
                'offline_gate_decision': 'FAIL' if effective_state == 'offline_failed' else 'PASS',
                'offline_evidence_json': json.dumps({'registration': {'metadata': metadata, 'oof_promotion_evidence': {
                    'schema_version': 'model-cpcv-evidence-v1', 'method': 'outer_purged_walk_forward_rank_ic',
                    'folds': 5, 'decision': 'FAIL' if effective_state == 'offline_failed' else 'PASS'}}})}
            existing = client.query('SELECT * FROM model_artifact_registry WHERE artifact_id=?', [row['artifact_id']])
            if existing:
                assert all(existing[0].get(key) == value for key, value in row.items())
            else:
                client.insert('model_artifact_registry', row)
            if state == 'production':
                client.insert('model_champion_pointers', {'model_name': model, 'champion_version': identity['version'],
                    'champion_artifact_id': identity['artifact_id']})
    db.conn.commit()
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return stamp(SESSIONS[-1])
    monkeypatch.setattr(authority, 'datetime', Clock)
    monkeypatch.setattr(registry, '_now_iso', lambda: stamp(SESSIONS[-1]).isoformat())
    db.conn.create_function('current_timestamp', 0, lambda: '2026-09-21 14:00:00')
    monkeypatch.setattr(registry, 'd1_client', client)
    configuration = plan['configuration']
    current = {key: deepcopy(configuration[key]) for key in ('trading_config','risk_config',
        'allocator_source_identity','l3_inference_source_identity','native_execution_policy')}
    monkeypatch.setattr(authority, 'current_execution_configuration', lambda: deepcopy(current))
    from nav_bundle_sqlite import ensure_prediction_schema
    from services import recommendation_service
    ensure_prediction_schema(client.conn)
    monkeypatch.setattr(recommendation_service, '_predictions_query',
                        lambda sql, params=None, timeout=None: client.query(sql, params))
    return client, changed, nav, configuration, current


def publish(ready, *, confirm=True, business_date=None):
    client, candidate, *_ = ready
    return registry.run_active8_ensemble_bundle_promotion_controller(
        training_run_id=candidate['training_run_id'],
        registry_rows=client.query('SELECT * FROM model_artifact_registry WHERE training_run_id=?', [candidate['training_run_id']]),
        d1_pointers=client.query('SELECT * FROM model_champion_pointers'),
        ensemble_artifact_id=candidate['artifact_id'], ensemble_payload_checksum=candidate['payload_checksum'],
        evaluation_business_date=business_date or SESSIONS[-1], confirm=confirm)


def test_original_nav_can_commit_offline_failed_bundle_without_rewriting_diagnostics_or_spending(ready):
    client, candidate, nav, configuration, _ = ready
    reviews = client.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id')
    preview = publish(ready, confirm=False)
    assert preview['can_promote'] and preview['validation']['decision'] == 'FAIL'
    assert client.batches == 0
    result = publish(ready)
    assert result['readback_verified'] and result['nav_validation'] == nav
    assert result['promotion_scope'] == 'paired_nav'
    assert result['serving_activation_verified'] is False  # Serving reader integration is separate, not fake complete.
    pointer = client.query('SELECT * FROM active8_ensemble_pointer_v1')[0]
    evidence = json.loads(pointer['promotion_evidence_json'])
    assert evidence['nav_validation'] == nav and evidence['nav_configuration'] == configuration
    assert evidence['validation']['decision'] == 'FAIL'
    assert client.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id') == reviews
    assert client.batches == 1


@pytest.mark.parametrize('field', ['trading_config', 'risk_config', 'allocator_source_identity',
                                  'l3_inference_source_identity', 'native_execution_policy'])
def test_current_configuration_drift_cannot_reuse_old_nav_pass(ready, field):
    client, _, _, _, current = ready
    before = client.query('SELECT * FROM active8_ensemble_pointer_v1')
    current[field]['changed_after_review'] = True
    result = publish(ready)
    assert result['status'] == 'waiting' and result['can_promote'] is False
    assert result['completion_scope'] == 'candidate_comparison'
    assert result['comparison']['changed_fields'] == [field]
    assert result['nav_validation']['decision'] == 'PASS'
    assert result['comparison']['nav_maturity_credit'] == 0
    assert client.batches == 0 and client.query('SELECT * FROM active8_ensemble_pointer_v1') == before


def test_changed_current_ensemble_cannot_use_comparison_against_previous_baseline(ready):
    client, *_ = ready
    client.conn.execute("UPDATE active8_ensemble_pointer_v1 SET payload_checksum=printf('%064d',8)")
    client.conn.commit()
    before = client.query('SELECT * FROM active8_ensemble_pointer_v1')
    with pytest.raises(RuntimeError, match='active8_nav_current_baseline_changed'):
        publish(ready)
    assert client.batches == 0 and client.query('SELECT * FROM active8_ensemble_pointer_v1') == before


def test_lost_nav_commit_ack_recovers_original_review_without_spending_again(ready):
    client, _, nav, _, current = ready
    client.lose_ack = True
    with pytest.raises(TimeoutError, match='commit_ack_lost'):
        publish(ready)
    before = {table: client.query('SELECT * FROM ' + table + ' ORDER BY 1') for table in
        ('model_champion_pointers','model_champion_history','active8_ensemble_pointer_v1','paired_nav_review_records_v1')}
    current['risk_config']['changed_after_commit'] = True
    result = publish(ready)
    assert result['recovered_existing_commit'] and result['nav_validation'] == nav
    assert result['serving_activation_verified'] is False
    assert client.batches == 1
    assert {table: client.query('SELECT * FROM ' + table + ' ORDER BY 1') for table in before} == before


def test_new_frozen_source_during_adoption_aborts_original_transaction(ready):
    from services.paired_nav_journal import freeze_snapshot
    client, *_ = ready
    before = client.query('SELECT * FROM active8_ensemble_pointer_v1')
    def other_writer(conn):
        def write(statements):
            for sql, params in statements:
                conn.execute(sql, params)
            return {'success_count': len(statements), 'error_count': 0}
        freeze_snapshot(signal_date='2026-09-21', source_run_id='concurrent-new-source',
            snapshot_kind='allocation_context', content={}, query=client.query, writer=write, now=stamp('2026-09-21'))
    client.before_batch = other_writer
    with pytest.raises(sqlite3.DatabaseError):
        publish(ready)
    assert client.query('SELECT * FROM active8_ensemble_pointer_v1') == before
    assert client.query('SELECT * FROM model_champion_history') == []


def test_original_api_carries_nav_date_without_claiming_serving_activation(ready, monkeypatch):
    from routers import model_pool
    client, candidate, nav, *_ = ready
    monkeypatch.setattr(model_pool, 'LEARNING_D1_CLIENT', client)
    request = model_pool.Active8BundlePromotionControllerRequest(training_run_id=candidate['training_run_id'],
        ensemble_artifact_id=candidate['artifact_id'], ensemble_payload_checksum=candidate['payload_checksum'],
        evaluation_business_date=SESSIONS[-1], confirm=True)
    result = asyncio.run(model_pool.artifact_registry_active8_bundle_promotion_controller(request))
    assert result['readback_verified'] and result['nav_validation'] == nav
    assert result['serving_activation_verified'] is False
