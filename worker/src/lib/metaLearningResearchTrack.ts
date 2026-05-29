import { assertOwnerCanOwn } from './strategyOwnerFreeze'
import {
  listResearchExperiments,
  normalizeResearchExperimentInput,
  putResearchExperiment,
  type ResearchExperimentRecord,
} from './researchExperimentRegistry'

export type MetaLearningTrackStage =
  | 'production_baseline'
  | 'counterfactual_audit'
  | 'production_controller'
  | 'strategy_research'
  | 'research_only'

export type MetaLearningTrackId =
  | 'LinUCB'
  | 'NeuralUCB'
  | 'NeuralTS'
  | 'OnlinePortfolioBandit'
  | 'NeuCB'

export interface MetaLearningTrack {
  id: MetaLearningTrackId
  stage: MetaLearningTrackStage
  role: string
  learning_targets: string[]
  required_evidence: string[]
  experiment_template: {
    hypothesis: string
    sourceRefs: string[]
    strategySpecIds: string[]
    dataSlice: Record<string, unknown>
    metrics: string[]
    followUp: string[]
  }
  decision_queue_status:
    | 'production_baseline_needs_evidence'
    | 'run_counterfactual_audit'
    | 'controller_evidence_active'
    | 'needs_experiment_registry'
    | 'research_only'
  can_influence_production: boolean
  can_vote_alpha: false
  next_action: string
  registered_experiment_ids: string[]
}

export const META_LEARNING_TRACK_VERSION = 'meta-learning-track-v1'

export interface MetaRewardLedgerRow {
  policy_id: MetaLearningTrackId | string
  arm_id: string
  context_hash?: string
  samples: number
  reward_mean?: number | null
  updated_at?: string | null
}

export interface MetaShadowDecisionEvidence {
  policy_id: MetaLearningTrackId | string
  samples: number
  counterfactual_reward_mean?: number | null
  latest_decision_at?: string | null
}

export interface MetaLearningEvidenceMatrixRow {
  id: MetaLearningTrackId
  stage: MetaLearningTrackStage
  decision_queue_status: MetaLearningTrack['decision_queue_status']
  evidence_status: 'ready' | 'partial' | 'missing'
  reward_ledger_status: 'ready' | 'missing' | 'not_applicable'
  shadow_status: 'ready' | 'partial' | 'missing' | 'not_applicable'
  registered_experiment_count: number
  samples: number
  latest_evidence_at: string | null
  next_action: string
  missing_evidence: string[]
}

