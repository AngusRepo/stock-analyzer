"""tools/opb_v3_offline_replay.py: read budgets, the avoid-window gate, the cold-store retry,
restoring patched modules, TabPack weights through the ledger, and --simulations."""
import argparse
import gzip
import hashlib
import importlib.util
import io
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def tool(monkeypatch):
    for name in ('GCS_BUCKET_NAME', 'OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS'):
        monkeypatch.setenv(name, 'restore')    # records the prior state; teardown restores it
        monkeypatch.delenv(name)
    monkeypatch.setattr(sys, 'path', list(sys.path))
    spec = importlib.util.spec_from_file_location('opb_v3_offline_replay_tool_under_test',
                                                  ROOT / 'tools' / 'opb_v3_offline_replay.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, 'in_avoid_window', lambda now: False)
    return module


def ledger(path):
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def wrangler_ok(rows_read, results=()):
    def run(cmd, **kwargs):
        assert cmd[1:3] == ['d1', 'execute'] and '--remote' in cmd and kwargs['timeout'] == 600
        return subprocess.CompletedProcess(cmd, 0, json.dumps([{'results': list(results),
                                                                'meta': {'rows_read': rows_read}}]), '')
    return run


# Both ends inclusive to the minute: the first and last minute of each window are inside.
@pytest.mark.parametrize('clock,inside', [('06:14', False), ('06:15', True), ('07:40', True), ('07:41', False),
                                          ('12:59', False), ('13:00', True), ('16:30', True), ('16:31', False),
                                          ('16:59', False), ('17:00', True), ('23:00', True), ('23:01', False)])
def test_avoid_windows_are_the_learning_write_windows(tool, clock, inside):
    # The fixture stubs the gate out; this checks the real function.
    spec = importlib.util.spec_from_file_location('opb_v3_gate', ROOT / 'tools' / 'opb_v3_offline_replay.py')
    fresh = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fresh)
    # TW 14:15-15:40 post-close, TW 21:00-00:30 evening, TW 01:00-07:00 night caution: exactly these.
    assert fresh.AVOID_WINDOWS_UTC == (('06:15', '07:40'), ('13:00', '16:30'), ('17:00', '23:00'))
    hour, minute = map(int, clock.split(':'))
    for day in (27, 28):     # a weekday (Fri 2026-11-27) and a weekend day
        assert fresh.in_avoid_window(datetime(2026, 11, day, hour, minute, tzinfo=timezone.utc)) is inside


@pytest.mark.parametrize('domain', ['paper', 'learning', 'market'])
def test_every_d1_domain_refuses_reads_inside_the_avoid_window(tool, monkeypatch, tmp_path, domain):
    monkeypatch.setattr(tool, 'in_avoid_window', lambda now: True)
    monkeypatch.setattr(tool.subprocess, 'run', lambda *a, **k: pytest.fail('read inside the avoid window'))
    with pytest.raises(RuntimeError, match=domain + '_db_avoid_window'):
        tool.WranglerQuery(domain, tmp_path / 'reads.jsonl').query('SELECT 1')
    assert ledger(tmp_path / 'reads.jsonl') == []


def test_d1_reads_are_ledgered_and_stop_at_the_row_budget_across_runs(tool, monkeypatch, tmp_path):
    book = tmp_path / 'reads.jsonl'
    monkeypatch.setattr(tool.subprocess, 'run', wrangler_ok(600, [{'x': 1}]))
    first = tool.WranglerQuery('paper', book, row_budget=1000)
    assert first.query('SELECT ?', [1]) == [{'x': 1}]
    assert [(e['domain'], e['rows_read'], e['rows']) for e in ledger(book)] == [('paper', 600, 1)]
    first.query('SELECT 2')                       # 600 < 1000: allowed, the ledger now holds 1200
    resumed = tool.WranglerQuery('market', book, row_budget=1000)   # a later run reads the same ledger
    monkeypatch.setattr(tool.subprocess, 'run', lambda *a, **k: pytest.fail('read past the budget'))
    with pytest.raises(RuntimeError, match='d1_rows_read_budget_spent'):
        resumed.query('SELECT 3')
    assert sum(e['rows_read'] for e in ledger(book)) == 1200


@pytest.mark.parametrize('sql', [
    'DELETE FROM t', 'INSERT INTO t VALUES (1)', 'UPDATE t SET x=1', 'PRAGMA foo',
    'WITH x AS (SELECT 1) DELETE FROM t', 'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x',
    'with x as (select 1) update t set y=1', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d',
    'SELECT 1; DELETE FROM t', 'SELECT 1;SELECT 2', "SELECT 'x'; DROP TABLE t", 'SELECT 1 /* open'])
