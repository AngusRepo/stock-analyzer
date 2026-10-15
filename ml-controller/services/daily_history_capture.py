"""Daily official-history updates from one verified historical snapshot.

Legacy history is imported explicitly by build_daily_history_baseline.py, never
by the daily entry. Consumers retain the original calendar and breadth checks.
"""
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path

SCHEMA = 'daily-history-snapshot-v1'


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True).encode('utf-8')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def packed(raw):
    return {'raw': raw.decode('utf-8'), 'sha256': digest(raw)}


def unpack(item):
    raw = item['raw'].encode('utf-8')
    if digest(raw) != item['sha256']:
        raise ValueError('daily_history_member_checksum')
    return raw


def read_snapshot(bucket, price_root, manifest):
    expected = manifest.get('daily_history_sha256')
    if not expected:
        return None
    raw = bucket.blob(price_root + '/daily_history.json').download_as_bytes()
    return validate_snapshot(raw, manifest, expected)


def validate_snapshot(raw, manifest, expected):
    if digest(raw) != expected:
        raise ValueError('daily_history_snapshot_checksum')
    value = json.loads(raw)
    if (value.get('schema_version') != SCHEMA
            or value.get('capture_id') != manifest['capture_id']
            or value.get('end_date') != manifest['end_date']
            or value.get('close_sha256') != manifest['checksums']['close']):
        raise ValueError('daily_history_snapshot_identity')
    return value


def load_daily_history(bucket, *, run_date, capture_prefix, bootstrap_ref=None):
    from services.daily_inference_producer import _baseline
    from services.daily_inference_composition import read_verified
    _, baseline = _baseline(bucket, run_date)
    candidates = [item for item in baseline['input_manifests']
                  if item.get('sha256') == baseline['price_manifest_sha256']]
    if len(candidates) > 1:
        raise ValueError('daily_history_price_source_ambiguous')
    ref = candidates[0] if candidates else {
        'path': capture_prefix.rstrip('/') + '/' + baseline['price_capture_id']
                + '/raw/daily_price_full_vintage/manifest.json',
        'sha256': baseline['price_manifest_sha256']}
    manifest = json.loads(read_verified(bucket, ref))
    if manifest['capture_id'] != baseline['price_capture_id'] or manifest['end_date'] != baseline['business_date']:
        raise ValueError('daily_history_baseline_identity')
    snapshot = read_snapshot(bucket, ref['path'].rsplit('/', 1)[0], manifest)
    if snapshot is None:
        if bootstrap_ref is None:
            raise ValueError('daily_history_baseline_required_run_explicit_import')
        raw = read_verified(bucket, bootstrap_ref)
        snapshot = validate_snapshot(raw, manifest, bootstrap_ref['sha256'])
    return snapshot


def update_official_history(*, run_dir, baseline, fetch, pause):
    """Update calendar months and new sessions; never traverse remote history."""
    from services.training_session_calendar import price_session_dates, official_month_sessions, require_session_equality
    from services.training_global_capture import parse_breadth
    root = Path(run_dir) / 'raw/daily_price_full_vintage'
    manifest = json.loads((root / 'manifest.json').read_bytes())
    days = price_session_dates((root / 'close.parquet').read_bytes())
    start, end = days[0], manifest['end_date']
    if baseline['end_date'] >= end:
        raise ValueError('daily_history_baseline_not_past')
    previous_month = (date.fromisoformat(end).replace(day=1) - timedelta(days=1)).strftime('%Y-%m')
    months = sorted({day[:7] for day in days})
    calendar, sessions, sources = {}, {'TWSE': [], 'TPEX': []}, []
    for month in months:
        for market in ('TWSE', 'TPEX'):
            key = market + '-' + month
            if month in {end[:7], previous_month}:
                stamp = month.replace('-', '') + '01'
                if market == 'TWSE':
                    url = 'https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?response=json&date=' + stamp
                else:
                    url = 'https://www.tpex.org.tw/www/indexInfo/inx?date=' + month.replace('-', '/') + '/01&response=json'
                body = fetch(url, label='training_calendar_' + market + '_' + month)
                values = official_month_sessions(body, market, month)
                item = {**packed(encode(body)), 'sessions': values}
                pause(2)
            else:
                item = baseline['calendar'].get(key)
                if item is None:
                    raise ValueError('daily_history_closed_month_missing:' + key)
                values = item['sessions']
            calendar[key] = item
            sessions[market].extend(values)
            sources.append({'market': market, 'month': month, 'sha256': item['sha256']})
    require_session_equality(days, sessions, start=start, end=end)
    receipt = {'schema_version': 'official-training-calendar-v1', 'capture_id': manifest['capture_id'],
               'start': start, 'end': end, 'close_sha256': manifest['checksums']['close'], 'sources': sources}
    raw = encode(receipt)
    (root / 'training_calendar.json').write_bytes(raw)
    manifest['official_calendar_sha256'] = digest(raw)
    breadth, sources = {}, []
    for day in days:
        item = baseline['breadth'].get(day)
        if item is None:
            if day <= baseline['end_date']:
                raise ValueError('daily_history_old_session_missing:' + day)
            body = fetch('https://www.twse.com.tw/exchangeReport/MI_INDEX?date='
                         + day.replace('-', '') + '&response=json&type=MS', label='training_breadth_' + day)
            parse_breadth(body, day)
            item = packed(encode(body))
            pause(4)
        breadth[day] = item
        sources.append({'date': day, 'sha256': item['sha256']})
    (root / 'training_breadth.json').write_bytes(encode({
        'schema_version': 'training-breadth-capture-v1', 'capture_id': manifest['capture_id'],
        'end': end, 'sources': sources}))
    snapshot = {'schema_version': SCHEMA, 'capture_id': manifest['capture_id'], 'end_date': end,
                'close_sha256': manifest['checksums']['close'], 'calendar': calendar, 'breadth': breadth}
    (root / 'manifest.json').write_bytes(encode(manifest))
    return snapshot


