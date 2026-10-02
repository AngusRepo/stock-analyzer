from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
import pytest
from services.l4_distribution import digest
from services.rfs_sparse_comparison import build_comparison, adjusted_basket_outcome, seal
from services.rfs_comparison_store import persist, refresh_outcomes, observe_published_plan
from services.rfs_liquidity import with_liquidity


@pytest.fixture
def inputs():
    symbols=['A','B','X','Z']
    account={'nav':1_000_000.,'available_cash':850_000.,'fees':{'buy_cost':.00035625,'sell_cost':.00335625}}
    plan={'owner':'l4_distribution','execution_scope':'paper','account_id':1,'signal_date':'2026-09-01',
        'account_checksum':digest(account),'policy_identity':'p','model_checksum':'m','forbidden_buys':['Z'],
        'targets':{s:{'current_weight':{'X':.1,'Z':.05}.get(s,0.),'expected_return_gross':{'A':.06,'B':.04,'X':.02,'Z':.01}[s],'locked':s=='X'} for s in symbols},
        'weights':{'A':.2,'B':.1,'X':.1,'Z':0.},
        'constraints':{'exposure_cap':.45,'name_cap':.2,'min_weight':.03,'max_positions':3,'name_caps':{},'exposure_groups':{'sector':{'symbols':['A','B'],'cap':.3}}},
        'utility_parameters':{'alpha_strength':1.,'risk_aversion':2.,'turnover_penalty':0.,'l2_penalty':0.},
        'risk_evidence':{'covariance_horizon_sessions':5,'turnover_pressure_by_symbol':dict.fromkeys(symbols,0.)}}
    plan['plan_id']=digest(plan)
    rows=[{'symbol':s,'avg_daily_turnover_twd':1e8} for s in symbols]
    history={s:[.01*(-1)**i+(j*.001) for i in range(30)] for j,s in enumerate(symbols)}
    return plan,rows,history,account


def test_full_pool_constraints_and_immutable_formal_inputs(inputs):
    before=deepcopy(inputs); packet=build_comparison(*inputs)
    assert inputs==before and packet['status']=='collecting'
    w=packet['weights']
    assert w['X']==.1 and w.get('Z',0)<=.05+1e-8
    assert len(w)<=3 and sum(w.values())<=.45+1e-8
    assert w.get('A',0)+w.get('B',0)<=.3+1e-8
    assert packet['candidate_symbols']==['A','B','X','Z']
    assert packet['constraint_proof']['within_tolerance'] is True
    assert packet['production_effect'] is packet['promotion_eligible'] is False
    assert all(.03-1e-8<=v<=.2+1e-8 for v in w.values())


@pytest.mark.parametrize('mutation',['plan','account'])
def test_mismatched_source_rejected(inputs,mutation):
    if mutation=='plan':inputs[0]['weights']['A']=.19
    else:inputs[3]['available_cash']=1.
    with pytest.raises(ValueError,match='identity_invalid'):build_comparison(*inputs)


def test_missing_adv_never_silently_drops_a_stock(inputs):
    inputs[1][0].pop('avg_daily_turnover_twd')
    packet=build_comparison(*inputs)
    assert packet['status']=='blocked' and packet['excluded_missing_adv_symbols']==['A']
    assert packet['weights']=={} and packet['source_expected_return_candidate_count']==4


def test_pair_outcome_same_dates_costs_missing_prices_block(inputs):
    packet=build_comparison(*inputs)
    sessions=[f'2026-09-{i:02}' for i in range(1,22)]
    bars={(s,d):100+i for i,d in enumerate(sessions) for s in ['A','B','X','Z']}
    result=adjusted_basket_outcome(packet,bars,sessions,5)
    assert result['entry_date']==sessions[0] and result['exit_date']==sessions[5]
    gross=.05*sum(packet['incumbent_weights'].values())
    expected=gross-packet['incumbent_metrics']['linear_rebalance_cost']-packet['incumbent_metrics']['impact_cost']-.00335625*1.05*sum(packet['incumbent_weights'].values())
    assert result['incumbent_net']==pytest.approx(expected)
    del bars[('X',sessions[5])]
    assert adjusted_basket_outcome(packet,bars,sessions,5) is None
    assert adjusted_basket_outcome(packet,bars,sessions[:20],20) is None


class Database:
    def __init__(self):
        self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row
        self.db.executescript((Path(__file__).parents[2]/'worker/domain-migrations/learning/0060_rfs_sparse_comparison.sql').read_text())
    def query(self,sql,params):return [dict(r) for r in self.db.execute(sql,params)]
    def batch_execute(self,statements):
        for sql,params in statements:self.db.execute(sql,params)
        return {'success_count':len(statements),'error_count':0}


