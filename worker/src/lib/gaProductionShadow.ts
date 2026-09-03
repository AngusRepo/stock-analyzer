import { sha256Text } from './datasetSnapshots'
import {
  GA_CANDIDATE_LATEST_KEY,
  GA_CHAMPION_KEY,
  GA_LEGACY_LATEST_KEY,
  GA_SHADOW_ACTIVE_KEY,
  evaluateGaPromotion,
} from './gaPromotion'
import type { Bindings } from '../types'

export const GA_SHADOW_EVALUATOR_VERSION = 'ga-prospective-shadow-v1/mode-a-relative'

export const GA_SHADOW_PROMOTION_POLICY_V1 = {
  schemaVersion: 'ga-shadow-promotion-policy-v1',
  l2: { evidenceDates: 20, candidateTrades: 30 },
  l3: { evidenceDates: 40, candidateTrades: 60 },
  l4: { evidenceDates: 60, candidateTrades: 100 },
} as const

export function gaShadowStateKey(shadowId: string): string {
  return `optimizer:ga:shadow:state:${shadowId}`
}

type JsonRecord = Record<string, any>

type GaShadowCandidateRow = {
  shadow_id: string
  candidate_registry_id: string
  ga_candidate_id: string
  status: string
  candidate_config_json: string
  candidate_config_checksum: string
  baseline_config_json: string
  baseline_config_checksum: string
  evaluator_version: string
  enrolled_business_date: string
  enrollment_snapshot_id?: string | null
  enrollment_snapshot_checksum?: string | null
  source_run_id?: string | null
  source_cadence?: string | null
  last_evidence_business_date?: string | null
}

