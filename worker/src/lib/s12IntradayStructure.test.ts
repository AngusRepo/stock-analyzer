import {
  aggregateCompletedS12Bars,
  assessS12IntradayStructure,
  assessS12IntradayStructureFromBaseBars,
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
  const policy = s12TimingPolicyFromEnv({
    S12_INTRADAY_MIN_15M_BARS: '2',
    S12_INTRADAY_ATR_15M_BARS: '99',
    S12_INTRADAY_SWING_LOOKBACK_BARS: '1',
    S12_INTRADAY_BOS_WAIT_BARS: '50',
    S12_INTRADAY_SR_PIVOT_LEN: '10',
    S12_INTRADAY_OB_LOOKBACK_BARS: '34',
    S12_INTRADAY_MIN_FVG_ATR: '0.08',
    S12_INTRADAY_TRIGGER_MODE: 'reaction_close',
    S12_POSITION_STOP_SOURCE: '15m_recent_fvg',
    S12_POSITION_PLANNED_TP: 'tp4',
    S12_POSITION_MANUAL_TP_PRICE: '123.4',
  })
  assert(policy.min15mBars === 3, 'S12 min 15m bars must clamp to the FVG-compatible lower bound')
  assert(policy.atr15mBars === 30, 'S12 ATR period should clamp unsafe large env overrides')
  assert(policy.swingLookbackBars === 2, 'S12 swing lookback should clamp below community-style pivot minimum')
  assert(policy.bosWaitBars === 50, 'S12 BOS wait should accept bounded env overrides')
  assert(policy.srPivotLen === 10, 'S12 S/R pivot window should be env-configurable')
  assert(policy.obLookbackBars === 34, 'S12 order-block lookback should be env-configurable')
  assert(policy.minFvgAtr === 0.08, 'S12 FVG minimum ATR ratio should be env-configurable')
  assert(policy.triggerMode === 'reaction_close', 'S12 trigger mode should be env-configurable')
  assert(policy.positionStopSource === '15m_recent_fvg', 'S12 position stop source should be env-configurable')
  assert(policy.plannedTakeProfit === 'tp4', 'S12 planned TP should be env-configurable')
  assert(policy.manualTakeProfitPrice === 123.4, 'S12 manual TP price should be env-configurable')
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
    policy: { plannedTakeProfit: 'manual', manualTakeProfitPrice: 108 },
  })
  assert(manualAssessment.exitPlan.manualTp.price === 108, 'S12 should carry manual TP from policy into the exit plan')
  const manualTp = resolveS12PositionDecision({
    assessment: manualAssessment,
    currentPrice: 108,
    executableBookAvailable: true,
    atr14: 2,
    pos: {
      shares: 1000,
      original_shares: 2000,
      avg_cost: manualAssessment.execution.entryPrice ?? 100,
      entry_price: manualAssessment.execution.entryPrice ?? 100,
      initial_stop: manualAssessment.execution.stopLoss ?? 95,
      trailing_stop: manualAssessment.execution.stopLoss ?? 95,
      highest_since_entry: 108,
      tp1_price: manualAssessment.exitPlan.tp1.price,
      tp2_price: manualAssessment.exitPlan.mainExit.price,
      manual_tp_price: manualAssessment.exitPlan.manualTp.price,
      tp1_hit: 1,
    },
  })
  assert(manualTp.action === 'TAKE_PROFIT', 'S12 position decision should support manual TP exit')
  assert(manualTp.reason === 's12_manual_take_profit', 'S12 manual TP exit reason should be explicit')
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
  const gateDecision = s12PreTradeTechnicalDecision(assessment, 'block_invalidated')
  assert(gateDecision?.action === 'skip', 'block_invalidated mode should skip structurally invalidated S12 setups')
  const assistDecision = s12PreTradeTechnicalDecision(assessment, 'assist_entry')
  assert(assistDecision?.action === 'skip', 'assist_entry mode should still skip structurally invalidated S12 setups')
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
