"""Historical accounting evidence for research; never a live Paper receipt.

A retrieval made today may describe an old economic event. Its actual capture
clock stays intact. This contract cannot establish original live availability,
feature PIT, or execution parity. The existing Paper loader is unchanged.
"""
from copy import deepcopy
from datetime import datetime, timezone, timedelta
import json
import re

import polars as pl
from services.paired_nav_journal import digest
from services.paper_corporate_source import validate_source_schema

OWNER = 'research-corporate-history-v1'
COMPONENT = 'corporate_history_records'


class CorporateHistoryGap(ValueError):
    """Actionable evidence request; never a fitness score or permission to skip."""
    def __init__(self, *, session_date, blockers, outstanding_action_ids=()):
        self.requirements = {'session_date': session_date,
            'symbols': sorted(blockers),
            'blockers': {s:sorted(set(v)) for s,v in sorted(blockers.items())},
            'outstanding_action_ids': sorted(outstanding_action_ids),
            'resolution_policy': 'seal_new_snapshot_and_restart_search',
            'skip_candidate_allowed': False}
        super().__init__('corporate_history_required_terms_missing:' +
            json.dumps(self.requirements, sort_keys=True))


def timestamp(value):
    parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('corporate_history_timestamp_timezone_missing')
    return parsed


def make_history_record(snapshot, *, captured_at, source_refs, history_start, history_end):
    """Seal already-normalized facts; no date or missing economic term inference."""
    snap = deepcopy(snapshot)
    snap['schema_version'] = OWNER
    # This is the real retrieval clock, not a pretend historical observation.
    snap['observed_at'] = captured_at
    record = {'schema_version': OWNER, 'snapshot': snap,
        'snapshot_checksum': digest(snap), 'captured_at': captured_at,
        'history_start': history_start, 'history_end': history_end,
        'source_refs': deepcopy(source_refs),
        'evidence_semantic': 'historical_economic_accounting',
        'original_paper_receipt': False, 'decision_input_eligible': False,
        'execution_parity_credit': False}
    record['record_checksum'] = digest(record)
    validate_history_record(record)
    return record


def validate_history_record(record):
    if (record.get('schema_version') != OWNER
            or record.get('evidence_semantic') != 'historical_economic_accounting'
            or any(record.get(k) is not False for k in ('original_paper_receipt',
                'decision_input_eligible', 'execution_parity_credit'))):
        raise ValueError('corporate_history_semantic_invalid')
    body = {k:v for k,v in record.items() if k != 'record_checksum'}
    if record.get('record_checksum') != digest(body):
        raise ValueError('corporate_history_record_corrupt')
    snap = record['snapshot']
    if snap.get('schema_version') != OWNER or record['snapshot_checksum'] != digest(snap):
        raise ValueError('corporate_history_snapshot_corrupt')
    captured = timestamp(record['captured_at'])
    if timestamp(snap['observed_at']) != captured:
        raise ValueError('corporate_history_capture_mismatch')
    day = snap['session_date']
    start, end = record['history_start'], record['history_end']
    for value in (day, start, end):
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            raise ValueError('corporate_history_date_invalid')
        datetime.fromisoformat(value)
    if not start <= day <= end or end > captured.astimezone(timezone(timedelta(hours=8))).date().isoformat():
        raise ValueError('corporate_history_range_invalid')
    symbols = snap.get('covered_symbols')
    if not isinstance(symbols, list) or not symbols or symbols != sorted(set(symbols)):
        raise ValueError('corporate_history_universe_invalid')
    refs = record.get('source_refs')
    if not isinstance(refs, list) or not refs:
        raise ValueError('corporate_history_source_refs_missing')
    for source in refs:
        if (not source.get('dataset') or not source.get('uri')
                or not re.fullmatch(r'[0-9a-f]{64}', str(source.get('sha256', '')))
                or timestamp(source['fetched_at']) > captured):
            raise ValueError('corporate_history_source_ref_invalid')
    validate_source_schema(snap)
    if any(symbol not in symbols or not isinstance(reasons, list) or not reasons
            or any(not isinstance(reason, str) or not reason for reason in reasons)
            for symbol, reasons in snap['blockers'].items()):
        raise ValueError('corporate_history_blocker_scope_invalid')
    if any(a['ex_date'] > day for a in snap['actions']):
        raise ValueError('corporate_history_future_entitlement')
    return snap


