"""Actual daily job -> original NAV -> exact registry, before any OOF prep."""
import asyncio
import json

import pytest

import oof_materialize_job_main as job
from services import paired_nav_review_store as store
from test_nav_oof_job_independence import isolated_job
from test_paired_nav_lifecycle import environment
from test_paired_nav_daily_review import local_policy


def written(db):
    return {row['model_name']: json.loads(row['live_evidence_json'])
        for row in db.query('SELECT model_name,live_evidence_json FROM model_artifact_registry '
                            'WHERE live_evidence_json IS NOT NULL', [])}


def test_prep_failure_cannot_starve_original_candidate_gate_writeback(isolated_job, monkeypatch):
    from services import active8_prep_lifecycle
    db, _, callbacks, _, routes = isolated_job
    async def fail(**_kw):
        assert len(written(db)) == 2, 'primary decisions must precede OOF prep'
        raise RuntimeError('fixture_prep_failed')
    monkeypatch.setattr(active8_prep_lifecycle, 'ensure_active8_daily_prep', fail)
    assert asyncio.run(job._run()) == 1
    assert not routes and callbacks[-1]['status'] == 'error'
    gates = written(db)
    assert set(gates) == {'l4_alpha_ev', 'allocator_ev_fusion'}
    assert all(g['nav_validation']['evaluable_date_count'] == 2 for g in gates.values())
    summary = callbacks[-1]['metadata']['paired_nav_maturity']['candidate_decisions']
    assert summary['status'] == 'nav_candidate_decisions_current'
    assert summary['evaluated_count'] == summary['candidate_count'] == 2
    assert summary['failure_count'] == 0


def test_newer_registry_noise_cannot_hide_frozen_candidates(isolated_job):
    db, _, callbacks, *_ = isolated_job
    # The old newest-80 query sees only unrelated unregistered candidates.
    for index in range(90):
        db.conn.execute('INSERT INTO model_artifact_registry '
            '(artifact_id,model_name,state,source_run_date,updated_at,candidate_type) VALUES(?,?,?,?,?,?)',
            (f'noise-{index}', 'l4_alpha_ev', 'shadowing', '2026-09-09',
             '2026-09-09', 'l4_alpha_ev_refresh'))
    assert asyncio.run(job._run()) == 0
    assert len(written(db)) == 2
    assert callbacks[-1]['metadata']['paired_nav_maturity']['candidate_decisions']['candidate_count'] == 2


@pytest.mark.parametrize('state', ['archived', 'production', 'retired'])
def test_daily_review_never_reactivates_or_rejects_serving_or_closed_registry(isolated_job, state):
    db, _, *_ = isolated_job
    db.conn.execute('UPDATE model_artifact_registry SET state=?', (state,))
    assert asyncio.run(job._run()) == 0
    assert len(written(db)) == 2
    assert {r['state'] for r in db.query('SELECT state FROM model_artifact_registry', [])} == {state}


def test_missing_registered_artifact_is_not_silently_dropped(isolated_job):
    db, _, callbacks, *_ = isolated_job
    db.conn.execute("DELETE FROM model_artifact_registry WHERE model_name='l4_alpha_ev'")
    assert asyncio.run(job._run()) == 0
    assert callbacks[-1]['status'] == 'triggered'
    nav = callbacks[-1]['metadata']['paired_nav_maturity']
    assert nav['accounting_status'] == 'up_to_date'
    summary = nav['candidate_decisions']
    assert summary['candidate_count'] == 2 and summary['failure_count'] == 1
    assert summary['evaluated_count'] == 1
    assert summary['failures'][0]['reason'] == 'nav_candidate_registry_missing_or_ambiguous'
    assert set(written(db)) == {'allocator_ev_fusion'}


def test_primary_write_failure_retries_without_rewriting_original_journals(isolated_job):
    db, client, callbacks, *_ = isolated_job
    before = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', [])
    def fail(statements, **_kw):
        if 'UPDATE model_artifact_registry' in statements[0][0]:
            raise RuntimeError('fixture_private_storage_error')
        return db.writer(statements)
    client.batch_execute = fail
    assert asyncio.run(job._run()) == 0
    assert callbacks[-1]['status'] == 'triggered'
    summary = callbacks[-1]['metadata']['paired_nav_maturity']['candidate_decisions']
    assert summary['failure_count'] == 2 and summary['evaluated_count'] == 0
    assert 'fixture_private' not in json.dumps(summary)
    headers = db.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', [])
    client.batch_execute = db.writer
    assert asyncio.run(job._run()) == 0
    assert callbacks[-1]['status'] == 'success'
    assert len(written(db)) == 2
    assert db.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', []) == headers
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', []) == before


def test_primary_does_not_read_oof_diagnostics_or_newest_candidate_query(isolated_job, monkeypatch):
    from services import expected_return_candidate_forward_evaluator as evaluator
    db, _, *_ = isolated_job
    def forbidden(*_a, **_kw):
        pytest.fail('OOF diagnostics and latest-N candidate query are not primary NAV dependencies')
    for name in ('_candidate_rows', '_selection_semantic_floor_date', '_stored_evaluations', '_promotion_gate'):
        monkeypatch.setattr(evaluator, name, forbidden)
    assert asyncio.run(job._run()) == 0
    assert len(written(db)) == 2


