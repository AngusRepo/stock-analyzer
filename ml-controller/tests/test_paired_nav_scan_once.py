import gzip
import hashlib
import json
import os
import pickle
import random

import pytest

from services import paired_nav_cold as cold
from services import paired_nav_scan_once as once
from services.paired_nav_journal import (read_context_projection, read_inventory_snapshot,
                                          read_snapshot, _INVENTORY_PREFIXES)
from services.paired_nav_read_cache import reuse_verified_cold_reads, _scope
from test_paired_nav_cold import env, freeze  # noqa: F401  (fixture)


def _content(seed=0):
    rng = random.Random(seed)
    return {
        'atomic_recommendation_inputs': {'definitions': {'d1': {'w': 0.25}}, 'input_hash': 'x'},
        'recommendation_context': {'inputs': {'screener_recs': [{'symbol': '2330', 'score': 0.1 * seed}],
                                              'unused': rng.randbytes(4000).hex()},
                                   'l3_candidate_selection': {'candidates': []}},
        'ev_candidate_selection': {'status': 'ok', 'l4_checksums': []},
        'trading_config': {'fees': {'buy': 0.001425}, 'big': 2 ** 70},
        'native_execution_environment': {'version': 'one'},
        'formal_baseline_identity': {'payload_checksum': 'f' * 64},
        'formal_output': [{'symbol': '2330', 'weight': rng.random()}],
        'unused_history': [rng.random() for _ in range(3000)],
    }


# Production cold contexts (99-419 MB gz) exceed the 64 MiB file entry; fixture
# objects are ~33 KB, so these budgets reproduce file_oversize at test scale.
OVERSIZE_FILES = {'max_bytes': 4096, 'entry_bytes': 2048}


def _tracked(objects, monkeypatch):
    downloads = []
    original = objects.download
    def download(key, path):
        downloads.append(key)
        return original(key, path)
    monkeypatch.setattr(objects, 'download', download)
    return downloads


def _parses(monkeypatch):
    """Count every full-object tokenisation: original reader and union scan."""
    calls = []
    parse_file, scan = cold.parse_file, once.verified_selections
    monkeypatch.setattr(cold, 'parse_file', lambda *a, **k: calls.append('parse') or parse_file(*a, **k))
    monkeypatch.setattr(once, 'verified_selections', lambda *a, **k: calls.append('scan') or scan(*a, **k))
    return calls


def _reads(db, ids):
    """Three census/owner sweeps plus validation projections, as daily NAV does."""
    out = []
    for owner in (None, 'atomic_strategy', 'l15_route'):
        for sid in ids:
            out.append(read_inventory_snapshot(db.query, sid, owner=owner))
    for sid in ids:
        out.append(read_context_projection(db.query, sid, ('trading_config',)))
        out.append(read_context_projection(db.query, sid, ('formal_baseline_identity', 'formal_output',
                                                           'native_execution_environment')))
        out.append(read_context_projection(db.query, sid, ('upstream_allocation_context_snapshot_id',)))
    return out


def _pickles(values):
    return [pickle.dumps(v, protocol=pickle.HIGHEST_PROTOCOL) for v in values]


def test_each_snapshot_downloaded_and_scanned_once_with_identical_values(env, monkeypatch):
    db, objects = env
    ids = [freeze(db, _content(i), run='r%d' % i)['snapshot_id'] for i in range(4)]
    with reuse_verified_cold_reads(max_bytes=4096, entry_bytes=2048):
        baseline = _reads(db, ids)  # Original reader; tiny budget = the production eviction case.
    downloads = _tracked(objects, monkeypatch)
    calls = _parses(monkeypatch)
    with once.scan_each_snapshot_once(max_bytes=4096, entry_bytes=2048) as cache:
        reused = _reads(db, ids)
        for value in reused:  # Caller mutations never reach the cache.
            value['payload']['content'].clear()
        again = _reads(db, ids)
        assert cache.bundle_bytes <= cache.bundle_budget
    assert sorted(downloads) == sorted(set(downloads)) and len(downloads) == len(ids)
    assert calls == ['scan'] * len(ids)
    assert _pickles(again) == _pickles(baseline)
    assert [json.dumps(v) for v in again] == [json.dumps(v) for v in baseline]
    assert _scope.get() is None


def test_original_reader_rescans_each_sweep_under_production_eviction(env, monkeypatch):
    # Documents the defect this scope removes: same projection, re-tokenised.
    db, objects = env
    ids = [freeze(db, _content(i), run='r%d' % i)['snapshot_id'] for i in range(3)]
    calls = _parses(monkeypatch)
    with reuse_verified_cold_reads(max_bytes=4096, entry_bytes=2048):
        _reads(db, ids)
    assert calls.count('parse') > len(ids)


