"""Reuse exact native bytes only after the vendor confirms they are unchanged."""
from collections import OrderedDict
from datetime import datetime, timezone
import json

from services.daily_inference_composition import read_verified


def unchanged_native_fields(bucket, baseline, datasets, *, metadata_fetcher=None):
    refs = [item for item in baseline.get('input_manifests', [])
            if item['path'].endswith('/inference-native/capture.json')]
    if not refs:
        return {}, None
    if len(refs) != 1:
        raise ValueError('daily_native_baseline_ambiguous')
    ref = refs[0]
    receipt = json.loads(read_verified(bucket, ref))
    if receipt.get('status') != 'raw_complete_not_formal_admitted':
        raise ValueError('daily_native_baseline_incomplete')
    records = receipt['datasets']
    requested = OrderedDict()
    for field, dataset in datasets.items():
        record = records.get(field)
        if record is None:
            continue
        if record.get('dataset') != dataset or record.get('status') != 'raw_verified':
            raise ValueError('daily_native_baseline_dataset_mismatch')
        # Start of the previous source check, never a later copy/seal time.
        stamp = datetime.fromisoformat(record.get('vendor_checked_at') or receipt['started_at'])
        if stamp.tzinfo is None or stamp > datetime.now(timezone.utc):
            raise ValueError('daily_native_baseline_time_invalid')
        requested[dataset + '.recent'] = stamp.astimezone(timezone.utc)
    if not requested:
        return {}, None
    if metadata_fetcher is None:
        import finlab
        if finlab.__version__ != '2.0.13':
            raise ValueError('capture_sdk_version_changed_review_required')
        from finlab.data.auth import fetch_metadata_batch
        metadata_fetcher = fetch_metadata_batch
    checked_at = datetime.now(timezone.utc).isoformat()
    metadata = metadata_fetcher(requested)
    result = {}
    for field, dataset in datasets.items():
        key = dataset + '.recent'
        if key not in requested:
            continue
        item = metadata.get(key)
        if item is None or item.error:
            raise ValueError('daily_native_update_status_unavailable:' + field)
        if item.expiry is None:
            raise ValueError('daily_native_update_status_incomplete:' + field)
        # Same condition as pinned SDK _resolve_recent_hit. An update always
        # goes through original full-wire capture; no reconstructed Feather.
        if not item.url and item.data is None:
            record = records[field]
            relative = record['path'].replace('\\', '/')
            if relative != 'sealed/' + field + '.feather':
                raise ValueError('daily_native_baseline_path_invalid')
            result[field] = {'path': ref['path'].rsplit('/', 1)[0] + '/' + relative,
                             'sha256': record['sha256'], 'receipt': ref}
    return result, checked_at
