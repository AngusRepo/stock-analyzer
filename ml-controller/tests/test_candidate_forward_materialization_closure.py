"""Exercise the real materializer SQL, including partial commit and retry."""
import json
import sqlite3
from pathlib import Path

import pytest

from services.expected_return_candidate_forward_evaluator import (
    _complete_write, _persist_evaluations, _persist_candidate_gate_state,
    _promotion_gate, _verify_evaluation_readback, _stored_evaluations,
)
from test_expected_return_candidate_forward_evaluator import _candidate


@pytest.fixture
def store():
    connection = sqlite3.connect(':memory:')
    connection.row_factory = sqlite3.Row
    root = Path(__file__).resolve().parents[2]
    connection.executescript((root / 'worker/domain-migrations/learning/0038_expected_return_candidate_preoutcome_evaluations.sql').read_text())
    for name in ('0040_paired_nav_shadow_journal.sql', '0044_paired_nav_review_records.sql'):
        connection.executescript((root / 'worker/domain-migrations/learning' / name).read_text())
    registry_sql = (root / 'worker/domain-migrations/learning/0010_expected_return_candidate_registry_identity_v3.sql').read_text()
    start = registry_sql.index('CREATE TABLE model_artifact_registry (')
    connection.executescript(registry_sql[start:registry_sql.index('\n);', start) + 3])
    registry, raw = _candidate('l4_alpha_ev')
    packet = json.loads(raw)
    candidate = {'registry': registry, 'packet': packet, 'artifact': packet['artifact'],
                 'identity': {'model_fingerprint': packet['artifact']['model_fingerprint']},
                 'checksum': registry['checksum'], 'selection_semantic_floor_date': '2026-08-25'}
    connection.execute('INSERT INTO model_artifact_registry(artifact_id,model_name,version,candidate_type,state,checksum) VALUES(?,?,?,?,?,?)',
                       [registry['artifact_id'], 'l4_alpha_ev', registry['version'], 'l4_alpha_ev_refresh', registry['state'], registry['checksum']])

    def query(sql, params):
        return [dict(row) for row in connection.execute(sql, params)]

    def batch(statements, **_kwargs):
        changes = 0
        for sql, params in statements:
            changes += connection.execute(sql, params).rowcount
        connection.commit()
        return {'success_count': len(statements), 'error_count': 0, 'changes_total': changes}

    yield connection, candidate, query, batch
    connection.close()


def daily_rows():
    return [{'evaluation_id': f'eval-{i}', 'prediction_date': f'2026-08-{25+i}',
             'label_known_date': f'2026-09-0{i+1}', 'sample_count': 30,
             'prediction_corr': 0.2, 'baseline_corr': 0.1, 'corr_delta': 0.1,
             'spread': .01, 'baseline_spread': .005, 'spread_delta': .005,
             'top_return': .02, 'quality_decision': 'PASS'} for i in range(4)]


def test_existing_four_ev_dates_survive_no_new_rows_and_respect_asof(store):
    _conn, candidate, query, batch = store
    _persist_evaluations(daily_rows(), batch_fn=batch, owner='l4_alpha_ev', candidate=candidate,
        cohort_id='cohort-1', extension_manifest_checksum='e' * 64)
    stored = _stored_evaluations(query, candidate, '2026-09-07')
    assert len(stored) == 4
    assert _promotion_gate(stored, owner='l4_alpha_ev', candidate=candidate)['evaluable_date_count'] == 4
    assert len(_stored_evaluations(query, candidate, '2026-09-02')) == 2


def test_old_stored_corruption_is_not_trusted_when_no_new_rows(store):
    conn, candidate, query, batch = store
    _persist_evaluations(daily_rows(), batch_fn=batch, owner='l4_alpha_ev', candidate=candidate,
        cohort_id='cohort-1', extension_manifest_checksum='e' * 64)
    conn.execute('UPDATE expected_return_candidate_preoutcome_evaluations SET top_return=9 WHERE evaluation_id=?', ['eval-0'])
    with pytest.raises(RuntimeError, match='stored_scalar_json_mismatch'):
        _stored_evaluations(query, candidate, '2026-09-07')


def test_real_evaluator_preserves_diagnostic_dates_without_claiming_nav_maturity(store, monkeypatch):
    from services import expected_return_candidate_forward_evaluator as module
    _conn, candidate, query, batch = store
    _persist_evaluations(daily_rows(), batch_fn=batch, owner='l4_alpha_ev', candidate=candidate,
        cohort_id='cohort-1', extension_manifest_checksum='e' * 64)
    monkeypatch.setattr(module, '_candidate_rows', lambda *a, **k: ({'l4_alpha_ev': candidate['registry']}, {'l4_alpha_ev': False}))
    monkeypatch.setattr(module, '_load_candidate_packet', lambda *a: candidate)
    monkeypatch.setattr(module, '_selection_semantic_floor_date', lambda *a: '2026-08-25')
    result = module.evaluate_expected_return_candidates_forward(bucket=None, cohort_id='cohort-1',
        business_date='2026-09-07', extension_manifest_checksum='e' * 64, snapshot_rows=[], native_rows=[],
        build_fusion_rows_fn=lambda *a, **k: [], query_fn=query, batch_fn=batch)
    assert result['preoutcome_locked_rows'] == 0
    gate = result['gates']['l4_alpha_ev']
    assert gate['evaluable_date_count'] == 0
    assert gate['nav_validation']['reason'] == 'nav_candidate_not_registered'
    assert gate['cross_section_diagnostic']['evaluable_date_count'] == 4
    persisted = query('SELECT live_evidence_json FROM model_artifact_registry WHERE artifact_id=?', [candidate['registry']['artifact_id']])[0]
    assert json.loads(persisted['live_evidence_json']) == gate
    assert len(_stored_evaluations(query, candidate, '2026-09-07')) == 4
    assert result['promotion_ready'] is False


