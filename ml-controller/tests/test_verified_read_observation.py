from copy import deepcopy
import pytest
from services.verified_read_observation import verified_read_observation, observed_read


def test_duplicate_reads_rechecked_and_no_cache_survives_request():
    calls=[]
    def fetch():
        calls.append(1)
        return [{'id':1,'nullable':None,'unknown_added_column':'preserved'}]
    with verified_read_observation():
        first=observed_read(('learning','1'),'SELECT * FROM source',fetch)
        first[0]['id']=99
        assert observed_read(('learning','1'),'SELECT * FROM source',fetch)[0]['id']==1
        assert len(calls)==1
    assert len(calls)==2
    observed_read(('learning','1'),'SELECT * FROM source',fetch)
    assert len(calls)==3


@pytest.mark.parametrize('changed', [[],[{'id':1,'nullable':0}], [{'id':2,'nullable':None}]])
def test_source_change_prevents_successful_return(changed):
    rows=[{'id':1,'nullable':None}]
    def fetch():return deepcopy(rows)
    def proof():
        with verified_read_observation():
            observed_read('source','SELECT * FROM source',fetch)
            rows[:]=changed
            return 'must not escape'
    with pytest.raises(RuntimeError,match='observation_changed'):proof()


def test_database_bindings_and_schema_queries_independently_verified():
    calls=[]
    with verified_read_observation():
        for key in [('learning',1),('market',1),('learning',2),('learning',1)]:
            observed_read(key,'SELECT * FROM source WHERE id=?',lambda key=key:(calls.append(key),[{'value':key}])[1])
        observed_read('schema','PRAGMA table_info(source)',lambda:(calls.append('schema'),[])[1])
    assert len(calls)==8 and calls[:4]==calls[4:]


def test_failed_recheck_write_and_nested_scopes_fail_closed():
    calls=0
    def fetch():
        nonlocal calls
        calls+=1
        if calls==2:raise TimeoutError('source unavailable')
        return []
    with pytest.raises(TimeoutError):
        with verified_read_observation():observed_read('source','SELECT * FROM source',fetch)
    with pytest.raises(ValueError,match='read_only'):
        with verified_read_observation():observed_read('source','DELETE FROM source',fetch)
    with pytest.raises(RuntimeError,match='nested'):
        with verified_read_observation():
            with verified_read_observation():pass
    assert observed_read('source','SELECT * FROM source',lambda:[1])==[1]

@pytest.mark.parametrize('change', [False, True])
def test_lineage_threadpool_checks_actual_domain_response_before_return(monkeypatch, change):
    import asyncio
    from routers.model_pool import _read_in_threadpool
    from services import d1_domain_client as domain
    monkeypatch.setenv('MULTI_D1_ACTIVE_DOMAINS','learning')
    monkeypatch.setenv('CF_D1_LEARNING_DB_ID','test-learning')
    monkeypatch.setattr(domain.d1_client,'STRATEGY_MINING_D1_WORKER_ONLY',False)
    calls=[]
    state=[{'artifact_id':'model','status':'admitted','future_column':None}]
    def post(body,timeout,database_id):
        calls.append((deepcopy(body),database_id))
        return {'result':[{'results':deepcopy(state)}]}
    monkeypatch.setattr(domain.d1_client,'_post',post)
    monkeypatch.setattr(domain.d1_client,'read_raw_batch',
        lambda requests, database_id, timeout:[post(request,timeout,database_id)['result'][0]['results'] for request in requests])
    client=domain.client_for_domain('learning')
    def reader():
        rows=client.query('SELECT * FROM admission WHERE id=?',[1])
        assert client.query('SELECT * FROM admission WHERE id=?',[1])==rows
        if change:state[0]['future_column']='revoked'
        return rows
    if change:
        with pytest.raises(RuntimeError,match='observation_changed'):
            asyncio.run(_read_in_threadpool(reader,verify_sources=True))
    else:
        assert asyncio.run(_read_in_threadpool(reader,verify_sources=True))==state
    assert len(calls)==2 and all(c[1]=='test-learning' for c in calls)
    # Ordinary inference is not memoized or copied through the UI mechanism.
    client.query('SELECT * FROM admission WHERE id=?',[1])
    client.query('SELECT * FROM admission WHERE id=?',[1])
    assert len(calls)==4


@pytest.mark.parametrize('change', [None, 'risk', 'approval', 'source'])
def test_configuration_and_kv_deduplicated_but_fully_rechecked(monkeypatch, change):
    from services import kv_client, active8_nav_adoption as authority
    reads = []
    values = {'risk': '{"limit":1}', 'approval': '{"approved":true}'}
    source = {'unknown_future_field': None}
    def remote(key, **kwargs):
        reads.append(key)
        return values[key]
    monkeypatch.setattr(kv_client, '_get_remote', remote)
    def configuration():
        reads.append('configuration')
        return {'risk': kv_client.get_json('risk', strict=True), 'source': deepcopy(source)}
    monkeypatch.setattr(authority, '_read_execution_configuration', configuration)
    def read():
        with verified_read_observation():
            for _ in range(8):
                assert authority.current_execution_configuration()['risk']['limit'] == 1
                assert kv_client.get_json('approval', strict=True)['approved'] is True
            assert reads.count('configuration') == reads.count('risk') == reads.count('approval') == 1
            if change == 'source': source['unknown_future_field'] = 'changed'
            elif change: values[change] = '{}'
    if change:
        with pytest.raises(RuntimeError, match='observation_changed'): read()
    else:
        read()
        assert reads.count('configuration') == reads.count('approval') == 2
    # Inference remains uncached outside the UI observation.
    before = reads.count('configuration')
    authority.current_execution_configuration(); authority.current_execution_configuration()
    assert reads.count('configuration') == before + 2


def test_sql_rechecks_grouped_without_omitting_values():
    batch_calls=[]
    state={'one':[{'nullable':None,'unknown':'preserved'}], 'two':[{'v':2}]}
    def batch(requests):
        batch_calls.append(requests)
        return [deepcopy(state[r]) for r in requests]
    with verified_read_observation():
        for key in state:
            observed_read(key,'SELECT * FROM source',lambda key=key:deepcopy(state[key]),
                          batch=('database',key,batch))
    assert batch_calls==[['one','two']]
    with pytest.raises(RuntimeError,match='observation_changed'):
        with verified_read_observation():
            observed_read('one','SELECT * FROM source',lambda:deepcopy(state['one']),
                          batch=('database','one',batch))
            state['one'][0]['unknown']='revoked'


@pytest.mark.parametrize('result', [[], [{'success':False}],
    [{'success':True,'results':{'columns':['x'],'rows':[[]]}}],
    [{'success':True,'results':{'columns':['x','x'],'rows':[[1,2]]}}]])
def test_batch_decoder_rejects_partial_failed_or_ambiguous_results(monkeypatch,result):
    from services import d1_client
    monkeypatch.setattr(d1_client,'_post_raw',lambda *a,**k:{'result':result})
    with pytest.raises(RuntimeError,match='d1_read_batch'):
        d1_client.read_raw_batch([{'sql':'SELECT 1'}],database_id='learning')


def test_batch_decoder_preserves_null_and_new_columns(monkeypatch):
    from services import d1_client
    monkeypatch.setattr(d1_client,'_post_raw',lambda *a,**k:{'result':[
        {'success':True,'results':{'columns':['id','new_field'],'rows':[[1,None]]}}]})
    assert d1_client.read_raw_batch([{'sql':'SELECT * FROM x'}],database_id='learning')==[[{'id':1,'new_field':None}]]
