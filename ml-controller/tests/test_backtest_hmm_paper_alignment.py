"""Replay uses Paper's market-regime inputs once an HMM row was visible before an open (Wei 10/30).

- The screener's alpha framework gets the pipeline HMM contract (family + surface).
- No confidence entry gate: Paper reads no buy threshold since 06-14 (Wei 10/30); entries follow
  Paper's morning risk chain (services.backtest_paper_risk): halt, single-name cap, exposure cap.
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


PAPER_CIRCUIT = {'maxPositionPct': .08, 'drawdownHalt': .15, 'drawdownScaleStart': .03, 'mddMultFloor': .2,
                 'highVolReducedPosPct': .04, 'layer7ScaleRatio': .3}


def portfolio_contract():
    from services import position_risk_owner
    return position_risk_owner.formal_portfolio_risk({'portfolio': {}})


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
                         params={'positionRiskDistribution': kv_position_risk, 'circuit': PAPER_CIRCUIT,
                                 'portfolioRiskPolicy': portfolio_contract()}, mode='B')
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
    # Entries get Paper's morning risk state only: no threshold, accuracy or adaptive inputs.
    gate_inputs = {'buy_conf_threshold', 'recent_accuracy_30d', 'risk_score', 'risk_level', 'regime_family',
                   'circuit_cfg', 'current_drawdown_30d', 'pf_30d', 'pf_90d'}
    assert set(entries) == {'2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20'}
    assert not any(gate_inputs & set(kw) for kw in entries.values())
    assert all(kw['paper_risk'] is not None for kw in entries.values())


def test_backfilled_rows_keep_the_stored_path_until_an_hmm_row_was_visible(monkeypatch, kv_position_risk):
    rows = [obs('2026-08-14', 'bear', '2026-08-14T13:00:00Z', '2026-08-19T13:00:00Z'),   # backfilled on 08-19
            obs('2026-08-18', 'volatile', '2026-08-18T13:00:00Z'),                       # on time
            obs('2026-08-19', 'sideways', '2026-08-19T13:00:00Z', source='market_env_fallback')]
    screens, entries = run(monkeypatch, kv_position_risk, rows)
    assert screens['2026-08-14']['regime_label'] == 'green' and screens['2026-08-14']['regime_surface'] is None
    assert screens['2026-08-17']['regime_label'] == 'yellow'
    assert screens['2026-08-18']['regime_label'] == 'volatile'
    assert '2026-08-19' in entries
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


def test_a_day_without_its_own_hmm_row_has_no_candidates(monkeypatch, kv_position_risk):
    # The pipeline's decision_lineage needs contract.run_date == the signal date.
    screens, entries = run(monkeypatch, kv_position_risk, [HMM_ROWS[0]])
    assert screens['2026-08-18']['regime_label'] == 'bear'
    assert '2026-08-19' not in screens and '2026-08-20' not in entries
    from services import backtest_state
    def query(sql, params):
        return [HMM_ROWS[0]] if 'market_regime_state' in sql else []
    for client in (backtest_state.CORE_D1_CLIENT, backtest_state.MARKET_D1_CLIENT):
        monkeypatch.setattr(client, 'query', query)
    state = backtest_state.BacktestMarketState('2026-08-14', '2026-08-20')
    assert state.hmm_regime_contract('2026-08-19', '2026-08-20') is None
    assert state.hmm_regime_contract('2026-08-18', '2026-08-19')['alpha_regime'] == 'bear'


def test_a_range_before_the_hmm_era_is_unchanged(monkeypatch, kv_position_risk):
    screens, entries = run(monkeypatch, kv_position_risk, [])
    assert [screens[d]['regime_label'] for d in DAYS[:3]] == ['green', 'yellow', 'orange']
    assert screens['2026-08-19']['regime_label'] is None
    assert set(entries) == set(DAYS[1:])


# ── no confidence gate; Paper's halt, name cap and exposure cap; no SL/TP add or medium scale ──

L2 = {'sltp_add_orange_sl': 5., 'sltp_add_orange_tp': 5., 'medium_risk_scale': .01}
GATE = {'buyConfThreshold': .99, 'lowAccuracyThreshold': .99, 'drawdownRaisedConf': .99}


def risk_state(*, halt=False, cap=.08, exposure=.95):
    from services.backtest_paper_risk import PaperRiskState
    return PaperRiskState(halt=halt, max_position_pct=0. if halt else cap, baseline_position_pct=.08,
                          target_exposure=None if halt else exposure, market=None,
                          triggered_layers=('P1',) if halt else (), reasons=('[P1] test halt',) if halt else ())


def entry(kv_position_risk, *, conf, risk=None, l2=L2, account=None, **extra):
    prices = pl.DataFrame([{'symbol': '2330', 'date': d, 'open': 100., 'high': 101., 'low': 99., 'close': 100.,
                            'volume': 10_000_000} for d in ('2026-08-18', '2026-08-19')])
    indicators = pl.DataFrame({'symbol': ['2330'], 'date': ['2026-08-18'], 'atr14': [10.]})
    chips = pl.DataFrame({'symbol': ['2330'], 'date': ['2026-08-18']})
    data = engine.BacktestDataset(prices=prices, indicators=indicators, chips=chips,
                                  market_risk=pl.DataFrame(), stocks=pl.DataFrame({'symbol': ['2330']}),
                                  trading_days=['2026-08-18', '2026-08-19'], start_date='2026-08-18', end_date='2026-08-19')
    candidate = engine.Candidate(symbol='2330', date='2026-08-18', close=100., industry='semi', base_score=1.,
                                 chip_score=1., tech_score=1., momentum_score=1., combined_score=1., has_buy_signal=1)
    account = account or engine.AccountState(cash=1_000_000., initial_capital=1_000_000.)
    attempts = engine.simulate_entries_for_date(
        dataset=data, decision_date='2026-08-18', entry_date='2026-08-19', candidates=[candidate], account=account,
        pos=engine.PositionSizeParams(), sltp=engine.SLTPParams(), fees=engine.FeeParams(),
        replay_days=['2026-08-18', '2026-08-19'],
        ml_predictions=engine.MLPredictionsCache({('2330', '2026-08-18'): conf}),
        paper_risk=risk if risk is not None else risk_state(), l2_formula_cfg=l2, position_risk_distribution_cfg=kv_position_risk, **extra)
    if attempts[0].status != 'skipped_circuit_halt':
        assert candidate.confidence == conf, 'sizing keeps the raw confidence, as Paper Kelly does'
    return attempts[0], account


def shares(account):
    position = account.positions.get('2330')
    return position.shares if position else 0


@pytest.mark.parametrize('conf', [0., .2, .449, .6, .99])
def test_any_confidence_enters_even_against_a_raised_threshold(kv_position_risk, conf):
    # 09-09+ rows carry the placeholder 0 (findings_sell_to_hold §8): they still enter, as in Paper.
    attempt, account = entry(kv_position_risk, conf=conf)
    assert attempt.status == 'filled' and shares(account) > 0
    # Equal size only because PositionSizeParams() has Kelly off; with Kelly on, conf still sizes.
    assert shares(account) == shares(entry(kv_position_risk, conf=.9)[1])


@pytest.mark.parametrize('removed', ['buy_conf_threshold', 'recent_accuracy_30d', 'risk_score', 'risk_level',
                                     'regime_family', 'circuit_cfg', 'current_drawdown_30d', 'pf_30d', 'pf_90d'])
def test_the_entry_simulation_has_no_confidence_gate_inputs(kv_position_risk, removed):
    with pytest.raises(TypeError):
        entry(kv_position_risk, conf=.6, **{removed: None})


def test_a_paper_risk_halt_stops_every_entry(kv_position_risk):
    attempt, account = entry(kv_position_risk, conf=.9, risk=risk_state(halt=True))
    assert attempt.status == 'skipped_circuit_halt' and not account.positions and 'P1' in attempt.reason
    assert entry(kv_position_risk, conf=.9)[0].status == 'filled'


def test_the_circuit_cap_shrinks_the_single_name_cap_and_never_the_whole_budget(kv_position_risk):
    # name cap = maxSingleNamePct (0.25) x min(1, maxPositionPct / circuit.maxPositionPct)
    full = entry(kv_position_risk, conf=.9)[1]
    scaled = entry(kv_position_risk, conf=.9, risk=risk_state(cap=.024))[1]     # x0.3, e.g. P6 RED
    assert shares(full) > 0 and 0 < shares(scaled) < shares(full)
    value = scaled.positions['2330'].shares * scaled.positions['2330'].entry_price
    assert value <= .25 * .3 * 1_000_000 + 1


def held(value):
    account = engine.AccountState(cash=1_000_000. - value, initial_capital=1_000_000.)
    account.positions['1101'] = engine.OpenPosition(
        symbol='1101', industry='cement', entry_date='2026-08-01', entry_price=100., shares=int(value // 100),
        initial_stop=90., tp1_price=120., tp2_price=130., atr14=2., sl_mult=2., highest_since_entry=100.)
    return account


def test_the_exposure_cap_limits_new_buys_to_the_room_left(kv_position_risk):
    # Holdings 0.40 of NAV under orange (0.45): new buys at most 0.05 of NAV.
    attempt, account = entry(kv_position_risk, conf=.9, risk=risk_state(exposure=.45), account=held(400_000.))
    assert attempt.status == 'filled'
    bought = account.positions['2330'].shares * account.positions['2330'].entry_price
    assert 0 < bought <= .05 * 1_000_000 + 1


def test_no_new_buy_once_holdings_reach_the_exposure_cap(kv_position_risk):
    attempt, account = entry(kv_position_risk, conf=.9, risk=risk_state(exposure=.45), account=held(500_000.))
    assert attempt.status == 'skipped_exposure_cap' and '2330' not in account.positions
    assert '1101' in account.positions   # deRisk of held positions is not simulated


def test_green_exposure_does_not_bind(kv_position_risk):
    capped = entry(kv_position_risk, conf=.9, risk=risk_state(exposure=.95), account=held(100_000.))[1]
    free = entry(kv_position_risk, conf=.9, risk=risk_state(exposure=1.), account=held(100_000.))[1]
    assert shares(capped) == shares(free) > 0


def test_no_risk_level_sltp_add_and_no_medium_scale(kv_position_risk):
    with_retired = entry(kv_position_risk, conf=.9)
    without = entry(kv_position_risk, conf=.9, l2={})
    assert (with_retired[0].status, shares(with_retired[1]), with_retired[1].positions['2330'].initial_stop) == \
        (without[0].status, shares(without[1]), without[1].positions['2330'].initial_stop)


CONFIDENCE_PATHS = {'circuit.buyConfThreshold', 'circuit.lowAccuracyThreshold', 'circuit.drawdownRaisedConf',
                    'L2_formula.confidence_risk_mult', 'L2_formula.confidence_perf_mult',
                    'L2_formula.confidence_delta_clip_lo', 'L2_formula.confidence_delta_clip_hi',
                    'L2_formula.confidence_effective_clip_lo', 'L2_formula.confidence_effective_clip_hi'}


def test_the_l2_search_never_tunes_the_retired_dimensions():
    from optuna_scripts.optuna_l2_sensitivity import DEFAULT_SEARCH_SPACE, RETIRED_PATHS
    retired = {f'L2_formula.sltp_add_{lv}_{sd}' for lv in ('orange', 'red', 'black') for sd in ('sl', 'tp')}
    retired |= {'L2_formula.medium_risk_scale', 'circuit.sellConfThreshold'} | CONFIDENCE_PATHS
    retired |= {f'L2_formula.pf_quality_{n}' for n in ('30d_weight', '90d_weight', 'clip_lo', 'clip_hi')}
    assert retired <= RETIRED_PATHS
    from optuna_scripts.optuna_l2_sensitivity import SELL_COUPLED_CONFIDENCE_PATHS
    assert SELL_COUPLED_CONFIDENCE_PATHS == CONFIDENCE_PATHS | {'circuit.sellConfThreshold'}   # restored together
    assert not {dim['path'] for dim in DEFAULT_SEARCH_SPACE} & RETIRED_PATHS
    assert {dim['path'] for dim in DEFAULT_SEARCH_SPACE if dim['path'].startswith('circuit.')} == {
        'circuit.drawdownHalt', 'circuit.drawdownScaleStart', 'circuit.mddMultFloor'}
    assert len(DEFAULT_SEARCH_SPACE) == 7   # 3 drawdown + 4 night drop (PF quality retired, Wei 10/30 §5-3)


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
