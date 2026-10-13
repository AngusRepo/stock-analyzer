"""Seal every day's inference inputs from an immutable baseline and new observations."""
from __future__ import annotations

import hashlib
import io
import json
from datetime import date
from pathlib import Path

import polars as pl

from services.daily_inference_composition import (
    SCHEMA, append_wide_delta, read_frame, read_verified, validate_composition,
)
from services.training_auxiliary_capture import DAILY_FIELDS, FIELDS

HEAD_PREFIX = 'daily_inference_compositions/dates/'
FINANCIAL_FIELDS = {'eps', 'roe', 'revenue_growth_yoy'}
MONTHLY_FIELDS = {'revenue', 'revenue_yoy', 'revenue_mom'}


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _baseline(bucket, run_date):
    candidates = []
    for blob in bucket.list_blobs(prefix=HEAD_PREFIX):
        day = blob.name.removeprefix(HEAD_PREFIX).removesuffix('.json')
        try:
            date.fromisoformat(day)
        except ValueError:
            continue
        if blob.name == HEAD_PREFIX + day + '.json' and day < run_date:
            candidates.append((day, blob))
    if candidates:
        day, blob = max(candidates, key=lambda item: item[0])
        source = json.loads(blob.download_as_bytes())
        if source.get('business_date') != day:
            raise ValueError('daily_composition_head_date_mismatch')
    else:
        source = json.loads(Path(__file__).with_name('daily_inference_baseline.json').read_bytes())
    value = json.loads(read_verified(bucket, source))
    day = value.get('business_date', '')
    if not day or day >= run_date:
        raise ValueError('daily_composition_baseline_not_past')
    result = validate_composition(bucket, value, source=source, run_date=day,
                                  price_capture={'capture_id': value['price_capture_id'],
                                                 'capture_manifest_sha256': value['price_manifest_sha256']})
    return source, result


class _LocalArtifacts:
    """The original readers validate local output before any cloud publication."""
    def __init__(self, bucket, files):
        self.bucket, self.files = bucket, files

    def blob(self, path):
        if path not in self.files:
            return self.bucket.blob(path)
        local = self.files[path]
        class Blob:
            def download_as_bytes(self):
                return local.read_bytes()
        return Blob()


def append_holding_observations(prior, observed, *, run_date):
    """Preserve known rows and admit unseen weekly observations through run_date."""
    keys = ['date','symbol']
    if observed.unique(keys).height != observed.height or prior.unique(keys).height != prior.height:
        raise ValueError('daily_composition_holding_duplicate')
    delta = observed.filter(pl.col('date') <= run_date).join(prior.select(keys),on=keys,how='anti')
    return pl.concat([prior,delta],how='diagonal_relaxed').sort('symbol','date')


def financial_observation_scope(frame, owners, *, roster, calendar_start):
    """Keep the captured price universe and potentially available observations.

    Earlier history is supplied by the immutable baseline, not reconstructed
    from today's vendor revision. A late old quarter stays in scope whenever
    either date owner places its observation inside the captured calendar.
    Missing dates for an in-scope value still fail the original owner gate.
    """
    import pandas as pd
    columns = [c for c in frame.columns if c in set(roster)]
    selected = frame.loc[:, columns].copy()
    start = pd.Timestamp(calendar_start)
    floor = str(start.to_period('Q') - 1).replace('Q', '-Q')
    recent = pd.DataFrame({c: selected.index >= floor for c in columns},index=selected.index)
    for owner in owners:
        dates = owner.reindex(index=selected.index,columns=columns).apply(
            lambda c: pd.to_datetime(c,errors='coerce'))
        recent |= dates >= start
    excluded = int((selected.notna() & ~recent).to_numpy().sum())
    selected = selected.where(recent)
    return selected, {'price_universe_only':True,'quarter_floor':floor,
                      'calendar_start':str(start.date()),
                      'baseline_history_preserved':True,
                      'out_of_calendar_cells_not_admitted':excluded,
                      'vendor_columns_outside_price_universe':sorted(set(frame.columns)-set(columns))}