const TRACKS: readonly Omit<MetaLearningTrack, 'registered_experiment_ids'>[] = [
  {
    id: 'LinUCB',
    stage: 'production_baseline',
    role: 'existing interpretable contextual bandit meta-router; it should explain family weights and threshold/sizing protection',
    learning_targets: ['model_family_weights', 'threshold_delta', 'position_sizing_multiplier'],
    required_evidence: ['reward_ledger', 'per_arm_samples', 'per_arm_reward_history', 'replay_simulation', 'context_vector_coverage'],
    experiment_template: {
      hypothesis: 'Audit LinUCB production meta-router with per-arm reward ledger, expanded context vector coverage and replay simulation before any policy change.',
      sourceRefs: ['p8-linucb-baseline', 'meta_reward_ledger'],
      strategySpecIds: ['meta_router_linucb_baseline_v1'],
      dataSlice: { start_date: '2026-04-01', lane: 'all', regime: 'all' },
      metrics: ['per_arm_samples', 'reward_mean', 'context_coverage', 'replay_hit_rate', 'turnover'],
      followUp: ['persist reward ledger', 'compare current weights vs replay weights', 'surface arm-level evidence in OBS'],
    },
    decision_queue_status: 'production_baseline_needs_evidence',
    can_influence_production: true,
    can_vote_alpha: false,
    next_action: 'persist reward ledger and expose per-arm samples/reward history before changing policy',
  },
  {
    id: 'NeuralUCB',
    stage: 'counterfactual_audit',
    role: 'nonlinear counterfactual meta-router to compare against LinUCB without changing production decisions',
    learning_targets: ['model_family_weights', 'alpha_bucket_weights', 'threshold_delta', 'regime_exploration'],
    required_evidence: ['counterfactual_decisions', 'counterfactual_rewards', 'replay_simulation', 'regime_slice', 'pbo'],
    experiment_template: {
      hypothesis: 'Run NeuralUCB as a counterfactual meta-router beside LinUCB and compare model weights, threshold deltas and regime-sliced reward.',
      sourceRefs: ['p9-neuralucb-counterfactual', 'meta_shadow_decisions'],
      strategySpecIds: ['meta_router_neuralucb_counterfactual_v1'],
      dataSlice: { start_date: '2026-04-01', lane: 'tradable', regime: 'bull|sideways|volatile' },
      metrics: ['counterfactual_reward', 'regime_slice_reward', 'pbo', 'drawdown_slice', 'decision_disagreement_rate'],
      followUp: ['write counterfactual decisions', 'compare against LinUCB reward ledger', 'keep production unchanged'],
    },
    decision_queue_status: 'run_counterfactual_audit',
    can_influence_production: false,
    can_vote_alpha: false,
    next_action: 'run counterfactual decisions beside LinUCB and compare reward distribution',
  },
  {
    id: 'NeuralTS',
    stage: 'counterfactual_audit',
    role: 'Thompson sampling counterfactual audit used to check whether NeuralUCB is too optimistic',
    learning_targets: ['model_family_weights', 'threshold_delta', 'uncertainty_calibration'],
    required_evidence: ['counterfactual_decisions', 'posterior_uncertainty', 'counterfactual_rewards', 'replay_simulation', 'drawdown_slice'],
    experiment_template: {
      hypothesis: 'Run Neural Thompson Sampling as a second counterfactual policy to test uncertainty calibration and prevent over-optimistic NeuralUCB exploration.',
      sourceRefs: ['p9-neuralts-counterfactual', 'meta_shadow_decisions'],
      strategySpecIds: ['meta_router_neuralts_counterfactual_v1'],
      dataSlice: { start_date: '2026-04-01', lane: 'tradable', uncertainty_bucket: 'all' },
      metrics: ['counterfactual_reward', 'posterior_uncertainty', 'calibration_error', 'drawdown_slice', 'decision_disagreement_rate'],
      followUp: ['write counterfactual decisions', 'compare NeuralTS vs NeuralUCB disagreement', 'keep production unchanged'],
    },
    decision_queue_status: 'run_counterfactual_audit',
    can_influence_production: false,
    can_vote_alpha: false,
    next_action: 'run second counterfactual policy and require disagreement/evidence report before any promotion proposal',
  },
  {
    id: 'OnlinePortfolioBandit',
    stage: 'production_controller',
    role: 'warm-start constrained UCB controller for allocator knobs; sparse_tangent_inverse_risk remains the final weight engine',
    learning_targets: ['candidate_count', 'max_weight', 'cash_buffer', 'min_trade_weight', 'turnover_budget', 'portfolio_risk_budget'],
    required_evidence: ['strategy_lab_experiment', 'warm_start_reward_ledger', 'paper_live_parity', 'slippage_model', 'partial_fill_replay', 'portfolio_drawdown'],
    experiment_template: {
      hypothesis: 'Run OnlinePortfolioBandit as sparse_tangent_inverse_risk allocator controller and compare warm-start constrained UCB knob choices against the approved allocation baseline.',
      sourceRefs: ['p9-online-portfolio-bandit', 'execution_realism_v1', 'sparse_tangent_inverse_risk'],
      strategySpecIds: ['portfolio_bandit_allocator_controller_v1'],
      dataSlice: { start_date: '2026-04-01', lane: 'production_controller', execution_model: 'paper_realism_v2' },
      metrics: ['portfolio_return', 'mdd', 'turnover', 'slippage_sensitivity', 'partial_fill_replay', 'capital_utilization', 'baseline_delta'],
      followUp: ['persist warm-start reward ledger', 'write allocator-controller attribution', 'do not change production knobs without Wei approval'],
    },
    decision_queue_status: 'controller_evidence_active',
    can_influence_production: true,
    can_vote_alpha: false,
    next_action: 'use as allocator knob controller only; sparse_tangent_inverse_risk remains the final weight engine and knob-policy changes require evidence',
  },
  {
    id: 'NeuCB',
    stage: 'research_only',
    role: 'neural contextual bandit benchmark; useful for literature comparison, not a production router until registry evidence exists',
    learning_targets: ['nonlinear_context_embedding', 'model_family_weights', 'exploration_policy'],
    required_evidence: ['strategy_lab_experiment', 'benchmark_report', 'oos_reward', 'pbo', 'cost_profile'],
    experiment_template: {
      hypothesis: 'Benchmark NeuCB as a research-only neural contextual bandit against LinUCB plus NeuralUCB/NeuralTS counterfactual audits on OOS reward and cost.',
      sourceRefs: ['p9-neucb-research', 'strategy_lab_benchmark'],
      strategySpecIds: ['neucb_research_benchmark_v1'],
      dataSlice: { start_date: '2026-04-01', lane: 'all', context_family: 'expanded_meta_context' },
      metrics: ['oos_reward', 'pbo', 'deflated_sharpe', 'cost_profile', 'latency_ms', 'regime_slice_reward'],
      followUp: ['create benchmark report', 'compare cost vs NeuralUCB/NeuralTS', 'stay research-only until evidence is ready'],
    },
    decision_queue_status: 'research_only',
    can_influence_production: false,
    can_vote_alpha: false,
    next_action: 'keep research-only until benchmark report proves it improves LinUCB and counterfactual-audit results',
  },
] as const

