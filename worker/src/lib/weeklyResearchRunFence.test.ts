import assert from 'node:assert/strict'
import {
  acceptWeeklyBacktestCallback,
  buildWeeklyBacktestRunId,
  markWeeklyBacktestDispatchFailed,
  markWeeklyBacktestDispatchRunning,
  reserveWeeklyBacktestDispatch,
  weeklyBacktestRunFenceKey,
} from './weeklyResearchRunFence'
import { classifySchedulerSummary } from './schedulerRunLogger'

type FenceRow = {
  lock_key: string
  owner: string
  run_date: string
  run_id: string
  created_at: string
  expires_at: string | null
}

class MemoryD1 {
  row: FenceRow | null = null

  prepare(sql: string) {
    const db = this
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values
        return this
      },
      async run() {
        if (sql.includes('INSERT INTO scheduler_locks')) {
          const [lockKey, owner, runDate, runId, createdAt] = this.values.map(String)
          const replaceable = !db.row
            || db.row.owner.startsWith('weekly_backtest_terminal:')
            || db.row.owner === 'weekly_backtest_dispatch_failed'
          if (!replaceable) return { success: true, results: [], meta: { changes: 0 } }
          db.row = {
            lock_key: lockKey,
            owner,
            run_date: runDate,
            run_id: runId,
            created_at: createdAt,
            expires_at: null,
          }
          return { success: true, results: [], meta: { changes: 1 } }
        }
        if (sql.includes('UPDATE scheduler_locks')) {
          const [owner, lockKey, runDate, runId, expectedOwner] = this.values.map(String)
          const identityMatches = db.row?.lock_key === lockKey
            && db.row.run_date === runDate
            && db.row.run_id === runId
          const ownerMatches = sql.includes('owner LIKE ?')
            ? db.row?.owner === expectedOwner || db.row?.owner.startsWith('weekly_backtest_running:')
            : db.row?.owner === expectedOwner
          if (identityMatches && ownerMatches && db.row) {
            db.row = { ...db.row, owner, expires_at: null }
            return { success: true, results: [], meta: { changes: 1 } }
          }
          return { success: true, results: [], meta: { changes: 0 } }
        }
        throw new Error(`unsupported run SQL: ${sql}`)
      },
      async first() {
        if (!sql.includes('SELECT run_date, run_id, owner')) {
          throw new Error(`unsupported first SQL: ${sql}`)
        }
        const [lockKey] = this.values.map(String)
        return db.row?.lock_key === lockKey ? db.row : null
      },
    }
  }
}

async function main(): Promise<void> {
  const memory = new MemoryD1()
  const db = memory as unknown as D1Database
  const firstRunId = buildWeeklyBacktestRunId('2026-08-23', 1787500000000, 'abcdef123456')
  const secondRunId = buildWeeklyBacktestRunId('2026-08-23', 1787500000001, 'abcdef123457')
  assert.equal(firstRunId, 'weekly-backtest-2026-08-23-1787500000000-abcdef123456')
  assert.equal(weeklyBacktestRunFenceKey('2026-08-23'), 'weekly-backtest:2026-08-23')

  const reserved = await reserveWeeklyBacktestDispatch(db, {
    runDate: '2026-08-23',
    runId: firstRunId,
  })
  assert.equal(reserved.acquired, true)
  assert.equal(memory.row?.owner, 'weekly_backtest_dispatching')

  const duplicate = await reserveWeeklyBacktestDispatch(db, {
    runDate: '2026-08-23',
    runId: secondRunId,
  })
  assert.equal(duplicate.acquired, false)
  assert.equal(duplicate.activeRunId, firstRunId)
  assert.equal(memory.row?.run_id, firstRunId)

  const fastCallback = await acceptWeeklyBacktestCallback(db, {
    runDate: '2026-08-23',
    runId: firstRunId,
    callbackStatus: 'success',
  })
  assert.equal(fastCallback.accepted, true)
  assert.equal(memory.row?.owner, 'weekly_backtest_terminal:success')

  const lateRunningCas = await markWeeklyBacktestDispatchRunning(db, {
    runDate: '2026-08-23',
    runId: firstRunId,
    executionId: 'weekly-backtest-research-abc',
  })
  assert.equal(lateRunningCas.transitioned, false)
  assert.equal(lateRunningCas.owner, 'weekly_backtest_terminal:success')

  const idempotentCallback = await acceptWeeklyBacktestCallback(db, {
    runDate: '2026-08-23',
    runId: firstRunId,
    callbackStatus: 'success',
  })
  assert.equal(idempotentCallback.accepted, true)
  const conflictingCallback = await acceptWeeklyBacktestCallback(db, {
    runDate: '2026-08-23',
    runId: firstRunId,
    callbackStatus: 'error',
  })
  assert.equal(conflictingCallback.accepted, false)

  const replacement = await reserveWeeklyBacktestDispatch(db, {
    runDate: '2026-08-23',
    runId: secondRunId,
  })
  assert.equal(replacement.acquired, true)
  const running = await markWeeklyBacktestDispatchRunning(db, {
    runDate: '2026-08-23',
    runId: secondRunId,
    executionId: 'weekly-backtest-research-def',
  })
  assert.equal(running.transitioned, true)
  assert.equal(memory.row?.owner, 'weekly_backtest_running:weekly-backtest-research-def')

  const oldAfterReplacement = await acceptWeeklyBacktestCallback(db, {
    runDate: '2026-08-23',
    runId: firstRunId,
    callbackStatus: 'error',
  })
  assert.equal(oldAfterReplacement.accepted, false)
  assert.equal(oldAfterReplacement.activeRunId, secondRunId)

  const failedMemory = new MemoryD1()
  const failedDb = failedMemory as unknown as D1Database
  const failedRunId = buildWeeklyBacktestRunId('2026-08-16', 1786900000000, 'deadbeef1234')
  await reserveWeeklyBacktestDispatch(failedDb, { runDate: '2026-08-16', runId: failedRunId })
  assert.equal(
    await markWeeklyBacktestDispatchFailed(failedDb, { runDate: '2026-08-16', runId: failedRunId }),
    true,
  )
  assert.equal(failedMemory.row?.owner, 'weekly_backtest_dispatch_failed')
  const retryRunId = buildWeeklyBacktestRunId('2026-08-16', 1786900000001, 'deadbeef1235')
  assert.equal(
    (await reserveWeeklyBacktestDispatch(failedDb, { runDate: '2026-08-16', runId: retryRunId })).acquired,
    true,
  )

  const empty = new MemoryD1() as unknown as D1Database
  const missing = await acceptWeeklyBacktestCallback(empty, {
    runDate: '2026-08-16',
    runId: failedRunId,
    callbackStatus: 'success',
  })
  assert.equal(missing.accepted, false)
  assert.equal(missing.reason, 'weekly_backtest_dispatch_fence_missing')
  assert.equal(
    classifySchedulerSummary(
      'weekly_backtest_reconciled validation=blocked run_date=2026-08-23 trades=5 blockers=monte_carlo:paper:verdict=CAUTION,pbo:insufficient_evidence:observed=5:required=30 evidence_read_only=true',
    ),
    'success',
  )

  console.log('weekly research run fence tests passed')
}

void main()