def records_frame(records):
    rows = [{'session_date':r['snapshot']['session_date'], 'record_json':json.dumps(r, sort_keys=True)} for r in records]
    frame = pl.DataFrame(rows, schema={'session_date':pl.String, 'record_json':pl.String})
    load_history_tape(frame)
    return frame


def load_history_tape(frame):
    if frame is None or not {'session_date','record_json'} <= set(frame.columns) or frame.is_empty():
        raise ValueError('corporate_history_component_empty_or_invalid')
    tape = {}
    for row in frame.iter_rows(named=True):
        record = json.loads(row['record_json'])
        snap = validate_history_record(record)
        day = snap['session_date']
        if row['session_date'] != day or day in tape:
            raise ValueError('corporate_history_session_identity_invalid')
        tape[day] = snap
    return tape


def load_research_corporate_components(components, reader, *, allow_history=False):
    """Explicit research opt-in, never a fallback from malformed Paper data."""
    if allow_history and COMPONENT in components:
        return load_history_tape(reader(components[COMPONENT]))
    from services.backtest_corporate_accounting import load_corporate_tape
    uri = components.get('corporate_source_records')
    return load_corporate_tape(reader(uri) if uri else None)


def account_history_snapshot(snapshot, required_symbols, *, outstanding_action_ids=None):
    """Unresolved terms never become no-action; block the affected portfolio.

    A full research universe can contain an unrelated unknown event. Applying
    the live account's global blocker check to that entire universe would stop
    even portfolios that have no entitlement to that issuer.
    """
    required = set(required_symbols)
    blocked = {s:list(r) for s,r in snapshot['blockers'].items() if s in required}
    if outstanding_action_ids is not None:
        outstanding = set(outstanding_action_ids)
        for symbol, reasons in list(blocked.items()):
            # Historical compiler carries market-wide pending events. A later
            # buyer has no entitlement to an old event merely by owning its stock.
            held_stock_event = any(a['symbol']==symbol and a['kind']=='stock'
                and (a['ex_date']==snapshot['session_date'] or a['action_id'] in outstanding)
                for a in snapshot['actions'])
            if 'unverified_stock_action_ids' in snapshot:
                unverified = set(snapshot['unverified_stock_action_ids'].get(symbol, []))
                eligible = {a['action_id'] for a in snapshot['actions'] if a['symbol']==symbol
                            and (a['ex_date']==snapshot['session_date'] or a['action_id'] in outstanding)}
                held_stock_event = bool(unverified & eligible)
            if not held_stock_event:
                reasons = [r for r in reasons if r != 'stock_delivery_issuer_history_unverified']
            unresolved = set(snapshot.get('unresolved_outstanding_action_ids', {}).get(symbol, []))
            if not unresolved & outstanding:
                reasons = [r for r in reasons if r != 'outstanding_event_revision_unresolved']
            issuer_ids = snapshot.get('issuer_blocker_action_ids', {}).get(symbol, {})
            current_ids = {a['action_id'] for a in snapshot['actions']
                           if a['symbol'] == symbol and a['ex_date'] == snapshot['session_date']}
            eligible_ids = current_ids | outstanding
            reasons = [reason for reason in reasons if reason not in issuer_ids
                       or bool(set(issuer_ids[reason]) & eligible_ids)]
            if reasons:
                blocked[symbol] = reasons
            else:
                del blocked[symbol]
    for symbol in required - set(snapshot['covered_symbols']):
        blocked.setdefault(symbol, []).append('event_index_coverage_missing')
    if blocked:
        raise CorporateHistoryGap(session_date=snapshot['session_date'], blockers=blocked,
            outstanding_action_ids=outstanding_action_ids or ())
    scoped = deepcopy(snapshot)
    scoped['actions'] = [a for a in snapshot['actions'] if a['symbol'] in required]
    scoped['blockers'] = {}
    return scoped


