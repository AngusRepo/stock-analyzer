"""Replay uses Paper's market-regime inputs once HMM history exists (Wei 10/30).

- The screener's alpha framework gets the pipeline HMM contract (family + surface).
- The P3 adaptive delta uses Paper's inputs and moves the buy THRESHOLD.
- No risk-level SL/TP add and no medium scale (Wei 10/30 B): Paper applies neither.
"""
import hashlib
import json
from types import SimpleNamespace

import polars as pl
import pytest

from services import backtest_engine as engine
from services.backtest_state import RegimeHistory, entry_open
from services.adaptive import compute_adaptive_params

COLUMNS = ('run_date', 'state_json', 'state_checksum', 'computed_at', 'recorded_at')


def obs(run_date, family, computed, recorded=None, *, source='hmm', surface=None):
    label = {'bull': 'bull_market', 'bear': 'bear_market'}.get(family, family)
    state = {'schema_version': 'market-regime-state-v1', 'label': label, 'family': family, 'run_date': run_date,
             'computed_at': computed, 'source': source, 'regime_surface': surface or {label: 1.0}}
    text = json.dumps(state)
    return {'run_date': run_date, 'state_json': text, 'state_checksum': hashlib.sha256(text.encode()).hexdigest(),
            'computed_at': computed, 'recorded_at': recorded or computed}


def frame(rows):
    return pl.DataFrame(rows) if rows else pl.DataFrame(schema={c: pl.Utf8 for c in COLUMNS})


# ── point-in-time selection ──────────────────────────────────────────────────

