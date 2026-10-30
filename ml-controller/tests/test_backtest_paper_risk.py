"""Paper's morning risk chain replayed point-in-time (plan_replay_paper_layers §1-2)."""
from pathlib import Path
import re

import pytest

from services import backtest_paper_risk as risk
from services.backtest_state import entry_open
from services.position_risk_owner import (PAPER_PORTFOLIO_PROGRAM_VALUES, formal_portfolio_risk,
                                          portfolio_risk_policy)

WORKER = Path(__file__).resolve().parents[2] / 'worker' / 'src' / 'lib'
POLICY = portfolio_risk_policy(formal_portfolio_risk({'portfolio': {}}))
CIRCUIT = {'maxPositionPct': 0.08, 'highVolReducedPosPct': 0.04, 'drawdownHalt': 0.15,
           'drawdownScaleStart': 0.03, 'mddMultFloor': 0.2, 'layer7ScaleRatio': 0.3}
SCALES = {'highVol': 0.5, 'severeHighVol': 0.5, 'momentumZone': {'RED': 0.3, 'YELLOW': 0.7}, 'lossStreak': 0.5}
SCALED = {**CIRCUIT, 'positionScales': SCALES}
D, ENTRY = '2026-10-28', '2026-10-29'
CUTOFF = entry_open(ENTRY)  # 2026-10-29T01:00Z


def market(*, close=100., prev=100., adv=0.5, label='bull_market', calc='2026-10-28T10:00:00Z',
           regime_run=D, regime=True, hmm_era=True, risk_level='green'):
    rows = [{'date': '2026-10-27', 'twii_close': prev, 'risk_level': 'green', 'calculated_at': '2026-10-27T10:00:00Z'},
            {'date': D, 'twii_close': close, 'risk_level': risk_level, 'calculated_at': calc}]
    breadth = [{'date': D, 'advance_ratio': adv, 'created_at': '2026-10-28T09:00:00Z'}]
    state = {'run_date': regime_run, 'label': label} if regime else None
    return risk.canonical_market_risk(session=D, cutoff=CUTOFF, market_risk_rows=rows, breadth_rows=breadth,
                                      regime_state=state, hmm_era=hmm_era, policy=POLICY)


def state_for(ctx, circuit=CIRCUIT, *extra):
    return risk.aggregate([risk.p3_p4_market(ctx, circuit), *extra], circuit=circuit, market=ctx)


# ── §2.1 canonical market risk ───────────────────────────────────────────────

@pytest.mark.parametrize('circuit', [CIRCUIT, SCALED])
def test_volatile_regime_alone_is_orange_not_a_halt(circuit):
    ctx = market(label='volatile')
    assert ctx.status == 'ready' and ctx.level == 'orange' and ctx.target_exposure == 0.45
    state = state_for(ctx, circuit)
    assert not state.halt and state.max_position_pct == pytest.approx(0.04) and state.exposure_cap == 0.45
    assert state.name_cap_scale == pytest.approx(0.5)


def test_shock_boundary_is_inclusive():
    assert market(close=97.01).level == 'green'
    assert market(close=97.).level == 'orange' and market(close=97.).shock_level == 'orange'
    assert market(close=95.).level == 'red' and market(close=91.9).level == 'black'
    # Same IEEE doubles as the worker: 92/100-1 is -0.07999999999999996, above -0.08.
    assert market(close=92.).level == 'red'


def test_breadth_boundary_is_inclusive():
    assert market(adv=0.25).level == 'orange'
    assert market(adv=0.2501).level == 'green'


def test_a_regime_state_not_visible_at_the_open_blocks_and_halts():
    ctx = market(regime=False)
    assert ctx.status == 'blocked' and 'market_regime_state_missing' in ctx.blockers
    assert 'market_regime_date_mismatch' in ctx.blockers  # TS: a missing state has no date either
    state = state_for(ctx)
    assert state.halt and state.exposure_cap == 0 and state.name_cap_scale == 0
    assert market(regime_run='2026-10-27').status == 'blocked'


def test_a_market_risk_row_stamped_after_the_open_is_read_and_named():
    # INSERT OR REPLACE restamps calculated_at: a 10/07 backfill moved every row since 08-03 past its open.
    ctx = market(calc='2026-10-29T02:00:00Z')
    assert ctx.status == 'ready' and ctx.date == D
    assert ctx.approximations == ('market_risk_written_after_open_untracked',
                                  'market_breadth_rewrite_after_created_at_untracked')
    assert 'market_risk_written_after_open_untracked' in market(calc=None).approximations
    assert 'market_risk_written_after_open_untracked' not in market().approximations


