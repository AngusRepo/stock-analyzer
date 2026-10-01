import {
  filterS12KbarsToTradeDate,
  loadOr15ResearchSessionBars,
  mergeS12CurrentSessionBars,
  normalizeS12KbarSessionTimeSkew,
  s12ResearchTerminalDataSourceReason,
  validateS12DailyPriceDomain,
  validatePreviousSessionSeedBars,
} from './s12RuntimeBars'
import type { IntradayRollingBar } from './intradayTechnicalSnapshot'
import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const canonical = [
    bar('2026-07-16T01:00:00.000Z'),
    bar('2026-07-16T01:01:00.000Z'),
    bar('2026-07-16T05:15:00.000Z'),
  ]
  const postRestartHub = [
    bar('2026-07-16T05:16:00.000Z'),
    bar('2026-07-16T05:17:00.000Z'),
  ]
  const currentEvent = [
    bar('2026-07-16T05:17:00.000Z'),
    bar('2026-07-16T05:18:00.000Z'),
  ]
  const merged = mergeS12CurrentSessionBars(canonical, postRestartHub, currentEvent)
  assert(merged.length === 6, 'canonical minute bars must bridge a Hub revision restart without duplicate buckets')
  assert(merged[0].startMs === canonical[0].startMs, 'restart continuity must preserve the market-open lineage')
  assert(merged[merged.length - 1].startMs === currentEvent[1].startMs, 'current incomplete event bar may extend the completed canonical lineage')
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

void (async () => {
  const cache = new Map<string, string>()
  const env = {
    S12_RESEARCH_KBARS_URL: 'https://research.example',
    PROXY_SERVICE_TOKEN: 'test-token',
    KV: {
      get: async (key: string) => cache.get(key) ?? null,
      put: async (key: string, value: string) => { cache.set(key, value) },
    },
  } as unknown as Parameters<typeof loadOr15ResearchSessionBars>[0]
  const originalFetch = globalThis.fetch
  let requests = 0
  try {
    globalThis.fetch = async (input) => {
      requests += 1
      assert(String(input).includes('/kbars/1101?start=2026-10-01&end=2026-10-01'),
        'Paper A research fallback must request only the current trading day')
      return Response.json({ data: [
        { ts: '2026-10-01T09:01:00+08:00', open: 26, high: 26.2, low: 25.9, close: 26.1, volume: 120 },
        { ts: '2026-10-01T09:02:00+08:00', open: 26.1, high: 26.3, low: 26, close: 26.2, volume: 150 },
      ] })
    }
    const first = await loadOr15ResearchSessionBars(env, '1101', '2026-10-01')
    const cached = await loadOr15ResearchSessionBars(env, '1101', '2026-10-01')
    assert(first.length === 2 && first[0].startMs === Date.parse('2026-10-01T09:01:00+08:00'),
      'current-session research bars must retain their Taiwan minute labels')
    assert(cached.length === 2 && requests === 1,
      'same-minute Paper checks must reuse the quota-aware research cache')
  } finally {
    globalThis.fetch = originalFetch
  }
})().catch((error) => { console.error(error); process.exitCode = 1 })

{
  const prior = [
    { ...bar('2026-09-29T01:00:00.000Z'), close: 178 },
    { ...bar('2026-09-29T05:29:00.000Z'), close: 180 },
  ]
  const current = bar('2026-09-30T01:00:00.000Z')
  const valid = validatePreviousSessionSeedBars([...prior, current], '2026-09-30', '2026-09-29', 180)
  assert(valid.error == null && valid.bars.length === 2, 'prior-session seed should use only the last confirmed prior date')
  const stale = validatePreviousSessionSeedBars(prior, '2026-09-30', '2026-09-28', 180)
  assert(stale.error === 'previous_session_date_mismatch', 'stale prior-session K bars must be rejected')
  const adjusted = validatePreviousSessionSeedBars(prior, '2026-09-30', '2026-09-29', 100)
  assert(adjusted.error === 'previous_session_price_domain_mismatch', 'adjusted K bars must not enter raw intraday S12')
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
  assert(source.includes('tradeDate !== twDateText(paperExecutionNow())'), 'research failure may fall back only for the current TW session')
  assert(source.includes('shioaji_streaming_tick_accumulator_same_session_fallback'), 'same-session fallback must remain observable')
  assert(source.includes('kbars_research_fallback_reason'), 'same-session research failure must preserve its root cause')
  assert(source.includes("[...requestedSessionDates].reverse()"), 'multi-session replay must load newest first so one R2 range artifact can serve older sessions')
  assert(!source.includes('const loadedSessions = await Promise.all'), 'multi-session replay must not burst five broker queries before cache publication')
  assert(source.includes('lifecycle_session_count: completeSessionDates.length'), 'replay maturity must count sessions with legal bars, not requested dates')
  assert(source.includes('start=${encodeURIComponent(tradeDate)}&end=${encodeURIComponent(tradeDate)}'), 'execution proxy may only receive current-session kbar requests')
  assert(!source.includes('s12KbarStartDate'), 'execution proxy must not receive historical date ranges')
  assert(source.includes('identifier_namespace_rank'), 'canonical daily context must rank identifier namespaces explicitly')
  assert(source.includes('const numericNamespaceCollision = namespaceIdentities.has(numericNamespace)') && source.includes('AND ? = 0'), 'internal-id fallback must reject collisions with real symbols')
  assert(!source.includes('CAST((SELECT id FROM stocks WHERE symbol = ? LIMIT 1) AS TEXT)'), 'ambiguous internal stock ids must not share the canonical symbol namespace')
  assert(source.includes('export async function loadS12ResearchUsageStatus'), 'quota recovery must expose a typed usage preflight')
  assert(source.includes('paperExecutionFetch(`${researchUrl}/usage`'), 'quota preflight must use the isolated research usage endpoint')
  assert(source.includes("status: remainingBytes > 0 ? 'ok' : 'exhausted'"), 'quota preflight must fail closed when bandwidth is exhausted')
}

{
  const terminal = s12ResearchTerminalDataSourceReason({
    kbars_error: null,
    kbars_research_fallback_reason: 's12_research_service_429:shioaji_research_bandwidth_exhausted',
  })
  assert(terminal?.includes('bandwidth_exhausted'), 'bandwidth exhaustion must open the per-run research circuit')
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
