"""OOF prep retention deletes only batch shards of old runs that nothing names."""
from __future__ import annotations

import json
import sqlite3
import sys
import types
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ml-controller'))

from scripts import gcs_prep_retention as gpr  # noqa: E402

TODAY = date(2026, 10, 31)
P = gpr.PREFIX


class Blob:
    def __init__(self, name, size=100, hold=False, text='', created=None):
        self.name, self.size, self.generation, self.time_created = name, size, 7, created
        self.temporary_hold, self.event_based_hold, self.text = hold, False, text
        self.deleted_with = None

    def download_as_text(self):
        return self.text

    def delete(self, if_generation_match=None):
        if if_generation_match != self.generation:
            raise RuntimeError('precondition')
        self.deleted_with = if_generation_match


def run(name, *, hold=False, created=None):
    return [Blob(f'{P}{name}/prep/batch_0.npz', 900, hold), Blob(f'{P}{name}/prep/batch_12.npz', 900, created=created),
            Blob(f'{P}{name}/prep/immutable_receipt.json', 5), Blob(f'{P}{name}/prep/feature_names.json', 5),
            Blob(f'{P}{name}/prep/cleaning_report_batch_0.json', 5)]


OLD = '2026-06-01-aaa'
RUNS = {
    'old': OLD,
    'recent': '2026-08-15-bbb',
    'pin': '2026-05-01-ccc',
    'canonical': '2026-05-02-ddd',
    'd1': '2026-05-03-eee',
    'cohort': '2026-05-04-fff',
    'held': '2026-05-05-ggg',
    'undated': 'manual-rebuild',
}


def blobs():
    out = []
    for key, name in RUNS.items():
        out += run(name, hold=key == 'held')
    return out


def refs(**over):
    base = {k: {RUNS[k]} for k in ('pin', 'canonical', 'd1', 'cohort')}
    base.update(over)
    return base


def test_only_unreferenced_old_batches_are_candidates():
    report = gpr.plan(blobs(), refs(), TODAY, 90)
    assert list(report['candidate_runs']) == [OLD]
    assert {b.name.rsplit('/', 1)[1] for b in report['_blobs']} == {'batch_0.npz', 'batch_12.npz'}
    assert report['candidate_objects'] == 2 and report['runs_total'] == len(RUNS)
    assert report['kept_by_reason'] == {'canonical': 1, 'cohort': 1, 'd1': 1, 'hold': 1, 'pin': 1,
                                        'recent': 1, 'undated': 1}


@pytest.mark.parametrize('key', ['pin', 'canonical', 'd1', 'cohort'])
def test_each_reference_source_keeps_its_run(key):
    report = gpr.plan(blobs(), refs(**{key: set()}), TODAY, 90)
    assert set(report['candidate_runs']) == {OLD, RUNS[key]}


def test_recent_window_and_holds():
    assert RUNS['recent'] in gpr.plan(blobs(), refs(), TODAY, 30)['candidate_runs']
    unheld = [b for b in blobs() if RUNS['held'] not in b.name] + run(RUNS['held'])
    assert RUNS['held'] in gpr.plan(unheld, refs(), TODAY, 90)['candidate_runs']
    with pytest.raises(ValueError):
        gpr.plan(blobs(), refs(), TODAY, 7)


def test_referenced_runs_missing_from_bucket_are_reported():
    report = gpr.plan(blobs(), refs(d1={RUNS['d1'], '2026-01-01-gone'}), TODAY, 90)
    assert report['referenced_runs_missing'] == {'d1': ['2026-01-01-gone']}


def test_runs_named_parses_paths_in_json_and_uris():
    text = json.dumps({'source_gcs_prefix': f'{P}2026-10-08-x-expanded1280',
                       'files': [f'gs://stockvision-models/{P}2026-09-01-y/prep/batch_3.npz']})
    assert gpr.runs_named([text, None, '']) == {'2026-10-08-x-expanded1280', '2026-09-01-y'}


def test_repo_pin_file_is_found():
    assert '2026-10-08-19be9b5b8827-955df4d3276b-911673b67497-expanded1280' in gpr.pin_refs()


