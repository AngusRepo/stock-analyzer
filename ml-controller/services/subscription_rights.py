"""Issuer-linked subscription terms; no subscription orders or invented marks."""
from copy import deepcopy
from datetime import date
from decimal import Decimal
import re

from services.paired_nav_journal import digest


def parse_subscription_terms(text: str, *, record_date: str, ratio: float, price: float) -> dict | None:
    from services.mops_corporate_terms import DATE, _date
    compact = re.sub(r'\s+', '', text)
    records = {_date(m) for m in re.finditer(DATE + r'為現金增資認股基準日', compact)}
    if record_date not in records:
        return None
    ratios = {Decimal(m) / 1000 for m in re.findall(r'每[仟千]股得認購([0-9.]+)股', compact)}
    prices = {Decimal(m) for m in re.findall(
        r'(?:每股發行價格[:：]?|發行價格[:：]每股)新[臺台]幣([0-9.]+)元', compact)}
    if (len(ratios) != 1 or abs(next(iter(ratios)) - Decimal(str(ratio))) > Decimal('0.000000000001')
            or prices != {Decimal(str(price))}):
        raise ValueError('subscription_issuer_ratio_or_price_mismatch')
    # Deliberately anchored to original holders, NOT the following placement
    # subscription period. No deadline is inferred from record/ex dates.
    periods = re.finditer(
        r'原股東(?:及員工)?(?:股款繳納期間[:：]|繳款期間自)([^()（）]+)', compact)
    dated_periods = {tuple(_date(m) for m in re.finditer(DATE, period[1])) for period in periods}
    days = next(iter(dated_periods)) if len(dated_periods) == 1 else ()
    if len(days) != 2 or days[0] > days[1]:
        raise ValueError('subscription_original_holder_deadline_missing')
    if not re.search(r'放棄認購.{0,70}特定人', compact):
        raise ValueError('subscription_unexercised_terms_missing')
    return {'policy': 'do_not_subscribe', 'payment_start': days[0], 'payment_deadline': days[1],
        'expiry_policy': 'unexercised_original_holder_rights_expire',
        'fair_value_per_right': None, 'valuation_status': 'unobservable',
        'fractional_policy': 'retain_no_automatic_pooling', 'promotion_eligible': False}


def enrich_subscription_source(snapshot: dict, evidence_by_symbol: dict) -> dict:
    result = deepcopy(snapshot)
    for action in result['actions']:
        if action['kind'] != 'subscription':
            continue
        evidence = evidence_by_symbol[action['symbol']]
        linked = []
        for doc in evidence['documents']:
            if digest(doc['body']) != doc['body_checksum']:
                raise ValueError('subscription_document_checksum_mismatch')
            if doc['published_date'] > evidence['query_end']:
                raise ValueError('subscription_future_document')
            try:
                terms = parse_subscription_terms(doc['body'], record_date=action['record_date'],
                    ratio=action['rights']['ratio'], price=action['rights']['subscription_price'])
            except ValueError as exc:
                terms = {'error': str(exc)}
            if terms is not None:
                linked.append((doc['published_date'], doc['body_checksum'], terms))
        latest = [entry for entry in linked if entry[0] == max((r[0] for r in linked), default=None)]
        if not latest or len({digest(r[2]) for r in latest}) != 1 or 'error' in latest[0][2]:
            result.setdefault('blockers', {}).setdefault(action['symbol'], []).append('subscription_latest_issuer_terms_unresolved')
            continue
        action['rights'].update(latest[0][2], evidence_checksums=[r[1] for r in latest])
        if action['rights']['payment_deadline'] < action['ex_date']:
            raise ValueError('subscription_deadline_before_entitlement')
    result['source_checksum'] = digest({k: v for k, v in result.items() if k != 'source_checksum'})
    return result


def validate_rights(rights: dict, ex_date: str) -> None:
    import math
    if not isinstance(rights, dict):
        raise ValueError('subscription_terms_missing')
    for field in ('ratio', 'subscription_price', 'issued_ratio'):
        value = rights.get(field)
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ValueError('subscription_numeric_terms_invalid')
    start, end = (date.fromisoformat(rights[k]).isoformat() for k in ('payment_start', 'payment_deadline'))
    if (not ex_date <= start <= end or rights.get('policy') != 'do_not_subscribe'
            or rights.get('expiry_policy') != 'unexercised_original_holder_rights_expire'
            or rights.get('fair_value_per_right') is not None or rights.get('valuation_status') != 'unobservable'
            or rights.get('promotion_eligible') is not False
            or rights.get('fractional_policy') != 'retain_no_automatic_pooling'
            or not rights.get('evidence_checksums')
            or any(not re.fullmatch(r'[0-9a-f]{64}', s) for s in rights['evidence_checksums'])):
        raise ValueError('subscription_policy_or_issuer_evidence_invalid')
