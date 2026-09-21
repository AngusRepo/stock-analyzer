import asyncio
import hashlib
import io
import json
from types import SimpleNamespace

import polars as pl
import pytest

from services.active8_prep_lifecycle import Active8PrepDependencyPending
from services.active8_snapshot_refresh import ensure_snapshot_price_dates, missing_snapshot_price_dates


def fixture(dates, name='old'):
    buffer = io.BytesIO()
    pl.DataFrame({'date': dates}).write_parquet(buffer)
    raw = buffer.getvalue()
    snapshot = {'snapshot_id': name, 'business_date': '2026-09-04', 'checksum': name,
                'metadata_json': json.dumps({'start_date': '2025-04-18',
                    'components': {'prices': f'gs://test/{name}.parquet'},
                    'component_meta': {'prices': {'content_checksum': hashlib.sha256(raw).hexdigest()}}})}
    return snapshot, raw


def bucket(store):
    return SimpleNamespace(name='test', blob=lambda path: SimpleNamespace(download_as_bytes=lambda: store[path]))


def test_missing_middle_date_is_detected_despite_correct_latest_date():
    snapshot, raw = fixture(['2026-08-19', '2026-08-21', '2026-09-04'])
    assert missing_snapshot_price_dates(snapshot, bucket=bucket({'old.parquet': raw}),
                                        expected_dates=['2026-08-19', '2026-08-20', '2026-08-21']) == ['2026-08-20']


def test_checksum_mismatch_cannot_trigger_trusted_recovery():
    snapshot, _ = fixture(['2026-08-20'])
    with pytest.raises(ValueError, match='checksum_mismatch'):
        missing_snapshot_price_dates(snapshot, bucket=bucket({'old.parquet': b'corrupt'}), expected_dates=['2026-08-20'])


def test_dry_run_reports_gap_without_export(monkeypatch):
    from services import dataset_snapshot_exporter as exporter
    monkeypatch.setattr(exporter, 'export_backtest_dataset_snapshot', lambda _: pytest.fail('dry run wrote'))
    snapshot, raw = fixture(['2026-08-19'])
    with pytest.raises(Active8PrepDependencyPending, match='missing_source_dates'):
        asyncio.run(ensure_snapshot_price_dates(snapshot, bucket=bucket({'old.parquet': raw}), expected_dates=['2026-08-20'], dry_run=True))


@pytest.mark.parametrize('repaired', [True, False])
def test_refresh_uses_original_exporter_and_verifies_result(monkeypatch, repaired):
    from services import dataset_snapshot_exporter as exporter, dataset_snapshots
    old, old_raw = fixture(['2026-08-19'])
    new, new_raw = fixture(['2026-08-19', '2026-08-20'] if repaired else ['2026-08-19'], 'new')
    store = {'old.parquet': old_raw, 'new.parquet': new_raw}
    calls = []
    monkeypatch.setattr(exporter, 'export_backtest_dataset_snapshot', lambda req: calls.append(req))
    monkeypatch.setattr(dataset_snapshots, 'latest_dataset_snapshot', lambda **_: new)
    task = ensure_snapshot_price_dates(old, bucket=bucket(store), expected_dates=['2026-08-19', '2026-08-20'], dry_run=False)
    if repaired:
        assert asyncio.run(task) == new
    else:
        with pytest.raises(Active8PrepDependencyPending, match='refresh_incomplete'):
            asyncio.run(task)
    assert len(calls) == 1
    assert calls[0].business_date == '2026-09-04'
    assert calls[0].start_date == '2025-04-18'
    assert calls[0].producer_run_id.startswith('active8-source-refresh:')
    assert store['old.parquet'] == old_raw


@pytest.mark.parametrize("state,manifest,expected", [
    ("succeeded", {"snapshot_id": "new"}, None),
    ("failed", {"snapshot_id": "new"}, "inference_snapshot_job_failed"),
    ("succeeded", None, "inference_snapshot_manifest_missing"),
    ("succeeded", {"manifest_errors": ["bad checksum"]}, "inference_snapshot_manifest_missing"),
])
def test_inference_snapshot_requires_completed_job_and_verified_manifest(monkeypatch, state, manifest, expected):
    from services import cloud_run_jobs_client as jobs, dataset_snapshots
    from services.active8_snapshot_refresh import produce_inference_snapshot
    calls = []
    class Client:
        def __init__(self, **kw): pass
        def run_job(self, **kw):
            calls.append(kw)
            return SimpleNamespace(execution_id="input-job")
        def execution_state(self, execution): return state
    monkeypatch.setenv("DATASET_SNAPSHOT_JOB_NAME", "dataset-snapshot-export")
    monkeypatch.setattr(jobs, "CloudRunJobsClient", Client)
    def latest(**kw):
        assert kw['business_date'] == '2026-09-21'
        return manifest
    monkeypatch.setattr(dataset_snapshots, "latest_dataset_snapshot", latest)
    task = produce_inference_snapshot(business_date='2026-09-21', required_history=1280)
    if expected:
        with pytest.raises(Active8PrepDependencyPending, match=expected): asyncio.run(task)
    else:
        assert asyncio.run(task) == manifest
    assert calls[0]['reject_if_running'] is True
    env = calls[0]['env_overrides']
    assert env['DATASET_SNAPSHOT_INPUT_ONLY'] == '1'
    assert env['STOCKVISION_RESEARCH_SNAPSHOT_LOOKBACK_DAYS'] == '1280'


def test_inference_snapshot_joins_existing_producer_without_duplicate(monkeypatch):
    from services import cloud_run_jobs_client as jobs, dataset_snapshots
    from services.active8_snapshot_refresh import produce_inference_snapshot
    execution = SimpleNamespace(execution_id='existing')
    class Client:
        def __init__(self, **kw): pass
        def run_job(self, **kw): raise jobs.JobAlreadyRunningError(execution)
        def execution_state(self, observed):
            assert observed is execution
            return 'succeeded'
    monkeypatch.setenv('DATASET_SNAPSHOT_JOB_NAME', 'dataset-snapshot-export')
    monkeypatch.setattr(jobs, 'CloudRunJobsClient', Client)
    monkeypatch.setattr(dataset_snapshots, 'latest_dataset_snapshot', lambda **_: {'snapshot_id': 'ready'})
    assert asyncio.run(produce_inference_snapshot(business_date='2026-09-21', required_history=1280)) == {'snapshot_id': 'ready'}