function experimentMatchesTrack(record: ResearchExperimentRecord, trackId: MetaLearningTrackId): boolean {
  const haystack = [
    record.id,
    record.hypothesis,
    ...record.source_refs,
    ...record.strategy_spec_ids,
    ...record.metrics,
    ...record.follow_up,
    JSON.stringify(record.data_slice ?? {}),
  ].join(' ').toLowerCase()
  const aliases: Record<MetaLearningTrackId, string[]> = {
    LinUCB: ['linucb', 'linear ucb'],
    NeuralUCB: ['neuralucb', 'neural ucb'],
    NeuralTS: ['neuralts', 'neural ts', 'neural thompson'],
    OnlinePortfolioBandit: ['onlineportfoliobandit', 'online portfolio bandit', 'portfolio bandit'],
    NeuCB: ['neucb', 'neural contextual bandit'],
  }
  return aliases[trackId].some((alias) => haystack.includes(alias))
}

export function listMetaLearningTracks(experiments: ResearchExperimentRecord[] = []): MetaLearningTrack[] {
  assertOwnerCanOwn('research', 'experiment_registry')
  return TRACKS.map((track) => ({
      ...track,
      learning_targets: [...track.learning_targets],
      required_evidence: [...track.required_evidence],
      experiment_template: {
        ...track.experiment_template,
        sourceRefs: [...track.experiment_template.sourceRefs],
        strategySpecIds: [...track.experiment_template.strategySpecIds],
        dataSlice: { ...track.experiment_template.dataSlice },
        metrics: [...track.experiment_template.metrics],
        followUp: [...track.experiment_template.followUp],
      },
    registered_experiment_ids: experiments
      .filter((record) => experimentMatchesTrack(record, track.id))
      .map((record) => record.id)
      .slice(0, 10),
  }))
}

export function buildMetaLearningDecisionPacket(experiments: ResearchExperimentRecord[] = []): string {
  const tracks = listMetaLearningTracks(experiments)
  const lines = [
    `Meta learning research track: ${META_LEARNING_TRACK_VERSION}`,
    'Rules: LinUCB remains the interpretable meta baseline; NeuralUCB and NeuralTS are counterfactual audits; OnlinePortfolioBandit controls allocator knobs with evidence and approval gates; NeuCB stays research-only.',
  ]
  for (const track of tracks) {
    lines.push(`${track.id}: stage=${track.stage}, status=${track.decision_queue_status}, experiments=${track.registered_experiment_ids.join(',') || 'none'}`)
  }
  return lines.join('\n')
}

