"""Read-only pre-session private state capture with native table ownership.

Only the chosen paper account/history, immutable stock identities and existing
screener rows are copied. Market/model data are read through the sealed source
recorder, not copied from a future end-of-day database into an earlier frame.
"""
from __future__ import annotations

import hashlib
import re
import sqlite3
from datetime import date

from services.native_paper_sandbox import PrivatePaperStore
from services.paired_nav_journal import digest, encode

IDENTIFIER = re.compile(r'^[A-Za-z_][A-Za-z_0-9]*$')


def capture_native_bootstrap(*, domain_queries: dict, ownership: dict[str, str], account_id: int,
                             signal_date: str, frozen_kv: dict[str, str], max_rows: int = 100000) -> dict:
    if type(account_id) is not int or account_id <= 0:
        raise ValueError('native_bootstrap_account_invalid')
    date.fromisoformat(signal_date)
    if any(not IDENTIFIER.fullmatch(table) for table in ownership):
        raise ValueError('native_bootstrap_table_identifier_invalid')
    def collect():
        schema, rows, auxiliary = {}, {}, []
        for domain in sorted(set(ownership.values())):
            query = domain_queries[domain]
            # No row data from unrelated user/chat/research tables is copied.
            for item in query("SELECT name,sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL ORDER BY name", []):
                table = item['name']
                if ownership.get(table) == domain:
                    schema[table] = item['sql']
            for item in query("SELECT name,tbl_name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name", []):
                if ownership.get(item['tbl_name']) == domain:
                    auxiliary.append(item)
        for required in ('paper_accounts', 'paper_positions', 'paper_orders', 'paper_settlements',
                         'paper_daily_snapshots', 'paper_corporate_entitlements_v1', 'paper_corporate_sessions_v1',
                         'stocks', 'daily_recommendations'):
            if required not in schema:
                raise ValueError('native_bootstrap_required_schema_missing:' + required)
        for table in sorted(schema):
            domain = ownership[table]
            if domain != 'paper' and table not in {'stocks', 'daily_recommendations'}:
                continue
            query = domain_queries[domain]
            columns = query('PRAGMA table_info(' + table + ')', [])
            names = {column['name'] for column in columns}
            primary = [column['name'] for column in sorted(columns, key=lambda c: c['pk']) if column['pk']]
            if not primary:
                raise ValueError('native_bootstrap_table_order_missing:' + table)
            if table == 'paper_accounts':
                where, args = ' WHERE id=?', [account_id]
            elif 'account_id' in names:
                where, args = ' WHERE account_id=?', [account_id]
            elif table == 'daily_recommendations':
                where, args = ' WHERE date=?', [signal_date]
            else:
                # Paper-owned shared calibrations / pending state have no
                # account field in the native schema; clone them only at start.
                where, args = '', []
            copied = []
            while True:
                page = query('SELECT * FROM ' + table + where + ' ORDER BY ' + ','.join(primary) + ' LIMIT ? OFFSET ?',
                             [*args, 1000, len(copied)])
                copied.extend(page)
                if len(copied) > max_rows:
                    raise ValueError('native_bootstrap_copy_bound_exceeded:' + table)
                if len(page) < 1000:
                    break
            rows[table] = copied
        return {'schema': schema, 'rows': rows, 'auxiliary': auxiliary}

    first = collect()
    if digest(first) != digest(collect()):
        raise ValueError('native_bootstrap_source_changed_during_capture')
    if len(first['rows']['paper_accounts']) != 1:
        raise ValueError('native_bootstrap_account_missing_or_ambiguous')
    private_domains = {'paper', 'ops', 'execution'}
    source_tables = {table: ownership[table] for table in first['schema']
                     if ownership[table] not in private_domains and table not in {'stocks', 'daily_recommendations'}}
    db = sqlite3.connect(':memory:')
    db.set_authorizer(PrivatePaperStore._authorize)
    try:
        # Restore rows before triggers, as in a logical snapshot restore;
        # preserve every owner index/trigger for subsequent native execution.
        for table in sorted(first['schema']):
            db.execute(first['schema'][table])
        for table, rows in first['rows'].items():
            for row in rows:
                fields = sorted(row)
                if any(not IDENTIFIER.fullmatch(field) for field in fields):
                    raise ValueError('native_bootstrap_column_identifier_invalid')
                db.execute('INSERT INTO ' + table + '(' + ','.join(fields) + ') VALUES('
                           + ','.join('?' for _ in fields) + ')', [row[field] for field in fields])
        for item in first['auxiliary']:
            db.execute(item['sql'])
        db.execute('CREATE TABLE _native_private_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_ms REAL,metadata TEXT)')
        for key, raw in sorted(frozen_kv.items()):
            if not isinstance(raw, str):
                raise ValueError('native_bootstrap_kv_nontext')
            db.execute('INSERT INTO _native_private_kv VALUES(?,?,NULL,NULL)', (key, raw))
        raw = '\n'.join(db.iterdump())
    finally:
        db.close()
    return {'state_sql': raw, 'state_checksum': hashlib.sha256(raw.encode()).hexdigest(),
            'source_tables': source_tables, 'source_checksum': digest(first),
            'seed_rows': first['rows']['daily_recommendations'], 'stock_rows': first['rows']['stocks'],
            'production_effect': False}
