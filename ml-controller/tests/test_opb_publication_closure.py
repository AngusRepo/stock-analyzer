"""Original registry SQL and isolated config transport; synthetic prior, NOT ROI."""
import asyncio
from copy import deepcopy
import sqlite3
import re
import json
from pathlib import Path

import pytest

from routers import opb_arm_prior as route
from services import model_artifact_registry as registry
from services import worker_config_client


@pytest.fixture
def publication(monkeypatch):
    artifact = {'artifact_id': 'opb_arm_prior:test', 'model_version': 'test',
        'expected_return_owner': 'l4_alpha_ev', 'trained_until': '2026-09-09',
        'generated_at': '2026-09-09T14:00:00+00:00',
        'validation': {'decision': 'PASS', 'failed_checks': []}, 'arm_priors': []}
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    schema = (Path(__file__).parents[2] / 'worker/domain-schemas/learning.sql').read_text(encoding='utf-8')
    table = re.search(r'CREATE TABLE IF NOT EXISTS model_artifact_registry \([\s\S]*?\n\);', schema)
    assert table, 'original registry schema must exist'
    db.executescript(table[0])
    def execute(sql, params, *_a, **_kw):
        db.execute(sql, params)
        return {'success': True}
    def query(sql, params, *_a, **_kw):
        return [dict(r) for r in db.execute(sql, params)]
    monkeypatch.setattr(registry.d1_client, 'execute', execute)
    monkeypatch.setattr(registry.d1_client, 'query', query)
    monkeypatch.setattr(route, 'load_opb_counterfactual_inputs', lambda **_kw: ([{}], [{}]))
    monkeypatch.setattr(route, 'build_opb_arm_prior_artifact', lambda *_a, **_kw: {'status': 'validated', 'artifact': deepcopy(artifact)})
    state, calls = {}, []
    async def fetch(path, **kw):
        calls.append((path, kw))
        if kw.get('method') == 'PUT':
            state.update(deepcopy(kw['json_body']))
            return {'success': True, 'config': deepcopy(state)}
        return deepcopy(state)
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    request = route.OpbArmPriorRefreshReq(end_date='2026-09-09', expected_return_owner='l4_alpha_ev',
        promote=True, dry_run=False)
    yield artifact, db, state, calls, request
    db.close()


def test_original_registry_readback_without_config_publication(publication):
    artifact, db, state, calls, request = publication
    result = asyncio.run(route.refresh_opb_arm_prior(request))
    assert not result['promoted'] and result['registry_verified'] and not result['config_projection_verified']
    assert calls == [] and state == {}
    assert db.execute('SELECT state FROM model_artifact_registry').fetchone()[0] == 'offline_passed'
    assert result['artifact_checksum'] == route._checksum(artifact)


def test_registry_ack_without_original_row_cannot_complete(publication, monkeypatch):
    _, _, state, calls, request = publication
    monkeypatch.setattr(registry.d1_client, 'execute', lambda *_a, **_kw: {'success': True})
    result = asyncio.run(route.refresh_opb_arm_prior(request))
    assert result['registry_verified'] is False and result['registry_error']
    assert result['status'] == 'registration_incomplete'
    assert calls == [] and state == {}  # registration must precede config writes


def test_first_registry_receipt_exists_before_any_publication(publication, monkeypatch):
    artifact, db, _, _, request = publication
    async def fetch(path, **kw):
        row = dict(db.execute('SELECT * FROM model_artifact_registry').fetchone())
        assert row['checksum'] == route._checksum(artifact)
        assert row['state'] == 'offline_passed'
        raise RuntimeError('fixture_no_publication_authority')
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    result = asyncio.run(route.refresh_opb_arm_prior(request))
    assert result['registry_verified'] and not result['promoted']
    assert result['promotion_error'] is None
    assert dict(db.execute('SELECT * FROM model_artifact_registry').fetchone())['checksum'] == route._checksum(artifact)


def test_retry_uses_first_sealed_time_and_does_not_downgrade_production(publication, monkeypatch):
    artifact, db, _, calls, request = publication
    assert asyncio.run(route.refresh_opb_arm_prior(request))['registry_verified']
    db.execute("UPDATE model_artifact_registry SET state='production'")
    before = dict(db.execute('SELECT * FROM model_artifact_registry').fetchone())
    artifact['generated_at'] = '2026-09-10T01:00:00+00:00'
    calls.clear()
    async def denied(*args, **kw):
        raise RuntimeError('fixture_transport_down')
    monkeypatch.setattr(worker_config_client, 'worker_fetch', denied)
    result = asyncio.run(route.refresh_opb_arm_prior(request))
    assert result['artifact']['generated_at'] == '2026-09-09T14:00:00+00:00'
    assert dict(db.execute('SELECT * FROM model_artifact_registry').fetchone()) == before
    assert result['status'] == 'candidate_registered' and not result['promoted']


