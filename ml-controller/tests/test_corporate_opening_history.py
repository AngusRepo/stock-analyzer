"""Private SQL integrity and source-scope tests; not investment performance."""
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import sqlite3

import polars as pl
import pytest

from services.corporate_opening_history import read_corporate_cash_discovery_dates, normalize_historical_cash_dates
from services.finlab_corporate_actions import normalize_dividend_announcements, CASH, STOCK
from services.paper_corporate_source import materialize_corporate_source
from services.native_paper_source_capture import ImmutableNativeObjects
from test_native_paper_source_capture import Bucket
from test_native_paper_sandbox import base_state
from test_finlab_corporate_actions import row


def opening_event(db, day, symbol='2330', account_id=2, shares=100):
    observed = day + 'T00:00:00.000Z'
    body = {'schema_version': 'paper-corporate-opening-basis-v1', 'account_id': account_id,
        'session_date': day, 'observed_at': observed, 'source_checksum': 'a' * 64,
        'positions': [] if shares == 0 else [{'account_id': account_id, 'symbol': symbol, 'shares': shares, 'avg_cost': 100}]}
    raw = json.dumps(body, ensure_ascii=False)
    db.execute('INSERT INTO paper_corporate_sessions_v1(account_id,session_date,source_checksum,processed_at) VALUES(?,?,?,?)',
        (account_id, day, 'a' * 64, observed))
    db.execute('INSERT INTO paper_execution_events(account_id,trade_date,event_type,status,reason,detail_json,source,created_at) '
        'VALUES(?,?,?,?,?,?,?,?)', (account_id, day, 'corporate_opening_basis', 'recorded',
        hashlib.sha256(raw.encode()).hexdigest(), raw, 'paper_corporate_actions_v1', observed))


def history(db, before='2026-09-08'):
    def query(sql, args):
        cur = db.execute(sql, args)
        return [dict(zip([c[0] for c in cur.description], row)) for row in cur.fetchall()]
    return read_corporate_cash_discovery_dates(query, account_id=2, before_date=before,
        now=datetime(2026, 9, 8, tzinfo=timezone.utc))


def test_exhausts_account_history_including_sold_symbols_and_excludes_current_and_other_account():
    with sqlite3.connect(':memory:') as db:
        db.executescript(base_state())
        dates = [(date(2026, 1, 1) + timedelta(days=i)).isoformat() for i in range(205)]
        for day in dates:
            opening_event(db, day)
        opening_event(db, '2026-09-07', '2317', shares=0)
        opening_event(db, '2026-09-08', '2317')
        opening_event(db, '2026-09-07', '1101', account_id=1)
        assert db.execute('SELECT COUNT(*) FROM paper_positions WHERE account_id=2').fetchone()[0] == 0
        assert history(db) == {'2330': dates}


@pytest.mark.parametrize('sql', [
    "UPDATE paper_execution_events SET reason='wrong'",
    "DELETE FROM paper_corporate_sessions_v1",
    "UPDATE paper_corporate_sessions_v1 SET processed_at='2026-09-07T02:00:00.000Z'",
    "INSERT INTO paper_execution_events(account_id,trade_date,event_type,status,reason,detail_json,source,created_at) "
    "SELECT account_id,trade_date,event_type,status,reason,detail_json,source,created_at FROM paper_execution_events",
])
def test_corrupt_uncommitted_or_duplicate_history_is_not_silently_empty(sql):
    with sqlite3.connect(':memory:') as db:
        db.executescript(base_state())
        opening_event(db, '2026-09-07')
        db.execute(sql)
        with pytest.raises(ValueError, match='corporate_opening_history'):
            history(db)


@pytest.mark.parametrize('value', [{'2330': ['2026-09-08']}, {'2330': ['20260907']},
    {'1101': ['2026-09-07']}, {'2330': []}, {1: ['2026-09-07'], '2330': ['2026-09-07']}])
def test_invalid_or_future_discovery_hints_rejected(value):
    with pytest.raises(ValueError, match='corporate_historical_cash_dates_invalid'):
        normalize_historical_cash_dates(value, symbols=['2330'], session_date='2026-09-08')


def test_old_observable_cash_only_enters_original_normalizer_and_immutable_source():
    now = datetime(2026, 9, 7, 23, tzinfo=timezone.utc)
    rows = pl.DataFrame([row(**{CASH[1]: 0., 'key_date': '2026-09-08 06:59:00'}),
        row(**{'股利所屬期間': '110年', '除息交易日': '2021-09-07', '除權交易日': '2021-09-07'})])
    calls = []
    def reader(**kwargs):
        calls.append(kwargs)
        return normalize_dividend_announcements(rows, observed_at=now, **kwargs)
    args = dict(session_date='2026-09-08', scope_id='paper-account-1', symbols=['2330'],
        outstanding_action_ids=[], historical_cash_dates={'2330': ['2026-09-07']},
        objects=ImmutableNativeObjects(Bucket()), reader=reader, clock=lambda: now)
    result = materialize_corporate_source(**args)
    assert result['request']['historical_cash_dates'] == {'2330': ['2026-09-07']}
    actions = result['snapshot']['actions']
    assert len(actions) == 1 and actions[0]['kind'] == 'cash' and actions[0]['cash_per_share'] == 2
    assert actions[0]['ex_date'] == '2026-09-07' and result['prospective_backfill_credit'] == 0
    assert materialize_corporate_source(**args) == result and len(calls) == 1
    with pytest.raises(ValueError, match='frozen_scope_changed'):
        materialize_corporate_source(**{**args, 'historical_cash_dates': None})


def test_unobservable_late_revision_remains_gap_not_historical_action():
    result = normalize_dividend_announcements(pl.DataFrame([row(**{'key_date': '2026-09-09 06:00:00'})]),
        symbols=['2330'], session_date='2026-09-08', observed_at=datetime(2026, 9, 8, tzinfo=timezone.utc),
        historical_cash_dates={'2330': ['2026-09-07']})
    assert result['actions'] == []
    assert result['blockers']['2330'] == ['corporate_event_has_no_observable_revision']


def test_controller_request_preserves_history_through_original_route_and_materializer(monkeypatch):
    import asyncio
    from routers import paper_corporate
    from services import paper_corporate_source
    now = datetime(2026, 9, 7, 23, tzinfo=timezone.utc)
    objects, calls = ImmutableNativeObjects(Bucket()), []
    def reader(**request):
        calls.append(request)
        return normalize_dividend_announcements(pl.DataFrame([row()]), observed_at=now, **request)
    monkeypatch.setattr(paper_corporate_source, 'fetch_paper_corporate_source', reader)
    monkeypatch.setattr(paper_corporate, 'production_objects', lambda: objects)
    monkeypatch.setattr(paper_corporate, 'materialize_corporate_source',
        lambda **kwargs: materialize_corporate_source(**kwargs, clock=lambda: now))
    request = paper_corporate.CorporateSourceRequest(session_date='2026-09-08', scope_id='paper-account-1',
        symbols=['2330'], outstanding_action_ids=[], historical_cash_dates={'2330': ['2026-09-07']})
    receipt = asyncio.run(paper_corporate.corporate_source(request))
    assert len(calls) == 1 and calls[0]['historical_cash_dates'] == {'2330': ['2026-09-07']}
    assert len(receipt['snapshot']['actions']) == 1 and receipt['snapshot']['actions'][0]['kind'] == 'cash'
    assert receipt['request']['historical_cash_dates'] == {'2330': ['2026-09-07']}
