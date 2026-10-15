"""Point-in-time forward samples. No fitting, order calls, or OOF relabeling.

Inputs must come from verified immutable snapshots. A manifest hash is not a
substitute for checking the original bytes; collection supplies that proof.
"""
from __future__ import annotations
from datetime import date, datetime, time, timezone
from zoneinfo import ZoneInfo
import hashlib
import json
import math

TZ = ZoneInfo('Asia/Taipei')

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
        allow_nan=False).encode()).hexdigest()

def timestamp(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('timezone_required')
    return result

def materialize(snapshot, *, calendar, prices, cutoff, expected_identity, pool_contract):
    """Return independently usable rows plus complete exclusions, never partial-day training.

    Date-only prices become available the following local date conservatively.
    Missing any symbol's labels blocks that day for pool-relative training.
    A routed allocation snapshot is evaluation-only for a native-pool model.
    """
    now = timestamp(cutoff)
    if calendar != sorted(set(calendar)) or not calendar:
        raise ValueError('invalid_session_calendar')
    for day in calendar: date.fromisoformat(day)
    if snapshot.get('verified_original_sha256') != snapshot.get('original_sha256'):
        raise ValueError('snapshot_original_not_verified')
    if len(snapshot.get('original_sha256', '')) != 64:
        raise ValueError('snapshot_original_hash_missing')
    rows = snapshot['feature_rows']
    if not rows or digest(rows) != snapshot['features_checksum']:
        raise ValueError('feature_projection_checksum_mismatch')
    symbols = [r['symbol'] for r in rows]
    if len(symbols) != len(set(symbols)):
        raise ValueError('duplicate_forward_symbol')
    if set(symbols) != set(snapshot['eligible_symbols']):
        raise ValueError('declared_pool_coverage_mismatch')
    if snapshot['signal_date'] not in calendar:
        raise ValueError('signal_date_not_in_calendar')
    pos = calendar.index(snapshot['signal_date'])
    receipt = dict(schema_version='l4-forward-maturity-v1', snapshot_id=snapshot['snapshot_id'],
        signal_date=snapshot['signal_date'], cutoff=cutoff, source_sha256=snapshot['original_sha256'],
        captured_at=snapshot['frozen_at'], prediction_kind='forward',
        pool_contract=snapshot['pool_contract'], feature_schema=snapshot['feature_schema'],
        l3_identity=snapshot['l3_identity'], excluded=[], rows=0, training_eligible=False,
        training_dispatched=False, promoted=False)
    def reject(reason):
        receipt['status'] = reason
        return [], receipt
    if snapshot['l3_identity'] != expected_identity:
        return reject('incompatible_l3_identity')
    if pos + 1 >= len(calendar):
        return reject('calendar_not_yet_covers_maturity')
    entry = calendar[pos + 1]
    deadline = datetime.combine(date.fromisoformat(entry), time(9), TZ)
    frozen = timestamp(snapshot['frozen_at'])
    if frozen >= deadline:
        return reject('prediction_sealed_after_entry')
    if frozen > now:
        return reject('snapshot_after_cutoff')
    if pos + 5 >= len(calendar):
        return reject('calendar_not_yet_covers_maturity')
    exit_day = calendar[pos + 5]
    receipt.update(entry_date=entry, label_known_date=exit_day)
    if exit_day >= now.astimezone(TZ).date().isoformat():
        return reject('label_not_yet_mature_at_cutoff')
    result = []
    for row in rows:
        symbol = row['symbol']
        first, last = prices.get((entry, symbol)), prices.get((exit_day, symbol))
        values = (None if first is None else first.get('adj_open'),
                  None if last is None else last.get('adj_close'))
        if any(v is None or isinstance(v, bool) or not math.isfinite(v) or v <= 0 for v in values):
            receipt['excluded'].append(dict(symbol=symbol, reason='missing_or_invalid_label_prices'))
            continue
        if not first.get('source_sha256') or not last.get('source_sha256'):
            raise ValueError('price_provenance_missing')
        result.append(dict(date=snapshot['signal_date'], symbol=symbol,
            features=row['features'], l3_baseline=row['l3_baseline'],
            l3_identity=snapshot['l3_identity'], feature_schema=snapshot['feature_schema'],
            prediction_kind='forward', label_known_date=exit_day,
            gross_return=values[1]/values[0]-1,
            source=dict(snapshot_id=snapshot['snapshot_id'], frozen_at=snapshot['frozen_at'],
                entry_deadline=deadline.isoformat(), original_sha256=snapshot['original_sha256'],
                entry_price_sha256=first['source_sha256'], exit_price_sha256=last['source_sha256'],
                pool_contract=snapshot['pool_contract'])) )
    receipt.update(rows=len(result), rows_checksum=digest(result),
        status='ready' if not receipt['excluded'] else 'incomplete_labels')
    known = snapshot.get('l3_training_label_known_max')
    causal_model = isinstance(known,str) and date.fromisoformat(known).isoformat()==known and known<snapshot['signal_date']
    if causal_model:
        for row in result:row['l3_training_label_known_max']=known
        receipt['rows_checksum']=digest(result)
    receipt['training_eligible'] = (not receipt['excluded'] and snapshot['pool_contract'] == pool_contract and causal_model)
    if not causal_model:
        receipt['training_blocker'] = 'l3_training_cutoff_not_attested'
    if snapshot['pool_contract'] != pool_contract:
        receipt['training_blocker'] = 'pool_contract_mismatch_evaluation_only'
    return result, receipt

def persist_local(directory, rows, receipt):
    """Content-addressed immutable publication; retry accepts byte-identical content."""
    from pathlib import Path
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    if digest(rows) != receipt.get('rows_checksum'):
        raise ValueError('forward_rows_receipt_mismatch')
    body = dict(rows=rows, receipt=receipt)
    checksum = digest(body)
    raw = json.dumps(body, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    path = root / (checksum + '.json')
    try:
        with path.open('xb') as stream: stream.write(raw)
    except FileExistsError:
        if path.read_bytes() != raw: raise ValueError('forward_immutable_conflict')
    return dict(path=str(path), sha256=hashlib.sha256(raw).hexdigest(), receipt_checksum=digest(receipt))