def test_d1_client_stays_read_only(tool, monkeypatch, tmp_path, sql):
    monkeypatch.setattr(tool.subprocess, 'run', lambda *a, **k: pytest.fail('write reached wrangler'))
    with pytest.raises(ValueError, match='read-only client'):
        tool.WranglerQuery('learning', tmp_path / 'r.jsonl').query(sql)
    assert ledger(tmp_path / 'r.jsonl') == []


@pytest.mark.parametrize('sql,params', [
    ("SELECT json_extract(payload_json,'$.weights') w FROM t WHERE a=? AND b='DELETE;'", ['x;DROP TABLE t']),
    ('WITH x AS (SELECT 1 AS replaced_at) SELECT replaced_at FROM x', []),
    ('EXPLAIN QUERY PLAN SELECT * FROM t WHERE c=?', ['UPDATE']),
    ('SELECT 1;', [])])
def test_d1_client_passes_one_read_with_write_words_only_inside_literals(tool, monkeypatch, tmp_path, sql, params):
    monkeypatch.setattr(tool.subprocess, 'run', wrangler_ok(1))
    assert tool.WranglerQuery('learning', tmp_path / 'r.jsonl').query(sql, params) == []


def cold_run(outcomes, calls):
    """gcloud storage cat stub: each call takes the next outcome ('ok', 'timeout', 'error')."""
    def run(cmd, stdout=None, timeout=None, **kwargs):
        assert cmd[:3] == ['gcloud', 'storage', 'cat'] and cmd[3].startswith('gs://')
        calls.append(timeout)
        outcome = outcomes.pop(0)
        if outcome == 'timeout':
            stdout.write(b'partial')
            raise subprocess.TimeoutExpired(cmd, timeout)
        if outcome == 'error':
            raise subprocess.CalledProcessError(1, cmd)
        stdout.write(b'x' * 10)
        return subprocess.CompletedProcess(cmd, 0)
    return run


def test_cold_download_retries_once_after_a_timeout(tool, monkeypatch, tmp_path):
    calls, book = [], tmp_path / 'cold.jsonl'
    monkeypatch.setattr(tool.subprocess, 'run', cold_run(['timeout', 'ok'], calls))
    tool.GcloudCold(book).download('k', tmp_path / 'obj')
    assert calls == [600, 600] and (tmp_path / 'obj').read_bytes() == b'x' * 10
    assert [(e['attempt'], e['status'], e['bytes']) for e in ledger(book)] == [
        (1, 'TimeoutExpired', 7), (2, 'ok', 10)]


@pytest.mark.parametrize('outcomes', [['timeout', 'timeout'], ['error', 'timeout'], ['error', 'error']])
def test_cold_download_stops_after_the_second_failure(tool, monkeypatch, tmp_path, outcomes):
    calls = []
    monkeypatch.setattr(tool.subprocess, 'run', cold_run(list(outcomes) + ['ok'], calls))
    with pytest.raises(RuntimeError, match='cold_download_failed_twice'):
        tool.GcloudCold(tmp_path / 'cold.jsonl').download('k', tmp_path / 'obj')
    assert len(calls) == 2


def test_cold_download_retry_checks_the_byte_budget_first(tool, monkeypatch, tmp_path):
    # The failed first attempt's 7 partial bytes reach the budget: no second download.
    calls, book = [], tmp_path / 'cold.jsonl'
    monkeypatch.setattr(tool.subprocess, 'run', cold_run(['timeout', 'ok'], calls))
    with pytest.raises(RuntimeError, match='cold_download_budget_spent'):
        tool.GcloudCold(book, byte_budget=7).download('k', tmp_path / 'obj')
    assert len(calls) == 1 and [(e['attempt'], e['bytes']) for e in ledger(book)] == [(1, 7)]


def test_cold_downloads_stop_at_the_byte_budget(tool, monkeypatch, tmp_path):
    calls, book = [], tmp_path / 'cold.jsonl'
    monkeypatch.setattr(tool.subprocess, 'run', cold_run(['ok', 'ok', 'ok'], calls))
    store = tool.GcloudCold(book, byte_budget=15)
    store.download('a', tmp_path / 'a')
    store.download('b', tmp_path / 'b')       # 10 < 15 before this one
    with pytest.raises(RuntimeError, match='cold_download_budget_spent'):
        tool.GcloudCold(book, byte_budget=15).download('c', tmp_path / 'c')
    assert len(calls) == 2


