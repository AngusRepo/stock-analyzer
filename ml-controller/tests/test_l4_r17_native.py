"""Actual native Worker sessions + R17 immutable registration/frame protocol."""
from pathlib import Path
from copy import deepcopy
from datetime import datetime,timezone
import hashlib,json,os,subprocess,sys
import pytest

HERE=Path(__file__).resolve().parent
SOURCE=HERE.parent
sys.path[:0]=[str(SOURCE),str(SOURCE/'tests')]
import test_native_paper_sandbox as native_test
native_test.ROOT=SOURCE.parent
import test_paired_native_session as session_test
session_test.ROOT=SOURCE.parent
from services import l4_r17_session as r17
from services.native_paper_sandbox import native_execution_identity,run_native_paper_frames
from services.paired_nav_journal import digest

class Objects:
    def __init__(self):self.data={};self.deliveries={}
    def put(self,v):
        key=digest(v);self.data[key]=deepcopy(v);return key
    def get(self,key):return deepcopy(self.data[key])
    def lookup_delivery(self,key):return self.deliveries.get(key)
    def publish_delivery(self,key,ref):return self.deliveries.setdefault(key,ref)

from test_native_paper_sandbox import native_runner

@pytest.fixture(scope='module')
def runner(native_runner):return native_runner


def setup(runner):
    from services.paired_native_runtime import KV_READ_POLICY
    config=session_test.native_config();raw=session_test.full_cash_state(config)
    state={'state_sql':raw,'state_checksum':hashlib.sha256(raw.encode()).hexdigest()}
    cfg={'trading_config':config['trading'],'risk_config':config['risk'],'fees':config['trading']['fees'],
         'kv_read_policy':deepcopy(KV_READ_POLICY)}
    activation={'sealed_at':'2026-09-04T00:00:00Z','model_checksum':'model','rules_sha':'rules',
        'weight_timing_sha':'timing','primary_weight_sample':'preopen_sealed_targets',
        'configuration_checksum':digest(cfg),'execution_owner':native_execution_identity(runner),
        'first_session_date':'2026-09-07','engineering_verified':True}
    activation['checksum']=digest(activation)
    forecast={'signal_date':'2026-09-04','captured_at':'2026-09-04T13:00:00Z','model_checksum':'model'}
    forecast['checksum']=digest(forecast)
    return dict(experiment='fixture-not-outer-evidence',signal_date='2026-09-04',session_date='2026-09-07',
        activation=activation,forecast=forecast,states={a:deepcopy(state) for a in r17.ARMS},
        opening_accounts={a:{'cash':99000,'positions':{},'nav':99000} for a in r17.ARMS},
        configuration=cfg,variables={},source_tables={},calendar=['2026-09-04','2026-09-07','2026-09-08'],
        objects=Objects(),runner=runner,account_id=2,now=datetime(2026,9,4,14,tzinfo=timezone.utc))

def test_actual_native_four_whole_sessions_and_replay(runner):
    args=setup(runner);ref=r17.register(**args);reg=args['objects'].get(ref)
    states={};fingerprints=[]
    for arm in r17.ARMS:
        inputs={f['input_id']:f for f in reg['schedule']}
        out=run_native_paper_frames(**reg['states'][arm],frames=reg['schedule'],frame_inputs=inputs,
          account_id=2,variables={},runner=runner,expected_execution_owner_version=reg['execution_owner'])
        assert len(out['frames'])==281 and out['frames'][-1]['result']['valuation']['nav']==99000
        assert out['production_effect'] is False
        fingerprints.append(out['state_checksum']);states[arm]=out
    assert len(set(reg['account_namespaces'].values()))==4
    assert len(set(fingerprints))==1 # equal starting accounts with equal safety inputs
    # Reuse a returned independent state: original T+2 next-day settlement.
    f={'input_id':'next','stage':'settlement','observed_at':'2026-09-08T00:45:00Z'}
    carried=run_native_paper_frames(**{k:states['A'][k] for k in ('state_sql','state_checksum')},
        frames=[f],frame_inputs={'next':f},account_id=2,variables={},runner=runner)
    assert carried['state_checksum']!=states['A']['state_checksum']
    assert states['B']['state_checksum']==fingerprints[1]

