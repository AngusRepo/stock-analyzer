import { useMemo, useState, type ReactNode } from 'react'
import {
  MODEL_POOL_ACTIVE_ALPHA_MODEL_IDS,
  MODEL_POOL_PRODUCTION_SLOT_IDS,
  MODEL_POOL_RETIRED_MODEL_IDS,
  MODEL_UPGRADE_CANDIDATES,
} from '@/lib/modelUpgradeTrack'
import type {
  ModelArtifactPromotionQueueResponse,
  ModelArtifactPromotionControllerResponse,
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
  promotionResult?: ModelArtifactPromotionControllerResponse | null
  finalComparePending?: boolean
  onDryRunFinalCompare?: (artifactId: string) => void
}

const RETIRED_MODELS = new Set<string>(MODEL_POOL_RETIRED_MODEL_IDS)
const ACTIVE_ALPHA_MODELS = new Set<string>(MODEL_POOL_ACTIVE_ALPHA_MODEL_IDS)
const PRODUCTION_SLOT_MODELS = new Set<string>(MODEL_POOL_PRODUCTION_SLOT_IDS)
const TREE_MODELS = new Set(['LightGBM', 'XGBoost', 'ExtraTrees'])
const SEQUENCE_MODELS = new Set(['DLinear', 'PatchTST', 'iTransformer'])
const L2_SIDECAR_MODELS = new Set(['TimesFM'])
const GRAPH_MODELS = new Set(['GNN'])
const TABULAR_NEURAL_MODELS = new Set(['TabM'])

