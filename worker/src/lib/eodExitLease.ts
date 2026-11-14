import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { acquireIntradayExecutionLease, releaseIntradayExecutionLease } from './intradayExecutionLease'

/**
 * AUD-4: at 13:20 the EOD exit overlaps the intraday-check ticks (manifest `0-30 5 * * 1-5`), and both can
 * sell the same position. The Worker EOD run therefore holds the same D1 intraday execution lease: it waits
 * for a running intraday tick to finish, and later ticks are suppressed until EOD releases it. A lease that
 * stays busy past the wait fails loudly instead of selling concurrently. (The native frame runs EOD serially.)
 */
export async function runEodExitUnderIntradayLease<T>(env: Bindings, run: () => Promise<T>,
  options: { waitMs?: number; pollMs?: number; ttlSec?: number } = {}): Promise<T> {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const runId = `eod-exit:${today}:${crypto.randomUUID()}`
  const db = databaseForDataDomain(env, 'ops')
  const deadline = Date.now() + (options.waitMs ?? 90_000)
  while (!(await acquireIntradayExecutionLease(db, runId, today, options.ttlSec ?? 600))) {
    if (Date.now() >= deadline) throw new Error('eod_exit_intraday_lease_busy')
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 2_000))
  }
  try {
    return await run()
  } finally {
    await releaseIntradayExecutionLease(db, runId).catch((error) => {
      console.warn('[EODExit] D1 lease release failed:', error instanceof Error ? error.message : String(error))
    })
  }
}
