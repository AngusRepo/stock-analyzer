import {
  aggregateCompletedS12Bars,
  applyS12TakeoverContinuity,
  assessS12IntradayStructure,
  assessS12IntradayStructureFromBaseBars,
  buildS12LongPositionStopPlan,
  isS12ExecutableLongAssessment,
  isS12HardVetoAssessment,
  isS12PrimaryOwnerBlockingAssessment,
  resolveS12PositionDecision,
  resolveS12UnifiedDecision,
  s12TimingPolicyFromEnv,
  s12PreTradeTechnicalDecision,
  type S12Bar,
} from './s12IntradayStructure'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const M15 = 15 * 60_000
const H1 = 60 * 60_000
const H4 = 4 * 60 * 60_000
const baseMs = Date.parse('2026-06-26T01:00:00.000Z')

function bar(startOffsetMs: number, open: number, high: number, low: number, close: number, volume = 100): S12Bar {
  return {
    startMs: baseMs + startOffsetMs,
    open,
    high,
    low,
    close,
    volume,
  }
}

{
  const baseBars = [
    bar(0, 100, 101, 99, 100.5),
    bar(5 * 60_000, 100.5, 102, 100, 101.8),
    bar(15 * 60_000, 101.8, 103, 101, 102.5),
  ]
  const completed = aggregateCompletedS12Bars(baseBars, M15, baseMs + 30 * 60_000)
  assert(completed.length === 2, '15m aggregation must include only completed buckets')
  assert(completed[0].open === 100 && completed[0].close === 101.8, 'first completed 15m bucket should preserve OHLC order')
  assert(completed[1].open === 101.8 && completed[1].close === 102.5, 'second completed 15m bucket should be closed at nowMs')
}

{
  const baseBars = [
    bar(0, 100, 101, 99, 100.5),
    bar(H1, 100.5, 103, 100, 102.5),
    bar(2 * H1, 102.5, 105, 102, 104.5),
    bar(3 * H1, 104.5, 106, 104, 105.5),
  ]
  const completed = aggregateCompletedS12Bars(baseBars, H4, baseMs + 4 * H1 + M15, { alignToTwSession: true })
  assert(completed.length === 1, 'TW session-aware 4H aggregation should include the completed 09:00-13:00 bucket')
  assert(completed[0].startMs === baseMs, 'TW session-aware 4H bucket should align to 09:00 Taipei session open')
  assert(completed[0].open === 100 && completed[0].close === 105.5, 'TW session-aware 4H bucket should preserve OHLC order')
}

{
  const currentBars = Array.from({ length: 8 }, (_, i) =>
    bar(i * M15, 108 + i * 0.1, 109 + i * 0.1, 107 + i * 0.1, 108.5 + i * 0.1, 100),
  )
  const fallback4h = [{
    startMs: Date.parse('2026-06-25T01:00:00.000Z'),
    open: 100,
    high: 110,
    low: 98,
    close: 108,
    volume: 1000,
  }]
  const assessment = assessS12IntradayStructureFromBaseBars({
    symbol: '2330',
    baseBars: currentBars,
    fallback4hBars: fallback4h,
    nowMs: baseMs + 2 * H1,
    barDiagnostics: { raw_kbars_count: 8, parsed_kbars_count: 8 },
    h4ReferenceDate: '2026-06-25',
    h4ReferenceClose: 108,
  })
  assert(assessment.h4Source === 'previous_trading_day_fallback', 'S12 should use previous trading day 4H fallback before current 4H completes')
  assert(assessment.completedBars.h4 === 1, 'previous trading day 4H fallback should satisfy the 4H anchor requirement')
  assert(assessment.state !== 'waiting_4h_completed_bar', 'previous 4H fallback must prevent opening-session 4H deadlock')
  assert(assessment.detail.includes('h4_source=previous_trading_day_fallback'), 'S12 detail should expose h4 fallback source')
  assert(assessment.detail.includes('raw_kbars_count=8'), 'S12 detail should expose kbar diagnostics')
}

{
  const bars4h = [
    bar(-2 * H4, 98, 102, 96, 101, 1000),
    bar(-1 * H4, 101, 108, 100, 107, 1200),
  ]
  const bars1h = [
    bar(-2 * H1, 100, 103, 99, 102, 500),
    bar(-1 * H1, 102, 106, 101, 105, 700),
  ]
  const bars15m = Array.from({ length: 10 }, (_, i) =>
    bar(i * M15, 102 + i * 0.2, 103 + i * 0.25, 101.8 + i * 0.15, 102.5 + i * 0.25, 100 + i * 20),
  )
  const assessment = assessS12IntradayStructure({
    symbol: '2330',
    bars15m,
    bars1h,
    bars4h,
  })
  assert(assessment.quality.vwapContext.schemaVersion === 's12_vwap_context_v1', 'S12 should expose VWAP+ context contract')
  assert(assessment.quality.vwapContext.session.value != null, 'S12 VWAP+ context should include session VWAP')
  assert(assessment.quality.vwapContext.anchored.day.value != null, 'S12 VWAP+ context should include anchored day VWAP')
  assert(assessment.quality.vwapContext.anchored.week.value != null, 'S12 VWAP+ context should include anchored week VWAP')
  assert(assessment.quality.vwapContext.rolling15m.bars7.value != null, 'S12 VWAP+ context should include rolling 15m VWAP')
  assert(assessment.quality.vwapContext.rollingDays.days7.value != null, 'S12 VWAP+ context should include rolling day VWAP')
  assert(assessment.detail.includes('vwap_context_schema=s12_vwap_context_v1'), 'S12 detail should expose VWAP+ schema')
  assert(assessment.detail.includes('vwap_anchor_day='), 'S12 detail should expose anchored VWAP values')
  assert(assessment.detail.includes('vwap_rolling_7d='), 'S12 detail should expose rolling-day VWAP values')
  assert(assessment.detail.includes('ib_state='), 'S12 detail should expose initial-balance state')
}

