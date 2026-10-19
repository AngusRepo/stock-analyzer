"""Receipt-to-mature-label tests; synthetic returns, never outer evidence."""
from pathlib import Path
import hashlib,json,sqlite3,sys
from copy import deepcopy
import pytest

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
from services.l4_r17_session import identity,publish,ARMS
from services.l4_distribution import digest as model_digest
from services.l4_r17_acceptance import digest,seal,evaluate
from services.l4_r17_reporting import materialize,label_returns,target_receipts


class Objects:
    def __init__(self):
        self.data={};self.deliveries={};self.available_at='2026-10-20T00:51:00+00:00'
    def put(self,value):
        key=digest(value);self.data[key]=deepcopy(value);return key
    def get(self,key):return deepcopy(self.data[key])
    def lookup_delivery(self,key):return self.deliveries.get(key)
    def publish_delivery(self,key,ref):return self.deliveries.setdefault(key,ref)
    def receipt_clock(self,ref,key):
        assert self.lookup_delivery(key)==ref
        return {'authority':'object_store_server','available_at':self.available_at,
                'objects':[{'generation':'synthetic-test','path':ref}]}


def scenario(weights=None):
    calendar=['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-26']
    forecast={'checksum':'forecast','symbols':['x','y'],'z':[1.,-1.],
              'arms':{n:[.1,-.1] for n in ('raw','linear','empirical_bayes')},
              'incumbent':{'gross':[.1,-.1]},'signal_date':calendar[0]}
    objects=Objects();states={};metrics={}
    for arm,name in zip(ARMS,('raw','linear','empirical_bayes','incumbent')):
        plan={'weights':{'x':.4,'y':.1} if weights is None else weights,
              'r16_evidence':{'forecast_checksum':'forecast','comparison_arm':name},
              'proof':{'within_tolerance':True},'note':'測試：驗證原配置器的 Unicode 雜湊規格'}
        plan['plan_id']=model_digest(plan)
        with sqlite3.connect(':memory:') as db:
            db.executescript('''CREATE TABLE l4_portfolio_plans_v1(account_id,signal_date,plan_id,payload_json,created_at);
            CREATE TABLE l4_portfolio_head_v1(account_id,plan_id);
            CREATE TABLE paper_positions(account_id,symbol,shares,entry_date);''')
            db.execute('INSERT INTO l4_portfolio_plans_v1 VALUES(1,?,?,?,?)',
                       (calendar[0],plan['plan_id'],json.dumps(plan),'2026-10-20 08:48:00'))
            # Later unactivated draft must not replace the active preopen head.
            db.execute('INSERT INTO l4_portfolio_plans_v1 VALUES(1,?,?,?,?)',
                       (calendar[0],'inactive-draft','{}','2026-10-20 08:49:00'))
            db.execute('INSERT INTO l4_portfolio_head_v1 VALUES(1,?)',(plan['plan_id'],))
            db.execute("INSERT INTO paper_positions VALUES(1,'y',2,'2026-10-20')")
            sql='\n'.join(db.iterdump())
        states[arm]={'state_sql':sql,'state_checksum':hashlib.sha256(sql.encode()).hexdigest()}
        metrics[arm]=[{'plan_id':plan['plan_id'],'solve_seconds':.01,'status':'optimal'}]
    reg={'identity':identity('registration','test',calendar[1]),'signal_date':calendar[0],
         'session_date':calendar[1],'activation_checksum':'activation','rules_sha':'rules',
         'weight_timing_sha':'timing','account_id':1,'forecast':forecast,'calendar':calendar,
         'opening_accounts':{a:{'positions':{}} for a in ARMS},
         'schedule':[{'stage':'settlement'},{'stage':'morning'},{'stage':'preopen'}]}
    reg_ref=objects.put(reg)
    for i in range(3):
        key=identity('frame','test',calendar[1],i)
        publish(objects,key,{'identity':key,'captured_at':'2026-10-20T08:50:00+08:00',
                'states':states,'execution_metrics':metrics if i==1 else {}})
    closed={'registration_ref':reg_ref,'activation_checksum':'activation','states':states,
        'accounts':{a:{'positions':{'y':2},'nav':1000} for a in ARMS},
        'source_receipt':{'closing_marks':{'y':100}},
        'fills':{a:[{'shares':2,'price':100,'side':'buy'}] for a in ARMS}}
    prices={(d,s):{'adj_open':100.,'adj_close':110. if s=='x' else 90.,'source_sha256':'price-proof'}
            for d in (calendar[1],calendar[5]) for s in ('x','y')}
    return dict(registration_ref=reg_ref,close_ref=objects.put(closed),objects=objects,
                prices=prices,cutoff='2026-10-27T00:00:00+08:00')


