import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { historicalLearningLineageDecision } from './historicalLearningLineageGuard'
import { nextTwTradingDate } from './schedulerPolicy'

export type EveningChainRunScope = 'live_canonical' | 'historical_replay'

export type EveningChainRunAuthority = {
  allowed: boolean
  runScope: EveningChainRunScope
  reason: string
  queuedAt: string | null
  queuedTaipeiDate: string | null
  nextSessionOpenUtc: string | null
  /** LIVE-AUTH-B: the post-close live effects (not `allowed`) of the newest closed business date. */
  liveEffectsAllowed: boolean
  liveEffectsReason: string
}

/** Post-close research (R33 B#1) runs after the next session's 13:30 TW close, past the open fence of `allowed`. */
export const POST_CLOSE_LIVE_EFFECTS_START_UTC = 'T05:30:00.000Z'

function utcMs(value: string): number {
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value.replace(' ', 'T')}Z`)
}

/**
 * LIVE-AUTH-B: the effect runs, and the canonical stage was last (re)queued, in [next session 13:30 TW, the
 * session after it 09:00 TW). Left-closed and right-open, so a later replay of an older date can never overwrite
 * newer state. The session after it comes from the official calendar only: a missing FinLab row for it must not
 * stretch the window past its open. It never widens `allowed`, which also gates strategy-learning policy,
 * promotion and GA.
 */
async function resolvePostCloseLiveEffects(
  env: Pick<Bindings, 'DB' | 'KV'>,
  queuedAt: string,
  nextSessionDate: string | null,
  nowMs: number,
): Promise<{ allowed: boolean; reason: string }> {
  if (!nextSessionDate) return { allowed: false, reason: 'post_close_window_next_session_unknown' }
  let followingSessionDate: string
  try {
    followingSessionDate = await nextTwTradingDate(env.KV, nextSessionDate, undefined, {
      requireOfficialFutureCalendar: true,
      nowMs,
    })
  } catch (error) {
    console.warn(`[eveningChainRunAuthority] session after ${nextSessionDate} unresolved:`, error)
    return { allowed: false, reason: 'post_close_window_following_session_unresolved' }
  }
  const start = Date.parse(`${nextSessionDate}${POST_CLOSE_LIVE_EFFECTS_START_UTC}`)
  const end = Date.parse(`${followingSessionDate}T01:00:00.000Z`)
  const queuedMs = utcMs(queuedAt)
  const inside = (ms: number) => Number.isFinite(ms) && ms >= start && ms < end
  if (!inside(queuedMs)) return { allowed: false, reason: 'post_close_window_stage_queued_outside' }
  if (!inside(nowMs)) return { allowed: false, reason: 'post_close_window_closed' }
  return { allowed: true, reason: 'post_close_next_session_window' }
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
      liveEffectsAllowed: false,
      liveEffectsReason: 'invalid_canonical_run_identity',
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
    const reason = authorityStage === 'post_verify_chain'
      ? 'canonical_post_verify_stage_missing'
      : 'canonical_screener_v2_stage_missing'
    return {
      allowed: false,
      runScope: 'historical_replay',
      reason,
      queuedAt,
      queuedTaipeiDate,
      nextSessionOpenUtc: null,
      liveEffectsAllowed: false,
      liveEffectsReason: reason,
    }
  }

  const nowMs = Date.now()
  const boundary = await historicalLearningLineageDecision(
    databaseForDataDomain(env, 'market'),
    env.KV,
    'evening-chain',
    input.businessDate,
    nowMs,
  )
  const crossMidnightCarryover = queuedTaipeiDate !== input.businessDate
    && (boundary.reason === 'pre_next_session_open_historical_write_window'
      || (boundary.reason === 'authorized_paper_recovery_20261012' && boundary.scope === 'paper'))
  const allowed = boundary.allowed
    && (queuedTaipeiDate === input.businessDate || crossMidnightCarryover)
  const liveEffects = allowed
    ? { allowed: true, reason: 'live_canonical' }
    : authorityStage === 'post_verify_chain' && boundary.reason === 'next_executable_session_opened_use_snapshot_only_repair'
      ? await resolvePostCloseLiveEffects(env, queuedAt, boundary.nextSessionDate, nowMs)
      : { allowed: false, reason: boundary.reason }
  return {
    allowed,
    runScope: allowed ? 'live_canonical' : 'historical_replay',
    reason: boundary.scope === 'paper' ? boundary.reason : allowed && crossMidnightCarryover
      ? 'canonical_stage_cross_midnight_before_next_session_open'
      : boundary.reason,
    queuedAt,
    queuedTaipeiDate,
    nextSessionOpenUtc: boundary.nextSessionOpenUtc,
    liveEffectsAllowed: liveEffects.allowed,
    liveEffectsReason: liveEffects.reason,
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
