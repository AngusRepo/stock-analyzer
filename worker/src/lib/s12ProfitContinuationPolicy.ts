import type { ExitDecision } from './paperExitPolicy'

export const S12_PROFIT_CONTINUATION_CONTRACT = 's12-profit-continuation-v1' as const
export const S12_PROFIT_CONTINUATION_SCHEMA = 's12-profit-continuation-serving-artifact-v1' as const
export const S12_PROFIT_CONTINUATION_MAX_MINUTES = 60 as const

const FINAL_TAKE_PROFIT_REASONS = new Set([
  's12_tp2_main_take_profit',
  's12_tp3_extended_take_profit',
  's12_tp4_extended_take_profit',
])

export type S12ProfitContinuationArtifactPayload = {
  schema_version: typeof S12_PROFIT_CONTINUATION_SCHEMA
  contract: typeof S12_PROFIT_CONTINUATION_CONTRACT
  enabled: true
  scope: 'paper_only'
  real_order_effect: false
  maximum_continuation_minutes: 60
  final_tranche_only: true
  no_overnight: true
  rank_or_top_k_used: false
  incremental_transaction_cost_bps: 0
  safety_priority: [
    'active_structure_stop',
    'bearish_defense_or_reverse_bos',
    'profit_continuation_deadline',
  ]
  evidence: {
    receipt_checksum: string
    full_cohort_checksum: string
    paired_rows_checksum: string
    validation_start: string
    validation_end: string
    sample_count: number
    date_count: number
    changed_rows: number
    full_portfolio_delta_lcb90: number
    bootstrap_mean_delta_q05: number
    trade_cvar10_non_degradation: true
    date_cvar10_non_degradation: true
    drawdown_non_degradation: true
  }
}

export type PromotedS12ProfitContinuationPolicy = {
  artifactId: string
  payloadChecksum: string
  knowledgeCutoffDate: string
  payload: S12ProfitContinuationArtifactPayload
}

type LifecycleState = {
  status: 'active'
  artifact_id: string
  payload_checksum: string
  activation_trade_date: string
  activated_at_ms: number
  deadline_ms: number
  target_price: number
}

type PositionLike = {
  shares?: number | null
  original_shares?: number | null
  tp1_hit?: number | null
  trailing_stop?: number | null
  trade_lifecycle_json?: unknown
}

export type S12ProfitContinuationResolution = {
  decision: ExitDecision
  lifecycleJson: string | null
  state: 'inactive' | 'activated' | 'continuing' | 'deadline_exit' | 'session_close_exit' | 'safety_exit'
  artifactId: string | null
}

