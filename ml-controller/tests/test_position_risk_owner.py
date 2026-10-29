"""K16a: every backtest replay entry takes the single-name cap from trading:risk_config."""
from __future__ import annotations

import asyncio
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from services import backtest_engine as engine
from services import kv_client, position_risk_owner, trading_config_loader
from services.position_risk_owner import PositionRiskConfigUnavailable

RISK = {'position': {'maxPerSector': 3, 'maxSingleNamePct': 0.12,
                     'correlationThreshold': 0.65, 'correlationWindow': 60}}
# Post-P1 trading:config: position.maxPctOfPortfolio is deleted.
POST_P1 = {'position': {'maxPositions': 5}, 'fees': {'commission': 0.001425, 'tax': 0.003}}


def kv(monkeypatch, value):
    reads = []

    def get_json(key, *_, **__):
        reads.append(key)
        return value
    monkeypatch.setattr(kv_client, 'get_json', get_json)
    return reads


def loaded(monkeypatch, config):
    monkeypatch.setattr(trading_config_loader, 'load_merged_trading_config_with_contract',
                        lambda **_: SimpleNamespace(config=config, contract=SimpleNamespace(degraded=False)))


def cap_of(params):
    return engine.PositionSizeParams.from_trading_config(params).max_pct_of_portfolio


# ── helper ────────────────────────────────────────────────────────────────────

def test_helper_reads_the_risk_config_owner(monkeypatch):
    reads = kv(monkeypatch, RISK)
    merged = position_risk_owner.with_formal_position_risk(POST_P1)
    assert reads == ['trading:risk_config']
    assert merged['positionRiskDistribution']['maxSingleNamePct'] == 0.12
    assert merged['positionRiskDistribution']['maxPerSector'] == 3
    assert 'positionRiskDistribution' not in POST_P1
    assert cap_of(merged) == 0.12


@pytest.mark.parametrize('raw', [None, {}, {'position': 'x'},
                                 {'position': {**RISK['position'], 'maxSingleNamePct': None}},
                                 {'position': {k: v for k, v in RISK['position'].items() if k != 'maxSingleNamePct'}},
                                 {'position': {**RISK['position'], 'maxSingleNamePct': 1.5}},
                                 {'position': {**RISK['position'], 'maxSingleNamePct': 'x'}}])
def test_helper_fails_closed_without_a_valid_owner_value(monkeypatch, raw):
    kv(monkeypatch, raw)
    with pytest.raises(PositionRiskConfigUnavailable, match='position_risk_config_'):
        position_risk_owner.with_formal_position_risk(POST_P1)


def test_keep_existing_validates_a_pinned_contract_without_reading_kv(monkeypatch):
    pinned = position_risk_owner.formal_position_risk(RISK)
    reads = kv(monkeypatch, None)
    kept = position_risk_owner.with_formal_position_risk({**POST_P1, 'positionRiskDistribution': pinned},
                                                         keep_existing=True)
    assert reads == [] and kept['positionRiskDistribution'] == pinned
    with pytest.raises(PositionRiskConfigUnavailable, match='position_risk_contract_invalid'):
        position_risk_owner.with_formal_position_risk(
            {**POST_P1, 'positionRiskDistribution': {**pinned, 'maxSingleNamePct': 0}}, keep_existing=True)
    with pytest.raises(PositionRiskConfigUnavailable):
        position_risk_owner.with_formal_position_risk(POST_P1, keep_existing=True)


# ── backtest_engine ───────────────────────────────────────────────────────────

def test_engine_cap_comes_only_from_the_contract():
    formal = position_risk_owner.formal_position_risk(RISK)
    # A leftover v1 value never wins, in either direction.
    for legacy in (0.9, 0.05):
        cfg = {'position': {'maxPctOfPortfolio': legacy}, 'positionRiskDistribution': formal}
        assert cap_of(cfg) == 0.12
    assert cap_of({**POST_P1, 'position_risk_distribution': formal}) == 0.12


@pytest.mark.parametrize('params', [{}, POST_P1, {'position': {'maxPctOfPortfolio': 0.25}}])
def test_replay_fails_closed_without_contract(params):
    with pytest.raises(engine.PositionRiskContractMissing, match='backtest_position_risk_contract_missing'):
        engine.replay_period(SimpleNamespace(trading_days=[]), '2026-01-01', '2026-01-31', params)
    with pytest.raises(engine.PositionRiskContractMissing):
        position_risk_owner.require_position_risk_contract(params)


def test_entry_simulation_refuses_an_unresolved_cap():
    candidate = SimpleNamespace(has_buy_signal=1)
    account = SimpleNamespace(reset_daily=lambda day: None)
    with pytest.raises(engine.PositionRiskContractMissing):
        engine.simulate_entries_for_date(
            dataset=None, decision_date='2026-01-02', entry_date='2026-01-05', candidates=[candidate],
            account=account, pos=engine.PositionSizeParams(), sltp=engine.SLTPParams(), fees=engine.FeeParams())


# ── Optuna entries ────────────────────────────────────────────────────────────

