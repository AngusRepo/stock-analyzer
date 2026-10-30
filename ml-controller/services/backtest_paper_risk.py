"""Paper's morning portfolio risk chain, replayed point-in-time (pure, no I/O).

Mirrors worker `riskChain.runPortfolioChecks` as Paper runs it before the
session's entries (pendingBuyOrchestrator.checkCircuitBreakers), plus the P8
daily-loss gate Paper re-checks right before buying (paperEntryTasks):

  halt               = any layer halts
  maxPositionPct     = MIN across layers (never a product)
  targetExposurePct  = canonical market risk cap (none when blocked)

Layers: P1 30-snapshot drawdown, P3/P4 canonical market risk (v4: HMM label,
one-day shock, breadth collapse), P5 recent stop-out losses, P6 momentum zone,
P7 ensemble prediction streak, P8 daily loss. Not reproducible here and named
in every result instead of silently passing: S1 kill switch (manual), P2's
per-day missing-evidence halt (no point-in-time source; the sealed
verified_predictions component is required at load instead), P5 manual
rearms, P9 intraday drawdown, and the factor-packet / quality / HMM-provenance
blockers (Wei 10/30 §5-1 B: unmodeled). deRisk of existing positions is a SELL
action and is not simulated (Wei 10/30 §5-5, deferred to R33).

Every value is read from the replay's inputs: trading:config.circuit, the
trading:risk_config portfolio contract, and sealed snapshot rows visible
before the entry session's 09:00 TW open. The few legacy constants below are
Paper's own program values; tests pin them to the worker source.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import math
from typing import Any, Iterable, Optional

LEVELS = ('green', 'yellow', 'orange', 'red', 'black')
_RANK = {level: index for index, level in enumerate(LEVELS)}

# Paper legacy branches, used only while trading:config.circuit.positionScales is
# absent (circuitPositionScales.ts). Pinned to the worker source by tests.
LEGACY_ZONE_MULTIPLIER = {'RED': 0.3, 'YELLOW': 0.7}           # momentumZone.ts ZONE_MULTIPLIER
LEGACY_P5_LOSS_POSITION_SCALE = 0.5                             # p5Losses.ts P5_LOSS_POSITION_SCALE
LEGACY_SEVERE_HIGH_VOL_FACTOR = 0.5                             # p3MarketRisk.ts / p4Breadth.ts `* 0.5`
MOMENTUM_POOL_DEFINITION = 'screener-v2.final-candidates.v1'    # momentumZone.ts
P7_LABEL_SCHEMA = 'next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4'
P7_IDENTITY_FIELDS = ('artifact_id', 'cohort_id', 'artifact_checksum', 'base_artifact_set_checksum')

# Market-risk blockers Paper evaluates whose inputs the sealed snapshot does not
# carry (Wei 10/30 §5-1: option B). A day that would have halted on one of these
# is not reproduced; every result names them.
UNMODELED_MARKET_BLOCKERS = (
    'market_regime_factor_packet', 'market_risk_quality_v1', 'market_risk_benchmark_price_lineage',
    'hmm_model_input_contract', 'hmm_inference_clock',
)
UNMODELED_LAYERS = ('S1_kill_switch', 'P2_missing_accuracy_evidence_halt', 'P5_manual_rearm',
                    'P9_intraday_drawdown', 'deRisk_existing_positions')


def _instant(value: Any) -> Optional[datetime]:
    if value in (None, ''):
        return None
    try:
        parsed = datetime.fromisoformat(str(value).strip().replace(' ', 'T').replace('Z', '+00:00'))
    except ValueError:
        return None
    # D1 datetime('now') text is UTC.
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def _finite(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool) or (isinstance(value, str) and not value.strip()):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def normalize_level(value: Any) -> Optional[str]:
    """marketRiskRuntime.normalizeCanonicalMarketRiskLevel."""
    text = str(value if value is not None else '').strip().lower()
    if text in ('black', 'halt', 'closed', 'extreme'):
        return 'black'
    if text in ('red', 'very_high', 'bear', 'bear_market'):
        return 'red'
    if text in ('orange', 'high', 'volatile'):
        return 'orange'
    if text in ('yellow', 'medium', 'sideways', 'neutral', 'normal'):
        return 'yellow'
    if text in ('green', 'low', 'bull', 'bull_market', 'constructive'):
        return 'green'
    return None


def _max_level(levels: Iterable[Optional[str]]) -> str:
    highest = 'green'
    for level in levels:
        if level and _RANK[level] > _RANK[highest]:
            highest = level
    return highest


# ── configuration views ──────────────────────────────────────────────────────

def position_scales(circuit: dict) -> Optional[dict]:
    """circuitPositionScales.ts: absent -> None (legacy), present -> exact shape or raise."""
    scales = (circuit or {}).get('positionScales')
    if scales is None:
        return None
    zone = scales.get('momentumZone') if isinstance(scales, dict) else None
    values = [scales.get('highVol'), scales.get('severeHighVol'),
              (zone or {}).get('RED'), (zone or {}).get('YELLOW'), scales.get('lossStreak')] if isinstance(scales, dict) else []
    if (not isinstance(scales, dict) or sorted(scales) != ['highVol', 'lossStreak', 'momentumZone', 'severeHighVol']
            or not isinstance(zone, dict) or sorted(zone) != ['RED', 'YELLOW']
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0 or v > 1
                   for v in values)):
        raise ValueError('circuit_position_scales_invalid')
    return scales


def _circuit_number(circuit: dict, name: str) -> float:
    value = _finite((circuit or {}).get(name))
    if value is None:
        raise ValueError('paper_risk_circuit_field_missing:' + name)
    return value


# ── canonical market risk (P3 + P4) ──────────────────────────────────────────

@dataclass(frozen=True)
class MarketRiskContext:
    status: str                      # 'ready' | 'blocked'
    date: Optional[str]
    level: str
    target_exposure: Optional[float]
    breadth_level: Optional[str]
    shock_level: Optional[str]
    regime_level: Optional[str]
    daily_change_pct: Optional[float]
    advance_ratio: Optional[float]
    blockers: tuple[str, ...]
    approximations: tuple[str, ...] = ()


def _visible(rows: Iterable[dict], *, session: str, cutoff: datetime, clock: str) -> list[dict]:
    """Rows dated on or before `session` whose write time precedes the entry open."""
    out = []
    for row in rows:
        date = str(row.get('date') or '')
        written = _instant(row.get(clock))
        if date and date <= session and written is not None and written < cutoff:
            out.append(row)
    return sorted(out, key=lambda row: str(row['date']), reverse=True)


def _target_exposure(level: str, policy: dict) -> float:
    return float(policy[level + 'TargetExposure'])


def canonical_market_risk(*, session: str, cutoff: datetime, market_risk_rows: list[dict],
                          breadth_rows: list[dict], regime_state: Optional[dict], hmm_era: bool,
                          policy: dict) -> MarketRiskContext:
    """marketRiskRuntime.buildCanonicalMarketRiskContext (v4) on sealed rows.

    `session` is the expected session (the decision date, the entry's previous
    trading day). Before the HMM era the stored market_risk level stands in for
    the regime level, and the day is marked as an approximation.
    """
    risk = _visible(market_risk_rows, session=session, cutoff=cutoff, clock='calculated_at')
    latest, previous = (risk[0] if risk else None), (risk[1] if len(risk) > 1 else None)
    breadth_visible = _visible(breadth_rows, session=session, cutoff=cutoff, clock='created_at')
    breadth = breadth_visible[0] if breadth_visible else None
    risk_date = str(latest['date']) if latest else None
    blockers: list[str] = []
    approximations: list[str] = []
    if latest is None:
        blockers.append('market_risk_missing')
    if previous is None:
        blockers.append('market_risk_previous_close_missing')
    if breadth is None:
        blockers.append('market_breadth_missing')
    if risk_date != session:
        blockers.append('market_risk_expected_session_mismatch')
    if risk_date and breadth is not None and str(breadth['date']) != risk_date:
        blockers.append('market_breadth_date_mismatch')
    regime_level = None
    if hmm_era:
        if regime_state is None:
            blockers.append('market_regime_state_missing')
        if risk_date and str((regime_state or {}).get('run_date')) != risk_date:
            blockers.append('market_regime_date_mismatch')  # TS: a missing state has no date either
        if regime_state is not None:
            from services.market_regime_state import normalize_regime_label
            normalized = normalize_regime_label(regime_state.get('label'))
            family = normalized[1] if normalized else None
            regime_level = {'bear': 'red', 'volatile': 'orange', 'sideways': 'yellow', 'bull': 'green'}.get(family)
            if regime_level is None:
                blockers.append('market_regime_family_invalid')
    else:
        regime_level = normalize_level(latest.get('risk_level')) if latest else None
        approximations.append('pre_hmm_era_stored_risk_level')
    current_close = _finite(latest.get('twii_close')) if latest else None
    previous_close = _finite(previous.get('twii_close')) if previous else None
    if current_close is None or current_close <= 0:
        blockers.append('market_risk_twii_close_missing')
    if previous_close is None or previous_close <= 0:
        blockers.append('market_risk_previous_twii_close_missing')
    advance_ratio = _finite(breadth.get('advance_ratio')) if breadth else None
    if advance_ratio is None or advance_ratio < 0 or advance_ratio > 1:
        blockers.append('market_breadth_advance_ratio_missing')
    if latest is not None and normalize_level(latest.get('risk_level')) is None:
        blockers.append('market_risk_level_invalid')
    caps = [_finite(policy.get(level + 'TargetExposure')) for level in reversed(LEVELS)]  # black .. green
    if any(c is None or c < 0 or c > 1 for c in caps) or any(caps[i] < caps[i - 1] for i in range(1, len(caps))):
        blockers.append('risk_exposure_policy_invalid')
    change = None
    if current_close and previous_close and current_close > 0 and previous_close > 0:
        change = (current_close / previous_close - 1) * 100
    shock = None
    if change is not None:
        ratio = change / 100
        shock = ('black' if ratio <= policy['marketShockBlackPct'] else 'red' if ratio <= policy['marketShockRedPct']
                 else 'orange' if ratio <= policy['marketShockOrangePct'] else None)
    breadth_level = None
    if advance_ratio is not None and 0 <= advance_ratio <= 1:
        breadth_level = ('black' if advance_ratio <= policy['breadthBlackAdvanceRatio']
                         else 'red' if advance_ratio <= policy['breadthRedAdvanceRatio']
                         else 'orange' if advance_ratio <= policy['breadthOrangeAdvanceRatio'] else None)
    level = _max_level([regime_level, shock, breadth_level])
    ready = not blockers
    return MarketRiskContext(
        status='ready' if ready else 'blocked', date=risk_date, level=level if ready else 'black',
        target_exposure=_target_exposure(level, policy) if ready else None,
        breadth_level=breadth_level, shock_level=shock, regime_level=regime_level,
        daily_change_pct=change, advance_ratio=advance_ratio,
        blockers=tuple(dict.fromkeys(blockers)), approximations=tuple(approximations))


# ── layer results ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class LayerResult:
    layer: str
    halt: bool
    max_position_pct: float
    reason: str


def p1_drawdown(equity: list[float], circuit: dict) -> Optional[LayerResult]:
    """p1Mdd.ts: the latest 30 daily snapshots, newest first; fewer than 3 -> no check."""
    values = list(equity)[-30:]
    if len(values) < 3:
        return None
    current, peak = values[-1], max(values)
    drawdown = (peak - current) / peak if peak > 0 else 0.
    base = _circuit_number(circuit, 'maxPositionPct')
    halt_at = _circuit_number(circuit, 'drawdownHalt')
    if drawdown > halt_at:
        return LayerResult('P1', True, 0., f'drawdown {drawdown:.4f} > drawdownHalt {halt_at}')
    start = _circuit_number(circuit, 'drawdownScaleStart')
    if drawdown > start:
        mult = max(_circuit_number(circuit, 'mddMultFloor'), (halt_at - drawdown) / (halt_at - start))
        return LayerResult('P1', False, base * mult, f'drawdown {drawdown:.4f} scale {mult:.4f}')
    return None


def p3_p4_market(ctx: MarketRiskContext, circuit: dict) -> Optional[LayerResult]:
    """canonicalMarketRestriction: P3 and P4 merged by minimum, halt if either halts."""
    base = _circuit_number(circuit, 'maxPositionPct')
    scales = position_scales(circuit)
    high_vol_legacy = None if scales else _circuit_number(circuit, 'highVolReducedPosPct')
    states: list[tuple[str, bool, float, str]] = []
    if ctx.status == 'blocked':
        states.append(('P3', True, 0., 'blocked:' + ','.join(ctx.blockers)))
        breadth_blockers = [b for b in ctx.blockers if 'breadth' in b]
        if breadth_blockers:
            states.append(('P4', True, 0., 'blocked:' + ','.join(breadth_blockers)))
    else:
        if ctx.level == 'black':
            states.append(('P3', True, 0., 'level black'))
        elif ctx.level == 'red':
            states.append(('P3', False, min(base, base * scales['highVol'] * scales['severeHighVol'] if scales
                                           else high_vol_legacy * LEGACY_SEVERE_HIGH_VOL_FACTOR), 'level red'))
        elif ctx.level == 'orange':
            states.append(('P3', False, min(base, base * scales['highVol'] if scales else high_vol_legacy), 'level orange'))
        if ctx.breadth_level:
            severe = ctx.breadth_level in ('red', 'black')
            if scales:
                cap = base * scales['highVol'] * (scales['severeHighVol'] if severe else 1)
            else:
                cap = high_vol_legacy * LEGACY_SEVERE_HIGH_VOL_FACTOR if severe else high_vol_legacy
            states.append(('P4', False, min(base, cap), 'breadth ' + ctx.breadth_level))
    if not states:
        return None
    return LayerResult('P3', any(s[1] for s in states), min(s[2] for s in states),
                       ' | '.join(f'{s[0]}: {s[3]}' for s in states))


def replay_exit_is_stopout(exit_reason: str) -> bool:
    """Replay stop exits are Paper's risk_stop intent (hard_stop category)."""
    from services.backtest_engine import _exit_category
    return _exit_category(exit_reason) in ('HardStop', 'TrailStop')


