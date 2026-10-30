"""The four Optuna replay searches read research corporate history and preflight it."""
import sys
from pathlib import Path

import pytest

from services import backtest_engine as engine
from services.research_corporate_preflight import CorporateCoverageError
from test_research_corporate_history_mode import DAYS, dataset, history

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'optuna_scripts'))

class Loaded(Exception):
    pass


@pytest.fixture
def capture_load(monkeypatch):
    calls = {}
    def load(**kwargs):
        calls.update(kwargs)
        raise Loaded()
    monkeypatch.setattr(engine.BacktestDataset, 'load_for_research', staticmethod(load))
    import services.position_risk_owner as owner
    monkeypatch.setattr(owner, 'require_position_risk_contract', lambda config: None)
    monkeypatch.setattr(owner, 'with_formal_position_risk', lambda config: config)
    return calls


@pytest.mark.parametrize('module', ['optuna_sltp', 'optuna_screener'])
def test_sltp_and_screener_read_history_window_and_opt_in(module, monkeypatch, capture_load):
    mod = __import__(module)
    kinds = []
    monkeypatch.setattr(mod, 'latest_snapshot_business_end_date',
                        lambda **kw: kinds.append(kw['kind']) or '2026-10-01')
    monkeypatch.setattr(mod, 'select_stratified_subset', lambda **_: ['2330'])
    with pytest.raises(Loaded):
        mod.run_search(n_trials=1, baseline_params={'screener': {'minDailyTurnover': 1}})
    assert kinds == ['ga_research_dataset']
    assert capture_load['corporate_history'] is True and capture_load['end_date'] == '2026-10-01'


def test_per_regime_reads_history_window_and_opts_in(monkeypatch, capture_load):
    import optuna_per_regime_robust as mod
    kinds = []
    monkeypatch.setattr(mod, 'latest_snapshot_business_end_date',
                        lambda **kw: kinds.append(kw['kind']) or '2026-10-01')
    monkeypatch.setattr(mod, 'select_stratified_subset', lambda **_: ['2330'])
    with pytest.raises(Loaded):
        mod.run_search(n_trials=1, as_of_date='2026-10-03')
    assert kinds == ['ga_research_dataset'] and capture_load['corporate_history'] is True


def test_l2_opts_in(capture_load):
    import optuna_l2_sensitivity as mod
    with pytest.raises(Loaded):
        mod.run_l2_sensitivity_search(None, DAYS[0], DAYS[-1], {})
    assert capture_load['corporate_history'] is True and capture_load['mode'] == 'snapshot'


@pytest.mark.parametrize('module,call', [
    ('optuna_l2_sensitivity', lambda mod: mod.run_l2_sensitivity_search(None, DAYS[0], DAYS[-1], {})),
    ('optuna_per_regime_robust', lambda mod: mod.run_search(n_trials=1, as_of_date='2026-10-03')),
])
def test_l2_and_per_regime_stop_on_a_coverage_gap_before_any_trial(module, call, monkeypatch, capture_load):
    mod = __import__(module)
    gap = dataset({DAYS[0]: history(DAYS[0])})  # two sessions missing
    monkeypatch.setattr(engine.BacktestDataset, 'load_for_research',
                        staticmethod(lambda **_: (gap, {'source': 'snapshot'})))
    if module == 'optuna_per_regime_robust':
        monkeypatch.setattr(mod, 'latest_snapshot_business_end_date', lambda **_: DAYS[-1])
        monkeypatch.setattr(mod, 'select_stratified_subset', lambda **_: ['2330'])
    import optuna
    monkeypatch.setattr(optuna, 'create_study', lambda **_: pytest.fail('search started'))
    with pytest.raises(CorporateCoverageError):
        call(mod)


@pytest.mark.parametrize('module', ['optuna_sltp', 'optuna_screener'])
def test_sltp_and_screener_fail_closed_without_a_history_snapshot(module, monkeypatch, capture_load):
    from services.research_data_access import ResearchSnapshotNotReadyError
    mod = __import__(module)
    monkeypatch.setattr(mod, 'latest_snapshot_business_end_date', lambda **_: None)
    monkeypatch.setattr(mod, 'select_stratified_subset', lambda **_: pytest.fail('no data before the window'))
    with pytest.raises(ResearchSnapshotNotReadyError, match='corporate_history_snapshot_missing'):
        mod.run_search(n_trials=1, baseline_params={'screener': {'minDailyTurnover': 1}})


@pytest.mark.parametrize('module', ['optuna_sltp', 'optuna_screener'])
def test_sltp_and_screener_check_the_owner_cap_before_any_lookup(module, monkeypatch):
    mod = __import__(module)
    monkeypatch.setattr(mod, 'latest_snapshot_business_end_date', lambda **_: pytest.fail('lookup before cap'))
    with pytest.raises(engine.PositionRiskContractMissing):
        mod.run_search(n_trials=1, baseline_params={'screener': {'minDailyTurnover': 1}})


def _data_error(*args, **kwargs):
    raise ValueError('backtest_corporate_cash_rounding_missing:2330')


def test_per_regime_trial_never_scores_a_corporate_data_error(monkeypatch):
    import optuna
    import optuna_per_regime_robust as mod
    monkeypatch.setattr(mod, 'replay_period', _data_error)
    objective = mod.create_robust_objective(dataset({d: history(d) for d in DAYS}), DAYS[0], DAYS[-1],
                                            mod._default_sltp_baseline(), 'sltp')
    trial = optuna.trial.FixedTrial({'sl_mult': 2.0, 'tp_mult': 1.5, 'slMultLow': .75,
                                     'tpMultLow': .65, 'slMultHigh': 1.25, 'tpMultHigh': 1.3})
    with pytest.raises(ValueError, match='cash_rounding_missing'):
        objective(trial)


def test_l2_trial_never_scores_a_corporate_data_error(monkeypatch, capture_load):
    import optuna_l2_sensitivity as mod
    ready = dataset({d: history(d) for d in DAYS})
    monkeypatch.setattr(engine.BacktestDataset, 'load_for_research',
                        staticmethod(lambda **_: (ready, {'source': 'snapshot'})))
    monkeypatch.setattr(engine, 'replay_period', _data_error)
    with pytest.raises(ValueError, match='cash_rounding_missing'):
        mod.run_l2_sensitivity_search(None, DAYS[0], DAYS[-1], {}, n_trials=1)
