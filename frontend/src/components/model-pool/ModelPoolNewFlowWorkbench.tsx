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
  if (status === 'syncing_evidence') return 'neutral'
  if (status === 'active' || status === 'ready_for_review' || status === 'approved_for_patch' || status === 'pointer_ready') return 'ok'
  if (status === 'degraded' || status === 'evaluation_pending' || status === 'needs_attention') return 'warn'
  if (status === 'failed' || status === 'retired' || status === 'rejected') return 'error'
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
  if (value >= -0.02) return 'warn'
  return 'error'
}

function artifactReady(model?: ModelPoolLineageModel, selectionRow?: SelectionModelRow): boolean {
  const artifact = selectionCandidate(selectionRow)
  return Boolean(artifact?.version || model?.version || model?.gcs_path || model?.artifact_uri)
}

function evidenceReady(statusRow?: ModelUpgradeResearchStatusRow, model?: ModelPoolLineageModel, statusFeedReady = true): boolean {
  if (!statusFeedReady) return false
  return (
    statusRow?.registry_status === 'ready_for_review' ||
    statusRow?.registry_status === 'approved_for_patch' ||
    model?.status === 'active'
  )
}

function pointerReady(pointerRow?: ModelChampionPointersResponse['models'][string]): boolean {
  return pointerTone(pointerRow?.readiness) === 'ok'
}

function finalCompareReady(rows: PromotionQueueRow[], pointerRow?: ModelChampionPointersResponse['models'][string]): boolean {
  return rows.some((row) => Boolean(row.final_compared_to)) || pointerReady(pointerRow)
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
  const modelCpcv = asRecord(registration.model_cpcv)
  const validationPacket = asRecord(offline.validation_packet)
  const pbo = asRecord(offline.pbo ?? validationPacket.pbo)
  const icSummary = asRecord(offline.ic_summary)
  const gatePolicy = asRecord(gate.policy)
  const cpcvPolicy = asRecord(modelCpcv.policy)
  const pboPolicy = asRecord(pbo.policy ?? gatePolicy)
  return { offline, live, gate, metrics, registration, modelCpcv, pbo, icSummary, gatePolicy, cpcvPolicy, pboPolicy }
}

