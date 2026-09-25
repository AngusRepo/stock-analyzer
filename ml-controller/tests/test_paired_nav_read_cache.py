import os
import pytest
from services.paired_nav_read_cache import reuse_verified_cold_reads, cached_verified_read, _scope


def test_success_reused_but_mutation_does_not_escape_and_scope_expires():
    reads = []
    def read():
        reads.append(1)
        return {'rows': [1, 2]}
    with reuse_verified_cold_reads():
        directory = _scope.get().directory
        cached_verified_read('a', read)['rows'].append(3)
        assert cached_verified_read('a', read) == {'rows': [1, 2]}
        with reuse_verified_cold_reads():
            assert cached_verified_read('a', read) == {'rows': [1, 2]}
        assert len(reads) == 1
        cached_verified_read('changed-manifest', read)
        assert len(reads) == 2
    assert not os.path.exists(directory)
    cached_verified_read('a', read)
    assert len(reads) == 3


def test_failed_verification_is_never_cached_and_cleanup_on_error():
    def fail():
        raise RuntimeError('checksum mismatch')
    with pytest.raises(RuntimeError), reuse_verified_cold_reads():
        directory = _scope.get().directory
        cached_verified_read('a', fail)
    assert _scope.get() is None
    assert not os.path.exists(directory)


def test_oversize_does_not_drop_evidence_and_storage_is_bounded():
    data = os.urandom(20000)
    reads = []
    def read():
        reads.append(1)
        return data
    with reuse_verified_cold_reads(max_bytes=2000, entry_bytes=1000):
        for _ in range(2):
            assert cached_verified_read('large', read) == data
        assert len(reads) == 2
        assert _scope.get().bytes == 0
        for i in range(50):
            assert cached_verified_read(i, lambda: os.urandom(500))
            assert sum(os.path.getsize(os.path.join(_scope.get().directory, p))
                       for p in os.listdir(_scope.get().directory)) <= 2000


def test_small_policy_definitions_reuse_fresh_identity_and_not_caller_mutations():
    from services.paired_nav_read_cache import policy_definitions, remember_policy_definitions
    manifest = {'snapshot_id':'source', 'payload_checksum':'original'}
    def query(sql, args): return [dict(manifest)]
    def must_not_read(): raise AssertionError('reparsed immutable source')
    with reuse_verified_cold_reads():
        remember_policy_definitions(query, manifest, 'l15_route', {'candidate':{'version':'v1'}})
        result = policy_definitions(query, 'source', 'l15_route', must_not_read)
        result['definitions'].clear()
        assert policy_definitions(query, 'source', 'l15_route', must_not_read)['definitions']
        manifest['payload_checksum'] = 'changed'
        with pytest.raises(RuntimeError, match='policy_source_changed'):
            policy_definitions(query, 'source', 'l15_route', must_not_read)
