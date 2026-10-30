import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { eodExitSchedule, eodExitWindowLabel } from './schedulerManifestGovernance'
import { isPaperContinuousSession } from './paperContinuousExecution'
import { buildAdminWorkerDomainTaskMap } from './adminTriggerWorkerDomainTasks'

const twMs = (clock: string) => Date.parse(`2026-11-02T${clock}:00+08:00`) // a Monday

test('AUD-4: the scheduler manifest owns the 13:20 EOD exit and leaves time inside continuous trading', () => {
  const schedule = eodExitSchedule()
  assert.deepEqual(schedule, { cron: '20 5 * * 1-5', twMinute: 13 * 60 + 20, twTime: '13:20', windowEndTwMinute: 13 * 60 + 30 })
  assert.equal(eodExitWindowLabel(schedule), '13:20-13:29')
  // The scheduled run and at least five minutes after it can still fill (the session ends at 13:25).
  assert.equal(isPaperContinuousSession(twMs('13:20')), true)
  assert.equal(isPaperContinuousSession(twMs('13:24')), true)
  assert.equal(isPaperContinuousSession(twMs('13:25')), false)
  assert.ok(schedule.twMinute + 5 <= 13 * 60 + 25, 'EOD exit must start at least 5 minutes before the end of continuous trading')
  assert.throws(() => eodExitSchedule({ timeZone: 'UTC', jobs: [] }), /eod_exit_schedule_invalid/)
  assert.throws(() => eodExitSchedule({ timeZone: 'Asia/Taipei', jobs: [{ id: 'eod-exit', schedule: '20 13 * * 1-5' }] }), /eod_exit_schedule_invalid/)
  assert.throws(() => eodExitSchedule({ timeZone: 'UTC', jobs: [{ id: 'eod-exit', schedule: '20 13 * * 1-5', timeZone: 'Asia/Taipei' }] }), /eod_exit_schedule_invalid/)
  assert.equal(eodExitSchedule({ timeZone: 'Asia/Taipei', jobs: [{ id: 'eod-exit', schedule: '20 5 * * 1-5', timeZone: 'UTC' }] }).twTime, '13:20')
})

test('AUD-4: the trigger window is derived from the manifest and still covers the legacy 13:25 run', async () => {
  let ran = 0
  const context = (force = false) => ({ env: leaseEnv(), req: { query: (key: string) => (key === 'force' && force ? '1' : undefined) } })
  const deps: any = { runEODExit: async () => { ran += 1; return 'EOD exit done' } }
  const at = async (clock: string, force = false) => {
    mock.timers.enable({ apis: ['Date'], now: twMs(clock) })
    try { return await buildAdminWorkerDomainTaskMap(context(force), deps)['eod-exit']() } finally { mock.timers.reset() }
  }
  assert.match(String(await at('13:19')), /^SKIPPED: 僅限 EOD 13:20-13:29 TW/)
  for (const clock of ['13:20', '13:25', '13:29']) assert.equal(await at(clock), 'EOD exit done')
  assert.match(String(await at('13:30')), /^SKIPPED/)
  assert.equal(await at('13:30', true), 'EOD exit done')
  assert.equal(ran, 4)
})

test('AUD-4: display and legacy cron readers carry no literal EOD time', () => {
  const status = readFileSync('src/lib/schedulerStatus.ts', 'utf8')
  const routes = readFileSync('src/routes/scheduleReadRoutes.ts', 'utf8')
  const cron = readFileSync('src/lib/cronWorkerDomainTasks.ts', 'utf8')
  const trigger = readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
  assert.ok(status.includes("{ id: 'eod-exit', name: 'EOD Exit', schedule: `Weekdays ${eodExitSchedule().twTime}`, cron: eodExitSchedule().cron"))
  assert.ok(routes.includes("{ task: 'eod-exit', tw_time: eodExitSchedule().twTime"))
  assert.ok(cron.includes('if (cron === eodExitSchedule().cron) {'))
  for (const source of [status, routes, cron, trigger]) assert.ok(!/25 5 \* \* 1-5|1325|13:25-13:35/.test(source))
})

// A D1 stand-in for scheduler_locks (intraday execution lease).
const locks = new Map<string, { run_id: string; expires_at: string }>()
function leaseEnv() {
  const db = { prepare(sql: string) {
    let args: any[] = []
    const st = { bind(...a: any[]) { args = a; return st }, async run() {
      if (/INSERT INTO scheduler_locks/.test(sql)) {
        const [key, , , runId, now, expiresAt] = args
        const held = locks.get(key)
        if (held && held.expires_at > now) return { success: true, meta: { changes: 0 } }
        locks.set(key, { run_id: runId, expires_at: expiresAt }); return { success: true, meta: { changes: 1 } }
      }
      if (/DELETE FROM scheduler_locks/.test(sql)) {
        const [key, , runId] = args
        if (locks.get(key)?.run_id === runId) locks.delete(key)
        return { success: true, meta: { changes: 1 } }
      }
      throw new Error('unexpected sql ' + sql)
    } }
    return st
  } }
  return { DB: db, OPS_DB: db } as any
}

test('AUD-4: the Worker EOD run holds the intraday execution lease, waits for a running tick, and fails loudly if it stays busy', async () => {
  const { runEodExitUnderIntradayLease } = await import('./eodExitLease')
  const { acquireIntradayExecutionLease, releaseIntradayExecutionLease } = await import('./intradayExecutionLease')
  const env = leaseEnv(), db = env.OPS_DB
  locks.clear()
  // While EOD runs, an intraday tick cannot acquire the lease (it is suppressed).
  let tickDuringEod: boolean | null = null
  assert.equal(await runEodExitUnderIntradayLease(env, async () => {
    tickDuringEod = await acquireIntradayExecutionLease(db, 'intraday-check:tick', '2026-10-29')
    return 'EOD exit done'
  }), 'EOD exit done')
  assert.equal(tickDuringEod, false)
  assert.equal(locks.size, 0, 'EOD releases the lease')
  // A running tick: EOD waits, then runs once the tick releases.
  assert.equal(await acquireIntradayExecutionLease(db, 'intraday-check:running', '2026-10-29'), true)
  let ran = 0
  setTimeout(() => { void releaseIntradayExecutionLease(db, 'intraday-check:running') }, 30)
  await runEodExitUnderIntradayLease(env, async () => { ran += 1 }, { pollMs: 10, waitMs: 2_000 })
  assert.equal(ran, 1)
  // A lease that stays busy past the wait: EOD never sells concurrently, it throws.
  assert.equal(await acquireIntradayExecutionLease(db, 'intraday-check:stuck', '2026-10-29'), true)
  await assert.rejects(runEodExitUnderIntradayLease(env, async () => { ran += 1 }, { pollMs: 5, waitMs: 20 }), /eod_exit_intraday_lease_busy/)
  assert.equal(ran, 1)
  locks.clear()
  // Both Worker call sites use it.
  assert.ok(readFileSync('src/lib/cronWorkerDomainTasks.ts', 'utf8').includes('await runEodExitUnderIntradayLease(env, () => runEODExit(env))'))
  assert.ok(readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8').includes('return runEodExitUnderIntradayLease(c.env, () => deps.runEODExit())'))
})
