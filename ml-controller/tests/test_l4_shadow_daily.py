import base64,hashlib,json,sqlite3
from copy import deepcopy
import pytest
from services.l4_challenger_comparison import seal
from services.l4_challenger_registry import Registry
from services.l4_shadow_accounts import Accounts,PREFIX
from services.l4_shadow_daily import configuration_checksum,validate
from test_l4_challenger_registry import Bucket,entry
from test_native_paper_sandbox import native_runner,ROOT,frame
from test_l4_distribution_runtime import fixture
from test_l4_p6_runtime import setup as p6_setup


def reseal(value):return seal({k:v for k,v in value.items() if k!='checksum'})


def setup(runner,p6=False,full_session=False):
    if p6:rows,policy,history,loader=p6_setup()
    else:rows,policy,history=fixture();loader=None
    policy=deepcopy(policy);policy['scope']='private_research'
    policy['runtime']['signal_date']='2026-10-19';policy['runtime']['account']['signal_date']='2026-10-19'
    for i,r in enumerate(rows,1):r.update(stock_id=i,score=50,
        score_seed_inputs={'chipFlowSeed40':20,'technicalSeed30':15,'screenerMomentumSeed20':10,'mlEdgeSeed30':15})
    inputs={'recommendations':rows,'alpha_policy':{'l4Distribution':policy},'return_history':history}
    if p6:inputs['p6_weight_objects']={r['weights']['path']:{'reference':r['weights'],
        'base64':base64.b64encode(loader(r['weights'])).decode()} for r in policy['artifact']['model']['seeds']}
    packet={'signal_date':'2026-10-19','session_date':'2026-10-20','next_open':'2026-10-20T09:00:00+08:00',
        'source_receipt_shas':['3'*64],'recommendations':rows,'l4_allocation_inputs':inputs,
        'trading_config':{'l4Distribution':policy},'risk_config':{'system':{}},
        'stock_rows':[dict(id=i,symbol=r['symbol'],name=r['symbol'],market='TWSE',added_at='2026-10-19 00:00:00',updated_at='2026-10-19 00:00:00') for i,r in enumerate(rows,1)],
        'seed_rows':[dict(stock_id=i,symbol=r['symbol'],name=r['symbol'],date='2026-10-19',rank=i,score=50,reason='synthetic',created_at='2026-10-19 13:00:00') for i,r in enumerate(rows,1)]}
    if full_session:
        from test_paired_native_session import native_config
        from services.paired_native_session import STRATEGY_SESSION_POLICY
        config=native_config()
        from services.paired_native_runtime import KV_READ_POLICY
        packet['trading_config']={**config['trading'],'l4Distribution':policy}
        packet['risk_config']=config['risk']
        packet['execution_context']=dict(session_policy=STRATEGY_SESSION_POLICY,variables={},source_tables={},
            capture_kv_reads=True,kv_read_policy=deepcopy(KV_READ_POLICY))
    model=entry('new-model' if p6 else 'old-model');model.pop('checksum')
    model['components'].update(L3=policy['runtime']['l3_identity']['payload_checksum'],L4=policy['artifact']['model_checksum'],
        allocator_policy=configuration_checksum(packet['trading_config'],packet['risk_config']))
    if full_session:
        from services.l4_challenger_comparison import digest
        model['components']['execution_context']=digest(packet['execution_context'])
    model['serving_identity']={'l3_payload_checksum':model['components']['L3'],'l4_model_checksum':model['components']['L4']}
    model['training_receipts']={name:reseal({**r,'component_checksum':model['components'][name]}) for name,r in model['training_receipts'].items()}
    model=seal(model);packet['serving_identity']=model['serving_identity'];packet=seal(packet)
    bucket=Bucket();clock=['2026-10-19T22:00:00Z']
    registry=Registry(bucket,formal_identity=lambda:model['serving_identity'],clock=lambda:clock[0])
    registry.initialize(model);accounts=Accounts(registry,runner=runner)
    with sqlite3.connect(':memory:') as db:
        if full_session:
            from test_paired_native_session import full_cash_state
            db.executescript(full_cash_state(config))
            db.execute('DELETE FROM paper_settlements')
        else:
            for name in ('core/0001_core_baseline.sql','paper/0001_paper_baseline.sql','paper/0004_corporate_action_accounting.sql','paper/0005_l4_distribution.sql'):
                db.executescript((ROOT/'worker/domain-migrations'/name).read_text(encoding='utf-8-sig'))
        db.execute('INSERT OR REPLACE INTO paper_accounts(id,cash,initial_cash) VALUES(1,1000000,1000000),(2,12345,12345)')
        db.executescript("INSERT INTO paper_settlements(account_id,order_id,symbol,side,amount,trade_date,settlement_date) VALUES(1,1,'A','sell',100,'2026-10-16','2026-10-20'),(1,2,'A','sell',200,'2026-10-19','2026-10-21');")
        db.execute('CREATE TABLE IF NOT EXISTS _native_private_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_ms REAL,metadata TEXT)')
        for day in ('2026-10-20','2026-10-21'):
            corporate=dict(schema_version='paper-corporate-source-v1',session_date=day,observed_at=day+'T00:00:00+08:00',
                source_checksum='c'*64,covered_symbols=['A'],actions=[],blockers={},tax_basis='gross_before_personal_tax')
            db.execute('INSERT INTO _native_private_kv VALUES(?,?,NULL,NULL)',('market:corporate_actions:v1:'+day,json.dumps(corporate)))
        raw='\n'.join(db.iterdump())
    sha=hashlib.sha256(raw.encode()).hexdigest()
    head=accounts.initialize(model['entry_id'],state_sql=raw,state_checksum=sha,account_id=1,
        opening_receipt=seal(dict(scope='paper_shadow',state_checksum=sha,source='synthetic_daily_native_fixture')))
    return accounts,model,packet,head,clock


