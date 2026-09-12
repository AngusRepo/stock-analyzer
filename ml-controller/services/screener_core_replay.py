"""Run the ORIGINAL Core upsert in memory, never copying its CASE rules.

No remote clients, disk databases, extensions or NAV credit. Pre-write state
distinguishes a fresh insert from an update preserving already-computed ML.
"""
from copy import deepcopy
import json
import sqlite3

from services.paired_nav_journal import _timestamp, digest


def replay_core_upsert(before: dict, sql: str, bindings: list[list], *, observed_at: str) -> list[dict]:
    if (before.get('schema_version') != 'screener-core-before-write-v1'
            or before.get('knowledge_scope') != 'observed_before_seed_write_not_historical_asof'
            or not isinstance(before.get('symbols'), list)
            or len(set(before['symbols'])) != len(before['symbols'])
            or type(before.get('sequence')) is not int or before['sequence'] < 0
            or not isinstance(before.get('table_sql'), str) or not isinstance(sql, str)
            or not sql.lstrip().upper().startswith('INSERT INTO DAILY_RECOMMENDATIONS')):
        raise ValueError('atomic_core_before_invalid')
    clock = _timestamp(observed_at).strftime('%Y-%m-%d %H:%M:%S')
    scope = set(before['symbols'])
    stocks, prior = before.get('stock_rows'), before.get('daily_rows')
    if not isinstance(stocks, list) or not isinstance(prior, list) or not isinstance(bindings, list):
        raise ValueError('atomic_core_before_rows_missing')
    identity = {}
    for row in stocks:
        if (not isinstance(row, dict) or row.get('symbol') not in scope
                or type(row.get('id')) is not int or row['id'] <= 0
                or row['symbol'] in identity or row['id'] in identity.values()):
            raise ValueError('atomic_core_stock_identity_invalid')
        identity[row['symbol']] = row['id']
    seen_ids, seen_symbols = set(), set()
    for row in prior:
        if (not isinstance(row, dict) or row.get('symbol') not in identity
                or row.get('stock_id') != identity[row['symbol']] or row.get('date') != before['signal_date']
                or type(row.get('id')) is not int or not 0 < row['id'] <= before['sequence']
                or row['id'] in seen_ids or row['symbol'] in seen_symbols):
            raise ValueError('atomic_core_prior_identity_invalid')
        seen_ids.add(row['id'])
        seen_symbols.add(row['symbol'])
    symbols = []
    for values in bindings:
        if (not isinstance(values, list) or len(values) != 19 or values[0] != before['signal_date']
                or not isinstance(values[1], str) or values[1] != values[2]
                or values[1] not in identity or values[1] in symbols):
            raise ValueError('atomic_core_upsert_bindings_invalid')
        symbols.append(values[1])

    def authorize(action, first, second, database, trigger):
        if database not in (None, 'main') or trigger is not None:
            return sqlite3.SQLITE_DENY
        if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_TRANSACTION):
            return sqlite3.SQLITE_OK
        if action in (sqlite3.SQLITE_READ, sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE):
            return sqlite3.SQLITE_OK if first in {'sqlite_master', 'sqlite_sequence', 'stocks', 'daily_recommendations'} else sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_CREATE_TABLE:
            return sqlite3.SQLITE_OK if first in {'stocks', 'daily_recommendations', 'sqlite_sequence'} else sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_CREATE_INDEX:
            return sqlite3.SQLITE_OK if second in {'stocks', 'daily_recommendations'} else sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_FUNCTION:
            return sqlite3.SQLITE_OK if second in {'coalesce', 'datetime'} else sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_DENY

    connection = sqlite3.connect(':memory:')
    connection.row_factory = sqlite3.Row
    connection.create_function('datetime', -1, lambda *args: clock)
    connection.set_authorizer(authorize)
    operations = 0
    def bounded():
        nonlocal operations
        operations += 1000
        return int(operations > 10_000_000)
    connection.set_progress_handler(bounded, 1000)
    try:
        connection.execute('CREATE TABLE stocks(id INTEGER PRIMARY KEY,symbol TEXT UNIQUE,name TEXT,sector TEXT,market TEXT)')
        connection.execute(before['table_sql'])
        connection.executemany('INSERT INTO stocks VALUES(?,?,?,?,?)', [
            [row.get(key) for key in ('id', 'symbol', 'name', 'sector', 'market')] for row in stocks])
        for row in prior:
            columns = list(row)
            if any(not key.replace('_', '').isalnum() for key in columns):
                raise ValueError('atomic_core_prior_column_invalid')
            connection.execute('INSERT INTO daily_recommendations (' + ','.join('"' + k + '"' for k in columns)
                + ') VALUES (' + ','.join('?' for _ in columns) + ')', [row[k] for k in columns])
        connection.execute("UPDATE sqlite_sequence SET seq=? WHERE name='daily_recommendations'", [before['sequence']])
        if not connection.execute("SELECT seq FROM sqlite_sequence WHERE name='daily_recommendations'").fetchone():
            connection.execute('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)', ['daily_recommendations', before['sequence']])
        connection.executemany(sql, bindings)
        rows = {row['symbol']: dict(row) for row in connection.execute(
            'SELECT * FROM daily_recommendations WHERE date=?', [before['signal_date']])}
        if any(symbol not in rows for symbol in symbols):
            raise ValueError('atomic_core_upsert_output_missing')
        return [rows[symbol] for symbol in symbols]
    finally:
        connection.close()