def test_checksum_failure_is_never_cached_and_original_error_survives(env, monkeypatch):
    db, objects = env
    sid = freeze(db, _content(1))['snapshot_id']
    key = next(iter(objects.data))
    good = objects.data[key]
    raw = gzip.decompress(good).replace(b'"one"', b'"two"')
    objects.data[key] = gzip.compress(raw)  # Same length, valid JSON, wrong checksum.
    calls = _parses(monkeypatch)
    with once.scan_each_snapshot_once() as cache:
        for _ in range(2):
            with pytest.raises(RuntimeError, match='paired_nav_cold_checksum_mismatch'):
                read_inventory_snapshot(db.query, sid)
        assert cache.bundles == {} and cache.scans == 0
        assert calls == ['scan', 'parse', 'scan', 'parse']  # Every attempt re-verifies.
        objects.data[key] = good
        saved = read_context_projection(db.query, sid, ('native_execution_environment',))
        assert saved['payload']['content'] == {'native_execution_environment': {'version': 'one'}}
        assert cache.scans == 1


def test_changed_locator_or_manifest_is_a_new_source(env, monkeypatch):
    db, objects = env
    sid = freeze(db, _content(2))['snapshot_id']
    downloads = _tracked(objects, monkeypatch)
    with once.scan_each_snapshot_once():
        read_inventory_snapshot(db.query, sid)
        def moved(sql, params):
            rows = db.query(sql, params)
            if sql.startswith('SELECT * FROM paired_nav_cold_objects_v1'):
                return [{**r, 'object_key': 'missing'} for r in rows]
            return rows
        with pytest.raises(KeyError):
            read_inventory_snapshot(moved, sid)
        saved = read_inventory_snapshot(db.query, sid)
        assert saved['payload']['content']['ev_candidate_selection'] == _content(2)['ev_candidate_selection']
    # The moved locator is its own source: the failed scan is not cached and the
    # original reader retries and raises; the unchanged locator stays verified.
    assert downloads == [next(iter(objects.data)), 'missing', 'missing']


def test_new_prefix_set_extends_union_once_and_full_reads_are_untouched(env, monkeypatch):
    db, objects = env
    sid = freeze(db, _content(3))['snapshot_id']
    calls = _parses(monkeypatch)
    with once.scan_each_snapshot_once(**OVERSIZE_FILES):
        read_inventory_snapshot(db.query, sid)
        late = read_context_projection(db.query, sid, ('unused_history',))
        read_context_projection(db.query, sid, ('unused_history', 'trading_config'))
        assert late['payload']['content']['unused_history'] == _content(3)['unused_history']
        full = read_snapshot(db.query, sid)
    assert calls[:2] == ['scan', 'scan']
    assert calls.count('scan') == 2
    assert full['payload']['content'] == json.loads(json.dumps(_content(3)))


def test_enclosing_prefix_falls_back_to_exact_reader(env, monkeypatch):
    db, objects = env
    sid = freeze(db, _content(4))['snapshot_id']
    with reuse_verified_cold_reads():
        expected = read_context_projection(db.query, sid, ('recommendation_context.inputs.screener_recs',))
    with once.scan_each_snapshot_once():
        # 'content.recommendation_context' encloses an inventory prefix.
        whole = read_context_projection(db.query, sid, ('recommendation_context',))
        calls = _parses(monkeypatch)
        got = read_context_projection(db.query, sid, ('recommendation_context.inputs.screener_recs',))
    assert whole['payload']['content']['recommendation_context']['inputs']['unused']
    assert calls == ['parse']
    assert pickle.dumps(got) == pickle.dumps(expected)