{
  const previous15m = Array.from({ length: 16 }, (_, i) =>
    bar(-24 * H1 + i * M15, 98 + i * 0.1, 99 + i * 0.15, 97 + i * 0.1, 98.5 + i * 0.1, 100 + i),
  )
  const current15m = [
    bar(0, 101.0, 101.5, 100.8, 101.2, 300),
  ]
  const fallback4h = [
    bar(-24 * H1, 96, 103, 95, 102, 1000),
  ]
  const assessment = assessS12IntradayStructureFromBaseBars({
    symbol: '2330',
    baseBars: current15m,
    fallback15mBars: previous15m,
    fallback4hBars: fallback4h,
    fallback1hBars: previous15m,
    nowMs: baseMs + M15 + 60_000,
    h4ReferenceDate: '2026-07-03',
    h4ReferenceClose: 102,
  })
  assert(assessment.state !== 'waiting_15m_completed_bars', 'previous-session 15m seed should prevent full 15m maturity reset after the first current bar')
  assert(assessment.state !== 'reaction_ready', 'previous-session 15m seed must not trigger a same-day buy without a current-session sequence')
  assert(assessment.detail.includes('previous_session_15m_seed_bars=16'), 'S12 detail should expose previous-session 15m seed count')
  assert(assessment.detail.includes('seeded_context_15m_bars=17'), 'S12 detail should expose combined seeded 15m context count')
}

{
  const policy = s12TimingPolicyFromEnv({
    S12_INTRADAY_MIN_15M_BARS: '2',
    S12_INTRADAY_ATR_15M_BARS: '99',
    S12_INTRADAY_SWING_LOOKBACK_BARS: '1',
    S12_INTRADAY_BOS_WAIT_BARS: '50',
    S12_INTRADAY_SR_PIVOT_LEN: '10',
    S12_INTRADAY_OB_LOOKBACK_BARS: '34',
    S12_INTRADAY_MIN_FVG_ATR: '0.08',
    S12_INTRADAY_TRIGGER_MODE: 'reaction_close',
    S12_INTRADAY_PREVIOUS_SESSION_FAST_MATURITY_ENABLED: 'false',
    S12_INTRADAY_PREVIOUS_SESSION_MIN_15M_BARS: '2',
    S12_POSITION_STOP_SOURCE: '15m_recent_fvg',
    S12_POSITION_PLANNED_TP: 'tp4',
    S12_POSITION_MANUAL_TP_PRICE: '123.4',
  })
  assert(policy.min15mBars === 3, 'S12 min 15m bars must clamp to the FVG-compatible lower bound')
  assert(policy.seededFastMaturityEnabled === false, 'S12 previous-session fast maturity should be env-configurable')
  assert(policy.seededMin15mBars === 3, 'S12 previous-session seed min 15m bars must clamp to the FVG-compatible lower bound')
  assert(policy.atr15mBars === 30, 'S12 ATR period should clamp unsafe large env overrides')
  assert(policy.swingLookbackBars === 2, 'S12 swing lookback should clamp below community-style pivot minimum')
  assert(policy.bosWaitBars === 50, 'S12 BOS wait should accept bounded env overrides')
  assert(policy.srPivotLen === 10, 'S12 S/R pivot window should be env-configurable')
  assert(policy.obLookbackBars === 34, 'S12 order-block lookback should be env-configurable')
  assert(policy.minFvgAtr === 0.08, 'S12 FVG minimum ATR ratio should be env-configurable')
  assert(policy.triggerMode === 'reaction_close', 'S12 trigger mode should be env-configurable')
  assert(policy.positionStopSource === '15m_recent_fvg', 'S12 position stop source should be env-configurable')
  assert(policy.plannedTakeProfit === 'tp4', 'S12 planned TP should be env-configurable')
  assert(policy.manualTakeProfitPrice === null, 'S12 manual TP env override must be disabled for automated trading')
}

{
  const positionBars = [
    bar(0 * M15, 100.0, 100.0, 99.0, 99.5),
    bar(1 * M15, 99.5, 101.0, 98.5, 100.0),
    bar(2 * M15, 100.0, 103.0, 99.5, 101.0),
    bar(3 * M15, 101.0, 101.0, 98.0, 99.0),
    bar(4 * M15, 99.0, 100.0, 97.5, 98.5),
    bar(5 * M15, 99.5, 100.5, 98.0, 99.0),
    bar(6 * M15, 99.0, 104.2, 101.0, 104.0),
  ]
  const sharedPolicy = {
    swingLookbackBars: 2,
    obLookbackBars: 4,
    minFvgAtr: 0.01,
    maxVisibleZones: 3,
  }
  const protectedLow = buildS12LongPositionStopPlan({
    bars15m: positionBars,
    entryPrice: 104.5,
    policy: sharedPolicy,
    stopSource: '15m_protected_low',
  })
  assert(protectedLow?.price === 97.5, 'Pine-style S12 position stop should use confirmed 15m protected low without ATR buffer')
  assert(protectedLow?.noAtrBuffer === true, 'S12 position stop must explicitly expose no-ATR Pine parity')

  const fvgBars = [
    bar(0 * M15, 100.0, 100.5, 99.0, 100.0),
    bar(1 * M15, 100.0, 101.0, 99.5, 100.5),
    bar(2 * M15, 103.0, 104.0, 103.0, 103.5),
  ]
  const fvg = buildS12LongPositionStopPlan({
    bars15m: fvgBars,
    entryPrice: 104,
    policy: sharedPolicy,
    stopSource: '15m_recent_fvg',
  })
  assert(fvg?.price === 103, `Pine-style S12 FVG stop should use bullish FVG upper edge, got ${fvg?.price}`)
  assert(fvg?.zoneLow === 100.5 && fvg.zoneHigh === 103, 'S12 FVG stop should expose the active 15m FVG zone')

  const trailingFvg = buildS12LongPositionStopPlan({
    bars15m: fvgBars,
    entryPrice: 100,
    referencePrice: 104,
    policy: sharedPolicy,
    stopSource: '15m_recent_fvg',
  })
  assert(trailingFvg?.price === 103, 'S12 position stop should trail to the latest valid 15m FVG below current price, even above entry')

  const orderBlock = buildS12LongPositionStopPlan({
    bars15m: positionBars,
    entryPrice: 104.5,
    policy: sharedPolicy,
    stopSource: '15m_order_block',
  })
  assert(orderBlock?.price === 99, `Pine-style S12 OB stop should use bullish OB lower edge, got ${orderBlock?.price}`)

  const adaptive = buildS12LongPositionStopPlan({
    bars15m: fvgBars,
    entryPrice: 104,
    policy: sharedPolicy,
    stopSource: 'adaptive',
  })
  assert(adaptive?.source === '15m_recent_fvg', 'S12 adaptive position stop should choose the nearest valid 15m structure below reference price')
}

