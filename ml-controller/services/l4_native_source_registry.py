"""Read-only discovery of native training receipts; never fits or publishes models."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re

import ijson
import polars as pl

SCHEMA = 'l4-native-oof-dataset-v1'
LABEL_SCHEMA = 'next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4'
FIELDS = ('date', 'symbol', 'features', 'feature_schema', 'gross_return',
          'label_known_date', 'l3_training_label_known_max', 'prediction_kind',
          'l3_identity', 'l3_baseline')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def file_sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def cutoff_day(value):
    instant = datetime.fromisoformat(value)
    if instant.tzinfo is None:
        raise ValueError('cutoff_requires_timezone')
    return instant.astimezone(timezone(timedelta(hours=8))).date().isoformat()


def discover_local(roots):
    """Inventory receipts, never choose a dataset by filename, mtime or latest score."""
    records = []
    for root in roots:
        root = Path(root).resolve(strict=True)
        # Explicit registry directories only; do not recursively sweep audit caches.
        for path in sorted(root.glob('*dataset-receipt*.json')):
            receipt = json.loads(path.read_bytes())
            paired = path.with_name(path.name.replace('dataset-receipt', 'dataset'))
            records.append({'receipt': receipt, 'receipt_uri': str(path),
                            'local_path': str(paired) if paired.is_file() else None})
    return records


def discover_gcs(bucket):
    """Refresh the candidate registry each run, including failed/newer listings errors."""
    records = []
    for blob in bucket.list_blobs(prefix='l4_distribution/candidates/'):
        if not blob.name.endswith('.json'):
            continue
        raw = blob.download_as_bytes(if_generation_match=blob.generation, timeout=120)
        candidate = json.loads(raw)
        receipt = candidate.get('training_source')
        if not receipt:
            continue
        records.append({'receipt': receipt,
                        'receipt_uri': f'gs://{bucket.name}/{blob.name}',
                        'receipt_generation': str(blob.generation),
                        'receipt_sha256': hashlib.sha256(raw).hexdigest()})
    return records


def prepare_sources(records, *, identity, feature_schema, cutoff, work, bucket=None):
    """Validate complete sources, then merge only mature, exact-lineage rows.

    Date-only known times conservatively require known_date < Taiwan cutoff day.
    Forward predictions are not relabelled as OOF; they need a separate verified adapter.
    """
    day = cutoff_day(cutoff)
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    inventory, frames, seen_sources = [], [], set()
    seen_rows = {}
    expected_features = None
    for record in records:
        receipt = record['receipt']
        item = {k: v for k, v in record.items() if k not in ('receipt', 'local_path')}
        item['receipt_checksum'] = digest(receipt)
        item['source_rows_checksum'] = receipt.get('rows_checksum')
        inventory.append(item)
        if receipt.get('schema_version') != SCHEMA:
            item.update(status='excluded', reason='unsupported_receipt_schema')
            continue
        if receipt.get('parent_l3_identity') != identity or receipt.get('feature_schema') != feature_schema:
            item.update(status='excluded', reason='incompatible_l3_identity_or_feature_schema')
            continue
        if (receipt.get('source_label_semantic') != LABEL_SCHEMA
                or not re.fullmatch('[0-9a-f]{64}', receipt.get('source_manifest_checksum', ''))
                or not receipt.get('source_pointer')):
            raise ValueError('source_lineage_evidence_missing:' + item['receipt_uri'])
        checksum = receipt.get('rows_checksum', '')
        expected_path = f'l4_distribution/native_datasets/{checksum}.json'
        if not re.fullmatch('[0-9a-f]{64}', checksum) or receipt.get('dataset_path') != expected_path:
            raise ValueError('dataset_reference_invalid')
        if checksum in seen_sources:
            item.update(status='duplicate_source', reason='same_verified_content')
            continue
        seen_sources.add(checksum)
        local = record.get('local_path')
        item['dataset_uri'] = expected_path
        if local:
            source = Path(local)
        else:
            if bucket is None:
                raise ValueError('source_not_available_locally:' + expected_path)
            blob = bucket.get_blob(expected_path)
            if blob is None:
                raise ValueError('registered_dataset_missing:' + expected_path)
            item['dataset_uri'] = f'gs://{bucket.name}/{expected_path}'
            item['dataset_generation'] = str(blob.generation)
            source = work / (checksum + '.json')
            blob.download_to_filename(str(source), if_generation_match=blob.generation, timeout=300)
        source_hash = hashlib.sha256(b'[')
        counts = Counter()
        batch, total, raw_dates, selected_dates = [], 0, set(), set()
        with source.open('rb') as stream:
            for row in ijson.items(stream, 'item', use_float=True):
                if total:
                    source_hash.update(b',')
                source_hash.update(canonical(row).encode())
                total += 1
                raw_dates.add(row['date'])
                # All rows, including excluded immature rows, must satisfy lineage.
                if (row['l3_identity'] != identity or row['feature_schema'] != feature_schema
                        or row['prediction_kind'] != 'oof'):
                    raise ValueError('row_lineage_mismatch')
                for key in ('date', 'label_known_date', 'l3_training_label_known_max'):
                    from datetime import date
                    if date.fromisoformat(row[key]).isoformat() != row[key]:
                        raise ValueError('noncanonical_date')
                if not row['l3_training_label_known_max'] < row['date'] < row['label_known_date']:
                    raise ValueError('noncausal_row')
                if not isinstance(row['gross_return'], (int, float)):
                    raise ValueError('invalid_label')
                names = sorted(row['features'])
                if len(names) != 30 or (expected_features is not None and names != expected_features):
                    raise ValueError('feature_coordinates_mismatch')
                expected_features = names
                if row['label_known_date'] >= day:
                    counts['label_not_known_before_cutoff_day'] += 1
                    continue
                projected = {k: row[k] for k in FIELDS}
                row_sha = digest(projected)
                key = (row['date'], row['symbol'])
                if key in seen_rows:
                    if seen_rows[key] != row_sha:
                        raise ValueError('conflicting_date_symbol:' + repr(key))
                    counts['identical_duplicate_row'] += 1
                    continue
                seen_rows[key] = row_sha
                counts['included'] += 1
                selected_dates.add(row['date'])
                # Keep identities stable across sources with different JSON key order.
                projected['l3_identity'] = json.loads(canonical(projected['l3_identity']))
                projected['l3_baseline'] = json.loads(canonical(projected['l3_baseline']))
                projected['features'] = {name: row['features'][name] for name in names}
                batch.append(projected)
                if len(batch) == 4096:
                    frames.append(pl.DataFrame(batch, infer_schema_length=None))
                    batch = []
        source_hash.update(b']')
        if source_hash.hexdigest() != checksum or total != receipt['rows']:
            raise ValueError('source_checksum_or_count_mismatch:' + item['receipt_uri'])
        if batch:
            frames.append(pl.DataFrame(batch, infer_schema_length=None))
        item.update(status='verified', rows=total, counts=dict(counts),
                    source_min=min(raw_dates, default=None), source_max=max(raw_dates, default=None),
                    included_min=min(selected_dates, default=None), included_max=max(selected_dates, default=None))
    if not frames:
        raise ValueError('no_eligible_rows')
    frame = pl.concat(frames, how='vertical_relaxed').sort(['date', 'symbol'])
    report = dict(schema='r2-source-inventory-v1', cutoff=cutoff, cutoff_taipei_day=day,
                  maturity_rule='date_only_label_known_strictly_before_cutoff_day',
                  identity=identity, feature_schema=feature_schema, sources=inventory,
                  rows=frame.height, first=frame['date'].min(), last=frame['date'].max(),
                  signal_days=frame['date'].n_unique(),
                  discovery_scope='registered_native_oof_datasets_only',
                  forward_prediction_adapter='not_implemented_not_treated_as_oof',
                  latest_available_is_not_assumed_equal_to_cutoff=True)
    return frame, report