def p5_losses(sells: list[dict], circuit: dict) -> Optional[LayerResult]:
    """p5Losses.ts latest-five-sell channel: >=3 stop-outs, all losses -> scale.

    `sells` are the replay's sell records before the entry session, oldest
    first, each {'exit_reason', 'pnl'}. Manual rearms are not modeled.
    """
    if (circuit or {}).get('lossGuard') is not None:
        raise ValueError('paper_risk_p5_loss_guard_unmodeled')
    recent = list(sells)[-5:]
    if len(recent) < 3:
        return None
    stops = [s for s in recent if replay_exit_is_stopout(s['exit_reason']) and _finite(s.get('pnl')) is not None]
    losses = [s for s in stops if s['pnl'] < 0]
    if len(stops) < 3 or len(losses) < 3:
        return None
    scales = position_scales(circuit)
    scale = scales['lossStreak'] if scales else LEGACY_P5_LOSS_POSITION_SCALE
    return LayerResult('P5', False, _circuit_number(circuit, 'maxPositionPct') * scale,
                       f'{len(losses)}/{len(stops)} recent stop-outs lost; scale {scale}')


def current_momentum_zone(rows: list[dict], *, session: str, cutoff: datetime) -> tuple[str, Optional[str]]:
    """momentumZone.readCurrentZone as of the open: only the current pool definition counts.

    The table is keyed by date and rewritten; a row rewritten after the cutoff is
    invisible and the previous visible row stands (conservative approximation).
    """
    visible = [row for row in rows if row.get('pool_definition') == MOMENTUM_POOL_DEFINITION]
    visible = _visible(visible, session=session, cutoff=cutoff, clock='created_at')
    if not visible:
        return 'GREEN', None
    zone = str(visible[0].get('zone') or '').upper()
    return (zone if zone in ('RED', 'YELLOW') else 'GREEN'), str(visible[0]['date'])