{
  const assessment = assessS12IntradayStructure({
    symbol: '2330',
    bars15m: [bar(5 * H1, 103, 104, 100, 101), bar(5 * H1 + M15, 101, 102, 99, 100)],
    bars1h: [],
    bars4h: [],
  })
  assert(assessment.state === 'waiting_15m_completed_bars', 'S12 should fail closed when 15m completed bars are insufficient')
  assert(!assessment.ready, 'insufficient bars must not be marked ready')
  assert(
    s12PreTradeTechnicalDecision(assessment, 'assist_entry') === null,
    'assist_entry mode should not defer while S12 is still waiting for maturity',
  )
  assert(assessment.detail.includes('policy_min15m_bars=4'), 'S12 detail must expose the effective timing policy')
}

{
  const assessment = assessS12IntradayStructure({
    symbol: '2330',
    bars15m: [
      bar(5 * H1, 103, 104, 100, 101),
      bar(5 * H1 + M15, 101, 102, 99, 100),
      bar(5 * H1 + 2 * M15, 100, 102, 99, 101),
    ],
    bars1h: [],
    bars4h: [],
  })
  assert(assessment.state === 'waiting_15m_completed_bars', 'S12 should still require four completed 15m bars when no previous-session 1H seed exists')
  assert(assessment.detail.includes('effective_min15m_bars=4'), 'S12 detail should expose the non-seeded effective 15m gate')
  assert(assessment.detail.includes('previous_session_1h_seed_candidate=false'), 'S12 detail should expose missing previous-session seed')
}

{
  const assessment = assessS12IntradayStructure({
    symbol: '2330',
    bars15m: [
      bar(5 * H1, 103, 104, 100, 101),
      bar(5 * H1 + M15, 101, 102, 99, 100),
      bar(5 * H1 + 2 * M15, 100, 102, 99, 101),
      bar(5 * H1 + 3 * M15, 101, 103, 100, 102),
    ],
    bars1h: [],
    bars4h: [],
  })
  assert(assessment.state !== 'waiting_15m_completed_bars', 'S12 should stop waiting for 15MK after four completed 15m bars')
}

{
  const assessment = assessS12IntradayStructure({
    symbol: '2330',
    bars15m: [
      bar(5 * H1, 103, 104, 100, 101),
      bar(5 * H1 + M15, 101, 102, 99, 100),
      bar(5 * H1 + 2 * M15, 100, 102, 99, 101),
    ],
    bars1h: [],
    bars4h: [],
    policy: { min15mBars: 3 },
  })
  assert(assessment.state !== 'waiting_15m_completed_bars', 'S12 min 15m bars should be policy-configurable')
  assert(assessment.detail.includes('policy_min15m_bars=3'), 'S12 detail should expose overridden min 15m bars')
}

{
  const bars4h = [{
    startMs: Date.parse('2026-06-25T01:00:00.000Z'),
    open: 100,
    high: 110,
    low: 90,
    close: 100,
    volume: 1000,
  }]
  const bars1h = [
    bar(H4, 100, 105, 99, 104, 500),
  ]
  const bars15m = [
    bar(H4 + H1 + 0 * M15, 103.0, 104.0, 101.0, 102.0),
    bar(H4 + H1 + 1 * M15, 102.0, 103.0, 100.5, 101.2),
    bar(H4 + H1 + 2 * M15, 101.2, 102.5, 100.8, 102.0),
    bar(H4 + H1 + 3 * M15, 102.0, 103.5, 101.8, 103.0),
  ]
  const assessment = assessS12IntradayStructure({
    symbol: '2330',
    bars15m,
    bars1h,
    bars4h,
    h4Source: 'previous_trading_day_fallback',
    h4ReferenceDate: '2026-06-25',
    h4ReferenceClose: 100,
  })
  assert(assessment.h4Source === 'previous_trading_day_fallback', 'S12 should preserve previous-day 4H fallback source')
  assert(assessment.bias4h.direction !== 'long', 'fixture should exercise neutral fallback 4H context')
  assert(assessment.state !== 'waiting_4h_long_bias', 'previous-day 4H fallback must be context only, not a hard long-bias gate')
  assert(assessment.detail.includes('h4_fallback_bias_mode=context_only'), 'S12 detail should explain fallback 4H bias is context-only')
}

{
  const bars4h = [
    bar(0, 100, 110, 98, 108, 1000),
  ]
  const fallback1hBars = [
    {
      startMs: Date.parse('2026-06-25T01:00:00.000Z'),
      open: 100,
      high: 105,
      low: 98,
      close: 104,
      volume: 500,
    },
  ]
  const bars15m = [
    bar(H4 + H1 + 0 * M15, 106.0, 107.0, 105.0, 106.5),
    bar(H4 + H1 + 1 * M15, 106.5, 107.2, 105.5, 106.8),
    bar(H4 + H1 + 2 * M15, 106.8, 107.5, 106.0, 107.0),
    bar(H4 + H1 + 3 * M15, 107.0, 107.6, 106.2, 107.2),
  ]
  const assessment = assessS12IntradayStructure({
    symbol: '2330',
    bars15m,
    bars1h: [],
    bars4h,
    fallback1hBars,
  })
  assert(assessment.state !== 'waiting_1h_completed_bar', 'S12 should use previous-session 1H zone seed instead of blocking early session')
  assert(assessment.demandZone1h != null, 'previous-session 1H seed should provide a demand/support zone')
  assert(assessment.detail.includes('demand_zone_source=previous_session_1h'), 'S12 detail should expose previous-session demand-zone source')
  assert(assessment.detail.includes('fallback_1h_completed_bars=1'), 'S12 detail should expose fallback 1H bar count')
}

{
  const bars4h = [
    bar(0, 100, 110, 98, 108, 1000),
  ]
  const fallback1hBars = [
    bar(H4, 100, 105, 98, 104, 500),
  ]
  const bars15m = [
    bar(H4 + H1 + 0 * M15, 106.0, 107.0, 105.0, 106.5),
    bar(H4 + H1 + 1 * M15, 106.5, 107.2, 105.5, 106.8),
    bar(H4 + H1 + 2 * M15, 106.8, 107.5, 106.0, 107.0),
  ]
  const assessment = assessS12IntradayStructure({
    symbol: '2330',
    bars15m,
    bars1h: [],
    bars4h,
    fallback1hBars,
  })
  assert(assessment.state !== 'waiting_15m_completed_bars', 'previous-session 1H seed should allow S12 to leave the 15m data gate after three completed 15m bars')
  assert(assessment.detail.includes('effective_min15m_bars=3'), 'S12 detail should expose the seeded effective 15m gate')
  assert(assessment.detail.includes('previous_session_1h_seed_candidate=true'), 'S12 detail should expose previous-session seed acceleration')
  assert(assessment.detail.includes('demand_zone_source=previous_session_1h'), 'S12 detail should keep the previous-session demand-zone source')
}