def reconstruct_company_sessions(rows, *, days, symbols, captured_at, source_refs,
                                 issuer_evidence, other_events=None, cash_rounding_rules=(),
                                 event_catalogs=None, reviewed_stock_rules=()):
    """Compile one frozen company feed and official event census locally.

    The caller supplies the complete exchange census (including par changes).
    Unknown conversion/rights terms remain named blockers, never zero events.
    Fetching/refreshing is separate from this deterministic compiler.
    """
    from services.finlab_corporate_actions import normalize_dividend_announcements
    from services.mops_corporate_terms import enrich_stock_delivery_source
    from services.subscription_rights import enrich_subscription_source
    days = sorted(set(days)); symbols = sorted(set(symbols))
    if not days or not symbols or any(not re.fullmatch(r'[1-9][0-9A-Za-z]{3,7}', x) for x in symbols):
        raise ValueError('corporate_history_company_scope_required')
    if event_catalogs is not None:
        if other_events is not None:
            raise ValueError('corporate_history_multiple_census_owners')
        other_events = finlab_company_event_census(event_catalogs, days=days, source_refs=source_refs)
    if not isinstance(other_events, dict) or any(d not in other_events for d in days):
        raise ValueError('corporate_history_exchange_census_missing')
    if event_catalogs is None and not any(r['dataset']=='official.exchange_census' for r in source_refs):
        raise ValueError('corporate_history_exchange_census_provenance_missing')
    # Group complete revisions of each fiscal event once, not 30k rows per day.
    scoped = rows.filter(pl.col('stock_id').cast(pl.String).is_in(symbols))
    periods = {}
    by_day = {}
    for row in scoped.iter_rows(named=True):
        key = (str(row['stock_id']), str(row['股利所屬期間']))
        periods.setdefault(key, []).append(row)
        for col in ('除息交易日','除權交易日'):
            if row[col] is not None:
                by_day.setdefault(str(row[col])[:10], set()).add(key)
    pending = {}; records = []; outstanding_periods = {}
    for day in days:
        selected = set(by_day.get(day, ())) | set(outstanding_periods.values())
        relevant = [row for key in selected for row in periods.get(key, [])]
        frame = pl.DataFrame(relevant, schema=scoped.schema) if relevant else scoped.head(0)
        snap = normalize_dividend_announcements(frame, symbols=symbols, session_date=day,
            observed_at=timestamp(day+'T08:59:59.999999+08:00'), outstanding_action_ids=tuple(pending),
            outstanding_scope='union_component')
        snap['vendor_asof_cutoff'] = day+'T08:59:59.999999+08:00'
        snap['issuer_blocker_action_ids'] = {}
        # Only documents within their declared historical query bounds may join.
        for symbol in sorted({a['symbol'] for a in snap['actions']}):
            evidence = issuer_evidence.get(symbol)
            if evidence is None:
                continue
            evidence = deepcopy(evidence)
            evidence['documents'] = [d for d in evidence['documents'] if d['published_date'] < day]
            part = deepcopy({k: v for k, v in snap.items() if k != 'blockers'})
            # Existing blockers stay on snap; merge only new issuer findings.
            part['blockers'] = {}
            part['actions'] = [a for a in snap['actions'] if a['symbol']==symbol
                and evidence['query_start'] <= a['ex_date'] <= evidence['query_end']]
            if not part['actions']:
                continue
            enriched_ids = {a['action_id'] for a in part['actions']}
            part = enrich_subscription_source(enrich_stock_delivery_source(part,{symbol:evidence}),{symbol:evidence})
            snap['actions'] = [a for a in snap['actions'] if a['action_id'] not in enriched_ids]+part['actions']
            for key, reasons in part.get('blockers',{}).items():
                snap['blockers'][key] = sorted(set(snap['blockers'].get(key, [])) | set(reasons))
                for reason in reasons:
                    snap['issuer_blocker_action_ids'].setdefault(key, {})[reason] = sorted(enriched_ids)
        snap = apply_issuer_cash_rounding(snap, cash_rounding_rules, source_refs)
        snap = apply_reviewed_stock_rules(snap, reviewed_stock_rules, source_refs)
        snap['unverified_stock_action_ids'] = {}
        for action in snap['actions']:
            if action['kind'] == 'stock' and action.get('stock_terms_status') not in ('confirmed_schedule', 'awaiting_issuer_schedule'):
                snap['blockers'].setdefault(action['symbol'], []).append('stock_delivery_issuer_history_unverified')
                snap['unverified_stock_action_ids'].setdefault(action['symbol'], []).append(action['action_id'])
        valid=[]
        for action in snap['actions']:
            try:
                validate_source_schema({**snap,'actions':[action]})
            except (KeyError,TypeError,ValueError) as exc:
                snap['blockers'].setdefault(action['symbol'],[]).append('economic_terms_incomplete:'+action['kind']+':'+type(exc).__name__)
                continue
            valid.append(action)
        snap['actions']=valid
        valid_ids = {a['action_id'] for a in valid}
        for action_id, action in pending.items():
            if action_id not in valid_ids:
                snap['blockers'].setdefault(action['symbol'], []).append('outstanding_event_revision_unresolved')
                snap.setdefault('unresolved_outstanding_action_ids', {}).setdefault(action['symbol'], []).append(action_id)
        for event in other_events[day]:
            if event['symbol'] in symbols:
                snap['blockers'].setdefault(event['symbol'],[]).append('exchange_event_terms_required:'+event['kind'])
        for a in valid:
            pending[a['action_id']]=a
            outstanding_periods[a['action_id']] = (a['symbol'], a.get('fiscal_period',''))
        # An unknown stock schedule remains a receivable; never invent delivery.
        for key,a in list(pending.items()):
            last=a['rights']['payment_deadline'] if a['kind']=='subscription' else a['payable_date']
            if last and last<=day:
                pending.pop(key);outstanding_periods.pop(key,None)
        snap.pop('raw_source',None)
        snap['source_checksum']=digest({'refs':source_refs,'day':day,'actions':snap['actions'],'blockers':snap['blockers']})
        records.append(make_history_record(snap,captured_at=captured_at,source_refs=source_refs,
            history_start=days[0],history_end=days[-1]))
    return records_frame(records)