def p6_momentum(zone: str, circuit: dict) -> Optional[LayerResult]:
    if zone == 'GREEN':
        return None
    scales = position_scales(circuit)
    mult = scales['momentumZone'][zone] if scales else LEGACY_ZONE_MULTIPLIER[zone]
    return LayerResult('P6', False, _circuit_number(circuit, 'maxPositionPct') * mult, f'momentum zone {zone}')


def ensemble_identity(forecast: Any) -> Optional[tuple]:
    ensemble = (forecast or {}).get('ensemble_v2') if isinstance(forecast, dict) else None
    if not isinstance(ensemble, dict) or any(not ensemble.get(name) for name in P7_IDENTITY_FIELDS):
        return None
    return tuple(str(ensemble[name]) for name in P7_IDENTITY_FIELDS)


def p7_streak(rows: list[dict], *, identity: Optional[tuple], entry_date: str, cutoff: datetime,
              circuit: dict) -> Optional[LayerResult]:
    """p7Streak.ts: five non-overlapping mature date cohorts of the current ensemble, >=4 wrong -> scale.

    The live pointer has no history; `identity` is the ensemble identity of the
    newest ensemble prediction published before the open (approximation).
    """
    if identity is None:
        return None
    latest: dict[tuple, dict] = {}
    for row in rows:
        verified, generated = _instant(row.get('verified_at')), _instant(row.get('generated_at'))
        if (row.get('model_name') != 'ensemble' or row.get('direction_correct') not in (0, 1)
                or verified is None or generated is None or verified > cutoff or generated > cutoff
                or str(row.get('verification_label_known_date') or '9999') > entry_date
                or str(row.get('verification_label_end_date') or '9999') > entry_date
                or not str(row.get('prediction_date') or '') < str(row.get('verification_label_end_date') or '')
                or row.get('verification_label_schema_version') != P7_LABEL_SCHEMA
                or _finite(row.get('forecast_horizon_bars')) != 5
                or tuple(str(row.get('ensemble_' + name) or '') for name in P7_IDENTITY_FIELDS) != identity):
            continue
        key = (str(row['prediction_date']), row.get('stock_id'))
        rank = (generated, row.get('id') or 0)
        if key not in latest or rank > latest[key]['_rank']:
            latest[key] = {**row, '_rank': rank}
    by_date: dict[str, list[dict]] = {}
    for row in latest.values():
        by_date.setdefault(str(row['prediction_date']), []).append(row)
    cohorts = sorted(({'date': date, 'end_date': max(str(r['verification_label_end_date']) for r in group),
                       'accuracy': sum(r['direction_correct'] for r in group) / len(group)}
                      for date, group in by_date.items()), key=lambda c: c['date'], reverse=True)[:100]
    chosen: list[dict] = []
    for cohort in cohorts:
        if chosen and cohort['end_date'] >= chosen[-1]['date']:
            continue
        chosen.append(cohort)
        if len(chosen) == 5:
            break
    if len(chosen) < 5:
        return None
    wrong = sum(1 - c['accuracy'] for c in chosen)
    if wrong < 4:
        return None
    scale = _circuit_number(circuit, 'layer7ScaleRatio')
    if scale < 0 or scale > 1:
        raise ValueError('p7_scale_invalid')
    return LayerResult('P7', False, _circuit_number(circuit, 'maxPositionPct') * scale, f'streak {wrong:.2f}/5 wrong')


