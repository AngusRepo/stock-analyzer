"""Read original native opening evidence; discovery hints are not entitlements."""
from datetime import date, datetime, timezone
import hashlib
import json
import math
import re

from services.paired_nav_journal import _timestamp


def normalize_historical_cash_dates(value, *, symbols, session_date):
    day = _date(session_date)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError('corporate_historical_cash_dates_invalid')
    result = {}
    for symbol, dates in value.items():
        if (not isinstance(symbol, str) or not re.fullmatch(r'[0-9A-Za-z]{4,8}', symbol)
                or symbol not in symbols or not isinstance(dates, list) or not dates):
            raise ValueError('corporate_historical_cash_dates_invalid')
        for item in dates:
            if _date(item) >= day:
                raise ValueError('corporate_historical_cash_dates_invalid')
        result[symbol] = sorted(set(dates))
    return dict(sorted(result.items()))


def _date(value):
    try:
        parsed = date.fromisoformat(value)
        if parsed.isoformat() == value:
            return parsed
    except (ValueError, TypeError):
        pass
    raise ValueError('corporate_historical_cash_dates_invalid')


def read_corporate_cash_discovery_dates(query, *, account_id, before_date, now=None):
    if type(account_id) is not int or account_id <= 0:
        raise ValueError('corporate_opening_account_invalid')
    _date(before_date)
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None:
        raise ValueError('corporate_opening_clock_invalid')
    cursor, sessions, result = 0, set(), {}
    while True:
        rows = query('''SELECT e.id,e.trade_date,e.detail_json,e.reason,e.source,e.status,e.created_at,
            s.source_checksum AS committed_source_checksum,s.processed_at
            FROM paper_execution_events e LEFT JOIN paper_corporate_sessions_v1 s
            ON s.account_id=e.account_id AND s.session_date=e.trade_date
            WHERE e.account_id=? AND e.event_type='corporate_opening_basis' AND e.trade_date<? AND e.id>?
            ORDER BY e.id LIMIT 100''', [account_id, before_date, cursor])
        if not isinstance(rows, list):
            raise ValueError('corporate_opening_history_read_failed')
        if not rows:
            break
        for row in rows:
            _date(row['trade_date'])
            if (type(row['id']) is not int or row['id'] <= cursor or row['trade_date'] >= before_date
                    or row['trade_date'] in sessions):
                raise ValueError('corporate_opening_history_ambiguous')
            raw = row['detail_json']
            if (row['source'] != 'paper_corporate_actions_v1' or row['status'] != 'recorded'
                    or not isinstance(raw, str) or hashlib.sha256(raw.encode('utf-8')).hexdigest() != row['reason']):
                raise ValueError('corporate_opening_history_corrupt')
            body = json.loads(raw)
            observed = _timestamp(body['observed_at'])
            if (body.get('schema_version') != 'paper-corporate-opening-basis-v1'
                    or type(body.get('account_id')) is not int or body['account_id'] != account_id
                    or body['session_date'] != row['trade_date'] or body['source_checksum'] != row['committed_source_checksum']
                    or not isinstance(body['source_checksum'], str) or not re.fullmatch(r'[a-f0-9]{64}', body['source_checksum'])
                    or observed.isoformat(timespec='milliseconds').replace('+00:00', 'Z') != body['observed_at']
                    or row['created_at'] != body['observed_at'] or row['processed_at'] != body['observed_at']
                    or observed > clock or observed >= _timestamp(body['session_date'] + 'T01:00:00Z')
                    or observed < _timestamp(body['session_date'] + 'T00:00:00+08:00')
                    or not isinstance(body['positions'], list)):
                raise ValueError('corporate_opening_history_invalid')
            symbols = set()
            for position in body['positions']:
                symbol = position['symbol']
                if (type(position['account_id']) is not int or position['account_id'] != account_id
                        or not isinstance(symbol, str) or not re.fullmatch(r'[0-9A-Za-z]{4,8}', symbol)
                        or symbol in symbols or type(position['shares']) is not int
                        or not 0 < position['shares'] <= 9007199254740991
                        or type(position['avg_cost']) not in (int, float)
                        or not math.isfinite(position['avg_cost']) or position['avg_cost'] < 0):
                    raise ValueError('corporate_opening_position_invalid')
                symbols.add(symbol)
                result.setdefault(symbol, set()).add(body['session_date'])
            cursor = row['id']
            sessions.add(row['trade_date'])
    return {symbol: sorted(dates) for symbol, dates in sorted(result.items())}