def test_registration_rejects_late_or_changed_policy_and_carry_reset(runner):
    args=setup(runner)
    bad={**args,'now':datetime(2026,9,7,1,tzinfo=timezone.utc)}
    with pytest.raises(ValueError,match='too_late'):r17.register(**bad)
    args['configuration']['fees']['tax']=.99
    with pytest.raises(ValueError,match='configuration_changed'):r17.register(**args)

def test_native_frame_retry_and_missing_predecessor(runner):
    args=setup(runner);ref=r17.register(**args);objects=args['objects'];reg=objects.get(ref)
    due=datetime.fromisoformat(reg['schedule'][0]['observed_at'])
    key=r17.collect(registration_ref=ref,index=0,objects=objects,capture_by_arm={a:None for a in r17.ARMS},runner=runner,now=due)
    assert r17.collect(registration_ref=ref,index=0,objects=objects,capture_by_arm={},runner=runner,
        now=datetime(2026,9,8,tzinfo=timezone.utc))==key
    with pytest.raises(ValueError,match='frame_gap'):
        r17.collect(registration_ref=ref,index=2,objects=objects,capture_by_arm={},runner=runner,
            now=datetime.fromisoformat(reg['schedule'][2]['observed_at']))

def test_existing_native_full_session_real_fills_and_cost_reconciliation(runner):
    # Original reference test: generated quotes, real original engine orders,
    # fees/tax/settlement, full-session transcript replay. Not market evidence.
    session_test.test_actual_native_held_position_whole_session_exits_and_reconciles(runner,0,False)

