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


@pytest.mark.parametrize('r2',[False,'candidate','baseline','p6_raw','p6_linear'])
def test_private_frozen_full_pool_replans_and_serializer_rollback(r2,monkeypatch):
    packet=None
    p6=str(r2).startswith('p6_');loader=None
    if p6:
        from test_l4_p6_runtime import setup
        recs,policy,history,loader=setup()
        if r2=='p6_raw':
            from services.l4_distribution import digest
            policy['artifact']['model']['calibration_kind']='raw'
            policy['artifact']['model_checksum']=digest(policy['artifact']['model'])
        day=policy['runtime']['signal_date']
        def forbidden(ref):raise AssertionError('private_replay_must_not_read_live_weights')
        monkeypatch.setattr('services.l4_p6_weights.load',forbidden)
    elif r2:
        from test_l4_r2_allocation import fixture as r2_fixture
        recs,policy,history,packet=r2_fixture()
        packet['comparison_arm']=r2
        if r2=='baseline':
            from services.l4_distribution import digest
            for row in packet['forecast']['forecasts']:row['baseline_gross']=row['relative_mu']
            packet['forecast']['forecasts_checksum']=digest(packet['forecast']['forecasts'])
    else:recs,policy,history=fixture()
    policy['scope']='private_research'
    policy['artifact'].pop('release',None)
    day=policy['runtime']['signal_date']
    with sqlite3.connect(':memory:') as db:
        for path in ['core/0001_core_baseline.sql','paper/0001_paper_baseline.sql','paper/0005_l4_distribution.sql']:
            db.executescript((ROOT/'worker/domain-migrations'/path).read_text(encoding='utf-8-sig'))
        db.execute('INSERT INTO paper_accounts(id,cash,initial_cash) VALUES(1,1000000,1000000)')
        seeds=[]
        for i,r in enumerate(recs,1):
            db.execute('INSERT INTO stocks(id,symbol,name,market) VALUES(?,?,?,?)',[i,r['symbol'],r['symbol'],'TWSE'])
            r.update(stock_id=i,score=50,score_seed_inputs={'chipFlowSeed40':20,'technicalSeed30':15,'screenerMomentumSeed20':10,'mlEdgeSeed30':15})
            seeds.append({'stock_id':i,'symbol':r['symbol'],'name':r['symbol'],'date':day,'rank':i,'score':50,'reason':'synthetic_seed','created_at':'2026-09-11 13:00:00'})
        raw='\n'.join(db.iterdump())
    inputs={'recommendations':recs,'alpha_policy':{'l4Distribution':policy},'return_history':history}
    if packet is not None:inputs['r2_shadow']=packet
    if p6:
        import base64
        inputs['p6_weight_objects']={r['weights']['path']:{'reference':r['weights'],
            'base64':base64.b64encode(loader(r['weights'])).decode()} for r in policy['artifact']['model']['seeds']}
    prepared=prepare_native_state(base_state={'state_sql':raw,'state_checksum':checksum(raw)},seed_rows=seeds,
        recommendations=recs,signal_date=day,trading_config={'l4Distribution':policy},risk_config={'system':{}},
        l4_allocation_inputs=inputs,allocation_snapshot_id='c'*64)
    f={'input_id':'f','stage':'morning','observed_at':('2026-10-20' if p6 else '2026-09-14')+'T00:00:00Z'}
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
        if p6:assert result['plan']['p6_projection']['source_pool_size']==4
        if p6:
            from services.l4_distribution_runtime import run
            expected_policy=deepcopy(policy);expected_policy['runtime']['account']=account
            expected=run(recs,expected_policy,return_history=history,private_research=True,p6_weight_loader=loader)[0]['_l4_portfolio_plan']
            assert result['plan']==expected
        else:assert result['plan']['weights']['B']>0
        if r2 and not p6:
            assert result['plan']['model_checksum']==packet['forecast']['baseline_model_checksum' if r2=='baseline' else 'model_checksum']
            assert result['plan']['r2_evidence']['promotion_allowed'] is False
        saved=json.loads(store.db.execute("SELECT alpha_allocation FROM daily_recommendations WHERE symbol='B'").fetchone()[0])
        assert saved['plan_id']==result['plan']['plan_id']
        account['forbidden_buys']=['A','B']
        revised=store.dispatch('l4_allocate',{'account':account})
        assert revised['plan']['weights']['B']==0
        if p6:
            expected_policy['runtime']['account']=account
            expected=run(recs,expected_policy,return_history=history,private_research=True,p6_weight_loader=loader)[0]['_l4_portfolio_plan']
            assert revised['plan']==expected
        else:assert revised['plan']['weights']['C']>0
        assert store.db.execute('SELECT cash FROM paper_accounts WHERE id=1').fetchone()[0]==1000000
        assert store.db.execute('SELECT COUNT(*) FROM paper_orders').fetchone()[0]==0
        store.dispatch('frame_rollback',{})
        assert store.db.execute("SELECT alpha_allocation FROM daily_recommendations WHERE symbol='B'").fetchone()[0] is None
    finally:store.db.close()


def test_private_p6_changed_or_missing_weights_rejected():
    import base64
    from test_l4_p6_runtime import setup
    from services.l4_private_execution import frozen_p6_loader
    _,policy,_,loader=setup();bundle=policy['artifact']
    with pytest.raises(ValueError,match='inventory_missing'):frozen_p6_loader({},bundle)
    objects={r['weights']['path']:{'reference':r['weights'], 'base64':base64.b64encode(loader(r['weights'])).decode()}
             for r in bundle['model']['seeds']}
    path=next(iter(objects));objects[path]['base64']=base64.b64encode(b'wrong').decode()
    with pytest.raises(ValueError,match='checksum_mismatch'):
        frozen_p6_loader({'p6_weight_objects':objects},bundle)
