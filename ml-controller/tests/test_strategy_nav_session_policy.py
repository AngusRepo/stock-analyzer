from datetime import datetime, timezone
import json

import pytest

from services.paired_native_session import (session_schedule, validate_schedule,
    session_policy, STRATEGY_SESSION_POLICY)
from services.native_paper_time import frame_capture_deadline
from test_paper_single_b_tabpack import single_config


def packet():
    return {'owner': 'atomic_strategy', 'session_date': '2026-09-07',
        'configuration': {'trading_config': single_config(),
            'native_session_policy': STRATEGY_SESSION_POLICY}}


def test_strategy_contract_follows_publication_without_losing_any_native_stage():
    p = packet()
    schedule = session_schedule(p['session_date'], policy=session_policy(p))
    legacy = session_schedule(p['session_date'])
    assert len(schedule) == len(legacy) == 281
    assert [r['stage'] for r in schedule] == [r['stage'] for r in legacy]
    assert schedule[2:] == legacy[2:]
    assert schedule[0]['observed_at'] == schedule[1]['observed_at'] == '2026-09-07T08:45:00+08:00'
    assert legacy[0]['observed_at'] == '2026-09-07T07:15:00+08:00'
    validate_schedule(schedule, p['session_date'], packet=p)
    for frame in schedule[:2]:
        assert frame_capture_deadline(frame) == datetime.fromisoformat('2026-09-07T08:50:00+08:00')
    with pytest.raises(ValueError, match='full_schedule_mismatch'):
        validate_schedule(legacy, p['session_date'], packet=p)
    with pytest.raises(ValueError, match='full_schedule_mismatch'):
        validate_schedule(schedule, p['session_date'])


@pytest.mark.parametrize('change', ['unknown', 'owner', 'mode', 'remove_stage'])
def test_policy_cannot_relax_legacy_unknown_owner_or_missing_stage(change):
    p = packet()
    schedule = session_schedule(p['session_date'], policy=STRATEGY_SESSION_POLICY)
    if change == 'unknown':
        p['configuration']['native_session_policy'] = 'unknown'
    elif change == 'owner':
        p['owner'] = 'ensemble'
    elif change == 'mode':
        p['configuration']['trading_config'].pop('l4Distribution')
    else:
        schedule.pop(0)
    with pytest.raises(ValueError):
        validate_schedule(schedule, p['session_date'], packet=p)


@pytest.mark.parametrize('stamp,reason', [
    ('2026-09-07T00:44:59+00:00', 'frozen_model_parent_missing'),
    ('2026-09-07T00:45:00+00:00', 'registration_after_first_phase'),
    ('2026-09-07T00:45:01+00:00', 'registration_after_first_phase')])
def test_original_registrar_enforces_exact_new_cutoff_without_creating_receipts(stamp, reason):
    from test_paired_nav_journal import DB
    from services.paired_nav_journal import freeze_snapshot, digest
    from services.paired_native_registration import register_allocation_pair
    db = DB()
    p = packet()
    p['pair_id'] = 'prospective-boundary'
    p['configuration_checksum'] = digest(p['configuration'])
    day = datetime(2026, 9, 6, 14, tzinfo=timezone.utc)
    sealed = freeze_snapshot(signal_date='2026-09-06', source_run_id=p['pair_id'],
        snapshot_kind='allocation_pair', content=p, query=db.query, writer=db.writer, now=day)
    def calendar(key):
        return json.dumps({'schemaVersion': 'twse-holiday-schedule-v2',
            'source': 'twse.openapi.holidaySchedule', 'loadedAt': day.isoformat(),
            'dates': []}) if key.startswith('market:twse_holiday_schedule:') else None
    with pytest.raises(ValueError, match=reason):
        register_allocation_pair(snapshot_id=sealed['snapshot_id'], query=db.query, writer=db.writer,
            domain_queries={}, kv_read=calendar, objects=None, account_id=1, variables={},
            kv_read_policy={}, now=datetime.fromisoformat(stamp))
    assert db.query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_pair'", []) == []
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []
