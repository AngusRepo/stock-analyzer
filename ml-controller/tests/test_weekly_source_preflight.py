"""Weekly source presence gates run before Jobs or large replay inputs."""
from copy import deepcopy
import json
import sys
import types

import polars as pl
import pytest
from fastapi import HTTPException

try:
    import google.cloud as google_cloud
except ImportError:
    google_cloud = sys.modules.setdefault('google.cloud', types.ModuleType('google.cloud'))
if not hasattr(google_cloud, 'run_v2'):
    stub = types.SimpleNamespace(JobsClient=object, ExecutionsClient=object)
    google_cloud.run_v2 = stub
    sys.modules.setdefault('google.cloud.run_v2', stub)

from routers import backtest
from services import weekly_evidence_service as service, cloud_run_jobs_client
from services.backtest_corporate_accounting import require_corporate_component, load_corporate_tape

RUN_ID = 'weekly-backtest-2026-08-23-1787500000000-abcdef123456'
PARAMS = {'positionRiskDistribution': {'maxPerSector': 3, 'maxSingleNamePct': .18,
    'correlationThreshold': .65, 'correlationWindow': 60, 'minCorrelationOverlap': 20}}


def manifest(present=True):
    components = {'prices': 'gs://fixture/prices'}
    if present:
        components['corporate_source_records'] = 'gs://fixture/original-receipts'
    return {'snapshot_id': 'weekly-source-fixture', 'business_date': '2026-08-21',
        'created_at': '2026-08-21T13:00:00Z', 'checksum': 'a' * 64,
        'kind': 'backtest_dataset', 'schema_version': 'backtest-dataset-parquet-v2',
        'producer_run_id': 'fixture', 'primary_store': 'gcs', 'access_tier': 'compute',
        'gcs_uri': 'gs://fixture', 'row_count': 0,
        'metadata_json': {'start_date': '2025-01-01', 'end_date': '2026-08-21',
            'components': components, 'component_meta': {'corporate_source_records': {'row_count': 0}}}}


@pytest.mark.parametrize('metadata_string', [False, True])
def test_missing_component_blocks_before_dataset_download_and_replay(monkeypatch, metadata_string):
    snapshot = manifest(False)
    if metadata_string:
        snapshot['metadata_json'] = json.dumps(snapshot['metadata_json'])
    monkeypatch.setattr(service, 'latest_dataset_snapshot', lambda **_: snapshot)
    calls = []
    def forbidden(**kwargs):
        calls.append(kwargs)
        raise AssertionError('heavy operation must not be called')
    monkeypatch.setattr(service.BacktestDataset, 'load_from_snapshot_manifest', forbidden)
    monkeypatch.setattr(service, 'replay_period', forbidden)
    before = deepcopy(snapshot)
    with pytest.raises(RuntimeError, match='backtest_corporate_component_missing:weekly-source-fixture'):
        service._replay(as_of_date='2026-08-23', params=PARAMS, initial_capital=100, symbols=None)
    assert calls == [] and snapshot == before
    status = service.preflight_weekly_backtest_source('2026-08-23')
    assert status['status'] == 'blocked' and status['heavy_compute_started'] is False


def test_declared_zero_row_component_is_not_absence_or_content_certification(monkeypatch):
    snapshot = manifest()
    before = deepcopy(snapshot)
    monkeypatch.setattr(service, 'latest_dataset_snapshot', lambda **_: snapshot)
    result = service.preflight_weekly_backtest_source('2026-08-23')
    assert result['status'] == 'ready' and result['component_contents_verified'] is False
    assert snapshot == before
    # Existing loader permits an empty schema-valid tape; daily coverage remains
    # enforced only when positions/receivables require it. Do not alter that gate.
    assert load_corporate_tape(pl.DataFrame(schema={'record_json': pl.String})) == {}


def test_present_component_retains_original_replay_arguments_and_provenance(monkeypatch):
    snapshot, dataset, metrics, calls = manifest(), object(), object(), []
    monkeypatch.setattr(service, 'latest_dataset_snapshot', lambda **_: snapshot)
    def load(**kwargs):
        calls.append(('load', kwargs))
        return dataset
    def replay(**kwargs):
        calls.append(('replay', kwargs))
        return metrics
    monkeypatch.setattr(service.BacktestDataset, 'load_from_snapshot_manifest', load)
    monkeypatch.setattr(service, 'replay_period', replay)
    result, provenance = service._replay(as_of_date='2026-08-23', params=PARAMS,
                                         initial_capital=123, symbols=['2330'])
    assert result is metrics
    assert calls == [('load', {'manifest': snapshot, 'start_date': '2025-01-01',
        'end_date': '2026-08-21', 'symbols': ['2330']}), ('replay', {'dataset': dataset,
        'start_date': '2025-01-01', 'end_date': '2026-08-21', 'params': PARAMS,
        'initial_capital': 123, 'mode': 'B'})]
    assert provenance['snapshot_id'] == snapshot['snapshot_id']
    assert provenance['snapshot_checksum'] == snapshot['checksum']