def test_a_breadth_row_first_written_after_the_open_is_invisible_and_later_risk_rows_never_count():
    rows = [{'date': '2026-10-27', 'twii_close': 100., 'risk_level': 'green', 'calculated_at': '2026-10-27T10:00:00Z'},
            {'date': D, 'twii_close': 100., 'risk_level': 'green', 'calculated_at': '2026-10-28T10:00:00Z'}]
    ctx = risk.canonical_market_risk(session=D, cutoff=CUTOFF, market_risk_rows=rows,
                                     breadth_rows=[{'date': D, 'advance_ratio': .5, 'created_at': '2026-10-29T02:00:00Z'}],
                                     regime_state={'run_date': D, 'label': 'bull_market'}, hmm_era=True, policy=POLICY)
    assert ctx.status == 'blocked' and 'market_breadth_missing' in ctx.blockers
    later = rows + [{'date': ENTRY, 'twii_close': 50., 'risk_level': 'black', 'calculated_at': '2026-10-28T12:00:00Z'}]
    ctx = risk.canonical_market_risk(session=D, cutoff=CUTOFF, market_risk_rows=later,
                                     breadth_rows=[{'date': D, 'advance_ratio': .5, 'created_at': '2026-10-28T09:00:00Z'}],
                                     regime_state={'run_date': D, 'label': 'bull_market'}, hmm_era=True, policy=POLICY)
    assert ctx.status == 'ready' and ctx.date == D and ctx.level == 'green'   # a row dated after the session never counts


@pytest.mark.parametrize('circuit,cap', [(SCALED, 0.08 * 0.5 * 0.5), (CIRCUIT, 0.04 * 0.5)])
def test_red_breadth_under_a_bull_regime_is_red(circuit, cap):
    ctx = market(adv=0.15)
    assert ctx.level == 'red' and ctx.regime_level == 'green' and ctx.target_exposure == 0.20
    state = state_for(ctx, circuit)
    assert not state.halt and state.max_position_pct == pytest.approx(cap)


def test_pre_hmm_days_use_the_stored_level_and_say_so():
    ctx = market(regime=False, hmm_era=False, risk_level='orange')
    assert ctx.status == 'ready' and ctx.level == 'orange'
    assert 'pre_hmm_era_stored_risk_level' in state_for(ctx).approximations


def test_every_state_names_what_it_does_not_model():
    state = state_for(market())
    assert 'deRisk_existing_positions' in state.unmodeled
    assert 'P3:market_regime_factor_packet' in state.unmodeled and 'P3:market_risk_quality_v1' in state.unmodeled


# ── §2.2 positionScales ──────────────────────────────────────────────────────

def test_layers_combine_by_minimum_not_product():
    p1 = risk.p1_drawdown([100., 100., 92.2], SCALED)  # drawdown 0.078 -> mult 0.6
    p6 = risk.p6_momentum('RED', SCALED)
    assert p1.max_position_pct == pytest.approx(0.048) and p6.max_position_pct == pytest.approx(0.024)
    state = risk.aggregate([p1, p6], circuit=SCALED, market=market())
    assert state.max_position_pct == pytest.approx(0.024) and state.name_cap_scale == pytest.approx(0.3)


@pytest.mark.parametrize('bad', [0, 1.2, True, None])
def test_an_invalid_scale_raises_instead_of_defaulting(bad):
    with pytest.raises(ValueError, match='circuit_position_scales_invalid'):
        risk.position_scales({**CIRCUIT, 'positionScales': {**SCALES, 'highVol': bad}})
    with pytest.raises(ValueError, match='circuit_position_scales_invalid'):
        risk.position_scales({**CIRCUIT, 'positionScales': {**SCALES, 'extra': 0.5}})


def test_p1_needs_three_closes_and_halts_past_the_limit():
    assert risk.p1_drawdown([100., 90.], CIRCUIT) is None
    assert risk.p1_drawdown([100., 100., 84.], CIRCUIT).halt
    assert risk.p1_drawdown([100., 100., 98.], CIRCUIT) is None
    floor = risk.p1_drawdown([100., 100., 85.5], CIRCUIT)  # mult (0.15-0.145)/0.12 below the 0.2 floor
    assert floor.max_position_pct == pytest.approx(0.08 * 0.2)