def test_union_replay_equals_single_prefix_parse(tmp_path):
    from services.streaming_json_reader import load
    compared, guarded, fallback = 0, 0, 0
    for seed in range(60):
        rng = random.Random(seed)
        def value(depth):
            kind = rng.randrange(6 if depth < 3 else 4)
            if kind == 0: return rng.random() * 10 ** rng.randrange(-5, 300)
            if kind == 1: return rng.choice([2 ** 70, -3, 0, True, None, 'α'])
            if kind == 2: return rng.choice(['a', 'b.c', 'item'])
            if kind == 3: return '__OVF__' if rng.random() < 0.3 else 1.5
            if kind == 4: return [value(depth + 1) for _ in range(rng.randrange(3))]
            return {rng.choice(['a', 'b', 'c', 'item', 'd.e']): value(depth + 1) for _ in range(rng.randrange(4))}
        doc = {'content': {k: value(0) for k in 'abcd'}, 'signal_date': '2026-10-28'}
        raw = json.dumps(doc, ensure_ascii=False).encode().replace(b'"__OVF__"', b'1e400')
        fallback += b'1e400' in raw
        if rng.random() < 0.3:
            raw = b'\xef\xbb\xbf' + raw
        path = tmp_path / ('p%d.gz' % seed)
        path.write_bytes(gzip.compress(raw))
        paths = ['signal_date', 'content', 'content.a', 'content.a.item', 'content.b.a', 'content.c.item.b',
                 'content.d.e', 'content.d', 'content.b.item', 'content.c']
        union = frozenset(rng.sample(paths, rng.randrange(2, len(paths))))
        found = once.verified_selections(path, union, checksum=hashlib.sha256(raw).hexdigest(),
                                         byte_count=len(raw))
        for _ in range(8):
            requested = frozenset(rng.sample(sorted(union), rng.randrange(1, len(union) + 1)))
            with gzip.open(path, 'rb') as source:
                expected = pickle.dumps(load(source, prefixes=requested))
            if once.derivable(requested, union):
                assert pickle.dumps(once.project(found, requested)) == expected
                compared += 1
            elif pickle.dumps(once.project(found, requested)) != expected:
                guarded += 1  # The enclosing-prefix guard is load-bearing.
    assert compared > 100 and guarded > 5 and fallback > 5


def test_budgets_are_bounded_and_scope_cleans_up(env):
    db, objects = env
    ids = [freeze(db, _content(i), run='b%d' % i)['snapshot_id'] for i in range(5)]
    with once.scan_each_snapshot_once(bundle_budget=6000, bundle_entry=3000) as cache:
        directory = cache.directory
        for sid in ids:
            read_inventory_snapshot(db.query, sid)
            files = sum(os.path.getsize(os.path.join(directory, n)) for n in os.listdir(directory)
                        if n.startswith('scan-'))
            assert files == cache.bundle_bytes <= 6000
        with once.scan_each_snapshot_once() as nested:
            assert nested is None and _scope.get() is cache
    assert not os.path.exists(directory)
    with pytest.raises(ValueError):
        with once.scan_each_snapshot_once(bundle_budget=1, bundle_entry=2):
            pass


def test_static_union_covers_daily_inventory_without_enclosing_prefixes():
    assert _INVENTORY_PREFIXES <= once.STATIC_PREFIXES
    assert once.derivable(frozenset(_INVENTORY_PREFIXES - {'content.atomic_recommendation_inputs'}),
                          once.STATIC_PREFIXES)
    for prefix in once.STATIC_PREFIXES:
        assert not any(other.startswith(prefix + '.') for other in once.STATIC_PREFIXES)


def test_bulk_request_widens_only_its_own_snapshot(env, monkeypatch):
    db, objects = env
    a, b = (freeze(db, _content(i), run='w%d' % i)['snapshot_id'] for i in (5, 6))
    with once.scan_each_snapshot_once() as cache:
        read_context_projection(db.query, a, ('unused_history',))
        read_inventory_snapshot(db.query, b)
        scanned = [bundle[2] for bundle in cache.bundles.values()]
    widened = [s for s in scanned if 'content.unused_history' in s]
    assert len(scanned) == 2 and len(widened) == 1
    assert all(s - {'content.unused_history'} == once.STATIC_PREFIXES for s in scanned)


def test_bundle_eviction_is_lru_bounded_and_leaks_no_files(env, monkeypatch):
    db, objects = env
    ids = [freeze(db, _content(i), run='e%d' % i)['snapshot_id'] for i in range(6)]
    with once.scan_each_snapshot_once(bundle_budget=1500, bundle_entry=1000, **OVERSIZE_FILES) as cache:
        for sid in ids + ids[-1:]:
            read_inventory_snapshot(db.query, sid)
            names = [n for n in os.listdir(cache.directory) if n.startswith('scan-')]
            assert len(names) == len(cache.bundles)
            assert sum(os.path.getsize(os.path.join(cache.directory, n)) for n in names) == cache.bundle_bytes
            assert cache.bundle_bytes <= 1500
        assert 1 < len(cache.bundles) < len(ids)  # Eviction ran and kept the most recent.
        assert cache.scans == len(ids)
        calls = _parses(monkeypatch)
        read_inventory_snapshot(db.query, ids[-1])
        assert calls == []
        read_inventory_snapshot(db.query, ids[0])  # Evicted: re-verified, never assumed.
        assert calls == ['scan']


