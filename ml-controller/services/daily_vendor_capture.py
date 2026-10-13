"""Bounded native observations for daily inference, before SDK alias transforms."""
from __future__ import annotations

import hashlib
import json
import math
import shutil
from pathlib import Path

import polars as pl

from services.finlab_sealed_raw import read_numeric_field
from services.vendor_raw_capture import FullRawCapture
from services.vendor_raw_resource_guard import capture_one, preflight, probe_quota

DATASETS = {
    'dividend_yield': 'price_earning_ratio:殖利率(%)',
    'revenue': 'monthly_revenue:當月營收',
    'revenue_yoy': 'monthly_revenue:去年同月增減(%)',
    'revenue_mom': 'monthly_revenue:上月比較增減(%)',
    'eps': 'fundamental_features:每股稅後淨利',
    'roe': 'fundamental_features:ROE稅後',
    'revenue_growth_yoy': 'fundamental_features:營收成長率',
    'disclosure': 'etl:financial_statements_disclosure_dates',
    'deadline': 'etl:financial_statements_deadline',
    'holding': 'inventory',
}
# Independent conservative quota allowance; bytes are not a vendor billing proof.
WIRE_BYTES = {field: 64 * 1024**2 for field in DATASETS}
WIRE_BYTES['holding'] = 256 * 1024**2
QUOTA_MB = {field: 80.0 for field in DATASETS}
QUOTA_MB['holding'] = 320.0


class DailyVendorCapture:
    def __init__(self, root: Path, *, roster):
        quota = probe_quota()
        preflight(quota, max_wire_bytes=max(WIRE_BYTES.values()),
                  quota_reserve_mb=math.fsum(QUOTA_MB.values()),
                  free_bytes=shutil.disk_usage(root.parent).free,
                  disk_floor_bytes=256 * 1024**2)
        cap = FullRawCapture(root, roster=roster, required=DATASETS, max_seconds=900)
        for field in DATASETS:
            capture_one(cap, field, max_wire_bytes=WIRE_BYTES[field],
                        quota_reserve_mb=QUOTA_MB[field], disk_floor_bytes=256 * 1024**2,
                        quota_provider=probe_quota)
        cap.finish()
        self.root = root
        raw = (root / 'capture.json').read_bytes()
        self.receipt = json.loads(raw)
        self.receipt_sha256 = hashlib.sha256(raw).hexdigest()

    def read(self, field):
        if field == 'holding':
            record = self.receipt['datasets'][field]
            path = self.root / record['path']
            if hashlib.sha256(path.read_bytes()).hexdigest() != record['sha256']:
                raise ValueError('daily_vendor_holding_checksum')
            return pl.read_ipc(path, memory_map=False), {'raw_sha256': record['sha256']}
        return read_numeric_field(self.root, receipt_sha256=self.receipt_sha256,
                                  field=field, expected_dataset=DATASETS[field],
                                  _date_owner=field in {'disclosure', 'deadline'})
