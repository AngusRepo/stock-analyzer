from copy import deepcopy
from pathlib import Path
import sqlite3
import pytest
import polars as pl
from services.research_trial_ledger import observation, append, search_inventory, checksum
from services.research_validation import bundle, bundle_drift, causal_replay_audit, robustness_report
from services.backtest_engine import BacktestDataset


def test_append_only_history_is_idempotent_and_not_complete():
    db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
    db.executescript((Path(__file__).parents[2]/'worker/domain-migrations/research/0002_research_trial_ledger.sql').read_text())
    def query(sql,values):return [dict(row) for row in db.execute(sql,values)]
    def writer(statements):
        with db:
            for sql,values in statements:db.execute(sql,values)
    source={'pointer':'gs://fixture/report#7','sha256':'a'*64}
    record=observation('trial',run_key='run',logical_id='failed-1',source=source,
        content={'state':'fail','parameters':{'x':1},'coverage':'partial'})
    assert append(record,query=query,writer=writer)==append(record,query=query,writer=writer)
    result=search_inventory('run',query=query)
    assert result['known_trial_count']==1 and result['coverage']=='partial'
    for sql in ('DELETE FROM research_trial_observations_v1','UPDATE research_trial_observations_v1 SET logical_id=\'changed\''):
        with pytest.raises(sqlite3.IntegrityError,match='immutable'):db.execute(sql)
    bad=deepcopy(record);bad['payload']['content']['state']='complete'
    with pytest.raises(ValueError,match='checksum'):append(bad,query=query,writer=writer)


def dataset():
    days=[f'2026-01-{i:02}' for i in range(1,13)]
    ds=BacktestDataset(prices=pl.DataFrame({'symbol':['A']*12,'date':days,'close':list(range(10,22)),
        'open':list(range(10,22)),'high':list(range(11,23)),'low':list(range(9,21)),'volume':[10000]*12}),
        indicators=pl.DataFrame({'symbol':['A']*12,'date':days,'atr14':[.2]*12}),
        chips=pl.DataFrame(),market_risk=pl.DataFrame(),
        stocks=pl.DataFrame({'symbol':['A'],'listed_date':['2020-01-01']}),trading_days=days,
        start_date=days[0],end_date=days[-1])
    ds._build_hot_caches();return ds


@pytest.mark.parametrize('leaky,expected',[(False,'PASS'),(True,'FAIL')])
def test_causal_audit_catches_future_peeking_and_rebuilds_caches(leaky,expected):
    ds=dataset();before=ds.prices.clone()
    def replay(*,dataset,params,start_date,end_date,mode,decision_observer):
        for day in dataset.trading_days:
            if day>end_date:break
            price=float(dataset.prices.get_column('close')[-1]) if leaky else float(dataset.get_bar('A',day)['close'])
            decision_observer({'date':day,'candidates':[{'symbol':'A','score':price}],'entries':[],'exits':[]})
    result=causal_replay_audit(dataset=ds,params={},start_date=ds.start_date,end_date=ds.end_date,
        snapshot={'snapshot_id':'fixture','snapshot_checksum':'a'*64},replay_fn=replay)
    assert result['status']==expected and ds.prices.equals(before)
    assert result['upstream_feature_recomputation_verified'] is False


def test_empty_decision_audit_and_live_mode_b_never_pass():
    ds=dataset()
    def empty(**kw):
        for day in kw['dataset'].trading_days:
            kw['decision_observer']({'date':day,'candidates':[],'entries':[],'exits':[]})
    args=dict(dataset=ds,params={},start_date=ds.start_date,end_date=ds.end_date,
        snapshot={'snapshot_id':'fixture','snapshot_checksum':'a'*64})
    assert causal_replay_audit(**args,replay_fn=empty)['status']=='INSUFFICIENT'
    assert causal_replay_audit(**args,mode='B')['status']=='INSUFFICIENT'


def test_plateau_uses_validation_and_not_holdout_or_peak():
    trials=[]
    for i,(x,score) in enumerate([(0,20),(.5,2),(.51,2.1),(.52,2.2),(.53,2.3),(.54,2.4),(.55,2.5)]):
        trials.append({'logical_id':str(i),'content':{'parameters':{'x':x},'validation':{'sharpe':score},
            'holdout':{'sharpe':1000 if i==0 else -3},'cost':{'fee':.004425},
            'validation_window':['2025-01-01','2025-12-31'],'data_snapshot':{'snapshot_id':'same','snapshot_checksum':'a'*64}}})
    result=robustness_report(trials,current_parameters={'x':.53},search_space=[{'name':'x','low':0,'high':1}],radius=.1)
    assert result['recommended_for_review']!='0'
    assert result['holdout_used_for_selection'] is False
    assert result['rows'][0]['neighbor_count']==0
    assert any(row['current_distance']==0 for row in result['rows'])
    changed=deepcopy(trials)
    for row in changed:row['content']['holdout']['sharpe']*=100
    assert robustness_report(changed,current_parameters={'x':.53},search_space=[{'name':'x','low':0,'high':1}],radius=.1)['recommended_for_review']==result['recommended_for_review']