def test_the_hmm_era_starts_at_the_first_hmm_row_not_a_coded_date():
    history = RegimeHistory([obs('2026-08-14', 'sideways', '2026-08-14T13:00:00Z', source='market_env_fallback'),
                             obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z')])
    assert history.first_hmm_date == '2026-08-18'
    assert RegimeHistory([]).first_hmm_date is None


def test_selection_is_latest_on_or_before_and_ignores_rows_written_after_the_open():
    late = obs('2026-08-18', 'bull', '2026-08-18T14:00:00Z', '2026-08-19T01:00:01Z')   # recorded after 09:00 TW
    history = RegimeHistory([obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z'), late,
                             obs('2026-08-19', 'volatile', '2026-08-19T13:00:00Z')])
    open_0819 = entry_open('2026-08-19')
    assert history.latest_on_or_before('2026-08-18', open_0819)['family'] == 'bear'
    assert history.latest_on_or_before('2026-08-18', entry_open('2026-08-20'))['family'] == 'bull'
    # A later run_date is never visible for an earlier session, and a weekend reads Friday's state.
    assert history.latest_on_or_before('2026-08-19', entry_open('2026-08-20'))['family'] == 'volatile'
    assert history.latest_on_or_before('2026-08-17', entry_open('2026-08-18')) is None


def test_a_non_hmm_latest_state_is_not_used_and_a_bad_checksum_stops_the_replay():
    history = RegimeHistory([obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z'),
                             obs('2026-08-19', 'bull', '2026-08-19T13:00:00Z', source='legacy_meta')])
    assert history.latest_on_or_before('2026-08-19', entry_open('2026-08-20')) is None
    broken = obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z')
    broken['state_checksum'] = '0' * 64
    with pytest.raises(ValueError, match='checksum_mismatch'):
        RegimeHistory([broken])


# ── replay wiring ────────────────────────────────────────────────────────────

DAYS = ['2026-08-14', '2026-08-17', '2026-08-18', '2026-08-19']
SURFACE = {'bear_market': .7, 'sideways': .3}


def dataset(regime_rows):
    return SimpleNamespace(
        stocks=pl.DataFrame({'id': [1], 'symbol': ['2330']}), start_date=DAYS[0], end_date=DAYS[-1], trading_days=DAYS,
        market_risk=pl.DataFrame({'date': DAYS, 'risk_level': ['green', 'yellow', 'orange', 'green'],
                                  'risk_score': [10, 40, 61, 20]}),
        replay_frames={
            'signals': pl.DataFrame({'stock_id': [1] * 4, 'prediction_date': DAYS,
                                     'generated_at': [d + 'T13:00:00Z' for d in DAYS], 'direction_accuracy': [.6] * 4}),
            'market_breadth': pl.DataFrame({'date': DAYS, 'advance_ratio': [.5] * 4}),
            'us_market_signals': pl.DataFrame({'date': DAYS, 'gspc_return': [.0] * 4}),
            'verified_predictions': pl.DataFrame({'generated_at': ['2026-08-01T13:00:00Z'],
                                                  'verified_at': ['2026-08-08T13:00:00Z'], 'direction_correct': [1]}),
            'market_regime_state': frame(regime_rows)})


def run(monkeypatch, kv_position_risk, regime_rows):
    from services import backtest_state
    def forbidden(*a, **kw): raise AssertionError('live D1 read')
    for client in (backtest_state.CORE_D1_CLIENT, backtest_state.LEARNING_D1_CLIENT, backtest_state.MARKET_D1_CLIENT):
        monkeypatch.setattr(client, 'query', forbidden)
    screens, entries = {}, {}
    monkeypatch.setattr(engine, 'replay_screener_for_date', lambda **kw: screens.setdefault(kw['date'], kw) and [object()])
    monkeypatch.setattr(engine, 'simulate_entries_for_date', lambda **kw: entries.setdefault(kw['entry_date'], kw) and [])
    data = dataset(regime_rows)
    engine.replay_period(dataset=data, start_date=data.start_date, end_date=data.end_date,
                         params={'positionRiskDistribution': kv_position_risk}, mode='B')
    return screens, entries


def test_hmm_days_use_the_pipeline_contract_and_earlier_days_keep_the_stored_level(monkeypatch, kv_position_risk):
    rows = [obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z', surface=SURFACE),
            obs('2026-08-18', 'bull', '2026-08-18T14:00:00Z', '2026-08-19T02:00:00Z')]   # after the open
    screens, entries = run(monkeypatch, kv_position_risk, rows)
    assert screens['2026-08-17']['regime_label'] == 'yellow' and screens['2026-08-17']['regime_surface'] is None
    assert screens['2026-08-18']['regime_label'] == 'bear'
    assert screens['2026-08-18']['regime_surface'] == SURFACE
    assert entries['2026-08-18']['regime_family'] is None and entries['2026-08-18']['risk_level'] == 'yellow'
    assert entries['2026-08-19']['regime_family'] == 'bear'
    assert entries['2026-08-19']['risk_level'] == 'orange' and entries['2026-08-19']['risk_score'] == 61


def test_a_range_before_the_hmm_era_is_unchanged(monkeypatch, kv_position_risk):
    screens, entries = run(monkeypatch, kv_position_risk, [])
    assert [screens[d]['regime_label'] for d in DAYS[:3]] == ['green', 'yellow', 'orange']
    assert all(kw['regime_family'] is None for kw in entries.values())


# ── P3 threshold, and no SL/TP add or medium scale ───────────────────────────

L2 = {'confidence_risk_mult': .15, 'confidence_perf_mult': .2, 'confidence_delta_clip_lo': -.1,
      'confidence_delta_clip_hi': .2, 'confidence_effective_clip_lo': .45, 'confidence_effective_clip_hi': .75,
      'sltp_add_orange_sl': 5., 'sltp_add_orange_tp': 5., 'medium_risk_scale': .01}


def entry(kv_position_risk, *, conf, risk_level, risk_score=61, regime_family='bear', accuracy=.55):
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
        risk_score=risk_score, risk_level=risk_level, regime_family=regime_family,
        position_risk_distribution_cfg=kv_position_risk)
    return attempts[0], account


def paper_delta(*, risk_score=61, risk_level='orange', regime='bear', accuracy=.55):
    return compute_adaptive_params(risk_score=risk_score, risk_level=risk_level, accuracy_30d=accuracy, rows_30d=[],
                                   rows_90d=[], losses_5d=0, total_5d=0, L2_formula=L2, regime=regime,
                                   regime_as_of_date='2026-08-18', regime_source='hmm')['confidence_delta']


def test_the_p3_delta_matches_paper_and_raises_the_threshold_instead_of_the_confidence(kv_position_risk):
    delta = paper_delta()
    assert delta > 0
    threshold = min(.75, .6 + delta)
    below, _ = entry(kv_position_risk, conf=threshold - .001, risk_level='orange')
    assert below.status == 'skipped_low_conf' and f'{threshold:.3f}' in below.reason
    above, _ = entry(kv_position_risk, conf=threshold + .001, risk_level='orange')
    assert above.status != 'skipped_low_conf'


def test_the_hmm_family_changes_the_p3_delta_as_it_does_in_paper(kv_position_risk):
    bear, bull = paper_delta(regime='bear', risk_score=20, risk_level='green', accuracy=.7), \
        paper_delta(regime='bull', risk_score=20, risk_level='green', accuracy=.7)
    assert bear > bull
    conf = .6 + (bear + bull) / 2
    assert entry(kv_position_risk, conf=conf, risk_level='green', risk_score=20, regime_family='bear',
                 accuracy=.7)[0].status == 'skipped_low_conf'
    assert entry(kv_position_risk, conf=conf, risk_level='green', risk_score=20, regime_family='bull',
                 accuracy=.7)[0].status != 'skipped_low_conf'


def test_no_risk_level_sltp_add_and_no_medium_scale(kv_position_risk):
    fills = {}
    for level in ('green', 'yellow', 'orange'):
        attempt, account = entry(kv_position_risk, conf=.9, risk_level=level, risk_score=61, regime_family='sideways')
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


# ── data sources ─────────────────────────────────────────────────────────────

def test_live_mode_b_reads_both_hmm_tables_up_to_the_end_date(monkeypatch):
    from services import backtest_state
    seen = []
    def query(sql, params):
        seen.append((sql, params))
        if 'market_regime_state' in sql:
            return [obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z', surface=SURFACE)]
        return []
    for client in (backtest_state.CORE_D1_CLIENT, backtest_state.MARKET_D1_CLIENT):
        monkeypatch.setattr(client, 'query', query)
    state = backtest_state.BacktestMarketState('2026-08-14', '2026-08-19')
    regime_sql, params = next((sql, p) for sql, p in seen if 'market_regime_state' in sql)
    assert 'market_regime_state_revisions_v1' in regime_sql and 'market_regime_state_history_v1' in regime_sql
    assert params == ['2026-08-19', '2026-08-19']
    contract = state.hmm_regime_contract('2026-08-18', '2026-08-19')
    assert contract['alpha_regime'] == 'bear' and contract['regime_surface'] == SURFACE
    assert state.hmm_regime_contract('2026-08-17', '2026-08-18') is None


def test_the_research_snapshot_freezes_every_hmm_observation(monkeypatch):
    from services import backtest_state, dataset_snapshot_exporter as e
    import services.backtest_corporate_export as corporate
    import services.retention_history as retention
    stocks = pl.DataFrame({'id': [1], 'symbol': ['2330'], 'market': ['TWSE']})
    frame = pl.DataFrame({'date': ['2026-08-18'], 'stock_id': [1]})
    signals = pl.DataFrame({'id': [1], 'stock_id': [1], 'generated_at': ['2026-08-18T13:00:00Z'],
                            'prediction_date': ['2026-08-18'], 'trade_signal': ['buy'], 'direction_accuracy': [.6],
                            'entry_price': [1.], 'stop_loss': [1.], 'target1': [1.], 'target2': [1.], 'forecast_data': ['{}']})
    monkeypatch.setattr(e, '_query_active_stocks', lambda *a: stocks)
    monkeypatch.setattr(e, '_query_prices', lambda *a: (frame, 1))
    monkeypatch.setattr(e, '_query_date_range', lambda sql, *a, **k: (signals if 'FROM predictions' in sql else frame, 1))
    for name in ('_query_sentiment_scores', '_query_margin_data', '_query_shareholding'):
        monkeypatch.setattr(e, name, lambda *a: (frame, 1))
    for name in ('_query_market_risk', '_query_monthly_revenue', '_query_canonical_fundamentals'):
        monkeypatch.setattr(e, name, lambda *a: frame)
    monkeypatch.setattr(e, 'MARKET_D1_CLIENT', SimpleNamespace(query=lambda sql, params: []))
    monkeypatch.setattr(e, 'client_for_domain', lambda domain: SimpleNamespace(query=lambda sql, params: []))
    monkeypatch.setattr(corporate, 'export_original_corporate_records', lambda days: pl.DataFrame())
    monkeypatch.setattr(retention, 'archived_predictions', lambda *a, **k: [])
    monkeypatch.setattr(backtest_state, 'load_verified_predictions', lambda *a: [])
    rows = [obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z')]
    asked = []
    monkeypatch.setattr(backtest_state, 'load_regime_observations',
                        lambda end, client=None: asked.append((end, client)) or rows)
    monkeypatch.setattr(e, '_write_compute_snapshot', lambda **kw: kw)
    req = e.DatasetSnapshotExportRequest(business_date='2026-08-19', start_date='2026-08-14', end_date='2026-08-19',
                                         include_signals=True)
    result = e.export_backtest_dataset_snapshot(req)
    assert asked == [('2026-08-19', e.MARKET_D1_CLIENT)]
    assert result['components']['market_regime_state'].to_dicts() == rows
    monkeypatch.setattr(backtest_state, 'load_regime_observations', lambda end, client=None: [])
    empty = e.export_backtest_dataset_snapshot(req)['components']['market_regime_state']
    assert empty.is_empty() and tuple(empty.columns) == COLUMNS
