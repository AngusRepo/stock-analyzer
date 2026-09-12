"""Original public routes must not turn offline PASS into new serving authority.

Historical SQL fixtures and synthetic NAV fixtures use private SQLite only.
"""
import asyncio
import base64
import hashlib
import json
from pathlib import Path
import zlib

import pytest

from routers import model_pool
from test_active8_bundle_transaction import bundle, publish, state
from test_nav_l3_adoption import ready, prepared, environment, publish as publish_nav, SESSIONS
from nav_bundle_sqlite import SQLiteBundle
from test_active8_ensemble_bundle_promotion import _fixture


@pytest.fixture
def offline_bundle(monkeypatch):
    """Old offline-PASS candidate only; never grant it publication permission."""
    from services import model_artifact_registry as registry
    db = SQLiteBundle()
    rows, pointers, ensemble = _fixture()
    ensemble.update(knowledge_cutoff_date='2026-08-27', schema_version='active8-oof-ensemble-serving-artifact-v1',
                    validation_json=json.dumps({'decision': 'PASS', 'failed_gates': []}),
                    archive_uri='test://immutable/bundle', production_effect=0)
    for row in rows:
        db.insert('model_artifact_registry', row)
        db.insert('model_artifact_registry', {**row, 'artifact_id': 'old:' + row['model_name'],
            'version': 'v-old', 'training_run_id': 'run-old', 'state': 'production'})
    for pointer in pointers:
        db.insert('model_champion_pointers', pointer)
    db.insert('active8_ensemble_artifacts_v1', ensemble)
    db.conn.commit()
    monkeypatch.setattr(registry, 'd1_client', db)
    yield db, rows, pointers, ensemble
    db.conn.close()


def request(bundle, **kwargs):
    row = bundle[3]
    return model_pool.Active8BundlePromotionControllerRequest(
        training_run_id=row['training_run_id'], ensemble_artifact_id=row['artifact_id'],
        ensemble_payload_checksum=row['payload_checksum'], confirm=True, **kwargs)


def test_public_offline_pass_cannot_publish_new_bundle_without_nav_date(offline_bundle, monkeypatch):
    bundle = offline_bundle
    db = bundle[0]
    monkeypatch.setattr(model_pool, 'LEARNING_D1_CLIENT', db)
    before = state(db)
    result = asyncio.run(model_pool.artifact_registry_active8_bundle_promotion_controller(request(bundle)))
    assert result['can_promote'] is False, result
    assert result['decision'] == 'active8_new_publication_requires_daily_nav'
    assert db.batches == 0 and state(db) == before


def test_low_level_offline_pass_is_not_new_publication_authority(offline_bundle):
    from services import model_artifact_registry as registry
    db, rows, pointers, ensemble = offline_bundle
    before = state(db)
    result = registry.run_active8_ensemble_bundle_promotion_controller(training_run_id='run-new',
        registry_rows=rows, d1_pointers=pointers, ensemble_rows=[ensemble], confirm=True)
    assert result['can_promote'] is False and result['decision'] == 'active8_new_publication_requires_daily_nav'
    assert db.batches == 0 and state(db) == before


def test_existing_nav_commit_can_still_recover_without_requalification(bundle, monkeypatch):
    db = bundle[0]
    publish(bundle)  # Original NAV transaction, never a production call.
    monkeypatch.setattr(model_pool, 'LEARNING_D1_CLIENT', db)
    before = state(db)
    result = asyncio.run(model_pool.artifact_registry_active8_bundle_promotion_controller(request(bundle)))
    assert result['recovered_existing_commit'] and result['readback_verified']
    assert state(db) == before and db.batches == 1


def test_generic_auto_promotion_delegates_ensemble_to_daily_owner(offline_bundle, monkeypatch):
    bundle = offline_bundle
    db, rows, *_ = bundle
    monkeypatch.setattr(model_pool, 'list_artifact_registry', lambda **kw: rows)
    monkeypatch.setattr(model_pool, 'build_promotion_queue', lambda *a, **kw: {'queue': []})
    monkeypatch.setattr(model_pool.discord_alert, 'alert_lifecycle', lambda *a, **kw: None)
    before = state(db)
    result = asyncio.run(model_pool.artifact_registry_auto_promote(model_pool.AutoPromotionRequest(confirm=True)))
    assert result['promoted'] == 0, result
    assert any(item.get('publication_owner') == 'daily_paired_nav' for item in result['results'])
    assert db.batches == 0 and state(db) == before


def test_offline_preview_is_diagnostic_not_publication_permission(offline_bundle, monkeypatch):
    bundle = offline_bundle
    monkeypatch.setattr(model_pool, 'LEARNING_D1_CLIENT', bundle[0])
    req = request(bundle).model_copy(update={'confirm': False})
    result = asyncio.run(model_pool.artifact_registry_active8_bundle_promotion_controller(req))
    assert result['can_promote'] is False and result['offline_diagnostic_can_promote'] is True
    assert result['completion_scope'] == 'offline_diagnostic_only'
    assert bundle[0].batches == 0


def test_recovery_only_is_enforced_inside_original_transaction(bundle):
    result = publish(bundle, recovery_only=True)
    assert result['can_promote'] is False
    assert result['decision'] == 'active8_recovery_requires_existing_commit'
    assert bundle[0].batches == 0


