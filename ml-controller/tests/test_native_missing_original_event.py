"""Native late-cash recognition reconciles against independent opening evidence.

Synthetic accounting counterexample, NOT returns or production verification.
The expected economic entitlement is based on an unchanged, known opening lot;
no historical signal, fill or frozen source is rewritten by this reproduction.
"""
from datetime import datetime
import json
import sqlite3

import polars as pl
import pytest

from services.finlab_corporate_actions import normalize_dividend_announcements, CASH, STOCK
from services.native_paper_sandbox import run_native_paper_frames
from services.paired_nav_journal import replay_session
from services.paired_nav_chain import empty_cash_history, advance_cash_history
from services.paired_native_session import validate_native_account
from services.corporate_opening_history import read_corporate_cash_discovery_dates
from test_finlab_corporate_actions import row
from test_native_paper_sandbox import native_runner, checksum, frame
from test_paired_native_session import full_cash_state, native_config
from test_native_late_entitlements import Quotes


class ExDividendQuotes(Quotes):
    def read(self, operation, request, frame):
        record = super().read(operation, request, frame)
        body = json.loads(record['response']['body'])
        data = body['data']
        for quote in ([data] if 'last' in data else data.values()):
            quote.update(last=98, bid=98, ask=98, reference_price=98, low=98, high=98, open=98)
        record['response']['body'] = json.dumps(body)
        return record