def four_arm_registration_fixture(runner, *, held=False, objects_factory=Objects):
    import sqlite3
    from services.native_paper_state import prepare_native_state
    from services.l4_r17_configuration import arm_trading_config
    from test_l4_r16_allocation import fixture
    config=session_test.native_config()
    registered_configs={}
    for arm in r17.ARMS:
        recs,policy,history,packet=fixture({'A':'raw','B':'linear','C':'empirical_bayes','L':'incumbent'}[arm])
        if held:
            from services.l4_distribution import digest as model_digest
            # Real stock-code grammar for native corporate ownership receipts.
            recs,policy,history,packet=json.loads(json.dumps([recs,policy,history,packet]).replace('"A"','"2330"').replace('"B"','"2331"').replace('"C"','"2332"'))
            obs=packet['observation'];obs['checksum']=model_digest({k:v for k,v in obs.items() if k!='checksum'})
            forecast=packet['forecast'];forecast['pool_checksum']=model_digest(sorted(forecast['symbols']))
            forecast['observation_checksum']=obs['checksum']
            forecast['checksum']=model_digest({k:v for k,v in forecast.items() if k!='checksum'})
        cfg=arm_trading_config(config['trading'],allocation_policy=policy,forecast=packet['forecast'],arm=arm)
        registered_configs[arm]=cfg
        with __import__('sqlite3').connect(':memory:') as db:
            db.executescript(session_test.full_cash_state(config))
            seeds=[]
            for i,row in enumerate(recs,1):
                db.execute('INSERT INTO stocks(id,symbol,name,market) VALUES(?,?,?,?)',(i,row['symbol'],row['symbol'],'TWSE'))
                db.execute('INSERT INTO stock_prices(stock_id,date,close,open,high,low,volume) VALUES(?,?,?,?,?,?,?)',
                    (i,'2026-09-11',100,100,100,100,1000000))
                row.update(stock_id=i,score=50,score_seed_inputs={'chipFlowSeed40':20,'technicalSeed30':15,'screenerMomentumSeed20':10,'mlEdgeSeed30':15})
                seeds.append(dict(stock_id=i,symbol=row['symbol'],name=row['symbol'],date='2026-09-11',rank=i,score=50,reason='fixture',created_at='2026-09-11 13:00:00'))
            l3=policy['runtime']['l3_identity']
            db.execute("INSERT INTO active8_ensemble_pointer_v1(singleton_id,artifact_id,cohort_id,payload_checksum,base_artifact_set_checksum,promotion_reason) VALUES(1,?,?,?,?,'synthetic_fixture')",
                [l3[k] for k in ('artifact_id','cohort_id','payload_checksum','base_artifact_set_checksum')])
            db.execute("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status) VALUES('2026-09-11','pipeline_execution','fixture','success')")
            corporate={'schema_version':'paper-corporate-source-v1','session_date':'2026-09-14','observed_at':'2026-09-14T00:00:00+08:00',
                'source_checksum':'c'*64,'covered_symbols':['2330'] if held else [],'actions':[],'blockers':{},'tax_basis':'gross_before_personal_tax'}
            db.execute('INSERT INTO _native_private_kv VALUES(?,?,NULL,NULL)',('market:corporate_actions:v1:2026-09-14',json.dumps(corporate)))
            db.execute('INSERT INTO _native_private_kv VALUES(?,?,NULL,NULL)',('market:corporate_actions:v1:2026-09-15',
                json.dumps({**corporate,'session_date':'2026-09-15','observed_at':'2026-09-15T00:00:00+08:00'})))
            if held:
                db.execute("INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,entry_price,entry_date,initial_stop,trailing_stop) VALUES(1,'2330','fixture',100,100,100,'2026-09-01',99,99)")
            raw='\n'.join(db.iterdump())
        prepared=prepare_native_state(base_state={'state_sql':raw,'state_checksum':hashlib.sha256(raw.encode()).hexdigest()},
            seed_rows=seeds,recommendations=recs,signal_date='2026-09-11',trading_config=cfg,risk_config=config['risk'],
            l4_allocation_inputs={'recommendations':recs,'alpha_policy':{'l4Distribution':policy},'return_history':history,'r16_shadow':packet},
            allocation_snapshot_id='e'*64)
        frames=r17.session_schedule('2026-09-14',policy=r17.STRATEGY_SESSION_POLICY)[:3]
        out=run_native_paper_frames(**{k:prepared[k] for k in ('state_sql','state_checksum')},
            frames=frames,frame_inputs={f['input_id']:f for f in frames},account_id=1,variables={},runner=runner)
        with sqlite3.connect(':memory:') as db:
            db.executescript(out['state_sql'])
            row=db.execute('SELECT payload_json FROM l4_portfolio_plans_v1').fetchone()
            assert row is not None
            plan=json.loads(row[0])
            assert plan['r16_evidence']['comparison_arm']==packet['arm']
            assert plan['model_checksum']==cfg['l4Distribution']['artifact']['model_checksum']
            assert plan['policy_identity']==cfg['l4Distribution']['opb']['approved_policy_identity']
        assert out['execution_metrics'][0]['solve_seconds']>=0
    # Exercise daily registration through the real serializer, not only a
    # hand-prepared state. Forecast timing is test-only historical evidence.
    from services.l4_r17_registration import register_signal
    from services.l4_distribution import digest as model_digest
    from services.paired_native_runtime import KV_READ_POLICY
    packet['forecast'].pop('checksum')
    packet['forecast']['captured_at']='2026-09-11T13:00:00Z'
    packet['forecast']['checksum']=model_digest(packet['forecast'])
    configuration={'trading_config':config['trading'],'risk_config':config['risk'],
        'arm_trading_configs':registered_configs,'fees':config['trading']['fees'],
        'commission_contract':__import__('services.native_paper_sandbox',fromlist=['native_runtime_manifest']).native_runtime_manifest(runner)['commission_contract'],
        'kv_read_policy':deepcopy(KV_READ_POLICY)}
    # Account 1 also has an original pending 900 settlement. Ledger cash uses
    # economic cash, as does the native valuation owner.
    bootstrap={'state':{'state_sql':raw,'state_checksum':hashlib.sha256(raw.encode()).hexdigest()},
               'account':{'cash':1000899,'positions':{'2330':100} if held else {},
                          'nav':1010899 if held else 1000899}}
    activation={'sealed_at':'2026-09-11T00:00:00Z','model_checksum':packet['forecast']['model_checksum'],
        'rules_sha':'rules','weight_timing_sha':'timing','primary_weight_sample':'preopen_sealed_targets',
        'configuration_checksum':digest(configuration),'bootstrap_checksum':digest(bootstrap),
        'execution_owner':native_execution_identity(runner),'first_session_date':'2026-09-14',
        'engineering_verified':True}
    activation['checksum']=digest(activation)
    objects=objects_factory()
    args=dict(experiment='registered-four-arm-fixture',activation=activation,forecast=packet['forecast'],
        observation=packet['observation'],allocation_inputs={'recommendations':recs,
          'alpha_policy':{'l4Distribution':policy},'return_history':history},seed_rows=seeds,
        stock_rows=None,configuration=configuration,calendar=['2026-09-11','2026-09-14'],
        variables={'SHIOAJI_PROXY_URL':'https://broker.fixture'},source_tables={},objects=objects,runner=runner,
        model_predictions=policy['runtime']['predictions'],bootstrap=bootstrap,
        now=datetime(2026,9,11,14,tzinfo=timezone.utc))
    registered=register_signal(**args)
    return args,registered,config


