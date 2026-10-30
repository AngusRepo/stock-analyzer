"""Replay uses Paper's market-regime inputs once an HMM row was visible before an open (Wei 10/30).

- The screener's alpha framework gets the pipeline HMM contract (family + surface).
- The P3 adaptive delta uses Paper's inputs and moves the buy THRESHOLD.
- No risk-level SL/TP add and no medium scale (Wei 10/30 B): Paper applies neither.
"""
import hashlib
import json
from datetime import datetime, timezone
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

def test_the_hmm_era_starts_when_an_hmm_row_was_visible_not_at_its_run_date():
    backfilled = obs('2026-08-14', 'bear', '2026-08-14T13:00:00Z', '2026-08-27T02:19:00Z')
    history = RegimeHistory([obs('2026-08-13', 'sideways', '2026-08-13T13:00:00Z', source='market_env_fallback'),
                             backfilled, obs('2026-08-24', 'bull', '2026-08-24T13:30:00Z')])
    assert not history.hmm_visible('2026-08-13', entry_open('2026-08-14'))      # fallback rows never count
    assert not history.hmm_visible('2026-08-21', entry_open('2026-08-24'))      # the 08-14 row came later
    assert history.hmm_visible('2026-08-24', entry_open('2026-08-25'))
    assert history.hmm_visible('2026-08-26', entry_open('2026-08-27')) is True
    assert not RegimeHistory([]).hmm_visible('2026-08-24', entry_open('2026-08-25'))
    assert not history.hmm_visible('2026-08-13', entry_open('2026-08-30'))      # later run_dates never count


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


def test_ties_break_like_the_worker_query():
    a = obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z', '2026-08-18T13:05:00Z')
    later_computed = obs('2026-08-18', 'bull', '2026-08-18T13:01:00Z', '2026-08-18T13:01:00Z')
    later_recorded = obs('2026-08-18', 'volatile', '2026-08-18T13:00:00Z', '2026-08-18T13:06:00Z')
    open_ = entry_open('2026-08-19')
    assert RegimeHistory([a, later_computed]).latest_on_or_before('2026-08-18', open_)['family'] == 'bull'
    assert RegimeHistory([a, later_recorded]).latest_on_or_before('2026-08-18', open_)['family'] == 'volatile'
    twin = obs('2026-08-18', 'sideways', '2026-08-18T13:00:00Z', '2026-08-18T13:05:00Z')
    winner = max((a, twin), key=lambda row: row['state_checksum'])
    assert RegimeHistory([a, twin]).latest_on_or_before('2026-08-18', open_)['family'] == \
        json.loads(winner['state_json'])['family']


def edited(row, **changes):
    state = {**json.loads(row['state_json']), **changes}
    text = json.dumps(state)
    return {**row, 'state_json': text, 'state_checksum': hashlib.sha256(text.encode()).hexdigest()}


@pytest.mark.parametrize('changes', [{'run_date': '2026-08-19'}, {'run_date': None}, {'computed_at': '2026-08-19T02:00:00Z'},
                                     {'schema_version': 'v0'}, {'label': 'calm'}])