export async function ensureMetaLearningResearchRegistry(
  kv: KVNamespace,
  nowIso = new Date().toISOString(),
): Promise<{ created: string[]; existing: string[]; total: number }> {
  assertOwnerCanOwn('research', 'experiment_registry')

  const existingRecords = await listResearchExperiments(kv, 100)
  const existingByTrack = new Map<MetaLearningTrackId, string[]>()
  for (const track of TRACKS) {
    existingByTrack.set(
      track.id,
      existingRecords
        .filter((record) => experimentMatchesTrack(record, track.id))
        .map((record) => record.id),
    )
  }

  const created: string[] = []
  for (const track of TRACKS) {
    if ((existingByTrack.get(track.id) ?? []).length > 0) continue
    const normalized = normalizeResearchExperimentInput({
      id: `meta-${track.id.toLowerCase()}-${META_LEARNING_TRACK_VERSION}`,
      status: track.stage === 'production_baseline' || track.stage === 'counterfactual_audit' || track.stage === 'production_controller'
        ? 'running'
        : 'queued',
      hypothesis: track.experiment_template.hypothesis,
      sourceRefs: track.experiment_template.sourceRefs,
      strategySpecIds: track.experiment_template.strategySpecIds,
      dataSlice: track.experiment_template.dataSlice,
      metrics: track.experiment_template.metrics,
      followUp: track.experiment_template.followUp,
    }, nowIso)
    if (!normalized.ok || !normalized.record) continue
    await putResearchExperiment(kv, normalized.record)
    created.push(normalized.record.id)
  }

  return {
    created,
    existing: [...existingByTrack.values()].flat(),
    total: existingRecords.length + created.length,
  }
}

function totalSamples(rows: Array<{ samples: number }>): number {
  return rows.reduce((sum, row) => sum + Math.max(0, Number(row.samples) || 0), 0)
}

function latestAt(values: Array<string | null | undefined>): string | null {
  return values
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .sort()
    .at(-1) ?? null
}

