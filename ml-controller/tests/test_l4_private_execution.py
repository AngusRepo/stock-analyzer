import json
import sqlite3
from copy import deepcopy
from datetime import datetime
import pytest
from services.native_paper_sandbox import PrivatePaperStore
from services.native_paper_state import prepare_native_state
from services.l4_private_execution import allocate_private
from test_native_paper_sandbox import ROOT,checksum
from test_l4_distribution_runtime import fixture


def test_private_frozen_full_pool_replans_and_serializer_rollback():
    recs,policy,history=fixture()
    policy['scope']='private_research'
    policy['artifact'].pop('release')
    with sqlite3.connect(':memory:') as db:
        for path in ['core/0001_core_baseline.sql','paper/0001_paper_baseline.sql','paper/0005_l4_distribution.sql']:
            db.executescript((ROOT/'worker/domain-migrations'/path).read_text(encoding='utf-8-sig'))
        db.execute('INSERT INTO paper_accounts(id,cash,initial_cash) VALUES(1,1000000,1000000)')
        seeds=[]
        for i,r in enumerate(recs,1):
            db.execute('INSERT INTO stocks(id,symbol,name,market) VALUES(?,?,?,?)',[i,r['symbol'],r['symbol'],'TWSE'])
            r.update(stock_id=i,score=50,score_seed_inputs={'chipFlowSeed40':20,'technicalSeed30':15,'screenerMomentumSeed20':10,'mlEdgeSeed30':15})
            seeds.append({'stock_id':i,'symbol':r['symbol'],'name':r['symbol'],'date':'2026-09-11','rank':i,'score':50,'reason':'synthetic_seed','created_at':'2026-09-11 13:00:00'})
        raw='\n'.join(db.iterdump())
    inputs={'recommendations':recs,'alpha_policy':{'l4Distribution':policy},'return_history':history}
    prepared=prepare_native_state(base_state={'state_sql':raw,'state_checksum':checksum(raw)},seed_rows=seeds,
        recommendations=recs,signal_date='2026-09-11',trading_config={'l4Distribution':policy},risk_config={'system':{}},
        l4_allocation_inputs=inputs,allocation_snapshot_id='c'*64)
    f={'input_id':'f','stage':'morning','observed_at':'2026-09-14T00:00:00Z'}
    store=PrivatePaperStore(prepared['state_sql'],prepared['state_checksum'],{'f':f})
    try:
        account=deepcopy(policy['runtime']['account'])
        account['account_anchor']={'cash':1000000,'order_watermark':0,'positions':[], 'settlement':{'unsettledBuyAmount':0,'unsettledSellAmount':0}}
        with pytest.raises(ValueError,match='scope_invalid'):allocate_private(store,account)
        store.dispatch('frame_input',{**f,'now_ms':int(datetime.fromisoformat(f['observed_at']).timestamp()*1000)})
        store.dispatch('frame_begin',{})
        result=store.dispatch('l4_allocate',{'account':account})
        assert result['plan']['execution_scope']=='private_research'
        assert result['plan']['proof']['evaluated_candidate_count']==3
        assert result['plan']['weights']['B']>0
        saved=json.loads(store.db.execute("SELECT alpha_allocation FROM daily_recommendations WHERE symbol='B'").fetchone()[0])
        assert saved['plan_id']==result['plan']['plan_id']
        account['forbidden_buys']=['A','B']
        revised=store.dispatch('l4_allocate',{'account':account})
        assert revised['plan']['weights']['B']==0 and revised['plan']['weights']['C']>0
        assert store.db.execute('SELECT cash FROM paper_accounts WHERE id=1').fetchone()[0]==1000000
        assert store.db.execute('SELECT COUNT(*) FROM paper_orders').fetchone()[0]==0
        store.dispatch('frame_rollback',{})
        assert store.db.execute("SELECT alpha_allocation FROM daily_recommendations WHERE symbol='B'").fetchone()[0] is None
    finally:store.db.close()