def produce_daily_inference_composition(*, run_dir, bucket, capture_prefix,
                                        vendor_factory=None):
    """Runs inside the existing daily FinLab producer, before its success callback.

    Historical cells stay unchanged. Missing daily observations, corrupt lineage,
    unresolved dates or source quota failures prevent publication of a ready ref.
    """
    from services.daily_vendor_capture import DailyVendorCapture
    from services.financial_availability import align_financial_availability
    from services.finlab_sealed_raw import quarterly_index
    from services.monthly_availability import LOCKED_NOTE, align_monthly
    from services.training_long_sources import write_holding_capture

    run_dir = Path(run_dir)
    price_file = run_dir / 'raw/daily_price_full_vintage/manifest.json'
    price_raw = price_file.read_bytes()
    price = json.loads(price_raw)
    capture_id, run_date = run_dir.name, price['end_date']
    date.fromisoformat(run_date)
    if (price.get('capture_id') != capture_id
            or price.get('schema_version') != 'finlab-adjusted-price-single-capture-v1'):
        raise ValueError('daily_composition_price_identity_mismatch')
    source, old = _baseline(bucket, run_date)
    old_day = old['business_date']
    if old_day >= run_date:
        raise ValueError('daily_composition_baseline_not_past')
    root = run_dir / 'inference'
    if root.exists():
        raise ValueError('daily_composition_output_already_exists')
    root.mkdir()
    capture_prefix = capture_prefix.rstrip('/')
    files = {}

    def original(relative, expected=None):
        relative = relative.replace('\\', '/')
        local = run_dir / relative
        raw = local.read_bytes()
        if expected is not None and _sha(raw) != expected:
            raise ValueError('daily_composition_local_source_checksum:' + relative)
        path = capture_prefix + '/' + relative
        files[path] = local
        return {'path': path, 'sha256': _sha(raw)}

    def emit(relative, raw):
        local = root / relative
        local.parent.mkdir(parents=True, exist_ok=True)
        with local.open('xb') as stream:
            stream.write(raw)
        path = capture_prefix + '/inference/' + relative
        files[path] = local
        return {'path': path, 'sha256': _sha(raw)}

    def frame_item(relative, frame, inputs, availability, **extra):
        stream = io.BytesIO()
        frame.write_parquet(stream, compression='zstd')
        return {**emit(relative, stream.getvalue()), 'rows': frame.height,
                'columns': frame.columns, 'inputs': inputs, 'availability': availability, **extra}

    close_ref = original('raw/daily_price_full_vintage/close.parquet', price['checksums']['close'])
    calendar = pl.read_parquet(files[close_ref['path']], columns=['date']).with_columns(pl.col('date').cast(pl.Date))
    if calendar.is_empty() or calendar['date'].null_count() or calendar['date'].is_duplicated().any():
        raise ValueError('daily_composition_price_calendar_invalid')
    if str(calendar['date'].max()) != run_date:
        raise ValueError('daily_composition_current_price_session_missing')
    # Use the exact captured columns as identities, including vendor-null symbols.
    roster = [c for c in pl.scan_parquet(files[close_ref['path']]).collect_schema().names() if c != 'date']
    vendor = (vendor_factory or DailyVendorCapture)(run_dir / 'inference-native', roster=roster)
    raw_receipt_ref = original('inference-native/capture.json')
    native_receipt = json.loads(files[raw_receipt_ref['path']].read_bytes())

    def native(field):
        frame, proof = vendor.read(field)
        record = native_receipt['datasets'][field]
        reference = original('inference-native/' + record['path'], record['sha256'])
        if proof.get('raw_sha256') != reference['sha256']:
            raise ValueError('daily_composition_native_proof_mismatch')
        return frame, reference, proof

    result = {'schema_version': SCHEMA, 'business_date': run_date,
              'price_capture_id': capture_id, 'price_manifest_sha256': _sha(price_raw),
              'training_admitted': False, 'historical_values_replaced': False,
              'baseline_business_date': old_day, 'auxiliary': {}, 'long': {},
              'input_manifests': [source, original('raw/daily_price_full_vintage/manifest.json'), raw_receipt_ref]}
    aux_raw = (run_dir / 'raw/training_auxiliary_full_vintage/manifest.json').read_bytes()
    aux_manifest = json.loads(aux_raw)
    if aux_manifest.get('capture_id') != capture_id or aux_manifest.get('end_date') != run_date:
        raise ValueError('daily_composition_auxiliary_identity_mismatch')
    result['input_manifests'].append(original('raw/training_auxiliary_full_vintage/manifest.json'))
    disclosure, disclosure_ref, _ = native('disclosure')
    deadline, deadline_ref, _ = native('deadline')
    owners = [quarterly_index(f).to_pandas().set_index('date') for f in (disclosure, deadline)]
    for field in FIELDS:
        prior = read_frame(bucket, old['auxiliary'][field], run_date=old_day)
        inputs = [{'path': old['auxiliary'][field]['path'], 'sha256': old['auxiliary'][field]['sha256']}]
        extra = {}
        availability = old['auxiliary'][field]['availability']
        if field in {'margin_balance', 'short_balance', 'pe', 'pb'}:
            spec = aux_manifest['fields'].get(field)
            if not spec:
                raise ValueError('daily_composition_current_field_missing:' + field)
            reference = original('raw/training_auxiliary_full_vintage/' + field + '.parquet', spec['sha256'])
            delta = pl.read_parquet(files[reference['path']])
        else:
            delta, reference, proof = native(field)
            extra['raw_source_proof'] = proof
            if field in MONTHLY_FIELDS:
                contract = old['auxiliary'][field].get('monthly_contract')
                if (not contract or contract.get('policy') != 'vendor_locked_key_date_next_observed_session'
                        or (contract.get('vendor_declaration') or {}).get('note') != LOCKED_NOTE):
                    raise ValueError('daily_composition_monthly_contract_required')
                delta, mapping, alignment = align_monthly(delta, calendar, roster,
                                                          start_date=str(calendar['date'].min()), end_date=run_date)
                extra.update(monthly_contract=contract, monthly_alignment=alignment,
                             monthly_capture_receipt_sha256=raw_receipt_ref['sha256'])
                availability = contract['policy']
            elif field in FINANCIAL_FIELDS:
                scoped, scope = financial_observation_scope(
                    quarterly_index(delta).to_pandas().set_index('date'),owners,
                    roster=roster,calendar_start=str(calendar['date'].min()))
                extra['financial_input_scope'] = scope
                aligned = align_financial_availability(scoped, owners,
                                                       calendar['date'].to_pandas())
                extra['financial_availability_proof'] = {k: v for k, v in aligned.attrs['financial_availability_proof'].items()}
                events = aligned.attrs['financial_availability_events']
                extra['financial_events'] = frame_item('events/' + field + '.parquet', events,
                                                        [reference, disclosure_ref, deadline_ref], availability)
                inputs.extend([disclosure_ref, deadline_ref])
                delta = pl.from_pandas(aligned.reset_index())
        inputs.append(reference)
        frame = append_wide_delta(prior, delta, baseline_end=old_day, run_date=run_date)
        if field in DAILY_FIELDS and set(calendar['date'].cast(pl.String)) - set(frame['date']):
            raise ValueError('daily_composition_market_dates_missing:' + field)
        # Appending must preserve every existing cell, including nulls and zero.
        historical = frame.filter(pl.col('date') <= old_day).select(prior.columns)
        if not historical.equals(prior.sort('date')):
            raise ValueError('daily_composition_history_changed:' + field)
        result['auxiliary'][field] = frame_item('auxiliary/' + field + '.parquet', frame, inputs, availability, **extra)

    broker_raw = (run_dir / 'raw/training_long_full_vintage/broker.json').read_bytes()
    broker_meta = json.loads(broker_raw)
    if broker_meta.get('capture_id') != capture_id or broker_meta.get('end') != run_date or broker_meta.get('source') != 'broker':
        raise ValueError('daily_composition_broker_identity_mismatch')
    broker_ref = original('raw/training_long_full_vintage/broker.parquet', broker_meta['sha256'])
    broker = pl.read_parquet(files[broker_ref['path']]).with_columns(pl.col('date').cast(pl.String).str.slice(0, 10))
    broker = broker.filter(pl.col('date') == run_date)
    if broker.is_empty() or broker.unique(['date', 'symbol']).height != broker.height:
        raise ValueError('daily_composition_current_broker_missing')
    result['input_manifests'].append(original('raw/training_long_full_vintage/broker.json'))
    result['long']['broker'] = frame_item('long/broker.parquet', broker, [broker_ref], broker_meta['availability_policy'])

    holding, holding_ref, _ = native('holding')
    holding_receipt = write_holding_capture(holding, run_dir=root / 'holding-observation',
                                           start=str(calendar['date'].min()), end=run_date)
    holding_path = root / 'holding-observation/raw/training_long_full_vintage/holding.parquet'
    delta = pl.read_parquet(holding_path).with_columns(pl.col('date').cast(pl.String).str.slice(0, 10))
    prior = read_frame(bucket, old['long']['holding'], run_date=old_day)
    frame = append_holding_observations(prior,delta,run_date=run_date)
    if frame.unique(['date', 'symbol']).height != frame.height:
        raise ValueError('daily_composition_holding_duplicate')
    result['long']['holding'] = frame_item('long/holding.parquet', frame,
        [holding_ref, {'path': old['long']['holding']['path'], 'sha256': old['long']['holding']['sha256']}],
        holding_receipt['availability_policy'], source_capture_end=run_date,
        carry_policy='retain_observed_history_and_append_new_holding_observations')

    manifest = emit('manifest.json', _json(result))
    overlay = _LocalArtifacts(bucket, files)
    validated = validate_composition(overlay, result, source=manifest, run_date=run_date,
        price_capture={'capture_id': capture_id, 'capture_manifest_sha256': _sha(price_raw)})
    for item in (*validated['auxiliary'].values(), *validated['long'].values()):
        read_frame(overlay, item, run_date=run_date)
    # Seal the consumer reference last, after all original readers have passed.
    reference = {**manifest, 'capture_id': capture_id, 'business_date': run_date}
    emit('reference.json', _json(reference))
    return reference


def publish_daily_inference_head(bucket, reference):
    """A head only points at artifacts already uploaded and SHA verified."""
    from google.api_core.exceptions import PreconditionFailed
    value = json.loads(read_verified(bucket, reference))
    validated = validate_composition(bucket, value, source=reference, run_date=reference['business_date'],
        price_capture={'capture_id': reference['capture_id'], 'capture_manifest_sha256': value['price_manifest_sha256']})
    for item in (*validated['auxiliary'].values(), *validated['long'].values()):
        read_frame(bucket, item, run_date=reference['business_date'])
    blob = bucket.blob(HEAD_PREFIX + reference['business_date'] + '.json')
    try:
        blob.upload_from_string(_json(reference), content_type='application/json', if_generation_match=0)
    except PreconditionFailed:
        existing = json.loads(blob.download_as_bytes())
        old = json.loads(read_verified(bucket, existing))
        if existing.get('business_date') != reference['business_date'] or old.get('business_date') != reference['business_date']:
            raise ValueError('daily_composition_existing_head_invalid')
    return reference
