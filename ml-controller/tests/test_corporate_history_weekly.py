"""Weekly research corporate-history export: scope, fetch, frozen reviewed rules, compile, gate, export."""
import asyncio
import hashlib
import json
from pathlib import Path
import shutil
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))

from services import corporate_history_weekly as weekly  # noqa: E402
from services.research_corporate_history import load_history_artifact  # noqa: E402
from test_compile_corporate_history import spec_fixture  # noqa: E402

URI = 'gs://bucket/research/corporate_history/baseline/b1/baseline.json'
BASELINE_DAYS = ['2026-09-03', '2026-09-04']
BUNDLE = json.dumps({'schema': 'issuer-bundle', 'issuers': {}}).encode()
STOCKS = [{'symbol': s, 'market': m, 'listed_date': '2000-01-01', 'delisted_date': None}
          for s, m in (('0056', 'TWSE'), ('1101', 'TWSE'), ('2330', 'TWSE'), ('020000', 'TWSE'))]


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def baseline_objects(days=BASELINE_DAYS, bundle=BUNDLE, **overrides):
    baseline = {'schema_version': weekly.BASELINE_SCHEMA, 'baseline_id': 'b1', 'history_start': days[0],
                'days': days, 'days_sha256': sha(json.dumps(sorted(days)).encode()),
                'reviewed_stock_rules': [], 'reviewed_subscription_rules': [], 'cash_rounding_rules': [],
                'extra_sources': [{'dataset': 'mops.issuer_evidence_bundle', 'object': 'issuer_bundle.json',
                                   'fetched_at': '2026-09-01T00:00:00+00:00', 'sha256': sha(BUNDLE)}],
                **overrides}
    return {URI: json.dumps(baseline).encode(), URI.rsplit('/', 1)[0] + '/issuer_bundle.json': bundle}


class Harness:
    def __init__(self, tmp_path, *, objects=None, sessions=('2026-09-07',), fetched_at=None):
        self.objects = objects or baseline_objects()
        self.sessions = list(sessions)
        self.fetched_at = fetched_at
        self.src = tmp_path / 'src'
        self.src.mkdir()
        self.fixture = spec_fixture(self.src)
        self.exports, self.queries, self.fetched = [], [], {}

    def read(self, uri):
        return self.objects[uri]

    def market_query(self, sql, params):
        self.queries.append((sql, params))
        return [{'session_date': d} for d in self.sessions if params[0] < d <= params[1]]

    def fetch(self, out, *, days_path, universe_path):
        # What seal_fetch leaves behind: sealed sources plus spec.json naming them relative to OUT_DIR.
        self.fetched = {'days': json.loads(days_path.read_text()), 'universe': json.loads(universe_path.read_text())}
        sources = {}
        for name, entry in self.fixture['sources'].items():
            shutil.copy(self.src / entry['path'], out / entry['path'])
            sources[name] = {**entry, 'fetched_at': self.fetched_at or entry['fetched_at']}
        spec = {'days': str(days_path), 'universe': str(universe_path), 'sources': sources, 'issuer_evidence': {},
                'cash_rounding_rules': [], 'reviewed_stock_rules': [], 'captured_at': '2026-10-03T01:00:00+00:00'}
        (out / 'spec.json').write_text(json.dumps(spec, ensure_ascii=False), encoding='utf-8')
        return {'finlab_calls': 7}

    def export(self, artifact, checksum, *, start, end, run_id):
        load_history_artifact(artifact, checksum)  # the exporter's own artifact check
        self.exports.append({'checksum': checksum, 'start': start, 'end': end, 'run_id': run_id})
        return {'status': 'ready', 'snapshot': {'snapshot_id': f'ga_research_dataset:{end}:{run_id}',
                                                'kind': 'ga_research_dataset', 'business_date': end, 'row_count': 9}}

    def deps(self):
        return {'read': self.read, 'market_query': self.market_query, 'active_stocks': lambda s, e: STOCKS,
                'fetch': self.fetch, 'export_ready': lambda: None, 'archive': self.archive, 'export': self.export}

    def archive(self, workdir, run_id):
        self.archived = sorted(p.relative_to(workdir).as_posix() for p in workdir.rglob('*') if p.is_file())
        return f'gs://b/research/corporate_history/weekly/{run_id}/'

    def run(self, tmp_path, run_date='2026-09-07'):
        return weekly.run_corporate_history_weekly(run_date, run_id=f'corporate-history-weekly-{run_date}-abcdef12',
                                                   workdir=tmp_path / 'work', baseline_uri=URI,
                                                   baseline_sha256=sha(self.objects[URI]), deps=self.deps())


