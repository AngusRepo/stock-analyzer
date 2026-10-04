from copy import deepcopy
from datetime import date, timedelta
from types import SimpleNamespace
import pytest
from services.ga_backtest_fitness import BacktestFitness, split_dates
from services.ga_optimizer_service import GAOptimizerRequest, run_ga_optimizer, build_ga_candidate


def context(replay):
    split=split_dates([(date(2025,1,1)+timedelta(days=i)).isoformat() for i in range(120)])
    return BacktestFitness(dataset=SimpleNamespace(trading_days=[(date(2025,1,1)+timedelta(days=i)).isoformat() for i in range(120)]), baseline={'fees':{'commission':0.001}},
        split=split, snapshot={'snapshot_id':'s','checksum':'x'}, replay=replay)


def measured_fixture(kw, score=1.):
    start=date.fromisoformat(kw['start_date']);end=date.fromisoformat(kw['end_date'])
    value=100.;curve=[]
    for i in range((end-start).days+1):
        value*=1+score*.0001+(.002 if i%2 else -.002)
        curve.append(((start+timedelta(days=i)).isoformat(),value))
    return SimpleNamespace(sharpe=score,total_trades=100,total_return=value/100-1,
        max_drawdown=.1,initial_capital=100.,final_equity=value,equity_curve=curve)


def test_every_generation_uses_backtest_and_elites_reuse_identical_fitness():
    calls=[]
    def replay(**kw):
        calls.append(kw)
        # Deliberately rewards a different direction from the old parameter prior.
        score=kw['params']['alphaFramework']['riskOverlay']['highVolThreshold']*100
        return measured_fixture(kw,score)
    evaluator=context(replay)
    result=run_ga_optimizer(GAOptimizerRequest(population_size=6,generations=3,seed=7),evaluator=evaluator)
    history=[row['best_score'] for row in result['history']]
    assert history==sorted(history)
    assert 6<=len(calls)<18  # copied elites do not repeat the same expensive replay
    assert result['best']['metrics']['evidence_semantic']=='candidate_specific_training_mode_a_replay'
    assert result['best']['gate']['passed'] is False
    assert all(c['mode']=='A' and c['end_date']==evaluator.split['train_end'] for c in calls)
    assert evaluator.split['train_end']<min(evaluator.split['purge_dates'])<evaluator.split['validation_start']


def test_cached_values_cannot_be_mutated_by_caller():
    evaluator=context(lambda **kw:measured_fixture(kw))
    candidate=build_ga_candidate(None,generation=0,candidate_index=0)
    first=evaluator(candidate);original=first['score'];first['score']=999
    assert evaluator(candidate)['score']==original and evaluator.replays==1


def test_source_errors_stop_search_without_fabricated_penalty():
    def replay(**kw):raise ValueError('backtest_corporate_source_missing:2026-06-16')
    with pytest.raises(ValueError,match='corporate_source_missing'):
        run_ga_optimizer(GAOptimizerRequest(population_size=6,generations=3),evaluator=context(replay))


def test_short_history_does_not_shrink_holdout_or_purge():
    with pytest.raises(ValueError,match='insufficient'):
        split_dates([str(i) for i in range(70)])


def test_infra_blocked_is_not_reported_as_successful_sweep():
    from routers.optuna import _run_optuna_sweep_source_inner
    result=_run_optuna_sweep_source_inner('ga_optimizer',lambda:{'status':'infra_blocked','reason':'missing corporate'})
    assert result['status']=='error'


def test_missing_component_blocks_before_large_snapshot_download(monkeypatch):
    from services import backtest_engine,weekly_evidence_service
    from services.ga_backtest_fitness import prepare_ga_backtest
    monkeypatch.setattr(weekly_evidence_service,'_resolve_snapshot',lambda day, **kwargs:({'snapshot_id':'current'},'2025-01-01',day))
    monkeypatch.setattr(backtest_engine,'_snapshot_component_uris',lambda s:{'prices':'gs://immutable'})
    monkeypatch.setattr(backtest_engine.BacktestDataset,'load_from_snapshot_manifest',lambda **kw:pytest.fail('unnecessary download'))
    with pytest.raises(ValueError,match='corporate_source_component_missing'):
        prepare_ga_backtest(as_of_date='2026-09-24')


