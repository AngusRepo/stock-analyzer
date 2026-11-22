"""Turn sealed MOPS issuer documents into reviewed research rules (local, no network).

Research only; the live Paper parsers (mops_corporate_terms, subscription_rights)
are read, never changed. For each FinLab stock or subscription event of a
listed symbol, the issuer documents published before its ex-date are searched
with the wording seen in real MOPS notices. A rule always carries FinLab's
exact economic values; the document only has to agree with them.

  auto_exact_match   one latest document states the record date and the exact
                     ratio (subscription: also price, original-holder payment
                     period and the specific-person placement of unexercised
                     shares) -> written as a rule
  review queue       last-digit ratio difference, a ratio derived from share
                     counts, terms spread over several documents, a later
                     unlinked revision -> written to review_queue.json only;
                     ids passed back with --accept become issuer_event_terms_reviewed

Cited documents are sealed into one issuer_bundle.json, the spec's single
`extra_sources` entry, never `issuer_evidence` (that path runs the live parser,
whose unlinked revisions add blockers rules cannot clear). Each rule keeps its
per-symbol fetch sha256. The output spec.json compiles with compile_corporate_history.py.

Run from ml-controller:
  python scripts/extract_reviewed_corporate_rules.py BASE_SPEC ISSUER_DIR OUT_DIR \
      --symbols symbols.json --start 2024-12-31 --end 2026-11-20 [--accept accepted.json]
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import polars as pl

from services.mops_corporate_terms import DATE as ISSUER_DATE, _date
from services.paired_nav_journal import digest

FULL_WIDTH = str.maketrans('０１２３４５６７８９．', '0123456789.')
# Never take digits from a neighbouring list number: 113/12/3⏎2.特定人 is not 12/32.
DATE = r'(?<!\d)' + ISSUER_DATE + r'(?!\d)'
PLAIN_DATE = re.sub(r'\(\?P<[^>]+>', '(?:', DATE)
NUMBER = r'([0-9][0-9,]*(?:\.[0-9]+)?)'
SEP = r'[^。；，,]'
RANGE = r'(?:日起至|日至|起至|至|～|~|-)'
PER_THOUSAND = r'每[壹一]?[仟千]股'
STOCK_RATIO = (PER_THOUSAND + SEP + r'{0,12}?(?:配發|配股|配)[^0-9。；，,]{0,10}?(?P<approx>約)?' + NUMBER + '股',
               r'配發' + PER_THOUSAND + r'(?P<approx>約)?' + NUMBER + '股')
SUBSCRIPTION_RATIO = (PER_THOUSAND + r'(?P<approx>約)?(?:得|可|有償)?(?:約)?(?:優先)?(?:認購)?(?:新股)?(?:約)?'
                      + NUMBER + '股')
LAST_DIGIT_MIN_PLACES = 4  # Wei 11/22 G2'': last-digit rounding of a long per-thousand ratio


def compact(text: str) -> str:
    text = text.translate(FULL_WIDTH)
    # A line break inside a number (97.408⏎26976) is no boundary; one before a list number is.
    return re.sub(r'\s+', '', re.sub(r'(?<=\d)\s+(?=[1-9]\d?[.、](?!\d))', '|', text))


def _number(value: str) -> Decimal:
    return Decimal(value.replace(',', ''))


def _places(value: Decimal) -> int:
    return max(0, -value.normalize().as_tuple().exponent)


def _day(match) -> str | None:
    """Issuer typos such as 115年79月3日 are no date at all."""
    try:
        return _date(match)
    except ValueError:
        return None


def _excerpt(text: str, match) -> str:
    return text[max(0, match.start() - 30):match.end() + 30]


def _dates(text: str, patterns) -> dict:
    found = {}
    for pattern in patterns:
        for match in re.finditer(pattern, text):
            if day := _day(match):
                found.setdefault(day, _excerpt(text, match))
    return found


def stock_record_dates(text: str) -> dict:
    """基準日 wording of dividend-share notices, never pricing or subscription dates."""
    found = {}
    for pattern in (r'(?<!訂價)(?<!認股)基準日' + SEP + r'{0,4}?(?:為|[:：])(?:民國)?' + DATE,
                    DATE + r'為(?P<label>' + SEP + r'{0,16}?)基準日'):
        for match in re.finditer(pattern, text):
            label = match.groupdict().get('label') or ''
            if any(word in label for word in ('訂價', '認股', '現金增資')):
                continue
            if day := _day(match):
                found.setdefault(day, _excerpt(text, match))
    return found


def _ratio_matches(text: str, patterns) -> tuple[dict, set]:
    """value -> excerpt, and the values the issuer itself calls approximate (約)."""
    found, approximate = {}, set()
    for pattern in patterns:
        for match in re.finditer(pattern, text):
            value = _number(match[match.re.groups])
            found.setdefault(value, _excerpt(text, match))
            if '約' in match[0]:
                approximate.add(value)
    return found, approximate


def stock_ratios(text: str) -> dict:
    """Shares per thousand; two labelled components may also form one total."""
    found, _ = _ratio_matches(text, STOCK_RATIO)
    if len(found) == 2:
        found.setdefault(sum(found), 'sum_of_two_components')
    return found


def stock_payable_dates(text: str) -> dict:
    return _dates(text, (r'(?:股票股利|增資股票|新股)發放日(?:期)?[:：](?:民國)?' + DATE,
                         DATE + r'(?:\([^)]{0,6}\))?為(?:股票股利|增資股票)?發放日',
                         r'(?:訂於|定於)' + DATE + r'(?:\([^)]{0,6}\))?發放'))


def book_entry_fee(text: str) -> bool:
    return bool(re.search(r'凡參加帳簿劃撥配發股票之股東.{0,20}未滿一股之畸零股款.{0,20}(?:做|作)為處理帳簿劃撥之費用', text))


def subscription_terms(text: str, *, previous_shares: Decimal | None) -> dict:
    record = _dates(text, (r'認股基準日' + SEP + r'{0,4}?(?:為|[:：])(?:民國)?' + DATE,
                           DATE + r'為' + SEP + r'{0,10}?認股基準日'))
    ratios, approximate = {}, set()
    for match in re.finditer(SUBSCRIPTION_RATIO, text):
        between = match[0][len(re.match(PER_THOUSAND, match[0])[0]):]
        if '可' in between or '認購' in between or '有償' in between:  # never a stock-dividend ratio
            ratios.setdefault(_number(match[match.re.groups]), _excerpt(text, match))
            if '約' in between:
                approximate.add(_number(match[match.re.groups]))
    derived = {}
    if previous_shares:
        for match in re.finditer(NUMBER + r'(仟)?股' + SEP + r'{0,8}?由原股東', text):
            unit = Decimal(1000) if match[2] else Decimal(1)
            derived.setdefault(_number(match[1]) * unit * 1000 / previous_shares,
                               {'excerpt': _excerpt(text, match), 'unit_shares': str(unit)})
    prices = {}
    if '尚未訂價' not in text:
        for match in re.finditer(r'(?:發行|認購)價格[^。；0-9]{0,10}?新[臺台]幣' + NUMBER + '元', text):
            prices.setdefault(_number(match[1]), _excerpt(text, match))
    periods = {}
    for pattern in (r'原股東' + SEP + r'{0,8}?(?:繳款|繳納)期間[:：自]?(?:民國)?(' + PLAIN_DATE + RANGE + r'(?:民國)?' + PLAIN_DATE + ')',
                    r'(' + PLAIN_DATE + RANGE + r'(?:民國)?' + PLAIN_DATE + r')(?:止)?為原股東' + SEP + r'{0,8}?(?:繳款|繳納)期間'):
        for match in re.finditer(pattern, text):
            days = tuple(_day(m) for m in re.finditer(DATE, match[1]))
            if len(days) == 2 and all(days):
                periods.setdefault(days, _excerpt(text, match))
    specific = re.search(r'(?:放棄認[購股]|認購不足|未認購)[^。]{0,80}?特定人', text)
    return {'record': record, 'ratios': ratios, 'approximate': approximate, 'derived': derived, 'prices': prices, 'periods': periods,
            'specific': _excerpt(text, specific) if specific else None}


def _candidate_id(rule: dict) -> str:
    core = {k: v for k, v in rule.items() if k not in ('evidence_documents', 'review_semantic')}
    return digest(core)[:16]


def stock_candidates(action: dict, docs: list, source: dict) -> tuple[list, list, dict]:
    """(rules, queue, diagnostic) for one stock action."""
    expected = Decimal(str(action['stock_per_share'])) * 1000
    links, seen_record = [], []
    for doc in docs:
        text = compact(doc['body'])
        records = stock_record_dates(text)
        if action['record_date'] not in records:
            continue
        seen_record.append(doc['published_date'])
        ratios = stock_ratios(text)
        approximate = _ratio_matches(text, STOCK_RATIO)[1]
        exact = [v for v in ratios if v == expected]
        # A rounding of a long fraction (>= 4 places), never a different whole or short ratio.
        near = [v for v in ratios if v != expected and _places(v) >= LAST_DIGIT_MIN_PLACES
                and abs(v - expected) <= Decimal(1).scaleb(-_places(v))]
        links.append({'doc': doc, 'text': text, 'records': records, 'ratios': ratios,
                      'match': 'exact' if exact else 'last_digit' if near else None,
                      'approximate': bool(set(exact or near) & approximate),
                      'issuer_value': (exact or near or [None])[0]})
    diagnostic = {'record_date_found_in': seen_record, 'ratios_seen': sorted(str(v) for l in links for v in l['ratios'])}
    linked = [l for l in links if l['match']]
    if not linked:
        return [], [], diagnostic
    latest_day = max(l['doc']['published_date'] for l in linked)
    latest = [l for l in linked if l['doc']['published_date'] == latest_day]
    later = [l for l in links if l['doc']['published_date'] > latest_day and not l['match']]
    link = latest[0]
    payables = stock_payable_dates(link['text'])
    fee = book_entry_fee(link['text'])
    payable = next(iter(payables)) if len(payables) == 1 and fee else None
    if payable and (payable < action['ex_date'] or payable < latest_day):
        payable = None
    rule = {'symbol': action['symbol'], 'ex_date': action['ex_date'], 'record_date': action['record_date'],
            'stock_per_share': action['stock_per_share'], 'published_date': latest_day,
            'payable_date': payable, 'fractional_treatment': 'book_entry_fee' if fee and payable else None,
            'source_sha256s': [source['sha256']], 'issuer_stock_per_thousand': str(link['issuer_value']),
            'issuer_ratio_delta_per_thousand': str(link['issuer_value'] - expected),
            'evidence_documents': [{'published_date': latest_day, 'body_checksum': link['doc']['body_checksum'],
                                    'record_excerpt': link['records'][action['record_date']],
                                    'ratio_excerpt': link['ratios'][link['issuer_value']]}]}
    reasons = []
    if link['match'] != 'exact':
        reasons.append('ratio_last_digit_difference')
    if link['approximate']:
        reasons.append('issuer_ratio_approximate')
    if len(latest) > 1:
        reasons.append('several_documents_same_day')
    if later:
        reasons.append('later_unlinked_revision')
    if len(payables) > 1:
        reasons.append('payable_date_ambiguous')
    if reasons:
        rule['review_semantic'] = 'issuer_event_terms_reviewed'
        return [], [{'id': _candidate_id(rule), 'kind': 'stock', 'reasons': reasons, 'rule': rule}], diagnostic
    rule['review_semantic'] = 'auto_exact_match'
    return [rule], [], diagnostic


def subscription_candidates(action: dict, docs: list, source: dict, previous_shares,
                            later_docs: list = ()) -> tuple[list, list, dict]:
    """later_docs (after ex-date) never supply terms; they only send a moved record date to review."""
    rights = action['rights']
    ratio = Decimal(str(rights['ratio'])) * 1000
    price = Decimal(str(rights['subscription_price']))
    per_doc = []
    for doc in docs:
        terms = subscription_terms(compact(doc['body']), previous_shares=previous_shares)
        if action['record_date'] in terms['record']:
            per_doc.append((doc, terms))
    diagnostic = {'record_date_found_in': [d['published_date'] for d, _ in per_doc]}
    if not per_doc:
        return [], [], diagnostic
    latest_day = max(d['published_date'] for d, _ in per_doc)
    fields, reasons, used = {}, [], set()
    for doc, terms in sorted(per_doc, key=lambda item: item[0]['published_date'], reverse=True):
        if 'ratio' not in fields and ratio in terms['ratios']:
            fields['ratio'] = ('stated', terms['ratios'][ratio]); used.add(doc['published_date'])
            if ratio in terms['approximate']:
                reasons.append('issuer_ratio_approximate')
        if 'ratio' not in fields:
            for value, info in terms['derived'].items():
                tolerance = Decimal('0.5') * Decimal(info['unit_shares']) * 1000 / previous_shares
                if abs(value - ratio) <= tolerance:
                    fields['ratio'] = ('derived', info['excerpt']); used.add(doc['published_date'])
        if 'price' not in fields and terms['prices']:
            if set(terms['prices']) == {price}:
                fields['price'] = terms['prices'][price]; used.add(doc['published_date'])
            else:
                reasons.append('price_differs:' + ','.join(sorted(str(p) for p in terms['prices'])))
        if 'period' not in fields and len(terms['periods']) == 1:
            fields['period'] = next(iter(terms['periods'].items())); used.add(doc['published_date'])
        if 'specific' not in fields and terms['specific']:
            fields['specific'] = terms['specific']; used.add(doc['published_date'])
    missing = [k for k in ('ratio', 'price', 'period', 'specific') if k not in fields]
    diagnostic['missing'] = missing
    if missing:
        return [], [], diagnostic
    (start, deadline), period_excerpt = fields['period']
    if not action['ex_date'] <= start <= deadline:
        diagnostic['missing'] = ['period_before_entitlement']
        return [], [], diagnostic
    rule = {'symbol': action['symbol'], 'ex_date': action['ex_date'], 'record_date': action['record_date'],
            'ratio': rights['ratio'], 'subscription_price': rights['subscription_price'],
            'published_date': max(used), 'payment_start': start, 'payment_deadline': deadline,
            'unexercised_to_specific_persons': True, 'ratio_basis': fields['ratio'][0],
            'source_sha256s': [source['sha256']],
            'evidence_documents': [{'published_dates': sorted(used), 'ratio_excerpt': fields['ratio'][1],
                                    'price_excerpt': fields['price'], 'period_excerpt': period_excerpt,
                                    'specific_person_excerpt': fields['specific']}]}
    if fields['ratio'][0] == 'derived':
        reasons.append('ratio_derived_from_share_counts')
    if len(used) > 1:
        reasons.append('terms_spread_over_documents')
    if max(used) != latest_day:
        reasons.append('later_document_not_used')
    for doc in later_docs:
        if doc['published_date'] <= deadline:
            moved = set(subscription_terms(compact(doc['body']), previous_shares=None)['record']) - {action['record_date']}
            if moved:
                reasons.append('record_date_moved_after_ex_date')
    if reasons:
        rule['review_semantic'] = 'issuer_event_terms_reviewed'
        return [], [{'id': _candidate_id(rule), 'kind': 'subscription', 'reasons': sorted(set(reasons)), 'rule': rule}], diagnostic
    rule['review_semantic'] = 'auto_exact_match'
    return [rule], [], diagnostic


def finlab_events(rows: pl.DataFrame, symbol: str, *, start: str, end: str) -> list[dict]:
    """The exact stock/subscription actions the compiler builds on each ex-date session."""
    from services.finlab_corporate_actions import normalize_dividend_announcements
    from services.research_corporate_history import timestamp
    scoped = rows.filter(pl.col('stock_id').cast(pl.String) == symbol)
    sessions = sorted({str(v)[:10] for v in scoped['除權交易日'].to_list() if v is not None and start <= str(v)[:10] <= end})
    actions = {}
    for day in sessions:
        snap = normalize_dividend_announcements(scoped, symbols=[symbol], session_date=day,
            observed_at=timestamp(day + 'T08:59:59.999999+08:00'), outstanding_scope='union_component')
        for action in snap['actions']:
            if action['kind'] in ('stock', 'subscription') and action['ex_date'] == day:
                actions[action['action_id']] = action
    return sorted(actions.values(), key=lambda a: (a['ex_date'], a['kind']))


def _previous_shares(rows: pl.DataFrame, action: dict):
    for row in rows.filter(pl.col('stock_id').cast(pl.String) == action['symbol']).iter_rows(named=True):
        if str(row['除權交易日'])[:10] == action['ex_date'] and str(row.get('權利分派基準日'))[:10] == action['record_date']:
            value = Decimal(str(row.get('參加分派總股數') or 0).replace(',', ''))
            if value > 0:
                return value
    return None


def sealed_sources(issuer_dir: Path) -> dict:
    """symbol -> sealed fetch entry, re-hashed against the file on disk."""
    sources = {}
    for report in sorted(issuer_dir.glob('fetch_report_*.json')):
        for symbol, item in json.loads(report.read_text(encoding='utf-8'))['symbols'].items():
            if item.get('status') == 'sealed':
                sources[symbol] = item
    for symbol, item in sources.items():
        raw = (issuer_dir.parent / item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('issuer_evidence_changed_since_fetch:' + symbol)
    return sources


def extract(base_spec: Path, issuer_dir: Path, symbols: list[str], *, start: str, end: str,
            accepted: set[str] = frozenset()) -> dict:
    spec = json.loads(base_spec.read_text(encoding='utf-8'))
    base = base_spec.resolve().parent
    rows = pl.read_parquet(base / spec['sources']['finlab.dividend_announcement']['path'])
    sources = sealed_sources(issuer_dir)
    stock_rules, subscription_rules, queue, per_symbol = [], [], [], {}
    for symbol in symbols:
        if symbol not in sources:
            per_symbol[symbol] = {'status': 'no_sealed_evidence'}
            continue
        source = sources[symbol]
        evidence = json.loads((issuer_dir.parent / source['path']).read_text(encoding='utf-8'))
        if evidence['symbol'] != symbol:
            raise ValueError('issuer_evidence_symbol_mismatch:' + symbol)
        events = []
        for action in finlab_events(rows, symbol, start=start, end=end):
            if not evidence['query_start'] <= action['ex_date'] <= evidence['query_end']:
                events.append({'kind': action['kind'], 'ex_date': action['ex_date'], 'status': 'outside_query'})
                continue
            docs = [d for d in evidence['documents'] if d['published_date'] < action['ex_date']]
            if action['kind'] == 'stock':
                rules, items, diagnostic = stock_candidates(action, docs, source)
                stock_rules += rules
            else:
                later = [d for d in evidence['documents'] if d['published_date'] >= action['ex_date']]
                rules, items, diagnostic = subscription_candidates(action, docs, source, _previous_shares(rows, action),
                                                                   later)
                subscription_rules += rules
            queue += items
            events.append({'kind': action['kind'], 'ex_date': action['ex_date'],
                           'status': 'auto' if rules else 'queued' if items else 'unlinked', **diagnostic})
        per_symbol[symbol] = {'status': 'extracted', 'events': events}
    for item in queue:
        if item['id'] in accepted:
            (stock_rules if item['kind'] == 'stock' else subscription_rules).append(item['rule'])
    unknown = sorted(set(accepted) - {item['id'] for item in queue})
    if unknown:
        raise ValueError('accepted_ids_not_in_queue:' + ','.join(unknown))
    return {'spec': spec, 'base': base, 'sources': sources, 'stock_rules': stock_rules,
            'subscription_rules': subscription_rules, 'queue': queue, 'per_symbol': per_symbol}


def write_outputs(result: dict, out: Path, *, issuer_dir: Path, clock=None) -> dict:
    """New spec (absolute base paths) plus rule, queue and report files; never overwrites."""
    out.mkdir(parents=True, exist_ok=False)
    spec, base = json.loads(json.dumps(result['spec'])), result['base']
    if any(not isinstance(spec.get(key) or [], list) for key in ('extra_sources', 'reviewed_stock_rules')):
        raise ValueError('base_spec_rules_must_be_inline_lists')
    for entry in spec['sources'].values():
        entry['path'] = str((base / entry['path']).resolve())
    for key in ('days', 'universe'):
        if isinstance(spec.get(key), str):
            spec[key] = str((base / spec[key]).resolve())
    rules = json.loads(json.dumps(result['stock_rules'] + result['subscription_rules']))
    by_sha = {item['sha256']: (symbol, item) for symbol, item in result['sources'].items()}
    cited = {by_sha[s][0]: by_sha[s][1] for rule in rules for s in rule['source_sha256s']}
    spec['captured_at'] = (clock or (lambda: datetime.now(timezone.utc).isoformat()))()
    if any(item['fetched_at'] > spec['captured_at'] for item in cited.values()):
        raise ValueError('issuer_evidence_fetched_after_capture')
    if cited:
        # One sealed bundle, one source ref: every history record repeats its refs,
        # so per-symbol refs would grow each record by ~290 bytes per issuer.
        bundle = {'schema_version': 'research-issuer-evidence-bundle-v1',
                  'sources': {s: {k: item[k] for k in ('dataset', 'fetched_at', 'sha256')} for s, item in sorted(cited.items())},
                  'evidence': {s: json.loads((issuer_dir.parent / item['path']).read_text(encoding='utf-8'))
                               for s, item in sorted(cited.items())}}
        raw = json.dumps(bundle, ensure_ascii=False, sort_keys=True).encode('utf-8')
        with open(out / 'issuer_bundle.json', 'xb') as handle:
            handle.write(raw)
        bundle_sha = hashlib.sha256(raw).hexdigest()
        spec['extra_sources'] = [*(spec.get('extra_sources') or []), {
            'dataset': 'mops.issuer_evidence_bundle', 'path': str((out / 'issuer_bundle.json').resolve()),
            'fetched_at': max(item['fetched_at'] for item in cited.values()), 'sha256': bundle_sha}]
        for rule in rules:
            rule['issuer_source_sha256s'], rule['source_sha256s'] = rule['source_sha256s'], [bundle_sha]
    spec['reviewed_stock_rules'] = [*(spec.get('reviewed_stock_rules') or []),
                                    *(r for r in rules if 'stock_per_share' in r)]
    spec['reviewed_subscription_rules'] = [r for r in rules if 'subscription_price' in r]
    report = {'stock_rules': len(result['stock_rules']), 'subscription_rules': len(result['subscription_rules']),
              'review_queue': len(result['queue']), 'cited_sources': len(cited),
              'rules_by_semantic': {s: sum(r['review_semantic'] == s for r in rules)
                                    for s in ('auto_exact_match', 'issuer_event_terms_reviewed')},
              'symbols': result['per_symbol']}
    for name, data in (('spec.json', spec), ('review_queue.json', result['queue']), ('extract_report.json', report)):
        with open(out / name, 'x', encoding='utf-8') as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('base_spec', type=Path)
    parser.add_argument('issuer_dir', type=Path)
    parser.add_argument('out_dir', type=Path)
    parser.add_argument('--symbols', type=Path, required=True)
    parser.add_argument('--start', required=True)
    parser.add_argument('--end', required=True)
    parser.add_argument('--accept', type=Path, default=None, help='JSON list of review-queue ids accepted after review')
    args = parser.parse_args(argv)
    symbols = sorted(set(json.loads(args.symbols.read_text(encoding='utf-8'))))
    accepted = set(json.loads(args.accept.read_text(encoding='utf-8'))) if args.accept else set()
    result = extract(args.base_spec, args.issuer_dir.resolve(), symbols, start=args.start, end=args.end,
                     accepted=accepted)
    report = write_outputs(result, args.out_dir.resolve(), issuer_dir=args.issuer_dir.resolve())
    print(json.dumps({k: v for k, v in report.items() if k != 'symbols'}, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
