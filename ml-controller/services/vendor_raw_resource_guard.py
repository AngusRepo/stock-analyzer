"""Read-only quota probe and bounded transfer guard for isolated raw capture.

The probe follows FinLab 2.0.17 auth.get_data_status, without installing it.
Wire bytes are NOT a proven upper bound on the vendor's metered quota.
"""
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import shutil
import time
import urllib.request

STATUS_URL = 'https://asia-east2-fdata-299302.cloudfunctions.net/auth_generate_data_url'


def finite_number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def probe_quota():
    # Does not import finlab.data, touch FileStorage, or request a download URL.
    from finlab.auth import get_id_token, get_session
    token, session = get_id_token(), get_session()
    if not token or not session:
        raise ValueError('existing_finlab_session_unavailable')
    payload = {'id_token': token, 'items': [{
        'bucket_name': 'finlab_tw_stock_item',
        'blob_name': 'price#收盤價.recent.feather',
        'time_saved': time.strftime('%Y%m%d%H%M%S', time.gmtime())}]}
    if session.get('session_id'):
        payload['session_id'] = session['session_id']
    request = urllib.request.Request(STATUS_URL, data=json.dumps(payload).encode(),
                                    headers={'Content-Type': 'application/json'}, method='POST')
    # No transport retry; never serialize payload, signed URLs or response bodies.
    with urllib.request.urlopen(request, timeout=15) as response:
        raw = response.read(65537)
    if len(raw) > 65536:
        raise ValueError('quota_response_oversize')
    result = json.loads(raw)
    items = result.get('results')
    if result.get('error') or not isinstance(items, list) or len(items) != 1:
        raise ValueError('quota_response_invalid')
    item = items[0]
    if not isinstance(item, dict) or item.get('error'):
        raise ValueError('quota_response_invalid')
    used, limit = item.get('quota'), item.get('limit_size')
    if not finite_number(used) or not finite_number(limit) or used < 0 or limit <= 0:
        raise ValueError('quota_values_invalid')
    return {'observed_at': datetime.now(timezone.utc).isoformat(),
            'used_mb': used, 'limit_mb': limit, 'remaining_mb': max(0, limit-used),
            'fresh_until': item.get('time_scheduled'),
            'unexpected_download_payload': bool(item.get('url') or item.get('data')),
            'data_downloads': 0, 'probe_method': 'official_2.0.17_time_saved_now'}


def preflight(quota, *, max_wire_bytes, quota_reserve_mb, free_bytes,
              disk_floor_bytes, now=None, max_age_seconds=60):
    """Check one request. Caller must refresh quota before every dataset.

    quota_reserve_mb is an explicit independent allowance, not inferred wire size.
    Reserve three wire copies: SDK atomic write/cache and sealed raw copy.
    """
    if any(not finite_number(x) for x in (max_wire_bytes, quota_reserve_mb,
                                         free_bytes, disk_floor_bytes, max_age_seconds)):
        raise ValueError('resource_bounds_invalid')
    if max_wire_bytes <= 0 or quota_reserve_mb <= 0 or free_bytes < 0 or disk_floor_bytes < 0 or max_age_seconds <= 0:
        raise ValueError('resource_bounds_invalid')
    stamp = datetime.fromisoformat(quota['observed_at'])
    if stamp.tzinfo is None:
        raise ValueError('quota_timestamp_naive')
    age = ((now or datetime.now(timezone.utc))-stamp).total_seconds()
    if not 0 <= age <= max_age_seconds:
        raise ValueError('quota_observation_stale_or_future')
    used, limit = quota['used_mb'], quota['limit_mb']
    if not finite_number(used) or not finite_number(limit) or used < 0 or limit <= 0:
        raise ValueError('quota_values_invalid')
    if quota.get('unexpected_download_payload'):
        raise ValueError('quota_probe_unexpected_payload')
    if used + quota_reserve_mb > limit:
        raise ValueError('quota_headroom_insufficient')
    if free_bytes < 3*max_wire_bytes + disk_floor_bytes:
        raise ValueError('disk_headroom_insufficient')
    return {'status': 'resource_preflight_passed_not_source_admission',
            'max_wire_bytes': max_wire_bytes, 'quota_reserve_mb': quota_reserve_mb,
            'free_bytes': free_bytes, 'disk_floor_bytes': disk_floor_bytes,
            'quota_billing_bound_proven': False}


def bounded_download(url, headers, *, max_wire_bytes, disk_root, disk_floor_bytes,
                     on_progress=None, request_get=None, free_space=None):
    """SDK-compatible raw fetch with Content-Length and incremental byte bounds.

    The only URL comes from authenticated SDK metadata. Do not print it.
    Abort closes response; no retry, no partial payload returned as complete.
    """
    if not isinstance(max_wire_bytes, int) or isinstance(max_wire_bytes, bool) or max_wire_bytes <= 0:
        raise ValueError('wire_bound_invalid')
    if not isinstance(disk_floor_bytes, int) or isinstance(disk_floor_bytes, bool) or disk_floor_bytes < 0:
        raise ValueError('disk_floor_invalid')
    if request_get is None:
        import requests
        request_get = requests.get
    free_space = free_space or (lambda: shutil.disk_usage(disk_root).free)
    if free_space() < 3*max_wire_bytes + disk_floor_bytes:
        raise ValueError('disk_headroom_insufficient')
    with request_get(url, headers=headers, timeout=(15, 60), stream=True) as response:
        response.raise_for_status()
        encoding = response.headers.get('content-encoding', 'identity')
        if encoding.lower() != 'identity':
            raise ValueError('encoded_wire_size_not_supported')
        declared = response.headers.get('content-length')
        if declared is not None:
            if not declared.isdecimal():
                raise ValueError('content_length_invalid')
            declared = int(declared)
            if declared <= 0 or declared > max_wire_bytes:
                raise ValueError('content_length_outside_bound')
        buf = bytearray()
        for chunk in response.iter_content(chunk_size=min(65536, max_wire_bytes+1)):
            if len(buf)+len(chunk) > max_wire_bytes:
                raise ValueError('wire_bound_exceeded')
            if free_space() < 3*max_wire_bytes+disk_floor_bytes:
                raise ValueError('disk_headroom_lost')
            buf.extend(chunk)
            if on_progress:
                on_progress(len(buf), declared or len(buf))
        if not buf or (declared is not None and len(buf) != declared):
            raise ValueError('wire_payload_incomplete')
        return bytes(buf)


