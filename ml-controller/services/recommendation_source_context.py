"""Original fundamental/sector loaders over one read-only observation ledger.

Successful observations (including absence) are immutable across retries.
Capture time is NOT historical knowledge time or NAV maturity authority.
"""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
from pathlib import Path

from services.paired_nav_journal import digest, _timestamp
from services.paired_nav_collection import shadow_failure


def source_identity():
    base = Path(__file__).parent
    return {name: hashlib.sha256((base / name).read_bytes()).hexdigest() for name in (
        'recommendation_source_context.py', 'recommendation_service.py',
        'fundamental_quality.py', 'pit_sector_alpha.py', 'sector_flow_pit_history.py')}


class FrozenSourceError(ValueError):
    pass


def _validate(saved, inputs):
    if (saved.get('schema_version') != 'recommendation-source-context-v1'
            or saved.get('source_checksum') != digest({k: v for k, v in saved.items() if k != 'source_checksum'})
            or saved.get('inputs') != inputs or saved.get('source_identity') != source_identity()):
        raise ValueError('recommendation_source_context_invalid')
    for key, item in saved['observations'].items():
        if (key != digest([item['domain'], item['sql'], item['params'], item['options']])
                or item['domain'] not in {'market', 'core'}
                or item['status'] not in {'captured', 'failed'}
                or not (_timestamp(item['started_at']) <= _timestamp(item['completed_at'])
                        <= _timestamp(saved['captured_at']) <= datetime.now(timezone.utc))):
            raise ValueError('recommendation_source_observation_invalid')


def capture_recommendation_sources(*, run_date, formal_recs, candidate_recs,
                                   knowledge_cutoff, query, core_query=None, saved=None, replay=False):
    from services.recommendation_service import load_fundamental_quality_by_symbol
    from services.pit_sector_alpha import load_pit_sector_alpha_experts

    inputs = deepcopy(dict(run_date=run_date, formal_recs=formal_recs,
        candidate_recs=candidate_recs, knowledge_cutoff=knowledge_cutoff))
    if saved is not None:
        _validate(saved, inputs)
    elif replay:
        raise ValueError('recommendation_source_replay_missing')
    observations = deepcopy((saved or {}).get('observations', {}))
    attempted, used = set(), []

    def read(sql, params, *, _domain='market', **options):
        key = digest([_domain, sql, params, options])
        used.append(key)
        prior = observations.get(key)
        if not prior or prior['status'] == 'failed' and key not in attempted and not replay:
            if replay:
                raise FrozenSourceError('recommendation_source_query_not_captured')
            started = datetime.now(timezone.utc).isoformat()
            item = dict(domain=_domain, sql=sql, params=deepcopy(params), options=deepcopy(options), started_at=started)
            try:
                reader = (core_query or query) if _domain == 'core' else query
                rows = reader(sql, params, **options)
                if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                    raise ValueError('paired_nav_source_query_rows_invalid')
                digest(rows)  # Reject unserializable/NaN responses before accepting a capture.
                item.update(status='captured', rows=deepcopy(rows))
            except Exception as exc:
                failure = shadow_failure('recommendation_source_query', exc)
                item.update(status='failed', error=failure['reason'], error_type=failure['error_type'])
            item['completed_at'] = datetime.now(timezone.utc).isoformat()
            item['failed_attempts'] = deepcopy((prior or {}).get('failed_attempts', []))
            if prior and prior['status'] == 'failed':
                item['failed_attempts'].append({k: v for k, v in prior.items() if k != 'failed_attempts'})
            observations[key] = item
            attempted.add(key)
        item = observations[key]
        if item['status'] != 'captured':
            raise FrozenSourceError(item['error'])
        return deepcopy(item['rows'])

    def fundamental(rows):
        start = len(used)
        values = load_fundamental_quality_by_symbol(rows, run_date, query_fn=read)
        seen = used[start:]
        errors = {}
        for row in rows:
            symbol = row['symbol']
            failures = []
            for table in ('canonical_revenue_monthly', 'canonical_fundamental_features'):
                matches = [observations[k] for k in seen if f'FROM {table}' in observations[k]['sql']
                           and symbol in observations[k]['params']]
                if not matches or any(r['status'] != 'captured' for r in matches):
                    failures.append(table + ':' + (matches[0].get('error', 'not_read') if matches else 'not_read'))
            if failures:
                errors[symbol] = failures
        return values, errors

    def sector(rows):
        start = len(used)
        try:
            values = load_pit_sector_alpha_experts(read,
                core_query_fn=lambda sql, params: read(sql, params, _domain='core'), signal_date=run_date,
                symbols=[r['symbol'] for r in rows], knowledge_cutoff=knowledge_cutoff,
                fallback_industry_by_symbol={r['symbol']: str(r.get('industry') or r.get('sector') or '') for r in rows})
            error = None
        except Exception as exc:
            values, error = {}, f'{type(exc).__name__}:{exc}'
        failures = [observations[k]['error'] for k in used[start:]
                    if k in observations and observations[k]['status'] != 'captured']
        return values, error, failures

    # Match the actual formal loader order before touching candidate-only stocks.
    formal_sector, sector_error, sector_failures = sector(formal_recs)
    formal_fundamental, formal_errors = fundamental(formal_recs)
    formal_symbols = {r['symbol'] for r in formal_recs}
    extras = {r['symbol']: r for rows in candidate_recs.values() for r in rows if r['symbol'] not in formal_symbols}
    extra_fundamental, extra_errors = fundamental([extras[s] for s in sorted(extras)])
    all_fundamental = {**formal_fundamental, **extra_fundamental}
    all_errors = {**formal_errors, **extra_errors}
    definitions = {}
    for key, rows in candidate_recs.items():
        values, error, failures = sector(rows)
        errors = {r['symbol']: all_errors[r['symbol']] for r in rows if r['symbol'] in all_errors}
        definitions[key] = dict(status='incomplete' if errors or error or failures else 'captured',
            fundamental_quality_by_symbol={r['symbol']: deepcopy(all_fundamental[r['symbol']]) for r in rows},
            pit_sector_alpha_by_symbol=values, fundamental_errors=errors, sector_load_error=error)
    formal = dict(status='incomplete' if formal_errors or sector_error or sector_failures else 'captured',
        fundamental_quality_by_symbol=formal_fundamental, pit_sector_alpha_by_symbol=formal_sector,
        fundamental_errors=formal_errors, sector_load_error=sector_error)
    if replay:
        if formal != saved['formal'] or definitions != saved['definitions']:
            raise ValueError('recommendation_source_replay_mismatch')
        return deepcopy(saved)
    body = dict(schema_version='recommendation-source-context-v1', inputs=inputs,
        source_identity=source_identity(), observations=observations, formal=formal, definitions=definitions,
        captured_at=datetime.now(timezone.utc).isoformat(),
        knowledge_scope='observed_at_capture_not_historical_asof',
        production_effect=False, promotion_allowed=False, nav_maturity_credit=0)
    return {**body, 'source_checksum': digest(body)}


def replay_recommendation_sources(context):
    return capture_recommendation_sources(**context['inputs'], query=None, saved=context, replay=True)
