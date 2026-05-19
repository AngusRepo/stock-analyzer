import { listModelUpgradeCandidates, P7_MODEL_UPGRADE_TRACK_VERSION, type ModelUpgradeCandidate } from './modelUpgradeResearchTrack'
import {
  getResearchExperiment,
  listResearchExperiments,
  normalizeResearchExperimentInput,
  putResearchExperiment,
  updateResearchExperimentStatus,
  type ResearchExperimentRecord,
} from './researchExperimentRegistry'
import { buildResearchEvaluationPlan } from './researchEvaluationPlan'
import {
  listResearchEvaluationRunReports,
  putResearchEvaluationRunReport,
  runResearchEvaluationPlan,
  type StoredResearchEvaluationRunReport,
} from './researchEvaluationRunner'
import { listResearchPatchHandoffs } from './researchPatchHandoff'
import { listResearchArtifactIntents } from './researchArtifactIntent'
import { assertOwnerCanOwn } from './strategyOwnerFreeze'
import type { Bindings } from '../types'

export interface ModelUpgradeResearchStatusRow {
  candidate_id: string
  stage: ModelUpgradeCandidate['stage']
  family: string
  role: string
  registry_status: 'track_only' | 'experiment_missing' | 'evaluation_pending' | 'needs_attention' | 'ready_for_review' | 'approved_for_patch' | 'rejected'
  registered_experiment_ids: string[]
  latest_experiment_id: string | null
  latest_experiment_status: string | null
  latest_evaluation_verdict: StoredResearchEvaluationRunReport['verdict'] | null
  latest_evaluation_at: string | null
  latest_patch_handoff_id: string | null
  latest_patch_handoff_at: string | null
  latest_artifact_intent_id: string | null
  latest_artifact_intent_status: 'blocked_missing_artifact' | 'ready_for_registry_preflight' | null
  artifact_intent_missing_fields: string[]
  registry_preflight_ready: boolean
  requires_experiment_registry: boolean
  can_predict: boolean
  can_vote: boolean
  production_effect: false
  next_action: string
  missing_evidence: string[]
}

export interface ModelUpgradeResearchStatusReport {
  success: true
  mode: 'read_only'
  version: string
  candidates: ModelUpgradeResearchStatusRow[]
}

export interface ModelUpgradeEvaluationRunRow {
  candidate_id: string
  experiment_id: string
  stage: ModelUpgradeCandidate['stage']
  verdict: StoredResearchEvaluationRunReport['verdict']
  status_after: string
  stored_id: string
  ok_steps: number
  skipped_steps: number
  error_steps: number
}