def capture_one(cap, field, *, max_wire_bytes, quota_reserve_mb, disk_floor_bytes,
                quota_provider=probe_quota, request_get=None, free_space=None):
    """One dataset through the installed SDK. Single isolated process only.

    No retries. Caller must preflight the whole capture separately. This only
    admits resources; raw conflicts still fail FullRawCapture.seal.
    """
    if cap.receipt['status'] != 'incomplete' or field in cap.receipt['datasets']:
        raise ValueError('capture_closed_or_field_already_sealed')
    if time.monotonic()-cap.started > cap.max_seconds:
        raise ValueError('capture_window_expired')
    dataset = cap.receipt['required'][field]
    free_space = free_space or (lambda: shutil.disk_usage(cap.root).free)
    quota = quota_provider()
    gate = preflight(quota, max_wire_bytes=max_wire_bytes, quota_reserve_mb=quota_reserve_mb,
                     free_bytes=free_space(), disk_floor_bytes=disk_floor_bytes)
    storage = cap.make_sdk_storage()
    import finlab
    import finlab.utils
    if finlab.__version__ != '2.0.13':
        raise ValueError('capture_sdk_version_changed_review_required')
    from finlab import data
    import importlib
    auth = importlib.import_module('finlab.data.auth')
    get_module = importlib.import_module('finlab.data.get')
    original_finalize = get_module._finalize
    original_download = auth._download_feather_bytes
    original_version_check = finlab.utils.check_version
    original_storage = data._storage
    original_flags = {k: getattr(data, k) for k in ('force_cloud_download', 'prefer_local_if_exists', 'use_local_data_only')}
    resources = {'field': field, 'quota_before': quota, 'gate': gate, 'status': 'started'}
    cap.receipt.setdefault('resources', {})[field] = resources
    cap._record()
    download_calls = 0
    def guarded(url, headers, on_progress=None):
        nonlocal download_calls
        download_calls += 1
        if download_calls != 1:
            raise ValueError('unexpected_additional_download')
        return bounded_download(url, headers, max_wire_bytes=max_wire_bytes,
            disk_root=cap.root, disk_floor_bytes=disk_floor_bytes, on_progress=on_progress,
            request_get=request_get, free_space=free_space)
    def raw_only_finalize(requested_dataset, frame, *, cache=True):
        # SDK persists the original Feather bytes immediately before this hook.
        # Capture does not consume normalized output. Do not run publication
        # alignment/universe/alias transforms which may fetch more datasets.
        if requested_dataset != dataset:
            raise ValueError('unexpected_raw_finalize_dataset')
        return frame
    try:
        # Fixed, reviewed SDK; avoid an unrelated PyPI request with no timeout.
        finlab.utils.check_version = lambda: None
        auth._download_feather_bytes = guarded
        get_module._finalize = raw_only_finalize
        resources['raw_only_finalize'] = True
        data.set_storage(storage)
        data.force_cloud_download = True
        data.prefer_local_if_exists = False
        data.use_local_data_only = False
        data.get(dataset, force_download=True)
        if download_calls != 1:
            raise ValueError('raw_download_not_observed')
        record = cap.seal(field)
        resources['status'] = 'sealed_raw_not_formal_admitted'
        return record
    except Exception as exc:
        resources.update(status='failed_no_retry', error_class=type(exc).__name__)
        # Record only our fixed error codes; never vendor text or signed URLs.
        if str(exc) in {'unexpected_additional_download', 'unexpected_raw_finalize_dataset',
                        'raw_download_not_observed', 'raw_alias_conflict',
                        'content_length_outside_bound', 'wire_bound_exceeded',
                        'disk_headroom_insufficient', 'disk_headroom_lost',
                        'wire_payload_incomplete', 'encoded_wire_size_not_supported'}:
            resources['guard_error_code'] = str(exc)
        cap.receipt['status'] = 'rejected'
        raise
    finally:
        finlab.utils.check_version = original_version_check
        auth._download_feather_bytes = original_download
        get_module._finalize = original_finalize
        data.set_storage(original_storage)
        for name, value in original_flags.items():
            setattr(data, name, value)
        cap._record()


if __name__ == '__main__':
    # Probe only. It cannot invoke data.get, train, or write production.
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    record = probe_quota()
    record['free_bytes'] = shutil.disk_usage(Path(args.output).parent).free
    with Path(args.output).open('x', encoding='utf8') as target:
        json.dump(record, target, ensure_ascii=False, indent=2)
    print(json.dumps(record, ensure_ascii=False))
