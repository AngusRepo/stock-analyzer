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