export function buildMetaLearningEvidenceMatrix(
  tracks: MetaLearningTrack[],
  evidence: {
    rewardLedger?: MetaRewardLedgerRow[]
    shadowDecisions?: MetaShadowDecisionEvidence[]
  } = {},
): MetaLearningEvidenceMatrixRow[] {
  assertOwnerCanOwn('research', 'experiment_registry')
  const rewardLedger = evidence.rewardLedger ?? []
  const shadowDecisions = evidence.shadowDecisions ?? []

  return tracks.map((track) => {
    const rewardRows = rewardLedger.filter((row) => String(row.policy_id).toLowerCase() === track.id.toLowerCase())
    const shadowRows = shadowDecisions.filter((row) => String(row.policy_id).toLowerCase() === track.id.toLowerCase())
    const rewardSamples = totalSamples(rewardRows)
    const shadowSamples = totalSamples(shadowRows)
    const registeredExperimentCount = track.registered_experiment_ids.length

    const rewardLedgerStatus: MetaLearningEvidenceMatrixRow['reward_ledger_status'] =
      track.id === 'LinUCB' || track.id === 'OnlinePortfolioBandit'
        ? rewardSamples >= 30 ? 'ready' : 'missing'
        : 'not_applicable'

    const shadowStatus: MetaLearningEvidenceMatrixRow['shadow_status'] =
      track.stage === 'counterfactual_audit'
        ? shadowSamples >= 30 ? 'ready' : shadowSamples > 0 ? 'partial' : 'missing'
        : 'not_applicable'

    const hasResearchEvidence = registeredExperimentCount > 0
    const evidenceStatus: MetaLearningEvidenceMatrixRow['evidence_status'] =
      track.stage === 'production_baseline'
        ? rewardLedgerStatus === 'ready' ? 'ready' : 'missing'
        : track.stage === 'counterfactual_audit'
          ? shadowStatus === 'ready' && hasResearchEvidence ? 'ready' : shadowStatus !== 'missing' || hasResearchEvidence ? 'partial' : 'missing'
          : track.stage === 'production_controller'
            ? rewardLedgerStatus === 'ready' && hasResearchEvidence ? 'ready' : rewardLedgerStatus === 'ready' || hasResearchEvidence ? 'partial' : 'missing'
          : hasResearchEvidence ? 'partial' : 'missing'

    const missingEvidence = track.required_evidence.filter((item) => {
      const lower = item.toLowerCase()
      if (lower.includes('reward') || lower.includes('per_arm')) return rewardLedgerStatus !== 'ready'
      if (lower.includes('shadow') || lower.includes('counterfactual')) return shadowStatus === 'missing'
      if (lower.includes('experiment') || lower.includes('strategy_lab') || lower.includes('benchmark')) return !hasResearchEvidence
      return evidenceStatus === 'missing'
    })

    return {
      id: track.id,
      stage: track.stage,
      decision_queue_status: track.decision_queue_status,
      evidence_status: evidenceStatus,
      reward_ledger_status: rewardLedgerStatus,
      shadow_status: shadowStatus,
      registered_experiment_count: registeredExperimentCount,
      samples: rewardSamples + shadowSamples,
      latest_evidence_at: latestAt([
        ...rewardRows.map((row) => row.updated_at),
        ...shadowRows.map((row) => row.latest_decision_at),
      ]),
      next_action: track.next_action,
      missing_evidence: missingEvidence,
    }
  })
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export async function listMetaRewardLedgerRows(db: D1Database, limit = 200): Promise<MetaRewardLedgerRow[]> {
  try {
    const { results } = await db.prepare(`
      SELECT policy_id, arm_id, context_hash, samples, reward_mean, updated_at
        FROM meta_reward_ledger
       ORDER BY updated_at DESC
       LIMIT ?
    `).bind(Math.max(1, Math.min(limit, 500))).all<Record<string, unknown>>()
    return (results ?? []).map((row) => ({
      policy_id: String(row.policy_id ?? ''),
      arm_id: String(row.arm_id ?? ''),
      context_hash: String(row.context_hash ?? 'global'),
      samples: toFiniteNumber(row.samples),
      reward_mean: row.reward_mean == null ? null : toFiniteNumber(row.reward_mean),
      updated_at: row.updated_at == null ? null : String(row.updated_at),
    }))
  } catch {
    return []
  }
}

export async function listMetaShadowDecisionEvidence(db: D1Database, limit = 500): Promise<MetaShadowDecisionEvidence[]> {
  try {
    const { results } = await db.prepare(`
      SELECT policy_id,
             COUNT(*) AS samples,
             AVG(counterfactual_reward) AS counterfactual_reward_mean,
             MAX(created_at) AS latest_decision_at
        FROM meta_shadow_decisions
       GROUP BY policy_id
       ORDER BY latest_decision_at DESC
       LIMIT ?
    `).bind(Math.max(1, Math.min(limit, 1000))).all<Record<string, unknown>>()
    return (results ?? []).map((row) => ({
      policy_id: String(row.policy_id ?? ''),
      samples: toFiniteNumber(row.samples),
      counterfactual_reward_mean: row.counterfactual_reward_mean == null ? null : toFiniteNumber(row.counterfactual_reward_mean),
      latest_decision_at: row.latest_decision_at == null ? null : String(row.latest_decision_at),
    }))
  } catch {
    return []
  }
}

export function validateMetaLearningTrack(): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const track of TRACKS) {
    if (seen.has(track.id)) errors.push(`duplicate_track:${track.id}`)
    seen.add(track.id)
    if (track.can_vote_alpha !== false) errors.push(`meta_track_can_vote_alpha:${track.id}`)
    if (
      track.stage !== 'production_baseline'
      && !(track.id === 'OnlinePortfolioBandit' && track.stage === 'production_controller')
      && track.can_influence_production
    ) {
      errors.push(`non_baseline_can_influence_production:${track.id}`)
    }
    if (track.stage === 'production_baseline' && track.id !== 'LinUCB') {
      errors.push(`unexpected_production_baseline:${track.id}`)
    }
    if (track.required_evidence.length < 3) errors.push(`insufficient_evidence_contract:${track.id}`)
  }
  return { ok: errors.length === 0, errors }
}