def _route(monkeypatch, module_name, attr, captured):
    from optuna_scripts import optuna_l2_sensitivity, optuna_screener, optuna_sltp
    module = {'optuna_sltp': optuna_sltp, 'optuna_screener': optuna_screener,
              'optuna_l2_sensitivity': optuna_l2_sensitivity}[module_name]
    monkeypatch.setitem(sys.modules, module_name, module)

    def run(**kwargs):
        captured.update(kwargs)
        raise RuntimeError('captured')
    monkeypatch.setattr(module, attr, run)


@pytest.mark.parametrize('route,module_name', [('run_sltp', 'optuna_sltp'), ('run_screener', 'optuna_screener')])
def test_sltp_and_screener_routes_inject_the_owner_cap(monkeypatch, route, module_name):
    from routers import optuna
    loaded(monkeypatch, POST_P1)
    kv(monkeypatch, RISK)
    captured = {}
    _route(monkeypatch, module_name, 'run_search', captured)
    with pytest.raises(HTTPException, match='captured'):
        getattr(optuna, route)(optuna.OptunaReq())
    assert cap_of(captured['baseline_params']) == 0.12


@pytest.mark.parametrize('route,module_name', [('run_sltp', 'optuna_sltp'), ('run_screener', 'optuna_screener')])
def test_sltp_and_screener_routes_fail_closed_before_search(monkeypatch, route, module_name):
    from routers import optuna
    loaded(monkeypatch, POST_P1)
    kv(monkeypatch, None)
    captured = {}
    _route(monkeypatch, module_name, 'run_search', captured)
    with pytest.raises(HTTPException) as caught:
        getattr(optuna, route)(optuna.OptunaReq())
    assert caught.value.status_code == 400 and 'position_risk_config_unavailable' in caught.value.detail
    assert captured == {}


def test_l2_route_injects_the_owner_cap_and_fails_closed(monkeypatch):
    from routers import optuna
    loaded(monkeypatch, POST_P1)
    captured = {}
    _route(monkeypatch, 'optuna_l2_sensitivity', 'run_l2_sensitivity_search', captured)
    kv(monkeypatch, RISK)
    with pytest.raises(RuntimeError, match='captured'):
        optuna.run_l2_sensitivity(optuna.L2SensitivityReq())
    assert cap_of(captured['baseline_config']) == 0.12
    captured.clear()
    kv(monkeypatch, None)
    with pytest.raises(PositionRiskConfigUnavailable):
        optuna.run_l2_sensitivity(optuna.L2SensitivityReq())
    assert captured == {}


@pytest.mark.parametrize('module_name', ['optuna_sltp', 'optuna_screener'])
def test_search_preflight_rejects_a_baseline_without_contract(monkeypatch, module_name):
    from optuna_scripts import optuna_screener, optuna_sltp
    module = {'optuna_sltp': optuna_sltp, 'optuna_screener': optuna_screener}[module_name]
    monkeypatch.setattr(module, 'select_stratified_subset', lambda **_: pytest.fail('must fail before data access'))
    with pytest.raises(engine.PositionRiskContractMissing):
        module.run_search(n_trials=1, start_date='2026-01-01', end_date='2026-03-31', baseline_params=POST_P1)
    with pytest.raises(engine.PositionRiskContractMissing):
        module.run_search(n_trials=1, start_date='2026-01-01', end_date='2026-03-31')


def test_l2_search_preflight_rejects_a_baseline_without_contract(monkeypatch):
    from optuna_scripts import optuna_l2_sensitivity
    monkeypatch.setattr(engine.BacktestDataset, 'load_for_research',
                        lambda **_: pytest.fail('must fail before data access'))
    with pytest.raises(engine.PositionRiskContractMissing):
        optuna_l2_sensitivity.run_l2_sensitivity_search(
            search_space=None, start_date='2026-01-01', end_date='2026-03-31', baseline_config=POST_P1, n_trials=1)


def test_per_regime_search_injects_and_fails_closed_before_data(monkeypatch):
    from optuna_scripts import optuna_per_regime_robust as per_regime
    kv(monkeypatch, None)
    monkeypatch.setattr(per_regime, 'select_stratified_subset', lambda **_: pytest.fail('must fail before data access'))
    with pytest.raises(PositionRiskConfigUnavailable):
        per_regime.run_search(n_trials=1, as_of_date='2026-03-31')

    kv(monkeypatch, RISK)
    captured = {}

    class Stop(Exception):
        pass

    def objective(dataset, start, end, baseline, target):
        captured['baseline'] = baseline
        raise Stop
    monkeypatch.setattr(per_regime, 'select_stratified_subset', lambda **_: ['2330'])
    monkeypatch.setattr(per_regime.BacktestDataset, 'load_for_research', lambda **_: (None, {}))
    monkeypatch.setattr(per_regime, 'create_robust_objective', objective)
    with pytest.raises(Stop):
        per_regime.run_search(n_trials=1, as_of_date='2026-03-31')
    assert cap_of(captured['baseline']) == 0.12


# ── GA / weekly / evidence entries ────────────────────────────────────────────

