"""Exercise the real pinned SDK and raw writer with offline wire payloads."""
import importlib
import io
import hashlib
import json
from collections import OrderedDict
from datetime import datetime, timezone
from types import SimpleNamespace

import pandas as pd
import polars as pl
import pytest

from services import daily_vendor_capture as module
from services import vendor_raw_resource_guard as guard
from services.vendor_raw_capture import FullRawCapture


def test_daily_native_capture_keeps_wire_bytes_aliases_and_date_owners(monkeypatch, tmp_path):
    import requests
    def blocked(*args, **kwargs):
        raise AssertionError('unexpected network')
    monkeypatch.setattr(requests.sessions.Session, 'request', blocked)
    monkeypatch.setattr('urllib.request.urlopen', blocked)
    monkeypatch.setattr(module.shutil, 'disk_usage', lambda path: SimpleNamespace(free=10*1024**3))
    # Safely bootstrap SDK storage before installing its offline metadata adapter.
    FullRawCapture(tmp_path / 'bootstrap', roster=['2330'], required={'close': 'price:收盤價'}).make_sdk_storage()
    get_module = importlib.import_module('finlab.data.get')
    auth = importlib.import_module('finlab.data.auth')
    from finlab import data
    previous_storage = data._storage
    previous_finalize = get_module._finalize
    payloads = {}
    for field, dataset in module.DATASETS.items():
        if field == 'holding':
            # Exact live wire schema: categorical stock_id, not SDK-finalized symbol.
            frame = pd.DataFrame({'date': pd.to_datetime(['2026-10-13']),
                                  'stock_id': pd.Categorical(['2330']),
                                  '持股分級': pd.Categorical(['1']), '占集保庫存數比例': [0.]})
        elif field in {'disclosure', 'deadline'}:
            frame = pd.DataFrame({'date': ['2026-Q3'], '2330 A': pd.to_datetime(['2026-10-13']),
                                  '2330 B': pd.to_datetime(['2026-10-13'])})
        else:
            day = '2026-Q3' if field in {'eps', 'roe', 'revenue_growth_yoy'} else pd.Timestamp('2026-10-13')
            frame = pd.DataFrame({'date': [day], '2330 A': [0.], '2330 B': [0.]})
        stream = io.BytesIO()
        frame.to_feather(stream)
        payloads[dataset] = stream.getvalue()
    calls = []
    def metadata(items):
        calls.extend(items)
        return OrderedDict((key, auth.FetchMetadata(expiry=datetime(2030, 1, 1, tzinfo=timezone.utc),
                              url=key, role='vip')) for key in items)
    monkeypatch.setattr(get_module, 'fetch_metadata_batch', metadata)
    monkeypatch.setattr(module, 'probe_quota', lambda: {'observed_at': datetime.now(timezone.utc).isoformat(),
                        'used_mb': 0., 'limit_mb': 5000., 'unexpected_download_payload': False})
    monkeypatch.setattr(guard, 'bounded_download', lambda url, headers, **kwargs: payloads[url])
    capture = module.DailyVendorCapture(tmp_path / 'native', roster=['2330'])
    assert calls == list(module.DATASETS.values())
    for field in module.DATASETS:
        record = capture.receipt['datasets'][field]
        assert (capture.root / record['path']).read_bytes() == payloads[module.DATASETS[field]]
        frame, proof = capture.read(field)
        assert proof['raw_sha256'] == record['sha256']
        if field == 'holding':
            assert frame['symbol'].cast(pl.String).to_list() == ['2330']
            assert frame['占集保庫存數比例'].to_list() == [0.]
            assert record['inventory']['identity_column'] == 'stock_id'
        if field not in {'holding', 'deadline', 'disclosure'}:
            assert frame['2330'].to_list() == [0.]
    assert data._storage is previous_storage and get_module._finalize is previous_finalize
    assert capture.receipt['formal_admission_passed'] is False

    # Next business run asks the vendor for updates, then reuses exact sealed
    # bytes. A genuine update still uses the real SDK's original raw path.
    objects = {'prior/inference-native/' + str(path.relative_to(capture.root)).replace('\\', '/'):
               path.read_bytes() for path in capture.root.rglob('*') if path.is_file()}
    raw = objects['prior/inference-native/capture.json']
    baseline = {'input_manifests': [{'path':'prior/inference-native/capture.json',
                                    'sha256':hashlib.sha256(raw).hexdigest()}]}
    bucket = SimpleNamespace(blob=lambda path: SimpleNamespace(download_as_bytes=lambda: objects[path]))
    checks = []
    def unchanged(items):
        checks.append(items)
        return {key: auth.FetchMetadata(expiry=datetime(2030, 1, 1, tzinfo=timezone.utc)) for key in items}
    monkeypatch.setattr(auth, 'fetch_metadata_batch', unchanged)
    calls.clear()
    next_capture = module.DailyVendorCapture(tmp_path/'next', roster=['2330'],bucket=bucket,baseline=baseline)
    assert calls == []
    assert list(checks[0]) == [dataset+'.recent' for dataset in module.DATASETS.values()]
    assert all(stamp.tzinfo is not None for stamp in checks[0].values())
    for field in module.DATASETS:
        assert next_capture.receipt['datasets'][field]['sha256'] == capture.receipt['datasets'][field]['sha256']
        assert next_capture.receipt['datasets'][field]['source_status'] == 'vendor_confirmed_unchanged'
    def changed(items):
        result = unchanged(items)
        result[module.DATASETS['holding']+'.recent'].url = 'changed-inventory'
        result[module.DATASETS['revenue']+'.recent'].url = 'changed-revenue'
        return result
    monkeypatch.setattr(auth, 'fetch_metadata_batch', changed)
    module.DailyVendorCapture(tmp_path/'changed', roster=['2330'],bucket=bucket,baseline=baseline)
    assert calls == [module.DATASETS['revenue'], module.DATASETS['holding']]

    calls.clear()
    def denied(items):
        result = unchanged(items)
        result[next(iter(result))].error = 'permission denied'
        return result
    monkeypatch.setattr(auth, 'fetch_metadata_batch', denied)
    with pytest.raises(ValueError, match='update_status_unavailable'):
        module.DailyVendorCapture(tmp_path/'denied', roster=['2330'],bucket=bucket,baseline=baseline)
    assert not calls


def test_daily_quota_preflight_blocks_before_any_capture(monkeypatch, tmp_path):
    monkeypatch.setattr(module, 'probe_quota', lambda: {'observed_at': datetime.now(timezone.utc).isoformat(),
                        'used_mb': 4999., 'limit_mb': 5000., 'unexpected_download_payload': False})
    def unexpected(*args, **kwargs):
        raise AssertionError('capture dispatched despite quota failure')
    monkeypatch.setattr(module, 'FullRawCapture', unexpected)
    with pytest.raises(ValueError, match='quota_headroom_insufficient'):
        module.DailyVendorCapture(tmp_path / 'native', roster=['2330'])
    assert not (tmp_path / 'native').exists()