def verify_local_sources(source_refs):
    """Verify sealed inputs before compilation; never trust a supplied hash alone."""
    import hashlib
    from pathlib import Path
    from urllib.parse import urlparse, unquote
    for ref in source_refs:
        uri = urlparse(ref['uri'])
        if uri.scheme != 'file' or uri.netloc:
            raise ValueError('corporate_history_local_source_required')
        path = unquote(uri.path)
        if re.match(r'^/[A-Za-z]:/', path):
            path = path[1:]
        raw = Path(path).read_bytes()
        if hashlib.sha256(raw).hexdigest() != ref['sha256']:
            raise ValueError('corporate_history_raw_source_corrupt:' + ref['dataset'])


def validate_history_coverage(frame, *, days, symbols):
    """Required before publication; partial-universe diagnostics cannot become GA input."""
    tape = load_history_tape(frame)
    missing = sorted(set(days) - set(tape))
    if missing:
        raise ValueError('corporate_history_sessions_missing:' + ','.join(missing[:10]))
    for day in days:
        uncovered = sorted(set(symbols) - set(tape[day]['covered_symbols']))
        if uncovered:
            raise ValueError('corporate_history_symbols_missing:' + json.dumps(
                {'date': day, 'count': len(uncovered), 'symbols': uncovered[:20]}))
    return tape