def test_weekly_evidence_uses_the_shared_owner(monkeypatch):
    from services import weekly_evidence_service
    kv(monkeypatch, RISK)
    assert cap_of(weekly_evidence_service._with_formal_position_risk(POST_P1)) == 0.12
    kv(monkeypatch, None)
    with pytest.raises(PositionRiskConfigUnavailable):
        weekly_evidence_service._with_formal_position_risk(POST_P1)


def test_ga_candidate_validator_injects_when_it_loads_the_baseline(monkeypatch):
    from services import ga_candidate_validator
    loaded(monkeypatch, POST_P1)
    monkeypatch.setattr(ga_candidate_validator, 'load_merged_trading_config_with_contract',
                        lambda: SimpleNamespace(config=POST_P1, contract=SimpleNamespace(to_dict=lambda: {})))
    monkeypatch.setattr(ga_candidate_validator, '_resolve_snapshot', lambda as_of: ({'snapshot_id': 's'}, 'a', 'b'))
    captured = {}

    def evidence(candidate, **kwargs):
        captured.update(kwargs)
        raise RuntimeError('captured')
    result = {'best': {'candidate': {'params': {'alphaFramework': {'x': 1}}}}}
    kv(monkeypatch, RISK)
    with pytest.raises(RuntimeError, match='captured'):
        ga_candidate_validator.validate_ga_top_candidate(result, as_of_date='2026-03-31', evidence_runner=evidence)
    assert cap_of(captured['baseline_config']) == 0.12
    kv(monkeypatch, None)
    with pytest.raises(PositionRiskConfigUnavailable):
        ga_candidate_validator.validate_ga_top_candidate(result, as_of_date='2026-03-31', evidence_runner=evidence)


def test_backtest_replay_route_injects_and_keeps_a_pinned_contract(monkeypatch):
    from routers import backtest
    captured = []

    def replay(**kwargs):
        captured.append(kwargs['params'])
        raise RuntimeError('captured')
    monkeypatch.setattr(backtest, 'replay_period_loading', replay)
    monkeypatch.setattr(backtest, 'taiwan_today', lambda: '2026-01-01')
    req = backtest.ReplayRequest(start_date='2025-12-01', end_date='2026-01-01', params=POST_P1)
    kv(monkeypatch, RISK)
    asyncio.run(backtest.trigger_replay(req))
    assert cap_of(captured[-1]) == 0.12
    pinned = position_risk_owner.formal_position_risk({'position': {**RISK['position'], 'maxSingleNamePct': 0.2}})
    kv(monkeypatch, None)
    asyncio.run(backtest.trigger_replay(backtest.ReplayRequest(
        start_date='2025-12-01', end_date='2026-01-01', params={**POST_P1, 'positionRiskDistribution': pinned})))
    assert cap_of(captured[-1]) == 0.2
    before = len(captured)
    failed = asyncio.run(backtest.trigger_replay(req))
    assert len(captured) == before
    assert failed['status'] == 'error' and 'position_risk_config_unavailable' in failed['error']


def test_config_pool_weekly_eval_replays_both_arms_under_one_owner_read(monkeypatch):
    from routers import config_pool
    reads = kv(monkeypatch, RISK)
    captured = []

    async def worker(path, **_):
        if path == '/api/admin/config':
            return dict(POST_P1)
        if path == '/api/admin/config/challenger?full=1':
            return {'challenger': {'config': dict(POST_P1), 'hash': 'h', 'shadow_since': '2026-01-01T00:00:00Z'}}
        raise AssertionError(path)

    def replay(**kwargs):
        captured.append(kwargs['params'])
        if len(captured) == 2:
            raise RuntimeError('captured')
        return SimpleNamespace()
    monkeypatch.setattr(config_pool, 'fetch_worker_admin', worker)
    monkeypatch.setattr(engine.BacktestDataset, 'load_for_research', lambda **_: (SimpleNamespace(), {}))
    monkeypatch.setattr(engine, 'replay_period', replay)
    with pytest.raises(RuntimeError, match='captured'):
        asyncio.run(config_pool.weekly_eval(config_pool.WeeklyEvalRequest(end_date='2026-03-31'), None, None))
    assert reads == ['trading:risk_config']
    assert [cap_of(p) for p in captured] == [0.12, 0.12]


def test_research_causal_configuration_carries_the_owner_cap(monkeypatch):
    from routers import research_validation

    class Client:
        def __init__(self, *a, **kw):
            pass

        def query(self, *a):
            return [{'candidate_id': 'c', 'sandbox_id': 's', 'source': 'ga'}]

    async def worker(path, **_):
        return {'config': {}} if 'sandbox' in path else dict(POST_P1)
    monkeypatch.setattr(research_validation, 'DomainD1Client', Client)
    monkeypatch.setattr(research_validation, 'worker_fetch', worker)
    kv(monkeypatch, RISK)
    _, configuration = asyncio.run(research_validation.candidate_configuration('c'))
    assert cap_of(configuration) == 0.12
    kv(monkeypatch, None)
    with pytest.raises(PositionRiskConfigUnavailable):
        asyncio.run(research_validation.candidate_configuration('c'))
