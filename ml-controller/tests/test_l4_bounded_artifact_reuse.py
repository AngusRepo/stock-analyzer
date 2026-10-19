from copy import deepcopy
import pytest
from services import pipeline_slate_artifacts as a
from services.paired_nav_journal import digest

@pytest.fixture
def scope():
    return {'date':'2026-10-16','run':'test','source':digest('source'),'code':'a'*40}

def test_readonly_delta_preserves_bytes_and_shares_only_transient_history(tmp_path,scope):
    history=[{'close':100,'values':[1,2,3]}]
    rows=[{'symbol':s,'market_env':{'history':history},'chips':{'value':i}} for i,s in enumerate(['A','B'])]
    before=deepcopy(rows)
    with a.local_store(tmp_path):
        pool=a.shared_payload_pool(rows);shared=a.put(pool,scope)
        ref=a.put_payloads(rows,scope,shared,pool)
        transient=a.load_readonly(ref,scope)
        assert transient==before==rows
        assert transient[0]['market_env']['history'] is transient[1]['market_env']['history']
        mutable=a.load(ref,scope)
        mutable[0]['market_env']['history'][0]['close']=999
        assert mutable[1]['market_env']['history'][0]['close']==100
        assert a.load(ref,scope)==before
        with pytest.raises(ValueError,match='logical_checksum'):
            a.load_readonly({**ref,'logical_sha256':'0'*64},scope)

def test_projection_is_verified_once_per_owner_and_returns_independent_rows(tmp_path,scope,monkeypatch):
    with a.local_store(tmp_path):
        ref=a.put([{'symbol':'A','chips':{'v':1},'prices':[1,2,3]}],scope)
        original=a.load_readonly;calls=[]
        def load(*args,**kwargs):calls.append(1);return original(*args,**kwargs)
        monkeypatch.setattr(a,'load_readonly',load)
        @a.artifact_reads
        def owner():
            first=a.load_fields(ref,('symbol','chips'),scope)
            first[0]['chips']['v']=999
            assert a.load_fields(ref,('symbol','chips'),scope)==[{'symbol':'A','chips':{'v':1}}]
            with pytest.raises(ValueError,match='identity'):
                a.load_fields(ref,('symbol','chips'),{**scope,'run':'other'})
            with pytest.raises(ValueError,match='identity'):
                a.load_fields({**ref,'sha256':'0'*64},('symbol','chips'),scope)
        owner();assert len(calls)==1
        owner();assert len(calls)==2
        assert a._projections.get() is None

def test_inline_projection_observes_mutation_on_every_read():
    rows=[{'symbol':'A','chips':{'v':1}}]
    @a.artifact_reads
    def owner():
        assert a.load_fields(rows,('chips',))[0]['chips']['v']==1
        rows[0]['chips']['v']=2
        assert a.load_fields(rows,('chips',))[0]['chips']['v']==2
    owner()

def test_preparation_exact_dependency_change_failure_and_scope_expiry():
    calls=[];identity={'input':[1]}
    def build():calls.append(1);return {'receipt':[len(calls)]}
    @a.artifact_reads
    def owner():
        first=a.verified_preparation(identity,build)
        first['receipt'][0]=999
        assert a.verified_preparation(identity,build)=={'receipt':[1]}
        identity['input'].append(2)
        assert a.verified_preparation(identity,build)=={'receipt':[2]}
        def fail():raise ValueError('bad')
        with pytest.raises(ValueError):a.verified_preparation('failed',fail)
        assert a.verified_preparation('failed',build)=={'receipt':[3]}
    owner();assert len(calls)==3
    assert a.verified_preparation(identity,build)=={'receipt':[4]}
    assert a._preparations.get() is None

def test_preparation_cache_rejects_oversized_results(monkeypatch):
    monkeypatch.setattr(a,'PREPARATION_CACHE_BYTES',20)
    calls=[]
    @a.artifact_reads
    def owner():
        for _ in range(2):
            a.verified_preparation('large',lambda:calls.append(1) or {'v':'x'*100})
        assert sum(map(len,a._preparations.get().values()))<=20
    owner();assert len(calls)==2

def test_compressed_file_cache_budget_never_retains_large_object(tmp_path,scope,monkeypatch):
    monkeypatch.setattr(a,'READ_CACHE_BYTES',1)
    with a.local_store(tmp_path):
        ref=a.put([{'symbol':'A','v':'x'*100}],scope)
        @a.artifact_reads
        def owner():
            assert a.load(ref)==a.load(ref)
            assert not a._read_sizes.get()
        owner()


def test_daily_input_readers_keep_full_verification_without_copying_observations(monkeypatch):
    from services import paired_nav_atomic_inputs as inputs
    rows=[{'symbol':'A'}]
    packet={'schema_version':'paired-nav-atomic-daily-inputs-v1','signal_date':'2026-10-16',
            'producer_run_id':'test','formal_stocks':rows,'observations':[{'v':[1,2,3]}]}
    packet['input_checksum']=digest(packet)
    kwargs=dict(signal_date='2026-10-16',producer_run_id='test',formal_stocks=rows)
    mutable=inputs.validate_daily_inputs(packet,**kwargs)
    mutable['observations'][0]['v'].append(999)
    assert packet['observations'][0]['v']==[1,2,3]
    monkeypatch.setattr(inputs,'deepcopy',lambda value:pytest.fail('read-only validation copied source'))
    assert inputs.validate_daily_inputs(packet,**kwargs,readonly=True) is packet
    packet['observations'][0]['v'].append(4)
    with pytest.raises(ValueError,match='frozen_inputs_invalid'):
        inputs.validate_daily_inputs(packet,**kwargs,readonly=True)
