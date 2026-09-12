"""Daily canonical Atomic inputs, using the original per-slate payload builder.

Read-only source capture. This is pre-L2 work, not a prediction, execution,
historical PIT attestation, statistical assessment or promotion decision.
"""
from copy import deepcopy
from datetime import datetime, timezone
import re

from services.paired_nav_journal import digest, _timestamp
from services.payload_builder import build_ml_universe

PATH = '/api/internal/evidence-artifacts/atomic-population'


async def read_daily_population(*, signal_date, producer_run_id, query):
    import asyncio
    from services.paired_nav_atomic_continuation import registered_atomic_continuations
    from services.worker_config_client import worker_fetch
    # The read cutoff proves canonical publication preceded THIS observation.
    # The native execution owner still enforces the real next-session boundary.
    cutoff = datetime.now(timezone.utc).isoformat()
    continuations = await asyncio.to_thread(registered_atomic_continuations, signal_date=signal_date, query=query)
    population = await worker_fetch(PATH, method='POST', timeout=120.0, json_body={
        'signalDate': signal_date, 'producerRunId': producer_run_id, 'decisionDeadline': cutoff,
        **({'continuations': continuations} if continuations else {})})
    if population.get('continuations', []) != continuations:
        raise ValueError('paired_nav_atomic_continuation_response_mismatch')
    replacements = {r['definition_checksum']: r['replacement'] for r in population.get('replacements', [])}
    if any(replacements.get(item['definitionChecksum']) != item['replacement'] for item in continuations):
        raise ValueError('paired_nav_atomic_registered_definition_missing')
    return population


def _rows(packet):
    rows = packet.get('rows')
    if not isinstance(rows, list):
        raise ValueError('paired_nav_atomic_core_rows_missing')
    symbols = []
    for row in rows:
        seed = row.get('seed', {}).get('row', {}) if isinstance(row, dict) else {}
        symbol = seed.get('symbol')
        if (not isinstance(symbol, str) or not symbol or symbol != symbol.strip()
                or row.get('marketSegment') not in {'LISTED', 'OTC'}
                or type(row.get('eligibleForPendingBuy')) is not bool
                or not isinstance(row.get('watchPoints'), list)):
            raise ValueError('paired_nav_atomic_core_row_invalid')
        symbols.append(symbol)
    if len(symbols) != len(set(symbols)):
        raise ValueError('paired_nav_atomic_core_symbol_duplicate')
    return rows