class FakeQuery:
    def __init__(self, fail=False):
        self.fail = fail

    def query(self, sql, params=()):
        if self.fail:
            raise RuntimeError('first_read_failed')
        return []


@pytest.mark.parametrize('failure', ['cold_table_missing', 'available_raises', 'date_query_raises'])
def test_fetch_restores_every_patch_on_any_exit(tool, monkeypatch, tmp_path, failure):
    from services import paired_nav_cold
    store, available = paired_nav_cold.production_store, paired_nav_cold.available
    if failure == 'cold_table_missing':
        monkeypatch.setattr(paired_nav_cold, 'available', lambda query: False)
    elif failure == 'available_raises':
        monkeypatch.setattr(paired_nav_cold, 'available', lambda query: query('SELECT 1'))
    else:
        monkeypatch.setattr(paired_nav_cold, 'available', lambda query: True)
    available = paired_nav_cold.available
    monkeypatch.setattr(tool, 'WranglerQuery', lambda domain, *a: FakeQuery(
        fail=(failure == 'available_raises' and domain == 'learning')
        or (failure == 'date_query_raises' and domain == 'paper')))
    args = argparse.Namespace(cache=str(tmp_path / 'cache'), row_budget=None, byte_budget=None,
                              start='2026-10-14', end='2026-11-26', refresh=False, market_proxy=None)
    with pytest.raises(RuntimeError):
        tool.fetch(args)
    assert paired_nav_cold.production_store is store and paired_nav_cold.available is available


def test_fetch_ledgers_every_domain_in_the_cache_ledger_with_the_row_budget(tool, monkeypatch, tmp_path):
    # One ledger file per cache, shared by every domain and every run: the budget spans runs.
    seen = []

    def client(domain, book=None, budget=None):
        seen.append((domain, book, budget))
        return FakeQuery(fail=True)
    monkeypatch.setattr(tool, 'WranglerQuery', client)
    args = argparse.Namespace(cache=str(tmp_path / 'cache'), row_budget=1234, byte_budget=None,
                              start='2026-10-14', end='2026-11-26', refresh=False, market_proxy=None)
    with pytest.raises(RuntimeError):
        tool.fetch(args)
    book = tmp_path / 'cache' / 'd1_reads.jsonl'
    assert seen == [('paper', book, 1234), ('learning', book, 1234), ('market', book, 1234)]


def test_prices_command_takes_the_row_budget(tool, monkeypatch, tmp_path):
    seen = []
    monkeypatch.setattr(tool, 'WranglerQuery', lambda domain, book=None, budget=None: seen.append((domain, book, budget)))
    monkeypatch.setattr(tool, 'prices', lambda args, market, cache: None)
    tool.main(['prices', '--start', '2026-10-14', '--end', '2026-11-26', '--cache', str(tmp_path), '--row-budget', '77'])
    assert seen == [('market', tmp_path / 'd1_reads.jsonl', 77)]


def weights_blob(seed=0):
    buffer = io.BytesIO()
    np.savez(buffer, w=np.arange(6, dtype=np.float32).reshape(2, 3) + seed)
    raw = buffer.getvalue()
    sha = hashlib.sha256(raw).hexdigest()
    return raw, {'path': 'l4_distribution/tabpack_weights/' + sha + '.npz', 'sha256': sha, 'bytes': len(raw)}


def record_naming(ref, day='2026-11-02'):
    return {'signal_date': day, 'frozen_before_entry': True,
            'inputs': {'l4Distribution': {'artifact': {'model': {'residual_tabpack': {'members': [
                {'model': {'weights': dict(ref)}}, {'model': {'weights': dict(ref)}}]}}},
                'runtime': {'l3_identity': {'k': 1}, 'account': {'fees': {}}}}}}


def blob_store(raw, calls, tmp_path):
    def run(cmd, stdout=None, timeout=None, **kwargs):
        calls.append(cmd[3])
        stdout.write(raw)
        return subprocess.CompletedProcess(cmd, 0)
    return run


