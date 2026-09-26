"""Append-only research observations. Legacy recovery never seals a search."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any

TABLES = {'source': 'research_trial_sources_v1', 'run': 'research_trial_runs_v1',
          'trial': 'research_trial_observations_v1'}
SCHEMA = 'research-trial-observation-v1'


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def checksum(value: Any) -> str:
    return hashlib.sha256(encode(value).encode()).hexdigest()


def observation(kind: str, *, run_key: str, logical_id: str, source: dict, content: dict) -> dict:
    if kind not in TABLES or not run_key or not logical_id:
        raise ValueError('research_ledger_identity_invalid')
    if (not isinstance(source.get('pointer'), str) or not source['pointer']
            or len(source.get('sha256', '')) != 64
            or any(c not in '0123456789abcdef' for c in source['sha256'])):
        raise ValueError('research_ledger_source_unpinned')
    body = {'schema_version': SCHEMA, 'kind': kind, 'run_key': run_key,
            'logical_id': logical_id, 'source': source, 'content': content}
    return {'receipt_id': checksum(body), 'payload': body}


def assert_schema(query):
    rows=query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN (?,?,?)", list(TABLES.values()))
    definitions={r['name']:r['sql'] or '' for r in rows}
    for table in TABLES.values():
        for suffix,operation in (('update','UPDATE'),('delete','DELETE'),('replace','INSERT')):
            sql=definitions.get(table+'_no_'+suffix,'')
            if not re.search(r'BEFORE\s+'+operation+r'\s+ON\s+'+table,sql,re.I) or 'research_ledger_immutable' not in sql:
                raise RuntimeError('research_ledger_immutable_schema_missing')


def append(record: dict, *, query, writer) -> str:
    body, rid = record['payload'], record['receipt_id']
    if checksum(body) != rid or body.get('schema_version') != SCHEMA:
        raise ValueError('research_ledger_checksum_invalid')
    table = TABLES[body['kind']]
    assert_schema(query)
    writer([(f'INSERT INTO {table}(receipt_id,run_key,logical_id,payload_json,recorded_at) '
             'SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM '+table+' WHERE receipt_id=?)',
             [rid, body['run_key'], body['logical_id'], encode(body), datetime.now(timezone.utc).isoformat(),rid])])
    rows = query(f'SELECT run_key,logical_id,payload_json FROM {table} WHERE receipt_id=?', [rid])
    if (len(rows) != 1 or rows[0]['payload_json'] != encode(body)
            or rows[0]['run_key']!=body['run_key'] or rows[0]['logical_id']!=body['logical_id']):
        raise RuntimeError('research_ledger_publication_mismatch')
    return rid


def verified_rows(kind: str, *, query, run_key: str | None = None, limit: int = 10000) -> list[dict]:
    table = TABLES[kind]
    assert_schema(query)
    if not 1 <= limit <= 10000:
        raise ValueError('research_ledger_limit_invalid')
    sql = f'SELECT receipt_id,run_key,logical_id,payload_json FROM {table}'
    params: list[Any] = []
    if run_key is not None:
        sql += ' WHERE run_key=?'; params.append(run_key)
    rows = query(sql + ' ORDER BY receipt_id LIMIT ?', [*params, limit + 1])
    if len(rows) > limit:
        raise ValueError('research_ledger_truncated_read')
    results = []
    for row in rows:
        body = json.loads(row['payload_json'])
        if (checksum(body) != row['receipt_id'] or body.get('schema_version') != SCHEMA
                or body.get('run_key')!=row['run_key'] or body.get('logical_id')!=row['logical_id']
                or body.get('kind') != kind or (run_key is not None and body.get('run_key') != run_key)):
            raise ValueError('research_ledger_corrupt')
        results.append({'receipt_id': row['receipt_id'], **body})
    return results


def search_inventory(run_key: str, *, query) -> dict:
    runs = verified_rows('run', query=query, run_key=run_key)
    trials = verified_rows('trial', query=query, run_key=run_key)
    grouped: dict[str, list[dict]] = {}
    for row in trials:
        grouped.setdefault(row['logical_id'], []).append(row)
    conflicts, selected = [], []
    for trial_id, versions in sorted(grouped.items()):
        # Full generation-pinned artifacts retain fields omitted from D1 projections.
        # Keep every observation and flag parameter disagreements instead of merging.
        parameters = [v['content'].get('parameters') for v in versions]
        shared = set.intersection(*(set(p) for p in parameters)) if all(isinstance(p,dict) for p in parameters) else set()
        identities = {checksum({k:p[k] for k in sorted(shared)} if shared else p) for p in parameters}
        if len(identities) > 1:
            conflicts.append(trial_id)
        chosen = sorted(versions, key=lambda v: (v['source']['pointer'].startswith('gs://'), v['receipt_id']))[-1]
        selected.append({**chosen, 'source_receipts': [v['receipt_id'] for v in versions]})
    seals = [r for r in runs if r['content'].get('coverage') == 'sealed_complete']
    ids = [r['logical_id'] for r in selected]
    sealed = any(r['content'].get('trial_ids') == ids for r in seals) and not conflicts
    return {'schema_version': 'research-search-inventory-v1', 'run_key': run_key,
            'runs': runs, 'trials': selected, 'known_trial_count': len(ids),
            'observation_count': len(trials), 'parameter_conflicts': conflicts,
            'coverage': 'sealed_complete' if sealed else 'partial',
            'unknown_trials_possible': not sealed, 'promotion_authority': False}


def optuna_trial(trial, *, run_key: str, source: dict, context: dict) -> dict:
    """Capture COMPLETE/FAIL/PRUNED rather than only study.best_trial."""
    return observation('trial', run_key=run_key, logical_id=f'trial-{trial.number}', source=source,
        content={'state': trial.state.name.lower(), 'optimizer_state':trial.state.name.lower(),
                 'evaluation_scope':context.get('evaluation_scope','optimization'),
                 'parameters': dict(trial.params),
                 'distributions':{name:{'type':type(dist).__name__,
                    **{key:getattr(dist,key) for key in ('low','high','log','step','choices') if hasattr(dist,key)}}
                    for name,dist in getattr(trial,'distributions',{}).items()},
                 'values': trial.values, 'user_attributes': dict(trial.user_attrs),
                 'search_metrics':{'reported_sharpe':trial.user_attrs.get('portfolio_sharpe',trial.user_attrs.get('sharpe'))},
                 'validation': {'sharpe':trial.user_attrs.get('validation_sharpe',
                    trial.user_attrs.get('sharpe') if context.get('evaluation_scope')=='validation' else None)},
                 'validation_window':context.get('validation') if context.get('evaluation_scope')=='validation' else None,
                 'search_window':context.get('search_window'),
                 'configuration_checksum':trial.user_attrs.get('resolved_configuration_checksum'),
                 'validation_dates':trial.user_attrs.get('validation_dates'),
                 'validation_daily_returns':trial.user_attrs.get('validation_daily_returns'),
                 'execution':context.get('execution'), 'sample_count':trial.user_attrs.get('n_trades'),
                 'data_snapshot': context.get('data_snapshot'),
                 'cost': context.get('cost'), 'coverage': 'live_terminal_trial',
                 'gaps': [*context.get('gaps',[]), *([] if context.get('data_snapshot') and context.get('cost') else ['evaluation_context_incomplete'])]})
