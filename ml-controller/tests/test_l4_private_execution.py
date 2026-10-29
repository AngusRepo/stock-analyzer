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


@pytest.mark.parametrize('r2',[False,'candidate','baseline'])
def test_private_frozen_full_pool_replans_and_serializer_rollback(r2):
    packet=None
    if r2:
        from test_l4_r2_allocation import fixture as r2_fixture
        recs,policy,history,packet=r2_fixture()
        packet['comparison_arm']=r2
        if r2=='baseline':
            from services.l4_distribution import digest
            for row in packet['forecast']['forecasts']:row['baseline_gross']=row['relative_mu']
            packet['forecast']['forecasts_checksum']=digest(packet['forecast']['forecasts'])
    else:recs,policy,history=fixture()
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
    if packet is not None:inputs['r2_shadow']=packet
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
        if r2:
            assert result['plan']['model_checksum']==packet['forecast']['baseline_model_checksum' if r2=='baseline' else 'model_checksum']
            assert result['plan']['r2_evidence']['promotion_allowed'] is False
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


def _private_store(recs,policy,history,inputs,receipts=()):
    with sqlite3.connect(':memory:') as db:
        for path in ['core/0001_core_baseline.sql','paper/0001_paper_baseline.sql','paper/0005_l4_distribution.sql']:
            db.executescript((ROOT/'worker/domain-migrations'/path).read_text(encoding='utf-8-sig'))
        db.execute('INSERT INTO paper_accounts(id,cash,initial_cash) VALUES(1,1000000,1000000)')
        seeds=[]
        for i,r in enumerate(recs,1):
            db.execute('INSERT INTO stocks(id,symbol,name,market) VALUES(?,?,?,?)',[i,r['symbol'],r['symbol'],'TWSE'])
            r.update(stock_id=i,score=50,score_seed_inputs={'chipFlowSeed40':20,'technicalSeed30':15,'screenerMomentumSeed20':10,'mlEdgeSeed30':15})
            seeds.append({'stock_id':i,'symbol':r['symbol'],'name':r['symbol'],'date':'2026-09-11','rank':i,'score':50,'reason':'synthetic_seed','created_at':'2026-09-11 13:00:00'})
        for i,receipt in enumerate(receipts):
            db.execute('INSERT INTO l4_policy_account_rewards_v1(receipt_id,known_date,policy_identity,payload_json) VALUES(?,?,?,?)',
                       [f'r{i}',receipt['known_date'],'x'*64,json.dumps(receipt)])
        raw='\n'.join(db.iterdump())
    prepared=prepare_native_state(base_state={'state_sql':raw,'state_checksum':checksum(raw)},seed_rows=seeds,
        recommendations=recs,signal_date='2026-09-11',trading_config={'l4Distribution':policy},risk_config={'system':{}},
        l4_allocation_inputs=inputs,allocation_snapshot_id='c'*64)
    f={'input_id':'f','stage':'morning','observed_at':'2026-09-14T00:00:00Z'}
    store=PrivatePaperStore(prepared['state_sql'],prepared['state_checksum'],{'f':f})
    store.dispatch('frame_input',{**f,'now_ms':int(datetime.fromisoformat(f['observed_at']).timestamp()*1000)})
    store.dispatch('frame_begin',{})
    return store


def _v2_learned_case():
    from datetime import date, timedelta
    from services.l4_distribution_runtime import distribution_policy_identity
    from services.l4_opb_selection import LEDGER_SCHEMA, arm_policies, context_identity, risk_envelope
    from test_l4_opb_v2 import v2_fixture
    recs,policy,history=v2_fixture()
    identity=policy['runtime']['l3_identity']
    policy['opb']['approved_policy_identity']=distribution_policy_identity(policy,identity)
    account=policy['runtime']['account']
    arms={a['id']:a for a in arm_policies(policy,risk_envelope(account,account['nav']))}
    context=context_identity(policy,identity)
    start=date(2026,6,1)
    ledger=[{'context_identity':context,'signal_date':(start+timedelta(days=i)).isoformat(),
             'known_date':(start+timedelta(days=i+5)).isoformat(),'arm_digest':arms['tight']['definition_digest'],
             'schema_version':LEDGER_SCHEMA,'delta':.002+.0001*(i%3),'status':'complete'} for i in range(40)]
    return recs,policy,history,ledger


@pytest.mark.parametrize('sealed',['learned','empty'])
def test_v2_private_replay_uses_the_sealed_arm_ledger_and_matches_the_formal_arm(sealed):
    from services.l4_distribution_runtime import run
    recs,policy,history,ledger=_v2_learned_case()
    # Candidate arms seal an empty ledger on purpose; rows in the private host's
    # table must not leak into v2 (they would move the empty case off base).
    receipts=()
    if sealed=='empty':receipts,ledger=ledger,[]
    formal=run(deepcopy(recs),deepcopy(policy),return_history=history,reward_ledger=ledger)[0]['_l4_portfolio_plan']['opb']
    assert (formal['status'],formal['arm_id'])==(('learned_policy','tight') if sealed=='learned' else ('cold_start_base','base'))
    private=deepcopy(policy);private['scope']='private_research';private['artifact'].pop('release',None)
    account=deepcopy(policy['runtime']['account'])
    account['account_anchor']={'cash':1000000,'order_watermark':0,'positions':[], 'settlement':{'unsettledBuyAmount':0,'unsettledSellAmount':0}}
    inputs={'recommendations':recs,'alpha_policy':{'l4Distribution':private},'return_history':history,'opb_reward_ledger':ledger}
    store=_private_store(recs,private,history,inputs,receipts)
    try:
        opb=store.dispatch('l4_allocate',{'account':account})['plan']['opb']
        assert (opb['status'],opb['arm_id'],opb['effective_digest'])==(formal['status'],formal['arm_id'],formal['effective_digest'])
    finally:store.db.close()


def test_v2_private_replay_without_a_sealed_ledger_fails_closed():
    recs,policy,history,_=_v2_learned_case()
    private=deepcopy(policy);private['scope']='private_research';private['artifact'].pop('release',None)
    account=deepcopy(policy['runtime']['account'])
    account['account_anchor']={'cash':1000000,'order_watermark':0,'positions':[], 'settlement':{'unsettledBuyAmount':0,'unsettledSellAmount':0}}
    store=_private_store(recs,private,history,{'recommendations':recs,'alpha_policy':{'l4Distribution':private},'return_history':history})
    try:
        with pytest.raises(ValueError,match='private_l4_opb_reward_ledger_missing'):
            store.dispatch('l4_allocate',{'account':account})
        assert store.db.execute('SELECT COUNT(*) FROM daily_recommendations WHERE alpha_allocation IS NOT NULL').fetchone()[0]==0
    finally:store.db.close()