{
  const bars4h = [
    bar(0, 100, 110, 90, 100, 1000),
  ]
  const bars15m = [
    bar(H4 + 0 * M15, 100.0, 100.5, 99.8, 100.2, 100),
    bar(H4 + 1 * M15, 100.2, 100.6, 99.9, 100.1, 120),
    bar(H4 + 2 * M15, 101.2, 102.0, 101.2, 101.8, 150),
    bar(H4 + 3 * M15, 101.8, 102.2, 101.4, 102.0, 180),
    bar(H4 + 4 * M15, 102.0, 103.0, 101.8, 102.8, 220),
    bar(H4 + 5 * M15, 102.8, 103.3, 102.5, 103.0, 240),
    bar(H4 + 6 * M15, 103.0, 106.0, 102.9, 105.8, 600),
  ]
  const assessment = assessS12IntradayStructure({
    symbol: '8091',
    bars15m,
    bars1h: [],
    bars4h,
  })
  assert(assessment.reason === 's12_equity_mutation_context_ready', `equity mutation should replace the 1H-demand hard gate, got ${assessment.reason}: ${assessment.detail}`)
  assert(assessment.state === 'limited_takeover_ready', 'equity mutation should become a limited S12 takeover instead of waiting forever')
  assert(assessment.ready, 'limited takeover must be executable by primary-owner mode')
  assert(assessment.maturity.takeoverRole === 'long_entry', 'limited takeover should expose long-entry ownership')
  assert(assessment.maturity.tier === 'limited_takeover_ready', 'limited takeover should expose an executable reduced-risk tier')
  assert(assessment.maturity.riskMode === 'reduced_size_tight_stop', 'limited takeover must not use full reaction sizing')
  assert(isS12ExecutableLongAssessment(assessment), 'limited takeover should activate executable S12 ownership')
  assert(!isS12HardVetoAssessment(assessment), 'limited takeover must not be treated as a hard veto')
  assert(isS12PrimaryOwnerBlockingAssessment(assessment), 'limited takeover should be a primary-owner blocking assessment')
  assert(assessment.execution.entryPrice === 105.8, 'equity mutation should use latest 15m close as S12 entry reference')
  assert((assessment.execution.stopLoss ?? 0) > 0 && (assessment.execution.stopLoss ?? 999) < 105.8, 'equity mutation must expose a structural S12 stop below entry')
  assert(assessment.exitPlan.trailingStop.source !== 'adaptive', 'equity mutation stop must resolve to a concrete 15m structure source')
  assert(assessment.detail.includes('s12_owner=primary_single_owner'), 'S12 detail should prove no split-owner entry path was introduced')
  assert(assessment.detail.includes('entry_archetype=equity_repricing_breakout'), 'S12 detail should expose the individual-stock mutation archetype')
  assert(assessment.detail.includes('vwap_fast_acceptance=true'), 'individual-stock mutation should use fast VWAP acceptance, not the full slow VWAP stack')
  assert(assessment.detail.includes('one_h_demand_required=false'), '1H demand should become evidence, not a hard gate, under equity mutation')
  assert(resolveS12UnifiedDecision(assessment).action === 'READY', 'S12 unified decision should allow limited takeover through execution gates')
}

{
  const bars4h = [
    bar(0, 100, 110, 90, 100, 1000),
  ]
  const bars1h = [
    bar(H4, 99.0, 103.0, 95.5, 102.0, 500),
  ]
  const bars15m = [
    bar(H4 + 0 * M15, 100.0, 100.5, 99.8, 100.2, 100),
    bar(H4 + 1 * M15, 100.2, 100.6, 99.9, 100.1, 120),
    bar(H4 + 2 * M15, 101.2, 102.0, 101.2, 101.8, 150),
    bar(H4 + 3 * M15, 101.8, 102.2, 101.4, 102.0, 180),
    bar(H4 + 4 * M15, 102.0, 103.0, 101.8, 102.8, 220),
    bar(H4 + 5 * M15, 102.8, 103.3, 102.5, 103.0, 240),
    bar(H4 + 6 * M15, 103.0, 106.0, 102.9, 105.8, 600),
  ]
  const assessment = assessS12IntradayStructure({
    symbol: '8091',
    bars15m,
    bars1h,
    bars4h,
  })
  assert(assessment.demandZone1h != null, 'fixture must contain a 1H demand zone that would previously divert to strict SMC sequence')
  assert(assessment.reason === 's12_equity_mutation_context_ready', `active equity mutation must not be blocked by an existing 1H demand zone, got ${assessment.reason}: ${assessment.detail}`)
  assert(assessment.state === 'limited_takeover_ready', `equity mutation should become limited takeover, got ${assessment.state}: ${assessment.detail}`)
  assert(assessment.ready, 'limited takeover should be executable by the S12 primary owner')
  assert(assessment.maturity.tier === 'limited_takeover_ready', 'equity mutation should expose a limited takeover tier')
  assert(assessment.maturity.riskMode === 'reduced_size_tight_stop', 'limited takeover must use reduced sizing with a tight stop')
  assert(assessment.detail.includes('one_h_demand_required=false'), '1H demand should remain evidence-only when equity mutation is active')
  assert(s12PreTradeTechnicalDecision(assessment, 'require_ready')?.action === 'pass', 'S12 primary owner should pass limited takeover')
  assert(resolveS12UnifiedDecision(assessment).action === 'READY', 'limited takeover should reach execution gates with reduced risk mode')
}

