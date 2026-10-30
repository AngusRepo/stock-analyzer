"""Replay uses Paper's market-risk inputs (Wei 10/30).

- No risk-level SL/TP add and no medium scale (Wei 10/30 B): Paper applies neither.
"""
import polars as pl

from services import backtest_engine as engine


# ── no SL/TP add or medium scale ─────────────────────────────────────────────

L2 = {'confidence_risk_mult': .15, 'confidence_perf_mult': .2, 'confidence_delta_clip_lo': -.1,
      'confidence_delta_clip_hi': .2, 'confidence_effective_clip_lo': .45, 'confidence_effective_clip_hi': .75,
      'sltp_add_orange_sl': 5., 'sltp_add_orange_tp': 5., 'medium_risk_scale': .01}


def entry(kv_position_risk, *, conf, risk_level, risk_score=61, accuracy=.55):
    prices = pl.DataFrame([{'symbol': '2330', 'date': d, 'open': 100., 'high': 101., 'low': 99., 'close': 100.,
                            'volume': 10_000_000} for d in ('2026-08-18', '2026-08-19')])
    indicators = pl.DataFrame({'symbol': ['2330'], 'date': ['2026-08-18'], 'atr14': [10.]})
    chips = pl.DataFrame({'symbol': ['2330'], 'date': ['2026-08-18']})
    data = engine.BacktestDataset(prices=prices, indicators=indicators, chips=chips,
                                  market_risk=pl.DataFrame(), stocks=pl.DataFrame({'symbol': ['2330']}),
                                  trading_days=['2026-08-18', '2026-08-19'], start_date='2026-08-18', end_date='2026-08-19')
    candidate = engine.Candidate(symbol='2330', date='2026-08-18', close=100., industry='semi', base_score=1.,
                                 chip_score=1., tech_score=1., momentum_score=1., combined_score=1., has_buy_signal=1)
    account = engine.AccountState(cash=1_000_000., initial_capital=1_000_000.)
    attempts = engine.simulate_entries_for_date(
        dataset=data, decision_date='2026-08-18', entry_date='2026-08-19', candidates=[candidate], account=account,
        pos=engine.PositionSizeParams(), sltp=engine.SLTPParams(), fees=engine.FeeParams(),
        replay_days=['2026-08-18', '2026-08-19'],
        ml_predictions=engine.MLPredictionsCache({('2330', '2026-08-18'): conf}), buy_conf_threshold=.6,
        circuit_cfg={}, current_drawdown_30d=0., recent_accuracy_30d=accuracy, l2_formula_cfg=L2,
        risk_score=risk_score, risk_level=risk_level,
        position_risk_distribution_cfg=kv_position_risk)
    return attempts[0], account


def test_no_risk_level_sltp_add_and_no_medium_scale(kv_position_risk):
    fills = {}
    for level in ('green', 'yellow', 'orange'):
        attempt, account = entry(kv_position_risk, conf=.9, risk_level=level, risk_score=61)
        position = account.positions.get('2330')
        fills[level] = (attempt.status, position.shares, position.initial_stop)
    assert fills['green'] == fills['yellow'] == fills['orange']
    assert fills['green'][1]


def test_the_l2_search_never_tunes_the_retired_dimensions():
    from optuna_scripts.optuna_l2_sensitivity import DEFAULT_SEARCH_SPACE, RETIRED_PATHS
    retired = {f'L2_formula.sltp_add_{lv}_{sd}' for lv in ('orange', 'red', 'black') for sd in ('sl', 'tp')}
    retired.add('L2_formula.medium_risk_scale')
    assert retired <= RETIRED_PATHS
    assert not {dim['path'] for dim in DEFAULT_SEARCH_SPACE} & retired
    assert len(DEFAULT_SEARCH_SPACE) == 20
