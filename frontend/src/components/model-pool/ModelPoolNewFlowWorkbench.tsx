import { useMemo, useState, type ReactNode } from 'react'
import {
  MODEL_POOL_ACTIVE_ALPHA_MODEL_IDS,
  MODEL_POOL_L2_COARSE_MODEL_IDS,
  MODEL_POOL_PRODUCTION_SLOT_IDS,
  MODEL_POOL_RETIRED_MODEL_IDS,
  MODEL_UPGRADE_CANDIDATES,
} from '@/lib/modelUpgradeTrack'
import type {
  ModelArtifactPromotionQueueResponse,
  ModelArtifactSelectionResponse,
  ModelChampionPointersResponse,
  ModelPoolLineageModel,
  ModelUpgradeResearchStatusRow,
} from '@/lib/api'
import {
  WorkstationPanel,
  type WorkstationTone,
} from '@/components/workstation/WorkstationChrome'

type ModelEntry = [string, ModelPoolLineageModel]

type ModelPoolNewFlowWorkbenchProps = {
  models: ModelEntry[]
  selection?: ModelArtifactSelectionResponse
  pointers?: ModelChampionPointersResponse
  promotionQueue?: ModelArtifactPromotionQueueResponse
  statusRows?: ModelUpgradeResearchStatusRow[]
  modelUpgradeStatusReady?: boolean
}

const RETIRED_MODELS = new Set<string>(MODEL_POOL_RETIRED_MODEL_IDS)
const ACTIVE_ALPHA_MODELS = new Set<string>(MODEL_POOL_ACTIVE_ALPHA_MODEL_IDS)
const PRODUCTION_SLOT_MODELS = new Set<string>(MODEL_POOL_PRODUCTION_SLOT_IDS)
const COARSE_MODELS = new Set<string>(MODEL_POOL_L2_COARSE_MODEL_IDS)
const TREE_MODELS = new Set(['LightGBM', 'XGBoost', 'ExtraTrees'])
const SEQUENCE_MODELS = new Set(['DLinear', 'PatchTST', 'iTransformer', 'TimesFM'])
const GRAPH_MODELS = new Set(['GNN'])
const TABULAR_NEURAL_MODELS = new Set(['TabM'])

const ADAPTIVE_EVIDENCE_STEPS = [
  {
    label: 'Active-9 confidence hook',
    detail: 'Risk thresholds and PF quality use active-9 verified model_accuracy only; retired models stay out of confidence and quality multipliers.',
    tone: 'ok' as const,
  },
  {
    label: 'Mode B policy replay',
    detail: 'Weekly adaptive-meta-policy-replay compares LinUCB, NeuralUCB, NeuralTS, and NeuCB as evidence-only meta-policy candidates.',
    tone: 'info' as const,
  },
  {
    label: 'LinUCB multiplier replay',
    detail: 'Weekly linucb-multiplier-replay audits bandit_* L2 constants; L2 KV push also requires Mode B replay, PBO PASS, and walk-forward PASS.',
    tone: 'info' as const,
  },
  {
    label: 'Promotion gate',
    detail: 'Artifact and parameter candidates still need final compare, explicit approval when required, and champion pointer readiness.',
    tone: 'warn' as const,
  },
]

const MODEL_DATASET_REQUIREMENTS: Record<string, { window: string; shape: string; note: string }> = {
  LightGBM: {
    window: '2-5y panel',
    shape: 'tabular feature matrix',
    note: 'Rolling features need enough panel depth for stable tree splits.',
  },
  XGBoost: {
    window: '2-5y panel',
    shape: 'tabular ranking/regression',
    note: 'Nonlinear tree interactions need the same panel history as LightGBM.',
  },
  ExtraTrees: {
    window: '2-5y panel',
    shape: 'robust tabular ensemble',
    note: 'Diversity guard against noisy features and unstable tree splits.',
  },
  TabM: {
    window: '2-5y panel',
    shape: 'normalized dense tabular',
    note: 'Sample count and feature normalization matter more than one-stock sequence length.',
  },
  GNN: {
    window: '252+ lookback',
    shape: 'market graph snapshot',
    note: 'Correlation edges should be stable enough before graph inference.',
  },
  DLinear: {
    window: '512/1024 sequence',
    shape: 'close-only contiguous series',
    note: 'Long history lets decomposition separate trend and seasonal components.',
  },
  PatchTST: {
    window: '512/1024 sequence',
    shape: 'NeuralForecast patch windows',
    note: 'Patch transformer benefits from longer, clean sequence windows.',
  },
  iTransformer: {
    window: '512/1024+ panel sequence',
    shape: 'NeuralForecast multiseries',
    note: 'Inverted attention is more useful with longer multiseries context.',
  },
  TimesFM: {
    window: '1024/2048 context',
    shape: 'TimesFM 2.5 zero-shot series',
    note: 'Use 16k context only after data depth and cost evidence justify it.',
  },
}

type SelectionModelRow = ModelArtifactSelectionResponse['models'][string]
type SelectedArtifactRow = NonNullable<SelectionModelRow['monthly_release_candidate']>
type PromotionQueueRow = ModelArtifactPromotionQueueResponse['queue'][number]

function isServing(model?: ModelPoolLineageModel): boolean {
  return model?.status === 'active' || model?.status === 'degraded'
}

function toneFromStatus(status?: string | null): WorkstationTone {
  const normalized = String(status ?? '').toLowerCase()
  if (!normalized || normalized === 'no_data') return 'neutral'
  if (
    normalized === 'active' ||
    normalized === 'production' ||
    normalized === 'registered' ||
    normalized === 'ready_for_review' ||
    normalized === 'approved_for_patch' ||
    normalized === 'pointer_ready' ||
    normalized === 'offline_strong_pass' ||
    normalized === 'offline_passed' ||
    normalized === 'live_gate_passed'
  ) return 'ok'
  if (
    normalized === 'track_only' ||
    normalized === 'not_applicable' ||
    normalized === 'offline_passed_weak' ||
    normalized === 'weak_pass'
  ) return 'info'
  if (normalized === 'degraded' || normalized === 'evaluation_pending' || normalized === 'needs_attention') return 'warn'
  if (normalized.includes('failed') || normalized === 'retired' || normalized === 'rejected' || normalized.includes('blocked')) return 'error'
  return 'neutral'
}

function modelFamily(name: string, model?: ModelPoolLineageModel): 'Tree' | 'TabM' | 'Sequence' | 'GNN' | 'Other' {
  const family = `${model?.balance_family ?? ''} ${model?.model_type ?? ''}`.toLowerCase()
  if (TREE_MODELS.has(name) || family.includes('tree') || family.includes('boost')) return 'Tree'
  if (TABULAR_NEURAL_MODELS.has(name) || family.includes('tabm') || family.includes('tabular_neural')) return 'TabM'
  if (GRAPH_MODELS.has(name) || family.includes('graph') || family.includes('gnn')) return 'GNN'
  if (SEQUENCE_MODELS.has(name) || family.includes('sequence') || family.includes('time')) return 'Sequence'
  return 'Other'
}

function latestStatusFor(candidateId: string, rows?: ModelUpgradeResearchStatusRow[]) {
  return rows?.find((row) => row.candidate_id.toLowerCase() === candidateId.toLowerCase())
}

function selectionCandidate(row?: SelectionModelRow) {
  return row?.monthly_release_candidate ?? row?.weekly_drift_candidate ?? null
}

function releaseArtifact(row?: SelectionModelRow) {
  return row?.latest_monthly_release_artifact ?? selectionCandidate(row) ?? row?.serving_release_artifact ?? null
}

