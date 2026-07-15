import {
  filterS12KbarsToTradeDate,
  normalizeS12KbarSessionTimeSkew,
  validateS12DailyPriceDomain,
} from './s12RuntimeBars'
import type { IntradayRollingBar } from './intradayTechnicalSnapshot'
import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function bar(iso: string): IntradayRollingBar {
  return {
    startMs: Date.parse(iso),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
  }
}

function twText(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 16)
}

{
  const source = readFileSync(new URL('./s12RuntimeBars.ts', import.meta.url), 'utf8')
  assert(source.includes('env.S12_RESEARCH_KBARS_URL'), 'historical S12 bars must use the isolated research service')
  assert(source.includes("provider: 'shioaji_research_service'"), 'research artifact must identify its canonical owner')
  assert(source.includes('writeEvidenceArtifact(env'), 'research bars must be cached as checksum-verified R2 evidence')
  assert(source.includes("business_date <= date(?, '+7 days')"), 'historical reconstruction must search only overlapping seven-day research artifacts')
  assert(source.includes('ORDER BY business_date ASC'), 'historical reconstruction must choose the nearest later artifact')
  assert(source.includes('document.business_date !== manifest.business_date'), 'cache validation must bind payload lineage to the selected manifest')
  assert(source.includes('kbars_point_in_time_reconstruction'), 'later overlapping artifacts must remain observable as counterfactual reconstruction')
  assert(source.includes('start=${encodeURIComponent(tradeDate)}&end=${encodeURIComponent(tradeDate)}'), 'execution proxy may only receive current-session kbar requests')
  assert(!source.includes('s12KbarStartDate'), 'execution proxy must not receive historical date ranges')
  assert(source.includes('identifier_namespace_rank'), 'canonical daily context must rank identifier namespaces explicitly')
  assert(source.includes('namespace_collision.symbol = CAST(requested_stock.id AS TEXT)'), 'internal-id fallback must reject collisions with real symbols')
  assert(!source.includes('CAST((SELECT id FROM stocks WHERE symbol = ? LIMIT 1) AS TEXT)'), 'ambiguous internal stock ids must not share the canonical symbol namespace')
}

{
  const daily = [
    bar('2026-06-23T01:00:00.000Z'),
    bar('2026-06-24T01:00:00.000Z'),
    bar('2026-06-25T01:00:00.000Z'),
  ]
  const validated = validateS12DailyPriceDomain(daily, '2026-06-25', 100)
  assert(validated.bars.length === 3, 'same-symbol raw daily context should pass price-domain validation')
  assert(validated.rejectedReason == null, 'valid daily context should not carry a rejection reason')
}

{
  const contaminated = [
    { ...bar('2026-06-24T01:00:00.000Z'), open: 850, high: 880, low: 840, close: 870 },
    { ...bar('2026-06-25T01:00:00.000Z'), open: 860, high: 890, low: 850, close: 872 },
  ]
  const validated = validateS12DailyPriceDomain(contaminated, '2026-06-25', 49)
  assert(validated.bars.length === 0, 'adjusted-price context must not enter an unadjusted intraday price domain')
  assert(validated.rejectedReason === 'latest_daily_close_reference_mismatch', 'price-domain rejection should be observable')
}

{
  const discontinuous = [
    { ...bar('2026-06-23T01:00:00.000Z'), open: 200, high: 202, low: 198, close: 200 },
    bar('2026-06-24T01:00:00.000Z'),
    bar('2026-06-25T01:00:00.000Z'),
  ]
  const validated = validateS12DailyPriceDomain(discontinuous, '2026-06-25', 100)
  assert(validated.bars.length === 2, 'daily context before a price-domain boundary must be trimmed')
  assert(validated.rejectedReason === 'older_daily_price_domain_boundary_trimmed', 'trimmed history should remain observable')
}

{
  const skewed = [
    bar('2026-07-01T09:01:00.000Z'),
    bar('2026-07-01T09:16:00.000Z'),
    bar('2026-07-01T10:01:00.000Z'),
  ]
  const normalized = normalizeS12KbarSessionTimeSkew(skewed)
  assert(normalized.adjustment === 'proxy_utc_label_to_tw_local_minus_8h', 'S12 should repair proxy UTC-labelled TW-local kbar timestamps')
  assert(normalized.rawSessionCount === 0, 'skewed UTC-labelled TW-local kbars should have no raw TW-session bars')
  assert(normalized.shiftedSessionCount === 3, 'shifted UTC-labelled TW-local kbars should recover TW-session bars')
  assert(normalized.normalizedSessionCount === 3, 'normalized S12 kbars should expose recovered session count')
  assert(twText(normalized.bars[0].startMs) === '2026-07-01 09:01', 'repaired S12 kbar should land in TW market session')
}

{
  const correct = [
    bar('2026-07-01T01:01:00.000Z'),
    bar('2026-07-01T01:16:00.000Z'),
    bar('2026-07-01T02:01:00.000Z'),
  ]
  const normalized = normalizeS12KbarSessionTimeSkew(correct)
  assert(normalized.adjustment == null, 'S12 should not shift correctly timestamped UTC kbars')
  assert(normalized.rawSessionCount === 3, 'correct UTC kbars should already land in TW session')
  assert(twText(normalized.bars[0].startMs) === '2026-07-01 09:01', 'correct S12 kbar timestamp should stay unchanged')
}

{
  const mixedWindow = [
    bar('2026-06-30T01:01:00.000Z'),
    bar('2026-07-01T00:30:00.000Z'),
    bar('2026-07-01T01:01:00.000Z'),
    bar('2026-07-01T02:01:00.000Z'),
    bar('2026-07-01T13:30:00.000Z'),
    bar('2026-07-02T01:01:00.000Z'),
  ]
  const filtered = filterS12KbarsToTradeDate(mixedWindow, '2026-07-01')
  assert(filtered.bars.length === 2, 'S12 must keep only target-date TW cash-session kbars before aggregation')
  assert(filtered.outsideTradeDateCount === 2, 'S12 diagnostics should expose kbars filtered out by trade date')
  assert(filtered.outsideSessionCount === 2, 'S12 diagnostics should expose target-date after-hours kbars')
  assert(filtered.bars.every((item) => twText(item.startMs).startsWith('2026-07-01')), 'filtered S12 kbars should all be target TW date')
}
