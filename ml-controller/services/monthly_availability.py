"""Pinned FinLab locked monthly dates aligned only to observed sessions."""
import hashlib
import json
from pathlib import Path

import polars as pl

from services.finlab_sealed_raw import SealedDailySource, SealedFinancialSource, read_numeric_field

MONTHLY_DATASETS = frozenset({
    'monthly_revenue:當月營收', 'monthly_revenue:去年同月增減(%)',
    'monthly_revenue:上月比較增減(%)',
})
LOCKED_NOTE = ('monthly_revenue 是鎖定版，數值與 key_date 以下一個開盤前的最後一次寫入為準，'
               '之後不再更正，沒有 revised_at。monthly_revenue_revised 是更正版：數值是最新更正值，'
               'key_date 與鎖定版相同（有輕微前視），revised_at 記錄該列最後一次偵測到更正的時間。')


def _decode(value):
    if not isinstance(value, dict):
        return value
    for key in ('stringValue', 'integerValue', 'booleanValue', 'nullValue'):
        if key in value:
            return value[key]
    if 'mapValue' in value:
        return {k: _decode(v) for k, v in value['mapValue'].get('fields', {}).items()}
    if 'arrayValue' in value:
        return [_decode(v) for v in value['arrayValue'].get('values', [])]
    return {k: _decode(v) for k, v in value.items()}