def test_p5_counts_only_stop_outs():
    rotations = [{'exit_reason': 'ML_SELL', 'pnl': -10.}] * 3
    assert risk.p5_losses(rotations, CIRCUIT) is None
    stops = [{'exit_reason': 'HardStop', 'pnl': -10.}, {'exit_reason': 'Trail/InitStop', 'pnl': -5.},
             {'exit_reason': 'GapHardStop', 'pnl': -1.}]
    assert risk.p5_losses(stops, CIRCUIT).max_position_pct == pytest.approx(0.04)
    assert risk.p5_losses([*stops[:2], {'exit_reason': 'HardStop', 'pnl': 3.}], CIRCUIT) is None
    with pytest.raises(ValueError, match='loss_guard'):
        risk.p5_losses(stops, {**CIRCUIT, 'lossGuard': {}})


def test_p6_reads_the_last_zone_visible_at_the_open():
    pool = risk.MOMENTUM_POOL_DEFINITION
    rows = [{'date': '2026-10-27', 'zone': 'YELLOW', 'pool_definition': pool, 'created_at': '2026-10-27T09:00:00Z'},
            {'date': D, 'zone': 'RED', 'pool_definition': pool, 'created_at': '2026-10-29T02:00:00Z'},
            {'date': D, 'zone': 'RED', 'pool_definition': None, 'created_at': '2026-10-28T09:00:00Z'}]
    assert risk.current_momentum_zone(rows, session=D, cutoff=CUTOFF) == ('YELLOW', '2026-10-27')
    assert risk.p6_momentum('YELLOW', CIRCUIT).max_position_pct == pytest.approx(0.056)
    assert risk.current_momentum_zone(rows[2:], session=D, cutoff=CUTOFF) == ('GREEN', None)
    # The newer row without a pool (pre-backfill) is skipped like Paper does, and named.
    state = morning(momentum_rows=rows)
    assert state.max_position_pct == pytest.approx(0.056)
    assert 'p6_newer_zone_row_without_pool_definition' in state.approximations
    assert 'p6_newer_zone_row_without_pool_definition' not in morning(momentum_rows=rows[:2]).approximations


# ── P7 / P8 ──────────────────────────────────────────────────────────────────

IDENTITY = ('art', 'cohort', 'sum', 'base')


def prediction(date, end, correct, *, stock='2330', identity=IDENTITY, verified='2026-10-27T12:00:00Z', **kw):
    row = {'model_name': 'ensemble', 'stock_id': stock, 'prediction_date': date, 'direction_correct': correct,
           'verified_at': verified, 'generated_at': date + 'T10:00:00Z', 'verification_label_known_date': end,
           'verification_label_end_date': end, 'verification_label_schema_version': risk.P7_LABEL_SCHEMA,
           'forecast_horizon_bars': 5, **dict(zip(('ensemble_' + f for f in risk.P7_IDENTITY_FIELDS), identity))}
    return {**row, **kw}


COHORTS = [('2026-10-20', '2026-10-27'), ('2026-10-13', '2026-10-19'), ('2026-10-06', '2026-10-12'),
           ('2026-09-29', '2026-10-05'), ('2026-09-22', '2026-09-28')]


def p7(rows):
    return risk.p7_streak(rows, identity=IDENTITY, entry_date=ENTRY, cutoff=CUTOFF, circuit=CIRCUIT)


def test_p7_scales_after_four_wrong_disjoint_cohorts():
    rows = [prediction(d, e, 0 if i < 4 else 1) for i, (d, e) in enumerate(COHORTS)]
    assert p7(rows).max_position_pct == pytest.approx(0.024)
    assert p7([prediction(d, e, 0 if i < 3 else 1) for i, (d, e) in enumerate(COHORTS)]) is None


def test_p7_skips_overlapping_late_foreign_and_unverified_rows():
    rows = [prediction(d, e, 0) for d, e in COHORTS]
    assert p7(rows[:4] + [prediction('2026-09-30', '2026-10-07', 0)]) is None          # overlaps the 10-06 cohort
    assert p7(rows[:4] + [prediction(*COHORTS[4], 0, verified='2026-10-29T02:00:00Z')]) is None
    assert p7(rows[:4] + [prediction(*COHORTS[4], 0, identity=('x',) * 4)]) is None
    assert p7(rows[:4] + [prediction(*COHORTS[4], 0, forecast_horizon_bars=10)]) is None
    assert risk.p7_streak(rows, identity=None, entry_date=ENTRY, cutoff=CUTOFF, circuit=CIRCUIT) is None