def test_primary_targets_and_actual_positions_are_separate():
    out=materialize(**scenario());a=out['arms']['A']
    assert a['exposure']==.5
    assert a['primary']==pytest.approx(.06)
    assert a['actual_holding_attribution']['primary']==pytest.approx(-.10)
    assert a['actual_holding_attribution']['exposure']==.2
    assert a['target_weights']=={'x':.4,'y':.1}
    assert a['holdings'][0]['symbol']=='y' and a['holdings'][0]['z']==-1.
    assert a['holding_trading_days']==1 and a['traded_notional']==200
    assert out['primary_weight_sample']=='preopen_sealed_targets'
    assert out['D']['pool_equal_weight_return']==pytest.approx(0.)
    result=evaluate([out],rules_sha='rules',weight_timing_sha='timing',activation_checksum='activation')
    assert result['count']==1


def test_excluded_execution_gap_keeps_actual_metrics_but_never_counts_outer_day():
    args=scenario();objects=args['objects'];closed=objects.get(args['close_ref'])
    closed['execution_gaps']=[{'index':30,'stage':'intraday','arms':['B','C','L']}]
    args['close_ref']=objects.put(closed)
    out=materialize(**args)
    assert out['arms']['A']['traded_notional']==200
    assert all(not row['data_complete'] for row in out['arms'].values())
    assert 'native_execution_intervals_missing' in out['exclusion_reasons']
    assert evaluate([out],rules_sha='rules',weight_timing_sha='timing',activation_checksum='activation')['count']==0


def test_solver_failure_stays_in_operational_denominator_after_later_success():
    args=scenario();obj=args['objects'];closed=obj.get(args['close_ref'])
    closed['execution_gaps']=[{'index':1,'stage':'morning',
        'failed_arms':{'C':'l4_portfolio_optimality_not_certified'}}]
    args['close_ref']=obj.put(closed);out=materialize(**args)
    assert out['arms']['C']['preopen_solve_success'] is True
    assert out['arms']['C']['solve_success'] is False
    assert out['arms']['L']['solve_success'] is True
    assert out['arms']['C']['solve_failures'][0]['index']==1
    assert evaluate([out],rules_sha='rules',weight_timing_sha='timing',activation_checksum='activation')['count']==0


def test_late_storage_receipt_cannot_be_backdated_by_frame_clock():
    args=scenario();args['objects'].available_at='2026-10-20T01:00:00+00:00'
    out=materialize(**args)
    assert 'preopen_receipt_published_late' in out['exclusion_reasons']
    assert out['arms']['A']['primary'] is None
    result=evaluate([out],rules_sha='rules',weight_timing_sha='timing',activation_checksum='activation')
    assert result['count']==0


def test_zero_targets_missing_even_when_actual_holdings_exist():
    out=materialize(**scenario({}));a=out['arms']['A']
    assert a['primary'] is None and a['exposure']==0
    assert a['actual_holding_attribution']['primary']==pytest.approx(-.1)


def test_label_maturity_not_inferred_from_existing_future_prices():
    args=scenario();args['cutoff']='2026-10-26T23:59:59+08:00'
    out=materialize(**args)
    assert out['label_status']=='pending' and out['arms']['A']['primary'] is None
    args['cutoff']='2026-10-26T16:00:00+00:00'
    assert materialize(**args)['label_status']=='mature'


def test_missing_pool_label_and_changed_timing_seal_rejected():
    args=scenario();args['prices'].pop(('2026-10-26','x'))
    out=materialize(**args)
    assert out['label_status']=='incomplete' and out['arms']['A']['primary'] is None
    with pytest.raises(ValueError,match='experiment_binding'):
        evaluate([out],rules_sha='rules',weight_timing_sha='different',activation_checksum='activation')


def test_maturity_calendar_can_extend_but_not_change_prior_sessions():
    args=scenario();obj=args['objects'];reg=obj.get(args['registration_ref'])
    complete=reg['calendar'];reg['calendar']=complete[:2]
    newref=obj.put(reg);closed=obj.get(args['close_ref']);closed['registration_ref']=newref
    args.update(registration_ref=newref,close_ref=obj.put(closed))
    assert materialize(**args)['label_status']=='pending'
    assert materialize(**args,calendar=complete)['label_status']=='mature'
    with pytest.raises(ValueError,match='historical_exchange_calendar_changed'):
        materialize(**args,calendar=complete[1:])
