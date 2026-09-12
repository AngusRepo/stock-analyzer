"""Whole native sessions -> original paired receipt -> nightly NAV evidence.

Synthetic market inputs, NOT investment performance or deployed queue closure.
Announcements enter at the actual preopen read, not the prior frozen state.
"""
from copy import deepcopy
from datetime import datetime
import json
import sqlite3

import polars as pl
import pytest

from services.corporate_opening_history import read_corporate_cash_discovery_dates
from services.finlab_corporate_actions import normalize_dividend_announcements, CASH, STOCK
from services.native_paper_sandbox import native_execution_identity, run_native_paper_frames
from services.paired_native_runtime import KV_READ_POLICY
from services.paired_native_session import session_schedule, run_paired_session
from services.paired_nav_journal import freeze_snapshot, digest, mature_staged_pairs
from services.paired_nav_evidence import read_verified_nav_evidence
from test_native_paper_sandbox import native_runner, checksum
from test_native_missing_original_event import ExDividendQuotes
from test_paired_native_session import full_cash_state, native_config
from test_paired_nav_journal import DB
from test_finlab_corporate_actions import row


def test_actual_three_day_native_pairs_capture_late_source_reconcile_and_materialize_once(native_runner):
    config, db = native_config(), DB()
    with sqlite3.connect(':memory:') as private:
        private.executescript(full_cash_state(config))
        private.execute('DELETE FROM paper_settlements WHERE account_id=2')
        private.execute('UPDATE paper_accounts SET cash=99000 WHERE id=2')
        private.execute("DELETE FROM _native_private_kv WHERE key LIKE 'market:corporate_actions:%'")
        private.execute("INSERT INTO stocks(id,symbol,name,market) VALUES(1,'2330','fixture','TWSE')")
        private.execute("INSERT INTO stock_prices(stock_id,date,close) VALUES(1,'2026-09-04',100)")
        private.execute("INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,entry_price,entry_date,initial_stop,trailing_stop) "
            "VALUES(2,'2330','original-owner',100,100,100,'2026-09-01',99,99)")
        raw = '\n'.join(private.iterdump())
    configuration = {'trading_config': config['trading'], 'risk_config': config['risk'],
        'fees': config['trading']['fees'], 'allocator_source_identity': {'fixture': 'test-only'}}
    initial = {'cash': 99000, 'positions': {'2330': 100}, 'marks': {'2330': 100}, 'nav': 109000}
    previous = None
    for signal, day in [('2026-09-04', '2026-09-07'), ('2026-09-07', '2026-09-08'), ('2026-09-08', '2026-09-09')]:
        clock = datetime.fromisoformat(day + 'T07:00:00+00:00')
        schedule = session_schedule(day)
        states = {arm: {'state_sql': raw, 'state_checksum': checksum(raw)} for arm in ('baseline', 'candidate')}
        packet = {'pair_id': 'native-late-cash-pair', 'candidate_checksum': 'c' * 64, 'baseline_checksum': 'b' * 64,
            'execution_owner_version': native_execution_identity(native_runner), 'configuration': configuration,
            'configuration_checksum': digest(configuration), 'fees': configuration['fees'], 'initial_account': initial,
            'initial_state_checksums': {arm: state['state_checksum'] for arm, state in states.items()},
            'account_id': 2, 'variables': {'SHIOAJI_PROXY_URL': 'https://broker.fixture'}, 'schedule': schedule,
            'previous_session_date': previous, 'session_date': day,
            'session_open_at': day + 'T01:00:00Z', 'session_close_at': day + 'T05:30:00Z'}
        sealed = freeze_snapshot(signal_date=signal, source_run_id=packet['pair_id'] + ':' + signal,
            snapshot_kind='execution_pair', content=packet, query=db.query, writer=db.writer,
            now=datetime.fromisoformat(signal + 'T14:00:00+00:00'))
        with sqlite3.connect(':memory:') as private:
            private.executescript(raw)
            def query(sql, params):
                cursor = private.execute(sql, params)
                return [dict(zip([c[0] for c in cursor.description], r)) for r in cursor.fetchall()]
            history = read_corporate_cash_discovery_dates(query, account_id=2, before_date=day, now=clock)
            outstanding = tuple(r[0] for r in private.execute('SELECT action_id FROM paper_corporate_entitlements_v1 WHERE account_id=2 AND settled=0'))
        rows = pl.DataFrame([row(**{CASH[1]: 0., STOCK[0]: 0., STOCK[1]: 0.,
            '現金股利發放日': '2026-09-09', 'key_date': '2026-09-08 06:59:00'})])
        source = normalize_dividend_announcements(rows if previous else rows.head(0), symbols=['2330'], session_date=day,
            observed_at=datetime.fromisoformat(day + 'T07:00:00+08:00'), outstanding_action_ids=outstanding,
            historical_cash_dates=history)
        class Sources(ExDividendQuotes):
            def read(self, operation, request, frame):
                if operation == 'source_kv':
                    return {'request': request, 'captured_at': frame['observed_at'],
                        'response': json.dumps(source) if request['key'] == 'market:corporate_actions:v1:' + day else None}
                return super().read(operation, request, frame)
        inputs = {f['input_id']: {**f, 'capture_kv_reads': True, 'kv_read_policy': deepcopy(KV_READ_POLICY)} for f in schedule}
        captured = run_native_paper_frames(state_sql=raw, state_checksum=checksum(raw), account_id=2,
            variables=packet['variables'], frames=schedule, frame_inputs=inputs, runner=native_runner, capture_source=Sources())
        source_receipt = {'session_date': day, 'complete': True, 'schedule_checksum': digest(schedule),
            'closed_at': day + 'T06:20:00Z', 'corporate_actions_complete': True,
            'corporate_actions': source['actions'], 'closing_marks': {'2330': 98}}
        tapes = {arm: {'frames': captured['captured_inputs'], 'source_receipt': source_receipt} for arm in states}
        result = run_paired_session(snapshot_id=sealed['snapshot_id'], tapes=tapes, states=states,
            query=db.query, writer=db.writer, now=clock, runner=native_runner,
            expected_final_checksums={arm: captured['state_checksum'] for arm in states})
        assert result['execution']['cash_accounting_version'] == 1
        assert len(captured['frames']) == 281
        assert sum(f['shares'] for f in result['execution']['arms']['candidate']['fills']) == (100 if previous is None else 0)
        maturity = mature_staged_pairs(business_date=day, query=db.query, writer=db.writer, now=clock)
        assert maturity['processed_pair_sessions'] == 1
        assert mature_staged_pairs(business_date=day, query=db.query, writer=db.writer, now=clock)['processed_pair_sessions'] == 0
        assert result['states']['baseline'] == result['states']['candidate']
        raw, previous = result['states']['candidate']['state_sql'], day
    evidence = read_verified_nav_evidence(business_date=day, query=db.query, now=clock)
    observations = evidence.pairs[0].observations
    assert len(observations) == 3 and observations[0].candidate_daily_return == pytest.approx(-49 / 109000)
    assert observations[1].candidate_daily_return == observations[2].candidate_daily_return == 0
    with sqlite3.connect(':memory:') as private:
        private.executescript(raw)
        assert private.execute('SELECT cash FROM paper_accounts WHERE id=2').fetchone()[0] == 108951
        assert private.execute('SELECT cash FROM paper_accounts WHERE id=1').fetchone()[0] == 999999
        assert private.execute('SELECT eligible_shares,cash_due,settled FROM paper_corporate_entitlements_v1 WHERE account_id=2').fetchall() == [(100, 200., 1)]
