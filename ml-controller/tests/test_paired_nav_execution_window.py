"""Expired comparisons cannot manufacture NAV or mask failed formal sources."""
from copy import deepcopy
from datetime import datetime
from functools import partial
import json

import pytest

from services import paired_nav_execution_window as window
from services.paired_nav_journal import freeze_snapshot, digest
from services.paired_nav_pipeline import complete_pipeline_shadow, pipeline_shadow_errors
from test_paired_nav_journal import DB
from test_paired_nav_execution_environment import environment_packet


def stamp(value):
    return datetime.fromisoformat(value)


@pytest.fixture
def source():
    db = DB(legacy_assessments=False)
    day = '2026-09-21'
    context = {'inputs': {'alpha_policy': {'l4Distribution': {}}},
        'recommendation_context': {'l3_candidate_selection': {
            'status': 'candidate_ensembles_frozen', 'signal_date': day,
            'decision_cutoff': day + 'T12:00:00+00:00'}},
        'capture': {'effective_weights': {'2330': .2}},
        'formal_output': [{'symbol': '2330', 'allocation_weight': .2}],
        'native_execution_environment': environment_packet(day=day)}
    saved = freeze_snapshot(signal_date=day, source_run_id='window-test',
        snapshot_kind='allocation_context', content=context, query=db.query, writer=db.writer,
        now=stamp(day + 'T22:00:00+00:00'))
    collection = {'status': 'allocation_context_frozen', 'snapshot_id': saved['snapshot_id'],
        'nav_maturity_credit': 0}
    calendar = {'schemaVersion': 'twse-holiday-schedule-v2',
        'source': 'twse.openapi.holidaySchedule', 'dates': [],
        'loadedAt': day + 'T10:00:00Z'}
    def read(key):
        return json.dumps(calendar) if key.endswith(':2026') else None
    return db, collection, calendar, read


@pytest.mark.parametrize('time,missed', [('07:14:59', False), ('07:15:00', True), ('08:00:00', True), ('10:00:00', True)])
def test_original_first_phase_boundary_and_zero_authority(source, time, missed):
    db, collection, _, read = source
    before = db.query('SELECT * FROM paired_nav_frozen_manifests_v1', [])
    result = window.missed_setup_window(collection, query=db.query, kv_read=read,
        now=stamp('2026-09-22T' + time + '+08:00'))
    assert (result is not None) is missed
    assert db.query('SELECT * FROM paired_nav_frozen_manifests_v1', []) == before
    if missed:
        assert window.valid_missed_window(result)
        assert pipeline_shadow_errors(result) == []
        assert result['nav_maturity_credit'] == 0
        assert result['promotion_allowed'] is False and result['can_write_order'] is False
        assert result['execution_evidence_status'] == 'not_observed'
        assert 'native_execution' not in result and 'candidate_allocations' not in result
    assert collection['status'] == 'allocation_context_frozen'


def test_official_holiday_uses_next_trading_session(source):
    db, collection, calendar, read = source
    calendar['dates'] = ['2026-09-22']
    assert window.missed_setup_window(collection, query=db.query, kv_read=read,
        now=stamp('2026-09-22T08:00:00+08:00')) is None


def test_calendar_failure_remains_blocking(source):
    db, collection, _, _ = source
    with pytest.raises(ValueError, match='official_calendar_missing'):
        window.missed_setup_window(collection, query=db.query, kv_read=lambda key: None,
            now=stamp('2026-09-22T08:00:00+08:00'))


@pytest.mark.parametrize('mutation', [
    {'status': 'failed', 'stage': 'allocation_context_seal', 'reason': 'paired_nav_corrupt'},
    {'owner_failures': {'ensemble': {'stage': 'candidate_allocations', 'reason': 'paired_nav_invalid_model'}}}])
def test_failed_sources_are_not_reclassified(source, mutation):
    _, collection, _, _ = source
    collection.update(mutation)
    assert window.missed_setup_window(collection,
        query=lambda *args: pytest.fail('failed source must not be reclassified')) is None
    assert pipeline_shadow_errors(collection)


def test_real_setup_skips_only_unobservable_work_and_preserves_frozen_input(source, monkeypatch):
    db, collection, _, read = source
    original = window.missed_setup_window
    monkeypatch.setattr(window, 'missed_setup_window', partial(original,
        kv_read=read, now=stamp('2026-09-22T08:00:00+08:00')))
    result = complete_pipeline_shadow(collection, query=db.query,
        writer=lambda *args, **kwargs: pytest.fail('late setup must not write comparisons'),
        enforce_execution_window=True)
    assert pipeline_shadow_errors(result) == []
    assert result['status'] == 'missed_execution_window'
    failed = {**result, 'atomic_daily': {'status': 'failed', 'reason': 'paired_nav_actual_source_failure'}}
    assert pipeline_shadow_errors(failed) == ['paired_nav:atomic_daily:paired_nav_actual_source_failure']


@pytest.mark.parametrize('field,value', [('nav_maturity_credit', 1), ('promotion_allowed', True),
    ('can_write_order', True), ('execution_evidence_status', 'native_execution_pairs_registered')])
def test_receipt_cannot_grant_execution_or_maturity(source, field, value):
    db, collection, _, read = source
    result = window.missed_setup_window(collection, query=db.query, kv_read=read,
        now=stamp('2026-09-22T08:00:00+08:00'))
    result[field] = value
    assert pipeline_shadow_errors(result) == ['paired_nav:invalid_missed_execution_window']


def test_rehashed_false_deadline_still_rejected(source):
    db, collection, _, read = source
    result = window.missed_setup_window(collection, query=db.query, kv_read=read,
        now=stamp('2026-09-22T08:00:00+08:00'))
    receipt = result['execution_window']
    receipt['first_phase_at'] = '2026-09-22T06:00:00+08:00'
    receipt['checksum'] = digest({k:v for k,v in receipt.items() if k != 'checksum'})
    assert not window.valid_missed_window(result)


def test_timely_setup_uses_original_complete_comparison_path(source, monkeypatch):
    from services import paired_nav_pipeline as pipeline
    db, collection, _, read = source
    original = window.missed_setup_window
    monkeypatch.setattr(window, 'missed_setup_window', partial(original,
        kv_read=read, now=stamp('2026-09-22T07:14:59+08:00')))
    calls = []
    expected = {'status': 'native_execution_pairs_registered', 'snapshot_id': collection['snapshot_id']}
    def complete(value, **kwargs):
        calls.append(value)
        return expected
    monkeypatch.setattr(pipeline, '_complete_existing_pipeline_shadow', complete)
    result = complete_pipeline_shadow(collection, query=db.query, writer=db.writer,
        enforce_execution_window=True)
    assert result is expected and calls == [collection]


def test_production_preflight_calendar_error_does_not_close_chain(source, monkeypatch):
    db, collection, _, _ = source
    original = window.missed_setup_window
    monkeypatch.setattr(window, 'missed_setup_window', partial(original,
        kv_read=lambda key: None, now=stamp('2026-09-22T08:00:00+08:00')))
    result = complete_pipeline_shadow(collection, query=db.query, writer=db.writer,
        enforce_execution_window=True)
    assert result['status'] == 'failed'
    assert result['reason'] == 'paired_native_official_calendar_missing'
    assert pipeline_shadow_errors(result)