@pytest.mark.asyncio
async def test_controller_missing_source_never_allocates_cloud_run_job(monkeypatch):
    monkeypatch.setattr(service, 'latest_dataset_snapshot', lambda **_: manifest(False))
    allocations = []
    def forbidden(**kwargs):
        allocations.append(kwargs)
        raise AssertionError('Cloud Run client must not be constructed')
    monkeypatch.setattr(cloud_run_jobs_client, 'CloudRunJobsClient', forbidden)
    with pytest.raises(HTTPException) as raised:
        await backtest.trigger_weekly_backtest_research_bundle(
            backtest.WeeklyBacktestResearchBundleRequest(run_date='2026-08-23', run_id=RUN_ID))
    assert raised.value.status_code == 409
    assert raised.value.detail['status'] == 'blocked' and raised.value.detail['triggered'] is False
    assert 'backtest_corporate_component_missing' in raised.value.detail['reason']
    # Worker logs only the first 200 body bytes; keep the actionable cause early.
    assert 'backtest_corporate_component_missing' in json.dumps({'detail': raised.value.detail})[:200]
    assert allocations == []


@pytest.mark.asyncio
async def test_controller_valid_component_preserves_job_dispatch(monkeypatch):
    monkeypatch.setattr(service, 'latest_dataset_snapshot', lambda **_: manifest())
    captured = []
    class Client:
        def __init__(self, *, job_name):
            captured.append(job_name)
        def run_job(self, **kwargs):
            captured.append(kwargs)
            return types.SimpleNamespace(execution_id='job-123', execution_name='projects/p/job-123')
    monkeypatch.setattr(cloud_run_jobs_client, 'CloudRunJobsClient', Client)
    result = await backtest.trigger_weekly_backtest_research_bundle(
        backtest.WeeklyBacktestResearchBundleRequest(run_date='2026-08-23', run_id=RUN_ID))
    assert result['status'] == 'triggered' and result['execution_id'] == 'job-123'
    assert captured[1]['reject_if_running'] is True
    assert captured[1]['env_overrides']['OPTUNA_RUN_ID'] == RUN_ID


def test_manifest_can_change_after_dispatch_but_job_resolves_and_blocks_before_compute(monkeypatch):
    selected = [manifest(), manifest(False)]
    monkeypatch.setattr(service, 'latest_dataset_snapshot', lambda **_: selected.pop(0))
    assert service.preflight_weekly_backtest_source('2026-08-23')['status'] == 'ready'
    monkeypatch.setattr(service.BacktestDataset, 'load_from_snapshot_manifest',
                        lambda **_: pytest.fail('missing re-resolved source must block'))
    with pytest.raises(RuntimeError, match='backtest_corporate_component_missing'):
        service._replay(as_of_date='2026-08-23', params=PARAMS, initial_capital=100, symbols=None)


@pytest.mark.parametrize('failure', [RuntimeError('D1 authentication unavailable'),
                                     ConnectionError('D1 network unavailable')])
def test_transport_error_is_not_misreported_as_missing_corporate_data(monkeypatch, failure):
    def fail(**kwargs):
        raise failure
    monkeypatch.setattr(service, 'latest_dataset_snapshot', fail)
    with pytest.raises(type(failure)) as raised:
        service.preflight_weekly_backtest_source('2026-08-23')
    assert raised.value is failure


@pytest.mark.parametrize('value', [None, '', '  ', {}, []])
def test_invalid_component_reference_is_not_a_presence_pass(value):
    snapshot = manifest()
    snapshot['metadata_json']['components']['corporate_source_records'] = value
    with pytest.raises(RuntimeError, match='backtest_corporate_component_missing'):
        require_corporate_component(snapshot)