def read_cash(head):
    with sqlite3.connect(':memory:') as db:
        db.executescript(head['state_sql']);return dict(db.execute('SELECT id,cash FROM paper_accounts'))


@pytest.mark.parametrize('p6',[False,True])
def test_daily_native_preparation_and_next_day_preserve_actual_cash_and_settlements(native_runner,p6):
    a,entry,p,head,clock=setup(native_runner,p6);key=entry['entry_id']
    for signal,day,balance in [('2026-10-19','2026-10-20',1000100),('2026-10-20','2026-10-21',1000300)]:
        p=deepcopy(p);p['signal_date']=signal;p['session_date']=day;p['next_open']=day+'T09:00:00+08:00'
        for r in p['seed_rows']:r['date']=signal
        policy=p['l4_allocation_inputs']['alpha_policy']['l4Distribution'];policy['runtime']['signal_date']=signal
        policy['runtime']['account']['signal_date']=signal
        if p6:policy['runtime']['p6_native_pool']['signal_date']=signal
        p['trading_config']['l4Distribution']=policy;p=reseal(p)
        before=read_cash(head)
        receipt=a.prepare_day(key,expected_state_checksum=head['checksum'],packet=p)
        assert a.prepare_day(key,expected_state_checksum=head['checksum'],packet=p)==receipt
        head=a.current(key)[0];assert read_cash(head)==before
        f=frame(day);a.advance(key,action_id=day+':settle',expected_state_checksum=head['checksum'],
            serving_identity=entry['serving_identity'],frames=[f],frame_inputs={f['input_id']:f},variables={})
        head=a.current(key)[0];assert read_cash(head)=={1:balance,2:12345}
        assert receipt['outer_acceptance_credit']==0
        clock[0]='2026-10-21T02:00:00Z'  # second preparation recorded after open, never backdated
    account=a._entry(key)[1];saved,_=a._read(account+'/daily/2026-10-21/'+p['checksum']+'.json')
    assert not saved['recorded_before_open'] and saved['recorded_at']==clock[0]


def test_daily_chain_policy_and_native_score_identity_cannot_be_relabelled(native_runner):
    _,entry,p,_,_=setup(native_runner)
    for mutation in ('model','policy','prediction'):
        bad=deepcopy(p);policy=bad['l4_allocation_inputs']['alpha_policy']['l4Distribution']
        if mutation=='model':policy['artifact']['model_checksum']='f'*64
        elif mutation=='policy':policy['constraints']['max_positions']+=1
        else:policy['runtime']['predictions']['A']['ensemble_v2']['artifact_checksum']='f'*64
        bad['trading_config']['l4Distribution']=policy
        with pytest.raises(ValueError):validate(reseal(bad),entry)


def test_trading_requires_same_day_immutable_input_receipt(native_runner,monkeypatch):
    a,model,p,head,_=setup(native_runner);key=model['entry_id']
    import services.l4_shadow_accounts as module
    calls=[]
    def forbidden(**kwargs):
        calls.append(kwargs)
        raise AssertionError('invalid_input_must_not_reach_native_engine')
    monkeypatch.setattr(module,'run_native_paper_frames',forbidden)
    def run(day):
        f=frame(day,stage='morning')
        return a.advance(key,action_id=day+':morning',expected_state_checksum=head['checksum'],
            serving_identity=model['serving_identity'],frames=[f],frame_inputs={f['input_id']:f},variables={})
    with pytest.raises(ValueError,match='daily_inputs_missing'):run('2026-10-20')
    a.prepare_day(key,expected_state_checksum=head['checksum'],packet=p)
    head=a.current(key)[0]
    with pytest.raises(ValueError,match='daily_frame_date_mismatch'):run('2026-10-21')
    account=a._entry(key)[1]
    path=account+'/daily/'+p['session_date']+'/'+p['checksum']+'.json'
    read=a._read
    monkeypatch.setattr(a,'_read',lambda candidate: (None,None) if candidate==path else read(candidate))
    with pytest.raises(ValueError,match='daily_receipt_mismatch'):run('2026-10-20')
    assert not calls
    monkeypatch.setattr(a,'_read',read)
    a._validate_daily_execution(model,account,head,[frame('2026-10-20',stage='morning')])