def test_p8_halts_on_either_limit():
    assert risk.p8_daily_loss(previous_nav=1_000_000, current_nav=970_000, policy=POLICY).halt
    assert risk.p8_daily_loss(previous_nav=500_000, current_nav=485_000, policy=POLICY).halt  # -3%
    assert risk.p8_daily_loss(previous_nav=1_000_000, current_nav=980_000, policy=POLICY) is None
    assert risk.p8_daily_loss(previous_nav=None, current_nav=1., policy=POLICY) is None
    with pytest.raises(ValueError, match='daily_pnl_context_invalid'):
        risk.p8_daily_loss(previous_nav=1., current_nav=0., policy=POLICY)


# ── parity with the worker source ────────────────────────────────────────────

def _ts(name):
    return (WORKER / name).read_text(encoding='utf-8')


def test_constants_match_the_worker():
    zone = _ts('momentumZone.ts')
    assert f"MOMENTUM_POOL_DEFINITION = '{risk.MOMENTUM_POOL_DEFINITION}'" in zone
    for name, value in risk.LEGACY_ZONE_MULTIPLIER.items():
        assert re.search(rf'ZONE_MULTIPLIER[^}}]*\b{name}: {value}\b', zone, re.S)
    assert f'P5_LOSS_POSITION_SCALE = {risk.LEGACY_P5_LOSS_POSITION_SCALE}' in _ts('riskChecks/p5Losses.ts')
    for name in ('riskChecks/p3MarketRisk.ts', 'riskChecks/p4Breadth.ts'):
        assert f'highVolReducedPosPct * {risk.LEGACY_SEVERE_HIGH_VOL_FACTOR}' in _ts(name)
    p7_source = _ts('riskChecks/p7Streak.ts')
    assert risk.P7_LABEL_SCHEMA in p7_source and "forecast_horizon_bars')=5" in p7_source
    for field in risk.P7_IDENTITY_FIELDS:
        assert f"'$.ensemble_v2.{field}')" in p7_source


def test_portfolio_program_values_match_the_worker_defaults():
    source = _ts('riskConfig.ts')
    block = source[source.index('portfolio: {', source.index('DEFAULT_RISK_CONFIG')):]
    block = block[:block.index('}')]
    defaults = {k: float(v) for k, v in re.findall(r'(\w+):\s*(-?[\d.]+)', block)}
    for name, value in PAPER_PORTFOLIO_PROGRAM_VALUES.items():
        assert defaults[name] == value, name
    shock_and_breadth = re.findall(r"(black|red|orange)TargetExposure|marketShock(\w+)Pct", _ts('marketRiskRuntime.ts'))
    assert shock_and_breadth  # the runtime still reads these policy fields


# ── one entry session (S3) ────────────────────────────────────────────────────

def morning(**overrides):
    rows = [{'date': '2026-10-27', 'twii_close': 100., 'risk_level': 'green', 'calculated_at': '2026-10-27T10:00:00Z'},
            {'date': D, 'twii_close': 100., 'risk_level': 'green', 'calculated_at': '2026-10-28T10:00:00Z'}]
    args = dict(decision_date=D, entry_date=ENTRY, circuit=CIRCUIT, policy=POLICY, market_risk_rows=rows,
                breadth_rows=[{'date': D, 'advance_ratio': .5, 'created_at': '2026-10-28T09:00:00Z'}],
                regime_state={'run_date': D, 'label': 'bull_market'}, hmm_era=True, equity=[1e6] * 5, sells=[],
                momentum_rows=[], verified_rows=[], identity=IDENTITY, previous_nav=1e6, current_nav=1e6)
    return risk.replay_morning_state(**{**args, **overrides})


def test_a_quiet_morning_runs_every_layer_with_nothing_triggered():
    state = morning()
    assert not state.halt and state.max_position_pct == .08 and state.exposure_cap == .95
    assert state.triggered_layers == () and state.approximations == ('market_breadth_rewrite_after_created_at_untracked',
                                                                       'p6_zone_rewrite_after_created_at_untracked')


def test_the_first_snapshot_session_has_no_previous_close_and_says_so_instead_of_halting():
    first = [{'date': D, 'twii_close': 100., 'risk_level': 'green', 'calculated_at': '2026-10-28T10:00:00Z'}]
    assert morning(market_risk_rows=first).halt                               # Paper-like: missing close blocks
    state = morning(market_risk_rows=first, first_snapshot_session=True)
    assert not state.halt and state.market.shock_level is None
    assert 'market_risk_previous_close_outside_window' in state.approximations