def prepare_daily_inputs(population, *, signal_date, producer_run_id, formal_stocks, query,
                         screener_seed_context=None):
    """Keep every structural replacement, including explicit unavailable ones.

    Core is consulted only for stock identity, never candidate scores/eligibility.
    Those come from the acknowledged canonical seed replay, not today's mutable
    recommendation rows. No candidate-specific source can overwrite the baseline.
    """
    p = deepcopy(population)
    if (not isinstance(p, dict) or p.get('schema_version') != 'atomic-canonical-population-v1'
            or p.get('signal_date') != signal_date or p.get('producer_run_id') != producer_run_id
            or not re.fullmatch('[a-f0-9]{64}', str(p.get('source_checksum')))
            or not p.get('canonical_artifact_id')
            or not re.fullmatch('sha256:[a-f0-9]{64}', str(p.get('canonical_artifact_checksum')))
            or p.get('production_effect') is not False or p.get('promotion_allowed') is not False
            or type(p.get('nav_maturity_credit')) is not int or p['nav_maturity_credit'] != 0
            or not isinstance(p.get('replacements'), list)):
        raise ValueError('paired_nav_atomic_population_invalid')
    if not (_timestamp(p['source_observed_at']) <= _timestamp(p['artifact_created_at'])
            < _timestamp(p['decision_deadline']) <= datetime.now(timezone.utc)):
        raise ValueError('paired_nav_atomic_population_time_invalid')
    if p.get('policy_context') is not None:
        from services.paired_nav_atomic_policy import validate_atomic_policy
        validate_atomic_policy(p)
    seed_boundary = None
    if screener_seed_context is not None:
        from services.screener_seed_domain_merge import verify_canonical_seed_boundary
        seed_boundary = verify_canonical_seed_boundary(p, screener_seed_context)
    baseline = p.get('baseline') or {}
    if baseline.get('status') != 'matched':
        raise ValueError('paired_nav_atomic_baseline_core_unavailable')
    baseline_rows = _rows(baseline)
    definitions, materialized = set(), {}
    for replacement in p['replacements']:
        definition = replacement.get('definition_checksum')
        if (not re.fullmatch('[a-f0-9]{64}', str(definition)) or definition in definitions
                or not isinstance(replacement.get('replacement'), dict)):
            raise ValueError('paired_nav_atomic_definition_invalid')
        definitions.add(definition)
        candidate = replacement.get('candidate') or {}
        if candidate.get('status') == 'materialized':
            materialized[definition] = _rows(candidate)
        elif candidate.get('status') != 'unavailable' or not candidate.get('reason'):
            raise ValueError('paired_nav_atomic_candidate_state_invalid')
    required = sorted({row['seed']['row']['symbol'] for rows in [baseline_rows, *materialized.values()] for row in rows})
    identities = {}
    for start in range(0, len(required), 80):
        chunk = required[start:start + 80]
        for row in query(f"SELECT id,symbol FROM stocks WHERE symbol IN ({','.join('?' for _ in chunk)})", chunk):
            if (type(row.get('id')) is not int or row['id'] <= 0 or row.get('symbol') not in chunk
                    or row['symbol'] in identities or row['id'] in identities.values()):
                raise ValueError('paired_nav_atomic_stock_identity_invalid')
            identities[row['symbol']] = row['id']
    if set(identities) != set(required):
        raise ValueError('paired_nav_atomic_stock_identity_missing')

    def stocks(rows):
        return build_ml_universe([], [dict(stock_id=identities[r['seed']['row']['symbol']],
            symbol=r['seed']['row']['symbol'], name=r['seed']['row'].get('name'),
            sector=r['seed']['row'].get('sector'), market_segment=r['marketSegment'],
            recommendation_lane='tradable', eligible_for_pending_buy=r['eligibleForPendingBuy'],
            watch_points=r['watchPoints']) for r in rows])

    baseline_stocks = stocks(baseline_rows)
    fields = ('id', 'symbol', 'market', 'market_segment', 'recommendation_lane',
              'eligible_for_pending_buy', 'eligible_for_execution', 'eligible_for_ml')
    project = lambda rows: [{key: row.get(key) for key in fields} for row in rows]
    if project(baseline_stocks) != project(formal_stocks):
        raise ValueError('paired_nav_atomic_formal_universe_mismatch')
    slates = {definition: stocks(rows) for definition, rows in materialized.items()}
    core_domains = merged_seeds = None
    if seed_boundary is not None:
        from services.screener_core_replay import materialize_atomic_core_domains
        from services.screener_candidate_merge import materialize_candidate_screener_seeds
        core_domains = materialize_atomic_core_domains(p, screener_seed_context)
        merged_seeds = materialize_candidate_screener_seeds(p, core_domains, screener_seed_context)
        if merged_seeds.get('status') == 'materialized':
            # Actual own-slate payload/ML consumers now receive the original
            # merge's metadata and preserved eligibility, not a Core shortcut.
            slates = {key: build_ml_universe([], value['screener_recs'])
                for key, value in merged_seeds['definitions'].items() if value['status'] == 'materialized'}
            if any(stock['id'] != identities.get(stock['symbol']) for rows in slates.values() for stock in rows):
                raise ValueError('paired_nav_atomic_frozen_core_identity_changed')
    union = {stock['symbol']: deepcopy(stock) for stock in formal_stocks}
    for rows in slates.values():
        for stock in rows:
            prior = union.setdefault(stock['symbol'], deepcopy(stock))
            if any(prior.get(field) != stock.get(field) for field in ('id', 'symbol', 'market', 'market_segment')):
                raise ValueError('paired_nav_atomic_shared_identity_changed')
    body = {'schema_version': 'paired-nav-atomic-daily-inputs-v1', 'signal_date': signal_date,
        'producer_run_id': producer_run_id, 'population': p, 'formal_stocks': deepcopy(formal_stocks),
        'candidate_stocks': slates, 'required_stocks': sorted(union.values(), key=lambda row: row['id']),
        'observed_at': datetime.now(timezone.utc).isoformat(), 'status': 'pre_l2_inputs_captured',
        'production_effect': False, 'promotion_allowed': False, 'nav_maturity_credit': 0}
    if seed_boundary is not None:
        body['screener_seed_boundary'] = seed_boundary
        body['core_domain_replay'] = core_domains
        body['candidate_recommendation_seeds'] = merged_seeds
    return {**body, 'input_checksum': digest(body)}