def test_actual_worker_four_arm_allocation_and_preopen_identity(runner):
    from services.l4_r17_registration import register_signal
    args,registered,_=four_arm_registration_fixture(runner)
    objects=args['objects']
    assert register_signal(**args)==registered
    assert len(set(objects.get(registered)['account_namespaces'].values()))==4
    bad=deepcopy(args['allocation_inputs']);bad['recommendations'][0]['symbol']='outside-sealed-slate'
    with pytest.raises(ValueError,match='outside_sealed_screener'):
        register_signal(**{**args,'objects':Objects(),'allocation_inputs':bad})


@pytest.mark.parametrize('mode',['normal','missing_and_solver_failure'])
def test_allocated_four_held_accounts_full_native_session_and_carry(runner,mode,monkeypatch):
    """Combined path; synthetic market inputs, ORIGINAL allocation/fills/replay.

    This is engineering evidence only and grants zero outer sample days.
    """
    from services.l4_r17_state_storage import ReferencedStates
    class ReferencedObjects(ReferencedStates,Objects):pass
    args,registered,config=four_arm_registration_fixture(runner,held=True,objects_factory=ReferencedObjects)
    objects=args['objects'];reg=objects.get(registered)
    omit=mode!='normal'
    original_run=r17.run_native_paper_frames
    attempts=[]
    def fail_one_c_attempt(**kwargs):
        frames=kwargs['frames']
        # Fault injection tests rollback/continuation only, not model quality.
        # Real native allocation and all later fills/replay remain unchanged.
        if omit and len(frames)==1 and frames[0]['stage']=='morning':
            attempts.append(True)
            if len(attempts)==3:
                raise RuntimeError('native_paper_private_ValueError:l4_portfolio_optimality_not_certified')
        return original_run(**kwargs)
    monkeypatch.setattr(r17,'run_native_paper_frames',fail_one_c_attempt)
    class Sources:
        def read(self,operation,request,frame):
            if operation=='source_kv':
                return {'request':request,'response':None,'captured_at':frame['observed_at']}
            assert operation=='frozen_fetch',(operation,request)
            url=request['url'];assert url.startswith('https://broker.fixture/'),url
            quote={'status':'ok','last':98,'bid':98,'ask':98.1,'bid_volume':1000,'ask_volume':1000,
                'reference_price':100,'source_time':frame['observed_at'],'confirmed_at':frame['observed_at'],
                'quote_age_ms':0,'source_age_ms':0,'low':98,'high':100,'open':100,
                'total_volume':100000,'session_epoch':1}
            if 'odd_lot' in url or (request.get('body') and json.loads(request['body']).get('lot_type')=='odd_lot'):
                quote['lot_type']='odd_lot'
            plural=any(x in url for x in ('/orderbooks','/quotes','/snapshots'))
            body={'data':{s:quote for s in ('2330','2331','2332')} if plural else quote}
            return {'request':request,'captured_at':frame['observed_at'],
                'response':{'body':json.dumps(body),'status':200,'headers':{}}}
    for i,frame in enumerate(reg['schedule']):
        if omit and i in (2,30):
            from datetime import timedelta
            assert frame['stage']==('preopen' if i==2 else 'intraday')
            from services.native_paper_time import frame_capture_deadline
            r17.record_unobserved_interval(registration_ref=registered,index=i,objects=objects,
                now=frame_capture_deadline(frame)+timedelta(seconds=1))
            continue
        r17.collect(registration_ref=registered,index=i,objects=objects,
            capture_by_arm={a:Sources() for a in r17.ARMS},runner=runner,
            now=datetime.fromisoformat(frame['observed_at']))
    source={'complete':True,'session_date':reg['session_date'],'schedule_checksum':digest(reg['schedule']),
        'corporate_actions_complete':True,'corporate_actions':[],'closing_marks':{}}
    ref=r17.close(registration_ref=registered,objects=objects,runner=runner,source_receipt=source,
                  now=datetime(2026,9,14,7,tzinfo=timezone.utc))
    closed=objects.get(ref)
    assert closed['outer_credit']==0 and closed['production_effect'] is False
    assert bool(closed['execution_gaps'])==omit
    if omit:
        assert closed['status']=='native_continuity_verified_excluded'
        assert any(g['failed_arms']=={'C':'l4_portfolio_optimality_not_certified'} for g in closed['execution_gaps'])
        assert any(g['unobserved_arms']==list(r17.ARMS) for g in closed['execution_gaps'])
    for arm in r17.ARMS:
        fills=closed['fills'][arm]
        assert sum(f['shares'] for f in fills if f['side']=='sell' and f['symbol']=='2330')==100
        assert all(f['commission']>0 and f['tax']>0 for f in fills)
        assert closed['accounts'][arm]['positions']=={}
        assert closed['accounts'][arm]['cash']<1000899+9800
    # Each account keeps its own original settlement state the next session.
    frame={'input_id':'next','stage':'settlement','observed_at':'2026-09-15T00:45:00Z'}
    for arm in r17.ARMS:
        carried=run_native_paper_frames(**closed['states'][arm],frames=[frame],
            frame_inputs={'next':frame},account_id=1,variables={},runner=runner)
        assert carried['production_effect'] is False
        assert carried['state_checksum']!=closed['states'][arm]['state_checksum']