def p8_daily_loss(*, previous_nav: Optional[float], current_nav: Optional[float], policy: dict) -> Optional[LayerResult]:
    """p8DailyPnl.ts with the entry-time context: NAV at the entry open vs the previous close."""
    if previous_nav is None or previous_nav <= 0 or current_nav is None:
        return None
    if not math.isfinite(current_nav) or current_nav <= 0:
        raise ValueError('daily_pnl_context_invalid')
    pnl = current_nav - previous_nav
    hit_abs = pnl <= policy['dailyPnlLossLimit']
    hit_pct = pnl / previous_nav <= policy['dailyPnlLossLimitPct']
    if not hit_abs and not hit_pct:
        return None
    return LayerResult('P8', True, 0., f'daily pnl {pnl:.0f} ({pnl / previous_nav:.4f})')


# ── aggregation ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class PaperRiskState:
    halt: bool
    max_position_pct: float
    baseline_position_pct: float
    target_exposure: Optional[float]
    market: Optional[MarketRiskContext]
    triggered_layers: tuple[str, ...]
    reasons: tuple[str, ...]
    unmodeled: tuple[str, ...] = field(default=UNMODELED_LAYERS + tuple('P3:' + b for b in UNMODELED_MARKET_BLOCKERS))
    approximations: tuple[str, ...] = ()

    @property
    def name_cap_scale(self) -> float:
        """riskPositionSizing.resolveCircuitAdjustedSingleNameCap's circuit ratio."""
        if self.halt or self.baseline_position_pct <= 0 or self.max_position_pct <= 0:
            return 0.
        return min(1., self.max_position_pct / self.baseline_position_pct)

    @property
    def exposure_cap(self) -> float:
        """l4AccountContext: halt -> 0, else the market cap."""
        return 0. if self.halt or self.target_exposure is None else self.target_exposure