def test_d1_refs_scan_every_path_column():
    con = sqlite3.connect(':memory:')
    con.row_factory = sqlite3.Row
    for table, columns in gpr.D1_PATH_COLUMNS.items():
        con.execute(f"CREATE TABLE {table} ({', '.join(c + ' TEXT' for c in columns)})")
        for i, column in enumerate(columns):
            con.execute(f'INSERT INTO {table} ({column}) VALUES (?)', [f'x/{P}{table}-{i}/prep/batch_0.npz'])
    con.execute('INSERT INTO active8_oof_cohorts (artifact_manifest_path) VALUES (?)', ['oof_cohorts/c1/manifest.json'])

    def query(sql, params):
        return [dict(r) for r in con.execute(sql, params)]

    runs, manifests = gpr.d1_refs(query)
    assert runs == {f'{t}-{i}' for t, cs in gpr.D1_PATH_COLUMNS.items() for i in range(len(cs))}
    assert sorted(manifests) == sorted([f'x/{P}active8_oof_cohorts-0/prep/batch_0.npz', 'oof_cohorts/c1/manifest.json'])


def test_manifest_read_failure_aborts():
    class Bucket:
        name = 'stockvision-models'

        def blob(self, path):
            if path == 'missing.json':
                raise FileNotFoundError(path)
            return Blob(path, text=f'{{"source_gcs_prefix": "{P}2026-05-02-ddd"}}')

    assert gpr.manifest_refs(Bucket(), ['gs://stockvision-models/a.json']) == {'2026-05-02-ddd'}
    with pytest.raises(FileNotFoundError):
        gpr.manifest_refs(Bucket(), ['a.json', 'missing.json'])


def test_execute_deletes_with_generation_precondition():
    targets = gpr.plan(blobs(), refs(), TODAY, 90)['_blobs']

    def rewritten(if_generation_match=None):  # the server copy changed after planning
        raise RuntimeError('precondition')

    targets[0].delete = rewritten
    result = gpr.execute(targets)
    assert result == {'deleted_objects': 1, 'failed': [{'name': targets[0].name, 'error': 'RuntimeError'}]}
    assert targets[1].deleted_with == 7


def test_backfill_created_recently_under_an_old_date_stays():
    created = datetime(2026, 10, 30, 1, tzinfo=timezone.utc)
    report = gpr.plan(run(OLD, created=created) + run('2026-06-02-old'), {}, TODAY, 90)
    assert list(report['candidate_runs']) == ['2026-06-02-old']
    assert report['kept_by_reason'] == {'recent': 1}


def test_cutoff_day_is_kept():
    report = gpr.plan(run('2026-08-02-edge') + run('2026-08-01-out'), {}, TODAY, 90)
    assert report['cutoff_date'] == '2026-08-02' and list(report['candidate_runs']) == ['2026-08-01-out']


@pytest.mark.parametrize('name', ['20261008-a', '2026-W41-3', '2026-10-0x-a', 'x2026-06-01-a'])
def test_only_strict_dated_names_count_as_dated(name):
    assert gpr.run_date(name) is None
    assert gpr.run_date('2026-06-01-a') == date(2026, 6, 1) and gpr.run_date('2026-06-01') == date(2026, 6, 1)


@pytest.mark.parametrize('tail', [',x', ')', '|', '}', '#', '?a', ';', '`', '"', "'", ' ', '/prep', '\\'])
def test_run_names_stop_at_delimiters(tail):
    assert gpr.runs_named([f'see {P}2026-06-01-abc{tail} end']) == {'2026-06-01-abc'}


def test_canonical_manifests_listing_arguments():
    calls = []

    class Bucket:
        def list_blobs(self, **kw):
            calls.append(kw)
            return [Blob('universal/canonical_adjusted_v6/r/prep/manifest.json')]

    assert gpr.canonical_manifests(Bucket()) == ['universal/canonical_adjusted_v6/r/prep/manifest.json']
    assert calls == [{'prefix': 'universal/canonical_adjusted', 'match_glob': '**/prep/manifest.json'}]


class FakeBucket:
    name = 'stockvision-models'

    def __init__(self, prep):
        self.prep, self.texts = prep, {}

    def list_blobs(self, prefix, match_glob=None):
        if match_glob:
            return [Blob(n) for n in self.texts if n.startswith(prefix) and n.endswith('/prep/manifest.json')]
        return [b for b in self.prep if b.name.startswith(prefix)]

    def blob(self, path):
        return Blob(path, text=self.texts[path])