def test_paper_held_symbols_are_not_whole_ga_universe_coverage(monkeypatch):
    from services import backtest_engine,weekly_evidence_service
    from services.ga_backtest_fitness import prepare_ga_backtest
    from services.backtest_snapshot_state import COMPONENTS
    days=[(date(2025,1,1)+timedelta(days=i)).isoformat() for i in range(120)]
    snapshot={'snapshot_id':'s','metadata_json':{'component_meta':{'corporate_source_records':{'row_count':120}}}}
    monkeypatch.setattr(weekly_evidence_service,'_resolve_snapshot',lambda day, **kwargs:(snapshot,days[0],days[-1]))
    monkeypatch.setattr(backtest_engine,'_snapshot_component_uris',lambda s:dict.fromkeys(['corporate_source_records',*COMPONENTS],'gs://immutable'))
    dataset=SimpleNamespace(trading_days=days,corporate_sources={d:{'actions':[],'blockers':{},'covered_symbols':['2485']} for d in days},
        get_universe_at=lambda d:{'2485','2330'})
    monkeypatch.setattr('services.ga_backtest_fitness.preflight_corporate_tape',lambda uri, **kwargs:None)
    monkeypatch.setattr(backtest_engine.BacktestDataset,'load_from_snapshot_manifest',lambda **kw:dataset)
    with pytest.raises(ValueError,match='ga_corporate_universe_incomplete:.*2330'):
        prepare_ga_backtest(as_of_date=days[-1])


def test_original_tape_blocks_insufficient_history_before_prices(monkeypatch):
    from services import backtest_engine,backtest_corporate_accounting
    from services.ga_backtest_fitness import preflight_corporate_tape
    calls=[]
    monkeypatch.setattr(backtest_engine,'_read_snapshot_parquet',lambda uri:calls.append(uri) or object())
    monkeypatch.setattr(backtest_corporate_accounting,'load_corporate_tape',lambda _: {'one':{'covered_symbols':[]}})
    with pytest.raises(ValueError,match='history_insufficient:1'):
        preflight_corporate_tape('gs://original-small-tape')
    assert calls==['gs://original-small-tape']


def test_history_preflight_blocks_incomplete_scope_without_changing_stock_universe(monkeypatch):
    from services import backtest_engine,weekly_evidence_service,trading_config_loader,backtest_snapshot_state
    from services.ga_backtest_fitness import prepare_ga_backtest
    days=[(date(2025,1,1)+timedelta(days=i)).isoformat() for i in range(120)]
    snapshot={'snapshot_id':'s','checksum':'unchanged'}
    dataset=SimpleNamespace(trading_days=days,corporate_sources={d:{'actions':[],'blockers':{},'covered_symbols':['2485']} for d in days},
        get_universe_at=lambda d:{'2485','2330'})
    monkeypatch.setattr(weekly_evidence_service,'_resolve_snapshot',lambda *a,**kw:(snapshot,days[0],days[-1]))
    monkeypatch.setattr(backtest_engine,'_snapshot_component_uris',lambda s:dict.fromkeys(
        ['corporate_history_records',*backtest_snapshot_state.COMPONENTS],'gs://immutable'))
    monkeypatch.setattr('services.ga_backtest_fitness.preflight_corporate_tape',lambda *a,**kw:None)
    monkeypatch.setattr(backtest_engine.BacktestDataset,'load_from_snapshot_manifest',lambda **kw:dataset)
    monkeypatch.setattr(backtest_snapshot_state,'frozen_mode_b',lambda ds:None)
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',lambda:SimpleNamespace(config={}))
    monkeypatch.setattr(weekly_evidence_service,'_with_formal_position_risk',lambda cfg:cfg)
    import polars as pl
    dataset.market_risk=pl.DataFrame({'date':days})
    dataset.replay_frames={'signals':pl.DataFrame({'prediction_date':days}),
        'market_breadth':pl.DataFrame({'date':days}),'us_market_signals':pl.DataFrame({'date':days})}
    from services.research_corporate_preflight import CorporateCoverageError
    with pytest.raises(CorporateCoverageError):
        prepare_ga_backtest(as_of_date=days[-1])
    assert dataset.get_universe_at(days[0])=={'2485','2330'}
    assert snapshot['checksum']=='unchanged'


def test_missing_held_evidence_aborts_population_and_preserves_exact_requirement(monkeypatch):
    from services.research_corporate_history import CorporateHistoryGap
    def replay(**kw):
        raise CorporateHistoryGap(session_date='2025-02-03',blockers={'2330':['event_index_coverage_missing']})
    evaluator=context(replay)
    with pytest.raises(CorporateHistoryGap) as caught:
        run_ga_optimizer(GAOptimizerRequest(population_size=6,generations=2),evaluator=evaluator)
    need=caught.value.requirements
    assert need['symbols']==['2330'] and need['session_date']=='2025-02-03'
    assert need['snapshot_id']=='s' and need['candidate_id']
    assert need['skip_candidate_allowed'] is False
    assert need['resolution_policy']=='seal_new_snapshot_and_restart_search'
    assert not evaluator.cache and evaluator.replays==0