def test_inputs_the_snapshot_lacks_are_named_never_assumed_green():
    assert 'p6_momentum_component_missing' in morning(momentum_rows=None).approximations
    assert 'p7_verified_columns_missing' in morning(verified_rows=None).approximations
    assert 'p7_verified_columns_missing' in morning(verified_rows=[{'generated_at': 'x'}]).approximations
    assert 'p7_ensemble_identity_unavailable' in morning(identity=None).approximations
    assert 'p8_open_mark_missing' in morning(current_nav=None).approximations


def test_each_layer_reaches_the_session_state():
    assert morning(equity=[1e6, 1e6, .84e6]).halt                                           # P1
    assert morning(regime_state=None).halt                                                  # P3 blocked
    stops = [{'exit_reason': 'HardStop @ 90', 'pnl': -1}] * 3
    assert morning(sells=stops).max_position_pct == pytest.approx(.04)                      # P5 legacy 0.5
    zone = [{'date': D, 'zone': 'RED', 'pool_definition': risk.MOMENTUM_POOL_DEFINITION,
             'created_at': '2026-10-28T09:00:00Z'}]
    assert morning(momentum_rows=zone).max_position_pct == pytest.approx(.024)              # P6
    streak = [prediction(d, e, 0) for d, e in COHORTS]
    assert morning(verified_rows=streak).max_position_pct == pytest.approx(.024)            # P7
    assert morning(current_nav=.96e6).halt                                                  # P8 at the open


def test_the_session_record_and_summary_carry_what_was_not_simulated():
    records = [risk.state_record(morning(), ENTRY), risk.state_record(morning(regime_state=None), '2026-10-30')]
    assert records[1]['halt'] and records[1]['market_status'] == 'blocked'
    assert records[0]['market_components'] == {'regime': 'green', 'shock': None, 'breadth': None}
    summary = risk.summarize(records)
    assert summary['sessions'] == 2 and summary['halt_sessions'] == 1 and summary['layer_trigger_sessions'] == {'P3': 1}
    assert 'deRisk 未模擬' in summary['not_simulated'] and 'P3:market_regime_factor_packet' in summary['unmodeled']


def test_the_ensemble_identity_is_the_newest_published_before_the_open():
    import json
    import polars as pl
    from services.backtest_snapshot_state import ensemble_identity_changes
    from services.backtest_state import BacktestMarketState
    def forecast(art):
        return json.dumps({'ensemble_v2': dict(zip(risk.P7_IDENTITY_FIELDS, (art, 'c', 's', 'b')))})
    signals = pl.DataFrame({'generated_at': ['2026-10-27T13:00:00Z', '2026-10-28T13:00:00Z', '2026-10-29T02:00:00Z',
                                             '2026-10-28T14:00:00Z'],
                            'forecast_data': [forecast('a'), forecast('b'), forecast('c'), '{}']})
    state = BacktestMarketState.__new__(BacktestMarketState)
    state._ensemble_identities = ensemble_identity_changes(signals)
    assert [i[0] for _, i in state._ensemble_identities] == ['a', 'b', 'c']
    assert state.ensemble_identity_at(CUTOFF) == ('b', 'c', 's', 'b')        # 'c' came after the 10-29 open
    assert state.ensemble_identity_at(entry_open('2026-10-27')) is None
    assert ensemble_identity_changes(signals.drop('forecast_data')) == []


def test_the_open_mark_never_reads_the_entry_day_close():
    from types import SimpleNamespace
    from services import backtest_engine as engine
    account = engine.AccountState(cash=100., initial_capital=100.)
    account.positions['2330'] = engine.OpenPosition(
        symbol='2330', industry='semi', entry_date='2026-10-01', entry_price=10., shares=10, initial_stop=9.,
        tp1_price=12., tp2_price=13., atr14=1., sl_mult=2., highest_since_entry=10.)
    bars = {('2330', ENTRY): {'open': 11., 'close': 50.}}
    data = SimpleNamespace(get_bar=lambda symbol, day: bars.get((symbol, day)))
    assert engine._mark_to_open(account, data, ENTRY, D) == 100. + 110.
    bars[('2330', ENTRY)] = {'open': None, 'close': 50.}
    assert engine._mark_to_open(account, data, ENTRY, D) is None