def load_history_artifact(path, checksum):
    """Explicit operator-provided immutable research artifact; no network fallback."""
    import hashlib
    from pathlib import Path
    from io import BytesIO
    raw = Path(path).read_bytes()
    if not re.fullmatch(r'[a-f0-9]{64}', str(checksum or '')) or hashlib.sha256(raw).hexdigest() != checksum:
        raise ValueError('corporate_history_artifact_checksum_mismatch')
    frame = pl.read_parquet(BytesIO(raw))
    load_history_tape(frame)
    return frame


def apply_issuer_cash_rounding(snapshot, rules, source_refs):
    """Reviewed, event-specific issuer terms; never a universal rounding default.

    Document date identifies the economic resolution, not original availability.
    The source's real fetch clock and research-only semantics remain unchanged.
    """
    refs = {r['sha256'] for r in source_refs}
    result = deepcopy(snapshot)
    for rule in rules:
        if (rule.get('source_sha256') not in refs or rule.get('cash_rounding') != 'floor_twd'
                or rule.get('review_semantic') != 'issuer_event_terms_reviewed'
                or not re.search(r'元以下(?:全捨|無條件捨去|捨去)', re.sub(r'\s+', '', rule.get('excerpt', '')))
                or not rule.get('fiscal_period') or not rule.get('ex_date')
                or not rule.get('document_date') or rule['document_date'] > rule['ex_date']):
            raise ValueError('corporate_history_issuer_rounding_rule_invalid')
        for action in result['actions']:
            if (action['kind']=='cash' and action['symbol']==rule['symbol']
                    and action.get('fiscal_period')==rule['fiscal_period'] and action['ex_date']==rule['ex_date']):
                if action.get('cash_rounding') not in (None, rule['cash_rounding']):
                    raise ValueError('corporate_history_issuer_rounding_conflict')
                action['cash_rounding'] = rule['cash_rounding']
                action['cash_rounding_source_sha256'] = rule['source_sha256']
    return result


COMPANY_EVENT_CATALOGS = (
    'capital_reduction_tse:恢復買賣日期', 'capital_reduction_otc:恢復買賣日期',
    'par_value_change_tse:恢復買賣日期', 'par_value_change_otc:恢復買賣日期',
)


def finlab_company_event_census(catalogs, *, days, source_refs):
    """Frozen vendor event indexes; conversion prices never become share terms.

    Sparse columns represent issuers with events, not the selection universe.
    All four complete downloaded indexes are required, including par changes.
    Economic terms for each indexed event still block until separately proven.
    """
    from services.capital_corporate_source import action_date
    if set(catalogs) != set(COMPANY_EVENT_CATALOGS):
        raise ValueError('corporate_history_finlab_catalogs_incomplete')
    references = {r['dataset']: r for r in source_refs}
    if any('finlab.' + key not in references for key in COMPANY_EVENT_CATALOGS):
        raise ValueError('corporate_history_finlab_catalog_provenance_missing')
    census = {day: [] for day in sorted(set(days))}
    for name in COMPANY_EVENT_CATALOGS:
        frame = catalogs[name]
        if (not isinstance(frame, pl.DataFrame) or frame.is_empty()
                or 'date' not in frame.columns or frame.width < 2
                or frame['date'].null_count() or frame['date'].n_unique() != frame.height):
            raise ValueError('corporate_history_finlab_catalog_schema_invalid:' + name)
        symbols = [c for c in frame.columns if c != 'date']
        if any(not re.fullmatch(r'[1-9][0-9A-Za-z]{3,7}', c) for c in symbols):
            raise ValueError('corporate_history_finlab_catalog_symbol_invalid')
        count = 0
        for row in frame.iter_rows(named=True):
            catalog_day = action_date(row['date'])
            for symbol in symbols:
                value = row[symbol]
                if value is None:
                    continue
                event_day = action_date(value)
                if event_day != catalog_day:
                    raise ValueError('corporate_history_finlab_catalog_date_conflict')
                count += 1
                if event_day in census:
                    census[event_day].append({'symbol': symbol, 'kind': name.split(':')[0]})
        if not count:
            raise ValueError('corporate_history_finlab_catalog_no_observed_events:' + name)
    return census