def test_weekly_run_extends_the_sealed_calendar_and_exports_a_fresh_history(tmp_path):
    h = Harness(tmp_path)
    result = h.run(tmp_path)
    assert h.fetched['days'] == [*BASELINE_DAYS, '2026-09-07']
    assert h.fetched['universe'] == sorted(s['symbol'] for s in STOCKS)
    sql, params = h.queries[0]
    assert 'market_trading_sessions' in sql and params == ['2026-09-04', '2026-09-07']
    assert h.exports == [{'checksum': result['artifact_sha256'], 'start': '2026-09-03', 'end': '2026-09-07',
                          'run_id': 'corporate-history-weekly-2026-09-07-abcdef12'}]
    assert result['status'] == 'exported' and result['history_end'] == '2026-09-07' and result['sessions'] == 3
    assert result['snapshot_id'].startswith('ga_research_dataset:2026-09-07:')
    assert {g['window_days'] for g in result['exclusion']} == {4, 90, 365}  # full window is end - start
    spec = json.loads((tmp_path / 'work' / 'spec_weekly.json').read_text())
    assert spec['extra_sources'][0]['sha256'] == sha(BUNDLE)  # the frozen reviewed bundle is cited
    assert 'max_exclusion=' in weekly.format_summary(result)
    # The temporary work dir dies with the job: every sealed input is archived before the export.
    assert {'corporate_history.parquet', 'gate.json', 'spec_weekly.json', 'days.json', 'universe.json',
            'baseline-issuer_bundle.json', 'fetch/spec.json'} <= set(h.archived)
    assert result['archive_uri'] == 'gs://b/research/corporate_history/weekly/corporate-history-weekly-2026-09-07-abcdef12/'


def test_a_baseline_that_differs_from_the_git_pin_stops_before_any_fetch(tmp_path):
    h = Harness(tmp_path)
    with pytest.raises(weekly.CorporateHistoryWeeklyError, match='baseline_checksum_mismatch'):
        weekly.run_corporate_history_weekly('2026-09-07', run_id='corporate-history-weekly-2026-09-07-abcdef12',
                                            workdir=tmp_path / 'work', baseline_uri=URI, baseline_sha256='0' * 64,
                                            deps=h.deps())
    assert h.fetched == {} and h.exports == []


def test_the_repo_pin_names_an_object_under_the_job_bucket(tmp_path, monkeypatch):
    monkeypatch.setenv('GCS_BUCKET_NAME', 'bucket')
    uri, digest = weekly.pinned_baseline()
    assert uri.startswith('gs://bucket/research/corporate_history/baseline/') and uri.endswith('/baseline.json')
    assert len(digest) == 64
    monkeypatch.delenv('GCS_BUCKET_NAME')
    with pytest.raises(weekly.CorporateHistoryWeeklyError, match='GCS_BUCKET_NAME'):
        weekly.pinned_baseline()
    bad = tmp_path / 'pin.json'
    bad.write_text(json.dumps({'schema_version': weekly.PIN_SCHEMA, 'object': '../x/baseline.json', 'sha256': '0' * 64}))
    with pytest.raises(weekly.CorporateHistoryWeeklyError, match='pin_invalid'):
        weekly.pinned_baseline(bad)


def test_the_universe_keeps_the_reviewed_markets_only(monkeypatch):
    import polars as pl
    import services.dataset_snapshot_exporter as exporter
    rows = pl.DataFrame({'symbol': ['2330', '6488', '7777', '9999'], 'market': ['TWSE', 'OTC', 'ROTC', None],
                         'listed_date': [None] * 4, 'delisted_date': [None] * 4})
    monkeypatch.setattr(exporter, '_query_active_stocks', lambda start, end: rows)
    assert [s['symbol'] for s in weekly.active_stocks('2024-12-31', '2026-11-27')] == ['2330', '6488']


def test_a_tampered_baseline_object_stops_before_any_fetch(tmp_path):
    objects = baseline_objects()
    objects[URI.rsplit('/', 1)[0] + '/issuer_bundle.json'] = b'{"tampered": true}'
    h = Harness(tmp_path, objects=objects)
    with pytest.raises(weekly.CorporateHistoryWeeklyError, match='object_checksum_mismatch'):
        h.run(tmp_path)
    assert h.fetched == {} and h.exports == []


