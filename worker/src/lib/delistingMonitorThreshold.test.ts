import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyScreenerRecentSessionSafety, delistingMonitorWindowWeekdays, resolveDelistingMonitorMaxSessions,
  DELISTING_MONITOR_DEFAULT_MAX_SESSIONS, type OverlayCandidate } from './screenerPostRouteOverlays'
import { resolveDelistingMonitorThreshold } from './marketScreener'

const fakeKv = (closed: string[], options: { throws?: boolean } = {}) => ({
  KV: { get: async (key: string) => {
    if (options.throws) throw new Error('kv_down')
    return closed.includes(key.replace(/^holiday:/, '')) ? '1' : null
  } } as unknown as KVNamespace,
})

const candidates = (): OverlayCandidate[] => Array.from({ length: 8 }, (_, i) => ({ symbol: String(1000 + i), name: `s${i}`, score: 50 - i, reason: 'r' }))
const rows = candidates().map((c, i) => ({ symbol: c.symbol, days_count: i }))

/** The pre-HL1-4#a rule, copied verbatim: drop days_count <= 2, evidence max 2. */
function legacy(finalCandidates: OverlayCandidate[], recentRows: typeof rows, excluded: Set<string>) {
  const delistRisk = new Set<string>()
  for (const r of recentRows) if (r.days_count <= 2) delistRisk.add(r.symbol)
  const removed = finalCandidates.filter(c => delistRisk.has(c.symbol))
  const events = removed.map(candidate => {
    excluded.add(candidate.symbol)
    return { symbol: candidate.symbol, name: candidate.name, stage: 'l1_post_route_safety_gate', decision: 'drop',
      reasonCode: 'delisting_monitor_insufficient_recent_sessions', scoreBefore: Number(candidate.score ?? 0), scoreAfter: null,
      evidence: { canonical_l15_route_present: true, recent_market_sessions_max: 2 } }
  })
  for (let i = finalCandidates.length - 1; i >= 0; i--) if (delistRisk.has(finalCandidates[i].symbol)) finalCandidates.splice(i, 1)
  return { removed, events }
}

test('every date of a holiday-free year resolves to the configured max and drops exactly what the legacy rule dropped', async () => {
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 86400_000) {
    const endDate = new Date(t).toISOString().slice(0, 10)
    const threshold = await resolveDelistingMonitorThreshold(fakeKv([]), endDate, {}, [])
    assert.equal(threshold, 2, endDate)
    assert(delistingMonitorWindowWeekdays(endDate).length >= 5, endDate)
    const a = candidates(), b = candidates(), ea = new Set<string>(), eb = new Set<string>()
    const next = applyScreenerRecentSessionSafety(a, rows, ea, threshold)
    const old = legacy(b, rows, eb)
    assert.deepEqual(a, b)
    assert.deepEqual([...ea], [...eb])
    assert.deepEqual(next, old)
  }
})

test('a single-day holiday inside a normal week keeps the legacy threshold', async () => {
  // 2026-10-09 (Fri) National Day eve closure: window 10-02..10-09 still expects 5 sessions.
  assert.equal(await resolveDelistingMonitorThreshold(fakeKv(['2026-10-09']), '2026-10-12', {}, []), 2)
  assert.equal(await resolveDelistingMonitorThreshold(fakeKv(['2026-10-09', '2026-10-10']), '2026-10-09', {}, []), 2)
})

test('the default argument is the legacy threshold', () => {
  const a = candidates(), b = candidates(), ea = new Set<string>(), eb = new Set<string>()
  assert.deepEqual(applyScreenerRecentSessionSafety(a, rows, ea), legacy(b, rows, eb))
  assert.equal(DELISTING_MONITOR_DEFAULT_MAX_SESSIONS, 2)
})

test('a 9-day Lunar New Year closure no longer clears the slate', async () => {
  // Closed 2026-02-14 (Sat) .. 2026-02-22 (Sun); the weekdays 02-16..02-20 carry holiday:* keys.
  const closed = ['2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20']
  const cases: Array<[string, number, number]> = [
    ['2026-02-23', 1, 0], // first session back: only stocks with no print are dropped
    ['2026-02-24', 2, 1],
    ['2026-02-25', 3, 2],
    ['2026-02-26', 4, 2],
  ]
  for (const [endDate, expected, threshold] of cases) {
    const weekdays = delistingMonitorWindowWeekdays(endDate)
    assert.equal(weekdays.filter(d => !closed.includes(d)).length, expected, endDate)
    const log: string[] = []
    assert.equal(await resolveDelistingMonitorThreshold(fakeKv(closed), endDate, {}, log), threshold, endDate)
    assert.equal(log.length, threshold === 2 ? 0 : 1)
  }
  // Every stock printed the single real session 02-23: the legacy rule would drop all of them.
  const slate = candidates(), excluded = new Set<string>()
  const full = slate.map(c => ({ symbol: c.symbol, days_count: 1 }))
  const legacyRun = legacy(candidates(), full, new Set())
  assert.equal(legacyRun.removed.length, 8)
  const { removed, events } = applyScreenerRecentSessionSafety(slate, [...full.slice(1), { symbol: '1000', days_count: 0 }], excluded,
    resolveDelistingMonitorMaxSessions(1, 2))
  assert.deepEqual(removed.map(c => c.symbol), ['1000'])
  assert.equal(slate.length, 7)
  assert.deepEqual([...excluded], ['1000'])
  assert.equal(events[0].evidence?.recent_market_sessions_max, 0)
})

test('a window with no expected session drops nothing', () => {
  assert.equal(resolveDelistingMonitorMaxSessions(0, 2), -1)
  const slate = candidates()
  assert.equal(applyScreenerRecentSessionSafety(slate, rows, new Set(), -1).removed.length, 0)
  assert.equal(slate.length, 8)
})

test('the configured max comes from trading:config.screener.delistingMonitorMaxRecentSessions', async () => {
  assert.equal(await resolveDelistingMonitorThreshold(fakeKv([]), '2026-10-28', { delistingMonitorMaxRecentSessions: 3 }, []), 3)
  assert.equal(await resolveDelistingMonitorThreshold(fakeKv([]), '2026-10-28', { delistingMonitorMaxRecentSessions: 0 }, []), 0)
  // Invalid values keep the default rather than disabling the monitor.
  for (const bad of [-1, 1.5, '2', Number.NaN]) {
    assert.equal(await resolveDelistingMonitorThreshold(fakeKv([]), '2026-10-28', { delistingMonitorMaxRecentSessions: bad }, []), 2)
  }
  // The calendar still caps a configured max after a long closure.
  const closed = ['2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20']
  assert.equal(await resolveDelistingMonitorThreshold(fakeKv(closed), '2026-02-24', { delistingMonitorMaxRecentSessions: 3 }, []), 1)
})

test('an unreadable holiday calendar keeps the configured threshold', async () => {
  assert.equal(await resolveDelistingMonitorThreshold(fakeKv([], { throws: true }), '2026-02-23', {}, []), 2)
  assert.throws(() => delistingMonitorWindowWeekdays('2026-2-3'), /delisting_monitor_end_date_invalid/)
})