def test_route_returns_source_requirement_without_pushing_partial_ranking(monkeypatch):
    from routers import optuna
    from services.research_corporate_history import CorporateHistoryGap
    def replay(**kw):
        raise CorporateHistoryGap(session_date='2025-02-03',blockers={'2330':['event_index_coverage_missing']})
    monkeypatch.setattr('services.ga_backtest_fitness.prepare_ga_backtest',lambda **kw:context(replay))
    monkeypatch.setattr(optuna,'push_optuna_result',lambda **kw:pytest.fail('partial population must not be published'))
    result=optuna.run_ga_optimizer(optuna.GAOptimizerReq(population_size=6,generations=1,push_kv=True,dry_run=False))
    assert result['status']=='infra_blocked' and result['ranked']==[] and result['best'] is None
    assert result['source_requirements']['symbols']==['2330']


def test_second_candidate_gap_does_not_publish_first_candidate_as_winner(monkeypatch):
    from routers import optuna
    from services.research_corporate_history import CorporateHistoryGap
    calls=[]
    def replay(**kw):
        calls.append(kw)
        if len(calls)==2:
            raise CorporateHistoryGap(session_date='2025-02-04',blockers={'8109':['event_index_coverage_missing']})
        return measured_fixture(kw,2.)
    evaluator=context(replay)
    monkeypatch.setattr('services.ga_backtest_fitness.prepare_ga_backtest',lambda **kw:evaluator)
    monkeypatch.setattr(optuna,'push_optuna_result',lambda **kw:pytest.fail('partial population must not be published'))
    result=optuna.run_ga_optimizer(optuna.GAOptimizerReq(population_size=6,generations=1,push_kv=True,dry_run=False))
    assert len(calls)==2 and evaluator.replays==1
    assert result['status']=='infra_blocked' and result['best'] is None and result['ranked']==[]
    assert result['source_requirements']['symbols']==['8109']
    assert result['source_requirements']['completed_fitness_count']==1


def test_holdout_gap_is_infrastructure_block_not_completed_learning(monkeypatch):
    from routers import optuna
    from services.research_corporate_history import CorporateHistoryGap
    evaluator=context(lambda **kw:measured_fixture(kw))
    monkeypatch.setattr('services.ga_backtest_fitness.prepare_ga_backtest',lambda **kw:evaluator)
    def validate(*args,**kwargs):
        raise CorporateHistoryGap(session_date='2025-04-03',blockers={'8109':['event_index_coverage_missing']})
    monkeypatch.setattr('services.ga_candidate_validator.validate_ga_top_candidate',validate)
    result=optuna.run_ga_optimizer(optuna.GAOptimizerReq(population_size=6,generations=1,push_kv=False,dry_run=True))
    assert result['status']=='infra_blocked' and result['learning_state']['status']=='infra_blocked'
    assert result['best']['gate']['passed'] is False
    assert result['source_requirements']['stage']=='validation'


def test_training_ranks_daily_account_nav_not_positive_trade_sharpe():
    def replay(**kw):
        result=measured_fixture(kw,-2.)
        result.sharpe=9.0  # Positive winning-trade statistic cannot hide account loss.
        return result
    measured=context(replay)(build_ga_candidate(None,generation=0,candidate_index=0))
    assert measured['total_return']<0 and measured['score']<0
    assert measured['trade_sharpe_diagnostic']==9.0
    assert measured['objective_metric']=='daily_nav_sharpe_zero_cash_benchmark_252'



def test_cash_sensitivity_replays_locked_pair_without_mutating_config():
    from services.ga_backtest_fitness import cash_rounding_sensitivity
    calls=[]
    def replay(**kw):
        calls.append(kw)
        metric=measured_fixture(kw)
        metric.corporate_rounding_assumptions=[]
        return metric
    baseline={'fees':{'commission':.001}};candidate={'alphaFramework':{'test':1}}
    ds=SimpleNamespace(trading_days=['2026-01-01','2026-01-02'])
    out=cash_rounding_sensitivity(dataset=ds,baseline=baseline,candidate=candidate,
        start_date='2026-01-01',end_date='2026-01-02',replay=replay)
    assert len(calls)==4 and out['advantage_sign_stable']
    assert 'researchAccounting' not in baseline and 'researchAccounting' not in candidate
    assert {c['params']['researchAccounting']['cashRoundingMode'] for c in calls}=={'exact_accrual','minus_one_twd'}


def test_evaluation_start_uses_shared_input_inception_and_keeps_internal_holes():
    import polars as pl
    from services.ga_backtest_fitness import evaluation_days
    ds=SimpleNamespace(trading_days=['2026-01-01','2026-01-02','2026-01-03','2026-01-04'],
        market_risk=pl.DataFrame({'date':['2026-01-01']}), replay_frames={
        'signals':pl.DataFrame({'prediction_date':['2026-01-02','2026-01-04']}),
        'market_breadth':pl.DataFrame({'date':['2026-01-01']}),
        'us_market_signals':pl.DataFrame({'date':['2026-01-01']})})
    assert evaluation_days(ds)==['2026-01-02','2026-01-03','2026-01-04']