{
  const bars4h = [
    bar(0, 100, 112, 98, 109, 1200),
  ]
  const bars1h = [
    bar(H4, 110.0, 111.0, 104.0, 105.0, 600),
    bar(H4 + H1, 105.0, 106.0, 99.5, 101.0, 800),
  ]
  const bars15m = [
    bar(H4 + 2 * H1 + 0 * M15, 100.0, 100.7, 99.7, 100.2, 120),
    bar(H4 + 2 * H1 + 1 * M15, 100.2, 101.0, 99.9, 100.5, 140),
    bar(H4 + 2 * H1 + 2 * M15, 100.5, 101.2, 100.1, 100.8, 160),
    bar(H4 + 2 * H1 + 3 * M15, 100.8, 101.6, 100.5, 101.2, 180),
    bar(H4 + 2 * H1 + 4 * M15, 101.2, 102.0, 101.0, 101.7, 220),
    bar(H4 + 2 * H1 + 5 * M15, 101.7, 102.5, 101.4, 102.1, 260),
    bar(H4 + 2 * H1 + 6 * M15, 102.1, 105.8, 102.0, 105.4, 900),
  ]
  const assessment = assessS12IntradayStructure({
    symbol: '6257',
    bars15m,
    bars1h,
    bars4h,
  })
  assert(assessment.reason === 's12_equity_mutation_context_ready', `1H short should be a risk haircut, not a hard block for fast individual-stock repricing, got ${assessment.reason}: ${assessment.detail}`)
  assert(assessment.detail.includes('equity_mutation_risk_haircuts=1h_short_risk_haircut'), 'S12 detail should expose 1H short as a risk haircut')
  assert(assessment.detail.includes('vwap_fast_acceptance=true'), 'fast VWAP acceptance should be the entry gate for individual-stock repricing')
  assert(assessment.detail.includes('htf_hard_block=false'), '1H short alone must not become an HTF hard block')
  assert(assessment.state === 'limited_takeover_ready', 'risk-haircut repricing should become limited takeover, not full reaction ready')
  assert(resolveS12UnifiedDecision(assessment).action === 'READY', 'risk-haircut repricing should reach execution gates as limited takeover')
}

{
  const bars4h = [
    bar(0, 100, 110, 90, 100, 1000),
  ]
  const bars15m = [
    bar(H4 + 0 * M15, 105.0, 105.5, 104.0, 104.5, 300),
    bar(H4 + 1 * M15, 104.5, 105.0, 103.8, 104.2, 260),
    bar(H4 + 2 * M15, 104.2, 104.6, 103.6, 103.9, 220),
    bar(H4 + 3 * M15, 103.9, 104.2, 103.2, 103.5, 180),
  ]
  const assessment = assessS12IntradayStructure({
    symbol: '8091',
    bars15m,
    bars1h: [],
    bars4h,
  })
  assert(assessment.state === 'waiting_4h_long_bias' || assessment.state === 'waiting_1h_completed_bar', 'non-mutation individual stocks should still wait inside S12 context gates')
  assert(assessment.maturity.takeoverRole === 'none', 'weak/no-volume context must not become a hidden buy path')
  assert(assessment.detail.includes('equity_mutation_context=false'), 'S12 detail should expose why equity mutation did not activate')
}

{
  const bars4h = [
    bar(0, 100, 110, 98, 108, 1000),
  ]
  const bars1h = [
    bar(H4, 100, 105, 99, 104, 500),
  ]
  const bars15m = [
    bar(H4 + H1 + 0 * M15, 102.0, 102.5, 100.4, 101.5),
    bar(H4 + H1 + 1 * M15, 101.5, 102.2, 100.6, 101.8),
    bar(H4 + H1 + 2 * M15, 101.8, 102.4, 100.7, 102.0),
    bar(H4 + H1 + 3 * M15, 102.0, 102.6, 100.8, 102.1),
  ]
  const assessment = assessS12IntradayStructure({
    symbol: '2330',
    bars15m,
    bars1h,
    bars4h,
  })
  assert(assessment.state === 'waiting_sweep', `expected waiting_sweep context, got ${assessment.state}: ${assessment.detail}`)
  assert(assessment.maturity.tier === 'none', 'S12 zone-touch state must not expose an executable tier')
  assert(assessment.maturity.takeoverRole === 'none', 'S12 waiting_sweep must remain non-executable until reaction_ready')
  assert(assessment.execution.entryPrice != null && assessment.execution.stopLoss != null, 'S12 waiting context may expose a risk box for audit only')
  assert(assessment.detail.includes('maturity_tier=none'), 'S12 detail should expose non-executable maturity tier')
  assert(s12PreTradeTechnicalDecision(assessment, 'require_ready')?.action === 'defer', 'S12 primary owner must defer waiting_sweep instead of buying early')
  assert(resolveS12UnifiedDecision(assessment).action === 'WAIT', 'S12 unified decision must not allow waiting_sweep to reach execution gates')
}

{
  const bars4h = [
    bar(0, 100, 110, 98, 108, 1000),
  ]
  const bars1h = [
    bar(H4, 100, 105, 99, 104, 500),
  ]
  const bars15m = [
    bar(H4 + H1 + 0 * M15, 102.0, 102.5, 100.4, 101.5),
    bar(H4 + H1 + 1 * M15, 101.5, 102.2, 100.6, 101.8),
    bar(H4 + H1 + 2 * M15, 101.8, 102.4, 100.7, 102.0),
    bar(H4 + H1 + 3 * M15, 102.0, 102.6, 100.8, 102.1),
  ]
  const previous = assessS12IntradayStructure({
    symbol: '8091',
    bars15m,
    bars1h,
    bars4h,
  })
  assert(previous.maturity.takeoverRole === 'none', 'fixture must start from a non-executable waiting context')
  const overlappingRegression = {
    ...previous,
    state: 'waiting_15m_zone_touch' as const,
    ready: false,
    reason: 's12_waiting_15m_zone_touch',
    demandZone1h: {
      ...previous.demandZone1h!,
      type: 'bullish_order_block' as const,
      createdMs: previous.demandZone1h!.createdMs + H1,
    },
    sequence: {},
    execution: { atr15m: previous.execution.atr15m },
    maturity: {
      ...previous.maturity,
      takeoverEligible: false,
      takeoverRole: 'none' as const,
      tier: 'none' as const,
      riskMode: 'none' as const,
      blocker: 'waiting_15m_zone_touch' as const,
      stage: 'setup' as const,
    },
    detail: previous.detail.replace('state=waiting_sweep', 'state=waiting_15m_zone_touch'),
  }
  const notReadyPreserved = applyS12TakeoverContinuity(overlappingRegression, JSON.stringify(previous))
  assert(notReadyPreserved.state === 'waiting_15m_zone_touch', 'overlapping non-ready state must not restore old waiting_sweep as executable continuity')
  assert(notReadyPreserved.maturity.takeoverRole === 'none', 'non-ready continuity must preserve non-executable ownership')
  assert(!notReadyPreserved.detail.includes('takeover_continuity=preserved'), 'non-ready continuity must not be marked preserved')

  const differentZone = {
    ...overlappingRegression,
    demandZone1h: {
      ...overlappingRegression.demandZone1h!,
      low: previous.demandZone1h!.high + 10,
      high: previous.demandZone1h!.high + 12,
    },
  }
  const notPreserved = applyS12TakeoverContinuity(differentZone, JSON.stringify(previous))
  assert(notPreserved.maturity.takeoverRole === 'none', 'different zones must still force a fresh S12 judgment')
}

