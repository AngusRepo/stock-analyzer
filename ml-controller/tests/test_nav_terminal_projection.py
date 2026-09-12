"""Legacy diagnostic continuation cannot reopen a closed candidate lifecycle."""
import json
import sqlite3
import pytest
from services.expected_return_candidate_forward_evaluator import _persist_candidate_gate_state


@pytest.mark.parametrize('state,live,promotion', [
    ('rejected', 'failed', 'prospective_failed'),
    ('production', 'promoted', 'expected_return_owner_promoted'),
    ('archived', 'passed', 'replaced_by_expected_return_champion'),
    ('retired', 'retired', 'retired_by_policy'),
])
def test_secondary_pending_projection_cannot_reopen_lifecycle(state, live, promotion):
    run_projection(state, live, promotion, expect_state=state, expect_live=live, expect_promotion=promotion)


def test_old_offline_only_rejection_can_still_enter_observation():
    run_projection('rejected', 'not_started', None, expect_state='shadowing',
        expect_live='collecting_forward_evidence', expect_promotion='prospective_collecting')


@pytest.mark.parametrize('state,old_live,new_live', [
    ('rejected', 'not_started', 'failed'),
    ('shadowing', 'collecting_forward_evidence', 'passed'),
])
def test_stale_nonterminal_read_cannot_overwrite_concurrent_evidence(state, old_live, new_live):
    with sqlite3.connect(':memory:') as db:
        db.row_factory = sqlite3.Row
        db.execute('CREATE TABLE model_artifact_registry (artifact_id TEXT,checksum TEXT,state TEXT,'
            'live_gate_status TEXT,live_evidence_json TEXT,promotion_decision TEXT,updated_at TEXT)')
        db.execute('INSERT INTO model_artifact_registry VALUES(?,?,?,?,?,?,NULL)',
            ['candidate', 'a'*64, state, old_live, None, None])
        def query(sql, params): return [dict(row) for row in db.execute(sql, params)]
        stale = query('SELECT * FROM model_artifact_registry', [])[0]
        db.execute('UPDATE model_artifact_registry SET live_gate_status=?,live_evidence_json=?,promotion_decision=?',
            [new_live, '{"newer":true}', 'prospective_' + new_live])
        concurrent = query('SELECT * FROM model_artifact_registry', [])[0]
        def writer(statements, **kwargs):
            for sql, params in statements: db.execute(sql, params)
            return {'success_count': len(statements), 'error_count': 0}
        with pytest.raises(RuntimeError, match='candidate_forward_gate_state_readback_mismatch'):
            _persist_candidate_gate_state(candidates={'l4_alpha_ev': {'registry': stale, 'checksum': stale['checksum']}},
                gates={'l4_alpha_ev': {'decision': 'PENDING'}}, activate={'l4_alpha_ev': True},
                batch_fn=writer, query_fn=query)
        assert query('SELECT * FROM model_artifact_registry', [])[0] == concurrent


def run_projection(state, live, promotion, *, expect_state, expect_live, expect_promotion):
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.execute('CREATE TABLE model_artifact_registry (artifact_id TEXT,checksum TEXT,state TEXT,'
        'live_gate_status TEXT,live_evidence_json TEXT,promotion_decision TEXT,updated_at TEXT)')
    db.execute('INSERT INTO model_artifact_registry VALUES(?,?,?,?,?,?,NULL)',
        ['candidate', 'a'*64, state, live, None, promotion])
    def query(sql, params): return [dict(row) for row in db.execute(sql, params)]
    row = query('SELECT * FROM model_artifact_registry', [])[0]
    def writer(statements, **kwargs):
        for sql, params in statements: db.execute(sql, params)
        return {'success_count': len(statements), 'error_count': 0}
    _persist_candidate_gate_state(candidates={'l4_alpha_ev': {'registry': row, 'checksum': row['checksum']}},
        gates={'l4_alpha_ev': {'decision': 'PENDING'}}, activate={'l4_alpha_ev': True},
        batch_fn=writer, query_fn=query)
    result = query('SELECT * FROM model_artifact_registry', [])[0]
    assert result['state'] == expect_state
    assert result['live_gate_status'] == expect_live
    assert result['promotion_decision'] == expect_promotion
    assert json.loads(result['live_evidence_json']) == {'decision': 'PENDING'}
    db.close()