@pytest.mark.parametrize('archive_conflict', [False, True])
def test_late_original_cash_event_must_not_silently_disappear_from_nav(native_runner, archive_conflict):
    config = native_config()
    days = ('2026-09-07', '2026-09-08', '2026-09-09')
    announcement = row(**{'股利所屬期間': '不適用', CASH[1]: 0., STOCK[0]: 0., STOCK[1]: 0.,
                          '現金股利發放日': days[-1]})
    with sqlite3.connect(':memory:') as db:
        db.executescript(full_cash_state(config))
        db.execute('DELETE FROM paper_settlements WHERE account_id=2')
        db.execute('UPDATE paper_accounts SET cash=99000 WHERE id=2')
        db.execute("INSERT INTO stocks(id,symbol,name,market) VALUES(1,'2330','fixture','TWSE')")
        db.execute("INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,entry_price,entry_date) "
                   "VALUES(2,'2330','original-holder',100,100,100,'2026-09-01')")
        for day, price in [('2026-09-04', 100), *[(day, 98) for day in days]]:
            db.execute('INSERT INTO stock_prices(stock_id,date,close) VALUES(1,?,?)', (day, price))
        opening = '\n'.join(db.iterdump())

    observed = {}
    for scenario in ('on_time', 'late_original'):
        raw = opening
        previous = {'cash': 99000., 'positions': {'2330': 100}, 'nav': 109000.}
        cash_history = empty_cash_history()
        daily = []
        for index, day in enumerate(days):
            with sqlite3.connect(':memory:') as db:
                db.executescript(raw)
                outstanding = tuple(r[0] for r in db.execute(
                    'SELECT action_id FROM paper_corporate_entitlements_v1 WHERE account_id=2 AND settled=0'))
                # The entire original event is absent from the first catalog.
                # Tomorrow it arrives with its actual later ingestion timestamp.
                current = {**announcement, 'key_date': '2026-09-08 06:59:00'} if scenario == 'late_original' else announcement
                rows = pl.DataFrame([current])
                if scenario == 'late_original' and index == 0:
                    rows = rows.head(0)  # Valid schema, missing source record.
                if archive_conflict:
                    archives = [dict(announcement, **{'公告日期': '2019-08-07',
                        'key_date': '2023-12-01 10:12:23', '除息交易日': '2019-08-20',
                        '除權交易日': None, '現金股利發放日': '2019-09-01'}),
                        dict(announcement, **{'公告日期': '2022-12-05',
                        'key_date': '2023-12-01 10:12:23', '除息交易日': '2022-12-18',
                        '除權交易日': None, '現金股利發放日': '2023-01-03'})]
                    rows = pl.concat([pl.DataFrame(archives), rows], how='vertical_relaxed')
                def query(sql, params):
                    cursor = db.execute(sql, params)
                    return [dict(zip([c[0] for c in cursor.description], r)) for r in cursor.fetchall()]
                observed_at = datetime.fromisoformat(day + 'T07:00:00+08:00')
                discovery = read_corporate_cash_discovery_dates(query, account_id=2, before_date=day, now=observed_at)
                source = normalize_dividend_announcements(rows, symbols=['2330'], session_date=day,
                    observed_at=observed_at, outstanding_action_ids=outstanding, historical_cash_dates=discovery)
                if scenario == 'late_original' and index:
                    assert any(r['除息交易日'] == days[0] for r in json.loads(source['raw_source']['rows_json']))
                    assert discovery['2330'][0] == days[0]
                    assert len(source['actions']) == 1 and source['actions'][0]['cash_per_share'] == 2
                db.execute('UPDATE _native_private_kv SET value=? WHERE key=?',
                    (json.dumps(source), 'market:corporate_actions:v1:' + day))
                raw = '\n'.join(db.iterdump())
            frames = [frame(day), {**frame(day, 'snapshot'), 'observed_at': day + 'T06:20:00Z'}]
            result = run_native_paper_frames(state_sql=raw, state_checksum=checksum(raw), account_id=2,
                variables={'SHIOAJI_PROXY_URL': 'https://broker.fixture'}, frames=frames,
                frame_inputs={f['input_id']: f for f in frames}, runner=native_runner, capture_source=ExDividendQuotes())
            ledger = replay_session(previous=previous, fills=[], marks={'2330': 98},
                corporate_actions=source['actions'], session_date=day, fees=config['trading']['fees'],
                cash_history=cash_history['baseline'])
            valuation = result['frames'][-1]['result']['valuation']
            if scenario == 'late_original' and index:
                print('SYNTHETIC_CORRECTION_NOT_ROI ' + json.dumps({'day': day, 'native_nav': valuation['nav'],
                    'independent_nav': ledger['nav'], 'native_cash': valuation['cash'],
                    'native_receivables': valuation['corporate_receivables']}, sort_keys=True))
            validate_native_account(valuation, ledger)
            advance_cash_history(cash_history, {arm: previous for arm in cash_history},
                {arm: ledger for arm in cash_history}, source['actions'], day)
            if scenario == 'late_original' and index == 1:
                assert ledger['reported_opening_nav'] == 108800
                assert ledger['return_opening_nav'] == 109000
                assert ledger['daily_return'] == pytest.approx(0.)
            with sqlite3.connect(':memory:') as db:
                db.executescript(result['state_sql'])
                assert db.execute('SELECT cash FROM paper_accounts WHERE id=1').fetchone()[0] == 999999
                assert db.execute('SELECT COUNT(*) FROM paper_orders WHERE account_id=2').fetchone()[0] == 0
                marker = db.execute('SELECT source_checksum FROM paper_corporate_sessions_v1 '
                                    'WHERE account_id=2 AND session_date=?', (day,)).fetchone()
                assert marker == (source['source_checksum'],)
                entitlements = db.execute('SELECT eligible_shares,cash_due,settled FROM '
                                         'paper_corporate_entitlements_v1 WHERE account_id=2').fetchall()
                basis_raw, basis_hash = db.execute("SELECT detail_json,reason FROM paper_execution_events "
                    "WHERE account_id=2 AND trade_date=? AND event_type='corporate_opening_basis'", (day,)).fetchone()
                assert checksum(basis_raw) == basis_hash
                basis = json.loads(basis_raw)
                assert basis['positions'][0]['shares'] == 100 and basis['account_id'] == 2
                assert basis['source_checksum'] == source['source_checksum']
            daily.append({'day': day, 'nav': valuation['nav'], 'cash': valuation['cash'],
                          'actions': len(source['actions']), 'blockers': source['blockers'],
                          'entitlements': entitlements})
            previous, raw = ledger, result['state_sql']
        observed[scenario] = daily
    print('SYNTHETIC_MISSING_SOURCE_NOT_ROI ' + json.dumps(observed, sort_keys=True))
    assert observed['on_time'][-1]['nav'] == pytest.approx(109000.)
    assert observed['on_time'][-1]['entitlements'] == [(100, 200., 1)]
    # This is recovery of an existing asset, not today's investment gain.
    assert observed['late_original'][-1]['nav'] == pytest.approx(observed['on_time'][-1]['nav'])
    assert observed['late_original'][-1]['cash'] == 99200
    assert observed['late_original'][-1]['entitlements'] == [(100, 200., 1)]