def aggregate(results: Iterable[Optional[LayerResult]], *, circuit: dict, market: Optional[MarketRiskContext],
              approximations: Iterable[str] = ()) -> PaperRiskState:
    base = _circuit_number(circuit, 'maxPositionPct')
    fired = [r for r in results if r is not None]
    halt = any(r.halt for r in fired)
    cap = min([base, *(r.max_position_pct for r in fired)])
    return PaperRiskState(
        halt=halt, max_position_pct=0. if halt else cap, baseline_position_pct=base,
        target_exposure=market.target_exposure if market is not None else None, market=market,
        triggered_layers=tuple(r.layer for r in fired), reasons=tuple(f'[{r.layer}] {r.reason}' for r in fired),
        approximations=tuple(dict.fromkeys([*(market.approximations if market else ()), *approximations])))


# ── one entry session ─────────────────────────────────────────────────────────

P7_REQUIRED_COLUMNS = frozenset({
    'model_name', 'stock_id', 'prediction_date', 'generated_at', 'verified_at', 'direction_correct',
    'verification_label_known_date', 'verification_label_end_date', 'verification_label_schema_version',
    'forecast_horizon_bars', *('ensemble_' + name for name in P7_IDENTITY_FIELDS)})


def replay_morning_state(*, decision_date: str, entry_date: str, circuit: dict, policy: dict,
                         market_risk_rows: list[dict], breadth_rows: list[dict], regime_state: Optional[dict],
                         hmm_era: bool, equity: list[float], sells: list[dict],
                         momentum_rows: Optional[list[dict]], verified_rows: Optional[list[dict]],
                         identity: Optional[tuple], previous_nav: Optional[float],
                         current_nav: Optional[float]) -> PaperRiskState:
    """Paper's checks for the session `entry_date`, decided after `decision_date`'s close.

    Inputs the sealed snapshot does not carry are named, never assumed green:
    no momentum component -> P6 not evaluated; verified rows without the
    ensemble identity columns, or no ensemble identity before the open -> P7
    not evaluated.
    """
    from services.backtest_state import entry_open
    cutoff = entry_open(entry_date)
    approximations: list[str] = []
    market = canonical_market_risk(session=decision_date, cutoff=cutoff, market_risk_rows=market_risk_rows,
                                   breadth_rows=breadth_rows, regime_state=regime_state, hmm_era=hmm_era,
                                   policy=policy)
    results = [p1_drawdown(equity, circuit), p3_p4_market(market, circuit), p5_losses(sells, circuit)]
    if momentum_rows is None:
        approximations.append('p6_momentum_component_missing')
    else:
        zone, _ = current_momentum_zone(momentum_rows, session=decision_date, cutoff=cutoff)
        results.append(p6_momentum(zone, circuit))
    if verified_rows is None or (verified_rows and not P7_REQUIRED_COLUMNS <= set(verified_rows[0])):
        approximations.append('p7_verified_columns_missing')
    elif identity is None:
        approximations.append('p7_ensemble_identity_unavailable')
    else:
        results.append(p7_streak(verified_rows, identity=identity, entry_date=entry_date, cutoff=cutoff,
                                 circuit=circuit))
    if previous_nav is not None and current_nav is None:
        approximations.append('p8_open_mark_missing')
    results.append(p8_daily_loss(previous_nav=previous_nav, current_nav=current_nav, policy=policy))
    return aggregate(results, circuit=circuit, market=market, approximations=approximations)