def test_primary_keeps_previously_observed_parity_failure(isolated_job):
    db, _, *_ = isolated_job
    assert asyncio.run(job._run()) == 0
    gates = written(db)
    gate = gates['l4_alpha_ev']
    gate['operational_parity'] = {'owner_decisions': {'l4_alpha_ev': {
        'decision': 'FAIL', 'failed_gates': ['operational_parity_evaluation_failed']}}}
    db.conn.execute("UPDATE model_artifact_registry SET live_evidence_json=? WHERE model_name='l4_alpha_ev'",
                    (json.dumps(gate),))
    assert asyncio.run(job._run()) == 0
    updated = written(db)['l4_alpha_ev']
    assert updated['decision'] == 'FAIL'
    assert 'owner_operational_parity_not_pass' in updated['contract_blockers']
    assert updated['nav_validation'] == gate['nav_validation']


@pytest.mark.parametrize('identity_matches', [True, False])
def test_nav_refresh_preserves_original_preoutcome_envelope_without_recounting_as_nav(isolated_job, identity_matches):
    db, _, *_ = isolated_job
    rows = db.query('SELECT * FROM model_artifact_registry', [])
    saved = {}
    for row in rows:
        # Migration/storage fixture, NOT evidence of returns or a promotable gate.
        diagnostic = {'schema_version': 'expected-return-candidate-forward-gate-v2',
            'candidate_artifact_id': row['artifact_id'],
            'candidate_artifact_checksum': row['checksum'] if identity_matches else 'other-candidate',
            'decision': 'PENDING', 'evaluable_date_count': 9,
            'prediction_date_max': '2026-09-04', 'evaluated_as_of_date': '2026-09-08'}
        saved[row['model_name']] = diagnostic
        db.conn.execute('UPDATE model_artifact_registry SET live_evidence_json=? WHERE artifact_id=?',
            (json.dumps(diagnostic), row['artifact_id']))
    for _ in range(2):
        assert asyncio.run(job._run()) == 0
        for owner, gate in written(db).items():
            if identity_matches:
                assert gate['cross_section_diagnostic'] == saved[owner]
            else:
                assert gate['cross_section_diagnostic']['status'] == 'not_run'
                assert 'evaluable_date_count' not in gate['cross_section_diagnostic']
            assert gate['nav_validation']['evaluable_date_count'] == 2
            assert gate['decision'] != 'PASS'


def test_concurrent_diagnostic_write_is_not_overwritten_by_primary_projection(isolated_job):
    db, client, callbacks, *_ = isolated_job
    concurrent = json.dumps({'diagnostic': 'newer concurrent receipt'})
    raced = []
    def writer(statements, **_kw):
        sql, params = statements[0]
        if 'UPDATE model_artifact_registry' in sql and not raced:
            raced.append(params[4])
            db.conn.execute('UPDATE model_artifact_registry SET live_evidence_json=? WHERE artifact_id=?',
                            (concurrent, params[4]))
        return db.writer(statements)
    client.batch_execute = writer
    assert asyncio.run(job._run()) == 0
    assert callbacks[-1]['status'] == 'triggered'
    summary = callbacks[-1]['metadata']['paired_nav_maturity']['candidate_decisions']
    assert summary['failure_count'] == 1 and summary['evaluated_count'] == 1
    assert db.query('SELECT live_evidence_json FROM model_artifact_registry WHERE artifact_id=?', raced)[0]['live_evidence_json'] == concurrent
    client.batch_execute = db.writer
    assert asyncio.run(job._run()) == 0
    assert callbacks[-1]['status'] == 'success'


def test_mutated_registry_metadata_cannot_relabel_frozen_candidate(isolated_job):
    db, _, callbacks, *_ = isolated_job
    db.conn.execute("UPDATE model_artifact_registry SET training_run_id='active8_oof:changed' WHERE model_name='l4_alpha_ev'")
    assert asyncio.run(job._run()) == 0
    summary = callbacks[-1]['metadata']['paired_nav_maturity']['candidate_decisions']
    assert summary['candidate_count'] == 2 and summary['failure_count'] == 1
    assert summary['failures'][0]['reason'] == 'nav_candidate_registry_identity_changed'
    assert set(written(db)) == {'allocator_ev_fusion'}


@pytest.mark.parametrize('state,live,promotion', [
    ('production', 'promoted', 'expected_return_owner_promoted'),
    ('archived', 'passed', 'replaced_by_expected_return_champion'),
    ('retired', 'retired', 'retired_by_policy'),
])
def test_daily_audit_preserves_existing_lifecycle_markers(isolated_job, state, live, promotion):
    db, _, *_ = isolated_job
    db.conn.execute('UPDATE model_artifact_registry SET state=?,live_gate_status=?,promotion_decision=?',
                    (state, live, promotion))
    assert asyncio.run(job._run()) == 0
    assert len(written(db)) == 2
    for row in db.query('SELECT state,live_gate_status,promotion_decision FROM model_artifact_registry', []):
        assert row == {'state': state, 'live_gate_status': live, 'promotion_decision': promotion}


def test_empty_frozen_inventory_does_not_fetch_a_bucket_or_require_a_candidate():
    from services.paired_nav_daily_candidates import refresh_registered_ev_nav_decisions
    from test_paired_nav_journal import DB
    from test_paired_nav_lifecycle import stamp
    db = DB(legacy_assessments=False)
    result = refresh_registered_ev_nav_decisions(business_date='2026-09-09', query=db.query,
        writer=lambda *_a: pytest.fail('no candidate means no projection write'),
        bucket_factory=lambda: pytest.fail('no candidate means no artifact fetch'), now=stamp('2026-09-09'))
    assert result['candidate_count'] == result['evaluated_count'] == result['failure_count'] == 0
    assert result['status'] == 'nav_candidate_decisions_current'