function promotionPressureTone(rows: PromotionQueueRow[]): WorkstationTone {
  if (!rows.length) return 'neutral'
  if (rows.some((row) => (row.blockers?.length ?? 0) > 0 || String(row.promotion_decision ?? '').includes('blocked'))) return 'error'
  if (rows.some((row) => row.approval_required)) return 'warn'
  return 'ok'
}

function pointerTone(readiness?: string | null): WorkstationTone {
  if (readiness === 'ready' || readiness === 'pointer_ready' || readiness === 'synced') return 'ok'
  if (readiness === 'missing' || readiness === 'artifact_mismatch') return 'error'
  if (readiness) return 'warn'
  return 'neutral'
}

function toneFromIc(value: number | null | undefined): WorkstationTone {
  if (value == null || !Number.isFinite(value)) return 'neutral'
  if (value > 0.02) return 'ok'
  if (value >= 0) return 'info'
  return 'warn'
}

function artifactReady(model?: ModelPoolLineageModel, selectionRow?: SelectionModelRow): boolean {
  const artifact = releaseArtifact(selectionRow)
  return Boolean(artifact?.version || model?.version || model?.gcs_path || model?.artifact_uri)
}

function evidenceReady(model?: ModelPoolLineageModel, artifact?: SelectedArtifactRow | null): boolean {
  return Boolean(artifact?.version || model?.version || model?.gcs_path || model?.artifact_uri)
}

function pointerReady(pointerRow?: ModelChampionPointersResponse['models'][string]): boolean {
  return pointerTone(pointerRow?.readiness) === 'ok'
}

function finalCompareReady(rows: PromotionQueueRow[], selectedCandidate?: SelectedArtifactRow | null): boolean {
  const hasCandidate = rows.some((row) => Boolean(row.candidate_version)) || Boolean(selectedCandidate?.version)
  if (!hasCandidate) return false
  return rows.some((row) => Boolean(row.final_compared_to)) || Boolean(selectedCandidate?.final_compared_to)
}

function approvalClear(rows: PromotionQueueRow[]): boolean {
  return rows.length === 0 || rows.every((row) => !row.approval_required && (row.blockers?.length ?? 0) === 0)
}

type GrafanaModelRecord = {
  candidate: typeof MODEL_UPGRADE_CANDIDATES[number]
  model?: ModelPoolLineageModel
  family: ReturnType<typeof modelFamily>
  status: string
  statusTone: WorkstationTone
  fleetTone: WorkstationTone
  artifactVersion: string
  selectedArtifact?: SelectedArtifactRow | null
  dataset?: { window: string; shape: string; note: string }
  pointerRow?: ModelChampionPointersResponse['models'][string]
  pointerTone: WorkstationTone
  promotionRows: PromotionQueueRow[]
  statusRow?: ModelUpgradeResearchStatusRow
  artifactOk: boolean
  evidenceOk: boolean
  finalCompareOk: boolean
  approvalOk: boolean
  pointerOk: boolean
  releaseArtifact?: SelectedArtifactRow | null
  servingArtifact?: SelectedArtifactRow | null
  blockers: string[]
  missingEvidence: string[]
  nextAction: string
  history: Array<{
    label: string
    value: string
    detail?: string
    title: string
    tone: WorkstationTone
  }>
}

function severityScore(tone: WorkstationTone): number {
  if (tone === 'error') return 4
  if (tone === 'warn') return 3
  if (tone === 'info') return 2
  if (tone === 'ok') return 1
  return 0
}

function maxTone(tones: WorkstationTone[]): WorkstationTone {
  return tones.reduce<WorkstationTone>((winner, tone) => (
    severityScore(tone) > severityScore(winner) ? tone : winner
  ), 'neutral')
}

function fleetToneFromMatrix(statusTone: WorkstationTone, blockers: string[], history: GrafanaModelRecord['history']): WorkstationTone {
  const requiredGateLabels = new Set(['OOS IC', 'LIVE IC', 'PBO/CPCV', 'COMPARE'])
  const gateTones = history
    .filter((cell) => requiredGateLabels.has(cell.label))
    .map((cell) => (cell.tone === 'neutral' ? 'warn' : cell.tone))
  return maxTone([
    statusTone,
    blockers.length ? 'warn' : 'ok',
    ...gateTones,
  ])
}

function statusLabel(tone: WorkstationTone): string {
  if (tone === 'ok') return 'OK'
  if (tone === 'warn') return 'WARN'
  if (tone === 'error') return 'CRIT'
  if (tone === 'info') return 'INFO'
  return 'NO DATA'
}

function grafanaCellClass(tone: WorkstationTone): string {
  const base = 'rounded-[10px] shadow-[inset_0_1px_0_rgba(255,255,255,0.10)]'
  if (tone === 'ok') return `${base} border-emerald-300/35 bg-emerald-400/75 text-[#07130d]`
  if (tone === 'warn') return `${base} border-amber-300/40 bg-amber-300/80 text-[#1b1300]`
  if (tone === 'error') return `${base} border-rose-300/40 bg-rose-500/80 text-white`
  if (tone === 'info') return `${base} border-sky-300/40 bg-sky-400/75 text-[#06111a]`
  return `${base} border-slate-500/45 bg-slate-700/45 text-slate-200`
}

function grafanaBorderClass(tone: WorkstationTone): string {
  if (tone === 'ok') return 'border-emerald-400/35'
  if (tone === 'warn') return 'border-amber-300/40'
  if (tone === 'error') return 'border-rose-300/40'
  if (tone === 'info') return 'border-sky-300/35'
  return 'border-slate-600/40'
}

function grafanaTextClass(tone: WorkstationTone): string {
  if (tone === 'ok') return 'text-emerald-300'
  if (tone === 'warn') return 'text-amber-300'
  if (tone === 'error') return 'text-rose-300'
  if (tone === 'info') return 'text-sky-300'
  return 'text-slate-400'
}

function compactNumber(value: number | null | undefined, digits = 3): string {
  if (value == null || !Number.isFinite(value)) return 'N/A'
  return value.toFixed(digits)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return null
}