function finitePositive(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function parseLifecycle(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...(value as Record<string, any>) }
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function validPayload(payload: unknown): payload is S12ProfitContinuationArtifactPayload {
  const row = payload as Partial<S12ProfitContinuationArtifactPayload> | null
  const evidence = row?.evidence
  return Boolean(
    row &&
    row.schema_version === S12_PROFIT_CONTINUATION_SCHEMA &&
    row.contract === S12_PROFIT_CONTINUATION_CONTRACT &&
    row.enabled === true &&
    row.scope === 'paper_only' &&
    row.real_order_effect === false &&
    row.maximum_continuation_minutes === S12_PROFIT_CONTINUATION_MAX_MINUTES &&
    row.final_tranche_only === true &&
    row.no_overnight === true &&
    row.rank_or_top_k_used === false &&
    row.incremental_transaction_cost_bps === 0 &&
    Array.isArray(row.safety_priority) &&
    row.safety_priority.join('|') === 'active_structure_stop|bearish_defense_or_reverse_bos|profit_continuation_deadline' &&
    evidence &&
    /^[a-f0-9]{64}$/.test(String(evidence.receipt_checksum ?? '')) &&
    /^[a-f0-9]{64}$/.test(String(evidence.full_cohort_checksum ?? '')) &&
    /^[a-f0-9]{64}$/.test(String(evidence.paired_rows_checksum ?? '')) &&
    Number(evidence.sample_count) >= 1 &&
    Number(evidence.date_count) >= 2 &&
    Number(evidence.full_portfolio_delta_lcb90) > 0 &&
    Number(evidence.bootstrap_mean_delta_q05) > 0 &&
    evidence.trade_cvar10_non_degradation === true &&
    evidence.date_cvar10_non_degradation === true &&
    evidence.drawdown_non_degradation === true
  )
}

export async function loadPromotedS12ProfitContinuationPolicy(
  db: D1Database,
  asOfDate: string,
): Promise<PromotedS12ProfitContinuationPolicy | null> {
  const row = await db.prepare(`
    SELECT a.artifact_id, a.knowledge_cutoff_date, a.payload_json, a.payload_checksum
      FROM s12_exit_policy_head_v1 h
      JOIN s12_exit_policy_artifacts_v1 a ON a.artifact_id=h.artifact_id
     WHERE h.singleton_id=1
       AND a.validation_decision='PASS'
       AND a.scope='paper_only'
       AND a.real_order_effect=0
       AND date(a.knowledge_cutoff_date)<=date(?)
     LIMIT 1
  `).bind(asOfDate).first<{
    artifact_id?: string | null
    knowledge_cutoff_date?: string | null
    payload_json?: string | null
    payload_checksum?: string | null
  }>()
  if (!row?.artifact_id || !row.payload_json || !row.payload_checksum || !row.knowledge_cutoff_date) return null
  if (!/^[a-f0-9]{64}$/.test(row.payload_checksum)) return null
  if (await sha256Hex(row.payload_json) !== row.payload_checksum) return null
  let payload: unknown
  try {
    payload = JSON.parse(row.payload_json)
  } catch {
    return null
  }
  if (!validPayload(payload)) return null
  if (stableStringify(payload) !== row.payload_json) return null
  return {
    artifactId: row.artifact_id,
    payloadChecksum: row.payload_checksum,
    knowledgeCutoffDate: row.knowledge_cutoff_date,
    payload,
  }
}

function readActiveState(rawLifecycle: unknown): LifecycleState | null {
  const lifecycle = parseLifecycle(rawLifecycle)
  const state = lifecycle?.exit_policy?.[S12_PROFIT_CONTINUATION_CONTRACT]
  if (!state || state.status !== 'active') return null
  const normalized: LifecycleState = {
    status: 'active',
    artifact_id: String(state.artifact_id ?? ''),
    payload_checksum: String(state.payload_checksum ?? ''),
    activation_trade_date: String(state.activation_trade_date ?? ''),
    activated_at_ms: Number(state.activated_at_ms),
    deadline_ms: Number(state.deadline_ms),
    target_price: Number(state.target_price),
  }
  return (
    normalized.artifact_id &&
    /^[a-f0-9]{64}$/.test(normalized.payload_checksum) &&
    /^\d{4}-\d{2}-\d{2}$/.test(normalized.activation_trade_date) &&
    Number.isFinite(normalized.activated_at_ms) &&
    Number.isFinite(normalized.deadline_ms) &&
    normalized.deadline_ms > normalized.activated_at_ms &&
    Number.isFinite(normalized.target_price) &&
    normalized.target_price > 0
  ) ? normalized : null
}

function writeActiveState(rawLifecycle: unknown, state: LifecycleState): string {
  const lifecycle = parseLifecycle(rawLifecycle)
  lifecycle.exit_policy = lifecycle.exit_policy && typeof lifecycle.exit_policy === 'object'
    ? { ...lifecycle.exit_policy }
    : {}
  lifecycle.exit_policy[S12_PROFIT_CONTINUATION_CONTRACT] = state
  return JSON.stringify(lifecycle)
}

function fullExit(reason: string, shares: number): ExitDecision {
  return {
    action: 'full_sell',
    reason,
    exitIntentKind: 'take_profit',
    sellShares: shares,
  }
}

export function resolveS12ProfitContinuationPolicy(input: {
  policy: PromotedS12ProfitContinuationPolicy | null
  baseDecision: ExitDecision
  position: PositionLike
  tradeDate: string
  nowMs: number
  allowActivation: boolean
}): S12ProfitContinuationResolution {
  const policy = input.policy
  const shares = Math.max(0, Math.floor(Number(input.position.shares ?? 0)))
  const active = readActiveState(input.position.trade_lifecycle_json)
  if (!policy || shares <= 0) {
    return { decision: input.baseDecision, lifecycleJson: null, state: 'inactive', artifactId: null }
  }

  if (active) {
    if (active.artifact_id !== policy.artifactId || active.payload_checksum !== policy.payloadChecksum) {
      return { decision: input.baseDecision, lifecycleJson: null, state: 'safety_exit', artifactId: policy.artifactId }
    }
    if (input.baseDecision.exitIntentKind === 'risk_stop') {
      return { decision: input.baseDecision, lifecycleJson: null, state: 'safety_exit', artifactId: policy.artifactId }
    }
    if (!input.allowActivation || active.activation_trade_date !== input.tradeDate) {
      return {
        decision: fullExit('s12_profit_continuation_session_close', shares),
        lifecycleJson: null,
        state: 'session_close_exit',
        artifactId: policy.artifactId,
      }
    }
    if (input.nowMs >= active.deadline_ms) {
      return {
        decision: fullExit('s12_profit_continuation_60m_time_exit', shares),
        lifecycleJson: null,
        state: 'deadline_exit',
        artifactId: policy.artifactId,
      }
    }
    return {
      decision: {
        action: 'hold',
        reason: 's12_profit_continuation_active',
        newTrailingStop: Math.max(finitePositive(input.position.trailing_stop) ?? 0, active.target_price),
      },
      lifecycleJson: writeActiveState(input.position.trade_lifecycle_json, active),
      state: 'continuing',
      artifactId: policy.artifactId,
    }
  }

  const finalTranche = (
    input.allowActivation &&
    input.baseDecision.action === 'full_sell' &&
    input.baseDecision.exitIntentKind === 'take_profit' &&
    FINAL_TAKE_PROFIT_REASONS.has(input.baseDecision.reason) &&
    Number(input.position.tp1_hit ?? 0) > 0 &&
    shares < Math.max(shares, Math.floor(Number(input.position.original_shares ?? shares)))
  )
  const target = finitePositive(input.baseDecision.newTrailingStop)
  if (!finalTranche || target == null) {
    return { decision: input.baseDecision, lifecycleJson: null, state: 'inactive', artifactId: policy.artifactId }
  }

  const activeState: LifecycleState = {
    status: 'active',
    artifact_id: policy.artifactId,
    payload_checksum: policy.payloadChecksum,
    activation_trade_date: input.tradeDate,
    activated_at_ms: input.nowMs,
    deadline_ms: input.nowMs + S12_PROFIT_CONTINUATION_MAX_MINUTES * 60_000,
    target_price: target,
  }
  return {
    decision: {
      action: 'hold',
      reason: 's12_profit_continuation_activated',
      newTrailingStop: Math.max(finitePositive(input.position.trailing_stop) ?? 0, target),
    },
    lifecycleJson: writeActiveState(input.position.trade_lifecycle_json, activeState),
    state: 'activated',
    artifactId: policy.artifactId,
  }
}
