import type { Bindings } from '../types'
import { historicalLearningLineageDecision } from './historicalLearningLineageGuard'

export type EveningChainRunScope = 'live_canonical' | 'historical_replay'

export type EveningChainRunAuthority = {
  allowed: boolean
  runScope: EveningChainRunScope
  reason: string
  queuedAt: string | null
  queuedTaipeiDate: string | null
  nextSessionOpenUtc: string | null
}

export async function resolveEveningChainRunAuthority(
  env: Pick<Bindings, 'DB' | 'KV'>,
  input: { businessDate: string; canonicalRunId: string },
): Promise<EveningChainRunAuthority> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) || !input.canonicalRunId.trim()) {
    return {
      allowed: false,
      runScope: 'historical_replay',
      reason: 'invalid_canonical_run_identity',
      queuedAt: null,
      queuedTaipeiDate: null,
      nextSessionOpenUtc: null,
    }
  }

  const stage = await env.DB.prepare(`
    SELECT queued_at,
           date(queued_at, '+8 hours') AS queued_taipei_date
      FROM pipeline_stage_runs
     WHERE business_date=?
       AND stage='post_verify_chain'
       AND canonical_run_id=?
     LIMIT 1
  `).bind(input.businessDate, input.canonicalRunId).first<{
    queued_at?: string | null
    queued_taipei_date?: string | null
  }>()
  const queuedAt = String(stage?.queued_at ?? '').trim() || null
  const queuedTaipeiDate = String(stage?.queued_taipei_date ?? '').trim() || null
  if (!queuedAt || queuedTaipeiDate !== input.businessDate) {
    return {
      allowed: false,
      runScope: 'historical_replay',
      reason: queuedAt ? 'canonical_stage_started_outside_business_date' : 'canonical_post_verify_stage_missing',
      queuedAt,
      queuedTaipeiDate,
      nextSessionOpenUtc: null,
    }
  }

  const boundary = await historicalLearningLineageDecision(
    env.DB,
    env.KV,
    'evening-chain',
    input.businessDate,
  )
  return {
    allowed: boundary.allowed,
    runScope: boundary.allowed ? 'live_canonical' : 'historical_replay',
    reason: boundary.reason,
    queuedAt,
    queuedTaipeiDate,
    nextSessionOpenUtc: boundary.nextSessionOpenUtc,
  }
}

export async function resolveEveningChainClosureDurationMs(
  db: D1Database,
  businessDate: string,
): Promise<number> {
  const row = await db.prepare(`
    SELECT MIN(COALESCE(queued_at, started_at, created_at)) AS started_at
      FROM pipeline_stage_runs
     WHERE business_date=?
       AND stage IN ('post_pipeline_chain', 'verify_v2', 'post_verify_chain')
  `).bind(businessDate).first<{ started_at?: string | null }>()
  const startedAt = String(row?.started_at ?? '').trim()
  if (!startedAt) return 0
  const includesTimezone = /(?:Z|[+-]\\d{2}:?\\d{2})$/i.test(startedAt)
  const normalized = includesTimezone ? startedAt : `${startedAt.replace(' ', 'T')}Z`
  const startedMs = Date.parse(normalized)
  if (!Number.isFinite(startedMs)) return 0
  return Math.max(0, Date.now() - startedMs)
}