def test_immutable_receipt_retry_and_conflict(inputs):
    db=Database();p=build_comparison(*inputs)
    persist(p,'snapshot',learning=db,observed_at='2026-09-01T00:00:00+00:00')
    persist(p,'snapshot',learning=db,observed_at='2026-09-02T00:00:00+00:00')
    assert len(db.query('SELECT * FROM rfs_sparse_comparisons_v1',[]))==1
    changed=deepcopy(p);changed.pop('packet_checksum');changed['weights']['A']=.1
    with pytest.raises(ValueError,match='immutable_receipt_conflict'):
        persist(seal(changed),'snapshot',learning=db,observed_at='2026-09-02T00:00:00+00:00')


def test_labels_start_after_capture_and_retries_do_not_duplicate(inputs):
    db=Database();p=build_comparison(*inputs)
    persist(p,'snapshot',learning=db,observed_at='2026-09-01T06:00:00+00:00') # after TW close
    seen=[]
    days=[f'2026-09-{i:02}' for i in range(2,8)]
    class Market:
        def query(self,sql,params):
            seen.append((sql,params))
            if 'GROUP BY' in sql:return [{'date':d} for d in days]
            return [{'stock_id':s,'date':d,'adj_close':100+i} for s in ['A','B','X','Z'] for i,d in enumerate(days)]
    now=datetime(2026,9,8,1,tzinfo=timezone.utc)
    refresh_outcomes(learning=db,market=Market(),now=now)
    assert seen[0][1]==['2026-09-02','2026-09-07']
    refresh_outcomes(learning=db,market=Market(),now=now)
    result=db.query('SELECT * FROM rfs_sparse_outcomes_v1',[])
    assert len(result)==1 and result[0]['horizon']==5


def test_turnover_observed_window_records_missing_and_requires_current():
    dates=[f'2026-08-{i:02}' for i in range(1,26)]
    class Market:
        def query(self,sql,params):
            if 'GROUP BY' in sql:return [{'date':d} for d in dates[::-1]]
            return [{'stock_id':s,'date':d,'value':float(i+1),'source':'finlab.price'} for s in ['A','B'] for i,d in enumerate(dates) if d!='2026-08-10' and not(s=='B' and d==dates[-1])]
    rows,evidence=with_liquidity([{'symbol':'A'},{'symbol':'B'}],['A','B'],dates[-1],Market())
    assert rows[0]['avg_daily_turnover_twd']>0 and rows[1]['avg_daily_turnover_twd'] is None
    assert evidence['by_symbol']['A']['missing_recent_dates']==['2026-08-10']
    assert len(evidence['by_symbol']['A']['observed'])==20


def test_frozen_capture_mismatch_is_blocked_receipt_not_valid_sample(inputs,monkeypatch):
    from services import paired_nav_journal
    plan=inputs[0]; db=Database()
    class Paper:
        def query(self,*args):return [{'allocation_snapshot_id':'snapshot','payload_json':json.dumps(plan)}]
    monkeypatch.setattr(paired_nav_journal,'read_context_projection',lambda *a:{'payload':{'content':{'inputs':{},'capture':{'portfolio_plan':{'plan_id':'other'}}}}})
    observe_published_plan(plan,'snapshot',learning=db,paper=Paper(),market=object())
    saved=db.query('SELECT payload_json,status FROM rfs_sparse_comparisons_v1',[])[0]
    assert saved['status']=='blocked'
    assert json.loads(saved['payload_json'])['validation_blockers']==['rfs_frozen_capture_plan_mismatch']


def test_observer_failure_isolated_and_provider_details_redacted(monkeypatch):
    from services import rfs_comparison_store as store
    def failing(*args):raise RuntimeError('https://private.invalid/?secret=value')
    monkeypatch.setattr(store,'observe_published_plan',failing)
    result=store.observe_safely({},'snapshot')
    assert result=={'status':'failed','reason':'rfs_comparison_source_unavailable','production_effect':False}


def test_formal_rebalance_cost_must_match_shared_account_fees(inputs):
    inputs[0]['expected_trading_cost']=.5
    inputs[0]['plan_id']=digest({k:v for k,v in inputs[0].items() if k!='plan_id'})
    with pytest.raises(ValueError,match='formal_cost_mismatch'):
        build_comparison(*inputs)