type GaShadowEvidenceRow = {
  business_date?: string | null
  candidate_total_return?: number | string | null
  baseline_total_return?: number | string | null
  paired_return_delta?: number | string | null
  candidate_total_trades?: number | string | null
  baseline_total_trades?: number | string | null
  candidate_sharpe?: number | string | null
  baseline_sharpe?: number | string | null
  candidate_max_drawdown?: number | string | null
  baseline_max_drawdown?: number | string | null
  walk_forward_pass?: number | string | null
  gate_decision?: string | null
  execution_parity_decision?: string | null
  evidence_checksum?: string | null
  snapshot_id?: string | null
  snapshot_checksum?: string | null
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function validBusinessDate(value: unknown): string | null {
  const date = String(value ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
}

function finite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function gaCandidateId(state: JsonRecord): string | null {
  const value = String(state?.best?.candidate?.id ?? '').trim()
  return value || null
}

function gaCandidateOverlay(state: JsonRecord): JsonRecord | null {
  const alphaFramework = state.best_alphaFramework
    ?? state.bestAlphaFramework
    ?? state?.best?.candidate?.params?.alphaFramework
  return alphaFramework && typeof alphaFramework === 'object' && !Array.isArray(alphaFramework)
    ? { alphaFramework }
    : null
}

export async function enrollGaProductionShadowCandidate(
  db: D1Database,
  input: {
    candidateRegistryId: string
    learningState: JsonRecord
    baselineConfig: JsonRecord
    runDate?: string | null
    runId?: string | null
    cadence?: string | null
  },
): Promise<{
  shadow_id: string
  ga_candidate_id: string
  status: 'ACTIVE' | 'QUEUED'
  candidate_config_checksum: string
  baseline_config_checksum: string
  enrolled_business_date: string
  production_effect: false
}> {
  const candidateId = gaCandidateId(input.learningState)
  const candidateConfig = gaCandidateOverlay(input.learningState)
  if (!candidateId) throw new Error('ga_shadow_candidate_id_missing')
  if (!candidateConfig) throw new Error('ga_shadow_candidate_config_missing')
  if (!input.candidateRegistryId) throw new Error('ga_shadow_candidate_registry_id_missing')
  const sourceRunId = String(input.runId ?? '').trim()
  if (!sourceRunId) throw new Error('ga_shadow_source_run_id_missing')

  const evidenceClock = input.learningState?.validation?.evidence_clock ?? {}
  const enrolledBusinessDate = validBusinessDate(
    input.runDate ?? evidenceClock.as_of_date ?? evidenceClock.data_end_date,
  )
  if (!enrolledBusinessDate) throw new Error('ga_shadow_enrolled_business_date_missing')

  const candidateConfigJson = canonicalJson(candidateConfig)
  const baselineConfigJson = canonicalJson(input.baselineConfig ?? {})
  const candidateChecksum = await sha256Text(candidateConfigJson)
  const baselineChecksum = await sha256Text(baselineConfigJson)
  const identity = canonicalJson({
    candidateId,
    candidateChecksum,
    baselineChecksum,
    evaluatorVersion: GA_SHADOW_EVALUATOR_VERSION,
    enrolledBusinessDate,
    sourceRunId,
  })
  const shadowId = `ga-shadow-v1:${(await sha256Text(identity)).replace(/^sha256:/, '').slice(0, 40)}`
  const snapshotId = String(evidenceClock.snapshot_id ?? '').trim() || null
  const snapshotChecksum = String(evidenceClock.snapshot_checksum ?? '').trim() || null

  await db.prepare(`
    INSERT INTO ga_optimizer_shadow_candidates_v1 (
      shadow_id, candidate_registry_id, ga_candidate_id, status,
      candidate_config_json, candidate_config_checksum,
      baseline_config_json, baseline_config_checksum,
      evaluator_version, enrolled_business_date,
      enrollment_snapshot_id, enrollment_snapshot_checksum,
      source_run_id, source_cadence, production_effect
    )
    SELECT ?, ?, ?,
      CASE WHEN EXISTS (
        SELECT 1 FROM ga_optimizer_shadow_candidates_v1 WHERE status='ACTIVE'
      ) THEN 'QUEUED' ELSE 'ACTIVE' END,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0
    ON CONFLICT(ga_candidate_id, candidate_config_checksum, baseline_config_checksum,
                enrolled_business_date, source_run_id)
    DO NOTHING
  `).bind(
    shadowId,
    input.candidateRegistryId,
    candidateId,
    candidateConfigJson,
    candidateChecksum,
    baselineConfigJson,
    baselineChecksum,
    GA_SHADOW_EVALUATOR_VERSION,
    enrolledBusinessDate,
    snapshotId,
    snapshotChecksum,
    sourceRunId,
    input.cadence ?? null,
  ).run()

  const row = await db.prepare(`
    SELECT shadow_id, ga_candidate_id, status, candidate_config_checksum,
           baseline_config_checksum, enrolled_business_date
      FROM ga_optimizer_shadow_candidates_v1
     WHERE ga_candidate_id=? AND candidate_config_checksum=? AND baseline_config_checksum=? AND enrolled_business_date=? AND source_run_id=?
  `).bind(candidateId, candidateChecksum, baselineChecksum, enrolledBusinessDate, sourceRunId).first<GaShadowCandidateRow>()
  if (!row || !['ACTIVE', 'QUEUED'].includes(String(row.status))) {
    throw new Error('ga_shadow_enrollment_readback_failed')
  }
  return {
    shadow_id: row.shadow_id,
    ga_candidate_id: row.ga_candidate_id,
    status: row.status as 'ACTIVE' | 'QUEUED',
    candidate_config_checksum: row.candidate_config_checksum,
    baseline_config_checksum: row.baseline_config_checksum,
    enrolled_business_date: row.enrolled_business_date,
    production_effect: false,
  }
}

export async function loadActiveGaShadowCandidate(db: D1Database): Promise<GaShadowCandidateRow | null> {
  return db.prepare(`
    SELECT shadow_id, candidate_registry_id, ga_candidate_id, status,
           candidate_config_json, candidate_config_checksum,
           baseline_config_json, baseline_config_checksum,
           evaluator_version, enrolled_business_date,
           enrollment_snapshot_id, enrollment_snapshot_checksum,
           source_run_id, source_cadence, last_evidence_business_date
      FROM ga_optimizer_shadow_candidates_v1
     WHERE status='ACTIVE'
     ORDER BY created_at ASC
     LIMIT 1
  `).first<GaShadowCandidateRow>()
}

function l2Blockers(evidenceDates: number, latest: GaShadowEvidenceRow | null): string[] {
  const blockers: string[] = []
  const policy = GA_SHADOW_PROMOTION_POLICY_V1.l2
  const trades = Math.max(0, Number(latest?.candidate_total_trades ?? 0))
  const delta = finite(latest?.paired_return_delta)
  const candidateReturn = finite(latest?.candidate_total_return)
  if (evidenceDates < policy.evidenceDates) blockers.push(`prospective_dates:${evidenceDates}/${policy.evidenceDates}`)
  if (trades < policy.candidateTrades) blockers.push(`candidate_trades:${trades}/${policy.candidateTrades}`)
  if (delta == null || delta <= 0) blockers.push('paired_return_delta_not_positive')
  if (candidateReturn == null || candidateReturn <= 0) blockers.push('candidate_return_not_positive')
  if (Number(latest?.walk_forward_pass ?? 0) !== 1) blockers.push('prospective_walk_forward_not_passed')
  return blockers
}

function advancedBlockers(
  level: 'l3' | 'l4',
  evidenceDates: number,
  latest: GaShadowEvidenceRow | null,
): string[] {
  const blockers = l2Blockers(evidenceDates, latest)
  const policy = GA_SHADOW_PROMOTION_POLICY_V1[level]
  const trades = Math.max(0, Number(latest?.candidate_total_trades ?? 0))
  if (evidenceDates < policy.evidenceDates) blockers.push(`${level}_prospective_dates:${evidenceDates}/${policy.evidenceDates}`)
  if (trades < policy.candidateTrades) blockers.push(`${level}_candidate_trades:${trades}/${policy.candidateTrades}`)
  if (String(latest?.gate_decision ?? 'MISSING').toUpperCase() !== 'PASS') blockers.push(`${level}_candidate_gate_not_passed`)
  if (String(latest?.execution_parity_decision ?? 'MISSING').toUpperCase() !== 'PASS') {
    blockers.push(`${level}_execution_parity_not_passed`)
  }
  return [...new Set(blockers)]
}

export async function buildGaShadowMaturity(
  db: D1Database,
  active?: GaShadowCandidateRow | null,
): Promise<JsonRecord | null> {
  const candidate = active ?? await loadActiveGaShadowCandidate(db)
  if (!candidate) return null
  const [countResult, latestResult] = await db.batch([
    db.prepare(`
      SELECT COUNT(*) AS evidence_dates
        FROM ga_optimizer_shadow_daily_evidence_v1
       WHERE shadow_id=?
    `).bind(candidate.shadow_id),
    db.prepare(`
      SELECT business_date, candidate_total_return, baseline_total_return,
             paired_return_delta, candidate_total_trades, baseline_total_trades,
             candidate_sharpe, baseline_sharpe,
             candidate_max_drawdown, baseline_max_drawdown,
             walk_forward_pass, gate_decision, execution_parity_decision,
             evidence_checksum, snapshot_id, snapshot_checksum
        FROM ga_optimizer_shadow_daily_evidence_v1
       WHERE shadow_id=?
       ORDER BY business_date DESC
       LIMIT 1
    `).bind(candidate.shadow_id),
  ])
  const countRow = (countResult.results?.[0] ?? {}) as { evidence_dates?: number | string }
  const latest = (latestResult.results?.[0] ?? null) as GaShadowEvidenceRow | null
  const evidenceDates = Math.max(0, Number(countRow.evidence_dates ?? 0))
  const l2 = l2Blockers(evidenceDates, latest)
  const l3 = advancedBlockers('l3', evidenceDates, latest)
  const l4 = advancedBlockers('l4', evidenceDates, latest)
  return {
    schema_version: GA_SHADOW_PROMOTION_POLICY_V1.schemaVersion,
    shadow_id: candidate.shadow_id,
    ga_candidate_id: candidate.ga_candidate_id,
    evaluator_version: candidate.evaluator_version,
    enrolled_business_date: candidate.enrolled_business_date,
    evidence_dates: evidenceDates,
    latest_evidence_date: latest?.business_date ?? null,
    l2_pass: l2.length === 0,
    l3_pass: l3.length === 0,
    l4_pass: l4.length === 0,
    blockers: { l2, l3, l4 },
    latest: latest ?? null,
    policy: GA_SHADOW_PROMOTION_POLICY_V1,
    production_effect: false,
  }
}

export async function ensureLatestGaShadowEnrolled(
  env: Bindings,
  input: { runDate: string; runId: string },
): Promise<string> {
  const { databaseForDataDomain } = await import('./dataDomainRegistry')
  const { getTradingConfig } = await import('./tradingConfig')
  const db = databaseForDataDomain(env, 'learning')
  const active = await loadActiveGaShadowCandidate(db)
  if (active) {
    return `GA shadow enrollment existing shadow_id=${active.shadow_id} candidate=${active.ga_candidate_id}`
  }

  const latest = await env.KV.get(GA_CANDIDATE_LATEST_KEY, 'json').catch(() => null) as JsonRecord | null
  if (!latest) return 'GA shadow enrollment skipped: no latest GA candidate'
  const candidateId = gaCandidateId(latest)
  if (!candidateId) throw new Error('ga_shadow_latest_candidate_identity_missing')
  const sourceRunId = String(latest?.meta?.run_id ?? latest?.meta?.push_id ?? '').trim()
  const registry = sourceRunId
    ? await db.prepare(`
        SELECT candidate_id, run_id
          FROM parameter_candidate_registry
         WHERE source='ga_optimizer' AND run_id=?
         ORDER BY updated_at DESC
         LIMIT 1
      `).bind(sourceRunId).first<{ candidate_id?: string; run_id?: string }>()
    : await db.prepare(`
        SELECT candidate_id, run_id
          FROM parameter_candidate_registry
         WHERE source='ga_optimizer'
         ORDER BY updated_at DESC
         LIMIT 1
      `).first<{ candidate_id?: string; run_id?: string }>()
  if (!registry?.candidate_id) throw new Error('ga_shadow_latest_candidate_registry_missing')

  const baselineConfig = await getTradingConfig(env.KV)
  const enrollment = await enrollGaProductionShadowCandidate(db, {
    candidateRegistryId: registry.candidate_id,
    learningState: latest,
    baselineConfig,
    runDate: input.runDate,
    runId: input.runId,
    cadence: 'daily_self_heal',
  })
  if (enrollment.status !== 'ACTIVE') {
    throw new Error(`ga_shadow_self_heal_expected_active:${enrollment.status}`)
  }
  const activeState = {
    ...latest,
    shadow: {
      schema_version: 'ga-frozen-shadow-enrollment-v1',
      ...enrollment,
      active_key: GA_SHADOW_ACTIVE_KEY,
      production_effect: false,
    },
  }
  await Promise.all([
    env.KV.put(GA_SHADOW_ACTIVE_KEY, JSON.stringify(activeState)),
    env.KV.put(gaShadowStateKey(enrollment.shadow_id), JSON.stringify(activeState)),
  ])
  const readback = await env.KV.get(GA_SHADOW_ACTIVE_KEY, 'json').catch(() => null) as JsonRecord | null
  if (
    readback?.shadow?.shadow_id !== enrollment.shadow_id ||
    gaCandidateId(readback ?? {}) !== candidateId ||
    readback?.shadow?.production_effect !== false
  ) {
    throw new Error('ga_shadow_self_heal_kv_readback_failed')
  }
  return `GA shadow enrollment created shadow_id=${enrollment.shadow_id} candidate=${candidateId} frozen_on=${input.runDate}`
}

async function rotateCompletedGaShadowIfQueued(
  env: Bindings,
  db: D1Database,
  completed: GaShadowCandidateRow,
): Promise<string | null> {
  const queued = await db.prepare(`
    SELECT shadow_id, candidate_registry_id, ga_candidate_id, status,
           candidate_config_json, candidate_config_checksum,
           baseline_config_json, baseline_config_checksum,
           evaluator_version, enrolled_business_date,
           enrollment_snapshot_id, enrollment_snapshot_checksum,
           source_run_id, source_cadence, last_evidence_business_date
      FROM ga_optimizer_shadow_candidates_v1
     WHERE status='QUEUED'
     ORDER BY created_at DESC
     LIMIT 1
  `).first<GaShadowCandidateRow>()
  if (!queued) return null

  const stored = await env.KV.get(gaShadowStateKey(queued.shadow_id), 'json').catch(() => null) as JsonRecord | null
  const latest = await env.KV.get(GA_CANDIDATE_LATEST_KEY, 'json').catch(() => null) as JsonRecord | null
  const queuedState = stored ?? (
    latest?.shadow?.shadow_id === queued.shadow_id && gaCandidateId(latest) === queued.ga_candidate_id
      ? latest
      : null
  )
  if (
    !queuedState ||
    queuedState?.shadow?.shadow_id !== queued.shadow_id ||
    gaCandidateId(queuedState) !== queued.ga_candidate_id
  ) {
    throw new Error(`ga_shadow_queued_kv_identity_mismatch:${queued.ga_candidate_id}`)
  }

  await db.batch([
    db.prepare(`
      UPDATE ga_optimizer_shadow_candidates_v1
         SET status='PROMOTION_READY', updated_at=datetime('now')
       WHERE shadow_id=? AND status='ACTIVE'
    `).bind(completed.shadow_id),
    db.prepare(`
      UPDATE ga_optimizer_shadow_candidates_v1
         SET status='ACTIVE', updated_at=datetime('now')
       WHERE shadow_id=? AND status='QUEUED'
    `).bind(queued.shadow_id),
    db.prepare(`
      UPDATE ga_optimizer_shadow_candidates_v1
         SET status='RETIRED', updated_at=datetime('now')
       WHERE status='QUEUED' AND shadow_id<>?
    `).bind(queued.shadow_id),
  ])
  const readback = await loadActiveGaShadowCandidate(db)
  if (readback?.shadow_id !== queued.shadow_id || readback.ga_candidate_id !== queued.ga_candidate_id) {
    throw new Error('ga_shadow_rotation_d1_readback_failed')
  }

  const activeState: JsonRecord = {
    ...queuedState,
    shadow: {
      ...(queuedState.shadow ?? {}),
      status: 'ACTIVE',
      active_key: GA_SHADOW_ACTIVE_KEY,
      production_effect: false,
    },
    rotation: {
      activated_at: new Date().toISOString(),
      previous_shadow_id: completed.shadow_id,
      automatic: true,
    },
    updated_at: new Date().toISOString(),
  }
  await Promise.all([
    env.KV.put(GA_SHADOW_ACTIVE_KEY, JSON.stringify(activeState)),
    env.KV.put(gaShadowStateKey(queued.shadow_id), JSON.stringify(activeState)),
    env.KV.put(GA_CANDIDATE_LATEST_KEY, JSON.stringify(activeState)),
    env.KV.put(GA_LEGACY_LATEST_KEY, JSON.stringify(activeState)),
  ])
  const kvReadback = await env.KV.get(GA_SHADOW_ACTIVE_KEY, 'json').catch(() => null) as JsonRecord | null
  if (kvReadback?.shadow?.shadow_id !== queued.shadow_id || gaCandidateId(kvReadback ?? {}) !== queued.ga_candidate_id) {
    throw new Error('ga_shadow_rotation_kv_readback_failed')
  }
  return queued.shadow_id
}

export async function refreshActiveGaShadowProjection(env: Bindings): Promise<string> {
  const { databaseForDataDomain } = await import('./dataDomainRegistry')
  const db = databaseForDataDomain(env, 'learning')
  const active = await loadActiveGaShadowCandidate(db)
  if (!active) return 'ga shadow projection skipped: no active frozen challenger'
  const state = await env.KV.get(GA_SHADOW_ACTIVE_KEY, 'json').catch(() => null) as JsonRecord | null
  if (
    !state ||
    gaCandidateId(state) !== active.ga_candidate_id ||
    state?.shadow?.shadow_id !== active.shadow_id
  ) {
    throw new Error(`ga_shadow_active_kv_identity_mismatch:${active.ga_candidate_id}`)
  }
  const maturity = await buildGaShadowMaturity(db, active)
  const nextState: JsonRecord = {
    ...state,
    shadow_maturity: maturity,
    updated_at: new Date().toISOString(),
    production_learning_loop: true,
    mutates_trading_config: false,
  }
  const decision = evaluateGaPromotion(nextState, state)
  nextState.status = decision.status
  nextState.promotion = {
    ...(state.promotion ?? {}),
    ...decision,
    evaluated_at: new Date().toISOString(),
    trading_config_unchanged: true,
    ...(decision.status === 'approved' ? {
      approved_level: decision.level,
      approval_mode: 'automatic_candidate_specific_evidence',
    } : {}),
  }
  await Promise.all([
    env.KV.put(GA_SHADOW_ACTIVE_KEY, JSON.stringify(nextState)),
    env.KV.put(gaShadowStateKey(active.shadow_id), JSON.stringify(nextState)),
  ])

  let autoRelease = 'not_ready'
  if (decision.status === 'approved' && (decision.level === 'L3' || decision.level === 'L4')) {
    const existingChampion = await env.KV.get(GA_CHAMPION_KEY, 'json').catch(() => null) as JsonRecord | null
    const order: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 }
    const existingLevel = String(existingChampion?.promotion?.level ?? '')
    const alreadyReleased =
      existingChampion?.shadow?.shadow_id === active.shadow_id &&
      (order[existingLevel] ?? -1) >= (order[decision.level] ?? -1)
    if (!alreadyReleased) {
      const championState: JsonRecord = {
        ...nextState,
        release: {
          source_candidate_key: GA_SHADOW_ACTIVE_KEY,
          released_at: new Date().toISOString(),
          released_by: 'ga_prospective_shadow_auto_promotion_v1',
          approved_level: decision.level,
          automatic: true,
          shadow_id: active.shadow_id,
          evidence_checksum: maturity?.latest?.evidence_checksum ?? null,
          production_effect: false,
          trading_config_unchanged: true,
        },
      }
      await env.KV.put(GA_CHAMPION_KEY, JSON.stringify(championState))
      const championReadback = await env.KV.get(GA_CHAMPION_KEY, 'json').catch(() => null) as JsonRecord | null
      if (
        championReadback?.shadow?.shadow_id !== active.shadow_id ||
        championReadback?.promotion?.level !== decision.level ||
        championReadback?.release?.automatic !== true
      ) {
        throw new Error('ga_shadow_auto_release_readback_failed')
      }
      autoRelease = `released_${decision.level}`
    } else {
      autoRelease = `already_released_${existingLevel}`
    }
    await db.prepare(`
      UPDATE parameter_candidate_registry
         SET status='PROD_ACTIVE', updated_at=datetime('now')
       WHERE candidate_id=?
    `).bind(active.candidate_registry_id).run()
  }
  const latest = await env.KV.get(GA_CANDIDATE_LATEST_KEY, 'json').catch(() => null) as JsonRecord | null
  if (
    latest &&
    gaCandidateId(latest) === active.ga_candidate_id &&
    latest?.shadow?.shadow_id === active.shadow_id
  ) {
    await Promise.all([
      env.KV.put(GA_CANDIDATE_LATEST_KEY, JSON.stringify(nextState)),
      env.KV.put(GA_LEGACY_LATEST_KEY, JSON.stringify(nextState)),
    ])
  }
  const rotatedTo = decision.status === 'approved' && decision.level === 'L4'
    ? await rotateCompletedGaShadowIfQueued(env, db, active)
    : null
  return [
    `ga shadow projection refreshed shadow_id=${active.shadow_id}`,
    `candidate=${active.ga_candidate_id}`,
    `evidence_dates=${maturity?.evidence_dates ?? 0}`,
    `level=${decision.level}`,
    `auto_release=${autoRelease}`,
    `rotated_to=${rotatedTo ?? 'none'}`,
    `production_effect=false`,
  ].join(' ')
}
