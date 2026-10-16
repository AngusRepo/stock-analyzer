from copy import deepcopy
import gzip
import hashlib
import json
import pytest

from services import pipeline_slate_artifacts as artifacts
from services.paired_nav_journal import digest


@pytest.fixture
def scope():
    return {'date': '2026-10-16', 'run': 'pipeline-test', 'source': digest('frozen'), 'code': 'a'*40}


def test_roundtrip_checksum_and_cross_slate_isolation(tmp_path, scope):
    original = [{'symbol': '2330', 'prices': [{'close': 10}], 'stock_meta': {'peer': .2}}]
    before = deepcopy(original)
    with artifacts.local_store(tmp_path):
        ref = artifacts.put(original, scope)
        assert ref['sha256'] == digest(original)
        first = artifacts.load(ref, scope)
        first[0]['prices'][0]['close'] = 999
        assert artifacts.load(ref, scope) == original == before
        with pytest.raises(ValueError, match='identity'):
            artifacts.load(ref, {**scope, 'run': 'other'})
        (tmp_path/hashlib.sha256(ref['path'].encode()).hexdigest()).write_bytes(gzip.compress(b'[]'))
        with pytest.raises(ValueError, match='checksum'):
            artifacts.load(ref)


def test_checkpoint_survives_interruption_without_rebuilding_completed_groups(tmp_path, scope):
    calls = []
    with artifacts.local_store(tmp_path):
        a = artifacts.checkpoint(scope, ['pre', 1], lambda: calls.append(1) or [{'v': 1}])
        def interrupted():
            raise RuntimeError('interrupted')
        with pytest.raises(RuntimeError):
            artifacts.checkpoint(scope, ['pre', 2], interrupted)
        assert artifacts.checkpoint(scope, ['pre', 1], lambda: pytest.fail('rebuild')) == a
        b = artifacts.checkpoint(scope, ['pre', 2], lambda: calls.append(2) or [{'v': 2}])
        assert artifacts.load(b) == [{'v': 2}] and calls == [1, 2]
        assert artifacts.checkpoint(scope, ['changed-policy', 1], lambda: [{'v': 3}]) != a


def test_owned_consumer_preserves_inline_and_artifact_sources(tmp_path, scope):
    original = {'symbols': ['A'], 'payloads': [{'symbol': 'A', 'prices': [{'close': 1}]}],
                'sequence_series': [{'symbol': 'A', 'prices': [1]}]}
    with artifacts.local_store(tmp_path):
        for source in (original, artifacts.put(original, scope)):
            value = artifacts.load_inputs(source, scope)
            value['payloads'][0]['prices'][0]['close'] = 999
            value['sequence_series'][0]['prices'][0] = 999
            assert artifacts.load_inputs(source, scope) == original
        rows = artifacts.load_owned(original['payloads'])
        rows[0]['prices'][0]['close'] = 999
        assert original['payloads'][0]['prices'][0]['close'] == 1


def test_verified_builder_view_preserves_own_peer_features_without_source_mutation(monkeypatch, tmp_path, scope):
    from test_paired_nav_atomic_payload_boundary import _frozen_loaders, _from_sources
    from services import payload_builder as builder
    stocks = _frozen_loaders(monkeypatch)
    packet = builder.capture_payload_sources(stocks, '2026-09-06')
    before = deepcopy(packet)
    view = builder.VerifiedPayloadSources(packet, '2026-09-06')
    with artifacts.local_store(tmp_path):
        for slate in (stocks[:2], [stocks[0], stocks[2]]):
            expected = _from_sources(slate, packet)
            values = [dict(vars(p)) for p in builder.build_payloads(slate, builder.MarketEnv(), {}, {}, {},
                '2026-09-06', frozen_sources=packet, verified_sources=view)]
            ref = artifacts.put(values, scope)
            assert artifacts.load(ref) == expected
        assert packet == before


def test_shared_arrays_are_stored_once_but_each_loaded_payload_is_isolated(tmp_path, scope):
    history = [{'date': '2026-10-16', 'close': 100}]
    rows = [{'symbol': s, 'prices': [{'close': i}], 'market_env': {'history': history, 'pe': i},
             'stock_meta': {'peer': i}, 'runtime_options': {}} for i, s in enumerate(['A', 'B'])]
    with artifacts.local_store(tmp_path):
        pool = artifacts.shared_payload_pool(rows)
        assert len(pool['histories']) == 1
        shared = artifacts.put(pool, scope)
        ref = artifacts.put_payloads(rows, scope, shared, pool)
        assert artifacts.content_digest(ref) == digest(rows)
        a = artifacts.load(ref)
        assert a == rows
        a[0]['market_env']['history'][0]['close'] = 999
        assert a[1]['market_env']['history'][0]['close'] == 100
        assert artifacts.load(ref) == rows
        tampered = {**ref, 'logical_sha256': '0'*64}
        with pytest.raises(ValueError, match='logical_checksum'):
            artifacts.load(tampered)
        inputs = {'symbols': ['A', 'B'], 'payloads': ref, 'sequence_series': []}
        restored = artifacts.load_inputs(artifacts.put(inputs, scope))
        assert restored['payloads'] == rows