@pytest.mark.parametrize('field,value', [('trained_until', '2026-09-08'),
    ('arm_priors', [{'arm_id': 'different'}]), ('expected_return_owner', 'allocator_ev_fusion')])
def test_same_id_different_evidence_is_rejected_without_rewriting(publication, field, value):
    artifact, db, _, calls, request = publication
    assert asyncio.run(route.refresh_opb_arm_prior(request))['registry_verified']
    before = dict(db.execute('SELECT * FROM model_artifact_registry').fetchone())
    calls.clear()
    artifact[field] = value
    try:
        result = asyncio.run(route.refresh_opb_arm_prior(request))
        assert result['status'] == 'registration_incomplete' and not result['registry_verified']
    except ValueError:
        pass  # request identity mismatch is also rejected before publication
    assert calls == []
    assert dict(db.execute('SELECT * FROM model_artifact_registry').fetchone()) == before


def test_archived_prior_cannot_be_revived_by_refresh(publication):
    _, db, _, calls, request = publication
    assert asyncio.run(route.refresh_opb_arm_prior(request))['registry_verified']
    db.execute("UPDATE model_artifact_registry SET state='archived'")
    before = dict(db.execute('SELECT * FROM model_artifact_registry').fetchone())
    calls.clear()
    result = asyncio.run(route.refresh_opb_arm_prior(request))
    assert not result['promoted'] and calls == []
    assert dict(db.execute('SELECT * FROM model_artifact_registry').fetchone()) == before


@pytest.mark.parametrize('stamp', [None, '', '2026-09-09T14:00:00', '2099-09-09T14:00:00+00:00'])
def test_unavailable_generation_time_never_reaches_storage_or_config(publication, stamp):
    artifact, db, _, calls, request = publication
    artifact['generated_at'] = stamp
    result = asyncio.run(route.refresh_opb_arm_prior(request))
    assert result['registry_error'] == 'opb_artifact_generation_time_invalid'
    assert not result['promoted'] and not calls
    assert db.execute('SELECT count(*) FROM model_artifact_registry').fetchone()[0] == 0


@pytest.mark.parametrize('different_content', [False, True])
def test_competing_first_writer_is_read_back_without_overwrite(publication, monkeypatch, different_content):
    artifact, db, _, calls, request = publication
    winner = deepcopy(artifact)
    winner['generated_at'] = '2026-09-09T13:00:00+00:00'
    if different_content:
        winner['arm_priors'] = [{'arm_id': 'another'}]
    def concurrent_insert(record, **kw):
        assert kw == {'immutable_identity': True}
        registry.upsert_artifact_record(route._registry_record(winner, promoted=False, promotion_error=None),
                                        immutable_identity=True)
        raise TimeoutError('fixture_lost_ack_after_competing_first_writer')
    monkeypatch.setattr(route, 'upsert_artifact_record', concurrent_insert)
    result = asyncio.run(route.refresh_opb_arm_prior(request))
    stored = dict(db.execute('SELECT * FROM model_artifact_registry').fetchone())
    assert json.loads(stored['offline_evidence_json']) == winner
    assert stored['checksum'] == route._checksum(winner)
    if different_content:
        assert not result['promoted'] and calls == []
        assert result['registry_error'] == 'opb_registry_immutable_identity_conflict'
    else:
        assert result['registry_verified'] and not result['promoted'] and result['artifact'] == winner


def test_successful_recovery_does_not_replace_original_production_receipt(publication):
    artifact, db, _, _, request = publication
    assert asyncio.run(route.refresh_opb_arm_prior(request))['registry_verified']
    db.execute("UPDATE model_artifact_registry SET state='production',live_evidence_json=?",
               [json.dumps({'original_adoption_receipt': 'sealed'})])
    before = dict(db.execute('SELECT * FROM model_artifact_registry').fetchone())
    artifact['generated_at'] = '2026-09-10T01:00:00+00:00'
    assert asyncio.run(route.refresh_opb_arm_prior(request))['registry_verified']
    assert dict(db.execute('SELECT * FROM model_artifact_registry').fetchone()) == before


@pytest.mark.parametrize('field,value', [('checksum', '0' * 64),
    ('model_name', 'another_owner'), ('version', 'wrong-version'),
    ('offline_evidence_json', '{"corrupt":true}')])