function liveGateCell(candidateId: string, liveStatus: string | null | undefined) {
  const raw = String(liveStatus ?? '').trim()
  if (!raw) {
    return {
      value: 'N/A',
      detail: 'no live rows',
      title: `${candidateId}: live gate evidence unavailable`,
      tone: 'neutral' as WorkstationTone,
    }
  }
  if (raw.toLowerCase().includes('shadow')) {
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
  const pboMax = firstFiniteNumber(evidence.pboPolicy.max_pbo, evidence.gatePolicy.max_pbo) ?? 0.5
  const oosMeanReturn = firstFiniteNumber(evidence.pbo.oos_mean_return, evidence.metrics.pbo_oos_mean_return)
  const minOosMeanReturn = firstFiniteNumber(evidence.pboPolicy.min_oos_mean_return, evidence.gatePolicy.min_oos_mean_return) ?? 0
  const cpcvIc = firstFiniteNumber(evidence.modelCpcv.oos_ic_mean, evidence.modelCpcv.rank_ic, evidence.metrics.model_cpcv_oos_ic)
  const cpcvMinIc = firstFiniteNumber(evidence.cpcvPolicy.min_oos_ic_mean) ?? 0
  const cpcvFolds = firstFiniteNumber(evidence.modelCpcv.folds)
  const cpcvMinFolds = firstFiniteNumber(evidence.cpcvPolicy.min_folds) ?? 5
  const coverage = firstFiniteNumber(evidence.modelCpcv.coverage_mean)
  const minCoverage = firstFiniteNumber(evidence.cpcvPolicy.min_coverage) ?? 0.6
  const decision = firstText(
    evidence.metrics.model_cpcv_decision,
    evidence.modelCpcv.decision,
    evidence.pbo.go_live_verdict,
    evidence.pbo.decision,
    evidence.pbo.status,
  )
  const detailParts = [
    pboValue == null ? `PBO<${formatMetric(pboMax, 2)}` : `PBO ${formatMetric(pboValue, 2)}<${formatMetric(pboMax, 2)}`,
    cpcvIc == null ? `IC>=${formatMetric(cpcvMinIc, 3)}` : `IC ${formatMetric(cpcvIc, 3)}>=${formatMetric(cpcvMinIc, 3)}`,
  ]
  const titleParts = [
    `${candidateId}: PBO/CPCV ${decision ?? 'unavailable'}`,
    `PBO=${formatMetric(pboValue, 3)} < ${formatMetric(pboMax, 2)}`,
    `PBO OOS return=${formatMetric(oosMeanReturn, 4)} >= ${formatMetric(minOosMeanReturn, 4)}`,
    `CPCV IC=${formatMetric(cpcvIc, 4)} >= ${formatMetric(cpcvMinIc, 4)}`,
    `folds=${formatMetric(cpcvFolds, 0)} >= ${formatMetric(cpcvMinFolds, 0)}`,
    `coverage=${formatMetric(coverage, 3)} >= ${formatMetric(minCoverage, 2)}`,
  ]
  return {
    value: gateToken(decision),
    detail: detailParts.join(' · '),
    title: titleParts.join(' | '),
    tone: toneFromGate(decision),
  }
}

function finalCompareCell(candidateId: string, finalComparedTo: string | null, pointerOk: boolean) {
  const ready = Boolean(finalComparedTo) || pointerOk
  return {
    value: ready ? 'READY' : 'WAIT',
    detail: finalComparedTo ? `vs ${compactVersion(finalComparedTo, 14)}` : pointerOk ? 'pointer synced' : 'needs compare',
    title: finalComparedTo
      ? `${candidateId}: final comparison completed against ${finalComparedTo}`
      : pointerOk
        ? `${candidateId}: champion pointer is ready; final compare can use serving pointer baseline`
        : `${candidateId}: final comparison against current champion is still pending`,
    tone: ready ? 'ok' as WorkstationTone : 'warn' as WorkstationTone,
  }
}

function uniqueTokens(items: Array<string | null | undefined>): string[] {
  return [...new Set(items.map((item) => String(item ?? '').trim()).filter(Boolean))]
}

function buildEvidenceCells({
  candidateId,
  model,
  artifact,
  promotionRows,
  pointerOk,
}: {
  candidateId: string
  model?: ModelPoolLineageModel
  artifact?: SelectedArtifactRow | null
  promotionRows: PromotionQueueRow[]
  pointerOk: boolean
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
    model?.rolling_ic,
  )
  const pboCpcv = pboCpcvCell(candidateId, evidence)
  const liveStatus = firstText(
    promotionRows[0]?.live_gate_status,
    artifact?.live_gate_status,
    evidence.live.status,
  )
  const liveGate = liveGateCell(candidateId, liveStatus)
  const finalComparedTo = firstText(
    promotionRows[0]?.final_compared_to,
    artifact?.final_compared_to,
    pointerOk ? 'serving pointer' : null,
  )
  const finalCompare = finalCompareCell(candidateId, finalComparedTo, pointerOk)

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
      label: 'LIVE',
      value: liveGate.value,
      detail: liveGate.detail,
      title: liveGate.title,
      tone: liveGate.tone,
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
  const artifactOk = artifactReady(model, selectionRow)
  const evidenceOk = evidenceReady(statusRow, model, modelUpgradeStatusReady)
  const pointerOk = pointerReady(pointerRow)
  const queueTone = promotionPressureTone(promotionRows)
  const blockers = uniqueTokens([
    ...(!artifactOk ? ['artifact_missing'] : []),
    ...(!modelUpgradeStatusReady ? ['evidence_status_syncing'] : []),
    ...(modelUpgradeStatusReady && !evidenceOk ? ['evidence_not_ready'] : []),
    ...(!pointerOk ? ['champion_pointer_not_ready'] : []),
    ...promotionRows.flatMap((row) => (row.blockers ?? []).map((blocker) => (
      typeof blocker === 'string' ? blocker : blocker.code ?? blocker.label ?? 'promotion_blocker'
    ))),
  ])
  const rawStatus = modelUpgradeStatusReady
    ? statusRow?.registry_status ?? model?.status ?? 'no_data'
    : 'syncing_evidence'
  const statusTone = modelUpgradeStatusReady && blockers.length
    ? maxTone([toneFromStatus(rawStatus), queueTone, 'warn'])
    : toneFromStatus(rawStatus)

  return {
    candidate,
    model,
    family: modelFamily(candidate.id, model),
    status: rawStatus,
    statusTone,
    artifactVersion: artifact?.version ?? model?.version ?? 'no artifact',
    selectedArtifact: artifact,
    dataset: MODEL_DATASET_REQUIREMENTS[candidate.id],
    pointerRow,
    pointerTone: pointerTone(pointerRow?.readiness),
    promotionRows,
    statusRow,
    artifactOk,
    evidenceOk,
    finalCompareOk: finalCompareReady(promotionRows, pointerRow),
    approvalOk: approvalClear(promotionRows),
    pointerOk,
    blockers,
    missingEvidence: uniqueTokens(statusRow?.missing_evidence ?? []),
    nextAction: modelUpgradeStatusReady
      ? promotionRows[0]?.next_action ?? pointerRow?.next_action ?? statusRow?.next_action ?? 'no action queued'
      : 'Waiting for model-upgrade evidence status feed before rendering gate pass/fail.',
    history: buildEvidenceCells({
      candidateId: candidate.id,
      model,
      artifact,
      promotionRows,
      pointerOk,
    }),
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
          {kicker && <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-[#90a0b8]">{kicker}</p>}
          <h3 className="truncate font-['Space_Grotesk'] text-[15px] font-semibold tracking-[0.02em] text-[#eef4fb]">{title}</h3>
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
      <p className="font-mono text-[11px] uppercase tracking-[0.10em] text-[#8fa0b7]">{label}</p>
      <div className={`mt-1 font-mono text-xl font-semibold ${grafanaTextClass(tone)}`}>{value}</div>
      <p className="mt-1 text-xs leading-5 text-[#9aa8ba]">{detail}</p>
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
  const okCount = records.filter((record) => record.statusTone === 'ok').length
  const blockedCount = records.filter((record) => record.blockers.length > 0 || record.statusTone === 'error').length
  const warnCount = records.filter((record) => record.statusTone === 'warn').length
  const fleetTone = blockedCount ? 'error' : warnCount ? 'warn' : okCount === records.length ? 'ok' : 'info'
  const now = new Date()

  return (
    <div className="border-b border-[#2d3a49] bg-[#0b1118]">
      <div className="flex flex-col gap-3 border-b border-[#2d3a49] px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.13em] text-[#f0c365]">Grafana-style model operations</p>
          <h2 className="mt-1 font-['Space_Grotesk'] text-2xl font-semibold tracking-[0.01em] text-[#f4efe4]">Active-9 Model Pool</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-[0.10em] text-[#a7b5c8]">
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
              <p className="truncate font-['Space_Grotesk'] text-[13px] font-semibold text-[#f2ead8]">{record.candidate.id}</p>
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${record.statusTone === 'ok' ? 'bg-emerald-400' : record.statusTone === 'warn' ? 'bg-amber-300' : record.statusTone === 'error' ? 'bg-rose-400' : 'bg-slate-500'}`} />
            </div>
            <p className="mt-1 truncate text-[11px] text-[#90a0b8]">{record.family} / {record.dataset?.window ?? 'model-specific'}</p>
            <div className={`mt-2 border px-2 py-1.5 text-center font-mono text-[11px] font-semibold ${grafanaCellClass(record.statusTone)}`}>
              {statusLabel(record.statusTone)}
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
  const labels = records[0]?.history.map((cell) => cell.label) ?? ['W-3', 'W-2', 'W-1', 'OOS IC', 'LIVE', 'PBO/CPCV', 'COMPARE']
  return (
    <GrafanaPanel
      title="Evidence matrix"
      kicker="weekly trend, OOS evidence, live parity, overfit guard, champion compare"
      action={<span className="font-mono text-[11px] uppercase tracking-[0.10em] text-[#90a0b8]">values include gate thresholds</span>}
      className="min-h-[360px]"
    >
      <div className="overflow-x-auto">
        <div className="min-w-[1060px]">
          <div className="grid grid-cols-[152px_repeat(7,minmax(112px,1fr))] border-b border-[#2d3a49] bg-[#0b1118] px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.10em] text-[#90a0b8]">
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
                  <p className="truncate font-['Space_Grotesk'] text-[13px] font-semibold text-[#f2ead8]">{record.candidate.id}</p>
                  <p className="truncate text-[11px] text-[#90a0b8]">{record.family}</p>
                </div>
                {record.history.map((cell) => (
                  <div
                    key={`${record.candidate.id}-${cell.label}`}
                    className={`min-h-[52px] border px-2 py-1.5 text-center font-mono text-[11px] font-semibold leading-4 ${grafanaCellClass(cell.tone)}`}
                    title={cell.title}
                    aria-label={cell.title}
                  >
                    <span className="block">{cell.value}</span>
                    {cell.detail && <span className="mt-0.5 block truncate text-[10px] font-medium opacity-80">{cell.detail}</span>}
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

  const gates = [
    { label: 'Artifact', ready: selected.artifactOk, detail: selected.artifactVersion },
    { label: 'Evidence', ready: selected.evidenceOk, detail: selected.status },
    { label: 'PBO/CPCV', ready: selected.history.find((cell) => cell.label === 'PBO/CPCV')?.tone === 'ok', detail: selected.history.find((cell) => cell.label === 'PBO/CPCV')?.detail ?? 'PBO<0.50 / IC>=0' },
    { label: 'Champion compare', ready: selected.finalCompareOk, detail: selected.promotionRows[0]?.final_compared_to ?? (selected.pointerOk ? 'serving pointer baseline' : 'pending') },
    { label: 'Approval', ready: selected.approvalOk, detail: selected.promotionRows.some((row) => row.approval_required) ? 'required' : 'clear' },
    { label: 'Pointer', ready: selected.pointerOk, detail: selected.pointerRow?.readiness ?? 'missing' },
  ]

  return (
    <GrafanaPanel title="Promotion readiness" kicker={`selected model: ${selected.candidate.id}`}>
      <div className="bg-[#0c1219] p-4">
        <div className={`rounded-xl border p-3 ${grafanaBorderClass(selected.statusTone)} bg-[#111821]`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-['Space_Grotesk'] text-[16px] font-semibold text-[#f2ead8]">{selected.candidate.id}</p>
              <p className="mt-1 text-xs leading-5 text-[#9aa8ba]">{selected.family} / {selected.dataset?.window ?? 'model-specific'} / {selected.artifactVersion}</p>
            </div>
            <span className={`border px-2.5 py-1 font-mono text-[11px] font-semibold ${grafanaCellClass(selected.statusTone)}`}>
              {selected.status}
            </span>
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-[#263247] bg-[#0b1118] p-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-[#90a0b8]">Promotion readiness funnel</p>
          <div className="mt-3 space-y-2">
            {gates.map((gate, index) => (
              <div key={gate.label} className="grid grid-cols-[28px_1fr_auto] items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-lg border border-[#303947] bg-[#121a24] font-mono text-[11px] text-[#a7b5c8]">{index + 1}</span>
                <div className="min-w-0">
                  <p className="font-['Space_Grotesk'] text-[13px] text-[#f2ead8]">{gate.label}</p>
                  <p className="text-[11px] leading-4 text-[#90a0b8]">{gate.detail}</p>
                </div>
                <span className={`border px-2.5 py-1 font-mono text-[11px] ${grafanaCellClass(gate.ready ? 'ok' : 'warn')}`}>
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
    <GrafanaPanel title="Evidence table" kicker="registry, dataset, pointer, promotion pressure, PBO/CPCV, and missing evidence">
      <div className="overflow-x-auto bg-[#0b1118] p-3">
        <table className="w-full min-w-[1240px] border-separate border-spacing-y-2 text-left">
          <thead className="font-mono text-[11px] uppercase tracking-[0.10em] text-[#90a0b8]">
            <tr>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Family</th>
              <th className="px-3 py-2 font-medium">Artifact</th>
              <th className="px-3 py-2 font-medium">Dataset</th>
              <th className="px-3 py-2 font-medium">Pointer</th>
              <th className="px-3 py-2 font-medium">Research state</th>
              <th className="px-3 py-2 font-medium">Pressure</th>
              <th className="px-3 py-2 font-medium">PBO/CPCV</th>
              <th className="px-3 py-2 font-medium">Missing evidence</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => {
              const isSelected = selectedModelId === record.candidate.id
              const pressureTone = record.blockers.length ? maxTone([promotionPressureTone(record.promotionRows), 'warn']) : promotionPressureTone(record.promotionRows)
              const pressureLabel = record.promotionRows.length ? `${record.promotionRows.length} queued` : record.blockers.length ? 'blocked' : 'clear'
              const missing = uniqueTokens([...record.missingEvidence, ...record.blockers])
              const pboCpcv = record.history.find((cell) => cell.label === 'PBO/CPCV')
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
                <td className="rounded-l-xl border-y border-l border-[#263247] px-3 py-3 font-['Space_Grotesk'] text-[14px] font-semibold text-[#f2ead8]">{record.candidate.id}</td>
                <td className="border-y border-[#263247] px-3 py-3 text-xs text-[#a7b5c8]">{record.family}</td>
                <td className="max-w-[210px] truncate border-y border-[#263247] px-3 py-3 font-mono text-xs text-[#dce3ea]" title={record.artifactVersion}>{record.artifactVersion}</td>
                <td className="border-y border-[#263247] px-3 py-3">
                  <p className="font-mono text-xs text-sky-300">{record.dataset?.window ?? 'model-specific'}</p>
                  <p className="text-[11px] text-[#90a0b8]">{record.dataset?.shape ?? 'N/A'}</p>
                </td>
                <td className="border-y border-[#263247] px-3 py-3">
                  <span className={`border px-2.5 py-1 font-mono text-[11px] ${grafanaCellClass(record.pointerTone)}`}>
                    {record.pointerRow?.readiness ?? 'missing'}
                  </span>
                </td>
                <td className="border-y border-[#263247] px-3 py-3">
                  <span className={`border px-2.5 py-1 font-mono text-[11px] ${grafanaCellClass(record.statusTone)}`}>
                    {record.status}
                  </span>
                </td>
                <td className="border-y border-[#263247] px-3 py-3">
                  <span className={`border px-2.5 py-1 font-mono text-[11px] ${grafanaCellClass(pressureTone)}`}>
                    {pressureLabel}
                  </span>
                </td>
                <td className="border-y border-[#263247] px-3 py-3" title={pboCpcv?.title}>
                  <span className={`inline-block border px-2.5 py-1 font-mono text-[11px] ${grafanaCellClass(pboCpcv?.tone ?? 'neutral')}`}>
                    {pboCpcv?.value ?? 'N/A'}
                  </span>
                  <p className="mt-1 max-w-[220px] text-[11px] leading-4 text-[#90a0b8]">{pboCpcv?.detail ?? 'PBO<0.50 / IC>=0'}</p>
                </td>
                <td className="rounded-r-xl border-y border-r border-[#263247] px-3 py-3">
                  <div className="flex max-w-[320px] flex-wrap gap-1">
                    {(missing.length ? missing : ['complete']).slice(0, 4).map((item) => (
                      <span key={item} className="rounded-full border border-[#303947] bg-[#151a22] px-2 py-0.5 font-mono text-[10px] text-[#c0cad8]">
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
              <p className="font-['Space_Grotesk'] text-[13px] font-semibold text-[#f2ead8]">{step.label}</p>
              <span className={`border px-2.5 py-1 font-mono text-[11px] ${grafanaCellClass(step.tone)}`}>{statusLabel(step.tone)}</span>
            </div>
            <p className="mt-2 text-xs leading-5 text-[#9aa8ba]">{step.detail}</p>
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

      <div className="border-t border-[#263247] bg-[#071018] p-4 text-sm leading-6 text-[#a7b5c8]">
        Parameter search and allocator/meta proposals stay in Promotion & Parameter Governance.
        This cockpit is only the L2/L3 model evidence surface: active slots, artifacts, verified rows,
        blockers, and champion pointer readiness.
      </div>
    </WorkstationPanel>
  )
}
