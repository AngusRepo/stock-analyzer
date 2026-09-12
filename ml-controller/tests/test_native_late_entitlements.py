"""Actual native ex-date sale, late delivery and retry; synthetic quotes, NOT ROI."""
from datetime import datetime
import json
import sqlite3

import pytest
import polars as pl

from services.native_paper_sandbox import run_native_paper_frames
from services.paired_native_session import native_fills, session_schedule, validate_native_account
from services.paired_nav_journal import replay_session
from test_native_paper_sandbox import native_runner, checksum, frame
from test_paired_native_session import full_cash_state, native_config
from services.finlab_corporate_actions import normalize_dividend_announcements, fetch_paper_corporate_source, CASH
from services.paper_corporate_source import materialize_corporate_source
from services.native_paper_source_capture import ImmutableNativeObjects
from services.paired_nav_journal import digest
from test_native_paper_source_capture import Bucket
from test_finlab_corporate_actions import row


def source_for_day(day, symbols, outstanding, objects):
    now = datetime.fromisoformat(day + 'T07:00:00+08:00')
    original = row(**{CASH[1]: 0., '現金股利發放日': None, '權利分派基準日': '2026-09-08'})
    revised = {**original, '公告日期': '2026-09-08', '公告時間': '12:00:00',
               'key_date': '2026-09-08 12:01:00', '現金股利發放日': '2026-09-09'}
    # Original normalizer must ignore the future revision on 9/7 and preopen 9/8.
    def dividends(**kwargs):
        return normalize_dividend_announcements(pl.DataFrame([original, revised]), observed_at=now, **kwargs)
    text = '增資配股及配息基準日為115年9月8日 每仟股無償配發100股 每股配發新台幣2元 擬訂115年9月10日為股票股利發放日'
    def delivery(**kwargs):
        return {'symbol': kwargs['symbol'], 'query_start': '2025-09-01', 'query_end': day,
            'observed_at': now.isoformat(), 'documents': [] if day < '2026-09-09' else
            [{'published_date': '2026-09-08', 'body': text, 'body_checksum': digest(text)}]}
    def reader(**kwargs):
        return fetch_paper_corporate_source(**kwargs, dividend_reader=dividends, delivery_reader=delivery,
            capital_reader=lambda **_: {'covered_symbols': symbols, 'observed_at': now.isoformat(), 'actions': []})
    args = dict(session_date=day, scope_id='paired-' + digest('native-late-entitlements'),
                symbols=symbols, outstanding_action_ids=outstanding, objects=objects)
    saved = materialize_corporate_source(**args, reader=reader, clock=lambda: now)
    def forbidden_refetch(**kwargs):
        raise AssertionError('retry must consume frozen corporate evidence')
    assert materialize_corporate_source(**args, reader=forbidden_refetch, clock=lambda: now) == saved
    return saved['snapshot']


class Quotes:
    """Only market input is synthetic; native owner creates all fills/fees."""
    def read(self, operation, request, frame):
        assert operation == 'frozen_fetch'
        url, observed = request['url'], frame['observed_at']
        quote = {'status': 'ok', 'last': 85, 'bid': 85, 'ask': 85.1,
            'bid_volume': 1000, 'ask_volume': 1000, 'reference_price': 89.1,
            'source_time': observed, 'confirmed_at': observed, 'quote_age_ms': 0,
            'source_age_ms': 0, 'low': 85, 'high': 89.1, 'open': 89.1,
            'total_volume': 100000, 'session_epoch': 1}
        if url.startswith('https://broker.fixture/') and ('/orderbooks' in url or url.endswith(('/quotes', '/snapshots'))):
            if request['body'] and json.loads(request['body']).get('lot_type') == 'odd_lot':
                quote['lot_type'] = 'odd_lot'
            body = {'data': {'2330': quote}}
        elif '/orderbook/2330' in url or '/quote/2330' in url:
            if 'odd_lot' in url:
                quote['lot_type'] = 'odd_lot'
            body = {'data': quote}
        else:
            raise AssertionError('unregistered private quote: ' + url)
        return {'request': request, 'captured_at': observed,
            'response': {'body': json.dumps(body), 'status': 200, 'headers': {}}}


