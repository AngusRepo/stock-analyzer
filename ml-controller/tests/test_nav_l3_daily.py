"""Original L3 frozen admission -> shared NAV reader -> actual daily callback.

Fixed synthetic artifacts; no training, production writes or ROI claims.
"""
from copy import deepcopy
from types import SimpleNamespace

import pytest

from services import paired_nav_l3_daily as l3
from services.paired_nav_journal import read_snapshot
from test_paired_nav_candidate_collection import environment
from test_paired_nav_l3_candidate import prepared, seal, DAY, NOW
from test_paired_nav_review_store import migrate


def run(db, candidates=None):
    return l3.refresh_registered_l3_nav_decisions(business_date=DAY, query=db.query, now=NOW,
        adoption_candidates=candidates)


def test_frozen_admission_is_counted_before_execution_without_new_registry_or_review_writes(prepared):
    db, *_ = prepared
    migrate(db)
    seal(prepared)
    changes, candidates = db.conn.total_changes, []
    first = run(db, candidates)
    assert first['candidate_count'] == first['evaluated_count'] == 1
    assert first['failure_count'] == 0 and first['registry_state_unchanged']
    assert first['decisions'][0]['decision'] == 'PENDING'
    assert first['decisions'][0]['evaluable_date_count'] == 0
    assert first['promotion_allowed'] is False and candidates[0]['owner'] == 'ensemble'
    assert candidates[0]['payload']['prospective_validation']['nav_validation']['reason'] == 'nav_candidate_not_registered'
    assert run(db) == first and db.conn.total_changes == changes


@pytest.mark.parametrize('state,effect', [('archived', 0), ('rejected', 0), ('production', 1)])
def test_mutable_lifecycle_does_not_erase_original_nav_candidate(prepared, state, effect):
    db, *_ = prepared
    migrate(db)
    seal(prepared)
    db.conn.execute('UPDATE active8_ensemble_artifacts_v1 SET state=?,production_effect=?', [state, effect])
    candidates = []
    result = run(db, candidates)
    assert result['candidate_count'] == result['evaluated_count'] == 1
    assert result['decisions'][0]['registry_state'] == state
    assert len(candidates) == int(state == 'production')
    assert not db.query('SELECT * FROM active8_ensemble_pointer_v1', [])


def test_missing_live_candidate_is_a_failure_not_a_smaller_denominator(prepared):
    db, *_ = prepared
    migrate(db)
    seal(prepared)
    db.conn.execute('DELETE FROM active8_ensemble_artifacts_v1')  # private in-memory fixture only
    result = run(db)
    assert result['candidate_count'] == result['failure_count'] == 1
    assert result['evaluated_count'] == 0
    assert result['failures'][0]['reason'] == 'nav_l3_registry_missing_or_ambiguous'


def test_original_daily_job_reports_l3_without_requiring_oof_or_new_model_fit(prepared, monkeypatch):
    import oof_materialize_job_main as job
    from services import d1_domain_client, walk_forward_retrain
    db, bucket, *_ = prepared
    migrate(db)
    seal(prepared)
    client = SimpleNamespace(query=db.query, batch_execute=db.writer, atomic_batch_execute=db.writer)
    monkeypatch.setattr(d1_domain_client, 'client_for_domain', lambda *_: client)
    monkeypatch.setattr(walk_forward_retrain, '_get_bucket', lambda: bucket)
    result = job._execute_daily_nav(end_date=DAY, now=NOW)
    assert result['l3_candidate_decisions']['candidate_count'] == 1
    assert result['l3_candidate_decisions']['evaluated_count'] == 1
    assert result['l3_candidate_decisions']['decisions'][0]['decision'] == 'PENDING'
    assert any(c['owner'] == 'ensemble' for c in result['_adoption_candidates'])
    callback = job._nav_callback_summary(result)
    assert callback['l3_candidate_decisions'] == result['l3_candidate_decisions']
    assert '_adoption_candidates' not in callback
    db.conn.execute('DELETE FROM active8_ensemble_artifacts_v1')
    failed = job._execute_daily_nav(end_date=DAY, now=NOW)
    assert failed['status'] == 'failed'
    assert failed['l3_candidate_decisions']['candidate_count'] == 1
    assert failed['l3_candidate_decisions']['failure_count'] == 1
    assert failed['candidate_decisions']['evaluated_count'] == result['candidate_decisions']['evaluated_count']
