import { filterS12KbarsToTradeDate, normalizeS12KbarSessionTimeSkew } from './s12RuntimeBars'
import type { IntradayRollingBar } from './intradayTechnicalSnapshot'

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
    bar('2026-07-01T01:01:00.000Z'),
    bar('2026-07-01T02:01:00.000Z'),
    bar('2026-07-02T01:01:00.000Z'),
  ]
  const filtered = filterS12KbarsToTradeDate(mixedWindow, '2026-07-01')
  assert(filtered.bars.length === 2, 'S12 must keep only target trade-date kbars before intraday aggregation')
  assert(filtered.outsideTradeDateCount === 2, 'S12 diagnostics should expose kbars filtered out by trade date')
  assert(filtered.bars.every((item) => twText(item.startMs).startsWith('2026-07-01')), 'filtered S12 kbars should all be target TW date')
}
