import assert from 'node:assert/strict'
import { recordCanonicalScreenerCallback } from './screenerRecoveryWatchdog'

type Stage = {
  business_date: string
  stage: string
  canonical_run_id: string
  status: 'running' | 'success' | 'error'
  cursor_key: string | null
  processed_count: number
  expected_count: number | null
  persisted_count: number
  attempt_count: number
  lease_owner: string | null
  lease_expires_at: string | null
}

function fakeDb(stage: Stage, successfulFunnelRunIds: string[]) {
  let updates = 0
  const db = {
    prepare(sql: string) {
      let args: unknown[] = []
      const statement = {
        bind(...values: unknown[]) {
          args = values
          return statement
        },
        async first<T>() {
          if (sql.includes('FROM pipeline_stage_runs')) return stage as T
          if (sql.includes('FROM screener_funnel_runs')) {
            const producerRunId = String(args[1] ?? '')
            return (successfulFunnelRunIds.includes(producerRunId)
              ? { run_id: producerRunId, universe_count: 600, final_count: 20 }
              : null) as T
          }
          if (sql.includes('UPDATE pipeline_stage_runs')) {
            updates += 1
            return { status: String(args[0] ?? '') } as T
          }
          return null as T
        },
      }
      return statement
    },
  } as unknown as D1Database
  return { db, updates: () => updates }
}

async function main(): Promise<void> {
  const base: Stage = {
    business_date: '2026-08-14',
    stage: 'screener_v2',
    canonical_run_id: 'chain-1',
    status: 'running',
    cursor_key: 'producer-new',
    processed_count: 0,
    expected_count: null,
    persisted_count: 0,
    attempt_count: 1,
    lease_owner: 'owner-1',
    lease_expires_at: '2026-08-14 15:00:00',
  }

  const oldOnly = fakeDb(base, ['producer-old'])
  const oldReceipt = await recordCanonicalScreenerCallback(oldOnly.db, {
    businessDate: '2026-08-14', canonicalRunId: 'chain-1', producerRunId: 'producer-new', status: 'success',
  })
  assert.equal(oldReceipt.accepted, false)
  assert.equal(oldReceipt.reason, 'screener_callback_exact_funnel_missing')
  assert.equal(oldOnly.updates(), 0)

  const mismatch = fakeDb(base, ['producer-old'])
  const mismatchReceipt = await recordCanonicalScreenerCallback(mismatch.db, {
    businessDate: '2026-08-14', canonicalRunId: 'chain-1', producerRunId: 'producer-old', status: 'success',
  })
  assert.equal(mismatchReceipt.accepted, false)
  assert.equal(mismatchReceipt.reason, 'screener_callback_producer_mismatch')
  assert.equal(mismatch.updates(), 0)

  const terminal = fakeDb({ ...base, status: 'success' }, ['producer-new'])
  const staleError = await recordCanonicalScreenerCallback(terminal.db, {
    businessDate: '2026-08-14', canonicalRunId: 'chain-1', producerRunId: 'producer-new', status: 'error',
  })
  assert.equal(staleError.accepted, false)
  assert.equal(staleError.reason, 'screener_callback_stale_non_success_after_success')
  assert.equal(terminal.updates(), 0)

  const exact = fakeDb(base, ['producer-new'])
  const exactReceipt = await recordCanonicalScreenerCallback(exact.db, {
    businessDate: '2026-08-14', canonicalRunId: 'chain-1', producerRunId: 'producer-new', status: 'success',
  })
  assert.equal(exactReceipt.accepted, true)
  assert.equal(exact.updates(), 1)
}

main().then(() => console.log('screener recovery lineage tests passed'))