def reconstruct_etf_sessions(rows, *, split_catalog, days, symbols, captured_at, source_refs):
    """Historical ETF economics, never a claim about past decision availability.

    Caller scopes symbols to the official ETF registry. Unknown split economics
    and incomplete distributions stay blocking; future distributions are unused.
    """
    from services.capital_corporate_source import action_date
    from services.finlab_corporate_actions import _amount
    required = {'symbol','date','收益分配基準日','收益分配發放日',
                '收益分配金額(每1受益權單位)','收益分配標準'}
    names = {r['dataset'] for r in source_refs}
    if not {'finlab.tw_etf_dividend_events','finlab.etf_split:恢復買賣日期','official.etf_registry'} <= names:
        raise ValueError('corporate_history_etf_provenance_missing')
    if rows.is_empty() or not required <= set(rows.columns):
        raise ValueError('corporate_history_etf_distribution_schema_invalid')
    if split_catalog.is_empty() or 'date' not in split_catalog.columns:
        raise ValueError('corporate_history_etf_split_catalog_missing')
    days=sorted(set(days));symbols=sorted(set(symbols))
    if not days or not symbols or any(not re.fullmatch(r'0[0-9A-Za-z]{3,7}',s) for s in symbols):
        raise ValueError('corporate_history_etf_scope_invalid')
    events={};invalid={};splits={}
    for row in rows.filter(pl.col('symbol').cast(pl.String).is_in(symbols)).iter_rows(named=True):
        ex_date=action_date(row['date']);symbol=str(row['symbol'])
        if not days[0] <= ex_date <= days[-1]:
            continue
        try:
            amount=float(_amount(row['收益分配金額(每1受益權單位)']))
            pay=action_date(row['收益分配發放日']);record=action_date(row['收益分配基準日'])
            if pay < ex_date or record < ex_date:raise ValueError('date_order')
        except (TypeError,ValueError):
            invalid.setdefault(ex_date,{}).setdefault(symbol,[]).append('etf_distribution_terms_missing')
            continue
        action={'action_id':digest({'source':'finlab.etf_history','symbol':symbol,'ex_date':ex_date}),
            'symbol':symbol,'kind':'cash','ex_date':ex_date,'record_date':record,'payable_date':pay,
            'cash_per_share':amount,'stock_per_share':0.,'cash_rounding':
                'floor_twd' if re.search(r'元以下(?:全捨|捨去|無條件捨去)',str(row['收益分配標準'])) else None}
        key=(symbol,ex_date)
        if key in events and events[key]!=action:
            raise ValueError('corporate_history_etf_conflicting_revision')
        if amount:events[key]=action
    for row in split_catalog.iter_rows(named=True):
        for symbol in set(symbols)&set(split_catalog.columns):
            if row[symbol] is None:continue
            day=action_date(row[symbol])
            if day<action_date(row['date']):raise ValueError('corporate_history_etf_split_date_conflict')
            splits.setdefault(day,{}).setdefault(symbol,[]).append('etf_split_economic_terms_required')
    records=[]
    for index,day in enumerate(days):
        blockers=deepcopy(invalid.get(day,{}))
        for symbol,reasons in splits.get(day,{}).items():blockers.setdefault(symbol,[]).extend(reasons)
        snap={'session_date':day,'covered_symbols':symbols,
            'actions':[],
            'blockers':blockers,'source_checksum':digest({'refs':source_refs,'day':day}),
            'tax_basis':'gross_before_personal_tax'}
        # Include a payment on the first observed session after a non-session day.
        previous=days[index-1] if index else day
        snap['actions']=[a for a in events.values() if a['ex_date']<=day and (a['payable_date']>=day or previous<a['payable_date']<day)]
        records.append(make_history_record(snap,captured_at=captured_at,source_refs=source_refs,
            history_start=days[0],history_end=days[-1]))
    return records_frame(records)