{
  const bars4h = [
    bar(0, 100, 110, 98, 108, 1000),
  ]
  const bars1h = [
    bar(H4, 100, 105, 99, 104, 500),
  ]
  const bars15m = [
    bar(H4 + H1 + 0 * M15, 102.0, 102.2, 100.5, 101.0),
    bar(H4 + H1 + 1 * M15, 101.0, 101.5, 99.8, 100.2),
    bar(H4 + H1 + 2 * M15, 100.2, 101.0, 98.8, 100.4),
    bar(H4 + H1 + 3 * M15, 100.5, 102.8, 100.4, 102.6),
    bar(H4 + H1 + 4 * M15, 102.6, 103.0, 100.2, 101.0),
    bar(H4 + H1 + 5 * M15, 101.0, 104.8, 101.0, 104.5),
    bar(H4 + H1 + 6 * M15, 101.4, 103.0, 101.2, 102.8),
  ]

  const assessment = assessS12IntradayStructure({
    symbol: '2330',
    bars15m,
    bars1h,
    bars4h,
  })
  assert(assessment.state === 'reaction_ready', `expected reaction_ready, got ${assessment.state}: ${assessment.detail}`)
  assert(assessment.ready, 'strict S12 sequence should produce a ready long assist signal')
  assert(assessment.maturity.takeoverRole === 'long_entry', 'ready long sequence should expose long-entry takeover role')
  assert(assessment.setupId?.startsWith('s12l-2330-'), 'ready S12 signal should expose setup_id')
  assert(assessment.execution.entryPrice === 102.8, 'ready S12 signal should use reaction close as entry reference')
  assert((assessment.execution.stopLoss ?? 999) < assessment.execution.entryPrice!, 'ready S12 signal should keep the selected stop below entry')
  assert((assessment.execution.chaseCeiling ?? 0) > assessment.execution.entryPrice!, 'ready S12 signal should expose no-chase ceiling')
  assert(assessment.quality.vwap.value != null, 'S12 assessment should expose VWAP quality telemetry')
  assert(assessment.quality.rvol.state === 'thin', 'flat-volume fixture should expose thin RVOL without blocking ready state')
  assert(assessment.detail.includes('vwap_state='), 'S12 detail should include VWAP state for UI/trace')
  assert(assessment.detail.includes('rvol_state='), 'S12 detail should include RVOL state for UI/trace')
  assert(assessment.exitPlan.tp1.source === '15m_previous_high', 'S12 TP1 should prefer the nearest 15m prior high')
  assert(assessment.execution.target1 === assessment.exitPlan.tp1.price, 'S12 execution target1 should mirror structural TP1')
  assert(assessment.execution.target2 === assessment.exitPlan.mainExit.price, 'S12 execution target2 should mirror structural main exit')
  assert(assessment.exitPlan.tp3.price != null, 'S12 Pine parity should expose TP3 in the structural ladder')
  assert(assessment.exitPlan.tp4.price != null, 'S12 Pine parity should expose TP4 in the structural ladder')
  assert(assessment.execution.target3 === assessment.exitPlan.tp3.price, 'S12 execution target3 should mirror structural TP3')
  assert(assessment.execution.target4 === assessment.exitPlan.tp4.price, 'S12 execution target4 should mirror structural TP4')
  assert(assessment.exitPlan.trailingStop.source !== undefined, 'S12 stop plan should expose the selected 15m stop source')
  assert(assessment.detail.includes('pine_v7_parity_contract='), 'S12 detail should expose Pine v7 parity diagnostics')
  assert(assessment.detail.includes('idm_price='), 'S12 detail should expose IDM proxy diagnostics')

  const observeDecision = s12PreTradeTechnicalDecision(assessment, 'observe')
  assert(observeDecision === null, 'observe mode must not alter pre-trade execution')
  const assistDecision = s12PreTradeTechnicalDecision(assessment, 'assist_entry')
  assert(assistDecision?.action === 'pass', 'assist_entry mode should pass when S12 long sequence is ready')
  const requireReadyDecision = s12PreTradeTechnicalDecision(assessment, 'require_ready')
  assert(requireReadyDecision?.action === 'pass', 'require_ready mode should pass when S12 long sequence is ready')
  const unified = resolveS12UnifiedDecision(assessment)
  assert(unified.action === 'READY', 'S12 unified pre-trade decision should expose READY for completed long sequence')
  assert(unified.executableBookRequired === true, 'S12 READY entry decision should require executable orderbook')
  const positionTp1 = resolveS12PositionDecision({
    assessment,
    currentPrice: assessment.exitPlan.tp1.price ?? 0,
    executableBookAvailable: true,
    atr14: 2,
    pos: {
      shares: 2000,
      original_shares: 2000,
      avg_cost: assessment.execution.entryPrice ?? 100,
      entry_price: assessment.execution.entryPrice ?? 100,
      initial_stop: assessment.execution.stopLoss ?? 95,
      trailing_stop: assessment.execution.stopLoss ?? 95,
      highest_since_entry: assessment.exitPlan.tp1.price ?? 0,
      tp1_price: assessment.exitPlan.tp1.price,
      tp2_price: assessment.exitPlan.mainExit.price,
      tp1_hit: 0,
    },
  })
  assert(positionTp1.action === 'TAKE_PROFIT', 'S12 position decision should trigger TP1 take-profit from structural plan')
  assert(positionTp1.sellShares === 1000, 'S12 position TP1 should sell half in board lots by default')
  const positionQuoteBlocked = resolveS12PositionDecision({
    assessment,
    currentPrice: assessment.exitPlan.tp1.price ?? 0,
    executableBookAvailable: false,
    atr14: 2,
    pos: {
      shares: 2000,
      original_shares: 2000,
      avg_cost: assessment.execution.entryPrice ?? 100,
      entry_price: assessment.execution.entryPrice ?? 100,
      initial_stop: assessment.execution.stopLoss ?? 95,
      trailing_stop: assessment.execution.stopLoss ?? 95,
      highest_since_entry: assessment.exitPlan.tp1.price ?? 0,
      tp1_price: assessment.exitPlan.tp1.price,
      tp2_price: assessment.exitPlan.mainExit.price,
      tp1_hit: 0,
    },
  })
  assert(positionQuoteBlocked.action === 'QUOTE_UNAVAILABLE', 'S12 sell decision should fail closed when executable book is missing')

  const assessmentStopWatch = resolveS12PositionDecision({
    assessment,
    currentPrice: (assessment.execution.stopLoss ?? 95) + 0.2,
    executableBookAvailable: true,
    atr14: 2,
    pos: {
      shares: 2000,
      original_shares: 2000,
      avg_cost: assessment.execution.entryPrice ?? 100,
      entry_price: assessment.execution.entryPrice ?? 100,
      initial_stop: 80,
      trailing_stop: 80,
      highest_since_entry: assessment.execution.entryPrice ?? 100,
      tp1_price: assessment.exitPlan.tp1.price,
      tp2_price: assessment.exitPlan.mainExit.price,
      tp1_hit: 0,
    },
  })
  assert(assessmentStopWatch.action === 'SET_STRUCTURAL_STOP', 'S12 assessment stopLoss should become the active structural stop watch')
  assert(assessmentStopWatch.stopPrice === assessment.execution.stopLoss, 'S12 structural stop watch should use assessment stopLoss instead of ATR fallback')

  const assessmentStopExit = resolveS12PositionDecision({
    assessment,
    currentPrice: assessment.execution.stopLoss ?? 0,
    executableBookAvailable: true,
    atr14: 2,
    pos: {
      shares: 2000,
      original_shares: 2000,
      avg_cost: assessment.execution.entryPrice ?? 100,
      entry_price: assessment.execution.entryPrice ?? 100,
      initial_stop: 80,
      trailing_stop: 80,
      highest_since_entry: assessment.execution.entryPrice ?? 100,
      tp1_price: assessment.exitPlan.tp1.price,
      tp2_price: assessment.exitPlan.mainExit.price,
      tp1_hit: 0,
    },
  })
  assert(assessmentStopExit.action === 'EXIT_ON_REVERSE_BOS', 'S12 assessment stopLoss breach should trigger structural stop exit')
  assert(assessmentStopExit.reason === 's12_position_structural_stop_full_exit', 'S12 assessment stopLoss breach should use structural-stop reason')

  const vwapTargetAssessment = assessS12IntradayStructure({
    symbol: '2330',
    bars15m,
    bars1h,
    bars4h: [
      bar(0, 100, 116, 98, 112, 1000),
    ],
  })
  assert(vwapTargetAssessment.state === 'reaction_ready', `expected VWAP target fixture reaction_ready, got ${vwapTargetAssessment.state}: ${vwapTargetAssessment.detail}`)
  assert(vwapTargetAssessment.exitPlan.tp1.source === '15m_previous_high', 'S12 TP1 should still prefer the nearest 15m prior high')
  assert(vwapTargetAssessment.exitPlan.mainExit.source === 'vwap_fair_value', 'S12 main exit should use VWAP fair value when no 1H supply target is available')
  assert(vwapTargetAssessment.exitPlan.mainExit.price != null && vwapTargetAssessment.exitPlan.mainExit.price > (vwapTargetAssessment.exitPlan.tp1.price ?? 0), 'VWAP main exit should remain above TP1')
  assert(vwapTargetAssessment.detail.includes('structural_main_exit_source=vwap_fair_value'), 'S12 detail should expose VWAP fair-value main-exit provenance')

  const positionTp4 = resolveS12PositionDecision({
    assessment,
    currentPrice: assessment.exitPlan.tp4.price ?? 0,
    executableBookAvailable: true,
    atr14: 2,
    pos: {
      shares: 1000,
      original_shares: 2000,
      avg_cost: assessment.execution.entryPrice ?? 100,
      entry_price: assessment.execution.entryPrice ?? 100,
      initial_stop: assessment.execution.stopLoss ?? 95,
      trailing_stop: assessment.execution.stopLoss ?? 95,
      highest_since_entry: assessment.exitPlan.tp4.price ?? 0,
      tp1_price: assessment.exitPlan.tp1.price,
      tp2_price: assessment.exitPlan.mainExit.price,
      tp3_price: assessment.exitPlan.tp3.price,
      tp4_price: assessment.exitPlan.tp4.price,
      planned_take_profit: 'tp4',
      tp1_hit: 1,
    },
  })
  assert(positionTp4.action === 'TAKE_PROFIT', 'S12 position decision should support Pine-style planned TP4 exit')
  assert(positionTp4.reason === 's12_tp4_extended_take_profit', 'S12 TP4 exit reason should be explicit')

  const manualAssessment = assessS12IntradayStructure({
    symbol: '2330',
    bars15m,
    bars1h,
    bars4h,
    policy: { plannedTakeProfit: 'manual' as any, manualTakeProfitPrice: 108 },
  })
  assert(manualAssessment.exitPlan.manualTp.price === null, 'S12 manual TP should stay disabled in automated trading mode')
  const automaticMainExit = manualAssessment.exitPlan.mainExit.price ?? 108
  const manualIgnored = resolveS12PositionDecision({
    assessment: manualAssessment,
    currentPrice: automaticMainExit,
    executableBookAvailable: true,
    atr14: 2,
    pos: {
      shares: 1000,
      original_shares: 2000,
      avg_cost: manualAssessment.execution.entryPrice ?? 100,
      entry_price: manualAssessment.execution.entryPrice ?? 100,
      initial_stop: manualAssessment.execution.stopLoss ?? 95,
      trailing_stop: manualAssessment.execution.stopLoss ?? 95,
      highest_since_entry: automaticMainExit,
      tp1_price: manualAssessment.exitPlan.tp1.price,
      tp2_price: manualAssessment.exitPlan.mainExit.price,
      planned_take_profit: 'manual',
      tp1_hit: 1,
    },
  })
  assert(manualIgnored.action === 'TAKE_PROFIT', 'S12 position decision should keep automatic TP behavior when manual is requested')
  assert(manualIgnored.reason === 's12_tp2_main_take_profit', 'S12 manual TP request should normalize to the automatic main-exit TP')
}

