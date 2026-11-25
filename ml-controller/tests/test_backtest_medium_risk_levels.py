"""Paper parity: backtest scales entry budget by L2_formula.medium_risk_scale only on medium_risk_levels."""
from __future__ import annotations

from types import SimpleNamespace

from services import backtest_engine as engine
from services import position_risk_owner

RISK = {'position': {'maxPerSector': 3, 'maxSingleNamePct': 0.5,
                     'correlationThreshold': 0.65, 'correlationWindow': 60, 'minCorrelationOverlap': 25}}


def _filled_shares(monkeypatch, l2, risk_level):
    monkeypatch.setattr(engine, '_gap_pct_from_benchmark', lambda *a: 0)
    monkeypatch.setattr(engine, '_get_atr14', lambda *a: 2)
    monkeypatch.setattr(engine, '_formal_position_correlation_skip', lambda **_: None)
    bar = {'open': 100, 'high': 101, 'low': 95, 'close': 100, 'volume': 10_000_000}
    dataset = SimpleNamespace(get_bar=lambda *a: bar)
    account = engine.AccountState(cash=10_000_000, initial_capital=10_000_000)
    candidate = engine.Candidate(symbol='2330', date='2026-08-25', close=100, industry='semi', base_score=80,
                                 chip_score=30, tech_score=30, momentum_score=20, combined_score=80, has_buy_signal=1)
    attempts = engine.simulate_entries_for_date(
        dataset, '2026-08-25', '2026-08-26', [candidate], account,
        engine.PositionSizeParams(min_position_value=1), engine.SLTPParams(), engine.FeeParams(),
        ml_predictions=SimpleNamespace(get=lambda *a: 0.9), buy_conf_threshold=0.5,
        l2_formula_cfg=l2, risk_level=risk_level,
        position_risk_distribution_cfg=position_risk_owner.formal_position_risk(RISK))
    filled = [a for a in attempts if a.status == 'filled']
    assert filled, [a.status for a in attempts]
    return filled[0].shares


def test_default_levels_never_scale_like_paper(monkeypatch):
    base = _filled_shares(monkeypatch, {'medium_risk_scale': 0.5}, 'green')
    assert _filled_shares(monkeypatch, {'medium_risk_scale': 0.5}, 'yellow') == base
    assert _filled_shares(monkeypatch, {'medium_risk_scale': 0.5, 'medium_risk_levels': []}, 'yellow') == base


def test_listed_level_scales_and_others_do_not(monkeypatch):
    l2 = {'medium_risk_scale': 0.5, 'medium_risk_levels': ['yellow']}
    base = _filled_shares(monkeypatch, l2, 'green')
    half = _filled_shares(monkeypatch, l2, 'yellow')
    assert half < base and abs(half - base / 2) <= 1000
    assert _filled_shares(monkeypatch, l2, 'orange') == _filled_shares(monkeypatch, {'medium_risk_scale': 0.5}, 'orange')


def test_invalid_scale_leaves_sizing_unchanged_like_the_worker(monkeypatch):
    base = _filled_shares(monkeypatch, {'medium_risk_scale': 0.5}, 'yellow')
    for bad in (None, float('nan'), '0.5', True):
        l2 = {'medium_risk_scale': bad, 'medium_risk_levels': ['yellow']}
        assert _filled_shares(monkeypatch, l2, 'yellow') == base, bad