def test_tabpack_weights_are_prefetched_through_the_byte_ledger_once(tool, monkeypatch, tmp_path):
    raw, ref = weights_blob()
    refs = tool.tabpack_weight_refs([record_naming(ref), record_naming(ref, '2026-11-03')])
    assert refs == [ref]
    calls, book = [], tmp_path / 'cold.jsonl'
    monkeypatch.setattr(tool.subprocess, 'run', blob_store(raw, calls, tmp_path))
    tool.prefetch_tabpack_weights(refs, tmp_path / 'tabpack', tool.GcloudCold(book))
    tool.prefetch_tabpack_weights(refs, tmp_path / 'tabpack', tool.GcloudCold(book))   # cached: no download
    assert len(calls) == 1 and calls[0].endswith('/' + ref['path'])
    assert [(e['status'], e['bytes']) for e in ledger(book)] == [('ok', len(raw))]
    assert (tmp_path / 'tabpack' / (ref['sha256'] + '.npz')).read_bytes() == raw


@pytest.mark.parametrize('payload', ['corrupt', 'budget'])
def test_tabpack_prefetch_refuses_a_mismatched_copy_or_a_spent_budget(tool, monkeypatch, tmp_path, payload):
    raw, ref = weights_blob()
    calls, book = [], tmp_path / 'cold.jsonl'
    if payload == 'budget':
        book.write_text(json.dumps({'bytes': 10 ** 9}) + '\n')
    monkeypatch.setattr(tool.subprocess, 'run', blob_store(raw[:-1] + bytes([raw[-1] ^ 1]), calls, tmp_path))
    with pytest.raises((ValueError, RuntimeError),
                       match='checksum_mismatch' if payload == 'corrupt' else 'cold_download_budget_spent'):
        tool.prefetch_tabpack_weights([ref], tmp_path / 'tabpack', tool.GcloudCold(book, byte_budget=10 ** 9))
    assert not (tmp_path / 'tabpack' / (ref['sha256'] + '.npz')).exists()


def test_tabpack_weight_refs_cover_every_record(tool):
    (_, first), (_, second) = weights_blob(0), weights_blob(1)
    refs = tool.tabpack_weight_refs([record_naming(first), record_naming(second, '2026-11-03')])
    assert refs == sorted([first, second], key=lambda r: r['sha256'])


def test_tabpack_prefetch_reverifies_an_existing_cached_copy(tool, monkeypatch, tmp_path):
    raw, ref = weights_blob()
    (tmp_path / 'tabpack').mkdir()
    (tmp_path / 'tabpack' / (ref['sha256'] + '.npz')).write_bytes(raw[:-1] + bytes([raw[-1] ^ 1]))
    monkeypatch.setattr(tool.subprocess, 'run', lambda *a, **k: pytest.fail('cached copy re-downloaded'))
    with pytest.raises(ValueError, match='checksum_mismatch'):
        tool.prefetch_tabpack_weights([ref], tmp_path / 'tabpack', tool.GcloudCold(tmp_path / 'cold.jsonl'))


def test_worker_loader_reads_the_local_copy_and_never_the_cold_store(tool, monkeypatch, tmp_path):
    from services import l4_tabpack_weights as official
    raw, ref = weights_blob()
    (tmp_path / (ref['sha256'] + '.npz')).write_bytes(raw)
    monkeypatch.setattr(official, '_load', official._load)       # restored after the test
    monkeypatch.setitem(sys.modules, 'google.cloud.storage', None)  # any cold-store import fails
    monkeypatch.setenv('GCS_BUCKET_NAME', 'bucket-under-test')
    tool._use_local_weights(str(tmp_path))
    arrays = official.load(ref)
    assert arrays['w'].dtype == np.float32 and arrays['w'].shape == (2, 3)
    (tmp_path / (ref['sha256'] + '.npz')).write_bytes(raw[:-1] + bytes([raw[-1] ^ 1]))
    official._load.cache_clear()
    with pytest.raises(ValueError, match='checksum_mismatch'):
        official.load(ref)