@pytest.mark.parametrize('metadata', ['{bad', ['not-a-metadata-object']])
@pytest.mark.asyncio
async def test_malformed_metadata_blocks_before_range_parse_or_job_allocation(monkeypatch, metadata):
    snapshot = manifest()
    snapshot['metadata_json'] = metadata
    monkeypatch.setattr(service, 'latest_dataset_snapshot', lambda **_: snapshot)
    heavy_calls = []
    def forbidden(**kwargs):
        heavy_calls.append(kwargs)
        raise AssertionError('malformed source must block before heavy work')
    monkeypatch.setattr(cloud_run_jobs_client, 'CloudRunJobsClient', forbidden)
    monkeypatch.setattr(service.BacktestDataset, 'load_from_snapshot_manifest', forbidden)
    monkeypatch.setattr(service, 'replay_period', forbidden)
    result = service.preflight_weekly_backtest_source('2026-08-23')
    assert result['status'] == 'blocked'
    assert result['reason'] == 'backtest_corporate_component_metadata_invalid'
    with pytest.raises(RuntimeError, match='backtest_corporate_component_metadata_invalid'):
        service._replay(as_of_date='2026-08-23', params=PARAMS, initial_capital=100, symbols=None)
    with pytest.raises(HTTPException) as raised:
        await backtest.trigger_weekly_backtest_research_bundle(
            backtest.WeeklyBacktestResearchBundleRequest(run_date='2026-08-23', run_id=RUN_ID))
    assert raised.value.status_code == 409
    assert raised.value.detail['reason'] == 'backtest_corporate_component_metadata_invalid'
    assert raised.value.detail['triggered'] is False
    assert heavy_calls == []


@pytest.mark.parametrize('state', ['ready', 'blocked', 'infra_error'])
@pytest.mark.asyncio
async def test_readonly_preflight_route_never_allocates_or_downloads(monkeypatch, state):
    failure = ConnectionError('D1 transport unavailable')
    source_reads, heavy_calls = [], []
    def selected(**kwargs):
        source_reads.append(kwargs)
        if state == 'infra_error':
            raise failure
        return manifest(state == 'ready')
    def forbidden(**kwargs):
        heavy_calls.append(kwargs)
        raise AssertionError('read-only preflight cannot allocate/download/replay')
    monkeypatch.setattr(service, 'latest_dataset_snapshot', selected)
    monkeypatch.setattr(cloud_run_jobs_client, 'CloudRunJobsClient', forbidden)
    monkeypatch.setattr(service.BacktestDataset, 'load_from_snapshot_manifest', forbidden)
    monkeypatch.setattr(service, 'replay_period', forbidden)
    if state == 'infra_error':
        with pytest.raises(ConnectionError) as raised:
            await backtest.weekly_backtest_source_preflight(run_date='2026-08-23')
        assert raised.value is failure
    else:
        result = await backtest.weekly_backtest_source_preflight(run_date='2026-08-23')
        assert result['status'] == state
        assert result['heavy_compute_started'] is False
        if state == 'ready':
            assert result['component_contents_verified'] is False
        else:
            assert 'backtest_corporate_component_missing' in result['reason']
    assert source_reads == [{'kind': 'backtest_dataset', 'as_of_business_date': '2026-08-23',
                             'access_tier': 'compute', 'required_components': ('signals', 'corporate_source_records'),
                             'available_before': '2026-08-24T00:00:00+08:00'}]
    assert heavy_calls == []


@pytest.mark.asyncio
async def test_readonly_preflight_route_uses_taiwan_today_when_date_omitted(monkeypatch):
    dates = []
    monkeypatch.setattr(backtest, 'taiwan_today', lambda: '2026-08-23')
    def preflight(day):
        dates.append(day)
        return {'status': 'blocked', 'reason': 'fixture', 'heavy_compute_started': False}
    monkeypatch.setattr(backtest, 'preflight_weekly_backtest_source', preflight)
    result = await backtest.weekly_backtest_source_preflight(run_date=None)
    assert dates == ['2026-08-23'] and result['status'] == 'blocked'


@pytest.mark.asyncio
async def test_readonly_preflight_http_date_validation_precedes_source_query(monkeypatch):
    import httpx
    from fastapi import FastAPI
    app = FastAPI()
    app.include_router(backtest.router)
    source_calls = []
    monkeypatch.setattr(backtest, 'preflight_weekly_backtest_source',
                        lambda day: source_calls.append(day))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture') as client:
        response = await client.get('/backtest/research-bundle/preflight', params={'run_date': '2026/08/23'})
    assert response.status_code == 422 and source_calls == []



def test_ga_history_selector_is_separate_from_generic_pipeline_snapshots(monkeypatch):
    from services import weekly_evidence_service as weekly
    seen=[]
    def latest(**kwargs):
        seen.append(kwargs)
        return None
    monkeypatch.setattr(weekly,'latest_dataset_snapshot',latest)
    with pytest.raises(RuntimeError,match='snapshot_not_ready'):
        weekly._resolve_snapshot('2026-10-03',prefer_corporate_history=True)
    assert [r['kind'] for r in seen]==['ga_research_dataset','backtest_dataset']
