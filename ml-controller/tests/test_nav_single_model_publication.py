"""A single base hotfix is not authority to split a committed ensemble."""
import asyncio
import base64
import hashlib
import json
from pathlib import Path
import zlib

import pytest

from nav_bundle_sqlite import SQLiteBundle
from routers import model_pool
from services import model_artifact_registry as registry
from test_active8_bundle_transaction import state
from test_model_artifact_registry import PROMOTION_GRADE_OFFLINE_EVIDENCE, PROMOTION_GRADE_LIVE_EVIDENCE


@pytest.fixture
def legacy_hotfix(monkeypatch, request):
    model = getattr(request, 'param', 'LightGBM')
    snapshot = json.loads((Path(__file__).parent / 'fixtures/nav_legacy_bundle_commit.json').read_text(encoding='utf-8'))
    raw = zlib.decompress(base64.b64decode(snapshot['tables_zlib_base64']))
    assert hashlib.sha256(raw).hexdigest() == snapshot['decoded_sha256']
    tables = json.loads(raw)
    db = SQLiteBundle()
    for table in ('model_artifact_registry', 'model_champion_pointers', 'model_champion_history',
                  'active8_ensemble_artifacts_v1', 'active8_ensemble_pointer_v1'):
        for row in tables[table]:
            db.insert(table, row)
    original = next(row for row in tables['model_artifact_registry']
                    if row['model_name'] == model and row['state'] == 'production')
    candidate = {**original, 'artifact_id': f'{model}:hotfix:manual_hotfix',
        'version': 'hotfix', 'candidate_type': 'manual_hotfix', 'state': 'live_gate_passed',
        'artifact_path': 'test://LightGBM/hotfix.joblib', 'offline_gate_decision': 'STRONG_PASS',
        'live_gate_status': 'multi_evidence_passed', 'offline_evidence_json': PROMOTION_GRADE_OFFLINE_EVIDENCE,
        'live_evidence_json': PROMOTION_GRADE_LIVE_EVIDENCE}
    db.insert('model_artifact_registry', candidate)
    db.conn.commit()
    writes = []
    def execute(sql, params=None):
        writes.append(sql)
        db.conn.execute(sql, params or [])
        db.conn.commit()
        return {'success': True}
    monkeypatch.setattr(db, 'execute', execute, raising=False)
    monkeypatch.setattr(registry, 'd1_client', db)
    monkeypatch.setattr(model_pool, 'list_artifact_registry', lambda **kw: db.query('SELECT * FROM model_artifact_registry'))
    monkeypatch.setattr(model_pool, 'list_champion_pointers', lambda **kw: db.query('SELECT * FROM model_champion_pointers'))
    yield db, candidate, writes
    db.conn.close()


@pytest.mark.parametrize('confirm', [False, True])
def test_approved_hotfix_cannot_split_original_ensemble(legacy_hotfix, confirm):
    db, candidate, writes = legacy_hotfix
    before = state(db)
    result = asyncio.run(model_pool.artifact_registry_promotion_controller(
        model_pool.PromotionControllerRequest(artifact_id=candidate['artifact_id'], confirm=confirm,
            approved=True, approved_by='isolated-test', manual_override=True)))
    if confirm and result['can_promote']:
        # RED proves a real split via original SQL, not just a misleading preview.
        assert not result['errors'] and writes
        assert db.query("SELECT champion_artifact_id FROM model_champion_pointers WHERE model_name='LightGBM'")[0]['champion_artifact_id'] == candidate['artifact_id']
        assert state(db) != before
    assert result['can_promote'] is False, result
    assert result['decision'] == 'active8_single_model_requires_canonical_bundle', result
    assert not writes and state(db) == before


def test_hotfix_queue_does_not_offer_individual_approval(legacy_hotfix):
    db, candidate, _ = legacy_hotfix
    result = registry.build_promotion_queue(db.query('SELECT * FROM model_artifact_registry'),
        champion_versions={row['model_name']: row['champion_version']
                           for row in db.query('SELECT * FROM model_champion_pointers')})
    row = next(row for row in result['queue'] if row['artifact_id'] == candidate['artifact_id'])
    assert row['promotion_decision'] == 'active8_single_model_requires_canonical_bundle'
    assert row['approval_required'] is False
    assert row['publication_owner'] == 'daily_paired_nav'


@pytest.mark.parametrize('legacy_hotfix', sorted(registry.ACTIVE8_ARTIFACT_MODEL_NAMES), indirect=True)
@pytest.mark.parametrize('manual_override', [False, True])
def test_all_active8_bases_use_original_bundle_owner(legacy_hotfix, manual_override):
    db, candidate, writes = legacy_hotfix
    before = state(db)
    result = registry.run_promotion_controller(artifact_id=candidate['artifact_id'],
        registry_rows=db.query('SELECT * FROM model_artifact_registry'),
        d1_pointers=db.query('SELECT * FROM model_champion_pointers'),
        confirm=True, approved=True, manual_override=manual_override)
    assert result['decision'] == 'active8_single_model_requires_canonical_bundle'
    assert not result['can_promote'] and not writes and state(db) == before


def test_exact_current_hotfix_check_remains_read_only(legacy_hotfix):
    db, candidate, writes = legacy_hotfix
    pointer = next(row for row in db.query('SELECT * FROM model_champion_pointers')
                   if row['model_name'] == candidate['model_name'])
    # Historical fixture: this identity was already current, not a new adoption.
    db.conn.execute("UPDATE model_artifact_registry SET candidate_type='manual_hotfix' WHERE artifact_id=?",
                    [pointer['champion_artifact_id']])
    db.conn.commit()
    before = state(db)
    result = asyncio.run(model_pool.artifact_registry_promotion_controller(
        model_pool.PromotionControllerRequest(artifact_id=pointer['champion_artifact_id'], confirm=True)))
    assert result['status'] == 'already_promoted' and not result['can_promote']
    assert not writes and state(db) == before