def test_sold_parent_keeps_cash_and_stock_rights_until_late_announced_delivery(native_runner):
    config = native_config()
    days = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10']
    objects = ImmutableNativeObjects(Bucket())
    with sqlite3.connect(':memory:') as db:
        db.executescript(full_cash_state(config))
        db.executescript("""
          INSERT INTO stocks(id,symbol,name,market) VALUES(1,'2330','fixture','TWSE');
          INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,entry_price,entry_date,initial_stop,trailing_stop)
          VALUES(2,'2330','original-holder',100,100,100,'2026-09-01',99,99);
        """)
        for day, price in [('2026-09-04', 100), *[(day, 85) for day in days]]:
            db.execute('INSERT INTO stock_prices(stock_id,date,close) VALUES(1,?,?)', (day, price))
        raw = '\n'.join(db.iterdump())
    previous = {'cash': 99000., 'positions': {'2330': 100}, 'nav': 109000.}
    opening_basis = None
    original_opening_event = None
    summaries = []
    for index, day in enumerate(days):
        with sqlite3.connect(':memory:') as db:
            db.executescript(raw)
            held = db.execute('SELECT symbol FROM paper_positions WHERE account_id=2 AND shares>0').fetchall()
            outstanding = db.execute('SELECT symbol,action_id FROM paper_corporate_entitlements_v1 WHERE account_id=2 AND settled=0').fetchall()
            symbols = sorted({r[0] for r in held + outstanding})
            source = source_for_day(day, symbols, sorted(r[1] for r in outstanding), objects)
            assert symbols == ['2330']
            if index < 2:
                assert all(a['payable_date'] is None for a in source['actions'])
            db.execute('UPDATE _native_private_kv SET value=? WHERE key=?',
                       (json.dumps(source), 'market:corporate_actions:v1:' + day))
            raw = '\n'.join(db.iterdump())
        close = {**frame(day, 'snapshot'), 'observed_at': day + 'T06:20:00Z'}
        frames = session_schedule(day) if index == 0 else [frame(day), close]
        args = dict(state_sql=raw, state_checksum=checksum(raw), account_id=2,
                    variables={'SHIOAJI_PROXY_URL': 'https://broker.fixture'}, frames=frames, runner=native_runner)
        result = run_native_paper_frames(**args, frame_inputs={f['input_id']: f for f in frames}, capture_source=Quotes())
        fills = native_fills(result['frames'], 2)
        if index == 0 and not fills:
            with sqlite3.connect(':memory:') as inspected:
                inspected.executescript(result['state_sql'])
                reasons = inspected.execute('SELECT DISTINCT event_type,reason,detail_json FROM paper_execution_events LIMIT 6').fetchall()
            pytest.fail('Original native sale did not execute: ' + repr(reasons))
        assert sum(f['shares'] for f in fills if f['side'] == 'sell') == (100 if index == 0 else 0)
        assert not any(f['side'] == 'buy' for f in fills)
        ledger = replay_session(previous=previous, fills=fills, marks={'2330': 85},
            corporate_actions=source['actions'], session_date=day, fees=config['trading']['fees'])
        valuation = result['frames'][-1]['result']['valuation']
        validate_native_account(valuation, ledger)
        assert valuation['positions'] == ({} if index < 3 else {'2330': 10})
        assert len(valuation['corporate_receivables']) == (2 if index < 2 else 1 if index == 2 else 0)
        if index:
            assert ledger['nav'] == pytest.approx(previous['nav'])
            assert ledger['daily_return'] == pytest.approx(0)
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            db.executescript(result['state_sql'])
            rights = {r['kind']: dict(r) for r in db.execute('SELECT * FROM paper_corporate_entitlements_v1 WHERE account_id=2')}
            assert rights['cash']['eligible_shares'] == rights['stock']['eligible_shares'] == 100
            assert rights['cash']['cash_due'] == 200 and rights['stock']['shares_due'] == 10
            assert db.execute('SELECT cash FROM paper_accounts WHERE id=1').fetchone()[0] == 999999
            events = [dict(r) for r in db.execute("SELECT * FROM paper_execution_events WHERE account_id=2 "
                "AND event_type='corporate_opening_basis' ORDER BY trade_date")]
            assert len(events) == index + 1
            event = events[-1]
            evidence = json.loads(event['detail_json'])
            assert checksum(event['detail_json']) == event['reason']
            assert evidence['source_checksum'] == source['source_checksum']
            assert evidence['session_date'] == day and evidence['account_id'] == 2
            assert evidence['observed_at'] == event['created_at']
            if index == 0:
                original_opening_event = events[0]
                assert evidence['positions'][0]['shares'] == 100
                assert evidence['positions'][0]['avg_cost'] == 100
            else:
                assert evidence['positions'] == []  # Delivery happens AFTER the opening capture.
                assert events[0] == original_opening_event  # Sold parent evidence is retained unchanged.
            if not index:
                opening_basis = json.loads(rights['stock']['position_basis_json'])
            if index == 3:
                p = dict(db.execute("SELECT * FROM paper_positions WHERE account_id=2 AND symbol='2330'").fetchone())
                for key in ('entry_date', 'initial_stop', 'trailing_stop', 'trade_lifecycle_json'):
                    assert p[key] == opening_basis[key]
        # Re-execute today's sealed settlement against its already committed state.
        # No second cash payment, share delivery, or entitlement is allowed.
        repeat_frame = frame(day)
        repeat = run_native_paper_frames(state_sql=result['state_sql'], state_checksum=result['state_checksum'],
            account_id=2, variables=args['variables'], frames=[repeat_frame],
            frame_inputs={repeat_frame['input_id']: repeat_frame}, runner=native_runner)
        assert repeat['state_checksum'] == result['state_checksum']
        summaries.append({'day': day, 'nav': ledger['nav'], 'cash': valuation['cash'],
                          'positions': valuation['positions'], 'receivables': len(valuation['corporate_receivables'])})
        previous, raw = ledger, result['state_sql']
    print('SYNTHETIC_ACCOUNTING_NOT_ROI ' + json.dumps(summaries, sort_keys=True))