{
  const bars4h = [
    bar(0, 100, 110, 98, 108, 1000),
  ]
  const bars1h = [
    bar(H4, 100, 105, 99, 104, 500),
  ]
  const bars15m = [
    bar(H4 + H1 + 0 * M15, 102.0, 102.2, 100.5, 101.0),
    bar(H4 + H1 + 1 * M15, 101.0, 101.5, 99.8, 100.2),
    bar(H4 + H1 + 2 * M15, 100.2, 101.0, 98.8, 100.4),
    bar(H4 + H1 + 3 * M15, 100.4, 100.8, 98.1, 98.2),
    bar(H4 + H1 + 4 * M15, 98.2, 98.5, 97.8, 98.0),
    bar(H4 + H1 + 5 * M15, 98.0, 98.3, 97.7, 97.9),
  ]
  const assessment = assessS12IntradayStructure({
    symbol: '2330',
    bars15m,
    bars1h,
    bars4h,
  })
  assert(assessment.state === 'invalidated', `expected invalidated, got ${assessment.state}: ${assessment.detail}`)
  assert(assessment.maturity.tier === 'defensive_invalidation', 'S12 invalidation should be a defensive maturity tier')
  assert(!isS12ExecutableLongAssessment(assessment), 'invalidated S12 setup must not be executable')
  assert(isS12HardVetoAssessment(assessment), 'invalidated S12 setup should be classified as hard veto')
  assert(isS12PrimaryOwnerBlockingAssessment(assessment), 'invalidated S12 setup should remain a primary-owner block')
  const gateDecision = s12PreTradeTechnicalDecision(assessment, 'block_invalidated')
  assert(gateDecision?.action === 'skip', 'block_invalidated mode should skip structurally invalidated S12 setups')
  const assistDecision = s12PreTradeTechnicalDecision(assessment, 'assist_entry')
  assert(assistDecision?.action === 'skip', 'assist_entry mode should still skip structurally invalidated S12 setups')
  const positionDecision = resolveS12PositionDecision({
    assessment,
    currentPrice: 98,
    executableBookAvailable: true,
    atr14: 2,
    pos: {
      shares: 1000,
      original_shares: 1000,
      avg_cost: 100,
      entry_price: 100,
      initial_stop: 95,
      trailing_stop: 95,
    },
  })
  assert(positionDecision.action === 'EXIT_ON_REVERSE_BOS', 'S12 invalidation should directly trigger defensive position exit')
  assert(positionDecision.reason === 's12_invalidated_defensive_exit', 'S12 invalidation exit reason should be explicit')
}