def test_corrupt_stored_identity_is_not_silently_repaired(publication, field, value):
    _, db, _, calls, request = publication
    assert asyncio.run(route.refresh_opb_arm_prior(request))['registry_verified']
    db.execute(f'UPDATE model_artifact_registry SET {field}=?', [value])
    before = dict(db.execute('SELECT * FROM model_artifact_registry').fetchone())
    calls.clear()
    result = asyncio.run(route.refresh_opb_arm_prior(request))
    assert not result['registry_verified'] and not calls
    assert dict(db.execute('SELECT * FROM model_artifact_registry').fetchone()) == before


def test_archive_after_registration_cannot_be_overwritten_by_refresh(publication, monkeypatch):
    artifact, db, config, calls, request = publication
    original = route._seal_prior_before_publication
    def concurrent_archive(*args, **kw):
        result = original(*args, **kw)
        db.execute("UPDATE model_artifact_registry SET state='archived'")
        return result
    monkeypatch.setattr(route, '_seal_prior_before_publication', concurrent_archive)
    result = asyncio.run(route.refresh_opb_arm_prior(request))
    assert result['status'] == 'candidate_registered' and result['registry_verified']
    stored = dict(db.execute('SELECT * FROM model_artifact_registry').fetchone())
    assert stored['state'] == 'archived'
    assert json.loads(stored['offline_evidence_json']) == artifact
    # Daily selection re-reads lifecycle; registration grants no authority.
    assert not result['config_projection_verified'] and not result['promoted']
    assert config == {} and calls == []


@pytest.mark.parametrize('mode', ['empty_ack', 'missing_projection', 'stale_readback', 'denied'])
def test_config_failure_is_not_a_promoted_prior(publication, monkeypatch, mode):
    artifact, _db, _state, _calls, request = publication
    async def fetch(_path, **kw):
        if mode == 'denied':
            raise RuntimeError('config_put_requires_promotion_packet_or_override')
        if kw.get('method') == 'PUT':
            if mode == 'empty_ack':
                return {'ok': True}
            config = {'alphaFramework': {'allocation': {'opbArmPrior': artifact}}} if mode == 'stale_readback' else {}
            return {'success': True, 'config': config}
        return {}
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    result = asyncio.run(route.refresh_opb_arm_prior(request))
    assert not result['promoted'] and result['promotion_error'] is None
    assert result['config_projection_verified'] is False
    assert result['status'] == 'candidate_registered'


@pytest.mark.parametrize('alias', ['opbArmPrior', 'opb_arm_prior'])
def test_real_worker_normalization_reaches_actual_python_prior_resolver(alias):
    import json
    from pathlib import Path
    import subprocess
    from services.alpha_framework import normalize_alpha_policy
    from services.online_portfolio_bandit import DEFAULT_ARMS, resolve_portfolio_bandit_arms
    from services.opb_counterfactual_prior import EXPECTED_RETURN_CONTRACTS, EXPECTED_RETURN_SEMANTICS
    owner = 'l4_alpha_ev'
    artifact = {'artifact_id': 'opb_arm_prior:isolated', 'model_version': 'isolated',
        'expected_return_owner': owner, 'source_expected_return_contract_version': EXPECTED_RETURN_CONTRACTS[owner],
        'source_expected_return_semantic': EXPECTED_RETURN_SEMANTICS[owner], 'validation': {'decision': 'PASS'},
        'arm_priors': [{'arm_id': arm.arm_id, 'prior_reward_mean': .012, 'prior_samples': 6} for arm in DEFAULT_ARMS]}
    script = """const {mergeAlphaFrameworkConfig}=require('./src/lib/tradingConfig.ts');
const raw=require('node:fs').readFileSync(0,'utf8');
process.stdout.write(JSON.stringify(mergeAlphaFrameworkConfig(JSON.parse(raw))));"""
    proc = subprocess.run(['node', '--import', 'tsx', '-e', script],
        input=json.dumps({'allocation': {alias: artifact}}), text=True, capture_output=True,
        encoding='utf-8', timeout=30, cwd=Path(__file__).parents[2] / 'worker')
    assert proc.returncode == 0, proc.stderr
    normalized = normalize_alpha_policy(json.loads(proc.stdout))
    arms, evidence = resolve_portfolio_bandit_arms(normalized['allocation']['opb_arm_prior'],
        expected_return_owner=owner, expected_return_contract_version=EXPECTED_RETURN_CONTRACTS[owner],
        expected_return_semantic=EXPECTED_RETURN_SEMANTICS[owner])
    assert evidence['status'] == 'artifact_loaded'
    assert all(arm.prior_reward_mean == pytest.approx(.012) for arm in arms)
    # Transporting a prior is NOT approval to activate unvalidated control.
    assert evidence['production_control_ready'] is False
