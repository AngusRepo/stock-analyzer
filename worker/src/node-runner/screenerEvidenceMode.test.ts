import assert from 'node:assert/strict'
import test from 'node:test'
import { screenerEvidenceMode } from './screenerEvidenceMode'

// The market DB knows 2026-10-30 is the session after 2026-10-29; the legacy DB must not be read.
const env = (nextSession: string | null) => ({
  DB: { prepare: () => { throw new Error('legacy_db_read') } },
  MARKET_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ next_session_date: nextSession }) }) }) },
  KV: { get: async () => null },
  MULTI_D1_ACTIVE_DOMAINS: 'market',
  MULTI_D1_STRICT: 'true',
}) as any

test('screener evidence mode: a past date reads the next session from the market DB', async () => {
  const beforeOpen = Date.parse('2026-10-30T00:30:00Z')   // 08:30 Taipei, before the 09:00 open
  const afterOpen = Date.parse('2026-10-30T01:30:00Z')
  assert.equal(await screenerEvidenceMode(env('2026-10-30'), '2026-10-29', '2026-10-30', beforeOpen), 'live_current')
  assert.equal(await screenerEvidenceMode(env('2026-10-30'), '2026-10-29', '2026-10-30', afterOpen), 'historical_replay')
  assert.equal(await screenerEvidenceMode(env(null), '2026-10-30', '2026-10-30', afterOpen), 'live_current')
})
