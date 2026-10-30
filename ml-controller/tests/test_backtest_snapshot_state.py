from types import SimpleNamespace
from copy import deepcopy
import polars as pl
import pytest
from services.backtest_snapshot_state import frozen_mode_b
from services.backtest_state import compute_rolling_accuracy_30d


def data():
    return SimpleNamespace(stocks=pl.DataFrame({'id':[1],'symbol':['2330']}),
        start_date='2026-09-01',end_date='2026-09-02',trading_days=['2026-09-01','2026-09-02'],market_risk=pl.DataFrame({'date':['2026-09-01'],'risk_level':['green']}),
        replay_frames={'signals':pl.DataFrame({'stock_id':[1,1],'prediction_date':['2026-09-01']*2,
            'generated_at':['2026-09-01T13:00:00Z','2026-09-03T13:00:00Z'],'direction_accuracy':[.6,.9]}),
            'market_breadth':pl.DataFrame({'date':['2026-09-01'],'advance_ratio':[.5]}),
            'us_market_signals':pl.DataFrame({'date':['2026-09-01'],'gspc_return':[.01]}),
            'market_regime_state':pl.DataFrame(schema={c:pl.Utf8 for c in ('run_date','state_json','state_checksum','computed_at','recorded_at')}),
            'verified_predictions':pl.DataFrame({'generated_at':['2026-09-01T13:00:00Z'],
                'verified_at':['2026-09-08T13:00:00Z'],'direction_correct':[1]})})


def test_frozen_inputs_use_original_prediction_and_never_d1(monkeypatch):
    from services import backtest_state
    def forbidden(*a,**kw):raise AssertionError('mutable read')
    for client in (backtest_state.CORE_D1_CLIENT,backtest_state.LEARNING_D1_CLIENT,backtest_state.MARKET_D1_CLIENT):
        monkeypatch.setattr(client,'query',forbidden)
    cache,state,outcomes=frozen_mode_b(data())
    assert cache.get('2330','2026-09-01')==.6
    assert state.get_risk('2026-09-01').risk_level=='green'
    assert compute_rolling_accuracy_30d(outcomes,'2026-09-03',min_samples=1)==.6
    assert compute_rolling_accuracy_30d(outcomes,'2026-09-09',min_samples=1)==1.


@pytest.mark.parametrize('component',['signals','verified_predictions','market_breadth','us_market_signals','market_regime_state'])
def test_missing_component_stops_instead_of_silent_mode_a(component):
    dataset=data();del dataset.replay_frames[component]
    with pytest.raises(ValueError,match='components_missing'):frozen_mode_b(dataset)


def test_missing_known_at_and_after_open_labels_cannot_enter_accuracy():
    rows=[{'generated_at':'2026-09-01T00:00:00Z','direction_correct':1},
          {'generated_at':'2026-09-01T00:00:00Z','verified_at':'2026-09-02T02:00:00Z','direction_correct':1}]
    assert compute_rolling_accuracy_30d(rows,'2026-09-02',min_samples=1)==.6
    assert compute_rolling_accuracy_30d(rows,'2026-09-03',min_samples=1)==1.


def test_replay_entries_read_market_risk_only_through_paper_s_morning_state(monkeypatch, kv_position_risk):
    # Wei 10/30: no adaptive P3 threshold and no raw market-risk input; the only market
    # input is Paper's canonical market risk as of the previous close, written before the
    # open (nothing from the entry day's own close can leak in).
    from services import backtest_engine as engine, backtest_state, position_risk_owner
    dataset=data();dataset.trading_days=['2026-09-01','2026-09-02']
    dataset.market_risk=pl.DataFrame({'date':['2026-08-31',*dataset.trading_days],'risk_level':['green','green','red'],
        'risk_score':[10,10,99],'twii_close':[100.,100.,50.],
        'calculated_at':['2026-08-31T08:00:00Z','2026-09-01T08:00:00Z','2026-09-02T08:00:00Z']})
    dataset.replay_frames['market_breadth']=pl.DataFrame({'date':dataset.trading_days,'bull_alignment_pct':[.7,.1],
        'advance_ratio':[.5,.01],'created_at':['2026-09-01T08:00:00Z','2026-09-02T08:00:00Z']})
    def forbidden(*a,**kw):raise AssertionError('unexpected D1 access')
    for client in (backtest_state.CORE_D1_CLIENT,backtest_state.LEARNING_D1_CLIENT,backtest_state.MARKET_D1_CLIENT):
        monkeypatch.setattr(client,'query',forbidden)
    captured=[]
    monkeypatch.setattr(engine,'replay_screener_for_date',lambda **kw:[object()])
    def entries(**kw):captured.append(kw);return []
    monkeypatch.setattr(engine,'simulate_entries_for_date',entries)
    params={'positionRiskDistribution':kv_position_risk,'portfolioRiskPolicy':position_risk_owner.formal_portfolio_risk({}),
            'circuit':{'maxPositionPct':.08,'drawdownHalt':.15,'drawdownScaleStart':.03,'mddMultFloor':.2,
                       'highVolReducedPosPct':.04,'layer7ScaleRatio':.3}}
    result=engine.replay_period(dataset=dataset,start_date=dataset.start_date,end_date=dataset.end_date,params=params,mode='B')
    assert result.mode=='B'
    assert len(captured)==1
    assert not {'risk_score','risk_level','regime_family','buy_conf_threshold'} & set(captured[0])
    state=captured[0]['paper_risk']
    assert state.market.date=='2026-09-01' and state.market.level=='green' and not state.halt
    assert state.target_exposure==.95 and 'pre_hmm_era_stored_risk_level' in state.approximations
    assert result.paper_risk['sessions']==1 and result.paper_risk['halt_sessions']==0
    assert 'deRisk' in result.paper_risk['not_simulated'] and any('deRisk' in w for w in result.realism_warnings)
    assert 'bull_align_pct' not in captured[0]   # Wei 10/29 Q5: no bull-alignment trigger
    del dataset.replay_frames['signals']
    with pytest.raises(ValueError,match='frozen_components_missing'):
        engine.replay_period(dataset=dataset,start_date=dataset.start_date,end_date=dataset.end_date,params=params,mode='B')


def test_next_trading_open_includes_overnight_and_rejects_open_or_later_rebuild():
    dataset=data()
    dataset.trading_days=['2026-09-04','2026-09-07']
    dataset.replay_frames['signals']=pl.DataFrame({
        'stock_id':[1,1,1,1], 'prediction_date':['2026-09-04']*4,
        'generated_at':['2026-09-04T17:00:00Z','2026-09-07T00:59:59Z',
                        '2026-09-07T01:00:00Z','2026-09-08T00:00:00Z'],
        'direction_accuracy':[.55,.62,.8,.99]})
    cache,_,_=frozen_mode_b(dataset)
    assert cache.get('2330','2026-09-04')==.62


def test_after_open_only_prediction_does_not_make_mode_b_available():
    dataset=data()
    dataset.replay_frames['signals']=pl.DataFrame({'stock_id':[1],
        'prediction_date':['2026-09-01'],'generated_at':['2026-09-02T01:00:00Z'],
        'direction_accuracy':[.99]})
    with pytest.raises(ValueError,match='predictions_empty'):
        frozen_mode_b(dataset)
