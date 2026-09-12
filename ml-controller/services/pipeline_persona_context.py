"""One observed sentiment source and one persona calculator for every slate.

Captures are observations made now, not historical as-of attestations. Only
the caller may persist formal opinions; candidate computations have no writes.
"""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone, timedelta
import math

from services.paired_nav_journal import digest, _timestamp
from services.paired_nav_collection import shadow_failure
from services.persona_service import (ChipBar, MarginBar, PersonaOpinions,
    compute_trust_opinion, compute_retail_opinion)


def persona_inputs(payloads):
    """The persona is per stock, not cross-sectional: only chips are consumed."""
    result = {}
    for payload in payloads:
        symbol = payload.get('symbol')
        if not isinstance(symbol, str) or not symbol or symbol != symbol.strip():
            raise ValueError('paired_nav_persona_symbol_missing')
        item = {'symbol': symbol, 'chips': deepcopy(payload.get('chips') or [])}
        if symbol in result and result[symbol] != item:
            raise ValueError('paired_nav_persona_shared_raw_inputs_changed')
        result[symbol] = item
    return result


def _capture_calendar(run_date, read_holiday, previous=None):
    today = date.fromisoformat(run_date)
    if today.month not in {3, 6, 9, 12}:
        return {'status': 'not_quarter_month', 'scheduled_dates': []}
    weekdays, day = [], today
    while day.month == today.month:
        if day.weekday() < 5:
            weekdays.append(day.isoformat())
        day += timedelta(days=1)
    if previous and previous.get('status') == 'captured':
        raw = previous.get('holiday_observations') or {}
        if (previous.get('owner') != 'worker_weekend_and_kv_holiday'
                or set(raw) != set(weekdays)
                or any(v is not None and not isinstance(v, str) for v in raw.values())
                or previous.get('scheduled_dates') != [d for d in weekdays if not raw[d]]
                or _timestamp(previous['observed_at']) > datetime.now(timezone.utc)):
            raise ValueError('paired_nav_persona_calendar_frozen_invalid')
        return deepcopy(previous)
    try:
        if read_holiday is None:
            raise ValueError('paired_nav_persona_quarter_calendar_missing')
        # Same business-day owner as Worker dateUtils.getSettlementDate:
        # weekend exclusion + truthiness of raw holiday:YYYY-MM-DD KV values.
        # A successful 404 is an observed absence; an HTTP error is NOT 404.
        with ThreadPoolExecutor(max_workers=4) as executor:
            values = list(executor.map(read_holiday, ['holiday:' + d for d in weekdays]))
        if any(v is not None and not isinstance(v, str) for v in values):
            raise ValueError('paired_nav_persona_holiday_value_invalid')
        return {'status': 'captured', 'owner': 'worker_weekend_and_kv_holiday',
            'observed_at': datetime.now(timezone.utc).isoformat(),
            'failed_attempts': deepcopy((previous or {}).get('failed_attempts', [])),
            'holiday_observations': dict(zip(weekdays, values)),
            'scheduled_dates': [d for d, value in zip(weekdays, values) if not value]}
    except Exception as exc:
        failure = shadow_failure('persona_calendar', exc)
        observed_at = datetime.now(timezone.utc).isoformat()
        return {**failure, 'observed_at': observed_at, 'failed_attempts': [
            *(previous or {}).get('failed_attempts', []), {'observed_at': observed_at, 'failure': failure}]}