@pytest.mark.parametrize('overrides, reason', [
    ({'schema_version': 'other'}, 'schema_invalid'),
    ({'days_sha256': '0' * 64}, 'days_checksum_mismatch'),
    ({'history_start': '2026-09-04'}, 'start_not_first_session'),
    ({'reviewed_stock_rules': 'rules.json'}, 'reviewed_stock_rules_invalid'),
])
def test_an_invalid_baseline_is_refused(tmp_path, overrides, reason):
    h = Harness(tmp_path, objects=baseline_objects(**overrides))
    with pytest.raises(weekly.CorporateHistoryWeeklyError, match=reason):
        h.run(tmp_path)
    assert h.exports == []


def test_an_object_name_cannot_leave_the_baseline_prefix(tmp_path):
    objects = baseline_objects()
    baseline = json.loads(objects[URI])
    baseline['extra_sources'][0]['object'] = '../other/issuer_bundle.json'
    objects[URI] = json.dumps(baseline).encode()
    with pytest.raises(weekly.CorporateHistoryWeeklyError, match='object_name_invalid'):
        Harness(tmp_path, objects=objects).run(tmp_path)


def test_no_new_session_after_the_baseline_publishes_nothing(tmp_path):
    h = Harness(tmp_path, sessions=())
    with pytest.raises(weekly.CorporateHistoryWeeklyError, match='no_new_sessions_after:2026-09-04'):
        h.run(tmp_path)
    assert h.exports == []
    with pytest.raises(weekly.CorporateHistoryWeeklyError, match='run_date_not_after_baseline'):
        (tmp_path / 'b').mkdir()
        Harness(tmp_path / 'b', sessions=()).run(tmp_path / 'b', run_date='2026-09-04')


def test_a_fetch_before_the_last_session_cutoff_never_exports_a_short_history(tmp_path):
    # Sources fetched before 2026-09-07 09:00 TW cannot prove that session: a named stop, no export.
    h = Harness(tmp_path, fetched_at='2026-09-06T00:00:00+00:00')
    with pytest.raises(weekly.CorporateHistoryWeeklyError,
                       match='target_end_not_reached:history_end=2026-09-04:target=2026-09-07'):
        h.run(tmp_path)
    assert h.exports == []


def test_an_exclusion_share_above_the_limit_publishes_nothing(tmp_path, monkeypatch):
    stop = {'window_days': 365, 'status': 'STOPS', 'excluded_count': 900, 'holdable_symbols': 2000,
            'excluded_share': 0.45}
    monkeypatch.setattr(weekly, 'exclusion_gate', lambda tape, stocks, start, end: [stop])
    h = Harness(tmp_path)
    with pytest.raises(weekly.CorporateHistoryWeeklyError, match='exclusion_share_above_limit:365d=900/2000'):
        h.run(tmp_path)
    assert h.exports == [] and not hasattr(h, 'archived')


def test_export_refusals_stop_before_the_write(tmp_path):
    h = Harness(tmp_path)
    deps = h.deps()

    def refuse():
        raise weekly.CorporateHistoryWeeklyError('corporate_history_export_d1_domain_not_routed:paper')
    deps['export_ready'] = refuse
    with pytest.raises(weekly.CorporateHistoryWeeklyError, match='not_routed:paper'):
        weekly.run_corporate_history_weekly('2026-09-07', run_id='corporate-history-weekly-2026-09-07-abcdef12',
                                            workdir=tmp_path / 'work', baseline_uri=URI,
                                            baseline_sha256=sha(h.objects[URI]), deps=deps)
    assert h.exports == []


