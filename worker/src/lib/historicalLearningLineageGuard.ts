export const HISTORICAL_CANONICAL_LINEAGE_WRITER_TASKS = new Set([
  'evening-chain',
  'update',
  'screener',
  'screener-v2',
  'ml',
  'pipeline',
  'recommendation',
  'post-screener-pipeline',
])

export interface HistoricalLearningLineageDecision {
  allowed: boolean
  signalDate: string
  nextSessionDate: string | null
  nextSessionOpenUtc: string | null
  reason: string
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
  return evaluateHistoricalLearningLineageBoundary({
    task,
    signalDate,
    nextSessionDate: String(row?.next_session_date ?? '').slice(0, 10) || null,
    nowMs,
  })
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