def seal_daily_history(run_dir, snapshot):
    root = Path(run_dir) / 'raw/daily_price_full_vintage'
    snapshot['us_quotes'] = {field: packed((root / 'us_quotes' / (field + '.json')).read_bytes())
                             for field in ('sox', 'gspc', 'vix', 'dxy')}
    raw = encode(snapshot)
    (root / 'daily_history.json').write_bytes(raw)
    manifest = json.loads((root / 'manifest.json').read_bytes())
    manifest['daily_history_sha256'] = digest(raw)
    (root / 'manifest.json').write_bytes(encode(manifest))


def import_legacy_history(bucket, price_ref):
    """One-time read-only import; full original proofs are checked here."""
    from services.daily_inference_composition import read_verified
    from services.training_session_calendar import verify_training_calendar, official_month_sessions
    from services.training_global_capture import parse_breadth
    from services.training_us_capture import SYMBOLS, quote_series, read_us_quote_history
    manifest = json.loads(read_verified(bucket, price_ref))
    root = price_ref['path'].rsplit('/', 1)[0]
    verify_training_calendar(bucket, price_capture={'capture_manifest_path': price_ref['path'],
        'capture_manifest_sha256': price_ref['sha256'], 'capture_id': manifest['capture_id']})
    calendar_receipt = json.loads(bucket.blob(root + '/training_calendar.json').download_as_bytes())
    calendar = {}
    for item in calendar_receipt['sources']:
        key = item['market'] + '-' + item['month']
        raw = read_verified(bucket, {'path': root + '/official_calendar/' + key + '.json', 'sha256': item['sha256']})
        calendar[key] = {**packed(raw), 'sessions': official_month_sessions(json.loads(raw), item['market'], item['month'])}
    breadth_receipt = json.loads(bucket.blob(root + '/training_breadth.json').download_as_bytes())
    if breadth_receipt.get('capture_id') != manifest['capture_id'] or breadth_receipt.get('end') != manifest['end_date']:
        raise ValueError('daily_history_import_breadth_identity')
    breadth = {}
    for item in breadth_receipt['sources']:
        day = item['date']
        if day in breadth:
            raise ValueError('daily_history_import_breadth_duplicate')
        raw = read_verified(bucket, {'path': root + '/official_breadth/' + day + '.json', 'sha256': item['sha256']})
        parse_breadth(json.loads(raw), day)
        breadth[day] = packed(raw)
    from services.training_session_calendar import price_session_dates
    price_raw = read_verified(bucket, {'path': root + '/close.parquet', 'sha256': manifest['checksums']['close']})
    price_days = price_session_dates(price_raw)
    if set(breadth) != set(price_days):
        raise ValueError('daily_history_import_breadth_gap')
    us_receipt = json.loads(bucket.blob(root + '/training_us_quotes.json').download_as_bytes())
    if us_receipt.get('capture_id') != manifest['capture_id'] or us_receipt.get('end') != manifest['end_date']:
        raise ValueError('daily_history_import_us_identity')
    us = {}
    for field, symbol in SYMBOLS.items():
        item = us_receipt['sources'][field]
        raw = read_verified(bucket, {'path': root + '/us_quotes/' + field + '.json', 'sha256': item['sha256']})
        rows = quote_series(json.loads(raw), symbol)
        if item['symbol'] != symbol or item['rows'] != len(rows):
            raise ValueError('daily_history_import_us_source')
        us[field] = packed(raw)
    read_us_quote_history(bucket, price_capture={'capture_manifest_path':price_ref['path'],
        'capture_id':manifest['capture_id']}, days=price_days)
    return {'schema_version': SCHEMA, 'capture_id': manifest['capture_id'], 'end_date': manifest['end_date'],
            'close_sha256': manifest['checksums']['close'], 'calendar': calendar, 'breadth': breadth, 'us_quotes': us}