def test_the_baseline_builder_round_trips_through_the_weekly_loader(tmp_path):
    from build_corporate_history_baseline import build
    src = tmp_path / 'spec'
    src.mkdir()
    (src / 'days.json').write_text(json.dumps(['2026-09-04', '2026-09-03']))
    (src / 'issuer_bundle.json').write_bytes(BUNDLE)
    rules = [{'symbol': '1225', 'ex_date': '2025-09-24'}]
    spec = {'days': 'days.json', 'days_sha256': sha((src / 'days.json').read_bytes()),
            'reviewed_stock_rules': rules, 'reviewed_subscription_rules': [],
            'extra_sources': [{'dataset': 'mops.issuer_evidence_bundle', 'path': str(src / 'issuer_bundle.json'),
                               'fetched_at': '2026-09-01T00:00:00+00:00', 'sha256': sha(BUNDLE)}]}
    (src / 'spec.json').write_text(json.dumps(spec))
    report = build(src / 'spec.json', tmp_path / 'out', baseline_id='b1')
    assert report['objects'] == ['baseline.json', 'issuer_bundle.json'] and report['baseline_end'] == '2026-09-04'
    assert report['baseline_sha256'] == sha((tmp_path / 'out' / 'baseline.json').read_bytes())
    prefix = 'gs://bucket/p/'
    objects = {prefix + p.name: p.read_bytes() for p in (tmp_path / 'out').iterdir()}
    loaded = weekly.load_baseline(prefix + 'baseline.json', tmp_path, expected_sha256=report['baseline_sha256'],
                                  read=objects.__getitem__)
    assert loaded['days'] == BASELINE_DAYS and loaded['history_start'] == '2026-09-03'
    assert loaded['reviewed_stock_rules'] == rules and loaded['cash_rounding_rules'] == []
    assert Path(loaded['extra_sources'][0]['path']).read_bytes() == BUNDLE
    inline = {**spec, 'days': ['2026-09-04', '2026-09-03']}
    (src / 'inline.json').write_text(json.dumps(inline))
    assert build(src / 'inline.json', tmp_path / 'out-inline', baseline_id='b3')['sessions'] == 2
    (src / 'evidence.json').write_text(json.dumps({**spec, 'issuer_evidence': {'1225': 'x.pdf'}}))
    with pytest.raises(SystemExit, match='baseline_issuer_evidence_not_supported'):
        build(src / 'evidence.json', tmp_path / 'out-evidence', baseline_id='b4')
    spec['days_sha256'] = '0' * 64
    (src / 'spec.json').write_text(json.dumps(spec))
    with pytest.raises(SystemExit, match='baseline_days_sha256_mismatch'):
        build(src / 'spec.json', tmp_path / 'out2', baseline_id='b2')


def test_the_job_mode_closes_its_own_scheduler_task(monkeypatch):
    import dataset_snapshot_job_main as job
    import services.corporate_history_weekly as module
    calls, seen = [], {}

    async def callback(payload):
        calls.append(payload)
    monkeypatch.setattr(job, '_callback_worker', callback)
    monkeypatch.setenv('DATASET_SNAPSHOT_MODE', 'corporate_history_weekly')
    monkeypatch.setenv('DATASET_SNAPSHOT_RUN_DATE', '2026-11-28')
    monkeypatch.setenv('GCS_BUCKET_NAME', 'secret-bucket')
    monkeypatch.delenv('CLOUD_RUN_TASK_ATTEMPT', raising=False)
    run_id = 'corporate-history-weekly-2026-11-28-abcdef12'

    # A run id for another date is a named stop: error callback, exit 0 so Cloud Run does not retry it.
    monkeypatch.setenv('DATASET_SNAPSHOT_PRODUCER_RUN_ID', 'corporate-history-weekly-2026-11-27-abcdef12')
    assert asyncio.run(job._run()) == 0
    assert calls[-1]['task'] == 'corporate-history-weekly' and calls[-1]['status'] == 'error'
    assert 'run_identity_invalid' in calls[-1]['error']
    monkeypatch.setenv('DATASET_SNAPSHOT_PRODUCER_RUN_ID', run_id)

    def gate_stop(run_date, *, run_id, workdir):
        raise module.CorporateHistoryWeeklyError('corporate_history_exclusion_share_above_limit:365d=900/2000')
    monkeypatch.setattr(module, 'run_corporate_history_weekly', gate_stop)
    assert asyncio.run(job._run()) == 0 and calls[-1]['status'] == 'error'

    # The fetch script's SystemExit (FinLab auth) and compile ValueErrors close the run and are not retried.
    def token_expired(run_date, *, run_id, workdir):
        raise SystemExit('finlab_token_expired: rerun with a fresh FINLAB_REFRESH_TOKEN / FINLAB_SESSION_ID')
    monkeypatch.setattr(module, 'run_corporate_history_weekly', token_expired)
    assert asyncio.run(job._run()) == 0
    assert calls[-1]['status'] == 'error' and 'finlab_token_expired' in calls[-1]['error']

    def corrupt(run_date, *, run_id, workdir):
        raise ValueError('corporate_history_source_ref_invalid')
    monkeypatch.setattr(module, 'run_corporate_history_weekly', corrupt)
    assert asyncio.run(job._run()) == 0 and calls[-1]['status'] == 'error'

    # Transport-class failures exit 1 (retried), and the bucket name never leaks into the run log.

    def gcs_down(run_date, *, run_id, workdir):
        raise RuntimeError('403 gs://secret-bucket/research/x denied')
    monkeypatch.setattr(module, 'run_corporate_history_weekly', gcs_down)
    assert asyncio.run(job._run()) == 1
    assert 'secret-bucket' not in calls[-1]['error'] + calls[-1]['summary']
    assert '$GCS_BUCKET_NAME' in calls[-1]['error']

    def fake_run(run_date, *, run_id, workdir):
        seen.update(run_date=run_date, run_id=run_id)
        return {'run_id': run_id, 'snapshot_id': 's', 'history_start': '2024-12-31', 'history_end': '2026-11-27',
                'sessions': 9, 'blocked_issuers': 1,
                'exclusion': [{'window_days': 90, 'excluded_count': 1, 'holdable_symbols': 10, 'excluded_share': 0.1}]}
    monkeypatch.setattr(module, 'run_corporate_history_weekly', fake_run)
    assert asyncio.run(job._run()) == 0
    assert seen == {'run_date': '2026-11-28', 'run_id': run_id}
    assert calls[-1]['status'] == 'success' and calls[-1]['run_date'] == '2026-11-28' and calls[-1]['run_id'] == run_id
    assert 'snapshot=s' in calls[-1]['summary']

    # A Cloud Run retry exports under its own producer id; the callback keeps the dispatched run id.
    monkeypatch.setenv('CLOUD_RUN_TASK_ATTEMPT', '1')
    assert asyncio.run(job._run()) == 0
    assert seen['run_id'] == run_id + '-a1' and calls[-1]['run_id'] == run_id

    # A lost callback after a finished export does not fail the task (no re-export).
    async def callback_down(payload):
        raise RuntimeError('worker unreachable')
    monkeypatch.setattr(job, '_callback_worker', callback_down)
    monkeypatch.setenv('CLOUD_RUN_TASK_ATTEMPT', '0')
    assert asyncio.run(job._run()) == 0