const ADAPTIVE_EVIDENCE_STEPS = [
  {
    label: 'Active-8 confidence hook',
    detail: 'Risk thresholds and PF quality use active-8 direct-alpha verified model_accuracy only; retired models and TimesFM sidecar stay out of confidence and quality multipliers.',
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

const EVIDENCE_MATRIX_COLUMNS = [
  { label: 'W-3', description: '三週前 weekly IC；看短期趨勢，不是升級門檻。' },
  { label: 'W-2', description: '兩週前 weekly IC；用來觀察是否連續轉弱。' },
  { label: 'W-1', description: '上週 weekly IC；反映最近一次已驗證週期。' },
  { label: 'FULL OOF IC', description: '單一模型完整 immutable CPCV／OOF 窗口的平均 rank IC；不可直接和 ensemble 尾端 validation IC 比較。' },
  { label: 'LIVE IC', description: 'daily verify 後的 rolling live rank IC；看上線後近期真實命中。' },
  { label: 'BASE CPCV', description: '各模型自己的 5-fold purged OOF 證據；bundle selection validation 另由 V5 ensemble owner 持有。' },
  { label: 'COMPARE', description: 'candidate vs current champion 的最終比較；dry-run 不切 pointer。' },
] as const

type SelectionModelRow = ModelArtifactSelectionResponse['models'][string]
type SelectedArtifactRow = NonNullable<SelectionModelRow['oof_full_fit_release_candidate']>
type RegistryArtifactRow = NonNullable<SelectionModelRow['latest_oof_full_fit_release_artifact']>
type PromotionQueueRow = ModelArtifactPromotionQueueResponse['queue'][number]

function isServing(model?: ModelPoolLineageModel): boolean {
  return (model?.status === 'active' || model?.status === 'degraded')
    && !model.serving_block_reason
    && Boolean(model.serving_owner || model.serving_artifact_id)
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

function modelFamily(name: string, model?: ModelPoolLineageModel): 'Tree' | 'TabM' | 'Sequence' | 'GNN' | 'Sidecar' | 'Other' {
  const family = `${model?.balance_family ?? ''} ${model?.model_type ?? ''}`.toLowerCase()
  if (L2_SIDECAR_MODELS.has(name) || family.includes('sidecar') || family.includes('timesfm_l2')) return 'Sidecar'
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
  return row?.oof_full_fit_release_candidate ?? null
}

function selectedPromotionRow(
  modelId: string,
  selectionRow: SelectionModelRow | undefined,
  rows: PromotionQueueRow[],
): PromotionQueueRow | null {
  const selected = selectionCandidate(selectionRow)
  if (!selected) return null
  const modelRows = rows.filter((row) => row.model_name === modelId)
  const artifactId = String(selected.artifact_id ?? '').trim()
  const version = String(selected.version ?? '').trim()
  return modelRows.find((row) => artifactId && row.artifact_id === artifactId)
    ?? modelRows.find((row) => version && row.candidate_version === version)
    ?? null
}

function v5ServingArtifact(
  row: SelectionModelRow | undefined,
  pointer?: ModelChampionPointersResponse['models'][string],
) {
  const serving = row?.serving_release_artifact ?? null
  return pointer?.readiness === 'v5_serving'
    && Boolean(pointer.serving_artifact_id)
    && pointer.serving_artifact_id === serving?.artifact_id
    ? serving
    : null
}

function promotionPressureTone(rows: PromotionQueueRow[]): WorkstationTone {
  if (!rows.length) return 'neutral'
  if (rows.some((row) => (row.blockers?.length ?? 0) > 0 || String(row.promotion_decision ?? '').includes('blocked'))) return 'error'
  if (rows.some((row) => row.approval_required)) return 'warn'
  return 'ok'
}

function pointerTone(readiness?: string | null): WorkstationTone {
  if (readiness === 'v5_serving' || readiness === 'ready' || readiness === 'pointer_ready' || readiness === 'synced') return 'ok'
  if (readiness === 'evidence_only_no_action') return 'info'
  if (readiness === 'validation_failed' || readiness === 'missing' || readiness === 'artifact_mismatch') return 'error'
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
  const artifact = selectionRow?.latest_oof_full_fit_release_artifact
  return Boolean(artifact?.version)
}

function evidenceReady(_model?: ModelPoolLineageModel, artifact?: SelectedArtifactRow | null): boolean {
  return Boolean(artifact?.version)
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
  slotStatus: string
  servingStatus: string
  statusTone: WorkstationTone
  fleetTone: WorkstationTone
  artifactVersion: string
  selectedArtifact?: SelectedArtifactRow | null
  latestRetrainArtifact?: RegistryArtifactRow | null
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
  const requiredGateLabels = new Set(['FULL OOF IC', 'LIVE IC', 'BASE CPCV', 'COMPARE'])
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

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean)
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed.map((item) => String(item ?? '').trim()).filter(Boolean)
    } catch {
      return [value.trim()]
    }
  }
  return []
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
  const registration = asRecord(offline.registration)
  const gate = asRecord(offline.gate)
  const metrics = asRecord(gate.metrics)
  const registrationIcTracking = asRecord(registration.ic_tracking)
  const lifecycleResult = asRecord(registration.artifact_lifecycle_result)
  const foundationForecastValidation = asRecord(
    registration.foundation_forecast_validation
      ?? lifecycleResult.foundation_forecast_validation
      ?? offline.foundation_forecast_validation,
  )
  const gatePolicy = asRecord(gate.policy ?? offline.policy)
  const gateCpcvPolicy = asRecord(gatePolicy.cpcv ?? gate.cpcv_policy ?? offline.cpcv_policy)
  const modelCpcv = asRecord(
    registration.oof_promotion_evidence
      ?? registration.model_cpcv
      ?? registrationIcTracking.model_cpcv
      ?? gate.model_cpcv
      ?? offline.model_cpcv
      ?? foundationForecastValidation,
  )
  const icSummary = asRecord(offline.ic_summary)
  const cpcvPolicy = asRecord(modelCpcv.policy ?? gateCpcvPolicy)
  const rowFailedGates = asStringList(artifact?.offline_gate_failed_gates)
  return {
    offline,
    live,
    gate,
    metrics,
    registration,
    registrationIcTracking,
    lifecycleResult,
    foundationForecastValidation,
    modelCpcv,
    icSummary,
    gatePolicy,
    gateCpcvPolicy,
    cpcvPolicy,
    rowFailedGates,
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
      title: `${candidateId}: active-8 direct-alpha flow does not use ML shadow/challenger ownership; live parity evidence is not required for this artifact state.`,
      tone: 'info' as WorkstationTone,
    }
  }
  if (normalized.includes('shadow')) {
    return {
      value: 'OBSERVE',
      detail: 'parity only',
      title: `${candidateId}: source returned "${raw}". In the active-8 direct-alpha flow this is live/parity evidence only, not an ML shadow or challenger owner.`,
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

function baseCpcvCell(candidateId: string, evidence: ReturnType<typeof selectedArtifactEvidence>) {
  const cpcvFolds = firstFiniteNumber(evidence.modelCpcv.folds, evidence.foundationForecastValidation.folds)
  const cpcvContractReady = (
    evidence.modelCpcv.schema_version === 'model-cpcv-evidence-v1'
    && evidence.modelCpcv.method === 'outer_purged_walk_forward_rank_ic'
    && cpcvFolds != null
    && cpcvFolds >= 5
  )
  const rawDecision = firstText(
    evidence.metrics.model_cpcv_decision,
    evidence.modelCpcv.decision,
    evidence.foundationForecastValidation.decision,
  ) ?? (typeof evidence.modelCpcv.passed === 'boolean' ? (evidence.modelCpcv.passed ? 'PASS' : 'FAIL') : null)
  const cpcvDecision = cpcvContractReady ? rawDecision : null
  const failedGates = uniqueTokens([
    ...evidence.rowFailedGates,
    ...asStringList(evidence.gate.failed_gates),
    ...asStringList(evidence.modelCpcv.failed_gates),
    ...asStringList(evidence.foundationForecastValidation.failed_gates),
  ])
  const cpcvIc = firstFiniteNumber(evidence.modelCpcv.oos_ic_mean, evidence.foundationForecastValidation.oos_ic_mean)
  const cpcvDetail = cpcvDecision
    ? 'CPCV ' + (gateToken(cpcvDecision) === 'PASS' ? '通過' : '未通過') + ' · ' + Math.trunc(cpcvFolds!) + ' folds' + (cpcvIc != null ? ' · IC ' + formatMetric(cpcvIc, 3) : '')
    : 'BASE CPCV evidence 缺失或不符合 V5 contract'
  const detailParts = [
    failedGates.length ? 'fail gates: ' + failedGates.map((item) => humanizeToken(item)).join(', ') : null,
    cpcvDetail,
    'selection risk：由 V5 ensemble 的 later-window IC／spread LCB 與 conformal coverage 驗證，不在單一模型重複填 PBO。',
  ].filter(Boolean)
  const cpcvFailed = gateToken(cpcvDecision) === 'FAIL'
  const cpcvPassed = gateToken(cpcvDecision) === 'PASS'
  const tone: WorkstationTone = cpcvFailed ? 'error' : cpcvPassed ? 'ok' : 'warn'
  return {
    value: cpcvFailed ? '未通過' : cpcvPassed ? '通過' : '待補證據',
    detail: detailParts.join('\n'),
    title: [
      candidateId + ': base CPCV=' + (cpcvDecision ?? 'missing'),
      failedGates.length ? 'failed_gates=' + failedGates.join(',') : null,
      'V5 bundle selection authority=chronological held-out ensemble validation',
    ].filter(Boolean).join(' | '),
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
      title: `${candidateId}: no canonical OOF release candidate is waiting for champion comparison.`,
      tone: 'info' as WorkstationTone,
    }
  }
  const ready = Boolean(finalComparedTo)
  return {
    value: ready ? 'READY' : 'WAIT',
    detail: finalComparedTo ? `vs ${compactVersion(finalComparedTo, 14)}\n${metricDetail}` : `dry-run required\n${metricDetail}`,
    title: finalComparedTo
      ? `${candidateId}: final comparison completed against ${finalComparedTo}; ${metricDetail}`
      : `${candidateId}: final comparison against current champion is still pending; ${metricDetail}`,
    tone: ready ? 'ok' as WorkstationTone : 'warn' as WorkstationTone,
  }
}

function artifactGateFailures(artifact: RegistryArtifactRow | null | undefined): string[] {
  const offline = asRecord(artifact?.offline_evidence_json)
  const gate = asRecord(offline.gate)
  return uniqueTokens([
    ...asStringList(artifact?.offline_gate_failed_gates),
    ...asStringList(gate.failed_gates),
  ])
}

function artifactCompareSummary(record: GrafanaModelRecord) {
  const promotion = record.promotionRows[0]
  const selectedChallenger = record.selectedArtifact ?? null
  const latestRetrain = record.latestRetrainArtifact ?? null
  const candidate = firstText(
    promotion?.candidate_version,
    selectedChallenger?.version,
  )
  const champion = firstText(
    record.servingArtifact?.version,
  )
  const compare = promotion?.artifact_compare
  const candidateOosIc = firstFiniteNumber(
    compare?.candidate_oos_ic,
    artifactOosIc(selectedChallenger, record.candidate.id),
  )
  const latestRetrainOosIc = artifactOosIc(latestRetrain, record.candidate.id)
  const championOosIc = artifactOosIc(record.servingArtifact, record.candidate.id)
  const metricStatus = firstText(compare?.metric_status)
  const hasCandidate = Boolean(candidate)
  const latestRetrainVersion = firstText(latestRetrain?.version)
  const latestRetrainIsSelected = Boolean(
    hasCandidate
    && latestRetrainVersion
    && latestRetrainVersion === candidate,
  )
  const latestRetrainFailedGates = artifactGateFailures(latestRetrain)
  const selectedMetricDetail = !hasCandidate
    ? 'no selected challenger / formal compare N/R'
    : [
      metricStatus ? humanizeToken(metricStatus) : 'formal head-to-head pending',
      compareMetricDetail(candidateOosIc, championOosIc),
    ].filter(Boolean).join('\n')
  const latestMetricDetail = latestRetrainVersion
    ? [
      `${latestRetrainIsSelected ? 'selected challenger' : 'latest retrain only'} · ${latestRetrain?.state ?? 'state unavailable'}`,
      compareMetricDetail(latestRetrainOosIc, championOosIc),
      latestRetrainFailedGates.length ? `failed gates: ${latestRetrainFailedGates.map(humanizeToken).join(', ')}` : null,
      latestRetrainIsSelected ? 'formal live/final comparison still required' : 'diagnostic only; not eligible for promotion',
    ].filter(Boolean).join('\n')
    : 'latest retrain artifact unavailable'
  const finalComparedTo = champion ? firstText(promotion?.final_compared_to, selectedChallenger?.final_compared_to) : null
  const hasReleaseArtifact = Boolean(record.servingArtifact?.version)
  const hasChampionBaseline = Boolean(champion)
  const compareReady = hasCandidate && hasChampionBaseline && Boolean(finalComparedTo)
  const artifactId = firstText(promotion?.artifact_id, selectedChallenger?.artifact_id)

  return {
    artifactId,
    candidate: candidate ?? 'no selected challenger',
    champion: champion ?? 'V5 serving bundle not promoted',
    latestRetrain: latestRetrainVersion ?? 'latest retrain unavailable',
    latestRetrainState: latestRetrain?.state ?? null,
    latestRetrainFailedGates,
    latestRetrainIsSelected,
    latestRetrainOosIc,
    latestMetricDetail,
    finalComparedTo,
    hasCandidate,
    hasReleaseArtifact,
    hasChampionBaseline,
    compareReady,
    candidateOosIc,
    championOosIc,
    metricDetail: selectedMetricDetail,
    tone: compareReady ? 'ok' as WorkstationTone : hasCandidate ? 'info' as WorkstationTone : latestRetrainVersion ? 'warn' as WorkstationTone : 'neutral' as WorkstationTone,
    title: [
      `${record.candidate.id}: V5 serving bundle and selected challenger are separate identities.`,
      `selected_challenger=${candidate ?? 'none'}`,
      `latest_retrain=${latestRetrainVersion ?? 'missing'}`,
      `latest_retrain_state=${latestRetrain?.state ?? 'missing'}`,
      `v5_serving_bundle=${champion ?? 'not_promoted'}`,
      `metric_status=${metricStatus ?? 'n/a'}`,
      latestMetricDetail,
      `final_compared_to=${finalComparedTo ?? 'pending'}`,
    ].join(' | '),
  }
}
function finalCompareResultFor(
  result: ModelArtifactPromotionControllerResponse | null | undefined,
  modelId: string,
  artifactId?: string | null,
) {
  if (!result) return null
  if (artifactId && result.artifact_id === artifactId) return result
  if (result.model_name === modelId) return result
  return null
}

function promotionResultMetric(result: ModelArtifactPromotionControllerResponse, keys: string[]): number | null {
  const evidence = result.evidence ?? {}
  const metrics = evidence.metrics && typeof evidence.metrics === 'object'
    ? evidence.metrics as Record<string, unknown>
    : evidence
  for (const key of keys) {
    const value = Number((metrics as Record<string, unknown>)[key])
    if (Number.isFinite(value)) return value
  }
  return null
}

function finalCompareResultDetail(result: ModelArtifactPromotionControllerResponse): string {
  const candidateIc = promotionResultMetric(result, ['candidate_oos_ic', 'shadow_ic', 'shadowIc'])
  const championIc = promotionResultMetric(result, ['champion_oos_ic', 'production_ic', 'productionIc'])
  const delta = promotionResultMetric(result, ['oos_ic_delta', 'ic_delta', 'icDelta'])
  return [
    `decision=${result.decision ?? result.status}`,
    `candidate=${formatMetric(candidateIc, 4)}`,
    `champion=${formatMetric(championIc, 4)}`,
    `delta=${formatMetric(delta, 4)}`,
  ].join(' / ')
}

function researchStatusDiagnosis(record: GrafanaModelRecord) {
  const statusRow = record.statusRow
  const status = statusRow?.registry_status ?? 'track_only'
  const missing = uniqueTokens([
    ...(record.missingEvidence ?? []),
    ...(statusRow?.artifact_intent_missing_fields ?? []),
  ])
  const nextAction = statusRow?.next_action ?? record.nextAction
  let rootCause = 'Active-8 direct-alpha artifact registry is the source of truth for this cockpit; Strategy Lab research status is diagnostic only.'

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
    rootCause = 'This production slot is tracked inside the active-8 direct-alpha flow and does not need a separate research experiment gate.'
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
    evidence.modelCpcv.oos_ic_mean,
    evidence.foundationForecastValidation.oos_ic_mean,
    evidence.offline.oos_ic,
    model?.challenger?.artifact_evidence?.oos_ic,
  )
  const liveIc = firstFiniteNumber(model?.rolling_ic, model?.challenger?.rolling_ic)
  const baseCpcv = baseCpcvCell(candidateId, evidence)
  const finalComparedTo = firstText(
    promotionRows[0]?.final_compared_to,
    selectedCandidate?.final_compared_to,
  )
  const hasCandidate = Boolean(promotionRows[0]?.candidate_version || selectedCandidate?.version)
  const finalCompare = finalCompareCell(
    candidateId,
    finalComparedTo,
    hasCandidate,
    compareMetricDetail(
      firstFiniteNumber(promotionRows[0]?.artifact_compare?.candidate_oos_ic, artifactOosIc(selectedCandidate ?? artifact, candidateId)),
      firstFiniteNumber(promotionRows[0]?.artifact_compare?.champion_oos_ic, artifactOosIc(servingArtifact, candidateId)),
    ),
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
      label: 'FULL OOF IC',
      value: compactNumber(oosIc),
      detail: '完整單模 OOF 窗口；ensemble 另用較晚的 held-out validation 窗口',
      title: oosIc == null
        ? `${candidateId}: full-window model OOF IC unavailable`
        : `${candidateId}: full-window immutable model OOF IC ${oosIc.toFixed(4)}; do not compare directly with later-window ensemble validation IC.`,
      tone: toneFromIc(oosIc),
    },
    {
      label: 'LIVE IC',
      value: compactNumber(liveIc),
      title: liveIc == null
        ? `${candidateId}: daily rolling live IC is not available yet; this is not a shadow/challenger ownership gate.`
        : `${candidateId}: daily verify-v2/model-ic-rolling live IC ${liveIc.toFixed(4)}; this is not a shadow/challenger ownership gate.`,
      tone: toneFromIc(liveIc),
    },
    {
      label: 'BASE CPCV',
      value: baseCpcv.value,
      detail: baseCpcv.detail,
      title: baseCpcv.title,
      tone: baseCpcv.tone,
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
  const latestRetrainArtifact = selectionRow?.latest_oof_full_fit_release_artifact ?? null
  const servingArtifact = v5ServingArtifact(selectionRow, pointerRow)
  const artifactOk = artifactReady(model, selectionRow)
  const evidenceOk = evidenceReady(model, latestRetrainArtifact)
  const pointerOk = pointerReady(pointerRow)
  const queueTone = promotionPressureTone(promotionRows)
  const blockers = uniqueTokens([
    ...(!artifactOk ? ['artifact_missing'] : []),
    ...(!pointerOk ? ['active8_v5_bundle_not_promoted'] : []),
    ...promotionRows.flatMap((row) => (row.blockers ?? []).map((blocker) => (
      typeof blocker === 'string' ? blocker : blocker.code ?? blocker.label ?? 'promotion_blocker'
    ))),
  ])
  const rawStatus = latestRetrainArtifact?.state ?? 'no_data'
  const slotStatus = model?.model_slot_status ?? 'active'
  const servingStatus = pointerOk ? 'V5 bundle serving' : 'V5 evidence-only'
  const statusTone = blockers.length
    ? maxTone([toneFromStatus(rawStatus), queueTone, 'warn'])
    : maxTone([toneFromStatus(rawStatus), queueTone])
  const history = buildEvidenceCells({
    candidateId: candidate.id,
    model,
    artifact: latestRetrainArtifact,
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
    slotStatus,
    servingStatus,
    statusTone,
    fleetTone,
    artifactVersion: pointerRow?.serving_version ?? 'V5 evidence-only · no production bundle',
    selectedArtifact: artifact,
    latestRetrainArtifact,
    releaseArtifact: latestRetrainArtifact,
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
        ? 'active-8 direct-alpha artifact registry evidence loaded; wait for a new candidate before final compare.'
        : 'register or backfill the active-8 direct-alpha model artifact.'
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
          {kicker && <p className="sv-num text-[12px] normal-case text-[#90a0b8]">{kicker}</p>}
          <h3 className="truncate font-['Space_Grotesk'] text-[17px] font-semibold text-[#eef4fb]">{title}</h3>
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
      <p className="sv-num text-[12px] normal-case text-[#8fa0b7]">{label}</p>
      <div className={`mt-1 sv-num text-xl font-semibold ${grafanaTextClass(tone)}`}>{value}</div>
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
          <p className="sv-num text-[12px] normal-case text-[#f0c365]">Grafana-style model operations</p>
          <h2 className="mt-1 font-['Space_Grotesk'] text-[28px] font-semibold text-[#f4efe4]">Active-8 Model Pool</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2 sv-num text-[12px] normal-case text-[#a7b5c8]">
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
          label="V5 bundle members"
          value={`${readyPointers}/${pointerTotal || 'N/A'}`}
          detail="atomic bundle serving parity"
          tone={pointerTotal && readyPointers === pointerTotal ? 'ok' : 'warn'}
        />
        <GrafanaStat
          label="Artifacts"
          value={selectedArtifacts}
          detail="selected canonical OOF candidates"
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

function candidateHousekeepingSummary(
  selection?: ModelArtifactSelectionResponse,
  promotionQueue?: ModelArtifactPromotionQueueResponse,
) {
  const selectionArchiveIds = Object.values(selection?.models ?? {})
    .flatMap((row) => Array.isArray(row.archive_candidates) ? row.archive_candidates : [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean)
  const suppressedById = new Map<string, NonNullable<ModelArtifactSelectionResponse['suppressed']>[number]>()
  for (const row of [...(selection?.suppressed ?? []), ...(promotionQueue?.suppressed ?? [])]) {
    const key = String(row.artifact_id ?? `${row.model_name}:${row.candidate_version ?? row.candidate_type}`).trim()
    if (key) suppressedById.set(key, row)
  }
  const suppressed = [...suppressedById.values()]
  const notBetter = suppressed.filter((row) => row.artifact_compare?.metric_status === 'candidate_not_better')
  const superseded = suppressed.filter((row) => String(row.reason ?? '').toLowerCase().includes('superseded'))
  const archiveIds = [...new Set(selectionArchiveIds)]
  const selectedSlots = Object.values(selection?.models ?? {}).reduce((sum, row) => (
    sum + (row.oof_full_fit_release_candidate ? 1 : 0)
  ), 0)
  const latestRejected = Object.entries(selection?.models ?? {})
    .filter(([modelName]) => PRODUCTION_SLOT_MODELS.has(modelName))
    .map(([, row]) => row.latest_oof_full_fit_release_artifact)
    .filter((row): row is NonNullable<typeof row> => (
      row?.state === 'offline_failed' || row?.state === 'registration_failed'
    ))
  return {
    archiveIds,
    suppressed,
    notBetter,
    superseded,
    selectedSlots,
    latestRejected,
  }
}

function CandidateHousekeepingPanel({
  selection,
  promotionQueue,
}: {
  selection?: ModelArtifactSelectionResponse
  promotionQueue?: ModelArtifactPromotionQueueResponse
}) {
  const summary = candidateHousekeepingSummary(selection, promotionQueue)
  const notBetterPreview = summary.notBetter.slice(0, 6)
  const archivePreview = summary.archiveIds.slice(0, 12)
  const rejectedPreview = summary.latestRejected.slice(0, 8)
  return (
    <GrafanaPanel
      title="Candidate housekeeping"
      kicker="V5 retrain review slots; legacy comparison rows remain audit-only"
    >
      <div className="grid gap-3 bg-[#0b1118] p-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="grid gap-2 sm:grid-cols-2">
          <GrafanaStat label="Review slots" value={summary.selectedSlots} detail="canonical immutable OOF selected by policy" tone={summary.selectedSlots ? 'info' : 'neutral'} />
          <GrafanaStat label="Archive-ready" value={summary.archiveIds.length} detail="superseded or candidate-not-better only" tone={summary.archiveIds.length ? 'warn' : 'ok'} />
          <GrafanaStat label="Legacy comparisons" value={summary.notBetter.length} detail="audit-only; excluded from V5 serving" tone={summary.notBetter.length ? 'info' : 'ok'} />
          <GrafanaStat label="Superseded" value={summary.superseded.length} detail="newer release train owns review slot" tone={summary.superseded.length ? 'info' : 'ok'} />
          <GrafanaStat label="Active-8 retrain rejected" value={summary.latestRejected.length} detail="diagnosis only; never production fleet health" tone={summary.latestRejected.length ? 'warn' : 'ok'} />
        </div>
        <div className="min-w-0 rounded-xl border border-[#263247] bg-[#090f16] p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-[#f2ead8]">Archive queue</p>
            <span className="sv-num text-[11px] normal-case text-[#90a0b8]">{archivePreview.length}/{summary.archiveIds.length}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {archivePreview.length ? archivePreview.map((id) => (
              <span key={id} className="max-w-full truncate rounded-full border border-amber-300/20 bg-amber-300/[0.07] px-2.5 py-1 sv-num text-[11px] normal-case text-amber-100" title={id}>
                {compactText(id, 28)}
              </span>
            )) : (
              <span className="rounded-full border border-emerald-300/20 bg-emerald-300/[0.07] px-2.5 py-1 text-[11px] font-semibold text-emerald-200">clean</span>
            )}
          </div>
          <div className="mt-3 grid gap-1.5">
            {notBetterPreview.map((row) => {
              const compare = row.artifact_compare
              const delta = compare?.oos_ic_delta
              return (
                <div key={row.artifact_id ?? `${row.model_name}-${row.candidate_version}`} className="grid min-w-0 gap-2 rounded-lg border border-[#263247] bg-[#0e1620] px-2 py-1.5 text-xs text-[#a7b5c8] sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_80px]">
                  <span className="min-w-0 truncate font-semibold text-[#f2ead8]">{row.model_name}</span>
                  <span className="min-w-0 truncate sv-num normal-case">{row.candidate_version ?? row.artifact_id ?? row.candidate_type}</span>
                  <span className="sv-num text-amber-200">{typeof delta === 'number' ? delta.toFixed(4) : 'delta n/a'}</span>
                </div>
              )
            })}
          </div>
          {rejectedPreview.length > 0 && (
            <div className="mt-3 border-t border-[#263247] pt-3">
              <p className="mb-2 text-[12px] font-semibold text-[#f2ead8]">Active-8 retrain rejected</p>
              <div className="flex flex-wrap gap-1.5">
                {rejectedPreview.map((row) => {
                  const failedGates = asStringList(row.offline_gate_failed_gates)
                  return (
                    <span
                      key={row.artifact_id ?? `${row.model_name}-${row.version}`}
                      className="max-w-full rounded-full border border-rose-300/20 bg-rose-300/[0.07] px-2.5 py-1 sv-num text-[11px] normal-case text-rose-100"
                      title={`${row.artifact_id ?? row.version ?? row.model_name}: ${failedGates.join(', ') || 'offline gate failed'}`}
                    >
                      {row.model_name}: {failedGates.length ? failedGates.map(humanizeToken).join(', ') : 'offline gate failed'}
                    </span>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </GrafanaPanel>
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
    <GrafanaPanel title="Fleet status" kicker="compact active-8 direct-alpha state cells">
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
            <p className="mt-1 truncate sv-num text-[11px] normal-case text-[#a7b5c8]">slot {record.slotStatus} / {record.servingStatus}</p>
            <div className={`mt-2 border px-2 py-1.5 text-center sv-num text-[12px] font-semibold ${grafanaCellClass(record.fleetTone)}`}>
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
  const columns = EVIDENCE_MATRIX_COLUMNS
  return (
    <GrafanaPanel
      title="Evidence matrix"
      kicker="每欄下方先說明數據語意；格子內只保留該模型的狀態與數值"
      action={<span className="sv-num text-[12px] normal-case text-[#90a0b8]">values include gate thresholds</span>}
      className="min-h-[360px]"
    >
      <div className="overflow-x-auto">
        <div className="min-w-[1240px]">
          <div className="grid grid-cols-[152px_repeat(7,minmax(136px,1fr))] border-b border-[#2d3a49] bg-[#0b1118] px-4 py-3 text-[#90a0b8]">
            <div className="sv-num text-[12px] normal-case">model</div>
            {columns.map((column) => (
              <div key={column.label} className="px-1 text-center">
                <p className="sv-num text-[12px] normal-case text-[#b4c0d0]">{column.label}</p>
                <p className="mt-1 text-[11px] leading-4 text-[#7f8ca3]">{column.description}</p>
              </div>
            ))}
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
                className={`grid w-full grid-cols-[152px_repeat(7,minmax(136px,1fr))] items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-[#151d28] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#f0c365]/35 ${isSelected ? 'bg-[#151d28]' : ''}`}
              >
                <div className="min-w-0">
                  <p className="truncate font-['Space_Grotesk'] text-[14px] font-semibold text-[#f2ead8]">{record.candidate.id}</p>
                  <p className="truncate text-[12px] text-[#90a0b8]">{record.family}</p>
                </div>
                {record.history.map((cell) => (
                  <div
                    key={`${record.candidate.id}-${cell.label}`}
                    className={`min-h-[86px] border px-2 py-2 text-center sv-num text-[12px] font-semibold leading-5 ${grafanaCellClass(cell.tone)}`}
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
    <GrafanaPanel title="Evidence table" kicker="V5 serving bundle, selected challenger, and latest retrain evidence stay separate; legacy pointers are audit-only">
      <div className="overflow-x-auto bg-[#0b1118] p-3">
        <table className="w-full min-w-[1380px] border-separate border-spacing-y-2 text-left">
          <thead className="sv-num text-[12px] normal-case text-[#90a0b8]">
            <tr>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Family</th>
              <th className="px-3 py-2 font-medium">V5 production bundle artifact</th>
              <th className="px-3 py-2 font-medium">Dataset</th>
              <th className="px-3 py-2 font-medium">Pointer</th>
              <th className="px-3 py-2 font-medium" title="Latest research registry state for this model artifact lane.">Research state</th>
              <th className="px-3 py-2 font-medium" title="Promotion queue load plus blockers that need review before release.">Review pressure</th>
              <th className="min-w-[300px] whitespace-normal px-3 py-2 font-medium leading-5">V5 serving bundle vs latest retrain</th>
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
              const researchState = record.latestRetrainArtifact?.state ?? (record.selectedArtifact?.state ?? 'no new retrain')
              const researchTone = toneFromStatus(researchState)
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
                <td className="max-w-[210px] truncate border-y border-[#263247] px-3 py-3 sv-num text-[13px] text-[#dce3ea]" title={record.artifactVersion}>{record.artifactVersion}</td>
                <td className="border-y border-[#263247] px-3 py-3">
                  <p className="sv-num text-[13px] text-sky-300">{record.dataset?.window ?? 'model-specific'}</p>
                  <p className="text-[12px] text-[#90a0b8]">{record.dataset?.shape ?? 'N/A'}</p>
                </td>
                <td className="border-y border-[#263247] px-3 py-3">
                  <span className={`border px-2.5 py-1 sv-num text-[12px] ${grafanaCellClass(record.pointerTone)}`}>
                    {record.pointerRow?.readiness ?? 'missing'}
                  </span>
                </td>
                <td className="border-y border-[#263247] px-3 py-3">
                  <span className={`border px-2.5 py-1 sv-num text-[12px] ${grafanaCellClass(researchTone)}`}>
                    {researchState}
                  </span>
                  <p className="mt-1 max-w-[280px] text-[12px] leading-5 text-[#a7b5c8]">{diagnosis.rootCause}</p>
                  <p className="mt-1 max-w-[280px] sv-num text-[12px] leading-5 text-sky-200">next: {diagnosis.nextAction}</p>
                </td>
                <td className="border-y border-[#263247] px-3 py-3">
                  <span className={`border px-2.5 py-1 sv-num text-[12px] ${grafanaCellClass(pressureTone)}`}>
                    {pressureLabel}
                  </span>
                </td>
                <td className="min-w-[300px] max-w-[390px] border-y border-[#263247] px-3 py-3" title={compare.title}>
                  <span className={`inline-block border px-2.5 py-1 sv-num text-[12px] ${grafanaCellClass(compare.tone)}`}>
                    {compare.compareReady ? 'formal compare ready' : compare.hasCandidate ? 'selected challenger' : compare.latestRetrainState ? 'latest retrain rejected' : 'serving only'}
                  </span>
                  <dl className="mt-2 grid max-w-[360px] gap-1.5 sv-num text-[12px] leading-5">
                    <div className="grid grid-cols-[96px_1fr] gap-2"><dt className="text-[#70809b]">V5 bundle</dt><dd className="break-all text-[#dce3ea]">{compare.champion}</dd></div>
                    <div className="grid grid-cols-[96px_1fr] gap-2"><dt className="text-[#70809b]">challenger</dt><dd className="break-all text-[#dce3ea]">{compare.candidate}</dd></div>
                    <div className="grid grid-cols-[96px_1fr] gap-2"><dt className="text-[#70809b]">latest retrain</dt><dd className="break-all text-[#dce3ea]">{compare.latestRetrain}</dd></div>
                  </dl>
                  <p className="mt-2 max-w-[340px] whitespace-pre-line sv-num text-[12px] leading-5 text-[#dce3ea]">{compare.latestMetricDetail}</p>
                </td>
                <td className="rounded-r-xl border-y border-r border-[#263247] px-3 py-3">
                  <div className="flex max-w-[320px] flex-wrap gap-1">
                    {(missing.length ? missing : ['complete']).slice(0, 4).map((item) => (
                      <span key={item} className="rounded-full border border-[#303947] bg-[#151a22] px-2 py-0.5 sv-num text-[12px] text-[#c0cad8]">
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
    <GrafanaPanel title="Meta boundary" kicker="evidence only outside active-8 direct-alpha vote">
      <div className="grid gap-2 bg-[#0b1118] p-3 md:grid-cols-2 xl:grid-cols-4">
        {ADAPTIVE_EVIDENCE_STEPS.map((step) => (
          <div key={step.label} className="rounded-xl border border-[#263247] bg-[#0c1219] p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="font-['Space_Grotesk'] text-[14px] font-semibold text-[#f2ead8]">{step.label}</p>
              <span className={`border px-2.5 py-1 sv-num text-[12px] ${grafanaCellClass(step.tone)}`}>{statusLabel(step.tone)}</span>
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
  promotionResult,
  finalComparePending = false,
  onDryRunFinalCompare,
}: ModelPoolNewFlowWorkbenchProps) {
  const liveModels = useMemo(
    () => models.filter(([name]) => ACTIVE_ALPHA_MODELS.has(name) && !RETIRED_MODELS.has(name)),
    [models],
  )
  const byName = useMemo(() => new Map(liveModels), [liveModels])
  const serving = useMemo(() => liveModels.filter(([, model]) => isServing(model)), [liveModels])
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
  const selectedArtifacts = Object.values(selection?.models ?? {}).filter((row) => Boolean(selectionCandidate(row))).length
  const promotionCount = promotionQueue?.count ?? promotionQueue?.queue?.length ?? 0
  const grafanaRecords = useMemo(() => activeSlots.map((candidate) => {
    const selectionRow = selection?.models?.[candidate.id]
    const promotionRow = selectedPromotionRow(candidate.id, selectionRow, promotionQueue?.queue ?? [])
    return buildGrafanaRecord({
      candidate,
      model: byName.get(candidate.id),
      selectionRow,
      pointerRow: pointers?.models?.[candidate.id],
      statusRow: latestStatusFor(candidate.id, statusRows),
      promotionRows: promotionRow ? [promotionRow] : [],
      modelUpgradeStatusReady,
    })
  }), [activeSlots, byName, selection, pointers, statusRows, promotionQueue, modelUpgradeStatusReady])
  const defaultSelectedModelId = useMemo(() => (
    grafanaRecords.find((record) => record.blockers.length > 0)?.candidate.id
      ?? grafanaRecords[0]?.candidate.id
      ?? null
  ), [grafanaRecords])
  const [selectedModelIdIntent, setSelectedModelIdIntent] = useState<string | null>(() => new URLSearchParams(window.location.search).get('model'))
  const selectedModelId = grafanaRecords.some((record) => record.candidate.id === selectedModelIdIntent)
    ? selectedModelIdIntent
    : defaultSelectedModelId

  function selectModel(id: string) {
    setSelectedModelIdIntent(id)
    const url = new URL(window.location.href)
    url.searchParams.set('model', id)
    window.history.replaceState({}, '', url)
  }

  return (
    <WorkstationPanel
      title="Model Ops Dashboard"
      kicker="Grafana-style fleet monitoring for TimesFM L2 sidecar -> L3 active-8 family registry"
      className="sv-readable-card-content sv-model-pool-readable"
    >
      <GrafanaDashboardHeader
        records={grafanaRecords}
        readyPointers={readyPointers}
        pointerTotal={pointerTotal}
        selectedArtifacts={selectedArtifacts}
        promotionCount={promotionCount}
      />

      <div className="grid gap-4 bg-[#0b1118] p-4">
        <CandidateHousekeepingPanel selection={selection} promotionQueue={promotionQueue} />

        <FleetStatusStrip
          records={grafanaRecords}
          selectedModelId={selectedModelId}
          onSelectModel={selectModel}
        />

        <StateTimelinePanel
          records={grafanaRecords}
          selectedModelId={selectedModelId}
          onSelectModel={selectModel}
        />

        <EvidenceTablePanel
          records={grafanaRecords}
          selectedModelId={selectedModelId}
          onSelectModel={selectModel}
        />
        <MetaBoundaryPanel />
      </div>

      <div className="border-t border-[#263247] bg-[#071018] p-4 text-[15px] leading-6 text-[#a7b5c8]">
        Parameter search and allocator/meta proposals stay in Promotion & Parameter Governance.
        This cockpit is only the L2 TimesFM sidecar and L3 active-8 evidence surface: active slots, artifacts, verified rows,
        blockers, and V5 bundle pointer readiness.
      </div>
    </WorkstationPanel>
  )
}
