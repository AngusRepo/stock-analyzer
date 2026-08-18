import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
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
  input: {
    businessDate: string
    canonicalRunId: string
    authorityStage?: 'post_verify_chain' | 'screener_v2'
  },
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

  const authorityStage = input.authorityStage ?? 'post_verify_chain'
  const stage = await databaseForDataDomain(env, 'ops').prepare(`
    SELECT queued_at,
           date(queued_at, '+8 hours') AS queued_taipei_date
      FROM pipeline_stage_runs
     WHERE business_date=?
       AND stage=?
       AND canonical_run_id=?
     LIMIT 1
  `).bind(input.businessDate, authorityStage, input.canonicalRunId).first<{
    queued_at?: string | null
    queued_taipei_date?: string | null
  }>()
  const queuedAt = String(stage?.queued_at ?? '').trim() || null
  const queuedTaipeiDate = String(stage?.queued_taipei_date ?? '').trim() || null
  if (!queuedAt) {
    return {
      allowed: false,
      runScope: 'historical_replay',
      reason: authorityStage === 'post_verify_chain'
        ? 'canonical_post_verify_stage_missing'
        : 'canonical_screener_v2_stage_missing',
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
  const crossMidnightCarryover = queuedTaipeiDate !== input.businessDate
    && boundary.reason === 'pre_next_session_open_historical_write_window'
  const allowed = boundary.allowed
    && (queuedTaipeiDate === input.businessDate || crossMidnightCarryover)
  return {
    allowed,
    runScope: allowed ? 'live_canonical' : 'historical_replay',
    reason: allowed && crossMidnightCarryover
      ? 'canonical_stage_cross_midnight_before_next_session_open'
      : boundary.reason,
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
