import {
  aggregateCompletedS12Bars,
  assessS12IntradayStructure,
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
  assert((assessment.execution.stopLoss ?? 999) < 100.2, 'ready S12 signal should anchor stop below sweep low / entry zone')
  assert((assessment.execution.chaseCeiling ?? 0) > assessment.execution.entryPrice!, 'ready S12 signal should expose no-chase ceiling')
  assert(assessment.quality.vwap.value != null, 'S12 assessment should expose VWAP quality telemetry')
  assert(assessment.quality.rvol.state === 'thin', 'flat-volume fixture should expose thin RVOL without blocking ready state')
  assert(assessment.detail.includes('vwap_state='), 'S12 detail should include VWAP state for UI/trace')
  assert(assessment.detail.includes('rvol_state='), 'S12 detail should include RVOL state for UI/trace')
  assert(assessment.exitPlan.tp1.source === '15m_previous_high', 'S12 TP1 should prefer the nearest 15m prior high')
  assert(assessment.execution.target1 === assessment.exitPlan.tp1.price, 'S12 execution target1 should mirror structural TP1')
  assert(assessment.execution.target2 === assessment.exitPlan.mainExit.price, 'S12 execution target2 should mirror structural main exit')
  assert(assessment.execution.target3 == null, 'S12 should not expose simplified 3R as target3 after structural exit contract')

  const observeDecision = s12PreTradeTechnicalDecision(assessment, 'observe')
  assert(observeDecision === null, 'observe mode must not alter pre-trade execution')
  const assistDecision = s12PreTradeTechnicalDecision(assessment, 'assist_entry')
  assert(assistDecision?.action === 'pass', 'assist_entry mode should pass when S12 long sequence is ready')
  const requireReadyDecision = s12PreTradeTechnicalDecision(assessment, 'require_ready')
  assert(requireReadyDecision?.action === 'pass', 'require_ready mode should pass when S12 long sequence is ready')
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
}
