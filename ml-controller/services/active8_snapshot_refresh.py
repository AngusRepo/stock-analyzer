"""Keep ML compute snapshots complete after historical source repairs."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import uuid
from typing import Any


def missing_snapshot_price_dates(snapshot: dict, *, bucket: Any, expected_dates: list[str]) -> list[str]:
    import polars as pl

    meta = snapshot.get('metadata_json') or {}
    if isinstance(meta, str):
        meta = json.loads(meta)
    uri = (meta.get('components') or {}).get('prices', '')
    price_meta = (meta.get('component_meta') or {}).get('prices') or {}
    checksum = str(price_meta.get('content_checksum') or '').removeprefix('sha256:')
    if not uri.startswith(f'gs://{bucket.name}/') or len(checksum) != 64:
        raise ValueError('active8_snapshot_prices_lineage_missing')
    raw = bucket.blob(uri.removeprefix(f'gs://{bucket.name}/')).download_as_bytes()
    if hashlib.sha256(raw).hexdigest() != checksum:
        raise ValueError('active8_snapshot_prices_checksum_mismatch')
    frame = pl.read_parquet(io.BytesIO(raw), columns=['date'])
    observed = set(frame['date'].cast(pl.String).str.slice(0, 10).to_list())
    return sorted(set(expected_dates) - observed)


async def ensure_snapshot_price_dates(snapshot: dict, *, bucket: Any, expected_dates: list[str], dry_run: bool) -> dict:
    from services.active8_prep_lifecycle import Active8PrepDependencyPending
    from services.dataset_snapshot_exporter import DatasetSnapshotExportRequest, export_backtest_dataset_snapshot
    from services.dataset_snapshots import latest_dataset_snapshot

    missing = missing_snapshot_price_dates(snapshot, bucket=bucket, expected_dates=expected_dates)
    if not missing:
        return snapshot
    evidence = {'snapshot_id': snapshot['snapshot_id'], 'missing_price_dates': missing}
    if dry_run:
        raise Active8PrepDependencyPending('compute_snapshot_missing_source_dates', evidence)
    meta = snapshot['metadata_json']
    if isinstance(meta, str):
        meta = json.loads(meta)
    business_date = snapshot['business_date']
    # Existing exporter remains the owner. New objects/receipt retain the old
    # business date and today's actual creation time; never edit the old seal.
    await asyncio.to_thread(export_backtest_dataset_snapshot, DatasetSnapshotExportRequest(
        business_date=business_date, start_date=meta['start_date'], end_date=business_date,
        producer_run_id=f'active8-source-refresh:{business_date}:{uuid.uuid4().hex}',
        include_signals='signals' in (meta.get('components') or {}),
    ))
    refreshed = latest_dataset_snapshot(kind='backtest_dataset', access_tier='compute', business_date=business_date)
    if not refreshed or refreshed.get('manifest_errors') or refreshed.get('checksum') == snapshot.get('checksum'):
        raise Active8PrepDependencyPending('compute_snapshot_source_refresh_incomplete', evidence)
    remaining = missing_snapshot_price_dates(refreshed, bucket=bucket, expected_dates=expected_dates)
    if remaining:
        raise Active8PrepDependencyPending('compute_snapshot_source_refresh_incomplete', {**evidence, 'remaining_dates': remaining})
    return refreshed