export interface ModelUpgradeEvaluationRunReport {
  success: true
  mode: 'dry_run_execution'
  version: string
  production_effect: false
  seeded: { created: string[]; existing: string[]; total: number } | null
  requested_candidates: string[]
  runs: ModelUpgradeEvaluationRunRow[]
  status: ModelUpgradeResearchStatusReport
  blocked_capabilities: string[]
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function requiresExperimentRegistry(candidate: ModelUpgradeCandidate): boolean {
  return candidate.stage === 'shadow_challenger' || candidate.stage === 'benchmark_only'
}

function candidateAliases(candidate: ModelUpgradeCandidate): string[] {
  const id = candidate.id.toLowerCase()
  const aliases = [id]
  if (id === 'residualmlp') aliases.push('residual mlp', 'mlp')
  if (id === 'gnn') aliases.push('graph neural', 'cross-stock graph')
  if (id === 'itransformer') aliases.push('i transformer', 'inverted transformer')
  if (id === 'timesfm') aliases.push('times fm', 'foundation time-series')
  return aliases
}

export function experimentMatchesModelUpgradeCandidate(
  record: ResearchExperimentRecord,
  candidate: ModelUpgradeCandidate,
): boolean {
  const dataSlice = record.data_slice ?? {}
  const explicit = [
    ...(Array.isArray(dataSlice.benchmark_candidates) ? dataSlice.benchmark_candidates : []),
    ...(Array.isArray(dataSlice.shadow_candidates) ? dataSlice.shadow_candidates : []),
  ].map((item) => cleanText(item).toLowerCase())
  if (explicit.includes(candidate.id.toLowerCase())) return true

  const haystack = [
    record.id,
    record.hypothesis,
    ...record.source_refs,
    ...record.strategy_spec_ids,
    ...record.metrics,
    ...record.follow_up,
    JSON.stringify(record.data_slice ?? {}),
  ].join(' ').toLowerCase()
  return candidateAliases(candidate).some((alias) => haystack.includes(alias))
}

function seedInputForCandidate(candidate: ModelUpgradeCandidate): Parameters<typeof normalizeResearchExperimentInput>[0] {
  const isBenchmark = candidate.stage === 'benchmark_only'
  const isShadow = candidate.stage === 'shadow_challenger'
  return {
    id: `model-upgrade-${candidate.id.toLowerCase()}-${P7_MODEL_UPGRADE_TRACK_VERSION}`,
    status: isShadow ? 'running' : 'queued',
    hypothesis: isBenchmark
      ? `${candidate.id} model_benchmark: use Strategy Lab dry-run to evaluate ${candidate.family} as benchmark-only evidence before any shadow challenger promotion.`
      : `${candidate.id} shadow evaluation: run Strategy Lab shadow evidence checks for OOS IC, CPCV/PBO, cost profile, and data-slice readiness before any production vote.`,
    sourceRefs: ['strategy-lab-ui', 'model-upgrade-track', P7_MODEL_UPGRADE_TRACK_VERSION],
    strategySpecIds: [isBenchmark ? 'model_family_benchmark_v1' : 'model_family_shadow_v1'],
    dataSlice: {
      start_date: '2026-04-01',
      lane: isShadow ? 'tradable_shadow' : 'research_benchmark',
      benchmark_candidates: isBenchmark ? [candidate.id] : [],
      shadow_candidates: isShadow ? [candidate.id] : [],
      production_mutation_allowed: false,
    },
    metrics: isBenchmark
      ? ['model_benchmark', 'oos_ic', 'cpcv_pbo', 'cost_sensitivity', 'data_slice_report']
      : ['shadow_rank_ic', 'oos_ic', 'cpcv_pbo', 'cost_profile', 'data_slice_report'],
    followUp: isBenchmark
      ? ['run model_benchmark dry-run plan', 'inspect blockers', 'decide whether to promote to shadow challenger or reject']
      : ['run shadow evaluation dry-run plan', 'inspect shadow rows and rank IC', 'keep production unchanged until review packet passes'],
  }
}

export async function ensureModelUpgradeResearchRegistry(
  kv: KVNamespace,
  nowIso = new Date().toISOString(),
): Promise<{ created: string[]; existing: string[]; total: number }> {
  assertOwnerCanOwn('research', 'experiment_registry')
  const candidates = [
    ...listModelUpgradeCandidates('shadow_challenger'),
    ...listModelUpgradeCandidates('benchmark_only'),
  ]
  const experiments = await listResearchExperiments(kv, 100)
  const created: string[] = []
  const existing: string[] = []

  for (const candidate of candidates) {
    const matched = experiments.filter((record) => experimentMatchesModelUpgradeCandidate(record, candidate))
    if (matched.length > 0) {
      existing.push(...matched.map((record) => record.id))
      continue
    }
    const normalized = normalizeResearchExperimentInput(seedInputForCandidate(candidate), nowIso)
    if (!normalized.ok || !normalized.record) continue
    await putResearchExperiment(kv, normalized.record)
    experiments.unshift(normalized.record)
    created.push(normalized.record.id)
  }

  return {
    created,
    existing: [...new Set(existing)],
    total: experiments.length,
  }
}

function missingEvidenceFor(candidate: ModelUpgradeCandidate, latestRun: StoredResearchEvaluationRunReport | null): string[] {
  if (!latestRun) return ['evaluation_run_missing']
  if (latestRun.verdict !== 'ready_for_review') return ['evaluation_not_ready_for_review']
  const review = latestRun.review_packet.toLowerCase()
  return candidate.evidence_required.filter((item) => {
    const compact = item.toLowerCase().replace(/\s+/g, '_')
    if (compact.includes('shadow')) return !review.includes('shadow') && !review.includes('ok=')
    if (compact.includes('oos') || compact.includes('ic')) return !review.includes('oos_ic')
    if (compact.includes('pbo') || compact.includes('cpcv')) return !review.includes('pbo')
    if (compact.includes('cost')) return !review.includes('cost')
    if (compact.includes('slice')) return !review.includes('slice') && !review.includes('data')
    return false
  })
}

function evaluationTargetPriority(status: ModelUpgradeResearchStatusRow['registry_status']): number {
  if (status === 'evaluation_pending') return 0
  if (status === 'needs_attention') return 1
  if (status === 'approved_for_patch') return 2
  if (status === 'rejected') return 3
  if (status === 'ready_for_review') return 4
  return 9
}

function nextActionFor(
  latest: ResearchExperimentRecord | null,
  candidate: ModelUpgradeCandidate,
  registryStatus: ModelUpgradeResearchStatusRow['registry_status'],
  latestRun: StoredResearchEvaluationRunReport | null,
  latestHandoffId: string | null,
  latestIntentStatus: ModelUpgradeResearchStatusRow['latest_artifact_intent_status'],
): string {
  if (!requiresExperimentRegistry(candidate)) {
    if (candidate.stage === 'production_slot_member') return 'track_inside_existing_production_slot_no_new_alpha_denominator'
    if (candidate.stage === 'meta_optimizer') return 'track_meta_optimizer_governance_no_stock_alpha_vote'
    if (candidate.stage === 'state_space_overlay') return 'track_regime_risk_overlay_no_alpha_vote'
    return 'track_governance_only'
  }
  if (!latest) return 'seed_strategy_lab_experiment_registry'
  if (registryStatus === 'rejected') return 'archive_or_create_new_experiment'
  if (registryStatus === 'approved_for_patch') {
    if (!latestHandoffId) return 'generate_patch_handoff'
    if (!latestIntentStatus) return 'create_artifact_registration_intent'
    if (latestIntentStatus === 'blocked_missing_artifact') return 'attach_artifact_checksum_manifest_feature_policy'
    return 'manual_registry_owner_can_review_intent'
  }
  if (!latestRun) return 'run_strategy_lab_dry_run_evaluation_plan'
  if (registryStatus === 'ready_for_review') return 'manual_review_then_decide_shadow_or_reject'
  return 'inspect_benchmark_or_shadow_blockers'
}

export async function buildModelUpgradeResearchStatus(kv: KVNamespace): Promise<ModelUpgradeResearchStatusReport> {
  assertOwnerCanOwn('research', 'experiment_registry')
  const experiments = await listResearchExperiments(kv, 100)
  const candidates = listModelUpgradeCandidates()
  const rows: ModelUpgradeResearchStatusRow[] = []

  for (const candidate of candidates) {
    const requiresRegistry = requiresExperimentRegistry(candidate)
    if (!requiresRegistry) {
      rows.push({
        candidate_id: candidate.id,
        stage: candidate.stage,
        family: candidate.family,
        role: candidate.role,
        registry_status: 'track_only',
        registered_experiment_ids: [],
        latest_experiment_id: null,
        latest_experiment_status: null,
        latest_evaluation_verdict: null,
        latest_evaluation_at: null,
        latest_patch_handoff_id: null,
        latest_patch_handoff_at: null,
        latest_artifact_intent_id: null,
        latest_artifact_intent_status: null,
        artifact_intent_missing_fields: [],
        registry_preflight_ready: false,
        requires_experiment_registry: false,
        can_predict: candidate.can_predict,
        can_vote: candidate.can_vote,
        production_effect: false,
        next_action: nextActionFor(null, candidate, 'track_only', null, null, null),
        missing_evidence: [],
      })
      continue
    }

    const matched = experiments
      .filter((record) => experimentMatchesModelUpgradeCandidate(record, candidate))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    const latest = matched[0] ?? null
    const latestRuns = latest ? await listResearchEvaluationRunReports(kv, latest.id, 1) : []
    const latestRun = latestRuns[0] ?? null
    const latestHandoffs = latest ? await listResearchPatchHandoffs(kv, latest.id, 1) : []
    const latestHandoff = latestHandoffs[0] ?? null
    const latestIntents = latest ? await listResearchArtifactIntents(kv, latest.id, 1) : []
    const latestIntent = latestIntents[0] ?? null
    const missing = missingEvidenceFor(candidate, latestRun)
    const registryStatus: ModelUpgradeResearchStatusRow['registry_status'] = !latest
      ? 'experiment_missing'
      : latest.status === 'approved_for_patch'
        ? 'approved_for_patch'
        : latest.status === 'rejected' || latest.status === 'archived'
          ? 'rejected'
          : latestRun?.verdict === 'ready_for_review' && missing.length === 0
            ? 'ready_for_review'
            : latestRun
              ? 'needs_attention'
              : 'evaluation_pending'

    rows.push({
      candidate_id: candidate.id,
      stage: candidate.stage,
      family: candidate.family,
      role: candidate.role,
      registry_status: registryStatus,
      registered_experiment_ids: matched.map((record) => record.id).slice(0, 5),
      latest_experiment_id: latest?.id ?? null,
      latest_experiment_status: latest?.status ?? null,
      latest_evaluation_verdict: latestRun?.verdict ?? null,
      latest_evaluation_at: latestRun?.created_at ?? null,
      latest_patch_handoff_id: latestHandoff?.id ?? null,
      latest_patch_handoff_at: latestHandoff?.created_at ?? null,
      latest_artifact_intent_id: latestIntent?.id ?? null,
      latest_artifact_intent_status: latestIntent?.status ?? null,
      artifact_intent_missing_fields: latestIntent?.preflight.missing_fields ?? [],
      registry_preflight_ready: Boolean(latestIntent?.preflight.ready_for_manual_registry_write),
      requires_experiment_registry: true,
      can_predict: candidate.can_predict,
      can_vote: candidate.can_vote,
      production_effect: false,
      next_action: nextActionFor(
        latest,
        candidate,
        registryStatus,
        latestRun,
        latestHandoff?.id ?? null,
        latestIntent?.status ?? null,
      ),
      missing_evidence: missing,
    })
  }

  return {
    success: true,
    mode: 'read_only',
    version: P7_MODEL_UPGRADE_TRACK_VERSION,
    candidates: rows,
  }
}

export async function runModelUpgradeResearchEvaluations(
  env: Bindings,
  options: {
    candidateIds?: string[]
    limit?: number
    seedMissing?: boolean
    includeReady?: boolean
  } = {},
): Promise<ModelUpgradeEvaluationRunReport> {
  assertOwnerCanOwn('research', 'experiment_registry')
  const seeded = options.seedMissing === false ? null : await ensureModelUpgradeResearchRegistry(env.KV)
  const requested = new Set((options.candidateIds ?? []).map((id) => id.toLowerCase()).filter(Boolean))
  const statusBefore = await buildModelUpgradeResearchStatus(env.KV)
  const limit = Math.max(1, Math.min(options.limit ?? 10, 20))
  const targets = statusBefore.candidates
    .filter((row) => row.latest_experiment_id)
    .filter((row) => !requested.size || requested.has(row.candidate_id.toLowerCase()))
    .filter((row) => options.includeReady === true || row.registry_status !== 'ready_for_review')
    .sort((a, b) => evaluationTargetPriority(a.registry_status) - evaluationTargetPriority(b.registry_status))
    .slice(0, limit)

  const runs: ModelUpgradeEvaluationRunRow[] = []
  for (const target of targets) {
    const experiment = await getResearchExperiment(env.KV, target.latest_experiment_id!)
    if (!experiment) continue
    const plan = buildResearchEvaluationPlan(experiment)
    const report = await runResearchEvaluationPlan(env, plan)
    const stored = await putResearchEvaluationRunReport(env.KV, report)
    const statusAfter = report.verdict === 'ready_for_review' ? 'review_ready' : 'running'
    await updateResearchExperimentStatus(env.KV, experiment.id, statusAfter)
    runs.push({
      candidate_id: target.candidate_id,
      experiment_id: experiment.id,
      stage: target.stage,
      verdict: report.verdict,
      status_after: statusAfter,
      stored_id: stored.id,
      ok_steps: report.results.filter((result) => result.status === 'ok').length,
      skipped_steps: report.results.filter((result) => result.status === 'skipped').length,
      error_steps: report.results.filter((result) => result.status === 'error').length,
    })
  }

  return {
    success: true,
    mode: 'dry_run_execution',
    version: P7_MODEL_UPGRADE_TRACK_VERSION,
    production_effect: false,
    seeded,
    requested_candidates: [...requested],
    runs,
    status: await buildModelUpgradeResearchStatus(env.KV),
    blocked_capabilities: ['production retrain', 'model promote', 'production deploy', 'paper/live trade execution'],
  }
}