def test_replay_prefetches_then_starts_workers_on_the_local_copies(tool, monkeypatch, tmp_path):
    import concurrent.futures
    from services import l4_tabpack_weights as official
    raw, ref = weights_blob()
    cache = tmp_path / 'cache'
    cache.mkdir()
    with gzip.open(cache / '2026-11-02.json.gz', 'wt', encoding='utf-8') as sink:
        json.dump(record_naming(ref), sink)
    monkeypatch.setattr(tool, 'load_prices', lambda c, proxy: ([], {}))
    monkeypatch.setattr(tool, 'reference_policies', lambda records: {json.dumps({'k': 1}, sort_keys=True): {}})
    calls = []
    monkeypatch.setattr(tool.subprocess, 'run', blob_store(raw, calls, tmp_path))
    monkeypatch.setattr(official, '_load', official._load)
    monkeypatch.setitem(sys.modules, 'google.cloud.storage', None)
    monkeypatch.setenv('GCS_BUCKET_NAME', 'bucket-under-test')
    seen = {}

    class InProcessPool:
        def __init__(self, max_workers=None, initializer=None, initargs=()):
            seen['init'] = (initializer, initargs)
            initializer(*initargs)

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def map(self, fn, jobs):
            for job in jobs:
                arrays = official.load(job[0]['inputs']['l4Distribution']['artifact']['model']
                                       ['residual_tabpack']['members'][0]['model']['weights'])
                yield {'signal_date': job[0]['signal_date'], 'arm': job[2]['id'], 'status': 'failed',
                       'error': str(arrays['w'].shape)}
    monkeypatch.setattr(concurrent.futures, 'ProcessPoolExecutor', InProcessPool)
    (tmp_path / 'arms.json').write_text(json.dumps([{'id': 'base'}]))
    args = argparse.Namespace(cache=str(cache), arms=str(tmp_path / 'arms.json'), output=str(tmp_path / 'out.json'),
                              workers=1, inert_reference_exposure=None, inert_reference_name=.0625,
                              market_proxy=None, byte_budget=None)
    tool.replay(args)
    assert seen['init'] == (tool._use_local_weights, (str(cache / 'tabpack'),))
    assert len(calls) == 1 and ledger(cache / 'cold_downloads.jsonl')[0]['bytes'] == len(raw)
    assert json.loads((tmp_path / 'out.json').read_text())[0]['error'] == '(2, 3)'


def test_replay_and_fetch_take_their_budgets_from_the_command_line(tool):
    parsed = {}
    for command, extra in (('fetch', ['--start', 'a', '--end', 'b']), ('replay', ['--arms', 'x', '--output', 'y'])):
        original = getattr(tool, command)
        setattr(tool, command, lambda args, command=command: parsed.__setitem__(command, args))
        try:
            tool.main([command, '--cache', 'c', *extra, '--byte-budget', '7'])
        finally:
            setattr(tool, command, original)
    assert parsed['fetch'].byte_budget == parsed['replay'].byte_budget == 7 and parsed['fetch'].row_budget is None


def results_for(arms, calendar):
    """Each day's five sessions are the next five calendar days, so the walk-forward sees matured rows."""
    out = []
    for i, day in enumerate(calendar[:-5]):
        sessions = calendar[i + 1:i + 6]
        for arm, edge in arms.items():
            out.append({'signal_date': day, 'arm': arm, 'status': 'ok', 'inert': False, 'counterfactual_inert': False,
                        'weights': {'A': .4, 'B': .1} if arm == 'base' else {'A': .3, 'B': .2},
                        'current': {}, 'exposure': .5,
                        'pieces': [.001 + edge * (1 + ((i + j) % 3)) for j in range(5)],
                        'market_pieces': [.0005 * (((i + j) % 5) - 2) for j in range(5)], 'sessions': sessions,
                        'net_return': 5 * .001})
    return out


@pytest.mark.parametrize('flag,expected', [([], 20000), (['--simulations', '4000'], 4000)])
def test_evaluate_uses_the_simulations_it_is_given(tool, monkeypatch, tmp_path, flag, expected):
    from services import l4_opb_selection
    used = []
    real = l4_opb_selection.critical_value

    def recording(samples, k, alpha, window, half_life, lag, simulations, *rest, **kw):
        used.append(simulations)
        return real(samples, k, alpha, window, half_life, lag, 200, *rest, **kw)
    monkeypatch.setattr(l4_opb_selection, 'critical_value', recording)
    from datetime import date, timedelta
    calendar = [(date(2026, 9, 1) + timedelta(days=d)).isoformat() for d in range(40)]
    (tmp_path / 'results.json').write_text(json.dumps(results_for({'base': 0., 'tilt': .0002}, calendar)))
    tool.main(['evaluate', '--results', str(tmp_path / 'results.json'), '--output', str(tmp_path / 'e.json'), *flag])
    # The full-sample call and the walk-forward calls (one per decision day with matured rows).
    assert len(used) > 20 and set(used) == {expected}
    assert json.loads((tmp_path / 'e.json').read_text())['parameters']['simulations'] == expected
