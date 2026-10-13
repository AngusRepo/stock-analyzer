"""Exercise the real pinned SDK and raw writer with offline wire payloads."""
import importlib
import io
from collections import OrderedDict
from datetime import datetime, timezone

import pandas as pd
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
            frame = pd.DataFrame({'date': pd.to_datetime(['2026-10-13']), 'symbol': ['2330'],
                                  '持股分級': [1], '占集保庫存數比例': [2.]})
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
        if field not in {'holding', 'deadline', 'disclosure'}:
            assert frame['2330'].to_list() == [0.]
    assert data._storage is previous_storage and get_module._finalize is previous_finalize
    assert capture.receipt['formal_admission_passed'] is False


def test_daily_quota_preflight_blocks_before_any_capture(monkeypatch, tmp_path):
    monkeypatch.setattr(module, 'probe_quota', lambda: {'observed_at': datetime.now(timezone.utc).isoformat(),
                        'used_mb': 4999., 'limit_mb': 5000., 'unexpected_download_payload': False})
    def unexpected(*args, **kwargs):
        raise AssertionError('capture dispatched despite quota failure')
    monkeypatch.setattr(module, 'FullRawCapture', unexpected)
    with pytest.raises(ValueError, match='quota_headroom_insufficient'):
        module.DailyVendorCapture(tmp_path / 'native', roster=['2330'])
    assert not (tmp_path / 'native').exists()