def test_bundle_detects_every_semantic_component_but_not_daily_snapshot_rotation():
    components={key:{'value':key} for key in ('strategy','models','parameters','data_semantics','cost','execution')}
    saved=bundle(candidate_id='candidate',components=components,
        snapshot={'snapshot_id':'old','snapshot_checksum':'a'*64},window=['2025','2026'])
    assert bundle_drift(saved,components)['status']=='PASS'
    for key in components:
        changed=deepcopy(components);changed[key]['value']='changed'
        assert bundle_drift(saved,changed)['fields'][0]['component']==key
    incomplete=bundle(candidate_id='candidate',components={**components,'models':None},snapshot={},window=[])
    assert bundle_drift(incomplete,incomplete['components'])['status']=='INSUFFICIENT'
    corrupt=deepcopy(saved);corrupt['components']['cost']={}
    assert bundle_drift(corrupt,components)['status']=='FAIL'


def test_rehashed_bundle_component_and_completeness_forgery_fail():
    components={key:{'value':key} for key in ('strategy','models','parameters','data_semantics','cost','execution')}
    saved=bundle(candidate_id='candidate',components=components,
        snapshot={'snapshot_id':'old','snapshot_checksum':'a'*64},window=['2025','2026'])
    saved['components']['models']={'value':'forged'}
    saved['bundle_checksum']=checksum({k:v for k,v in saved.items() if k!='bundle_checksum'})
    assert bundle_drift(saved,components)['reason']=='component_checksum_invalid'
    missing=bundle(candidate_id='candidate',components={**components,'models':None},snapshot={},window=[])
    missing['missing']=[]
    missing['bundle_checksum']=checksum({k:v for k,v in missing.items() if k!='bundle_checksum'})
    assert bundle_drift(missing,missing['components'])['reason']=='bundle_completeness_invalid'


def test_real_replay_observer_preserves_results_and_catches_screener_future_peek(monkeypatch):
    from services import backtest_engine as engine
    ds=dataset()
    # Corporate receipts are independently attested; the fixture has no actions.
    monkeypatch.setattr(engine,'_apply_daily_corporate',lambda *args:None)
    def screener(*,dataset,date,**kw):
        price=dataset.get_bar('A',date)['close']
        return [engine.Candidate(symbol='A',date=date,close=price,industry='fixture',
            base_score=price,chip_score=0,tech_score=0,momentum_score=0,combined_score=price,has_buy_signal=1)]
    monkeypatch.setattr(engine,'replay_screener_for_date',screener)
    args=dict(dataset=ds,params={},start_date=ds.start_date,end_date=ds.end_date,mode='A')
    ordinary=engine.replay_period(**args);trace=[]
    observed=engine.replay_period(**args,decision_observer=trace.append)
    assert observed==ordinary and trace[0]['candidates'][0]['symbol']=='A'
    assert any(a['status']=='filled' for row in trace for a in row['entries'])
    assert any(row['positions'] for row in trace)
    audit_args={**args,'snapshot':{'snapshot_id':'fixture','snapshot_checksum':'a'*64}}
    assert causal_replay_audit(**audit_args)['status']=='PASS'
    def leaky(*,dataset,date,**kw):
        row=screener(dataset=dataset,date=date)[0]
        row.combined_score=float(dataset.prices.get_column('close')[-1])
        return [row]
    monkeypatch.setattr(engine,'replay_screener_for_date',leaky)
    assert causal_replay_audit(**audit_args)['status']=='FAIL'


def test_missing_snapshot_or_unsealed_mode_b_context_cannot_recommend_plateau():
    rows=[{'logical_id':str(i),'content':{'parameters':{'x':.5+i/100},
        'validation':{'sharpe':2},'validation_window':['2025-01-01','2025-12-31'],
        'cost':{'fee':.004425},'data_snapshot':None}} for i in range(7)]
    args=dict(current_parameters={'x':.53},search_space=[{'name':'x','low':0,'high':1}])
    assert robustness_report(rows,**args)['recommended_for_review'] is None
    for row in rows:
        row['content']['data_snapshot']={'snapshot_id':'fixed','snapshot_checksum':'a'*64}
        row['content']['gaps']=['mode_b_prediction_inputs_not_sealed']
    assert robustness_report(rows,**args)['status']=='INSUFFICIENT'


def test_future_null_cells_are_not_reported_as_changed():
    from services.research_validation import dataset_variant
    ds=dataset();cutoff='2026-01-04'
    for name in ('prices','indicators'):
        frame=getattr(ds,name)
        columns=[c for c,dtype in frame.schema.items() if dtype.is_numeric()]
        setattr(ds,name,frame.with_columns([pl.when(pl.col('date')>cutoff).then(None)
            .otherwise(pl.col(c)).alias(c) for c in columns]))
    _,changed=dataset_variant(ds,cutoff=cutoff,perturb=True)
    assert changed==0
