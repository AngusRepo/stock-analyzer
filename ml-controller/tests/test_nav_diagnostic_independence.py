"""Actual original NAV reader + SQL writeback; diagnostic failures are not efficacy."""
import json

import pytest

from services import expected_return_candidate_forward_evaluator as evaluator
from services import paired_nav_daily_review as daily
from test_paired_nav_lifecycle import environment, stamp
from test_paired_nav_review_store import migrate, two_sessions
from test_paired_nav_daily_review import local_policy


@pytest.fixture
def original_nav(environment, monkeypatch, local_policy):
    db, bucket, *_ = environment
    migrate(db)
    two_sessions(environment, monkeypatch)
    assert not daily.run_daily_nav_reviews(business_date='2026-09-09', query=db.query,
        writer=db.writer, now=stamp('2026-09-09'))['failures']
    def query(sql, params):
        if 'MIN(signal_date)' in sql:
            return [{'selection_semantic_floor_date': '2026-08-25'}]
        if 'expected_return_candidate_preoutcome_evaluations' in sql:
            return []
        return db.query(sql, params)
    def evaluate(**overrides):
        return evaluator.evaluate_expected_return_candidates_forward(**{
            'bucket': bucket, 'cohort_id': 'cohort', 'business_date': '2026-09-09',
            'extension_manifest_checksum': 'e' * 64, 'snapshot_rows': [],
            'build_fusion_rows_fn': lambda *_a, **_kw: [], 'query_fn': query,
            'batch_fn': lambda statements, **_kw: db.writer(statements), **overrides})
    return db, query, evaluate


@pytest.mark.parametrize('stage', ['source', 'samples', 'fusion', 'persist', 'stored', 'legacy_gate'])
def test_diagnostic_failure_preserves_original_nav_and_truthful_retry(original_nav, monkeypatch, stage):
    db, query, evaluate = original_nav
    original = evaluate()
    journals = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', [])
    def fail(*_a, **_kw):
        raise RuntimeError('private diagnostic URL https://example.invalid?token=secret')
    args = {'snapshot_rows': [{'fold_id': 'frozen_forward', 'snapshot_date': '2026-09-08',
        'label_known_date': '2026-09-09'}]}
    target = {'source': '_selection_semantic_floor_date', 'samples': '_l4_samples',
        'persist': '_persist_evaluations', 'stored': '_stored_evaluations', 'legacy_gate': '_promotion_gate'}
    with monkeypatch.context() as patch:
        if stage == 'fusion':
            args['build_fusion_rows_fn'] = fail
        else:
            patch.setattr(evaluator, target[stage], fail)
        result = evaluate(**args)
    assert result['status'] == 'evaluated_with_diagnostic_failures'
    assert result['diagnostic_failures'] and result['diagnostics_retry_required'] is True
    assert 'secret' not in json.dumps(result)
    for owner, gate in result['gates'].items():
        assert gate['nav_validation'] == original['gates'][owner]['nav_validation']
        assert gate['decision'] == original['gates'][owner]['decision']
        assert gate['cross_section_diagnostic']['status'] == 'failed'
        row = db.query('SELECT live_evidence_json FROM model_artifact_registry WHERE model_name=?', [owner])[0]
        assert json.loads(row['live_evidence_json']) == gate
    recovered = evaluate()
    assert recovered['status'] == 'evaluated' and not recovered.get('diagnostic_failures')
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', []) == journals


def test_nav_source_failure_is_not_converted_to_a_diagnostic_warning(original_nav):
    _db, query, evaluate = original_nav
    def unavailable(sql, params):
        if 'paired_nav_review_records_v1' in sql:
            raise RuntimeError('fixture_original_nav_storage_failed')
        return query(sql, params)
    with pytest.raises(RuntimeError, match='fixture_original_nav_storage_failed'):
        evaluate(query_fn=unavailable)


def test_attempted_parity_failure_never_falls_back_to_packet_pass(original_nav, monkeypatch):
    from services import ev_operational_parity
    _db, _query, evaluate = original_nav
    def broken(**_kwargs):
        raise ValueError('fixture_operational_parity_failed')
    monkeypatch.setattr(ev_operational_parity, 'assess_ev_operational_parity', broken)
    result = evaluate(native_rows=[{}], snapshot_rows=[{'fold_id': 'frozen_forward',
        'snapshot_date': '2026-09-08', 'label_known_date': '2026-09-09'}])
    assert result['status'] == 'evaluated_with_diagnostic_failures'
    assert not result['promotion_ready']
    assert all(g['decision'] == 'FAIL' and 'owner_operational_parity_not_pass' in g['contract_blockers']
               for g in result['gates'].values())


def test_nonfinite_diagnostic_cannot_poison_original_nav_writeback(original_nav, monkeypatch):
    _db, _query, evaluate = original_nav
    monkeypatch.setattr(evaluator, '_promotion_gate', lambda *_a, **_kw: {'metric': float('nan')})
    result = evaluate()
    assert result['status'] == 'evaluated_with_diagnostic_failures'
    json.dumps(result, allow_nan=False)
    assert all(g['cross_section_diagnostic']['status'] == 'failed' for g in result['gates'].values())


def test_main_gate_write_failure_still_fails_the_evaluation(original_nav):
    _db, _query, evaluate = original_nav
    with pytest.raises(RuntimeError, match='gate_state_write_incomplete'):
        evaluate(batch_fn=lambda *_a, **_kw: {'success_count': 0, 'error_count': 1})