function compactText(value: string | null | undefined, max = 18): string {
  const text = String(value ?? '').trim()
  if (!text) return 'N/A'
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

function compactVersion(value: string | null | undefined, max = 16): string {
  const text = String(value ?? '').trim()
  if (!text) return 'pending'
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

function humanizeToken(value: string | null | undefined): string {
  const text = String(value ?? '').trim()
  if (!text) return 'none'
  return text.replace(/[_-]+/g, ' ')
}

function formatMetric(value: number | null | undefined, digits = 3): string {
  if (value == null || !Number.isFinite(value)) return 'missing'
  return value.toFixed(digits)
}

function gateToken(value?: string | null): string {
  const text = String(value ?? '').toLowerCase()
  if (!text) return 'N/A'
  if (text.includes('pass') || text.includes('ready') || text.includes('active') || text.includes('synced')) return 'PASS'
  if (text.includes('fail') || text.includes('blocked') || text.includes('reject') || text.includes('error')) return 'FAIL'
  if (text.includes('shadow')) return 'OBSERVE'
  if (text.includes('pending') || text.includes('attention') || text.includes('required') || text.includes('weak')) return 'WAIT'
  return compactText(String(value).toUpperCase(), 8)
}

function toneFromGate(value?: string | null): WorkstationTone {
  const text = String(value ?? '').toLowerCase()
  if (!text) return 'neutral'
  if (text.includes('pass') || text.includes('ready') || text.includes('active') || text.includes('synced')) return 'ok'
  if (text.includes('fail') || text.includes('blocked') || text.includes('reject') || text.includes('error')) return 'error'
  if (text.includes('weak') || text.includes('pending') || text.includes('attention') || text.includes('required')) return 'warn'
  if (text.includes('not_started') || text.includes('missing')) return 'neutral'
  return 'info'
}

function selectedArtifactEvidence(artifact?: SelectedArtifactRow | null) {
  const offline = asRecord(artifact?.offline_evidence_json)
  const live = asRecord(artifact?.live_evidence_json)
  const gate = asRecord(offline.gate)
  const metrics = asRecord(gate.metrics)
  const registration = asRecord(offline.registration)
  const lifecycleResult = asRecord(registration.artifact_lifecycle_result)
  const foundationForecastValidation = asRecord(
    registration.foundation_forecast_validation
      ?? lifecycleResult.foundation_forecast_validation
      ?? offline.foundation_forecast_validation,
  )
  const gatePolicy = asRecord(gate.policy ?? offline.policy)
  const gateCpcvPolicy = asRecord(gatePolicy.cpcv ?? gate.cpcv_policy ?? offline.cpcv_policy)
  const gatePboPolicy = asRecord(gatePolicy.pbo ?? gate.pbo_policy ?? offline.pbo_policy)
  const modelCpcv = asRecord(registration.model_cpcv ?? offline.model_cpcv ?? foundationForecastValidation)
  const validationPacket = asRecord(offline.validation_packet)
  const pbo = asRecord(offline.pbo ?? validationPacket.pbo)
  const icSummary = asRecord(offline.ic_summary)
  const cpcvPolicy = asRecord(modelCpcv.policy ?? gateCpcvPolicy)
  const pboPolicy = asRecord(pbo.policy ?? gatePboPolicy)
  return {
    offline,
    live,
    gate,
    metrics,
    registration,
    lifecycleResult,
    foundationForecastValidation,
    modelCpcv,
    pbo,
    icSummary,
    gatePolicy,
    gateCpcvPolicy,
    gatePboPolicy,
    cpcvPolicy,
    pboPolicy,
  }
}

function artifactOosIc(artifact: SelectedArtifactRow | null | undefined, candidateId: string): number | null {
  if (!artifact) return null
  const evidence = selectedArtifactEvidence(artifact)
  return firstFiniteNumber(
    evidence.metrics.oos_ic,
    evidence.icSummary[candidateId],
    evidence.modelCpcv.oos_ic_mean,
    evidence.foundationForecastValidation.oos_ic_mean,
  )
}

function compareMetricDetail(candidateOosIc: number | null, championOosIc: number | null): string {
  if (candidateOosIc == null && championOosIc == null) return 'metric diff pending'
  if (candidateOosIc == null) return `cand OOS missing / champ ${formatMetric(championOosIc, 3)}`
  if (championOosIc == null) return `cand ${formatMetric(candidateOosIc, 3)} / champ OOS missing`
  const delta = candidateOosIc - championOosIc
  return `cand ${formatMetric(candidateOosIc, 3)} / champ ${formatMetric(championOosIc, 3)} / delta ${delta >= 0 ? '+' : ''}${formatMetric(delta, 3)}`
}

function liveGateCell(candidateId: string, liveStatus: string | null | undefined) {
  const raw = String(liveStatus ?? '').trim()
  const normalized = raw.toLowerCase()
  if (!raw || normalized === 'not_started' || normalized === 'not_applicable') {
    return {
      value: 'N/R',
      detail: 'no shadow gate',
      title: `${candidateId}: active-9 does not use ML shadow/challenger ownership; live parity evidence is not required for this artifact state.`,
      tone: 'info' as WorkstationTone,
    }
  }
  if (normalized.includes('shadow')) {
    return {
      value: 'OBSERVE',
      detail: 'parity only',
      title: `${candidateId}: source returned "${raw}". In the active-9 flow this is live/parity evidence only, not an ML shadow or challenger owner.`,
      tone: 'info' as WorkstationTone,
    }
  }
  return {
    value: gateToken(raw),
    detail: compactText(raw, 18),
    title: `${candidateId}: live gate ${raw}`,
    tone: toneFromGate(raw),
  }
}

function pboCpcvCell(candidateId: string, evidence: ReturnType<typeof selectedArtifactEvidence>) {
  const pboValue = firstFiniteNumber(evidence.metrics.pbo, evidence.pbo.pbo)
  const pboMax = firstFiniteNumber(evidence.pboPolicy.max_pbo)
  const pboRequiredRaw = evidence.pboPolicy.required
  const pboRequired = typeof pboRequiredRaw === 'boolean'
    ? pboRequiredRaw
    : pboValue != null || pboMax != null
  const pboPolicyMissing = pboRequired && pboMax == null
  const oosMeanReturn = firstFiniteNumber(evidence.pbo.oos_mean_return, evidence.metrics.pbo_oos_mean_return)
  const minOosMeanReturn = firstFiniteNumber(evidence.pboPolicy.min_oos_mean_return) ?? 0
  const cpcvIc = firstFiniteNumber(
    evidence.modelCpcv.oos_ic_mean,
    evidence.modelCpcv.rank_ic,
    evidence.modelCpcv.min_rank_ic,
    evidence.metrics.model_cpcv_oos_ic,
  )
  const cpcvMinIc = firstFiniteNumber(
    evidence.cpcvPolicy.min_oos_ic_mean,
    evidence.cpcvPolicy.min_rank_ic,
    evidence.gateCpcvPolicy.min_oos_ic_mean,
  )
  const cpcvFolds = firstFiniteNumber(evidence.modelCpcv.folds)
  const cpcvMinFolds = firstFiniteNumber(evidence.cpcvPolicy.min_folds, evidence.gateCpcvPolicy.min_folds)
  const coverage = firstFiniteNumber(evidence.modelCpcv.coverage_mean, evidence.modelCpcv.coverage)
  const minCoverage = firstFiniteNumber(evidence.cpcvPolicy.min_coverage, evidence.gateCpcvPolicy.min_coverage)
  const positiveFoldRatio = firstFiniteNumber(evidence.modelCpcv.positive_fold_ratio)
  const minPositiveFoldRatio = firstFiniteNumber(evidence.cpcvPolicy.min_positive_fold_ratio, evidence.gateCpcvPolicy.min_positive_fold_ratio)
  const directionAccuracy = firstFiniteNumber(evidence.modelCpcv.direction_accuracy)
  const minDirectionAccuracy = firstFiniteNumber(evidence.cpcvPolicy.min_direction_accuracy)
  const decision = firstText(
    evidence.metrics.model_cpcv_decision,
    evidence.modelCpcv.decision,
    evidence.pbo.go_live_verdict,
    evidence.pbo.decision,
    evidence.pbo.status,
  ) ?? (typeof evidence.modelCpcv.passed === 'boolean' ? (evidence.modelCpcv.passed ? 'PASS' : 'FAIL') : null)
  const pboDetail = !pboRequired
    ? 'PBO N/R official config'
    : pboPolicyMissing
      ? 'PBO policy missing'
      : pboValue == null
        ? `PBO missing <${formatMetric(pboMax, 2)}`
        : `PBO ${formatMetric(pboValue, 2)}<${formatMetric(pboMax, 2)}`
  const cpcvDetail = cpcvMinIc == null
    ? 'CPCV policy missing'
    : cpcvIc == null
      ? `IC missing >=${formatMetric(cpcvMinIc, 3)}`
      : `IC ${formatMetric(cpcvIc, 3)}>=${formatMetric(cpcvMinIc, 3)}`
  const foldCoverageDetail = [
    cpcvMinFolds == null ? null : `folds ${formatMetric(cpcvFolds, 0)}>=${formatMetric(cpcvMinFolds, 0)}`,
    minCoverage == null ? null : `cov ${formatMetric(coverage, 3)}>=${formatMetric(minCoverage, 2)}`,
  ].filter(Boolean).join(' / ')
  const stabilityDetail = [
    minPositiveFoldRatio == null ? null : `pos-fold ${formatMetric(positiveFoldRatio, 2)}>=${formatMetric(minPositiveFoldRatio, 2)}`,
    minDirectionAccuracy == null ? null : `dir ${formatMetric(directionAccuracy, 3)}>=${formatMetric(minDirectionAccuracy, 2)}`,
  ].filter(Boolean).join(' / ')
  const detailParts = [
    pboDetail,
    cpcvDetail,
    foldCoverageDetail,
    stabilityDetail,
  ].filter(Boolean)
  const titleParts = [
    `${candidateId}: PBO/CPCV ${decision ?? 'unavailable'}`,
    !pboRequired
      ? `PBO not required: ${firstText(evidence.pboPolicy.reason, evidence.pboPolicy.method) ?? 'single official config or family policy'}`
      : `PBO=${formatMetric(pboValue, 3)} < ${formatMetric(pboMax, 2)}`,
    `PBO OOS return=${formatMetric(oosMeanReturn, 4)} >= ${formatMetric(minOosMeanReturn, 4)}`,
    `CPCV IC=${formatMetric(cpcvIc, 4)} >= ${formatMetric(cpcvMinIc, 4)}`,
    `folds=${formatMetric(cpcvFolds, 0)} >= ${formatMetric(cpcvMinFolds, 0)}`,
    `coverage=${formatMetric(coverage, 3)} >= ${formatMetric(minCoverage, 2)}`,
  ]
  const tone = decision
    ? toneFromGate(decision)
    : pboPolicyMissing || cpcvMinIc == null
      ? 'warn'
      : !pboRequired
        ? 'info'
        : 'neutral'
  return {
    value: decision ? gateToken(decision) : !pboRequired ? 'N/R' : 'N/A',
    detail: detailParts.join('\n'),
    title: titleParts.join(' | '),
    tone,
  }
}

function finalCompareCell(
  candidateId: string,
  finalComparedTo: string | null,
  hasCandidate: boolean,
  metricDetail: string,
) {
  if (!hasCandidate) {
    return {
      value: 'N/R',
      detail: 'no candidate',
      title: `${candidateId}: no selected weekly/monthly candidate is waiting for champion comparison.`,
      tone: 'info' as WorkstationTone,
    }
  }
  const ready = Boolean(finalComparedTo)
  return {
    value: ready ? 'READY' : 'WAIT',
    detail: finalComparedTo ? `vs ${compactVersion(finalComparedTo, 14)}\n${metricDetail}` : `needs final compare\n${metricDetail}`,
    title: finalComparedTo
      ? `${candidateId}: final comparison completed against ${finalComparedTo}; ${metricDetail}`
      : `${candidateId}: final comparison against current champion is still pending; ${metricDetail}`,
    tone: ready ? 'ok' as WorkstationTone : 'warn' as WorkstationTone,
  }
}

function artifactCompareSummary(record: GrafanaModelRecord) {
  const promotion = record.promotionRows[0]
  const candidate = firstText(
    promotion?.candidate_version,
    record.selectedArtifact?.version,
  )
  const releaseArtifactVersion = firstText(record.releaseArtifact?.version)
  const releaseIsServing = record.releaseArtifact?.state === 'production'
  const servingVersion = firstText(record.servingArtifact?.version)
  const artifactDisplay = candidate ?? (
    releaseArtifactVersion
      ? `${releaseIsServing ? 'serving monthly release' : 'monthly release'} ${releaseArtifactVersion}`
      : null
  )
  const champion = firstText(
    promotion?.current_champion_version,
    promotion?.evaluation_baseline_version,
    servingVersion,
    record.selectedArtifact?.final_compared_to,
    record.selectedArtifact?.evaluation_baseline_version,
    record.pointerRow?.serving_version,
    record.pointerRow?.d1_pointer_version,
  )
  const candidateEvidenceArtifact = record.selectedArtifact ?? (
    candidate && record.releaseArtifact?.version === candidate ? record.releaseArtifact : null
  )
  const candidateOosIc = artifactOosIc(candidateEvidenceArtifact, record.candidate.id)
  const championOosIc = artifactOosIc(record.servingArtifact, record.candidate.id)
  const metricDetail = compareMetricDetail(candidateOosIc, championOosIc)
  const finalComparedTo = firstText(promotion?.final_compared_to, record.selectedArtifact?.final_compared_to)
  const hasCandidate = Boolean(candidate)
  const hasReleaseArtifact = Boolean(artifactDisplay)
  const hasChampionBaseline = Boolean(champion)
  const compareReady = hasCandidate && Boolean(finalComparedTo)

  return {
    candidate: artifactDisplay ?? 'no monthly/weekly release artifact',
    champion: champion ?? 'champion baseline missing',
    finalComparedTo,
    hasCandidate,
    hasReleaseArtifact,
    hasChampionBaseline,
    compareReady,
    candidateOosIc,
    championOosIc,
    metricDetail,
    tone: compareReady ? 'ok' as WorkstationTone : hasReleaseArtifact && hasChampionBaseline ? 'info' as WorkstationTone : 'warn' as WorkstationTone,
    title: [
      `${record.candidate.id}: weekly/monthly candidate artifact is compared against the current champion baseline before pointer migration.`,
      `artifact=${artifactDisplay ?? 'missing'}`,
      `candidate_gate=${candidate ?? 'none'}`,
      `current_champion=${champion ?? 'missing'}`,
      metricDetail,
      `final_compared_to=${finalComparedTo ?? 'pending'}`,
    ].join(' | '),
  }
}

function researchStatusDiagnosis(record: GrafanaModelRecord) {
  const statusRow = record.statusRow
  const status = statusRow?.registry_status ?? 'track_only'
  const missing = uniqueTokens([
    ...(record.missingEvidence ?? []),
    ...(statusRow?.artifact_intent_missing_fields ?? []),
  ])
  const nextAction = statusRow?.next_action ?? record.nextAction
  let rootCause = 'Active-9 artifact registry is the source of truth for this cockpit; Strategy Lab research status is diagnostic only.'

  if (status === 'experiment_missing') {
    rootCause = 'No matching Strategy Lab / research experiment is registered for this model lane.'
  } else if (status === 'evaluation_pending') {
    rootCause = 'A research experiment exists, but no completed evaluation run has been attached yet.'
  } else if (status === 'needs_attention') {
    rootCause = missing.length
      ? `Evaluation exists, but evidence is incomplete: ${missing.map(humanizeToken).join(', ')}.`
      : 'Evaluation exists, but the latest verdict is needs_attention.'
  } else if (status === 'ready_for_review') {
    rootCause = 'Required research evidence is present and ready for manual review.'
  } else if (status === 'approved_for_patch') {
    rootCause = 'Research review approved this candidate for artifact registration / patch handoff.'
  } else if (status === 'rejected') {
    rootCause = 'The research lane was rejected or archived; create a new candidate experiment if needed.'
  } else if (status === 'track_only') {
    rootCause = 'This production slot is tracked inside the active-9 flow and does not need a separate research experiment gate.'
  }

  return {
    rootCause,
    nextAction: nextAction ? humanizeToken(nextAction) : 'no action queued',
    missing,
  }
}

function uniqueTokens(items: Array<string | null | undefined>): string[] {
  return [...new Set(items.map((item) => String(item ?? '').trim()).filter(Boolean))]
}

function buildEvidenceCells({
  candidateId,
  model,
  artifact,
  servingArtifact,
  selectedCandidate,
  promotionRows,
}: {
  candidateId: string
  model?: ModelPoolLineageModel
  artifact?: SelectedArtifactRow | null
  servingArtifact?: SelectedArtifactRow | null
  selectedCandidate?: SelectedArtifactRow | null
  promotionRows: PromotionQueueRow[]
}): GrafanaModelRecord['history'] {
  const weekly = (model?.weekly_ic ?? []).slice(-3)
  const paddedWeekly = [
    ...Array(Math.max(0, 3 - weekly.length)).fill(null),
    ...weekly,
  ] as Array<number | null>
  const evidence = selectedArtifactEvidence(artifact)
  const oosIc = firstFiniteNumber(
    evidence.metrics.oos_ic,
    evidence.icSummary[candidateId],
    model?.challenger?.artifact_evidence?.oos_ic,
  )
  const liveIc = firstFiniteNumber(model?.rolling_ic, model?.challenger?.rolling_ic)
  const pboCpcv = pboCpcvCell(candidateId, evidence)
  const finalComparedTo = firstText(
    promotionRows[0]?.final_compared_to,
    selectedCandidate?.final_compared_to,
  )
  const hasCandidate = Boolean(promotionRows[0]?.candidate_version || selectedCandidate?.version)
  const finalCompare = finalCompareCell(
    candidateId,
    finalComparedTo,
    hasCandidate,
    compareMetricDetail(artifactOosIc(selectedCandidate ?? artifact, candidateId), artifactOosIc(servingArtifact, candidateId)),
  )

  return [
    ...(['W-3', 'W-2', 'W-1'] as const).map((label, index) => {
      const value = paddedWeekly[index]
      const tone = toneFromIc(value)
      return {
        label,
        value: compactNumber(value),
        title: value == null ? `${candidateId} ${label}: weekly IC unavailable` : `${candidateId} ${label}: weekly IC ${value.toFixed(4)}`,
        tone,
      }
    }),
    {
      label: 'OOS IC',
      value: compactNumber(oosIc),
      title: oosIc == null ? `${candidateId}: OOS IC unavailable` : `${candidateId}: artifact OOS IC ${oosIc.toFixed(4)}`,
      tone: toneFromIc(oosIc),
    },
    {
      label: 'LIVE IC',
      value: compactNumber(liveIc),
      detail: liveIc == null ? '尚無每日 verified IC' : '每日 rolling verified IC',
      title: liveIc == null
        ? `${candidateId}: daily rolling live IC is not available yet; this is not a shadow/challenger ownership gate.`
        : `${candidateId}: daily verify-v2/model-ic-tracker rolling live IC ${liveIc.toFixed(4)}; this is not a shadow/challenger ownership gate.`,
      tone: toneFromIc(liveIc),
    },
    {
      label: 'PBO/CPCV',
      value: pboCpcv.value,
      detail: pboCpcv.detail,
      title: pboCpcv.title,
      tone: pboCpcv.tone,
    },
    {
      label: 'COMPARE',
      value: finalCompare.value,
      detail: finalCompare.detail,
      title: finalCompare.title,
      tone: finalCompare.tone,
    },
  ]
}

function buildGrafanaRecord({
  candidate,
  model,
  selectionRow,
  pointerRow,
  statusRow,
  promotionRows,
  modelUpgradeStatusReady,
}: {
  candidate: typeof MODEL_UPGRADE_CANDIDATES[number]
  model?: ModelPoolLineageModel
  selectionRow?: SelectionModelRow
  pointerRow?: ModelChampionPointersResponse['models'][string]
  statusRow?: ModelUpgradeResearchStatusRow
  promotionRows: PromotionQueueRow[]
  modelUpgradeStatusReady: boolean
}): GrafanaModelRecord {
  const artifact = selectionCandidate(selectionRow)
  const release = releaseArtifact(selectionRow)
  const servingArtifact = selectionRow?.serving_release_artifact ?? null
  const artifactOk = artifactReady(model, selectionRow)
  const evidenceOk = evidenceReady(model, release)
  const pointerOk = pointerReady(pointerRow)
  const queueTone = promotionPressureTone(promotionRows)
  const blockers = uniqueTokens([
    ...(!artifactOk ? ['artifact_missing'] : []),
    ...(!pointerOk ? ['champion_pointer_not_ready'] : []),
    ...promotionRows.flatMap((row) => (row.blockers ?? []).map((blocker) => (
      typeof blocker === 'string' ? blocker : blocker.code ?? blocker.label ?? 'promotion_blocker'
    ))),
  ])
  const rawStatus = release?.state ?? model?.status ?? 'no_data'
  const statusTone = blockers.length
    ? maxTone([toneFromStatus(rawStatus), queueTone, 'warn'])
    : maxTone([toneFromStatus(rawStatus), queueTone])
  const history = buildEvidenceCells({
    candidateId: candidate.id,
    model,
    artifact: release,
    servingArtifact,
    selectedCandidate: artifact,
    promotionRows,
  })
  const fleetTone = fleetToneFromMatrix(statusTone, blockers, history)

  return {
    candidate,
    model,
    family: modelFamily(candidate.id, model),
    status: rawStatus,
    statusTone,
    fleetTone,
    artifactVersion: release?.version ?? model?.version ?? 'no artifact',
    selectedArtifact: artifact,
    releaseArtifact: release,
    servingArtifact,
    dataset: MODEL_DATASET_REQUIREMENTS[candidate.id],
    pointerRow,
    pointerTone: pointerTone(pointerRow?.readiness),
    promotionRows,
    statusRow: modelUpgradeStatusReady ? statusRow : undefined,
    artifactOk,
    evidenceOk,
    finalCompareOk: finalCompareReady(promotionRows, artifact),
    approvalOk: approvalClear(promotionRows),
    pointerOk,
    blockers,
    missingEvidence: [],
    nextAction: promotionRows[0]?.next_action ?? pointerRow?.next_action ?? (
      artifactOk
        ? 'active-9 artifact registry evidence loaded; wait for a new candidate before final compare.'
        : 'register or backfill the active-9 model artifact.'
    ),
    history,
  }
}

function GrafanaPanel({
  title,
  kicker,
  children,
  action,
  className = '',
}: {
  title: string
  kicker?: string
  children: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <section className={`overflow-hidden rounded-2xl border border-[#2d3a49] bg-[#111821]/96 shadow-[0_14px_36px_rgba(0,0,0,0.20),inset_0_1px_0_rgba(255,255,255,0.05)] ${className}`}>
      <header className="flex min-h-12 items-center justify-between gap-3 border-b border-[#2d3a49] bg-[#18212c] px-4 py-2">
        <div className="min-w-0">
          {kicker && <p className="font-mono text-[12px] uppercase tracking-[0.10em] text-[#90a0b8]">{kicker}</p>}
          <h3 className="truncate font-['Space_Grotesk'] text-[17px] font-semibold tracking-[0.01em] text-[#eef4fb]">{title}</h3>
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

function GrafanaStat({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string | number
  detail: string
  tone: WorkstationTone
}) {
  return (
    <div className={`rounded-xl border bg-[#0c1219] px-4 py-3 ${grafanaBorderClass(tone)}`}>
      <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-[#8fa0b7]">{label}</p>
      <div className={`mt-1 font-mono text-xl font-semibold ${grafanaTextClass(tone)}`}>{value}</div>
      <p className="mt-1 text-[13px] leading-5 text-[#9aa8ba]">{detail}</p>
    </div>
  )
}

function GrafanaDashboardHeader({
  records,
  readyPointers,
  pointerTotal,
  selectedArtifacts,
  promotionCount,
}: {
  records: GrafanaModelRecord[]
  readyPointers: number
  pointerTotal: number
  selectedArtifacts: number
  promotionCount: number
}) {
  const okCount = records.filter((record) => record.fleetTone === 'ok').length
  const blockedCount = records.filter((record) => record.blockers.length > 0 || record.fleetTone === 'error').length
  const warnCount = records.filter((record) => record.fleetTone === 'warn').length
  const fleetTone = blockedCount ? 'error' : warnCount ? 'warn' : okCount === records.length ? 'ok' : 'info'
  const now = new Date()

  return (
    <div className="border-b border-[#2d3a49] bg-[#0b1118]">
      <div className="flex flex-col gap-3 border-b border-[#2d3a49] px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="font-mono text-[12px] uppercase tracking-[0.10em] text-[#f0c365]">Grafana-style model operations</p>
          <h2 className="mt-1 font-['Space_Grotesk'] text-[28px] font-semibold tracking-[0.01em] text-[#f4efe4]">Active-9 Model Pool</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[12px] uppercase tracking-[0.08em] text-[#a7b5c8]">
          <span className="rounded-full border border-[#2d3a49] bg-[#121a24] px-3 py-1">env prod</span>
          <span className="rounded-full border border-[#2d3a49] bg-[#121a24] px-3 py-1">weekly + OOS/live gates</span>
          <span className="rounded-full border border-[#2d3a49] bg-[#121a24] px-3 py-1">refresh 60s</span>
          <span className="rounded-full border border-[#2d3a49] bg-[#121a24] px-3 py-1">local {now.toLocaleTimeString()}</span>
        </div>
      </div>
      <div className="grid gap-2 bg-[#0b1118] p-3 md:grid-cols-2 xl:grid-cols-5">
        <GrafanaStat
          label="Fleet state"
          value={statusLabel(fleetTone)}
          detail={`${okCount}/${records.length} active slots green`}
          tone={fleetTone}
        />
        <GrafanaStat
          label="Blocked"
          value={blockedCount}
          detail="artifact, evidence, pointer, or gate blockers"
          tone={blockedCount ? 'error' : 'ok'}
        />
        <GrafanaStat
          label="Pointer ready"
          value={`${readyPointers}/${pointerTotal || 'N/A'}`}
          detail="champion pointer serving parity"
          tone={pointerTotal && readyPointers === pointerTotal ? 'ok' : 'warn'}
        />
        <GrafanaStat
          label="Artifacts"
          value={selectedArtifacts}
          detail="selected monthly or weekly candidates"
          tone={selectedArtifacts ? 'info' : 'neutral'}
        />
        <GrafanaStat
          label="Promotion queue"
          value={promotionCount}
          detail="rows needing review or release action"
          tone={promotionCount ? 'warn' : 'ok'}
        />
      </div>
    </div>
  )
}

function selectedFrameClass(isSelected: boolean): string {
  return isSelected ? 'border-[#f0c365]/70 bg-[#131b25] shadow-[0_0_0_1px_rgba(240,195,101,0.22)]' : 'border-[#253242] bg-[#0c1219]'
}

function FleetStatusStrip({
  records,
  selectedModelId,
  onSelectModel,
}: {
  records: GrafanaModelRecord[]
  selectedModelId?: string | null
  onSelectModel: (modelId: string) => void
}) {
  return (
    <GrafanaPanel title="Fleet status" kicker="compact active-9 state cells">
      <div className="grid gap-2 bg-[#0b1118] p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-9">
        {records.map((record) => {
          const isSelected = selectedModelId === record.candidate.id
          return (
          <button
            key={record.candidate.id}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onSelectModel(record.candidate.id)}
            className={`rounded-xl border p-3 text-left transition-colors hover:border-[#f0c365]/55 focus:outline-none focus:ring-2 focus:ring-[#f0c365]/40 ${selectedFrameClass(isSelected)}`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="truncate font-['Space_Grotesk'] text-[14px] font-semibold text-[#f2ead8]">{record.candidate.id}</p>
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${record.fleetTone === 'ok' ? 'bg-emerald-400' : record.fleetTone === 'warn' ? 'bg-amber-300' : record.fleetTone === 'error' ? 'bg-rose-400' : record.fleetTone === 'info' ? 'bg-sky-400' : 'bg-slate-500'}`} />
            </div>
            <p className="mt-1 truncate text-[12px] text-[#90a0b8]">{record.family} / {record.dataset?.window ?? 'model-specific'}</p>
            <div className={`mt-2 border px-2 py-1.5 text-center font-mono text-[12px] font-semibold ${grafanaCellClass(record.fleetTone)}`}>
              {statusLabel(record.fleetTone)}
            </div>
          </button>
          )
        })}
      </div>
    </GrafanaPanel>
  )
}

function StateTimelinePanel({
  records,
  selectedModelId,
  onSelectModel,
}: {
  records: GrafanaModelRecord[]
  selectedModelId?: string | null
  onSelectModel: (modelId: string) => void
}) {
  const labels = records[0]?.history.map((cell) => cell.label) ?? ['W-3', 'W-2', 'W-1', 'OOS IC', 'LIVE IC', 'PBO/CPCV', 'COMPARE']
  return (
    <GrafanaPanel
      title="Evidence matrix"
      kicker="weekly trend, monthly OOS evidence, daily rolling live IC, overfit guard, champion compare"
      action={<span className="font-mono text-[12px] uppercase tracking-[0.08em] text-[#90a0b8]">values include gate thresholds</span>}
      className="min-h-[360px]"
    >
      <div className="overflow-x-auto">
        <div className="min-w-[1060px]">
          <div className="grid grid-cols-[152px_repeat(7,minmax(112px,1fr))] border-b border-[#2d3a49] bg-[#0b1118] px-4 py-2.5 font-mono text-[12px] uppercase tracking-[0.08em] text-[#90a0b8]">
            <div>model</div>
            {labels.map((label) => <div key={label} className="text-center">{label}</div>)}
          </div>
          <div className="divide-y divide-[#263247]">
            {records.map((record) => {
              const isSelected = selectedModelId === record.candidate.id
              return (
              <button
                key={record.candidate.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectModel(record.candidate.id)}
                className={`grid w-full grid-cols-[152px_repeat(7,minmax(112px,1fr))] items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-[#151d28] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#f0c365]/35 ${isSelected ? 'bg-[#151d28]' : ''}`}
              >
                <div className="min-w-0">
                  <p className="truncate font-['Space_Grotesk'] text-[14px] font-semibold text-[#f2ead8]">{record.candidate.id}</p>
                  <p className="truncate text-[12px] text-[#90a0b8]">{record.family}</p>
                </div>
                {record.history.map((cell) => (
                  <div
                    key={`${record.candidate.id}-${cell.label}`}
                    className={`min-h-[82px] border px-2 py-2 text-center font-mono text-[12px] font-semibold leading-5 ${grafanaCellClass(cell.tone)}`}
                    title={cell.title}
                    aria-label={cell.title}
                  >
                    <span className="block">{cell.value}</span>
                    {cell.detail && <span className="mt-1 block whitespace-pre-line break-words text-[11px] font-medium leading-4 opacity-85">{cell.detail}</span>}
                  </div>
                ))}
              </button>
              )
            })}
          </div>
        </div>
      </div>
    </GrafanaPanel>
  )
}

function PromotionReadinessPanel({
  records,
  selectedModelId,
}: {
  records: GrafanaModelRecord[]
  selectedModelId?: string | null
}) {
  const selected = records.find((record) => record.candidate.id === selectedModelId)
    ?? records.find((record) => record.blockers.length > 0)
    ?? records[0]
  if (!selected) return null
  const compare = artifactCompareSummary(selected)
  const diagnosis = researchStatusDiagnosis(selected)

  const gates = [
    { label: 'Release artifact', ready: compare.hasReleaseArtifact, detail: compare.candidate },
    { label: 'Artifact evidence', ready: selected.evidenceOk, detail: selected.status },
    { label: 'PBO/CPCV', ready: selected.history.find((cell) => cell.label === 'PBO/CPCV')?.tone === 'ok', detail: selected.history.find((cell) => cell.label === 'PBO/CPCV')?.detail ?? 'policy pending' },
    { label: 'Champion baseline', ready: compare.hasChampionBaseline, detail: compare.champion },
    { label: 'Final compare', ready: compare.compareReady, detail: compare.finalComparedTo ?? 'pending candidate-vs-champion comparison' },
    { label: 'Approval', ready: selected.approvalOk, detail: selected.promotionRows.some((row) => row.approval_required) ? 'required' : 'clear' },
    { label: 'Current pointer baseline', ready: selected.pointerOk, detail: selected.pointerRow?.readiness ?? 'missing' },
  ]

  return (
    <GrafanaPanel title="Candidate release readiness" kicker={`selected model: ${selected.candidate.id} / release evidence; candidate gate when available; candidate gate, not current prod artifact`}>
      <div className="bg-[#0c1219] p-4">
        <div className={`rounded-xl border p-3 ${grafanaBorderClass(selected.statusTone)} bg-[#111821]`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-['Space_Grotesk'] text-[18px] font-semibold text-[#f2ead8]">{selected.candidate.id}</p>
              <p className="mt-1 text-[13px] leading-5 text-[#9aa8ba]">{selected.family} / {selected.dataset?.window ?? 'model-specific'} / {selected.artifactVersion}</p>
            </div>
            <span className={`border px-2.5 py-1 font-mono text-[12px] font-semibold ${grafanaCellClass(selected.statusTone)}`}>
              {selected.status}
            </span>
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-[#263247] bg-[#0b1118] p-3">
          <p className="font-mono text-[12px] uppercase tracking-[0.10em] text-[#90a0b8]">Research diagnosis</p>
          <p className="mt-2 text-[13px] leading-5 text-[#dce3ea]">{diagnosis.rootCause}</p>
          <div className="mt-2 rounded-lg border border-[#253242] bg-[#101722] px-3 py-2">
            <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-[#90a0b8]">next action</p>
            <p className="mt-1 text-[13px] leading-5 text-[#a7b5c8]">{diagnosis.nextAction}</p>
          </div>
          {diagnosis.missing.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {diagnosis.missing.slice(0, 5).map((item) => (
                <span key={item} className="rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 font-mono text-[12px] text-amber-200">
                  {humanizeToken(item)}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="mt-3 rounded-xl border border-[#263247] bg-[#0b1118] p-3" title={compare.title}>
          <p className="font-mono text-[12px] uppercase tracking-[0.10em] text-[#90a0b8]">Candidate vs current champion</p>
          <div className="mt-3 grid gap-2">
            <div className="rounded-lg border border-[#253242] bg-[#101722] px-3 py-2">
              <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-[#90a0b8]">candidate artifact</p>
              <p className="mt-1 break-all font-mono text-[13px] font-semibold text-[#dce3ea]">{compare.candidate}</p>
            </div>
            <div className="rounded-lg border border-[#253242] bg-[#101722] px-3 py-2">
              <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-[#90a0b8]">current champion baseline</p>
              <p className="mt-1 break-all font-mono text-[13px] font-semibold text-[#dce3ea]">{compare.champion}</p>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-[#253242] bg-[#101722] px-3 py-2">
              <div className="min-w-0">
                <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-[#90a0b8]">final compare</p>
                <p className="mt-1 truncate text-[13px] text-[#a7b5c8]">{compare.finalComparedTo ? `completed vs ${compare.finalComparedTo}` : 'waiting for promotion-controller comparison'}</p>
              </div>
              <span className={`shrink-0 border px-2.5 py-1 font-mono text-[12px] font-semibold ${grafanaCellClass(compare.tone)}`}>
                {compare.compareReady ? 'READY' : 'WAIT'}
              </span>
            </div>
            <div className="rounded-lg border border-[#253242] bg-[#101722] px-3 py-2">
              <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-[#90a0b8]">OOS IC delta</p>
              <p className="mt-1 font-mono text-[13px] font-semibold text-[#dce3ea]">{compare.metricDetail}</p>
            </div>
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-[#263247] bg-[#0b1118] p-3">
          <p className="font-mono text-[12px] uppercase tracking-[0.10em] text-[#90a0b8]">Candidate release funnel</p>
          <div className="mt-3 space-y-2">
            {gates.map((gate, index) => (
              <div key={gate.label} className="grid grid-cols-[28px_1fr_auto] items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-lg border border-[#303947] bg-[#121a24] font-mono text-[12px] text-[#a7b5c8]">{index + 1}</span>
                <div className="min-w-0">
                  <p className="font-['Space_Grotesk'] text-[14px] text-[#f2ead8]">{gate.label}</p>
                  <p className="text-[12px] leading-5 text-[#90a0b8]">{gate.detail}</p>
                </div>
                <span className={`border px-2.5 py-1 font-mono text-[12px] ${grafanaCellClass(gate.ready ? 'ok' : 'warn')}`}>
                  {gate.ready ? 'PASS' : 'WAIT'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </GrafanaPanel>
  )
}

function EvidenceTablePanel({
  records,
  selectedModelId,
  onSelectModel,
}: {
  records: GrafanaModelRecord[]
  selectedModelId?: string | null
  onSelectModel: (modelId: string) => void
}) {
  return (
    <GrafanaPanel title="Evidence table" kicker="registry, dataset, pointer, candidate compare, promotion pressure, and missing evidence">
      <div className="overflow-x-auto bg-[#0b1118] p-3">
        <table className="w-full min-w-[1240px] border-separate border-spacing-y-2 text-left">
          <thead className="font-mono text-[12px] uppercase tracking-[0.08em] text-[#90a0b8]">
            <tr>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Family</th>
              <th className="px-3 py-2 font-medium">Artifact</th>
              <th className="px-3 py-2 font-medium">Dataset</th>
              <th className="px-3 py-2 font-medium">Pointer</th>
              <th className="px-3 py-2 font-medium" title="Latest research registry state for this model artifact lane.">Research state</th>
              <th className="px-3 py-2 font-medium" title="Promotion queue load plus blockers that need review before release.">Review pressure</th>
              <th className="px-3 py-2 font-medium">Artifact compare</th>
              <th className="px-3 py-2 font-medium">Missing evidence</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => {
              const isSelected = selectedModelId === record.candidate.id
              const pressureTone = record.blockers.length ? maxTone([promotionPressureTone(record.promotionRows), 'warn']) : promotionPressureTone(record.promotionRows)
              const pressureLabel = record.promotionRows.length ? `${record.promotionRows.length} queued` : record.blockers.length ? 'blocked' : 'clear'
              const missing = uniqueTokens([...record.missingEvidence, ...record.blockers])
              const compare = artifactCompareSummary(record)
              const diagnosis = researchStatusDiagnosis(record)
              return (
              <tr
                key={record.candidate.id}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                onClick={() => onSelectModel(record.candidate.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelectModel(record.candidate.id)
                  }
                }}
                className={`cursor-pointer bg-[#111821] outline-none transition-colors hover:bg-[#151f2b] focus:bg-[#151f2b] focus:ring-2 focus:ring-inset focus:ring-[#f0c365]/35 ${isSelected ? 'bg-[#151f2b]' : ''}`}
              >
                <td className="rounded-l-xl border-y border-l border-[#263247] px-3 py-3 font-['Space_Grotesk'] text-[15px] font-semibold text-[#f2ead8]">{record.candidate.id}</td>
                <td className="border-y border-[#263247] px-3 py-3 text-[13px] text-[#a7b5c8]">{record.family}</td>
                <td className="max-w-[210px] truncate border-y border-[#263247] px-3 py-3 font-mono text-[13px] text-[#dce3ea]" title={record.artifactVersion}>{record.artifactVersion}</td>
                <td className="border-y border-[#263247] px-3 py-3">
                  <p className="font-mono text-[13px] text-sky-300">{record.dataset?.window ?? 'model-specific'}</p>
                  <p className="text-[12px] text-[#90a0b8]">{record.dataset?.shape ?? 'N/A'}</p>
                </td>
                <td className="border-y border-[#263247] px-3 py-3">
                  <span className={`border px-2.5 py-1 font-mono text-[12px] ${grafanaCellClass(record.pointerTone)}`}>
                    {record.pointerRow?.readiness ?? 'missing'}
                  </span>
                </td>
                <td className="border-y border-[#263247] px-3 py-3">
                  <span className={`border px-2.5 py-1 font-mono text-[12px] ${grafanaCellClass(record.statusTone)}`}>
                    {record.status}
                  </span>
                  <p className="mt-1 max-w-[280px] text-[12px] leading-5 text-[#a7b5c8]">{diagnosis.rootCause}</p>
                  <p className="mt-1 max-w-[280px] font-mono text-[12px] leading-5 text-sky-200">next: {diagnosis.nextAction}</p>
                </td>
                <td className="border-y border-[#263247] px-3 py-3">
                  <span className={`border px-2.5 py-1 font-mono text-[12px] ${grafanaCellClass(pressureTone)}`}>
                    {pressureLabel}
                  </span>
                </td>
                <td className="border-y border-[#263247] px-3 py-3" title={compare.title}>
                  <span className={`inline-block border px-2.5 py-1 font-mono text-[12px] ${grafanaCellClass(compare.tone)}`}>
                    {compare.compareReady ? 'ready' : compare.hasCandidate ? 'baseline' : compare.hasReleaseArtifact ? 'serving' : 'no candidate'}
                  </span>
                  <p className="mt-1 max-w-[260px] break-all font-mono text-[12px] leading-5 text-[#90a0b8]">
                    {compactVersion(compare.candidate, 18)} vs {compactVersion(compare.champion, 18)}
                  </p>
                  <p className="mt-1 max-w-[260px] font-mono text-[12px] leading-5 text-[#dce3ea]">{compare.metricDetail}</p>
                </td>
                <td className="rounded-r-xl border-y border-r border-[#263247] px-3 py-3">
                  <div className="flex max-w-[320px] flex-wrap gap-1">
                    {(missing.length ? missing : ['complete']).slice(0, 4).map((item) => (
                      <span key={item} className="rounded-full border border-[#303947] bg-[#151a22] px-2 py-0.5 font-mono text-[12px] text-[#c0cad8]">
                        {item}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </GrafanaPanel>
  )
}

function MetaBoundaryPanel() {
  return (
    <GrafanaPanel title="Meta boundary" kicker="evidence only outside active-9 alpha vote">
      <div className="grid gap-2 bg-[#0b1118] p-3 md:grid-cols-2 xl:grid-cols-4">
        {ADAPTIVE_EVIDENCE_STEPS.map((step) => (
          <div key={step.label} className="rounded-xl border border-[#263247] bg-[#0c1219] p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="font-['Space_Grotesk'] text-[14px] font-semibold text-[#f2ead8]">{step.label}</p>
              <span className={`border px-2.5 py-1 font-mono text-[12px] ${grafanaCellClass(step.tone)}`}>{statusLabel(step.tone)}</span>
            </div>
            <p className="mt-2 text-[13px] leading-5 text-[#9aa8ba]">{step.detail}</p>
          </div>
        ))}
      </div>
    </GrafanaPanel>
  )
}

export default function ModelPoolNewFlowWorkbench({
  models,
  selection,
  pointers,
  promotionQueue,
  statusRows,
  modelUpgradeStatusReady = false,
}: ModelPoolNewFlowWorkbenchProps) {
  const liveModels = useMemo(
    () => models.filter(([name]) => ACTIVE_ALPHA_MODELS.has(name) && !RETIRED_MODELS.has(name)),
    [models],
  )
  const byName = useMemo(() => new Map(liveModels), [liveModels])
  const serving = useMemo(() => liveModels.filter(([, model]) => isServing(model)), [liveModels])
  const coarse = useMemo(() => [...COARSE_MODELS].map((name) => [name, byName.get(name)] as const), [byName])
  const activeSlots = useMemo(
    () => MODEL_UPGRADE_CANDIDATES.filter((candidate) => PRODUCTION_SLOT_MODELS.has(candidate.id)),
    [],
  )
  const familyCounts = useMemo(() => {
    return serving.reduce<Record<string, number>>((acc, [name, model]) => {
      const family = modelFamily(name, model)
      acc[family] = (acc[family] ?? 0) + 1
      return acc
    }, {})
  }, [serving])
  const readyPointers = pointers?.ready_count ?? 0
  const pointerTotal = pointers?.model_count ?? 0
  const selectedArtifacts = Object.values(selection?.models ?? {}).reduce((sum, row) => {
    return sum + (row.monthly_release_candidate ? 1 : 0) + (row.weekly_drift_candidate ? 1 : 0)
  }, 0)
  const promotionCount = promotionQueue?.count ?? promotionQueue?.queue?.length ?? 0
  const grafanaRecords = useMemo(() => activeSlots.map((candidate) => buildGrafanaRecord({
    candidate,
    model: byName.get(candidate.id),
    selectionRow: selection?.models?.[candidate.id],
    pointerRow: pointers?.models?.[candidate.id],
    statusRow: latestStatusFor(candidate.id, statusRows),
    promotionRows: (promotionQueue?.queue ?? []).filter((row) => row.model_name === candidate.id),
    modelUpgradeStatusReady,
  })), [activeSlots, byName, selection, pointers, statusRows, promotionQueue, modelUpgradeStatusReady])
  const defaultSelectedModelId = useMemo(() => (
    grafanaRecords.find((record) => record.blockers.length > 0)?.candidate.id
      ?? grafanaRecords[0]?.candidate.id
      ?? null
  ), [grafanaRecords])
  const [selectedModelIdIntent, setSelectedModelIdIntent] = useState<string | null>(null)
  const selectedModelId = grafanaRecords.some((record) => record.candidate.id === selectedModelIdIntent)
    ? selectedModelIdIntent
    : defaultSelectedModelId

  return (
    <WorkstationPanel
      title="Model Ops Dashboard"
      kicker="Grafana-style fleet monitoring for L2 coarse -> L3 family model registry"
    >
      <GrafanaDashboardHeader
        records={grafanaRecords}
        readyPointers={readyPointers}
        pointerTotal={pointerTotal}
        selectedArtifacts={selectedArtifacts}
        promotionCount={promotionCount}
      />

      <div className="grid gap-4 bg-[#0b1118] p-4">
        <FleetStatusStrip
          records={grafanaRecords}
          selectedModelId={selectedModelId}
          onSelectModel={setSelectedModelIdIntent}
        />

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(340px,0.8fr)]">
          <StateTimelinePanel
            records={grafanaRecords}
            selectedModelId={selectedModelId}
            onSelectModel={setSelectedModelIdIntent}
          />
          <PromotionReadinessPanel
            records={grafanaRecords}
            selectedModelId={selectedModelId}
          />
        </div>

        <EvidenceTablePanel
          records={grafanaRecords}
          selectedModelId={selectedModelId}
          onSelectModel={setSelectedModelIdIntent}
        />
        <MetaBoundaryPanel />
      </div>

      <div className="border-t border-[#263247] bg-[#071018] p-4 text-[15px] leading-6 text-[#a7b5c8]">
        Parameter search and allocator/meta proposals stay in Promotion & Parameter Governance.
        This cockpit is only the L2/L3 model evidence surface: active slots, artifacts, verified rows,
        blockers, and champion pointer readiness.
      </div>
    </WorkstationPanel>
  )
}