def test_oversize_union_is_served_once_and_keeps_existing_bundle(env, monkeypatch):
    db, objects = env
    sid = freeze(db, _content(7))['snapshot_id']
    with once.scan_each_snapshot_once(bundle_entry=3000, **OVERSIZE_FILES) as cache:
        read_inventory_snapshot(db.query, sid)
        kept = dict(cache.bundles)
        bulk = read_context_projection(db.query, sid, ('unused_history',))
        assert bulk['payload']['content']['unused_history'] == _content(7)['unused_history']
        assert cache.bundles == kept and cache.scans == 2
        calls = _parses(monkeypatch)
        read_inventory_snapshot(db.query, sid, owner='l15_route')
        assert calls == []


def test_nested_values_never_alias_the_bundle(env):
    db, objects = env
    sid = freeze(db, _content(8))['snapshot_id']
    with once.scan_each_snapshot_once():
        for _ in range(3):
            saved = read_inventory_snapshot(db.query, sid)
            recs = saved['payload']['content']['recommendation_context']['inputs']['screener_recs']
            assert recs == [{'symbol': '2330', 'score': 0.8}]
            recs[0]['symbol'] = 'mutated'
            recs.append('extra')


def test_scan_links_small_verified_file_like_the_original_reader(env, monkeypatch):
    db, objects = env
    sid = freeze(db, _content(9))['snapshot_id']
    downloads = _tracked(objects, monkeypatch)
    with once.scan_each_snapshot_once(max_bytes=1 << 20, entry_bytes=1 << 19):
        read_inventory_snapshot(db.query, sid)
        calls = _parses(monkeypatch)
        read_inventory_snapshot(db.query, sid, owner='l15_route')
        assert calls == []  # Bundle first, even though the file is retained.
        assert read_snapshot(db.query, sid)['payload']['content'] == json.loads(json.dumps(_content(9)))
    assert len(downloads) == 1


def test_retention_failure_never_fails_a_verified_read(env, monkeypatch):
    db, objects = env
    sid = freeze(db, _content(10))['snapshot_id']
    with reuse_verified_cold_reads():
        expected = pickle.dumps(read_inventory_snapshot(db.query, sid))
    def broken(*args, **kwargs):
        raise OSError('tmpfs full')
    monkeypatch.setattr(once.SnapshotScanCache, '_write', staticmethod(broken))
    with once.scan_each_snapshot_once() as cache:
        assert pickle.dumps(read_inventory_snapshot(db.query, sid)) == expected
        assert cache.bundles == {} and not [n for n in os.listdir(cache.directory) if n.startswith('scan-')]


def test_widened_rescan_replaces_bundle_without_leaking_files(env):
    db, objects = env
    sid = freeze(db, _content(11))['snapshot_id']
    with once.scan_each_snapshot_once(**OVERSIZE_FILES) as cache:
        read_inventory_snapshot(db.query, sid)
        read_context_projection(db.query, sid, ('ev_candidate_selection', 'unused_history'))
        names = [n for n in os.listdir(cache.directory) if n.startswith('scan-')]
        assert cache.scans == 2 and len(names) == len(cache.bundles) == 1
        assert cache.bundle_bytes == sum(size for _, size, _ in cache.bundles.values())
        assert cache.bundle_bytes == os.path.getsize(os.path.join(cache.directory, names[0]))


def test_retained_small_file_is_reparsed_without_download(env, monkeypatch):
    db, objects = env
    sid = freeze(db, _content(12))['snapshot_id']
    with once.scan_each_snapshot_once(max_bytes=1 << 20, entry_bytes=1 << 19) as cache:
        read_inventory_snapshot(db.query, sid)
        downloads = _tracked(objects, monkeypatch)
        read_context_projection(db.query, sid, ('recommendation_context',))  # Enclosing: not derivable.
        assert downloads == [] and cache.scans == 1


def test_root_prefix_encloses_everything():
    assert not once.derivable(frozenset({'a'}), frozenset({'', 'a'}))
    assert once.derivable(frozenset({'', 'a'}), frozenset({'', 'a'}))


def test_daily_nav_job_uses_scan_once_scope(monkeypatch):
    import oof_materialize_job_main as job
    seen = []
    def scoped(**kwargs):
        seen.append(type(_scope.get()).__name__)
        return {'status': 'ok', 'as_of_date': '2026-10-28'}
    monkeypatch.setattr(job, '_execute_daily_nav_scoped', scoped)
    job._execute_daily_nav(end_date='2026-10-28')
    assert seen == ['SnapshotScanCache']