def capture_persona_context(*, run_date, formal_payloads, extra_payloads, query, saved=None, read_holiday=None):
    """Retry only failed/missing reads; never replace a completed observation.

Formal symbols are read first. Candidate-only provider failures cannot discard
formal observations. Shared symbols inherit the same observation, not a second
query with a later value. Every successful empty source is recorded explicitly.
"""
    date.fromisoformat(run_date)
    formal = persona_inputs(formal_payloads)
    wanted = persona_inputs([*formal_payloads, *extra_payloads])
    observations = {}
    if saved is not None:
        if (saved.get('schema_version') != 'pipeline-persona-context-v1'
                or saved.get('signal_date') != run_date
                or saved.get('formal_symbols') != sorted(formal)
                or saved.get('source_checksum') != digest({k: v for k, v in saved.items() if k != 'source_checksum'})):
            raise ValueError('paired_nav_persona_frozen_context_invalid')
        observations = deepcopy(saved['observations'])
        for symbol, item in observations.items():
            # A later candidate validation failure must not make an otherwise
            # valid formal retry depend on that candidate's current availability.
            # Retain past observations; no dropped candidate gets success credit.
            if (symbol in wanted and item['input_checksum'] != digest(wanted[symbol])
                    or _timestamp(item['observed_at']) > datetime.now(timezone.utc)):
                raise ValueError('paired_nav_persona_frozen_inputs_changed')

    # A theme is a common fact even when two distinct stocks share it. Reuse
    # its first successful (including empty) observation across chunks/retries.
    theme_observations = {}
    for item in observations.values():
        if item.get('status') == 'captured' and item['taxonomy_rows']:
            concept = item['taxonomy_rows'][0]['tag']
            value = item['buzz_row']
            if concept in theme_observations and theme_observations[concept] != value:
                raise ValueError('paired_nav_persona_shared_theme_changed')
            theme_observations[concept] = deepcopy(value)
    # Keep the existing top-weight FinLab industry_theme / PTT intent. Explicit
    # source selection also removes nondeterministic last-row-wins across feeds.
    groups = [list(formal), [s for s in wanted if s not in formal]]
    for group in groups:
        missing = [s for s in group if observations.get(s, {}).get('status') != 'captured']
        for start in range(0, len(missing), 75):
            symbols = missing[start:start + 75]
            cutoff = datetime.now(timezone.utc).isoformat()
            try:
                placeholders = ','.join('?' for _ in symbols)
                tags = query('SELECT symbol,tag,weight,as_of_date,created_at FROM finlab_taxonomy_tags '
                    "WHERE tag_type='industry_theme' AND source='finlab.security_industry_themes' "
                    f'AND symbol IN ({placeholders}) AND date(as_of_date)<=date(?) '
                    'AND datetime(created_at)<=datetime(?) ORDER BY symbol,weight DESC,tag',
                    [*symbols, run_date, cutoff]) or []
                by_symbol = {s: [] for s in symbols}
                for row in tags:
                    if row.get('symbol') not in by_symbol:
                        raise ValueError('paired_nav_persona_taxonomy_membership_invalid')
                    by_symbol[row['symbol']].append(deepcopy(row))
                concepts = sorted({rows[0]['tag'] for rows in by_symbol.values()
                                   if rows and rows[0]['tag'] not in theme_observations})
                buzz = []
                if concepts:
                    buzz = query('SELECT date,concept,sentiment_avg,source,created_at FROM concept_buzz '
                        f"WHERE date=? AND source='ptt' AND concept IN ({','.join('?' for _ in concepts)}) "
                        'AND datetime(created_at)<=datetime(?) ORDER BY concept',
                        [run_date, *concepts, cutoff]) or []
                by_concept = {}
                for row in buzz:
                    concept = row.get('concept')
                    value = row.get('sentiment_avg')
                    if (concept not in concepts or concept in by_concept
                            or value is not None and (isinstance(value, bool) or not math.isfinite(float(value)))):
                        raise ValueError('paired_nav_persona_buzz_invalid')
                    by_concept[concept] = deepcopy(row)
                theme_observations.update({c: by_concept.get(c) for c in concepts})
                observed_at = datetime.now(timezone.utc).isoformat()
                for symbol in symbols:
                    rows = by_symbol[symbol]
                    selected = theme_observations.get(rows[0]['tag']) if rows else None
                    prior = observations.get(symbol)
                    attempts = deepcopy(prior.get('failed_attempts', [])) if prior else []
                    observations[symbol] = {'status': 'captured', 'input_checksum': digest(wanted[symbol]),
                        'observed_at': observed_at, 'query_cutoff': cutoff, 'taxonomy_rows': rows,
                        'buzz_row': selected, 'sentiment': float(selected['sentiment_avg'])
                            if selected and selected.get('sentiment_avg') is not None else None,
                        'failed_attempts': attempts}
            except Exception as exc:
                failure = shadow_failure('persona_source', exc)
                observed_at = datetime.now(timezone.utc).isoformat()
                for symbol in symbols:
                    prior = observations.get(symbol) or {}
                    observations[symbol] = {**failure, 'input_checksum': digest(wanted[symbol]),
                        'observed_at': observed_at, 'failed_attempts': [*prior.get('failed_attempts', []),
                            {'observed_at': observed_at, 'failure': failure}]}
    calendar = _capture_calendar(run_date, read_holiday, (saved or {}).get('calendar')) if wanted else {
        'status': 'empty_population', 'scheduled_dates': []}
    body = {'schema_version': 'pipeline-persona-context-v1', 'signal_date': run_date, 'calendar': calendar,
        'formal_symbols': sorted(formal),
        'knowledge_scope': 'observed_at_capture_not_historical_asof', 'observations': observations}
    return {**body, 'source_checksum': digest(body)}


