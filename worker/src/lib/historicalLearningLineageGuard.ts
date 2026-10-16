import { nextTwTradingDate } from './schedulerPolicy'

export const HISTORICAL_CANONICAL_LINEAGE_WRITER_TASKS = new Set([
  'evening-chain',
  'update',
  'screener',
  'screener-v2',
  'ml',
  'pipeline',
  'recommendation',
  'post-screener-pipeline',
  'screener-v2-watchdog',
  'indicator-queue-watchdog',
])

export interface HistoricalLearningLineageDecision {
  allowed: boolean
  signalDate: string
  nextSessionDate: string | null
  nextSessionOpenUtc: string | null
  reason: string
  scope?: 'paper'
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function taipeiDate(nowMs: number): string {
  return new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10)
}

export function evaluateHistoricalLearningLineageBoundary(input: {
  task: string
  signalDate: string
  nextSessionDate: string | null
  nowMs?: number
}): HistoricalLearningLineageDecision {
  const nowMs = input.nowMs ?? Date.now()
  if (!HISTORICAL_CANONICAL_LINEAGE_WRITER_TASKS.has(input.task) || !validDate(input.signalDate)) {
    return {
      allowed: true,
      signalDate: input.signalDate,
      nextSessionDate: input.nextSessionDate,
      nextSessionOpenUtc: null,
      reason: 'not_a_historical_canonical_lineage_write',
    }
  }
  if (input.signalDate >= taipeiDate(nowMs)) {
    return {
      allowed: true,
      signalDate: input.signalDate,
      nextSessionDate: input.nextSessionDate,
      nextSessionOpenUtc: null,
      reason: 'current_signal_date',
    }
  }
  if (!input.nextSessionDate || !validDate(input.nextSessionDate)) {
    return {
      allowed: false,
      signalDate: input.signalDate,
      nextSessionDate: null,
      nextSessionOpenUtc: null,
      reason: 'next_executable_session_unavailable_use_snapshot_only_repair',
    }
  }
  const nextSessionOpenUtc = `${input.nextSessionDate}T01:00:00.000Z`
  if (nowMs >= Date.parse(nextSessionOpenUtc)) {
    return {
      allowed: false,
      signalDate: input.signalDate,
      nextSessionDate: input.nextSessionDate,
      nextSessionOpenUtc,
      reason: 'next_executable_session_opened_use_snapshot_only_repair',
    }
  }
  return {
    allowed: true,
    signalDate: input.signalDate,
    nextSessionDate: input.nextSessionDate,
    nextSessionOpenUtc,
    reason: 'pre_next_session_open_historical_write_window',
  }
}

export async function historicalLearningLineageDecision(
  db: D1Database,
  kv: KVNamespace,
  task: string,
  signalDate: string,
  nowMs = Date.now(),
): Promise<HistoricalLearningLineageDecision> {
  if (!HISTORICAL_CANONICAL_LINEAGE_WRITER_TASKS.has(task) || !validDate(signalDate) || signalDate >= taipeiDate(nowMs)) {
    return evaluateHistoricalLearningLineageBoundary({ task, signalDate, nextSessionDate: null, nowMs })
  }
  const row = await db.prepare(`
    SELECT MIN(c.date) AS next_session_date
      FROM canonical_market_daily c
     WHERE c.stock_id = '0050'
       AND c.source = 'finlab.price'
       AND c.date > ?
  `).bind(signalDate).first<{ next_session_date?: string | null }>()
  let nextSessionDate = String(row?.next_session_date ?? '').slice(0, 10) || null
  if (!nextSessionDate) {
    try {
      nextSessionDate = await nextTwTradingDate(kv, signalDate, db, {
        requireOfficialFutureCalendar: true,
        nowMs,
      })
    } catch (error) {
      console.warn(`[historicalLearningLineageGuard] next session unresolved for ${signalDate}:`, error)
      nextSessionDate = null
    }
  }
  const decision = evaluateHistoricalLearningLineageBoundary({
    task,
    signalDate,
    nextSessionDate,
    nowMs,
  })
  // Dated paper recoveries keep real timestamps and the published admission.
  // Oct13/14 only continue the pipeline; other historical writers stay closed.
  const today = taipeiDate(nowMs)
  const recoveryDate = signalDate === '2026-10-08' && nextSessionDate === '2026-10-12' && today === '2026-10-12'
    ? '20261012'
    : task === 'pipeline' && signalDate === '2026-10-12' && nextSessionDate === '2026-10-13' && today === '2026-10-13'
      ? '20261013'
      : task === 'pipeline' && signalDate === '2026-10-13' && nextSessionDate === '2026-10-14' && today === '2026-10-14'
        ? '20261014'
        : signalDate === '2026-10-15' && nextSessionDate === '2026-10-16' && today === '2026-10-16'
          ? '20261016' : null
  if (!decision.allowed && recoveryDate) {
    const admission = await kv.get('ml:active8:paper_admission:v1', 'json') as any
    const variables = admission?.configuration?.native_execution_policy?.variables
    const trading = await kv.get('trading:config', 'json') as any
    if (admission?.approved === true && admission.scope === 'paper' && admission.business_date === '2026-10-08'
      && variables?.PAPER_DAILY_PLAN_OWNER === 'premarket_once_v1'
      && variables.LIVE_EXECUTION_CLIENT_ENABLED === '0' && variables.LIVE_EXECUTION_SUBMIT_GUARD_ENABLED === '0'
      && trading?.l4Distribution?.scope === 'paper'
      && /^[a-f0-9]{64}$/.test(String(trading.l4Distribution.artifact?.model_checksum ?? ''))
      && trading.l4Distribution.artifact?.model_checksum === admission.configuration.trading_config?.l4Distribution?.artifact?.model_checksum) {
      return {...decision, allowed:true, scope:'paper', reason:`authorized_paper_recovery_${recoveryDate}`}
    }
  }
  return decision
}

export function historicalLearningLineageBlockedMessage(decision: HistoricalLearningLineageDecision): string {
  return [
    `historical canonical lineage write blocked for ${decision.signalDate}`,
    `reason=${decision.reason}`,
    `next_session=${decision.nextSessionDate ?? 'unknown'}`,
    `next_open_utc=${decision.nextSessionOpenUtc ?? 'unknown'}`,
    'allowed_repair=allocator-ev-feature-snapshot-backfill,verify-v2,s12-replay-backfill',
  ].join('; ')
}
