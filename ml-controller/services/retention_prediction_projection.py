"""Evaluate existing bounded research SELECTs over verified cold predictions.

No replacement scoring, sampling, or date truncation. SQL filtering/projection
is unchanged; only the original result limit is retained during chunk merging.
"""
from contextlib import closing
import json
import sqlite3
from services.retention_archive import _ident
from services.retention_history import archived_predictions


def read_latest_prediction_projection(sql, params, *, query_hot, cold_reader=None):
    if len(params) != 1 or type(params[0]) is not int or not 1 <= params[0] <= 5000:
        raise ValueError('retention_latest_projection_limit_invalid')
    normalized = ' '.join(sql.split()).upper()
    if not (normalized.startswith('SELECT ') and ' FROM PREDICTIONS WHERE ' in normalized
            and normalized.endswith(' ORDER BY GENERATED_AT DESC LIMIT ?')):
        raise ValueError('retention_latest_projection_sql_invalid')
    limit = params[0]
    result = query_hot(sql, params)
    # A full hot result already sets a lower bound on useful cold dates.
    start = str(result[-1]['generated_at']) if len(result) >= limit else '0000-01-01'
    reader = cold_reader or archived_predictions
    with closing(reader(start, '9999-12-31T23:59:59', date_column='generated_at',
                        model_name='ensemble', query_hot=query_hot)) as cold:
        first = next(cold, None)
        if first is None:
            return result
        schemas = query_hot("SELECT sql FROM sqlite_master WHERE type='table' AND name='predictions'", [])
        if len(schemas) != 1 or not schemas[0].get('sql'):
            raise RuntimeError('retention_prediction_schema_missing')
        with closing(sqlite3.connect(':memory:')) as db:
            db.row_factory = sqlite3.Row
            db.execute(schemas[0]['sql'])
            count = byte_count = 0
            def flush():
                nonlocal result, count, byte_count
                # Stable merge leaves existing hot ordering unchanged for ties.
                result = sorted([*result, *(dict(row) for row in db.execute(sql, params))],
                                key=lambda row: row['generated_at'], reverse=True)[:limit]
                db.execute('DELETE FROM predictions')
                count = byte_count = 0
            from itertools import chain
            for row in chain((first,), cold):
                size = len(json.dumps(row, ensure_ascii=False).encode())
                if count and (count >= 250 or byte_count + size > 1024 * 1024):
                    flush()
                columns = list(row)
                db.execute('INSERT INTO predictions (' + ','.join(map(_ident, columns)) + ') VALUES ('
                           + ','.join('?' for _ in columns) + ')', list(row.values()))
                count += 1; byte_count += size
            if count:
                flush()
    return result
