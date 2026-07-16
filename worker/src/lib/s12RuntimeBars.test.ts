import {
  filterS12KbarsToTradeDate,
  mergeS12CurrentSessionBars,
  normalizeS12KbarSessionTimeSkew,
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

{
  const source = readFileSync(new URL('./s12RuntimeBars.ts', import.meta.url), 'utf8')
  assert(source.includes('env.S12_RESEARCH_KBARS_URL'), 'historical S12 bars must use the isolated research service')
  assert(source.includes("provider: 'shioaji_research_service'"), 'research artifact must identify its canonical owner')
  assert(source.includes('writeEvidenceArtifact(env'), 'research bars must be cached as checksum-verified R2 evidence')
  assert(source.includes('start=${encodeURIComponent(tradeDate)}&end=${encodeURIComponent(tradeDate)}'), 'execution proxy may only receive current-session kbar requests')
  assert(!source.includes('s12KbarStartDate'), 'execution proxy must not receive historical date ranges')
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
