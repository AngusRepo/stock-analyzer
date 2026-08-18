import { strict as assert } from 'node:assert'
import {
  resolveEveningChainClosureDurationMs,
  resolveEveningChainRunAuthority,
} from './eveningChainRunAuthority'

type FakeDbOptions = {
  expectedRunId?: string
  queuedAt?: string
  queuedTaipeiDate?: string
  nextSessionDate?: string
  startedAt?: string
}

function fakeDb(options: FakeDbOptions): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              if (sql.includes('MIN(COALESCE')) {
                return { started_at: options.startedAt ?? null }
              }
              if (sql.includes('pipeline_stage_runs')) {
                if (String(values.at(-1) ?? '') !== String(options.expectedRunId ?? '')) return null
                return {
                  queued_at: options.queuedAt ?? null,
                  queued_taipei_date: options.queuedTaipeiDate ?? null,
                }
              }
              if (sql.includes('canonical_market_daily')) {
                return { next_session_date: options.nextSessionDate ?? null }
              }
              throw new Error(`unexpected query: ${sql}`)
            },
          }
        },
      }
    },
  } as unknown as D1Database
}

async function main(): Promise<void> {
const originalNow = Date.now
Date.now = () => Date.parse('2026-07-30T17:00:00.000Z')
try {
  const db = fakeDb({
    expectedRunId: 'verify-2026-07-30-canonical',
    queuedAt: '2026-07-30 15:25:36',
    queuedTaipeiDate: '2026-07-30',
    nextSessionDate: '2026-07-31',
    startedAt: '2026-07-30 13:00:00',
  })
  const env = { DB: db, KV: {} as KVNamespace }

  const allowed = await resolveEveningChainRunAuthority(env, {
    businessDate: '2026-07-30',
    canonicalRunId: 'verify-2026-07-30-canonical',
  })
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.runScope, 'live_canonical')
  assert.equal(allowed.reason, 'pre_next_session_open_historical_write_window')
  assert.equal(allowed.nextSessionOpenUtc, '2026-07-31T01:00:00.000Z')

  const screenerAllowed = await resolveEveningChainRunAuthority(env, {
    businessDate: '2026-07-30',
    canonicalRunId: 'verify-2026-07-30-canonical',
    authorityStage: 'screener_v2',
  })
  assert.equal(screenerAllowed.allowed, true)
  assert.equal(screenerAllowed.runScope, 'live_canonical')

  const wrongRun = await resolveEveningChainRunAuthority(env, {
    businessDate: '2026-07-30',
    canonicalRunId: 'wrong-run',
  })
  assert.equal(wrongRun.allowed, false)
  assert.equal(wrongRun.reason, 'canonical_post_verify_stage_missing')

  const wrongDateDb = fakeDb({
    expectedRunId: 'verify-2026-07-30-canonical',
    queuedAt: '2026-07-30 16:05:00',
    queuedTaipeiDate: '2026-07-31',
    nextSessionDate: '2026-07-31',
  })
  const wrongDate = await resolveEveningChainRunAuthority(
    { DB: wrongDateDb, KV: {} as KVNamespace },
    {
      businessDate: '2026-07-30',
      canonicalRunId: 'verify-2026-07-30-canonical',
    },
  )
  assert.equal(wrongDate.allowed, true)
  assert.equal(wrongDate.reason, 'canonical_stage_cross_midnight_before_next_session_open')

  Date.now = () => Date.parse('2026-07-31T01:00:00.000Z')
  const afterOpen = await resolveEveningChainRunAuthority(
    { DB: wrongDateDb, KV: {} as KVNamespace },
    {
      businessDate: '2026-07-30',
      canonicalRunId: 'verify-2026-07-30-canonical',
    },
  )
  assert.equal(afterOpen.allowed, false)
  assert.equal(afterOpen.reason, 'next_executable_session_opened_use_snapshot_only_repair')
  Date.now = () => Date.parse('2026-07-30T17:00:00.000Z')

  const durationMs = await resolveEveningChainClosureDurationMs(db, '2026-07-30')
  assert.equal(durationMs, 4 * 60 * 60 * 1000)
} finally {
  Date.now = originalNow
}

console.log('eveningChainRunAuthority tests passed')
}

void main()
