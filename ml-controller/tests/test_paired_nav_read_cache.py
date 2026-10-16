import os
import pytest
from services.paired_nav_read_cache import reuse_verified_cold_reads, cached_verified_read, _scope


def test_repeated_projection_replacement_releases_files_and_preserves_budget():
    with reuse_verified_cold_reads(max_bytes=2000, entry_bytes=1000):
        cache = _scope.get()
        cache.save('other', {'retained': 1})
        for sequence in range(40):
            cache.save('same', {'sequence': sequence, 'data': os.urandom(500)})
            files = [os.path.join(cache.directory, name) for name in os.listdir(cache.directory)]
            assert len(files) == len(cache.entries) == 2
            assert cache.bytes == sum(os.path.getsize(path) for path in files) <= 2000
        assert cache.read('same')[1]['sequence'] == 39
        assert cache.read('other') == (True, {'retained': 1})


def test_repeated_file_replacement_releases_links_without_losing_source(tmp_path):
    source = tmp_path / 'verified.bin'
    source.write_bytes(os.urandom(500))
    with reuse_verified_cold_reads(max_bytes=2000, entry_bytes=1000):
        cache = _scope.get()
        path = cache.save_file('same', source)
        if path is None:
            pytest.skip('filesystem has no hard links')
        for _ in range(40):
            path = cache.save_file('same', path)
            assert path is not None and os.path.exists(path)
            assert os.listdir(cache.directory) == [os.path.basename(path)]
            assert cache.bytes == os.path.getsize(path) == 500
        assert source.read_bytes() == open(path, 'rb').read()


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


def test_oversize_projection_does_not_evict_verified_small_entry():
    data=os.urandom(20000)
    calls=[]
    with reuse_verified_cold_reads(max_bytes=2000, entry_bytes=1000):
        assert cached_verified_read('small',lambda: calls.append('small') or {'v':1})=={'v':1}
        cached_verified_read('large',lambda:data)
        assert cached_verified_read('small',lambda: calls.append('reread') or {'v':1})=={'v':1}
        assert calls==['small']
        assert sum(os.path.getsize(os.path.join(_scope.get().directory,p))
                   for p in os.listdir(_scope.get().directory)) <= 2000


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


def test_async_pipeline_scope_survives_thread_handoffs_and_expires():
    import asyncio
    from services.paired_nav_read_cache import verified_reads_async
    calls=[]
    @verified_reads_async
    async def pipeline():
        for _ in range(2):
            result=await asyncio.to_thread(cached_verified_read,'same-projection',lambda: calls.append(1) or {'v':[1]})
            result['v'].append(2)
        return _scope.get().directory
    directory=asyncio.run(pipeline())
    assert calls==[1]
    assert not os.path.exists(directory)
    assert _scope.get() is None


def test_proxy_and_direct_query_keys_reuse_only_same_actual_database(monkeypatch):
    from services.paired_nav_read_cache import query_cache_identity
    from services.d1_domain_client import DomainD1Client, DomainD1ClientProxy, D1DataDomain
    import services.d1_domain_client as d
    monkeypatch.setattr(d,'database_id_for_domain',lambda *a,**kw:'db-a')
    direct=DomainD1Client(D1DataDomain.LEARNING);proxy=DomainD1ClientProxy('learning')
    key=query_cache_identity(direct.query)
    assert query_cache_identity(proxy.query)==key
    monkeypatch.setattr(d,'database_id_for_domain',lambda *a,**kw:'db-b')
    assert query_cache_identity(proxy.query)!=key


def test_exact_recorded_clients_share_reads_without_expanding_budget(monkeypatch):
    from services.paired_nav_read_cache import query_cache_identity
    from services.daily_nav_read_receipt import RecordedClient
    from services.d1_domain_client import DomainD1Client,D1DataDomain
    import services.d1_domain_client as d
    monkeypatch.setattr(d,'database_id_for_domain',lambda *a,**kw:'db-a')
    direct=DomainD1Client(D1DataDomain.LEARNING);recorded=RecordedClient(direct)
    keys=[query_cache_identity(c.query) for c in (direct,recorded,RecordedClient(recorded))]
    assert keys[0]==keys[1]==keys[2]
    calls=[]
    with reuse_verified_cold_reads(max_bytes=4096,entry_bytes=2048):
        for key in keys:
            value=cached_verified_read((key,'source'),lambda:calls.append(1) or {'rows':[1]})
            value['rows'].append(2)
        assert calls==[1]
        assert _scope.get().bytes<=4096


def test_recorded_policy_reuse_still_rereads_manifest_and_rejects_change(monkeypatch):
    from services.paired_nav_read_cache import policy_definitions,remember_policy_definitions
    from services.daily_nav_read_receipt import RecordedClient
    from services.d1_domain_client import DomainD1Client,D1DataDomain
    import services.d1_domain_client as d
    monkeypatch.setattr(d,'database_id_for_domain',lambda *a,**kw:'db-a')
    manifest={'snapshot_id':'original','payload_checksum':'sealed'};reads=[]
    def query(self,sql,params=None):reads.append(1);return [dict(manifest)]
    monkeypatch.setattr(DomainD1Client,'query',query)
    direct=DomainD1Client(D1DataDomain.LEARNING);recorded=RecordedClient(direct)
    def no_reparse():pytest.fail('reparsed identical source')
    with reuse_verified_cold_reads():
        remember_policy_definitions(recorded.query,manifest,'atomic_strategy',{'candidate':{'v':1}})
        result=policy_definitions(direct.query,'original','atomic_strategy',no_reparse)
        result['definitions'].clear()
        assert policy_definitions(recorded.query,'original','atomic_strategy',no_reparse)['definitions']
        assert len(reads)==2 and recorded.reads
        manifest['payload_checksum']='changed'
        with pytest.raises(RuntimeError,match='policy_source_changed'):
            policy_definitions(direct.query,'original','atomic_strategy',no_reparse)


def test_unknown_recorded_subclass_and_cycle_do_not_claim_domain_identity(monkeypatch):
    from services.paired_nav_read_cache import query_cache_identity
    from services.daily_nav_read_receipt import RecordedClient
    from services.d1_domain_client import DomainD1Client,D1DataDomain
    import services.d1_domain_client as d
    monkeypatch.setattr(d,'database_id_for_domain',lambda *a,**kw:'db-a')
    direct=DomainD1Client(D1DataDomain.LEARNING)
    class FilteredRecorder(RecordedClient):pass
    assert query_cache_identity(FilteredRecorder(direct).query)!=query_cache_identity(direct.query)
    cycle=RecordedClient(direct);cycle.client=cycle
    assert query_cache_identity(cycle.query)==cycle.query


def test_aliases_do_not_make_atomic_comparisons_cacheable(monkeypatch):
    from services.paired_nav_read_cache import remember_comparison,reusable_comparison
    from services.daily_nav_read_receipt import RecordedClient
    from services.d1_domain_client import DomainD1Client,D1DataDomain
    import services.d1_domain_client as d
    monkeypatch.setattr(d,'database_id_for_domain',lambda *a,**kw:'db-a')
    direct=DomainD1Client(D1DataDomain.LEARNING);recorded=RecordedClient(direct)
    allocation={'payload':{'content':{'owner':'atomic_strategy'}}}
    with reuse_verified_cold_reads():
        remember_comparison(recorded.query,allocation,{'manifest':{'snapshot_id':'source'}},{'value':1})
        assert reusable_comparison(direct.query,allocation) is None
