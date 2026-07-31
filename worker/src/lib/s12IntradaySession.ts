import type { Bindings } from '../types'
import { runS12IntradaySetupWatchBatch } from './s12IntradaySetupWatch'
import {
  acquireS12IntradaySessionLease,
  refreshS12IntradaySessionLease,
  releaseS12IntradaySessionLease,
} from './s12IntradaySessionLease'
import { isTwIntradayTradingMinute } from './twMarketSession'

const DEFAULT_POLL_MS = 60_000
const DEFAULT_LEASE_SECONDS = 180

export interface S12IntradaySessionSummary {
  schema_version: 's12-intraday-session-summary-v1'
  status: 'completed' | 'lease_busy' | 'outside_session'
  run_id: string
  trade_date: string
  ticks: number
  watched: number
  near_zone: number
  assessed: number
  ready_for_formal_ev: number
  still_waiting: number
  errors: number
  started_at: string
  completed_at: string
}

function twDate(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nextAlignedTickDelayMs(nowMs: number, pollMs: number): number {
  const remainder = nowMs % pollMs
  return Math.max(250, remainder === 0 ? pollMs : pollMs - remainder)
}

export async function runS12IntradaySession(
  env: Bindings,
  tradeDate: string,
  options: {
    runId: string
    concurrency?: number
    pollMs?: number
    leaseSeconds?: number
    maxTicks?: number
  },
): Promise<S12IntradaySessionSummary> {
  const startedAt = new Date()
  const base = {
    schema_version: 's12-intraday-session-summary-v1' as const,
    run_id: options.runId,
    trade_date: tradeDate,
    ticks: 0,
    watched: 0,
    near_zone: 0,
    assessed: 0,
    ready_for_formal_ev: 0,
    still_waiting: 0,
    errors: 0,
    started_at: startedAt.toISOString(),
  }
  if (twDate(startedAt) !== tradeDate || !isTwIntradayTradingMinute(startedAt)) {
    return { ...base, status: 'outside_session', completed_at: new Date().toISOString() }
  }

  const pollMs = Math.max(1_000, Math.floor(options.pollMs ?? DEFAULT_POLL_MS))
  const leaseSeconds = Math.max(60, Math.floor(options.leaseSeconds ?? DEFAULT_LEASE_SECONDS))
  const acquired = await acquireS12IntradaySessionLease(env.DB, options.runId, tradeDate, leaseSeconds)
  if (!acquired) {
    return { ...base, status: 'lease_busy', completed_at: new Date().toISOString() }
  }

  let leaseLost = false
  const heartbeat = setInterval(() => {
    void refreshS12IntradaySessionLease(env.DB, options.runId, tradeDate, leaseSeconds)
      .then((refreshed) => { if (!refreshed) leaseLost = true })
      .catch(() => { leaseLost = true })
  }, Math.max(30_000, Math.floor(leaseSeconds * 1000 / 3)))

  try {
    while (twDate() === tradeDate && isTwIntradayTradingMinute()) {
      if (leaseLost) throw new Error(`s12_intraday_session_lease_lost:${tradeDate}`)
      const tick = await runS12IntradaySetupWatchBatch(env, tradeDate, {
        concurrency: Math.max(1, Math.floor(options.concurrency ?? 4)),
      })
      base.ticks += 1
      base.watched += tick.watched
      base.near_zone += tick.near_zone
      base.assessed += tick.assessed
      base.ready_for_formal_ev += tick.ready_for_formal_ev
      base.still_waiting += tick.still_waiting
      base.errors += tick.errors
      if (!await refreshS12IntradaySessionLease(env.DB, options.runId, tradeDate, leaseSeconds)) {
        throw new Error(`s12_intraday_session_lease_lost:${tradeDate}`)
      }
      if (options.maxTicks != null && base.ticks >= Math.max(1, options.maxTicks)) break
      await sleep(nextAlignedTickDelayMs(Date.now(), pollMs))
    }
    return { ...base, status: 'completed', completed_at: new Date().toISOString() }
  } finally {
    clearInterval(heartbeat)
    await releaseS12IntradaySessionLease(env.DB, options.runId, tradeDate).catch(() => {})
  }
}