def _entries(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _entries(child)
    elif isinstance(value, list):
        for child in value:
            yield from _entries(child)


def verify_monthly_contract(path, digest, capture_sha, requested):
    path = Path(path).resolve()
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError('monthly_contract_checksum')
    record = json.loads(raw)
    if (record.get('schema') != 'finlab-locked-monthly-contract-v1'
            or record.get('capture_receipt_sha256') != capture_sha
            or record.get('policy') != 'vendor_locked_key_date_next_observed_session'
            or set(record.get('datasets', [])) != MONTHLY_DATASETS
            or not requested or not set(requested).issubset(MONTHLY_DATASETS)):
        raise ValueError('monthly_contract_scope')
    relative = Path(record['catalog']['path'])
    catalog_path = (path.parent / relative).resolve()
    if relative.is_absolute() or not catalog_path.is_relative_to(path.parent):
        raise ValueError('monthly_catalog_path')
    catalog_raw = catalog_path.read_bytes()
    if hashlib.sha256(catalog_raw).hexdigest() != record['catalog']['sha256']:
        raise ValueError('monthly_catalog_checksum')
    catalog = json.loads(catalog_raw)
    if catalog.get('name') != 'projects/fdata-299302/databases/(default)/documents/data_categories/finlab_tw_stock':
        raise ValueError('monthly_catalog_identity')
    entries = list(_entries(_decode(catalog)))
    declarations = [x for x in entries if x.get('alias') == 'monthly_revenue:revised_at']
    if (len(declarations) != 1 or declarations[0].get('note') != LOCKED_NOTE
            or declarations[0].get('target') != 'monthly_revenue_revised:revised_at'):
        raise ValueError('monthly_locked_contract_not_proven')
    listed = {x.get('alias') for x in entries if isinstance(x.get('alias'), str)}
    if not MONTHLY_DATASETS.issubset(listed):
        raise ValueError('monthly_catalog_dataset_missing')
    return {'contract_sha256': digest, 'catalog_sha256': record['catalog']['sha256'],
            'catalog_document': catalog['name'], 'policy': record['policy'],
            'vendor_declaration': declarations[0], 'capture_receipt_sha256': capture_sha,
            'original_announcement_or_historical_vintage_certified': False}


def _dates(frame, label):
    dates = frame['date']
    if (dates.dtype != pl.Date and not isinstance(dates.dtype, pl.Datetime)) or dates.is_null().any():
        raise ValueError(f'monthly_{label}_date_invalid')
    if isinstance(dates.dtype, pl.Datetime) and (dates.dtype.time_zone is not None or (dates != dates.dt.truncate('1d')).any()):
        raise ValueError(f'monthly_{label}_date_invalid')
    normalized = dates.cast(pl.Datetime('ns'))
    if normalized.is_duplicated().any():
        raise ValueError(f'monthly_{label}_date_duplicate')
    return normalized


def align_monthly(frame, calendar, roster, *, start_date, end_date):
    from datetime import datetime
    start, end = (datetime.strptime(v, '%Y-%m-%d') for v in (start_date, end_date))
    sessions = _dates(calendar, 'calendar').sort()
    if sessions.is_empty() or start > end or sessions.min() > start or sessions.max() < end:
        raise ValueError('monthly_calendar_request_uncovered')
    dates = _dates(frame, 'source')
    if not roster or len(set(roster)) != len(roster):
        raise ValueError('monthly_roster_invalid')
    frame = frame.with_columns(dates.alias('date')).sort('date')
    mapping = frame.select(pl.col('date').alias('raw_key_date')).join_asof(
        pl.DataFrame({'available_session': sessions}),
        left_on='raw_key_date', right_on='available_session', strategy='forward')
    mapping = mapping.with_columns(
        pl.when(pl.col('raw_key_date') < sessions.min()).then(pl.lit('before_observed_calendar'))
        .when(pl.col('available_session').is_null()).then(pl.lit('after_observed_calendar'))
        .otherwise(pl.lit('observed_session')).alias('status'))
    eligible = mapping.filter(pl.col('status') == 'observed_session')
    if eligible['available_session'].is_duplicated().any():
        raise ValueError('monthly_multiple_periods_same_session')
    selected = frame.select('date', *[
        pl.col(s).cast(pl.Float64).fill_nan(None) if s in frame.columns else pl.lit(None, dtype=pl.Float64).alias(s)
        for s in roster])
    if selected.select(pl.any_horizontal(pl.exclude('date').is_infinite()).any()).item():
        raise ValueError('monthly_nonfinite_value')
    aligned = selected.join(eligible, left_on='date', right_on='raw_key_date', how='inner')
    aligned = aligned.select(pl.col('available_session').alias('date'), *roster).sort('date')
    # Keep pre-window observations for a downstream as-of join; never fabricate future sessions.
    proof = {'policy': 'vendor_locked_key_date_next_observed_session', 'start_date': start_date,
             'end_date': end_date, 'requested_symbols': list(roster),
             'vendor_absent_symbols_retained_null': sorted(set(roster) - set(frame.columns)),
             'outside_calendar_rows_preserved_in_native': mapping.filter(pl.col('status') != 'observed_session').height,
             'date_mapping_rows': mapping.height, 'aligned_rows': aligned.height,
             'values_changed_or_imputed': False, 'original_publication_certified': False}
    return aligned, mapping, proof


class SealedMonthlySource(SealedDailySource):
    def __init__(self, root, capture_sha, datasets, *, contract_path, contract_sha, start_date, end_date):
        requested = set(datasets)
        monthly = {x for x in requested if x.startswith('monthly_revenue:')}
        contract = verify_monthly_contract(contract_path, contract_sha, capture_sha, monthly)
        financial = any(x.startswith(('fundamental_features:', 'financial_statement:')) for x in requested)
        if financial:
            base = SealedFinancialSource(root, capture_sha, requested - monthly)
            self.root, self.roster = base.root, base.roster
            self.frames, self.proofs, self.binding = base.frames, base.proofs, base.binding
        else:
            super().__init__(root, capture_sha, (requested - monthly) | {'price:收盤價'})
        receipt = json.loads((self.root / 'capture.json').read_bytes())
        by_dataset = {v: k for k, v in receipt['required'].items()}
        if not monthly.issubset(by_dataset):
            raise ValueError('sealed_requested_dataset_missing')
        self.monthly_native = {}
        self.monthly_events = {}
        self.monthly_proofs = {}
        for dataset in sorted(monthly):
            native, source_proof = read_numeric_field(root, receipt_sha256=capture_sha,
                field=by_dataset[dataset], expected_dataset=dataset)
            aligned, mapping, proof = align_monthly(native, self.frames['price:收盤價'], self.roster,
                                                   start_date=start_date, end_date=end_date)
            self.frames[dataset] = aligned
            self.proofs[dataset] = source_proof
            self.monthly_native[dataset] = native
            self.monthly_events[dataset] = mapping
            self.monthly_proofs[dataset] = proof
        self.binding.update(schema_version=('sealed-financial-and-locked-monthly-producer-input-v1' if financial
                else 'sealed-locked-monthly-producer-input-v1'),
            requested_datasets=sorted(requested), monthly_contract=contract,
            raw_values_and_calendar_same_capture=True)