def materialize_atomic_core_domains(population: dict, formal_context: dict) -> dict:
    observations = population.get('core_seed_persistence')
    if not isinstance(observations, list) or not observations:
        return {'status': 'unavailable', 'reason': 'core_pre_write_source_not_captured'}
    if len(observations) != 1 or observations[0].get('status') != 'captured':
        return {'status': 'unavailable', 'reason': 'core_pre_write_source_not_verified'}
    observation = observations[0]
    if not (_timestamp(population['source_observed_at']) <= _timestamp(observation['started_at'])
            <= _timestamp(observation['completed_at']) <= _timestamp(population['artifact_created_at'])):
        raise ValueError('atomic_core_pre_write_time_invalid')
    source = observation.get('value') or {}
    before = source.get('before') or {}
    if before.get('signal_date') != population['signal_date'] or set(observation.get('symbols') or []) != set(before.get('symbols') or []):
        raise ValueError('atomic_core_pre_write_scope_invalid')
    baseline = replay_core_upsert(before, source.get('upsert_sql'), source.get('baseline_bindings'),
        observed_at=observation['completed_at'])
    actual = formal_context['inputs']['daily_rows']
    def canonical(value):
        if isinstance(value, str) and value.lstrip().startswith(('{', '[')):
            try:
                return json.loads(value)
            except ValueError:
                pass
        return value
    replayed = {r['symbol']: r for r in baseline}
    if set(replayed) != {r['symbol'] for r in actual} or any(
            any(canonical(replayed[r['symbol']].get(k)) != canonical(v) for k, v in r.items()) for r in actual):
        raise ValueError('atomic_core_incumbent_persistence_mismatch')
    definitions = {}
    for replacement in population['replacements']:
        key = replacement['definition_checksum']
        if replacement.get('candidate', {}).get('status') != 'materialized':
            definitions[key] = {'status': 'unavailable', 'evidence': deepcopy(replacement.get('candidate'))}
            continue
        bindings = replacement.get('core_upsert_bindings')
        if bindings is None:
            definitions[key] = {'status': 'unavailable', 'reason': 'candidate_core_bindings_missing'}
            continue
        rows = replay_core_upsert(before, source['upsert_sql'], bindings, observed_at=observation['completed_at'])
        expected_symbols = [row['seed']['row']['symbol'] for row in replacement['candidate']['rows']]
        if [row['symbol'] for row in rows] != expected_symbols:
            raise ValueError('atomic_candidate_core_persistence_scope_mismatch')
        definitions[key] = {'status': 'materialized', 'daily_rows': rows}
    body = {'status': 'materialized', 'schema_version': 'atomic-core-domain-replay-v1',
        'source_checksum': digest(source), 'formal_context_checksum': formal_context['content_checksum'],
        'baseline_daily_rows': baseline, 'stock_rows': deepcopy(before['stock_rows']), 'definitions': definitions,
        'production_effect': False, 'promotion_allowed': False, 'nav_maturity_credit': 0}
    return {**body, 'output_checksum': digest(body)}