def compute_payload_personas(*, payloads, run_date, context, allow_unavailable_sentiment=False):
    """Use the existing trust/retail algorithms, keyed by exchange symbol.

No chips remains an explicit no-op, as in the original daily node. Source or
numeric failures remain errors, not fabricated neutral observations.
"""
    today = date.fromisoformat(run_date)
    if (context.get('signal_date') != run_date
            or context.get('source_checksum') != digest({k: v for k, v in context.items() if k != 'source_checksum'})):
        raise ValueError('paired_nav_persona_context_invalid')
    inputs = persona_inputs(payloads)
    records, opinions, errors, no_chips = [], {}, {}, []
    for symbol, payload in inputs.items():
        try:
            observation = context['observations'].get(symbol) or {}
            if observation.get('input_checksum') != digest(payload):
                raise ValueError('paired_nav_persona_source_unavailable')
            if observation.get('status') != 'captured':
                if not allow_unavailable_sentiment:
                    raise ValueError('paired_nav_persona_source_unavailable')
                # Preserve the formal node's existing fail-soft behavior: trust
                # can still use chips, retail sees missing sentiment. Keep the
                # error visible and never count this as complete paired evidence.
                errors[symbol] = shadow_failure('persona_source',
                    ValueError('paired_nav_persona_source_unavailable'))
            chips = payload['chips']
            if not chips:
                no_chips.append(symbol)
                continue
            chip_bars, margin_bars, seen = [], [], set()
            for row in chips:
                day = row.get('date')
                if not day:
                    continue  # original semantics for non-dated source rows
                if date.fromisoformat(day) > today or day in seen:
                    raise ValueError('paired_nav_persona_chip_date_invalid')
                seen.add(day)
                for name, target, kind in (('trust_net', chip_bars, ChipBar), ('margin_balance', margin_bars, MarginBar)):
                    value = row.get(name)
                    if value is not None:
                        if isinstance(value, bool) or not math.isfinite(float(value)):
                            raise ValueError('paired_nav_persona_chip_numeric_invalid')
                        target.append(kind(date=day, **{name: float(value)}))
            chip_bars.sort(key=lambda r: r.date)
            margin_bars.sort(key=lambda r: r.date)
            calendar = context.get('calendar') or {}
            # A short history still yields the original no-signal opinion;
            # a usable quarter-month signal requires the observed schedule.
            trust = compute_trust_opinion(chip_bars, today,
                scheduled_trading_dates=calendar.get('scheduled_dates')
                    if calendar.get('status') in {'captured', 'not_quarter_month'} else None)
            retail = compute_retail_opinion(margin_bars, observation.get('sentiment'))
            records.append(PersonaOpinions(symbol=symbol, date=run_date, trust=trust, retail=retail))
            opinions[symbol] = {'trust': trust.to_dict(), 'retail': retail.to_dict()}
        except Exception as exc:
            errors[symbol] = shadow_failure('persona_compute', exc)
    return records, {'status': 'incomplete' if errors else 'personas_computed',
        'opinions': opinions, 'errors': errors, 'no_chip_symbols': no_chips,
        'input_checksum': digest(inputs), 'context_checksum': context['source_checksum']}