{
  const bars4h = [
    bar(0, 100, 110, 98, 108, 1000),
  ]
  const bars1h = [
    bar(H4, 100, 105, 99, 104, 500),
  ]
  const bars15m = Array.from({ length: 20 }, (_, i) =>
    bar(H4 + H1 + i * M15, 106.0, 108.0, 105.8, 107.2, 150),
  )
  const assessment = assessS12IntradayStructure({
    symbol: '2330',
    bars15m,
    bars1h,
    bars4h,
  })
  assert(assessment.state === 'waiting_15m_zone_touch', `expected waiting_15m_zone_touch, got ${assessment.state}`)
  assert(assessment.maturity.takeoverRole === 'none', 'waiting S12 sequence should not expose a takeover role')
  assert(assessment.maturity.stale === true, 'S12 stale telemetry should flag long waits without 15m zone touch')
  assert(assessment.maturity.staleReason === '15m_zone_touch_timeout', 'S12 stale telemetry should expose timeout reason')
  assert(!assessment.ready && !assessment.invalidated, 'S12 stale telemetry must not become a trade decision by itself')
  assert(!isS12ExecutableLongAssessment(assessment), 'waiting S12 state must not be executable')
  assert(!isS12HardVetoAssessment(assessment), 'waiting S12 state must not be treated as a hard veto')
  assert(!isS12PrimaryOwnerBlockingAssessment(assessment), 'waiting S12 state should be advisory, not a primary-owner block')
}

{
  const bars4h = [
    bar(0, 100, 110, 98, 108, 1000),
  ]
  const bars1h = [
    bar(H4, 108, 112, 106, 111, 500),
    bar(H4 + H1, 111, 112, 103, 104, 700),
  ]
  const start = H4 + 2 * H1
  const bars15m = [
    bar(start + 0 * M15, 108.0, 111.0, 107.0, 110.0, 150),
    bar(start + 1 * M15, 110.0, 113.0, 109.0, 109.5, 180),
    bar(start + 2 * M15, 109.5, 110.0, 105.0, 105.5, 220),
    bar(start + 3 * M15, 105.5, 108.0, 105.0, 107.0, 120),
    bar(start + 4 * M15, 107.0, 107.5, 102.0, 102.5, 260),
    bar(start + 5 * M15, 106.0, 106.5, 102.0, 103.0, 240),
  ]
  const assessment = assessS12IntradayStructure({
    symbol: '2330',
    bars15m,
    bars1h,
    bars4h,
  })
  assert(assessment.state === 'bearish_defense_ready', `expected bearish_defense_ready, got ${assessment.state}: ${assessment.detail}`)
  assert(!assessment.ready, 'bearish defense must not be exposed as a long-entry ready signal')
  assert(assessment.maturity.takeoverRole === 'no_buy_defense', 'bearish defense should expose a no-buy/defense takeover role')
  assert(assessment.defensiveAction === 'NO_BUY', 'complete bearish SMC structure should only emit a no-buy defensive action')
  assert(assessment.bearishDefense.ready, 'bearish defense checklist should be marked ready')
  assert(!isS12ExecutableLongAssessment(assessment), 'bearish defense must not be executable long ownership')
  assert(isS12HardVetoAssessment(assessment), 'bearish defense should be classified as hard veto')
  assert(isS12PrimaryOwnerBlockingAssessment(assessment), 'bearish defense should remain a primary-owner block')
  assert(
    s12PreTradeTechnicalDecision(assessment, 'observe') === null,
    'observe mode must keep bearish defense informational only',
  )
  const assistDecision = s12PreTradeTechnicalDecision(assessment, 'assist_entry')
  assert(assistDecision?.action === 'skip', 'assist_entry mode should skip pending buys on complete bearish defense')
  assert(assistDecision.reason === 's12_bearish_defense_ready', 'skip reason should be explicit bearish defense')
  const unified = resolveS12UnifiedDecision(assessment)
  assert(unified.action === 'NO_BUY', 'S12 unified pre-trade decision should expose NO_BUY for bearish defense')
  assert(unified.noShortOrder === true, 'S12 bearish defense must keep no-short boundary')
}