def validate_daily_inputs(packet, *, signal_date, producer_run_id, formal_stocks):
    if (not isinstance(packet, dict) or packet.get('schema_version') != 'paired-nav-atomic-daily-inputs-v1'
            or packet.get('signal_date') != signal_date or packet.get('producer_run_id') != producer_run_id
            or packet.get('formal_stocks') != formal_stocks
            or packet.get('input_checksum') != digest({k: v for k, v in packet.items() if k != 'input_checksum'})):
        raise ValueError('paired_nav_atomic_frozen_inputs_invalid')
    return deepcopy(packet)


def daily_setup_status(state):
    """Input preparation is not native execution; never manufacture closure."""
    from services.paired_nav_collection import shadow_failure
    saved = state.get('paired_nav_atomic_inputs')
    if isinstance(saved, dict) and saved.get('status') == 'failed':
        return deepcopy(saved)
    try:
        packet = validate_daily_inputs(saved, signal_date=state['run_date'], producer_run_id=state['screener_run_id'],
                                       formal_stocks=state['active_stocks'])
        count = len(packet['population']['replacements'])
        summary = {'input_checksum': packet['input_checksum'], 'replacement_count': count,
            'production_effect': False, 'promotion_allowed': False, 'nav_maturity_credit': 0}
        if not count:
            return {**summary, 'status': 'no_structural_candidates'}
        pre_l2 = state.get('paired_nav_atomic_pre_l2') or {}
        if pre_l2.get('status') == 'failed':
            return {**summary, **deepcopy(pre_l2)}
        for name in ('paired_nav_atomic_dispatch', 'paired_nav_atomic_ml', 'paired_nav_atomic_personas',
                     'paired_nav_atomic_recommendation', 'paired_nav_atomic_allocation'):
            stage = state.get(name) or {}
            if stage.get('status') == 'failed':
                return {**summary, **deepcopy(stage)}
        ml = state.get('paired_nav_atomic_ml') or {}
        if ml:
            personas = state.get('paired_nav_atomic_personas') or {}
            registered = (state.get('paired_nav_collection') or {}).get('atomic_collection') or {}
            if registered.get('status') == 'native_execution_pairs_registered':
                if (registered.get('definition_count') != count or len(registered.get('plans', [])) != count
                        or registered.get('selection_materialization_complete') is not True
                        or registered.get('native_execution', {}).get('status') != 'native_execution_pairs_registered'
                        or len(registered['native_execution'].get('registrations', [])) != count):
                    raise ValueError('paired_nav_atomic_registration_summary_incomplete')
                return {**summary, 'status': 'native_execution_pairs_registered',
                    'execution_status': 'awaiting_native_session', 'nav_maturity_credit': 0,
                    'registered_definition_count': count, 'production_effect': False, 'promotion_allowed': False}
            return {**summary, 'status': 'incomplete', 'reason': 'requires_allocation_and_native_execution',
                'ml_status': ml.get('status'),
                'persona_status': personas.get('status', 'not_computed'),
                'recommendation_status': (state.get('paired_nav_atomic_recommendation') or {}).get('status', 'not_computed'),
                'allocation_status': (state.get('paired_nav_atomic_allocation') or {}).get('status', 'not_computed'),
                'persona_ready_definition_count': sum(r.get('status') == 'ready' for r in personas.get('definitions', {}).values()),
                'ml_ready_definition_count': sum(r.get('status') == 'ready' for r in ml.get('definitions', {}).values()),
                'ml_unavailable_definition_count': sum(r.get('status') != 'ready' for r in ml.get('definitions', {}).values())}
        l2 = state.get('paired_nav_atomic_l2') or {}
        if l2.get('status') == 'failed':
            return {**summary, **deepcopy(l2)}
        if l2:
            return {**summary, 'status': 'incomplete', 'reason': 'requires_ml_and_native_execution',
                'l2_status': l2.get('status'),
                'l2_ready_slate_count': sum(r.get('status') == 'ready' for r in l2.get('slates', {}).values()),
                'l2_failed_slate_count': sum(r.get('status') != 'ready' for r in l2.get('slates', {}).values()),
                'unavailable_replacement_count': count - len(packet['candidate_stocks'])}
        return {**summary, 'status': 'incomplete', 'reason': 'requires_l2_ml_and_native_execution',
            'materialized_slate_count': len(packet['candidate_stocks']),
            'unavailable_replacement_count': count - len(packet['candidate_stocks'])}
    except Exception as exc:
        return shadow_failure('atomic_daily_setup', exc)
