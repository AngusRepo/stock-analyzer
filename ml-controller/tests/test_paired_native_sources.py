from datetime import datetime, timezone
import sqlite3

import pytest

from services.paired_native_sources import opening_corporate_universe, pair_corporate_source, build_source_receipt
from services.paired_nav_journal import digest
from test_paired_native_collector import fixture
from test_native_paper_sandbox import native_runner, checksum
from test_corporate_opening_history import opening_event


def test_corporate_universe_covers_both_private_arms_not_formal_holdings(native_runner):
    db, args, objects, packet, snapshot_id = fixture(native_runner)
    for arm, symbol in [('baseline', '2330'), ('candidate', '2317')]:
        state = objects.get(packet['initial_state_objects'][arm])
        with sqlite3.connect(':memory:') as private:
            private.executescript(state['state_sql'])
            private.execute('INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost) VALUES(?,?,?,?,?)',
                (packet['account_id'], symbol, 'fixture', 100, 100))
            raw = '\n'.join(private.iterdump())
        new = {'state_sql': raw, 'state_checksum': checksum(raw)}
        packet['initial_state_objects'][arm] = objects.put(new)
        packet['initial_state_checksums'][arm] = new['state_checksum']
    assert opening_corporate_universe(packet, objects) == (['2317', '2330'], [])
    clock = lambda: datetime(2026, 9, 6, 23, 15, tzinfo=timezone.utc)
    calls = []
    def reader(**request):
        calls.append(request)
        return {'schema_version': 'paper-corporate-source-v1', 'session_date': packet['session_date'],
            'observed_at': clock().isoformat(), 'covered_symbols': request['symbols'], 'actions': [],
            'blockers': {}, 'source_checksum': digest(request), 'tax_basis': 'gross_before_personal_tax'}
    first = pair_corporate_source(snapshot_id=snapshot_id, packet=packet, objects=objects, reader=reader, clock=clock)
    second = pair_corporate_source(snapshot_id=snapshot_id, packet=packet, objects=objects, reader=reader,
        clock=lambda: args['now'])
    assert first == second and len(calls) == 1
    assert first['request']['symbols'] == ['2317', '2330']


def test_close_cannot_self_assert_coverage_or_download_missing_historical_source(native_runner):
    db, args, objects, packet, snapshot_id = fixture(native_runner)
    with pytest.raises(ValueError, match='live_preopen_required'):
        build_source_receipt(snapshot_id=snapshot_id, objects=objects, query=db.query, now=args['now'])
    with pytest.raises(ValueError, match='session_not_closed'):
        build_source_receipt(snapshot_id=snapshot_id, objects=objects, query=db.query,
            now=datetime(2026, 9, 6, 23, 15, tzinfo=timezone.utc))


def test_sold_symbols_from_each_arm_reach_shared_discovery_without_sharing_quantities(native_runner):
    db, args, objects, packet, snapshot_id = fixture(native_runner)
    for arm, symbol, shares in [('baseline', '2330', 100), ('candidate', '2317', 300)]:
        state = objects.get(packet['initial_state_objects'][arm])
        with sqlite3.connect(':memory:') as private:
            private.executescript(state['state_sql'])
            opening_event(private, '2026-09-04', symbol, packet['account_id'], shares)
            opening_event(private, '2026-09-04', '1101', 1, 999)
            assert private.execute('SELECT COUNT(*) FROM paper_positions WHERE account_id=?',
                [packet['account_id']]).fetchone()[0] == 0
            raw = '\n'.join(private.iterdump())
        new = {'state_sql': raw, 'state_checksum': checksum(raw)}
        packet['initial_state_objects'][arm] = objects.put(new)
        packet['initial_state_checksums'][arm] = new['state_checksum']
    clock = lambda: datetime(2026, 9, 6, 23, 15, tzinfo=timezone.utc)
    calls = []
    def reader(**request):
        calls.append(request)
        return {'schema_version': 'paper-corporate-source-v1', 'session_date': packet['session_date'],
            'observed_at': clock().isoformat(), 'covered_symbols': request['symbols'], 'actions': [],
            'blockers': {}, 'source_checksum': digest(request), 'tax_basis': 'gross_before_personal_tax'}
    result = pair_corporate_source(snapshot_id=snapshot_id, packet=packet, objects=objects, reader=reader, clock=clock)
    assert calls == [{'symbols': ['2317', '2330'], 'session_date': packet['session_date'],
        'outstanding_action_ids': (), 'historical_cash_dates': {'2317': ['2026-09-04'], '2330': ['2026-09-04']}}]
    assert result['request']['symbols'] == ['2317', '2330']
    assert result['account_mutations'] == 0 and result['prospective_backfill_credit'] == 0
    assert pair_corporate_source(snapshot_id=snapshot_id, packet=packet, objects=objects,
        reader=reader, clock=lambda: args['now']) == result
    assert len(calls) == 1
