from datetime import datetime, timedelta, timezone
import json
import sqlite3

import pytest

from services.paired_native_registration import next_session, register_allocation_pair
from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot
from services.native_paper_source_capture import ImmutableNativeObjects
from services.native_paper_sandbox import native_runtime_manifest
from test_native_paper_source_capture import Bucket
from test_native_paper_bootstrap import fixture as source_fixture
from test_native_paper_state import fixture as state_fixture
from test_native_paper_sandbox import native_runner
from test_paired_nav_journal import DB
from test_paired_native_session import paired_fixture
from services.paired_native_session import run_paired_session
from services.paired_nav_journal import mature_staged_pairs


NOW = datetime(2026, 9, 7, 14, tzinfo=timezone.utc)


def freeze_model_context(db, packet):
    parent = freeze_snapshot(signal_date='2026-09-07', source_run_id='model-fixture', snapshot_kind='allocation_context',
        content={'model_predictions': {}}, query=db.query, writer=db.writer, now=NOW)
    packet['allocation_context_snapshot_id'] = parent['snapshot_id']
    packet['model_predictions_checksum'] = digest({})


def calendar(key):
    if key.startswith('market:twse_holiday_schedule:'):
        return json.dumps({'schemaVersion': 'twse-holiday-schedule-v2',
                          'source': 'twse.openapi.holidaySchedule', 'dates': [], 'loadedAt': NOW.isoformat()})
    return None


def test_next_session_requires_official_nonstale_calendar_and_respects_holiday():
    def holidays(key):
        return '1' if key == 'holiday:2026-09-08' else calendar(key)
    assert next_session('2026-09-07', kv_read=holidays, now=NOW)[0] == '2026-09-09'
    with pytest.raises(ValueError, match='official_calendar_missing'):
        next_session('2026-09-07', kv_read=lambda key: None, now=NOW)
    with pytest.raises(ValueError, match='invalid_or_stale'):
        next_session('2026-09-07', kv_read=calendar, now=NOW + timedelta(days=8))


def test_weekend_registration_keeps_real_frozen_parent_causality_and_cannot_rescue_old_predictions():
    db = DB()
    friday = datetime(2026, 9, 4, 14, tzinfo=timezone.utc)
    sunday = datetime(2026, 9, 6, 14, tzinfo=timezone.utc)
    parent = freeze_snapshot(signal_date='2026-09-04', source_run_id='parent', snapshot_kind='allocation_pair',
        content={}, query=db.query, writer=db.writer, now=friday)
    content = {'allocation_snapshot_id': parent['snapshot_id'],
               'schedule': [{'observed_at': '2026-09-07T07:15:00+08:00'}]}
    result = freeze_snapshot(signal_date='2026-09-04', source_run_id='child', snapshot_kind='execution_pair',
        content=content, query=db.query, writer=db.writer, now=sunday)
    assert result['prospective'] == 1
    late = freeze_snapshot(signal_date='2026-09-04', source_run_id='late-parent', snapshot_kind='allocation_pair',
        content={}, query=db.query, writer=db.writer, now=sunday)
    result = freeze_snapshot(signal_date='2026-09-04', source_run_id='late-child', snapshot_kind='execution_pair',
        content={**content, 'allocation_snapshot_id': late['snapshot_id']}, query=db.query, writer=db.writer, now=sunday)
    assert result['prospective'] == 0


def test_registration_freezes_original_serializer_states_and_retry_does_not_read_new_sources(native_runner):
    source, query_source = source_fixture()
    db = DB()
    try:
        config = {'trading_config': {'fees': {'commission': .001425, 'minCommission': 20,
                   'tax': .003, 'dayTradeTax': .0015}}, 'risk_config': {'system': {'killSwitch': True}}}
        recommendations = state_fixture()['recommendations']
        packet = {'pair_id': 'registration-test', 'owner': 'l4_alpha_ev', 'candidate_checksum': 'c' * 64,
            'baseline_checksum': 'b' * 64, 'configuration': config, 'configuration_checksum': digest(config),
            'baseline': {'recommendations': recommendations}, 'candidate': {'recommendations': recommendations}}
        freeze_model_context(db, packet)
        seal = freeze_snapshot(signal_date='2026-09-07', source_run_id='allocation-fixture', snapshot_kind='allocation_pair',
                               content=packet, query=db.query, writer=db.writer, now=NOW)
        objects = ImmutableNativeObjects(Bucket())
        owners = native_runtime_manifest(native_runner)['tables']
        kwargs = dict(snapshot_id=seal['snapshot_id'], query=db.query, writer=db.writer,
            domain_queries={domain: query_source for domain in set(owners.values())}, kv_read=calendar,
            objects=objects, account_id=1, variables={}, kv_read_policy={'source': ['holiday:'], 'private': ['paper:']},
            runner=native_runner, now=NOW)
        before = source.total_changes
        result = register_allocation_pair(**kwargs)
        assert source.total_changes == before
        execution = read_snapshot(db.query, result['snapshot_id'])['payload']['content']
        assert execution['session_date'] == '2026-09-08'
        assert execution['initial_account']['nav'] == 100000
        assert execution['initial_state_checksums']['baseline'] == execution['initial_state_checksums']['candidate']
        def forbidden(key):
            raise AssertionError('Registered retry must not rebootstrap changed live state')
        kwargs['kv_read'] = forbidden
        kwargs['domain_queries'] = {}
        assert register_allocation_pair(**kwargs) == result
        assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []
    finally:
        source.close()


