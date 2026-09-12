"""Candidate-specific inputs through the ORIGINAL OPS/Core merge, read-only."""
from copy import deepcopy

from services.paired_nav_journal import digest
from services.screener_seed_domain_merge import merge_screener_seed_domains


def materialize_candidate_screener_seeds(population, core_domains, formal_context):
    if core_domains.get('status') != 'materialized':
        return {'status': 'unavailable', 'reason': core_domains.get('reason', 'core_domain_replay_missing')}
    if (core_domains.get('output_checksum') != digest({k: v for k, v in core_domains.items() if k != 'output_checksum'})
            or core_domains.get('formal_context_checksum') != formal_context['content_checksum']):
        raise ValueError('atomic_candidate_core_domain_binding_invalid')
    cutoffs = {r['decision_universe_frozen_at'] for r in formal_context['inputs']['ops_seed_rows']}
    if len(cutoffs) != 1:
        raise ValueError('atomic_candidate_seed_cutoff_unavailable')
    cutoff = next(iter(cutoffs))
    scoring = {}
    for item in population['screener_seed_source']['items']:
        if item.get('stage') == 'scoring' and item.get('decision') == 'pass':
            scoring.setdefault(item['symbol'], []).append(item)
    stock_rows = [{**r, 'stock_id': r['id']} for r in core_domains['stock_rows']]
    definitions = {}
    for replacement in population['replacements']:
        key = replacement['definition_checksum']
        core = core_domains['definitions'][key]
        if core.get('status') != 'materialized':
            definitions[key] = deepcopy(core)
            continue
        seed = replacement.get('recommendation_seed') or {}
        if seed.get('status') != 'replayed' or not isinstance(seed.get('merge_items'), list):
            definitions[key] = {'status': 'unavailable', 'reason': 'candidate_l1_merge_items_missing'}
            continue
        try:
            items = seed['merge_items']
            symbols = [r['symbol'] for r in core['daily_rows']]
            if ([r.get('symbol') for r in items] != symbols or len(set(symbols)) != len(symbols)
                    or [r['symbol'] for r in seed['final_seed']] != symbols):
                raise ValueError('candidate_l1_core_scope_mismatch')
            ops_rows = []
            for index, item in enumerate(items, 1):
                symbol = item['symbol']
                if (item.get('stage') != 'l1_candidate_seed_after_overlay' or item.get('decision') != 'selected'
                        or item.get('rank') != index or not isinstance(item.get('evidence'), dict)
                        or 'l15_route_contrast' not in item['evidence']):
                    raise ValueError('candidate_l1_merge_item_invalid')
                raw = scoring.get(symbol, [])
                if not raw:
                    raise ValueError('candidate_original_scoring_missing:' + symbol)
                rank = min(r.get('rank') if r.get('rank') is not None else 999999 for r in raw)
                tied = [r for r in raw if (r.get('rank') if r.get('rank') is not None else 999999) == rank]
                if len({digest(r) for r in tied}) != 1:
                    raise ValueError('candidate_original_scoring_tie_timestamp_missing:' + symbol)
                original = tied[0]
                ops_rows.append(dict(screener_run_id=population['producer_run_id'], decision_universe_frozen_at=cutoff,
                    symbol=symbol, seed_name=item.get('name'), seed_stage=item['stage'], seed_reason_code=item.get('reasonCode'),
                    seed_rank=index, seed_score=item.get('scoreAfter'), seed_evidence=deepcopy(item['evidence']),
                    scoring_score=original.get('scoreAfter'), scoring_evidence=deepcopy(original.get('evidence')),
                    l1_evidence=deepcopy(item['evidence'])))
            inputs = dict(ops_seed_rows=ops_rows, daily_rows=deepcopy(core['daily_rows']), stock_rows=deepcopy(stock_rows))
            rows = merge_screener_seed_domains(run_date=population['signal_date'], **inputs)
            if {r['symbol'] for r in rows} != set(symbols):
                raise ValueError('candidate_original_merge_dropped_seed')
            definitions[key] = {'status': 'materialized', 'inputs': inputs, 'screener_recs': rows}
        except (ValueError, KeyError, TypeError) as exc:
            # Keep every definition, isolating missing candidate-only sources.
            definitions[key] = {'status': 'unavailable', 'reason': str(exc)}
    body = {'schema_version': 'atomic-screener-merge-replay-v1', 'status': 'materialized',
        'signal_date': population['signal_date'], 'core_domain_checksum': core_domains['output_checksum'],
        'definitions': definitions, 'production_effect': False, 'promotion_allowed': False, 'nav_maturity_credit': 0}
    return {**body, 'output_checksum': digest(body)}
