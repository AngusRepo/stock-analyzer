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