def test_the_controller_route_dispatches_the_snapshot_job_with_the_weekly_mode(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import routers.dataset_snapshots as route
    import services.cloud_run_jobs_client as jobs

    runs = []

    class Execution:
        execution_id = 'dataset-snapshot-export-abc'

    class Client:
        def __init__(self, job_name, require_source_alignment=False):
            runs.append({'job': job_name, 'aligned': require_source_alignment})

        def run_job(self, env_overrides=None, reject_if_running=True):
            runs[-1].update(env=env_overrides, reject=reject_if_running)
            if env_overrides['DATASET_SNAPSHOT_RUN_DATE'] == '2026-12-05':
                raise jobs.JobAlreadyRunningError(Execution())
            return Execution()
    monkeypatch.setattr(jobs, 'CloudRunJobsClient', Client)
    monkeypatch.setenv('DATASET_SNAPSHOT_JOB_NAME', 'dataset-snapshot-export')
    app = FastAPI()
    app.include_router(route.router)
    client = TestClient(app)
    path = '/datasets/corporate-history/weekly'
    ok = client.post(path, json={'run_date': '2026-11-28', 'run_id': 'corporate-history-weekly-2026-11-28-abcdef12'})
    assert ok.status_code == 200 and ok.json()['status'] == 'dispatched'
    assert runs[-1] == {'job': 'dataset-snapshot-export', 'aligned': True, 'reject': True, 'env': {
        'DATASET_SNAPSHOT_MODE': 'corporate_history_weekly', 'DATASET_SNAPSHOT_RUN_DATE': '2026-11-28',
        'DATASET_SNAPSHOT_PRODUCER_RUN_ID': 'corporate-history-weekly-2026-11-28-abcdef12'}}
    mismatch = client.post(path, json={'run_date': '2026-11-28', 'run_id': 'corporate-history-weekly-2026-11-27-abcdef12'})
    assert mismatch.status_code == 422
    busy = client.post(path, json={'run_date': '2026-12-05', 'run_id': 'corporate-history-weekly-2026-12-05-abcdef12'})
    assert busy.status_code == 409
    assert busy.json()['detail']['error'] == 'corporate_history_weekly_execution_already_running'
    dry = client.post(path, json={'run_date': '2026-11-28', 'run_id': 'corporate-history-weekly-2026-11-28-abcdef12',
                                  'dry_run': True})
    assert dry.json()['status'] == 'not_triggered' and len(runs) == 2  # 422 and dry_run never build a client