@pytest.mark.parametrize('prior_status', ['nightly', 'receipt_only', 'missing_receipt', 'unrelated_failed'])
def test_next_day_registration_carries_both_verified_native_accounts_not_formal_cash(native_runner, prior_status):
    source, query_source = source_fixture()
    db, first = paired_fixture(native_runner)
    objects = ImmutableNativeObjects(Bucket())
    try:
        if prior_status != 'missing_receipt':
            run_paired_session(**first, state_objects=objects)
        if prior_status == 'nightly':
            mature_staged_pairs(business_date='2026-09-07', query=db.query, writer=db.writer, now=NOW)
        else:
            assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []
        if prior_status == 'unrelated_failed':
            from test_paired_nav_journal import packet as journal_packet, receipt
            from services.paired_nav_journal import stage_execution_receipt
            broken = journal_packet('2026-09-07', '2026-09-04')
            broken['pair_id'] = 'unrelated-missing-predecessor'
            bad = freeze_snapshot(signal_date='2026-09-04', source_run_id=broken['pair_id'],
                snapshot_kind='execution_pair', content=broken, query=db.query, writer=db.writer,
                now=datetime(2026,9,4,14,tzinfo=timezone.utc))
            stage_execution_receipt(execution=receipt(broken, bad), query=db.query, writer=db.writer, now=NOW)
        previous = read_snapshot(db.query, first['snapshot_id'])['payload']['content']
        config = previous['configuration']
        recs = state_fixture()['recommendations']
        allocation = {key: previous[key] for key in ('pair_id', 'candidate_checksum', 'baseline_checksum')}
        allocation.update(owner='l4_alpha_ev', configuration=config, configuration_checksum=digest(config),
                          baseline={'recommendations': recs}, candidate={'recommendations': recs})
        freeze_model_context(db, allocation)
        plan = freeze_snapshot(signal_date='2026-09-07', source_run_id=allocation['pair_id'], snapshot_kind='allocation_pair',
            content=allocation, query=db.query, writer=db.writer, now=NOW)
        owners = native_runtime_manifest(native_runner)['tables']
        args = dict(snapshot_id=plan['snapshot_id'], query=db.query, writer=db.writer,
            domain_queries={domain: query_source for domain in set(owners.values())}, kv_read=calendar,
            objects=objects, account_id=2, variables={}, kv_read_policy={}, runner=native_runner, now=NOW)
        original_changes = source.total_changes
        if prior_status == 'missing_receipt':
            with pytest.raises(ValueError, match='paired_native_previous_session_not_materialized'):
                register_allocation_pair(**args)
            assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []
            assert not db.query('SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?',
                [digest(['execution_pair','2026-09-07',allocation['pair_id']])])
            assert source.total_changes == original_changes
            return
        result = register_allocation_pair(**args)
        packet = read_snapshot(db.query, result['snapshot_id'])['payload']['content']
        assert packet['previous_session_date'] == '2026-09-07'
        assert len(db.query('SELECT * FROM paired_nav_daily_journal_v1', [])) == 1
        assert source.total_changes == original_changes
        assert register_allocation_pair(**args) == result
        assert source.execute('SELECT cash FROM paper_accounts WHERE id=2').fetchone()[0] == 777
        for arm in ('baseline', 'candidate'):
            state = objects.get(packet['initial_state_objects'][arm])
            with sqlite3.connect(':memory:') as check:
                check.executescript(state['state_sql'])
                assert check.execute('SELECT cash FROM paper_accounts WHERE id=2').fetchone()[0] == 92000
                assert check.execute('SELECT total_value FROM paper_daily_snapshots WHERE account_id=2').fetchone()[0] == 99000
    finally:
        source.close()