def test_checkpoint_verification_checks_logical_hash_without_copying_histories(monkeypatch, tmp_path, scope):
    rows = [{'symbol': 'A', 'prices': [{'close': 1}],
             'market_env': {'history': [{'close': 2}]}, 'stock_meta': {'peer': 3}}]
    with artifacts.local_store(tmp_path):
        pool = artifacts.shared_payload_pool(rows)
        shared = artifacts.put(pool, scope)
        ref = artifacts.checkpoint(scope, ['pre', 'A'], lambda: rows,
            store=lambda value, target: artifacts.put_payloads(value, target, shared, pool))
        monkeypatch.setattr(artifacts, 'deepcopy', lambda value: pytest.fail('verification_copied_consumer'))
        assert artifacts.checkpoint(scope, ['pre', 'A'], lambda: pytest.fail('rebuild')) == ref
        artifacts.verify(ref, scope)
        with pytest.raises(ValueError, match='logical_checksum'):
            artifacts.verify({**ref, 'logical_sha256': '0' * 64}, scope)
        with pytest.raises(ValueError, match='identity'):
            artifacts.verify(ref, {**scope, 'run': 'wrong'})


def test_reference_read_cache_is_scoped_to_owner_and_does_not_keep_decoded_rows(monkeypatch, tmp_path, scope):
    with artifacts.local_store(tmp_path):
        ref = artifacts.put([{'value': 1}], scope)
        original = artifacts._download_uncached
        reads = []
        def download(key, filename):
            reads.append(key)
            return original(key, filename)
        monkeypatch.setattr(artifacts, '_download_uncached', download)
        @artifacts.artifact_reads
        def owner():
            first = artifacts.load(ref)
            first[0]['value'] = 99
            assert artifacts.load(ref) == [{'value': 1}]
        owner()
        assert len(reads) == 1
        owner()
        assert len(reads) == 2
        assert artifacts._reads.get() is None


def test_identical_checkpoint_verification_is_reused_only_within_owner(monkeypatch, tmp_path, scope):
    with artifacts.local_store(tmp_path):
        ref = artifacts.put([{'value': 1}], scope)
        actual = artifacts._load
        reads = []
        def read(*args, **kwargs):
            reads.append(args[0]['sha256'])
            return actual(*args, **kwargs)
        monkeypatch.setattr(artifacts, '_load', read)
        @artifacts.artifact_reads
        def owner():
            artifacts.verify(ref, scope)
            artifacts.verify(ref, scope)
            with pytest.raises(ValueError, match='identity'):
                artifacts.verify(ref, {**scope, 'run': 'wrong'})
        owner()
        assert len(reads) == 1
        owner()
        assert len(reads) == 2 and artifacts._verified.get() is None


def test_nested_payload_reference_cannot_cross_run(tmp_path, scope):
    with artifacts.local_store(tmp_path):
        other = artifacts.put([], {**scope, 'run': 'other'})
        outer = artifacts.put({'symbols': [], 'payloads': other, 'sequence_series': []}, scope)
        with pytest.raises(ValueError, match='identity'):
            artifacts.load_inputs(outer)


@pytest.mark.asyncio
async def test_async_checkpoint_reuses_completed_work_and_does_not_save_failed_attempt(tmp_path, scope):
    calls = []
    async def build():
        calls.append(1)
        return {'status': 'ready', 'value': [1, 2]}
    async def failed():
        return {'status': 'failed'}
    with artifacts.local_store(tmp_path):
        accept = lambda v: v['status'] == 'ready'
        assert await artifacts.checkpoint_async(scope, 'l2', failed, cacheable=accept) == {'status': 'failed'}
        ref = await artifacts.checkpoint_async(scope, 'l2', build, cacheable=accept)
        assert await artifacts.checkpoint_async(scope, 'l2', build, cacheable=accept) == ref
        assert calls == [1] and artifacts.load(ref)['value'] == [1, 2]


def test_gcs_adapter_pins_generation_and_checksum_and_never_overwrites(monkeypatch, tmp_path, scope):
    from google.api_core.exceptions import NotFound, PreconditionFailed
    from pathlib import Path
    objects, calls = {}, []
    class Blob:
        generation = 7
        def __init__(self, key):
            self.key = key
        def reload(self):
            if self.key not in objects:
                raise NotFound('missing')
        def upload_from_filename(self, filename, **options):
            calls.append(('upload', options))
            if self.key in objects:
                raise PreconditionFailed('exists')
            objects[self.key] = Path(filename).read_bytes()
        def download_to_filename(self, filename, **options):
            calls.append(('download', options))
            Path(filename).write_bytes(objects[self.key])
    class Bucket:
        def blob(self, key):
            return Blob(key)
    monkeypatch.setattr(artifacts, '_bucket', lambda: Bucket())
    token = artifacts._local.set(None)
    try:
        ref = artifacts.put([{'value': 3}], scope)
        assert artifacts.put([{'value': 3}], scope) == ref
        assert artifacts.load(ref) == [{'value': 3}]
        assert len(objects) == 1
        assert calls == [('upload', {'if_generation_match': 0, 'checksum': 'crc32c'})] * 2 + [
            ('download', {'if_generation_match': 7, 'checksum': 'crc32c'})]
        assert not artifacts._download_uncached('missing', str(tmp_path / 'missing'))
    finally:
        artifacts._local.reset(token)
