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
  assert(assessment.setupId?.startsWith('s12l-2330-'), 'ready S12 signal should expose setup_id')
  assert(assessment.execution.entryPrice === 102.8, 'ready S12 signal should use reaction close as entry reference')
  assert((assessment.execution.stopLoss ?? 999) < 100.2, 'ready S12 signal should anchor stop below sweep low / entry zone')
  assert((assessment.execution.chaseCeiling ?? 0) > assessment.execution.entryPrice!, 'ready S12 signal should expose no-chase ceiling')

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