def state_record(state: PaperRiskState, entry_date: str) -> dict:
    """The per-session audit line, comparable with Paper's risk_audit_log morning_setup."""
    return {'entry_date': entry_date, 'halt': state.halt, 'max_position_pct': state.max_position_pct,
            'name_cap_scale': state.name_cap_scale, 'target_exposure': state.target_exposure,
            'exposure_cap': state.exposure_cap,
            'level': state.market.level if state.market else None,
            'market_status': state.market.status if state.market else None,
            'market_blockers': list(state.market.blockers) if state.market else [],
            'triggered_layers': list(state.triggered_layers), 'reasons': list(state.reasons),
            'approximations': list(state.approximations)}


def summarize(records: list[dict]) -> dict:
    """Replay-level summary: what ran, what was approximated, what is not simulated."""
    layers: dict[str, int] = {}
    approximations: dict[str, int] = {}
    for record in records:
        for layer in dict.fromkeys(record['triggered_layers']):
            layers[layer] = layers.get(layer, 0) + 1
        for item in record['approximations']:
            approximations[item] = approximations.get(item, 0) + 1
    return {'sessions': len(records), 'halt_sessions': sum(1 for r in records if r['halt']),
            'layer_trigger_sessions': dict(sorted(layers.items())),
            'approximation_sessions': dict(sorted(approximations.items())),
            'unmodeled': list(PaperRiskState.__dataclass_fields__['unmodeled'].default),
            'not_simulated': 'deRisk 未模擬（SELL 側減碼，延到 R33 恢復 SELL；Wei 10/30 §5-5）',
            'records': records}