def test_r17_full_collector_close_and_next_session_carry(runner):
    args=setup(runner);ref=r17.register(**args);objects=args['objects'];reg=objects.get(ref)
    class EmptySources:
        def read(self,operation,request,frame):
            assert operation=='source_kv',(operation,request)
            return {'request':request,'response':None,'captured_at':frame['observed_at']}
    for i,frame in enumerate(reg['schedule']):
        r17.collect(registration_ref=ref,index=i,objects=objects,
            capture_by_arm={a:EmptySources() for a in r17.ARMS},runner=runner,
            now=datetime.fromisoformat(frame['observed_at']))
    source={'complete':True,'session_date':reg['session_date'],'schedule_checksum':digest(reg['schedule']),
        'corporate_actions_complete':True,'corporate_actions':[],'closing_marks':{}}
    closed=r17.close(registration_ref=ref,objects=objects,runner=runner,source_receipt=source,
        now=datetime(2026,9,7,7,tzinfo=timezone.utc))
    journal=objects.get(closed)
    assert set(journal['accounts'])==set(r17.ARMS) and journal['outer_credit']==0
    assert all(a['nav']==99000 for a in journal['accounts'].values())
    next_forecast={'signal_date':'2026-09-07','captured_at':'2026-09-07T13:00:00Z','model_checksum':'model'}
    next_forecast['checksum']=digest(next_forecast)
    next_args={**args,'signal_date':'2026-09-07','session_date':'2026-09-08','forecast':next_forecast,
        'states':journal['states'],'opening_accounts':journal['accounts'],'previous':'2026-09-07',
        'now':datetime(2026,9,7,14,tzinfo=timezone.utc)}
    continued=r17.register(**next_args)
    assert objects.get(continued)['predecessor']==closed
    bad=deepcopy(journal['accounts']);bad['A']['cash']+=1
    with pytest.raises(ValueError,match='account_reset'):
        r17.register(**{**next_args,'opening_accounts':bad})
