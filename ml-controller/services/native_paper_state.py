"""Prepare private native state using the SAME formal recommendation serializer.

Inputs must be pre-execution frozen source rows. These functions do not query,
mutate, or delete production data. They cannot create new screener candidates.
"""
from __future__ import annotations

from copy import deepcopy
import json
from typing import Any

from services.native_paper_sandbox import PrivatePaperStore
from services.paired_nav_journal import digest, encode


def prepare_native_state(*, base_state: dict[str, str], seed_rows: list[dict[str, Any]],
                         recommendations: list[dict[str, Any]], signal_date: str,
                         trading_config: dict, risk_config: dict,
                         stock_rows: list[dict[str, Any]] | None = None,
                         frozen_kv: dict[str, str | None] | None = None) -> dict:
    from services.recommendation_service import (
        build_recommendation_update_statements, build_filtered_recommendation_update_statements)

    store = PrivatePaperStore(base_state['state_sql'], base_state['state_checksum'], {})
    try:
        if stock_rows is not None:
            stock_columns = {row['name'] for row in store.db.execute('PRAGMA table_info(stocks)')}
            identities, stock_symbols = set(), set()
            for row in sorted(stock_rows, key=lambda item: item['id']):
                identity, symbol = row.get('id'), row.get('symbol')
                if type(identity) is not int or identity <= 0 or not symbol or identity in identities or symbol in stock_symbols:
                    raise ValueError('native_state_stock_master_invalid')
                identities.add(identity)
                stock_symbols.add(symbol)
                existing = store.db.execute('SELECT id,symbol FROM stocks WHERE id=? OR symbol=?', (identity, symbol)).fetchall()
                if existing and (len(existing) != 1 or existing[0]['id'] != identity or existing[0]['symbol'] != symbol):
                    raise ValueError('native_state_stock_identity_reassigned')
                fields = sorted(set(row) & stock_columns)
                if existing:
                    update = [key for key in fields if key != 'id']
                    store.db.execute('UPDATE stocks SET ' + ','.join(key + '=?' for key in update) + ' WHERE id=?',
                                     [row[key] for key in update] + [identity])
                else:
                    if any(not row.get(key) for key in ('added_at', 'updated_at') if key in stock_columns):
                        raise ValueError('native_state_new_stock_source_timestamps_missing')
                    store.db.execute('INSERT INTO stocks(' + ','.join(fields) + ') VALUES(' + ','.join('?' for _ in fields) + ')',
                                     [row[key] for key in fields])
        columns = {row['name'] for row in store.db.execute('PRAGMA table_info(daily_recommendations)')}
        if not columns:
            raise ValueError('native_state_recommendation_schema_missing')
        seeds = deepcopy(seed_rows)
        ids, symbols = set(), set()
        for row in seeds:
            stock_id, symbol = row.get('stock_id'), row.get('symbol')
            if (row.get('date') != signal_date or type(stock_id) is not int or stock_id <= 0
                    or not symbol or stock_id in ids or symbol in symbols or not row.get('created_at')):
                raise ValueError('native_state_seed_identity_invalid')
            identity = store.db.execute('SELECT symbol FROM stocks WHERE id=?', (stock_id,)).fetchone()
            if identity is None or identity['symbol'] != symbol:
                raise ValueError('native_state_seed_stock_identity_mismatch')
            ids.add(stock_id)
            symbols.add(symbol)
        allowed = [row for row in recommendations if row.get('stock_id') in ids]
        seed_symbols = {row['stock_id']: row['symbol'] for row in seeds}
        if any(type(row.get('stock_id')) is not int or row.get('symbol') != seed_symbols[row['stock_id']] for row in allowed):
            raise ValueError('native_state_recommendation_stock_identity_mismatch')
        if recommendations and not allowed:
            raise ValueError('native_state_screener_seed_missing')
        if len({row['stock_id'] for row in allowed}) != len(allowed):
            raise ValueError('native_state_duplicate_recommendation')
        # Only this signal date in the PRIVATE database is replaced, with exact
        # screener-owned input rows. Historical account/order state is retained.
        store.db.execute('DELETE FROM daily_recommendations WHERE date=?', (signal_date,))
        for row in sorted(seeds, key=lambda item: item['stock_id']):
            fields = sorted((set(row) & columns) - {'id'})
            store.db.execute('INSERT INTO daily_recommendations(' + ','.join(fields) + ') VALUES('
                + ','.join('?' for _ in fields) + ')', [row[key] for key in fields])
        # The source may already contain incumbent BUYs. A different candidate
        # slate must not inherit those BUYs for symbols it filtered out.
        # Preserve the seed and historical positions using the FORMAL non-buy
        # serializer, rather than inventing a second masking policy here.
        kept_symbols = {row['symbol'] for row in allowed}
        excluded = sorted(symbols - kept_symbols)
        statements = [*build_filtered_recommendation_update_statements(excluded, signal_date),
                      *build_recommendation_update_statements(allowed, signal_date)]
        for sql, args in statements:
            cursor = store.db.execute(sql, args)
            if cursor.rowcount != 1:
                raise ValueError('native_state_recommendation_update_incomplete')
        for key, value in (('trading:config', trading_config), ('trading:risk_config', risk_config)):
            if not isinstance(value, dict) or not value:
                raise ValueError('native_state_frozen_configuration_missing')
            store.db.execute('INSERT OR REPLACE INTO _native_private_kv VALUES(?,?,NULL,NULL)', (key, encode(value)))
        for key, raw in (frozen_kv or {}).items():
            if key not in {'ml:config', 'ml:config.debate_max_rounds', 'ml:adaptive_params'}:
                raise ValueError('native_state_unapproved_frozen_policy_key')
            store.db.execute('DELETE FROM _native_private_kv WHERE key=?', (key,))
            if raw is not None:
                json.loads(raw)
                store.db.execute('INSERT INTO _native_private_kv VALUES(?,?,NULL,NULL)', (key, raw))
        actual = [dict(row) for row in store.db.execute('SELECT * FROM daily_recommendations WHERE date=? ORDER BY stock_id',
                                                       (signal_date,))]
        return {**store.export(), 'seed_checksum': digest(seeds), 'recommendations_checksum': digest(actual),
                'ignored_nonseed_symbols': sorted(str(row['symbol']) for row in recommendations if row.get('stock_id') not in ids),
                'production_effect': False}
    finally:
        store.db.close()