def test_a_payload_the_worker_rejects_stops_the_replay(changes):
    history = RegimeHistory([edited(obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z'), **changes)])
    with pytest.raises(ValueError, match='payload_invalid'):
        history.latest_on_or_before('2026-08-18', entry_open('2026-08-19'))


def test_a_payload_run_date_up_to_the_session_is_accepted_like_the_worker_latest_before_read():
    history = RegimeHistory([edited(obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z'), run_date='2026-08-17')])
    assert history.latest_on_or_before('2026-08-18', entry_open('2026-08-19'))['family'] == 'bear'


def test_a_state_that_is_not_an_object_stops_the_replay():
    text = '[]'
    row = {**obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z'), 'state_json': text,
           'state_checksum': hashlib.sha256(text.encode()).hexdigest()}
    with pytest.raises(ValueError, match='payload_invalid'):
        RegimeHistory([row])


def test_visibility_needs_both_instants_by_the_open_inclusive():
    open_0819 = entry_open('2026-08-19')
    assert open_0819 == datetime(2026, 8, 19, 1, tzinfo=timezone.utc)                # 09:00 TW
    computed_late = obs('2026-08-18', 'bear', '2026-08-19T01:00:01Z', '2026-08-19T00:30:00Z')
    history = RegimeHistory([computed_late])
    assert not history.hmm_visible('2026-08-18', open_0819)
    assert history.latest_on_or_before('2026-08-18', open_0819) is None
    at_open = RegimeHistory([obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z', '2026-08-19T01:00:00Z')])
    assert at_open.hmm_visible('2026-08-18', open_0819)
    assert at_open.latest_on_or_before('2026-08-18', open_0819)['family'] == 'bear'


def test_a_naive_persisted_at_is_read_as_utc():
    # The Worker compares with julianday(), which reads a zoneless timestamp as UTC.
    open_0819 = entry_open('2026-08-19')
    after = RegimeHistory([obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z', '2026-08-19 01:00:01')])
    before = RegimeHistory([obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z', '2026-08-19 00:59:59')])
    assert not after.hmm_visible('2026-08-18', open_0819)
    assert before.hmm_visible('2026-08-18', open_0819)


@pytest.mark.parametrize('column', COLUMNS)
def test_an_incomplete_row_stops_the_replay(column):
    with pytest.raises(ValueError, match='row_invalid'):
        RegimeHistory([{**obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z'), column: None}])


# ── replay wiring ────────────────────────────────────────────────────────────

DAYS = ['2026-08-14', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20']
SURFACE = {'bear_market': .7, 'sideways': .3}


def dataset(regime_rows):
    return SimpleNamespace(
        stocks=pl.DataFrame({'id': [1], 'symbol': ['2330']}), start_date=DAYS[0], end_date=DAYS[-1], trading_days=DAYS,
        market_risk=pl.DataFrame({'date': DAYS[:3] + DAYS[4:], 'risk_level': ['green', 'yellow', 'orange', 'red'],
                                  'risk_score': [10, 40, 61, 80]}),
        replay_frames={
            'signals': pl.DataFrame({'stock_id': [1] * 5, 'prediction_date': DAYS,
                                     'generated_at': [d + 'T13:00:00Z' for d in DAYS], 'direction_accuracy': [.6] * 5}),
            'market_breadth': pl.DataFrame({'date': DAYS, 'advance_ratio': [.5] * 5}),
            'us_market_signals': pl.DataFrame({'date': DAYS, 'gspc_return': [.0] * 5}),
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


HMM_ROWS = [obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z', surface=SURFACE),
            obs('2026-08-18', 'bull', '2026-08-18T14:00:00Z', '2026-08-19T02:00:00Z'),   # after the 08-19 open
            obs('2026-08-19', 'volatile', '2026-08-19T13:00:00Z')]


def test_hmm_days_use_the_pipeline_contract_and_earlier_days_keep_the_stored_level(monkeypatch, kv_position_risk):
    screens, entries = run(monkeypatch, kv_position_risk, HMM_ROWS)
    assert screens['2026-08-17']['regime_label'] == 'yellow' and screens['2026-08-17']['regime_surface'] is None
    assert screens['2026-08-18']['regime_label'] == 'bear'
    assert screens['2026-08-18']['regime_surface'] == SURFACE
    assert screens['2026-08-19']['regime_label'] == 'volatile'
    assert entries['2026-08-18']['regime_family'] is None and entries['2026-08-18']['risk_level'] == 'yellow'
    assert entries['2026-08-19']['regime_family'] == 'bear'
    assert entries['2026-08-19']['risk_level'] == 'orange' and entries['2026-08-19']['risk_score'] == 61
    assert entries['2026-08-20']['regime_family'] == 'volatile'
    # 08-19 has no market_risk row: Paper's adaptive reads the latest stored row (08-18).
    assert entries['2026-08-20']['risk_level'] == 'orange' and entries['2026-08-20']['risk_score'] == 61


def test_backfilled_rows_keep_the_stored_path_until_an_hmm_row_was_visible(monkeypatch, kv_position_risk):
    rows = [obs('2026-08-14', 'bear', '2026-08-14T13:00:00Z', '2026-08-19T13:00:00Z'),   # backfilled on 08-19
            obs('2026-08-18', 'volatile', '2026-08-18T13:00:00Z'),                       # on time
            obs('2026-08-19', 'sideways', '2026-08-19T13:00:00Z', source='market_env_fallback')]
    screens, entries = run(monkeypatch, kv_position_risk, rows)
    assert screens['2026-08-14']['regime_label'] == 'green' and screens['2026-08-14']['regime_surface'] is None
    assert screens['2026-08-17']['regime_label'] == 'yellow'
    assert entries['2026-08-17']['regime_family'] is None and entries['2026-08-18']['regime_family'] is None
    assert screens['2026-08-18']['regime_label'] == 'volatile'
    assert entries['2026-08-19']['regime_family'] == 'volatile'
    # Inside the era, a day whose latest visible state is not HMM still gets no candidates.
    assert '2026-08-19' not in screens and '2026-08-20' not in entries


def test_the_era_is_judged_at_the_open_the_candidates_are_for(monkeypatch, kv_position_risk):
    # The first HMM row lands during 08-19 (after its open): the 08-19 screen, for the 08-20 open,
    # is in the era; its latest visible state is a fallback, so it gets no candidates.
    rows = [obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z', '2026-08-19T05:00:00Z'),
            obs('2026-08-19', 'sideways', '2026-08-19T13:00:00Z', source='market_env_fallback')]
    screens, entries = run(monkeypatch, kv_position_risk, rows)
    assert screens['2026-08-18']['regime_label'] == 'orange'
    assert '2026-08-19' not in screens


def test_an_hmm_day_without_a_contract_has_no_candidates(monkeypatch, kv_position_risk):
    rows = [HMM_ROWS[0], obs('2026-08-19', 'sideways', '2026-08-19T13:00:00Z', source='market_env_fallback')]
    screens, entries = run(monkeypatch, kv_position_risk, rows)
    assert '2026-08-18' in screens and '2026-08-19' not in screens
    assert '2026-08-20' not in entries


def test_a_range_before_the_hmm_era_is_unchanged(monkeypatch, kv_position_risk):
    screens, entries = run(monkeypatch, kv_position_risk, [])
    assert [screens[d]['regime_label'] for d in DAYS[:3]] == ['green', 'yellow', 'orange']
    assert screens['2026-08-19']['regime_label'] is None
    assert all(kw['regime_family'] is None for kw in entries.values())


# ── P3 threshold, and no SL/TP add or medium scale ───────────────────────────

L2 = {'confidence_risk_mult': .15, 'confidence_perf_mult': .2, 'confidence_delta_clip_lo': -.1,
      'confidence_delta_clip_hi': .2, 'confidence_effective_clip_lo': .45, 'confidence_effective_clip_hi': .75,
      'sltp_add_orange_sl': 5., 'sltp_add_orange_tp': 5., 'medium_risk_scale': .01}


def entry(kv_position_risk, *, conf, risk_level, risk_score=61, regime_family='bear', accuracy=.55,
          circuit=None, threshold=.6):
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
        ml_predictions=engine.MLPredictionsCache({('2330', '2026-08-18'): conf}), buy_conf_threshold=threshold,
        circuit_cfg=circuit or {}, current_drawdown_30d=0., recent_accuracy_30d=accuracy, l2_formula_cfg=L2,
        risk_score=risk_score, risk_level=risk_level, regime_family=regime_family,
        position_risk_distribution_cfg=kv_position_risk)
    assert candidate.confidence == conf, 'sizing keeps the raw confidence, as Paper Kelly does'
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
    assert regime_sql.count('run_date <= ?') == 2 and 'persisted_at AS recorded_at' in regime_sql
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
    rows = [obs('2026-08-01', 'bull', '2026-08-01T13:00:00Z'),                      # before start_date: kept
            obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z')]
    asked = []
    monkeypatch.setattr(backtest_state, 'load_regime_observations',
                        lambda end, client=None: asked.append((end, client)) or rows)
    monkeypatch.setattr(e, '_write_compute_snapshot', lambda **kw: kw)
    req = e.DatasetSnapshotExportRequest(business_date='2026-08-19', start_date='2026-08-14', end_date='2026-08-19',
                                         include_signals=True)
    result = e.export_backtest_dataset_snapshot(req)
    assert asked == [('2026-08-19', e.MARKET_D1_CLIENT)]
    assert result['d1_query_counts']['market_regime_state'] == 1
    assert result['components']['market_regime_state'].to_dicts() == rows
    monkeypatch.setattr(backtest_state, 'load_regime_observations', lambda end, client=None: [])
    empty = e.export_backtest_dataset_snapshot(req)['components']['market_regime_state']
    assert empty.is_empty() and tuple(empty.columns) == COLUMNS


def test_the_stored_level_feeds_the_volatility_term_even_at_a_low_score(kv_position_risk):
    orange, green = paper_delta(risk_score=20, risk_level='orange', regime='sideways', accuracy=.7), \
        paper_delta(risk_score=20, risk_level='green', regime='sideways', accuracy=.7)
    assert orange > green
    conf = .6 + (orange + green) / 2
    kw = dict(conf=conf, risk_score=20, regime_family='sideways', accuracy=.7)
    assert entry(kv_position_risk, risk_level='orange', **kw)[0].status == 'skipped_low_conf'
    assert entry(kv_position_risk, risk_level='green', **kw)[0].status != 'skipped_low_conf'


def test_layer_two_raises_the_adjusted_threshold_after_the_delta(kv_position_risk):
    circuit = {'lowAccuracyThreshold': .5, 'drawdownRaisedConf': .7}
    kw = dict(risk_score=20, risk_level='green', accuracy=.49)
    delta = paper_delta(regime='sideways', **kw)
    paper = max(min(.75, max(.45, .6 + delta)), .7)         # max(clip(base + delta), raised)
    wrong_order = min(.75, max(.45, .7 + delta))             # clip(max(base, raised) + delta)
    assert wrong_order > paper
    conf = (paper + wrong_order) / 2
    assert entry(kv_position_risk, conf=conf, regime_family='sideways', circuit=circuit,
                 **kw)[0].status != 'skipped_low_conf'
    assert entry(kv_position_risk, conf=paper - .001, regime_family='sideways', circuit=circuit,
                 **kw)[0].status == 'skipped_low_conf'


def test_before_the_hmm_era_there_is_no_delta_only_the_clip(kv_position_risk):
    # Paper has no adaptive params without an HMM family (adaptive_regime_evidence_unknown).
    kw = dict(risk_level='orange', risk_score=61, accuracy=.55)
    delta = paper_delta(regime='bear', **kw)
    assert delta > .001
    assert entry(kv_position_risk, conf=.6 + .001, regime_family=None, **kw)[0].status != 'skipped_low_conf'
    assert entry(kv_position_risk, conf=.6 - .001, regime_family=None, **kw)[0].status == 'skipped_low_conf'
    assert entry(kv_position_risk, conf=.76, regime_family=None, threshold=.8, **kw)[0].status != 'skipped_low_conf'


def test_missing_inputs_drop_the_delta_but_keep_the_clip(kv_position_risk):
    # Paper always clips the threshold; without adaptive inputs the delta is zero.
    attempt, _ = entry(kv_position_risk, conf=.76, risk_level=None, risk_score=None, threshold=.8)
    assert attempt.status != 'skipped_low_conf'


def test_the_snapshot_loader_carries_the_regime_component(monkeypatch):
    import services.research_corporate_history as corporate
    rows = [obs('2026-08-18', 'bear', '2026-08-18T13:00:00Z')]
    frames = {'stocks': pl.DataFrame({'symbol': ['2330'], 'listed_date': [None], 'delisted_date': [None]}),
              'prices': pl.DataFrame({'symbol': ['2330'], 'date': ['2026-08-18'], 'open': [1.], 'high': [1.],
                                      'low': [1.], 'close': [1.], 'volume': [1]}),
              'indicators': pl.DataFrame({'symbol': ['2330'], 'date': ['2026-08-18']}),
              'chips': pl.DataFrame({'symbol': ['2330'], 'date': ['2026-08-18']}),
              'market_risk': pl.DataFrame({'date': ['2026-08-18']}),
              'market_regime_state': frame(rows)}
    monkeypatch.setattr(engine, '_snapshot_component_uris', lambda manifest: {name: name for name in frames})
    monkeypatch.setattr(engine, '_read_snapshot_parquet', lambda uri, transform=None: frames[uri])
    monkeypatch.setattr(corporate, 'load_research_corporate_components', lambda *a, **k: {})
    data = engine.BacktestDataset.load_from_snapshot_manifest({'snapshot_id': 's'}, '2026-08-18', '2026-08-18')
    assert data.replay_frames['market_regime_state'].to_dicts() == rows