def test_public_recovery_cannot_become_new_publication_after_pointer_change(bundle, monkeypatch):
    db = bundle[0]
    publish(bundle)
    monkeypatch.setattr(model_pool, 'LEARNING_D1_CLIENT', db)
    original_query = db.query
    changed = []
    def racing_query(sql, params=None):
        if not changed and sql.startswith('SELECT * FROM model_artifact_registry WHERE training_run_id='):
            db.conn.execute('DELETE FROM active8_ensemble_pointer_v1')
            db.conn.execute("UPDATE active8_ensemble_artifacts_v1 SET state='candidate',production_effect=0")
            db.conn.commit()
            changed.append(True)
        return original_query(sql, params)
    monkeypatch.setattr(db, 'query', racing_query)
    result = asyncio.run(model_pool.artifact_registry_active8_bundle_promotion_controller(request(bundle)))
    assert changed and result['can_promote'] is False
    assert result['decision'] == 'active8_recovery_requires_existing_commit'
    assert db.batches == 1


def test_nav_commit_recovery_uses_original_date_and_does_not_spend_again(ready, monkeypatch):
    client, candidate, nav, *_ = ready
    publish_nav(ready)
    monkeypatch.setattr(model_pool, 'LEARNING_D1_CLIENT', client)
    before = state(client)
    reviews = client.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id')
    req = model_pool.Active8BundlePromotionControllerRequest(training_run_id=candidate['training_run_id'],
        ensemble_artifact_id=candidate['artifact_id'], ensemble_payload_checksum=candidate['payload_checksum'],
        confirm=True)
    result = asyncio.run(model_pool.artifact_registry_active8_bundle_promotion_controller(req))
    assert result['recovered_existing_commit'] and result['nav_validation'] == nav
    assert result['nav_validation']['as_of_date'] == SESSIONS[-1]
    assert client.batches == 1 and state(client) == before
    assert client.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id') == reviews


@pytest.mark.parametrize('damage', [None, 'history', 'receipt', 'base_pointer'])
def test_captured_legacy_commit_recovers_without_new_publication_or_nav_relabel(monkeypatch, damage):
    from services import model_artifact_registry as registry
    snapshot = json.loads((Path(__file__).parent / 'fixtures/nav_legacy_bundle_commit.json').read_text(encoding='utf-8'))
    assert snapshot['fixture_kind'] == 'synthetic_legacy_policy_commit_not_production_or_roi'
    raw = zlib.decompress(base64.b64decode(snapshot['tables_zlib_base64']))
    assert len(raw) == snapshot['decoded_size'] and hashlib.sha256(raw).hexdigest() == snapshot['decoded_sha256']
    tables = json.loads(raw)
    db = SQLiteBundle()
    try:
        for table in ('model_artifact_registry','model_champion_pointers','model_champion_history',
                      'active8_ensemble_artifacts_v1','active8_ensemble_pointer_v1'):
            for row in tables[table]:
                db.insert(table, row)
        if damage == 'history':
            db.conn.execute("UPDATE model_champion_history SET evidence_grade='unknown'")
        elif damage == 'receipt':
            db.conn.execute("UPDATE active8_ensemble_pointer_v1 SET promotion_evidence_json='{}'")
        elif damage == 'base_pointer':
            db.conn.execute("UPDATE model_champion_pointers SET champion_version='corrupt'")
        db.conn.commit()
        monkeypatch.setattr(registry, 'd1_client', db)
        monkeypatch.setattr(model_pool, 'LEARNING_D1_CLIENT', db)
        before = state(db)
        current = tables['active8_ensemble_artifacts_v1'][0]
        req = model_pool.Active8BundlePromotionControllerRequest(training_run_id=current['training_run_id'],
            ensemble_artifact_id=current['artifact_id'], ensemble_payload_checksum=current['payload_checksum'], confirm=True)
        if damage:
            with pytest.raises(model_pool.HTTPException) as error:
                asyncio.run(model_pool.artifact_registry_active8_bundle_promotion_controller(req))
            assert 'active8_bundle_committed_receipt_invalid' in error.value.detail
            assert state(db) == before and db.batches == 0
            return
        result = asyncio.run(model_pool.artifact_registry_active8_bundle_promotion_controller(req))
        assert result.get('recovered_existing_commit') and result['readback_verified'], result
        assert result['serving_activation_verified'] is False
        from services.model_serving_resolver import _artifact_structure_block_reason
        legacy_model = next(row for row in tables['model_artifact_registry']
                            if row['model_name'] == 'DLinear' and row['state'] == 'production')
        assert _artifact_structure_block_reason(legacy_model, model_name='DLinear',
            artifact_role='direct_alpha') == 'artifact_extension_bin_expected_pt'
        assert 'nav_validation' not in result  # Never relabel a legacy adoption as NAV-qualified.
        assert state(db) == before and db.batches == 0
    finally:
        db.conn.close()


def test_new_nav_publication_still_requires_current_model_structure(bundle):
    db, rows, *_ = bundle
    row = next(item for item in rows if item['model_name'] == 'DLinear')
    row['artifact_path'] = 'test://immutable/not-loadable.bin'
    db.conn.execute('UPDATE model_artifact_registry SET artifact_path=? WHERE artifact_id=?',
                    (row['artifact_path'], row['artifact_id']))
    db.conn.commit()
    before = state(db)
    reviews = db.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id')
    result = publish(bundle)
    assert result['can_promote'] is False, result
    assert 'DLinear:artifact_extension_bin_expected_pt' in result['blockers']
    assert state(db) == before and db.batches == 0
    assert db.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id') == reviews