def fake_services(monkeypatch, bucket, query):
    class Client:
        def __init__(self, domain, require_specific=False):
            assert domain == 'learning' and require_specific is True

        def query(self, sql, params=None):
            return query(sql, params or [])

    monkeypatch.setitem(sys.modules, 'services.d1_domain_client', types.SimpleNamespace(
        D1DataDomain=types.SimpleNamespace(LEARNING='learning'), DomainD1Client=Client))
    monkeypatch.setitem(sys.modules, 'services.walk_forward_retrain', types.SimpleNamespace(_get_bucket=lambda: bucket))
    monkeypatch.setattr(gpr, 'pin_refs', lambda: {RUNS['pin']})


def prod_like(monkeypatch):
    bucket = FakeBucket(blobs())
    bucket.texts['universal/canonical_adjusted_v6/c/prep/manifest.json'] = json.dumps(
        {'source_gcs_prefix': P + RUNS['canonical']})
    bucket.texts['oof_cohorts/c1/manifest.json'] = json.dumps({'x': P + RUNS['cohort']})

    def query(sql, params):
        if 'artifact_manifest_path IS NOT NULL' in sql:
            return [{'v': 'gs://stockvision-models/oof_cohorts/c1/manifest.json'}]
        return [{'v': P + RUNS['d1']}] if 'FROM dataset_snapshots' in sql and 'gcs_uri' in sql else []

    fake_services(monkeypatch, bucket, query)
    monkeypatch.setattr(gpr, 'datetime', types.SimpleNamespace(now=lambda tz: datetime(2026, 10, 31, tzinfo=tz)))
    return bucket


def test_main_dry_run_never_deletes_and_wires_every_reference(monkeypatch, capsys):
    bucket = prod_like(monkeypatch)
    for b in bucket.prep:
        b.delete = lambda **_k: pytest.fail('dry-run deleted')
    assert gpr.main([]) == 0
    report = json.loads(capsys.readouterr().out)
    assert list(report['candidate_runs']) == [OLD] and 'executed' not in report
    assert report['manifests_read'] == {'canonical': 1, 'cohort': 1}


def test_main_execute_reports_failures_with_exit_1(monkeypatch, capsys):
    bucket = prod_like(monkeypatch)
    target = next(b for b in bucket.prep if b.name.endswith(f'{OLD}/prep/batch_0.npz'))
    target.delete = lambda **_k: (_ for _ in ()).throw(RuntimeError('precondition'))
    assert gpr.main(['--execute', '--confirm', gpr.CONFIRM_PHRASE]) == 1
    report = json.loads(capsys.readouterr().out)
    assert report['executed']['deleted_objects'] == 1 and len(report['executed']['failed']) == 1
    assert [b.name for b in bucket.prep if b.deleted_with] == [f'{P}{OLD}/prep/batch_12.npz']


@pytest.mark.parametrize('broken', ['d1', 'canonical_listing', 'cohort_manifest'])
def test_main_aborts_before_any_delete_when_a_source_fails(monkeypatch, broken):
    bucket = prod_like(monkeypatch)
    for b in bucket.prep:
        b.delete = lambda **_k: pytest.fail('deleted after a reference source failed')
    if broken == 'd1':
        fake_services(monkeypatch, bucket, lambda sql, params: (_ for _ in ()).throw(RuntimeError('d1 down')))
    elif broken == 'canonical_listing':
        listing = bucket.list_blobs
        bucket.list_blobs = lambda prefix, match_glob=None: (_ for _ in ()).throw(RuntimeError('list')) \
            if match_glob else listing(prefix)
    else:
        del bucket.texts['oof_cohorts/c1/manifest.json']
    with pytest.raises(Exception):
        gpr.main(['--execute', '--confirm', gpr.CONFIRM_PHRASE])


def test_main_requires_confirm_phrase(monkeypatch):
    # Fake D1 and GCS modules that fail if reached, so this test never touches a real bucket.
    def unreachable(*_a, **_k):
        raise AssertionError('reached D1 or GCS')

    monkeypatch.setitem(sys.modules, 'services.d1_domain_client', types.SimpleNamespace(
        D1DataDomain=types.SimpleNamespace(LEARNING='learning'), DomainD1Client=unreachable))
    monkeypatch.setitem(sys.modules, 'services.walk_forward_retrain', types.SimpleNamespace(_get_bucket=unreachable))
    with pytest.raises(SystemExit) as exc:
        gpr.main(['--execute', '--confirm', 'yes'])
    assert exc.value.code == 2