@pytest.mark.parametrize('ack', [{}, {'changes': 1},
    {'success_count': True, 'error_count': False},
    {'success_count': 0, 'error_count': 1},
    {'success_count': 1, 'error_count': 0, 'partial_failure': True},
    {'success_count': 1, 'error_count': 0, 'mode': 'allocator_contract_noop'}])
def test_no_ack_or_noop_is_not_materialization(ack):
    with pytest.raises(RuntimeError, match='write_incomplete'):
        _complete_write(ack, 1, 'test')


def test_partial_commit_retry_preserves_four_dates_and_repairs_exact_values(store):
    connection, candidate, query, batch = store
    rows = daily_rows()
    kwargs = dict(owner='l4_alpha_ev', candidate=candidate, cohort_id='cohort-1',
                  extension_manifest_checksum='e' * 64)

    def partial(statements, **_kwargs):
        batch(statements[:1])
        return {'success_count': 1, 'error_count': 3, 'partial_failure': True}

    with pytest.raises(RuntimeError, match='evaluations_write_incomplete'):
        _persist_evaluations(rows, batch_fn=partial, **kwargs)
    assert query('SELECT COUNT(*) AS n FROM expected_return_candidate_preoutcome_evaluations', [])[0]['n'] == 1
    # Retry the same immutable candidate/date keys; never add duplicate maturity.
    for _ in range(2):
        _persist_evaluations(rows, batch_fn=batch, **kwargs)
    stored = query('SELECT * FROM expected_return_candidate_preoutcome_evaluations ORDER BY prediction_date', [])
    assert len(stored) == 4
    _verify_evaluation_readback(rows, stored, candidate=candidate, extension_manifest_checksum='e'*64)
    assert _promotion_gate(stored, owner='l4_alpha_ev', candidate=candidate)['decision'] == 'PENDING'
    connection.execute('UPDATE expected_return_candidate_preoutcome_evaluations SET top_return=9 WHERE evaluation_id=?', ['eval-0'])
    corrupted = query('SELECT * FROM expected_return_candidate_preoutcome_evaluations', [])
    with pytest.raises(RuntimeError, match='readback_mismatch'):
        _verify_evaluation_readback(rows, corrupted, candidate=candidate, extension_manifest_checksum='e'*64)
    _persist_evaluations(rows, batch_fn=batch, **kwargs)
    _verify_evaluation_readback(rows, query('SELECT * FROM expected_return_candidate_preoutcome_evaluations', []),
                                candidate=candidate, extension_manifest_checksum='e'*64)


def test_missing_and_mixed_manifest_readback_never_reaches_gate(store):
    _conn, candidate, _query, _batch = store
    rows = daily_rows()
    with pytest.raises(RuntimeError, match='readback_missing'):
        _verify_evaluation_readback(rows, [], candidate=candidate, extension_manifest_checksum='e'*64)
    stored = [{**r, 'candidate_artifact_checksum': candidate['checksum'],
               'extension_manifest_checksum': 'd'*64} for r in rows]
    with pytest.raises(RuntimeError, match='readback_mismatch'):
        _verify_evaluation_readback(rows, stored, candidate=candidate, extension_manifest_checksum='e'*64)


def test_gate_state_is_read_back_and_cannot_overwrite_concurrent_production(store):
    connection, candidate, query, batch = store
    gate = _promotion_gate(daily_rows(), owner='l4_alpha_ev', candidate=candidate)
    kwargs = dict(candidates={'l4_alpha_ev': candidate}, gates={'l4_alpha_ev': gate},
                  activate={'l4_alpha_ev': True}, batch_fn=batch, query_fn=query)
    _persist_candidate_gate_state(**kwargs)
    assert query('SELECT state FROM model_artifact_registry', [])[0]['state'] == 'shadowing'
    connection.execute("UPDATE model_artifact_registry SET state='production'")
    with pytest.raises(RuntimeError, match='gate_state_readback_mismatch'):
        _persist_candidate_gate_state(**kwargs)
    assert query('SELECT state FROM model_artifact_registry', [])[0]['state'] == 'production'


@pytest.mark.parametrize('invalid', [None, True, float('nan'), float('inf')])
def test_missing_or_nonfinite_date_cannot_be_dropped_to_improve_test(store, invalid):
    _conn, candidate, _query, _batch = store
    rows = daily_rows()
    rows[0]['spread_delta'] = invalid
    result = _promotion_gate(rows, owner='l4_alpha_ev', candidate=candidate)
    assert result['decision'] == 'FAIL'
    assert 'prospective_nonfinite_or_missing_paired_metrics' in result['contract_blockers']
    json.dumps(result, allow_nan=False)


def test_duplicate_dates_are_not_additional_maturity(store):
    _conn, candidate, _query, _batch = store
    result = _promotion_gate(daily_rows() * 3, owner='l4_alpha_ev', candidate=candidate)
    assert result['decision'] == 'FAIL'
    assert 'prospective_duplicate_prediction_dates' in result['contract_blockers']
    assert result['evaluable_date_count'] == 4
