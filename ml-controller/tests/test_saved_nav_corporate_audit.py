"""Audit tool controls use synthetic rows, not actual investment returns."""
from datetime import datetime, timezone
import json

import polars as pl
import pytest

from scripts.audit_saved_nav_corporate_sources import audit
from services.paired_nav_journal import digest
from test_finlab_corporate_actions import row


def inputs(tmp_path):
    data = pl.DataFrame([row()])
    catalog = tmp_path / 'catalog.parquet'
    inventory = tmp_path / 'inventory.json'
    data.write_parquet(catalog)
    meta = {'data_checksum': digest(data.write_json()),
        'observed_at': datetime(2026, 9, 8, tzinfo=timezone.utc).isoformat(),
        'window': ['2026-09-07', '2026-09-07']}
    inventory.write_text(json.dumps(meta), encoding='utf-8')
    return catalog, inventory, meta


def test_saved_source_audit_has_no_maturity_or_economic_claim(tmp_path):
    catalog, inventory, _ = inputs(tmp_path)
    result = audit(catalog, inventory)
    assert result['catalog_rows'] == result['symbol_sessions'] == result['sessions'] == 1
    assert result['normalized_actions'] == 2
    assert result['historical_capture_proven'] is False
    assert result['portfolio_returns_available'] is False
    assert result['performance_improvement_claim'] is False
    assert result['prospective_credit'] == result['production_writes'] == 0


@pytest.mark.parametrize('fault', ['checksum', 'future'])
def test_saved_source_audit_rejects_changed_catalog_or_future_window(tmp_path, fault):
    catalog, inventory, meta = inputs(tmp_path)
    if fault == 'checksum':
        meta['data_checksum'] = '0' * 64
    else:
        meta['observed_at'] = '2026-09-06T00:00:00+00:00'
    inventory.write_text(json.dumps(meta), encoding='utf-8')
    with pytest.raises(ValueError, match='saved_corporate_catalog'):
        audit(catalog, inventory)