def merge_history_frames(*frames):
    """Combine disjoint economic-source scopes without replacing the universe."""
    tapes=[{r['session_date']:json.loads(r['record_json']) for r in f.iter_rows(named=True)} for f in frames]
    if not tapes or any(set(t)!=set(tapes[0]) for t in tapes):
        raise ValueError('corporate_history_merge_calendar_mismatch')
    records=[]
    for day in sorted(tapes[0]):
        parts=[t[day] for t in tapes];snaps=[validate_history_record(r) for r in parts]
        symbols=[s for snap in snaps for s in snap['covered_symbols']]
        if len(symbols)!=len(set(symbols)):raise ValueError('corporate_history_merge_scope_overlap')
        snap=deepcopy(snaps[0]);snap['covered_symbols']=sorted(symbols)
        snap['actions']=[a for part in snaps for a in part['actions']]
        snap['blockers']={s:v for part in snaps for s,v in part['blockers'].items()}
        snap['unverified_stock_action_ids']={s:v for part in snaps for s,v in part.get('unverified_stock_action_ids',{}).items()}
        snap['unresolved_outstanding_action_ids']={s:v for part in snaps for s,v in part.get('unresolved_outstanding_action_ids',{}).items()}
        snap['source_checksum']=digest([r['record_checksum'] for r in parts])
        refs={digest(ref):ref for r in parts for ref in r['source_refs']}
        records.append(make_history_record(snap,captured_at=max(r['captured_at'] for r in parts),
            source_refs=list(refs.values()),history_start=min(r['history_start'] for r in parts),
            history_end=max(r['history_end'] for r in parts)))
    return records_frame(records)



def apply_reviewed_stock_rules(snapshot, rules, source_refs):
    """Research-only reviewed joins across issuer documents; facts stay dated.

    Exact event identity plus immutable raw-source hashes are mandatory. These
    rules never enter the live Paper materializer or waive fractional terms.
    """
    from decimal import Decimal
    result = deepcopy(snapshot)
    hashes = {r['sha256'] for r in source_refs}
    for action in result['actions']:
        if action['kind'] != 'stock':
            continue
        applicable = []
        for rule in rules:
            if not rule.get('source_sha256s') or not set(rule['source_sha256s']) <= hashes:
                raise ValueError('corporate_history_reviewed_stock_provenance_missing')
            if (rule['symbol'] == action['symbol'] and rule['ex_date'] == action['ex_date']
                    and rule['record_date'] == action.get('record_date')
                    and Decimal(str(rule['stock_per_share'])) == Decimal(str(action['stock_per_share']))
                    and rule['published_date'] < snapshot['session_date']):
                applicable.append(rule)
        if not applicable:
            continue
        latest = max(r['published_date'] for r in applicable)
        selected = [r for r in applicable if r['published_date'] == latest]
        if len(selected) != 1:
            raise ValueError('corporate_history_reviewed_stock_conflict')
        rule = selected[0]
        payable = rule['payable_date']
        if payable and (payable < action['ex_date'] or payable < rule['published_date']):
            raise ValueError('corporate_history_reviewed_stock_date_invalid')
        action.update(payable_date=payable, fractional_treatment=rule['fractional_treatment'],
            stock_terms_status='confirmed_schedule' if payable else 'awaiting_issuer_schedule',
            reviewed_history_evidence=deepcopy(rule))
    return result
