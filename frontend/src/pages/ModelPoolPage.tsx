import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Loader2, RefreshCw } from 'lucide-react'
import AppShell from '@/components/AppShell'
import { Button } from '@/components/ui/button'
import { DecisionTraceRail, SignalInsightCard } from '@/components/workstation/DecisionArchitecture'
import { WorkstationPageTitle, WorkstationPanel, WorkstationPill, type WorkstationTone } from '@/components/workstation/WorkstationChrome'
import { modelPoolApi, recommendationsApi, strategyLabApi, type ModelArtifactActionContext, type ModelArtifactPromotionControllerResponse, type ModelArtifactPromotionQueueResponse, type ModelArtifactRegistryRow, type ModelArtifactSelectionResponse, type ModelChampionPointersResponse, type ModelPoolLineageModel, type ResearchExperiment } from '@/lib/api'
import { MODEL_UPGRADE_CANDIDATES, MODEL_UPGRADE_STAGE_LABELS, type ModelUpgradeStage } from '@/lib/modelUpgradeTrack'
import { queryTtl, recommendationDailyKey, twToday } from '@/lib/queryPolicy'

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'N/A'
  if (typeof value === 'number') return value.toFixed(4)
  return String(value)
}

function toneFromStatus(status?: string): WorkstationTone {
  if (status === 'active' || status === 'ok') return 'ok'
  if (status === 'degraded' || status === 'warn' || status === 'coverage_low') return 'warn'
  if (status === 'retired' || status === 'failed' || status === 'error' || status === 'artifact_mismatch') return 'error'
  return 'neutral'
}

function isStateSpaceOverlay(name: string, model: ModelPoolLineageModel) {
  return (
    name === 'KalmanFilter' ||
    name === 'MarkovSwitching' ||
    model.model_type === 'state_space_overlay' ||
    model.balance_family === 'state_space'
  )
}

function icValue(model: ModelPoolLineageModel): number | null {
  const raw = model.ic_4w_avg ?? model.rolling_ic
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function familyCounts(models: Array<[string, ModelPoolLineageModel]>) {
  return models.reduce<Record<string, number>>((acc, [, model]) => {
    const family = model.balance_family ?? model.model_type ?? 'unknown'
    if (model.status === 'active') acc[family] = (acc[family] ?? 0) + 1
    return acc
  }, {})
}

function shortRootCause(model: ModelPoolLineageModel): string {
  return model.lifecycle_diagnosis?.status ?? model.last_ic_root_cause ?? model.last_ic_status ?? 'unknown'
}

function segmentIcEntries(model: ModelPoolLineageModel) {
  return Object.entries(model.last_ic_by_segment ?? {})
    .map(([segment, detail]) => {
      const ic = Number(detail?.ic ?? detail?.rolling_ic ?? detail?.ic_4w_avg)
      const samples = Number(detail?.n_samples ?? detail?.samples ?? 0)
      return {
        segment,
        ic: Number.isFinite(ic) ? ic : null,
        samples: Number.isFinite(samples) ? samples : 0,
      }
    })
    .filter((row) => row.ic != null || row.samples > 0)
}

function compactMetric(value: number | null, digits = 0): string {
  if (value == null) return 'N/A'
  return digits > 0 ? value.toFixed(digits) : Math.round(value).toLocaleString()
}

function compactUnknown(value: unknown, digits = 4): string {
  if (value === null || value === undefined || value === '') return 'N/A'
  const n = Number(value)
  if (Number.isFinite(n)) return digits > 0 ? n.toFixed(digits) : Math.round(n).toLocaleString()
  return String(value)
}

function formatCalibrationMethod(method: string): string {
  if (method === 'empirical_rank_bins_monotonic') return '單調分箱校準'
  if (method === 'rank_to_return_curve') return '排名轉報酬曲線'
  if (method === 'bounded_pseudo_return') return '保守預期報酬校準'
  if (method === 'unknown') return '未知校準'
  return method.replace(/_/g, ' ')
}

function experimentEvidence(candidateId: string, experiments: ResearchExperiment[]) {
  const matched = candidateExperiments(candidateId, experiments)
  const latest = matched[0]
  const dataSlice = latest?.data_slice ?? {}
  const metricText = latest?.metrics?.length ? latest.metrics.join(', ') : 'missing'
  const approval = latest?.approval_gate ?? {}
  const hasEvaluationPlan = Boolean(latest?.evaluation_plan)
  const isEvidenceReady = Boolean(
    latest &&
    (latest.status === 'ready_for_review' || latest.status === 'completed' || latest.status === 'reviewed') &&
    latest.metrics?.some((metric) => /oos|ic|pbo|cpcv|cost|slice/i.test(metric)),
  )
  return {
    matched,
    latest,
    dataSlice,
    metricText,
    hasEvaluationPlan,
    isEvidenceReady,
    approval,
  }
}

function parseArtifactEvidence(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return typeof raw === 'object' ? raw as Record<string, unknown> : {}
}

function deepMetric(source: unknown, keys: string[]): unknown {
  if (!source || typeof source !== 'object') return undefined
  const obj = source as Record<string, unknown>
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key]
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = deepMetric(value, keys)
      if (found !== undefined && found !== null && found !== '') return found
    }
  }
  return undefined
}

function evidenceMetric(row: ModelArtifactRegistryRow, keys: string[], digits = 4): string {
  const offline = parseArtifactEvidence(row.offline_evidence_json)
  const live = parseArtifactEvidence(row.live_evidence_json)
  const value = deepMetric(live, keys) ?? deepMetric(offline, keys)
  return compactUnknown(value, digits)
}

function promotionMetric(result: ModelArtifactPromotionControllerResponse, keys: string[], digits = 4): string {
  const value = deepMetric(result.evidence, keys)
  return compactUnknown(value, digits)
}

function promotionMetricNumber(result: ModelArtifactPromotionControllerResponse, keys: string[]): number | null {
  const value = deepMetric(result.evidence, keys)
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function promotionComparisonSummary(result: ModelArtifactPromotionControllerResponse) {
  const shadowIc = promotionMetricNumber(result, ['shadow_ic', 'shadowIc'])
  const productionIc = promotionMetricNumber(result, ['production_ic', 'productionIc'])
  const icDelta = promotionMetricNumber(result, ['ic_delta', 'icDelta'])
  const hasLiveComparison = shadowIc != null && productionIc != null
  const beatsChampion = hasLiveComparison && shadowIc > productionIc
  const blockers = Array.isArray(result.evidence?.blockers) ? result.evidence.blockers.map(String) : []
  const approvalRequired = result.approval_required === true || result.decision === 'approval_required'
  const resultLabel = beatsChampion
    ? approvalRequired ? '比現行 champion 好，但需要 Wei 審核' : '比現行 champion 好，可晉級'
    : hasLiveComparison ? '未優於現行 champion' : '流程可走，但缺 live comparison 數值'
  return { shadowIc, productionIc, icDelta, hasLiveComparison, beatsChampion, blockers, approvalRequired, resultLabel }
}

function flattenSelectedArtifacts(selection?: ModelArtifactSelectionResponse) {
  return Object.entries(selection?.models ?? {}).flatMap(([modelName, row]) => {
    const items: Array<{
      modelName: string
      slot: 'monthly_release_candidate' | 'weekly_drift_candidate'
      artifact: ModelArtifactRegistryRow
      actionContext?: ModelArtifactActionContext
    }> = []
    if (row.monthly_release_candidate) {
      items.push({
        modelName,
        slot: 'monthly_release_candidate',
        artifact: row.monthly_release_candidate,
        actionContext: row.action_context?.monthly_release_candidate,
      })
    }
    if (row.weekly_drift_candidate) {
      items.push({
        modelName,
        slot: 'weekly_drift_candidate',
        artifact: row.weekly_drift_candidate,
        actionContext: row.action_context?.weekly_drift_candidate,
      })
    }
    return items
  })
}

function stageTone(stage: ModelUpgradeStage): WorkstationTone {
  if (stage === 'shadow_challenger') return 'info'
  if (stage === 'benchmark_only') return 'warn'
  if (stage === 'production_slot_member') return 'ok'
  return 'neutral'
}

function TinyBar({ label, value, tone = 'info' }: { label: string; value: number; tone?: WorkstationTone }) {
  const safe = Math.max(0, Math.min(100, value))
  const color = tone === 'ok' ? 'bg-emerald-300' : tone === 'warn' ? 'bg-amber-300' : tone === 'error' ? 'bg-rose-300' : 'bg-sky-300'
  return (
    <div>
      <div className="mb-1 flex justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#8a92a6]">
        <span>{label}</span>
        <span>{safe}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[#172033]">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${safe}%` }} />
      </div>
    </div>
  )
}

function ModelHealthRow({ name, model }: { name: string; model: ModelPoolLineageModel }) {
  const ic = icValue(model)
  const sampleCount = model.last_ic_sample_count ?? 0
  const challenger = model.challenger
  const metadataTone = model.metadata_exists === false ? 'warn' : 'ok'
  const diagnosis = model.lifecycle_diagnosis
  const icTone: WorkstationTone = ic == null || Math.abs(ic) < 0.0001 ? 'warn' : ic > 0 ? 'ok' : 'error'
  const segmentRows = segmentIcEntries(model)

  return (
    <tr className="hover:bg-[#101927]">
      <td className="border border-[#263247] px-2 py-2 text-slate-100">
        <div className="font-semibold">{name}</div>
        <div className="mt-0.5 text-[10px] text-[#70809b]">{model.model_type ?? 'unknown'} / {model.balance_family ?? 'unknown'}</div>
      </td>
      <td className="border border-[#263247] px-2 py-2"><WorkstationPill tone={toneFromStatus(model.status)}>{model.status ?? '-'}</WorkstationPill></td>
      <td className="border border-[#263247] px-2 py-2">
        <WorkstationPill tone={icTone}>{ic == null ? 'N/A' : ic.toFixed(4)}</WorkstationPill>
        {segmentRows.length > 0 && (
          <div className="mt-1 flex max-w-[240px] flex-wrap gap-1">
            {segmentRows.map((row) => (
              <span key={row.segment} className="rounded border border-[#263247] bg-[#05070c] px-1.5 py-0.5 font-mono text-[10px] text-[#8a92a6]">
                {row.segment} {row.ic == null ? 'N/A' : row.ic.toFixed(3)} / n={row.samples}
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="border border-[#263247] px-2 py-2 text-slate-300">{sampleCount}</td>
      <td className="border border-[#263247] px-2 py-2"><WorkstationPill tone={metadataTone}>{model.metadata_exists === false ? 'missing' : 'present'}</WorkstationPill></td>
      <td className="border border-[#263247] px-2 py-2 text-slate-300">{diagnosis?.coverage == null ? 'N/A' : `${Math.round(diagnosis.coverage * 100)}%`}</td>
      <td className="border border-[#263247] px-2 py-2 text-slate-300">
        {challenger ? (
          <div className="space-y-1">
            <div className="font-mono text-[10px] text-[#70809b]">{challenger.version ?? 'challenger'}</div>
            <WorkstationPill tone={Number(challenger.ic_4w_avg ?? challenger.rolling_ic ?? 0) > 0 ? 'ok' : 'warn'}>
              lifecycle IC {fmt(challenger.ic_4w_avg ?? challenger.rolling_ic)}
            </WorkstationPill>
            <div className="text-[10px] leading-4 text-[#8a92a6]">
              samples {challenger.last_ic_sample_count ?? 0}; not artifact OOS IC
            </div>
          </div>
        ) : '-'}
      </td>
      <td className="border border-[#263247] px-2 py-2 text-[#8a92a6]">
        <div>{shortRootCause(model)}</div>
        {diagnosis?.reason && <div className="mt-1 max-w-[280px] whitespace-normal text-[10px] leading-4">{diagnosis.reason}</div>}
      </td>
    </tr>
  )
}

function candidateExperiments(candidateId: string, experiments: ResearchExperiment[]) {
  const needle = candidateId.toLowerCase()
  return experiments
    .filter((experiment) => {
      const haystack = [
        experiment.id,
        experiment.hypothesis,
        ...(experiment.source_refs ?? []),
        ...(experiment.metrics ?? []),
        ...(experiment.follow_up ?? []),
      ].join(' ').toLowerCase()
      return haystack.includes(needle)
    })
    .slice(0, 3)
}

function modelUpgradeNextAction(stage: ModelUpgradeStage, hasEvidence: boolean) {
  if (hasEvidence) return '下一步：由 Strategy Lab 檢查 evidence matrix，通過後才可進 promotion / challenger gate。'
  if (stage === 'shadow_challenger') {
    return '下一步不是 Scheduler job：到 Strategy Lab 建立或選擇 experiment，執行 model_benchmark dry-run / shadow evaluation，產出 OOS IC、CPCV/PBO、cost profile；若要固定自動跑，需另建 research-evaluation scheduler。'
  }
  return '下一步不是 Scheduler job：到 Strategy Lab 建立 model benchmark experiment，呼叫 /research/model-benchmark/dry-run 產出 benchmark report；通過後才可升級成 shadow challenger。'
}

function UpgradeTrackPanel({ experiments = [] }: { experiments?: ResearchExperiment[] }) {
  const byStage = MODEL_UPGRADE_CANDIDATES.reduce<Record<string, typeof MODEL_UPGRADE_CANDIDATES>>((acc, candidate) => {
    acc[candidate.stage] = [...(acc[candidate.stage] ?? []), candidate]
    return acc
  }, {})
  const stageOrder: ModelUpgradeStage[] = ['shadow_challenger', 'benchmark_only']

  return (
    <WorkstationPanel title="Model-family Challenger / 新模型家族挑戰者" kicker="Shadow Challengers / 影子挑戰者 · Research Benchmarks / 研究基準">
      <div className="grid gap-px bg-[#263247] lg:grid-cols-2">
        {stageOrder.map((stage) => (
          <div key={stage} className="bg-[#070a10] p-3">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-100">{MODEL_UPGRADE_STAGE_LABELS[stage]}</p>
                <p className="mt-1 text-xs leading-5 text-[#8a92a6]">
                  {stage === 'shadow_challenger'
                    ? '這裡只放 ResidualMLP / GNN 這種新模型家族。它們應該先產生 shadow evidence，但 promotion 前不投 production vote。'
                    : '只做研究 benchmark，不跑 production inference，避免成本暴增。'}
                </p>
              </div>
              <WorkstationPill tone={stageTone(stage)}>{byStage[stage]?.length ?? 0}</WorkstationPill>
            </div>
            <div className="grid gap-2">
              {(byStage[stage] ?? []).map((candidate) => {
                const evidence = experimentEvidence(candidate.id, experiments)
                return (
                <div key={candidate.id} className="border border-[#263247] bg-[#05070c] p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-mono text-[12px] font-semibold text-[#fff1cf]">{candidate.id}</p>
                      <p className="mt-0.5 text-[10px] text-[#70809b]">{candidate.titleZh} / {candidate.family}</p>
                    </div>
                    <WorkstationPill tone={evidence.isEvidenceReady ? 'ok' : evidence.latest ? 'warn' : 'error'}>
                      {evidence.isEvidenceReady ? 'evidence ready' : evidence.latest ? 'registry incomplete' : 'registry missing'}
                    </WorkstationPill>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-[#8a92a6]">{candidate.roleZh}</p>
                  <p className="mt-1 text-[11px] leading-5 text-slate-500">{candidate.roleEn}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {candidate.requiredEvidence.map((item) => (
                      <WorkstationPill key={item} tone="neutral">{item}</WorkstationPill>
                    ))}
                  </div>
                  {evidence.latest ? (
                    <div className="mt-2 border border-emerald-400/20 bg-emerald-400/[0.04] p-2 text-[11px] leading-5 text-emerald-100">
                      <p>registry: {evidence.latest.id} · status {evidence.latest.status}</p>
                      <p>metrics: {evidence.metricText}</p>
                      <p>slice: {Object.entries(evidence.dataSlice).slice(0, 4).map(([key, value]) => `${key}=${compactUnknown(value, 0)}`).join(' / ') || 'missing'}</p>
                      <p>evaluation plan: {evidence.hasEvaluationPlan ? 'ready' : 'missing'} · approval gate: {Object.keys(evidence.approval).length ? 'defined' : 'missing'}</p>
                    </div>
                  ) : (
                    <div className="mt-2 border border-rose-400/25 bg-rose-400/[0.04] p-2 text-[11px] leading-5 text-rose-100">
                      尚未訓練或尚未產出 registry evidence：目前沒有 OOS IC、CPCV/PBO、成本敏感度、資料切片報告，所以不能假裝它已經比 production 模型更好。
                    </div>
                  )}
                  <p className="mt-2 rounded-lg border border-sky-400/20 bg-sky-400/[0.04] p-2 text-[11px] leading-5 text-sky-100">
                    {modelUpgradeNextAction(candidate.stage, evidence.isEvidenceReady)}
                  </p>
                  {candidate.stage === 'benchmark_only' && (
                    <p className="mt-2 text-[11px] leading-5 text-amber-200">
                      benchmark report required：必須先進 experiment registry，產出 OOS IC、CPCV/PBO、成本敏感度與資料切片報告，通過後才可升級成 shadow challenger。
                    </p>
                  )}
                </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </WorkstationPanel>
  )
}

function versionChallengerStatusLabel(status: string) {
  if (status === 'awaiting_live_shadow') return 'awaiting verify-v2 + IC tracker'
  if (status === 'computed') return 'live evidence computed'
  if (status === 'insufficient_samples') return 'need more verified samples'
  if (status === 'ok') return 'ok'
  return status
}

function ArtifactMetricDelta({ label, before, after, afterNote }: { label: string; before: string; after: string; afterNote?: string }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2 border-b border-[#263247]/70 py-2 text-xs last:border-0">
      <span className="text-[#70809b]">{label}</span>
      <span className="flex min-w-0 items-center gap-2 font-mono text-slate-100">
        <span className="truncate">{before}</span>
        <ArrowRight className="h-3 w-3 shrink-0 text-slate-500" />
        <span className="truncate text-amber-100">{after}</span>
        {afterNote && <span className="shrink-0 text-[10px] text-[#70809b]">{afterNote}</span>}
      </span>
    </div>
  )
}

function LiveShadowEvidencePanel({ selection }: { selection?: ModelArtifactSelectionResponse }) {
  const rows = flattenSelectedArtifacts(selection)

  return (
    <WorkstationPanel title="Live Gate Evidence / 版本實戰驗證" kicker="selected candidate only: shadow predict -> verify-v2 -> IC tracker">
      <div className="p-3">
        <p className="mb-3 text-xs leading-5 text-[#8a92a6]">
          這裡只看新版 registry 選出的 monthly / weekly candidate。狀態若是 not_started，代表還沒被 daily shadow predict 與 verify-v2 / model-ic-tracker 累積 actual_return live outcome；不是舊 model_pool challenger 單槽位。
        </p>
        {rows.length ? (
          <div className="grid gap-2 md:grid-cols-2">
            {rows.map(({ modelName, slot, artifact, actionContext }) => {
              const live = parseArtifactEvidence(artifact.live_evidence_json)
              const decision = (live.decision && typeof live.decision === 'object') ? live.decision as Record<string, unknown> : {}
              const metrics = (decision.metrics && typeof decision.metrics === 'object') ? decision.metrics as Record<string, unknown> : {}
              const liveStatus = artifact.live_gate_status ?? 'not_started'
              const samples = compactUnknown(metrics.shadow_samples ?? metrics.shadowSamples ?? 0, 0)
              const rootCause = String(actionContext?.root_cause ?? decision.root_cause ?? decision.reason ?? (liveStatus === 'not_started' ? 'daily shadow evidence not started' : liveStatus))
              const nextAction = actionContext?.next_action ?? (liveStatus === 'not_started'
                ? 'run daily ML predict shadow, then verify-v2 and model-ic-tracker'
                : decision.reason ? String(decision.reason) : 'continue collecting live gate evidence')
              return (
                <div key={`${modelName}-${slot}-${artifact.artifact_id}`} className="border border-[#263247] bg-[#05070c] p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-mono text-[12px] font-semibold text-[#fff1cf]">{modelName}</p>
                      <p className="mt-0.5 text-[10px] text-[#70809b]">{artifact.version} · {slot.replace(/_/g, ' ')}</p>
                    </div>
                    <WorkstationPill tone={liveStatus === 'passed' ? 'ok' : liveStatus === 'failed' ? 'error' : 'warn'}>
                      {versionChallengerStatusLabel(liveStatus)}
                    </WorkstationPill>
                  </div>
                  <div className="mt-3 grid grid-cols-4 gap-2 font-mono text-[11px]">
                    <div><p className="text-[#70809b]">Shadow IC</p><p className="text-slate-100">{compactUnknown(metrics.shadow_ic, 4)}</p></div>
                    <div><p className="text-[#70809b]">Prod IC</p><p className="text-slate-100">{compactUnknown(metrics.production_ic, 4)}</p></div>
                    <div><p className="text-[#70809b]">Samples</p><p className="text-slate-100">{samples}</p></div>
                    <div><p className="text-[#70809b]">Min</p><p className="text-slate-100">{compactUnknown(metrics.min_samples, 0)}</p></div>
                  </div>
                  <p className="mt-2 text-[11px] leading-4 text-amber-200">root: {rootCause}</p>
                  <p className="mt-1 text-[11px] leading-4 text-[#8a92a6]">next: {nextAction}</p>
                  {actionContext?.affected_downstream?.length ? (
                    <p className="mt-1 text-[11px] leading-4 text-sky-200">
                      affects: {actionContext.affected_downstream.join(', ')}
                    </p>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="border border-amber-400/25 bg-amber-400/[0.05] p-3 text-sm text-amber-200">
            目前 registry 沒有選出的 monthly / weekly candidate；請先確認 retrain followup 是否寫入 model_artifact_registry。
          </div>
        )}
      </div>
    </WorkstationPanel>
  )
}

function ArtifactDiffPanel({ selection, pointers }: { selection?: ModelArtifactSelectionResponse; pointers?: ModelChampionPointersResponse }) {
  const rows = flattenSelectedArtifacts(selection)

  return (
    <WorkstationPanel title="Artifact Diff / Champion -> Candidate 差異" kicker="one algorithm per card, champion pointer -> candidate">
      <div className="p-3">
        <p className="mb-3 text-xs leading-5 text-[#8a92a6]">
          每張卡是一個演算法：左側是目前 champion pointer，右側是 registry candidate。若 champion_artifact_id 尚未連結，代表只能做版本級比較，artifact metadata diff 會被標為受限，而不是顯示假 NaN。
        </p>
        {rows.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {rows.map(({ modelName, slot, artifact }) => {
              const pointer = pointers?.models?.[modelName]
              const championVersion = pointer?.d1_pointer_version ?? pointer?.serving_version ?? 'champion version not linked'
              const championArtifact = pointer?.d1_pointer_artifact_id ?? null
              const linkStatus = pointer?.artifact_link_status ?? 'not_linked'
              return (
                <div key={`${modelName}-${slot}-${artifact.artifact_id}`} className="border border-[#263247] bg-[#05070c] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-[12px] font-semibold text-[#fff1cf]">{modelName}</p>
                      <p className="mt-1 text-[11px] text-[#8a92a6]">
                        {championVersion} → {artifact.version} · {artifact.candidate_type}
                      </p>
                    </div>
                    <WorkstationPill tone={linkStatus === 'linked' ? 'ok' : 'warn'}>
                      {linkStatus === 'linked' ? 'artifact linked' : 'version-only baseline'}
                    </WorkstationPill>
                  </div>

                  <div className="mt-3 rounded-lg border border-[#263247] bg-[#070a10] p-3">
                    <ArtifactMetricDelta label="artifact id" before={championArtifact ?? 'not linked'} after={artifact.artifact_id} />
                    <ArtifactMetricDelta label="baseline" before={artifact.evaluation_baseline_version ?? championVersion} after={artifact.final_compared_to ?? 'final comparison pending'} />
                    <ArtifactMetricDelta label="feature policy" before="champion policy" after={artifact.feature_policy_version ?? 'policy not recorded'} />
                    <ArtifactMetricDelta label="offline gate" before="candidate evidence" after={artifact.offline_gate_decision ?? artifact.offline_gate_status ?? artifact.state} />
                    <ArtifactMetricDelta label="offline OOS IC" before="candidate holdout" after={evidenceMetric(artifact, ['oos_ic', 'oosIc'], 4)} afterNote="not live IC" />
                    <ArtifactMetricDelta label="live IC" before={`champion ${evidenceMetric(artifact, ['production_ic', 'productionIc'], 4)}`} after={`shadow ${evidenceMetric(artifact, ['shadow_ic', 'shadowIc'], 4)}`} afterNote={`delta ${evidenceMetric(artifact, ['ic_delta', 'icDelta'], 4)}`} />
                    <ArtifactMetricDelta label="live samples" before={`champion ${evidenceMetric(artifact, ['production_samples', 'productionSamples'], 0)}`} after={`shadow ${evidenceMetric(artifact, ['shadow_samples', 'shadowSamples'], 0)}`} afterNote={`min ${evidenceMetric(artifact, ['min_samples', 'minSamples'], 0)}`} />
                    <ArtifactMetricDelta label="CPCV / PBO" before="candidate offline gate" after={`${evidenceMetric(artifact, ['model_cpcv_decision', 'cpcv_decision'], 3)} / ${evidenceMetric(artifact, ['pbo'], 3)}`} />
                    <ArtifactMetricDelta label="DSR / MC" before="candidate offline gate" after={`${evidenceMetric(artifact, ['deflated_sharpe', 'dsr'], 3)} / ${evidenceMetric(artifact, ['monte_carlo', 'mc', 'plateau'], 3)}`} />
                    <ArtifactMetricDelta label="live gate" before="production serving" after={artifact.live_gate_status ?? 'not_started'} />
                  </div>

                  {linkStatus !== 'linked' && (
                    <p className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/[0.05] p-2 text-[11px] leading-5 text-amber-200">
                      champion pointer 已對齊版本，但沒有 champion_artifact_id；需要下一次 monthly release 或 artifact backfill 才能做完整 artifact-to-artifact diff。
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="border border-amber-400/25 bg-amber-400/[0.05] p-3 text-sm text-amber-200">
            目前沒有 registry candidate，所以沒有 champion → candidate artifact diff 可比較。
          </div>
        )}
      </div>
    </WorkstationPanel>
  )
}

function FamilyBalancePanel({ counts, total }: { counts: Record<string, number>; total: number }) {
  const entries = Object.entries(counts)
  return (
    <WorkstationPanel title="Family Balance / 模型家族平衡" kicker="do not let one family dominate">
      <div className="grid gap-3 p-3 md:grid-cols-[1fr_280px]">
        <div className="grid gap-3">
          {entries.map(([family, count]) => (
            <TinyBar key={family} label={`${family} (${count})`} value={total ? Math.round((count / total) * 100) : 0} tone="info" />
          ))}
          {!entries.length && <p className="text-sm text-slate-500">沒有 family balance payload。</p>}
        </div>
        <div className="border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">How to read / 怎麼看</p>
          <p className="mt-2 text-xs leading-5 text-[#8a92a6]">
            Alpha models 是會投票的 8 個 production slots；Kalman/Markov 是 state-space overlay，不算 alpha vote；MLP/GNN 是 shadow challenger；TabM、iTransformer、TimesFM 是 benchmark research。
          </p>
        </div>
      </div>
    </WorkstationPanel>
  )
}

function registryTone(state?: string): WorkstationTone {
  if (state === 'offline_strong_pass' || state === 'offline_passed' || state === 'live_gate_passed' || state === 'production') return 'ok'
  if (state === 'offline_failed' || state === 'registration_failed' || state === 'rejected') return 'error'
  if (state === 'offline_passed_weak' || state === 'approval_required') return 'warn'
  return 'neutral'
}

function ActionContextNote({ context }: { context?: ModelArtifactActionContext }) {
  if (!context) return null
  return (
    <div className="mt-2 rounded-lg border border-[#263247] bg-[#070a10] p-2 text-[11px] leading-5 text-[#8a92a6]">
      <div className="font-mono text-amber-200">root: {context.root_cause}</div>
      <div>impact: {context.impact}</div>
      <div>next: {context.next_action}</div>
      {context.scheduler_dependency?.length ? (
        <div className="mt-1 text-sky-200">needs: {context.scheduler_dependency.join(' -> ')}</div>
      ) : null}
    </div>
  )
}

function PromotionControllerResultPanel({ result }: { result: ModelArtifactPromotionControllerResponse }) {
  const summary = promotionComparisonSummary(result)
  const reason = String(deepMetric(result.evidence, ['reason']) ?? result.next_action ?? result.note ?? '-')
  const candidate = String(result.candidate_version ?? deepMetric(result.evidence, ['candidate_version']) ?? 'candidate N/A')
  const champion = String(result.final_compared_to ?? deepMetric(result.evidence, ['current_champion_version']) ?? 'champion N/A')
  const tone: WorkstationTone = summary.beatsChampion ? 'ok' : summary.hasLiveComparison ? 'error' : 'warn'

  return (
    <div className="rounded-xl border border-sky-400/25 bg-sky-400/[0.05] p-3 text-sm text-sky-100 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">Promotion dry-run：{summary.resultLabel}</p>
          <p className="mt-1 text-xs leading-5 text-sky-200">
            {champion} <ArrowRight className="mx-1 inline h-3 w-3" /> {candidate}
          </p>
        </div>
        <WorkstationPill tone={tone}>{result.status} / {result.decision ?? '-'}</WorkstationPill>
      </div>
      <div className="mt-3 grid gap-2 text-[11px] md:grid-cols-4">
        <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
          <p className="font-mono text-[#70809b]">Shadow IC</p>
          <p className="mt-1 text-slate-100">{promotionMetric(result, ['shadow_ic', 'shadowIc'], 4)}</p>
        </div>
        <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
          <p className="font-mono text-[#70809b]">Champion IC</p>
          <p className="mt-1 text-slate-100">{promotionMetric(result, ['production_ic', 'productionIc'], 4)}</p>
        </div>
        <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
          <p className="font-mono text-[#70809b]">IC Delta</p>
          <p className={`mt-1 ${summary.icDelta != null && summary.icDelta > 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
            {promotionMetric(result, ['ic_delta', 'icDelta'], 4)}
          </p>
        </div>
        <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
          <p className="font-mono text-[#70809b]">Samples</p>
          <p className="mt-1 text-slate-100">
            {promotionMetric(result, ['shadow_samples', 'shadowSamples'], 0)} / min {promotionMetric(result, ['min_samples', 'minSamples'], 0)}
          </p>
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-[#263247] bg-[#05070c] p-2 text-xs leading-5">
        <p><span className="text-[#70809b]">原因：</span>{reason}</p>
        <p><span className="text-[#70809b]">下一步：</span>{result.next_action ?? '-'}</p>
        {summary.blockers.length > 0 && (
          <p className="text-amber-200"><span className="text-[#70809b]">Blockers：</span>{summary.blockers.join(', ')}</p>
        )}
      </div>
    </div>
  )
}

function ArtifactMiniCard({ title, artifact, actionContext }: { title: string; artifact?: ModelArtifactRegistryRow | null; actionContext?: ModelArtifactActionContext }) {
  if (!artifact) {
    return (
      <div className="rounded-lg border border-[#263247] bg-[#05070c] p-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#70809b]">{title}</p>
        <p className="mt-2 text-sm text-slate-500">No selected artifact</p>
        <ActionContextNote context={actionContext} />
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-[#263247] bg-[#05070c] p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#70809b]">{title}</p>
          <p className="mt-1 font-mono text-[12px] text-[#fff1cf]">{artifact.version}</p>
        </div>
        <WorkstationPill tone={registryTone(artifact.state)}>{artifact.state}</WorkstationPill>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-[#8a92a6]">
        <span>offline</span><span className="text-right text-slate-200">{artifact.offline_gate_decision ?? 'PENDING'}</span>
        <span>live</span><span className="text-right text-slate-200">{artifact.live_gate_status ?? 'not_started'}</span>
        <span>approval</span><span className="text-right text-slate-200">{artifact.approval_state ?? 'not_required'}</span>
      </div>
      <p className="mt-2 truncate font-mono text-[10px] text-[#70809b]" title={artifact.artifact_path ?? undefined}>{artifact.artifact_path ?? '-'}</p>
      <ActionContextNote context={actionContext} />
    </div>
  )
}

function ArtifactRegistryPanel({ selection }: { selection?: ModelArtifactSelectionResponse }) {
  const models = Object.entries(selection?.models ?? {})
  const monthlyCount = models.filter(([, row]) => row.monthly_release_candidate).length
  const weeklyCount = models.filter(([, row]) => row.weekly_drift_candidate).length
  const archivedCount = models.reduce((sum, [, row]) => sum + (row.archive_candidates?.length ?? 0), 0)

  return (
    <WorkstationPanel title="Model Registry / 模型版本中心" kicker="artifact lifecycle: registered -> gate -> selected -> shadow -> promote">
      <div className="grid gap-3 p-3 md:grid-cols-3">
        <SignalInsightCard title="Monthly release" value={String(monthlyCount)} detail="主版本列車；通過 offline gate 才進候選。" tone={monthlyCount ? 'ok' : 'warn'} />
        <SignalInsightCard title="Weekly drift" value={String(weeklyCount)} detail="只有 offline strong pass 才能占用 live shadow slot。" tone={weeklyCount ? 'info' : 'neutral'} />
        <SignalInsightCard title="Archived evidence" value={String(archivedCount)} detail="保留證據但不進 live gate，避免 weekly 疊爆。" tone="neutral" />
      </div>
      <div className="grid gap-3 border-t border-[#263247] p-3 lg:grid-cols-2">
        {models.length ? models.map(([modelName, row]) => (
          <div key={modelName} className="rounded-xl border border-[#263247] bg-[#070a10] p-3">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-[12px] font-semibold text-slate-100">{modelName}</p>
                <p className="mt-1 text-[11px] text-[#70809b]">release-train selection · not production promotion</p>
              </div>
              <WorkstationPill tone={row.weekly_drift_candidate ? 'info' : row.monthly_release_candidate ? 'ok' : 'neutral'}>
                {row.weekly_drift_candidate ? 'weekly shadow eligible' : row.monthly_release_candidate ? 'monthly release eligible' : 'no candidate'}
              </WorkstationPill>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <ArtifactMiniCard
                title="Next Monthly Release Candidate"
                artifact={row.monthly_release_candidate}
                actionContext={row.action_context?.monthly_release_candidate}
              />
              <ArtifactMiniCard
                title="Weekly drift candidate"
                artifact={row.weekly_drift_candidate}
                actionContext={row.action_context?.weekly_drift_candidate}
              />
            </div>
            {row.archive_candidates?.length > 0 && (
              <p className="mt-2 text-[11px] text-[#8a92a6]">
                archived: {row.archive_candidates.slice(0, 3).join(', ')}{row.archive_candidates.length > 3 ? ` +${row.archive_candidates.length - 3}` : ''}
              </p>
            )}
          </div>
        )) : (
          <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] p-3 text-sm text-amber-200 lg:col-span-2">
            尚未讀到 model_artifact_registry。下一次 retrain followup 成功後會開始出現 registered / offline gate evidence。
          </div>
        )}
      </div>
    </WorkstationPanel>
  )
}

function PromotionQueuePanel({
  queue,
  onPromote,
  isPromoting,
  promotionResult,
}: {
  queue?: ModelArtifactPromotionQueueResponse
  onPromote: (artifactId: string, approved: boolean, confirm: boolean) => void
  isPromoting: boolean
  promotionResult?: ModelArtifactPromotionControllerResponse | null
}) {
  const rows = queue?.queue ?? []
  const approvalCount = rows.filter((row) => row.approval_required).length
  const autoCount = rows.filter((row) => row.promotion_decision === 'auto_promote_candidate').length
  const blockedCount = rows.filter((row) => row.promotion_decision === 'blocked_missing_champion_pointer').length

  return (
    <WorkstationPanel title="Promotion Queue / 晉級決策佇列" kicker="final comparison, approval, champion pointer">
      <div className="grid gap-3 p-3 md:grid-cols-3">
        <SignalInsightCard title="Auto candidates" value={String(autoCount)} detail="monthly release 且通過 live gate，仍需 final comparison" tone={autoCount ? 'ok' : 'neutral'} />
        <SignalInsightCard title="Approval required" value={String(approvalCount)} detail="weekly hotfix / manual hotfix 需要 Wei approval" tone={approvalCount ? 'warn' : 'neutral'} />
        <SignalInsightCard title="Blocked" value={String(blockedCount)} detail="缺 champion pointer 或 final comparison 前置條件" tone={blockedCount ? 'error' : 'ok'} />
      </div>
      <div className="grid gap-3 border-t border-[#263247] p-3 lg:grid-cols-2">
        {rows.length ? rows.map((row) => (
          <div key={row.artifact_id ?? `${row.model_name}-${row.candidate_version}`} className="rounded-xl border border-[#263247] bg-[#070a10] p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-[12px] font-semibold text-slate-100">{row.model_name}</p>
                <p className="mt-1 font-mono text-[11px] text-[#70809b]">
                  {row.current_champion_version ?? 'champion N/A'} → {row.candidate_version ?? 'candidate N/A'}
                </p>
              </div>
              <WorkstationPill tone={row.promotion_decision === 'auto_promote_candidate' ? 'ok' : row.approval_required ? 'warn' : row.promotion_decision.includes('blocked') ? 'error' : 'info'}>
                {row.promotion_decision}
              </WorkstationPill>
            </div>
            <div className="mt-3 grid gap-2 text-[11px] text-[#9aa6bd] md:grid-cols-2">
              <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
                <p className="font-mono text-[#70809b]">offline / live</p>
                <p className="mt-1 text-slate-200">{row.offline_gate_decision ?? '-'} / {row.live_gate_status ?? '-'}</p>
              </div>
              <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
                <p className="font-mono text-[#70809b]">final compared to</p>
                <p className="mt-1 text-slate-200">{row.final_compared_to ?? 'pending champion pointer'}</p>
              </div>
            </div>
            <p className="mt-3 text-[12px] leading-5 text-slate-300">{row.next_action}</p>
            <ActionContextNote context={row.action_context} />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!row.artifact_id || isPromoting || row.promotion_decision.includes('blocked')}
                className="rounded-full border-emerald-400/30 text-emerald-200 hover:bg-emerald-400/10"
                onClick={() => row.artifact_id && onPromote(row.artifact_id, false, false)}
              >
                Final compare dry-run
              </Button>
              {row.approval_required && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!row.artifact_id || isPromoting}
                  className="rounded-full border-amber-400/30 text-amber-200 hover:bg-amber-400/10"
                  onClick={() => row.artifact_id && onPromote(row.artifact_id, true, true)}
                >
                  Wei approve + promote pointer
                </Button>
              )}
              {!row.approval_required && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!row.artifact_id || isPromoting}
                  className="rounded-full border-sky-400/30 text-sky-200 hover:bg-sky-400/10"
                  onClick={() => row.artifact_id && onPromote(row.artifact_id, false, true)}
                >
                  Auto promote pointer
                </Button>
              )}
            </div>
          </div>
        )) : (
          <div className="rounded-xl border border-[#263247] bg-[#070a10] p-3 text-sm text-[#8a92a6] lg:col-span-2">
            目前沒有 artifact 通過 live gate；promotion-controller 沒有待處理項目。
          </div>
        )}
        {promotionResult && (
          <PromotionControllerResultPanel result={promotionResult} />
        )}
      </div>
    </WorkstationPanel>
  )
}

function ChampionPointerPanel({ pointers }: { pointers?: ModelChampionPointersResponse }) {
  const models = Object.entries(pointers?.models ?? {})
  const missingCount = models.filter(([, row]) => row.readiness === 'missing_d1_pointer').length
  const mismatchCount = models.filter(([, row]) => row.readiness === 'pointer_mismatch').length
  const linkedCount = models.filter(([, row]) => row.readiness === 'pointer_ready').length

  return (
    <WorkstationPanel title="Production Champion Pointer / 現行正式版本指標" kicker="serving ownership only: champion, rollback, pointer readiness">
      <div className="grid gap-3 p-3 md:grid-cols-5">
        <SignalInsightCard title="Artifact linked" value={String(linkedCount)} detail="requires champion_artifact_id, not only version" tone={linkedCount === (pointers?.model_count ?? 0) ? 'ok' : 'warn'} />
        <SignalInsightCard title="Production reader" value={pointers?.production_reader ?? 'N/A'} detail="目前 serving 實際讀取來源" tone={pointers?.production_reader === 'model_pool.json' ? 'warn' : 'ok'} />
        <SignalInsightCard title="Pointer ready" value={`${pointers?.ready_count ?? 0}/${pointers?.model_count ?? 0}`} detail="D1 champion pointer 對齊數" tone={pointers?.migration_ready ? 'ok' : 'warn'} />
        <SignalInsightCard title="Missing" value={String(missingCount)} detail="尚未 backfill D1 pointer" tone={missingCount ? 'warn' : 'ok'} />
        <SignalInsightCard title="Mismatch" value={String(mismatchCount)} detail="D1 pointer 與 serving version 不一致" tone={mismatchCount ? 'error' : 'ok'} />
      </div>
      <div className="grid gap-3 border-t border-[#263247] p-3 lg:grid-cols-2">
        {models.length ? models.map(([modelName, row]) => (
          <div key={modelName} className="rounded-xl border border-[#263247] bg-[#070a10] p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-[12px] font-semibold text-slate-100">{modelName}</p>
                <p className="mt-1 font-mono text-[11px] text-[#70809b]">
                  serving {row.serving_version ?? 'N/A'} → D1 pointer {row.d1_pointer_version ?? 'N/A'}
                </p>
              </div>
              <WorkstationPill tone={row.readiness === 'pointer_ready' ? 'ok' : row.readiness === 'pointer_mismatch' ? 'error' : 'warn'}>
                {row.readiness}
              </WorkstationPill>
            </div>
            <p className="mt-2 font-mono text-[10px] text-[#70809b]">
              artifact link: {row.artifact_link_status ?? 'unknown'} · {row.d1_pointer_artifact_id ?? 'champion_artifact_id missing'}
            </p>
            <p className="mt-3 text-[12px] leading-5 text-slate-300">{row.next_action}</p>
          </div>
        )) : (
          <div className="rounded-xl border border-[#263247] bg-[#070a10] p-3 text-sm text-[#8a92a6] lg:col-span-2">
            尚未取得 champion pointer projection；請先確認 ml-controller / Worker proxy 已部署。
          </div>
        )}
      </div>
    </WorkstationPanel>
  )
}

function ArtifactLifecycleSummaryPanel({
  selection,
  pointers,
  queue,
}: {
  selection?: ModelArtifactSelectionResponse
  pointers?: ModelChampionPointersResponse
  queue?: ModelArtifactPromotionQueueResponse
}) {
  const models = Object.values(selection?.models ?? {})
  const selectedArtifacts = models.flatMap((row) => [
    row.monthly_release_candidate,
    row.weekly_drift_candidate,
  ]).filter(Boolean) as ModelArtifactRegistryRow[]
  const contexts = models.flatMap((row) => [
    row.action_context?.monthly_release_candidate,
    row.action_context?.weekly_drift_candidate,
  ]).filter(Boolean) as ModelArtifactActionContext[]
  const liveCollecting = contexts.filter((ctx) => ctx.evidence_status === 'collecting' || ctx.evidence_status === 'offline_only').length
  const blockers = contexts.filter((ctx) => ['failed', 'missing', 'partial'].includes(String(ctx.evidence_status))).length
  const pointerReady = `${pointers?.ready_count ?? 0}/${pointers?.model_count ?? 0}`
  const promotionCount = queue?.count ?? 0

  return (
    <WorkstationPanel title="Artifact Lifecycle Summary / 版本生命週期總覽" kicker="registry -> gate -> shadow -> promotion pointer">
      <div className="grid gap-3 p-3 md:grid-cols-5">
        <SignalInsightCard
          title="Champion linked"
          value={pointerReady}
          detail="production pointer 必須連到 artifact，不只版本字串"
          tone={pointers?.migration_ready ? 'ok' : 'warn'}
        />
        <SignalInsightCard
          title="Selected candidates"
          value={String(selectedArtifacts.length)}
          detail="offline gate 後被選進 monthly / weekly slot"
          tone={selectedArtifacts.length ? 'info' : 'warn'}
        />
        <SignalInsightCard
          title="Live evidence"
          value={String(liveCollecting)}
          detail="等待 daily predict -> verify-v2 -> IC tracker"
          tone={liveCollecting ? 'warn' : 'ok'}
        />
        <SignalInsightCard
          title="Promotion queue"
          value={String(promotionCount)}
          detail="promotion-controller final comparison"
          tone={promotionCount ? 'info' : 'neutral'}
        />
        <SignalInsightCard
          title="Blockers"
          value={String(blockers)}
          detail="missing / weak / failed evidence"
          tone={blockers ? 'warn' : 'ok'}
        />
      </div>
    </WorkstationPanel>
  )
}

function ServingDiagnosticsPanel({ payload }: { payload: any }) {
  const recs = (payload?.all_recommendations ?? payload?.recommendations ?? []) as any[]
  const diagnostics = recs
    .map((rec) => rec?.ml_diagnostics)
    .filter((diag) => diag && typeof diag === 'object')
  const total = diagnostics.length
  const alphaTotal = Number(diagnostics[0]?.totalAlphaModels ?? 8)
  const avgActive = total
    ? diagnostics.reduce((sum, diag) => sum + Number(diag.activeWeightCount ?? 0), 0) / total
    : 0
  const avgCompression = total
    ? diagnostics.reduce((sum, diag) => sum + Number(diag.dispersion?.mergeCompression ?? 0), 0) / total
    : 0
  const avgStd = total
    ? diagnostics.reduce((sum, diag) => sum + Number(diag.dispersion?.rawRankStd ?? 0), 0) / total
    : 0
  const zeroCounts = diagnostics.reduce<Record<string, number>>((acc, diag) => {
    for (const name of diag.zeroWeightModels ?? []) acc[name] = (acc[name] ?? 0) + 1
    return acc
  }, {})
  const blockedCounts = diagnostics.reduce<Record<string, number>>((acc, diag) => {
    for (const name of diag.validationBlockedModels ?? []) acc[name] = (acc[name] ?? 0) + 1
    return acc
  }, {})
  const calibrationCounts = diagnostics.reduce<Record<string, number>>((acc, diag) => {
    const key = diag.forecastCalibration?.method ?? diag.forecastCalibration?.source ?? 'unknown'
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  const calibrationSamples = diagnostics.reduce((sum, diag) => sum + Number(diag.forecastCalibration?.sampleCount ?? 0), 0)
  const primaryCalibration = Object.entries(calibrationCounts).sort((a, b) => b[1] - a[1])[0]
  const topZero = Object.entries(zeroCounts).sort((a, b) => b[1] - a[1]).slice(0, 4)
  const topBlocked = Object.entries(blockedCounts).sort((a, b) => b[1] - a[1]).slice(0, 4)
  const calibrationText = primaryCalibration
    ? `${formatCalibrationMethod(primaryCalibration[0])} · ${primaryCalibration[1]}/${total}`
    : 'N/A'

  return (
    <WorkstationPanel title="Serving Ensemble Diagnostics / 服務中投票診斷" kicker="latest daily recommendations · card contract">
      <div className="grid gap-3 p-3 lg:grid-cols-4">
        <SignalInsightCard
          title="Active weights / 有效權重"
          value={total ? `${avgActive.toFixed(1)}/${alphaTotal}` : 'N/A'}
          detail={`${total} recommendations with ml_diagnostics`}
          tone={!total ? 'warn' : avgActive >= alphaTotal * 0.75 ? 'ok' : 'warn'}
        />
        <SignalInsightCard
          title="Rank dispersion / 模型分歧"
          value={total ? avgStd.toFixed(3) : 'N/A'}
          detail="raw rank std; too low means views may be over-compressed"
          tone={!total ? 'warn' : avgStd > 0.02 ? 'ok' : 'warn'}
        />
        <SignalInsightCard
          title="Merge compression / 合併壓縮"
          value={total ? avgCompression.toFixed(2) : 'N/A'}
          detail="ensemble vs raw model spread"
          tone={!total ? 'warn' : avgCompression > 0.15 ? 'ok' : 'warn'}
        />
        <SignalInsightCard
          title="Forecast calibration / 預期值校準"
          value={calibrationText}
          detail={`樣本 ${calibrationSamples || 'N/A'}；date ${payload?.date ?? payload?.requested_date ?? 'N/A'}；用歷史排名分箱校準預期報酬，不是天文代碼。`}
          tone={calibrationText === 'N/A' || calibrationText.includes('unknown') ? 'warn' : 'ok'}
        />
      </div>
      <div className="grid gap-3 border-t border-[#263247] p-3 lg:grid-cols-2">
        <div className="rounded-lg border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#70809b]">Zero-weight models / 0 權重模型</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {topZero.length ? topZero.map(([name, count]) => (
              <WorkstationPill key={name} tone="warn">{name} {count}/{total}</WorkstationPill>
            )) : <WorkstationPill tone="ok">none</WorkstationPill>}
          </div>
        </div>
        <div className="rounded-lg border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#70809b]">Validation blocked / 驗證擋下</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {topBlocked.length ? topBlocked.map(([name, count]) => (
              <WorkstationPill key={name} tone="error">{name} {count}/{total}</WorkstationPill>
            )) : <WorkstationPill tone="ok">none</WorkstationPill>}
          </div>
        </div>
      </div>
    </WorkstationPanel>
  )
}

export default function ModelPoolPage() {
  const today = twToday()
  const queryClient = useQueryClient()
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['model-pool', 'lineage'],
    queryFn: modelPoolApi.lineage,
    refetchInterval: 60_000,
  })
  const { data: researchData } = useQuery({
    queryKey: ['research', 'experiments', 'model-upgrade'],
    queryFn: strategyLabApi.experiments,
    retry: false,
    staleTime: 60_000,
  })
  const servingDiagnostics = useQuery({
    queryKey: recommendationDailyKey(today),
    queryFn: () => recommendationsApi.daily(undefined, { view: 'card' }),
    retry: false,
    staleTime: queryTtl.dailyDecision,
    refetchInterval: queryTtl.dailyDecision,
  })
  const artifactSelection = useQuery({
    queryKey: ['model-pool', 'artifact-selection'],
    queryFn: () => modelPoolApi.artifactSelection(200),
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
  })
  const artifactPromotionQueue = useQuery({
    queryKey: ['model-pool', 'artifact-promotion-queue'],
    queryFn: () => modelPoolApi.artifactPromotionQueue(200),
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
  })
  const championPointers = useQuery({
    queryKey: ['model-pool', 'champion-pointers'],
    queryFn: () => modelPoolApi.championPointers(200),
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
  })
  const promotionController = useMutation({
    mutationFn: ({ artifactId, approved, confirm }: { artifactId: string; approved: boolean; confirm: boolean }) => modelPoolApi.promotionController({
      artifact_id: artifactId,
      confirm,
      approved,
      approved_by: approved ? 'Wei' : undefined,
      reason: approved ? 'wei_approval_from_model_pool_ui' : confirm ? 'auto_promotion_from_model_pool_ui' : 'dry_run_from_model_pool_ui',
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['model-pool', 'artifact-promotion-queue'] })
      queryClient.invalidateQueries({ queryKey: ['model-pool', 'champion-pointers'] })
      queryClient.invalidateQueries({ queryKey: ['model-pool', 'artifact-selection'] })
    },
  })

  const models = data?.models ?? {}
  const modelList = Object.entries(models).filter(([name, model]) => !isStateSpaceOverlay(name, model))
  const legacyOverlayList = Object.entries(models).filter(([name, model]) => isStateSpaceOverlay(name, model))
  const overlayList = [
    ...Object.entries(data?.state_overlays ?? {}),
    ...legacyOverlayList.map(([name, model]) => [name, {
      status: model.status,
      version: model.version,
      model_type: model.model_type,
      balance_family: model.balance_family,
      role: 'regime_risk_overlay',
      gcs_path: model.gcs_path,
      note: 'Legacy lineage entry rendered as state-space overlay; excluded from alpha model IC counts.',
    }] as const),
  ]

  const counts = familyCounts(modelList)
  const shadowLineageCount = modelList.filter(([, model]) => !!model.challenger).length
  const plannedShadowCount = MODEL_UPGRADE_CANDIDATES.filter((candidate) => candidate.stage === 'shadow_challenger').length
  const benchmarkCount = MODEL_UPGRADE_CANDIDATES.filter((candidate) => candidate.stage === 'benchmark_only').length
  const missingMetadata = modelList.filter(([, model]) => !model.metadata_exists).length
  const weakIc = modelList.filter(([, model]) => {
    const ic = icValue(model)
    return ic == null || Math.abs(ic) < 0.0001
  }).length
  const sampleGaps = modelList.filter(([, model]) => Number(model.last_ic_sample_count ?? 0) <= 0).length
  const activeModels = modelList.filter(([, model]) => model.status === 'active').length

  const traceSteps = useMemo(() => [
    { label: 'Alpha Vote', detail: '8 個 production slots 才會進 user-facing ML 投票。', tone: 'ok' as WorkstationTone },
    { label: 'Shadow', detail: 'MLP / GNN 只產生 evidence；promotion 前不投票。', tone: plannedShadowCount || shadowLineageCount ? 'info' as WorkstationTone : 'warn' as WorkstationTone },
    { label: 'Benchmark', detail: 'TabM / iTransformer / TimesFM 只做研究比較，避免成本暴增。', tone: 'warn' as WorkstationTone },
    { label: 'Overlay', detail: 'Kalman / Markov 提供 regime、noise、risk context，不算 alpha model。', tone: 'neutral' as WorkstationTone },
  ], [plannedShadowCount, shadowLineageCount])

  return (
    <AppShell>
      <div className="space-y-6 p-4 lg:p-6">
        <WorkstationPageTitle
          kicker="Model care"
          title="模型池"
          description="用一頁看 production alpha、shadow challenger、研究基準、狀態 overlay、IC 根因與 artifact metadata，避免模型健康只藏在 log 裡。"
          action={
            <div className="flex flex-wrap items-center gap-2">
              {isFetching && <WorkstationPill tone="info">更新中</WorkstationPill>}
              <Button size="sm" variant="outline" className="rounded-full border-[#d6a85f]/30 text-[#f1c16f]" onClick={() => { refetch(); servingDiagnostics.refetch(); artifactSelection.refetch(); artifactPromotionQueue.refetch(); championPointers.refetch() }}>
                <RefreshCw className="mr-1 h-3 w-3" /> 更新
              </Button>
            </div>
          }
        />

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading model pool...
          </div>
        )}

        {error && (
          <div className="border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{(error as Error).message}</div>
        )}

        {!isLoading && (
          <>
            <DecisionTraceRail title="模型生命週期規則" compact steps={traceSteps} />

            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <SignalInsightCard title="Alpha Models / 投票模型" value={String(modelList.length)} detail={`active ${activeModels}; family ${Object.entries(counts).map(([family, count]) => `${family}:${count}`).join(' / ') || 'N/A'}`} tone="info" />
              <SignalInsightCard title="影子挑戰者" value={`${shadowLineageCount}+${plannedShadowCount}`} detail="左邊是 lineage 已掛載；右邊是 P7 upgrade track 計畫中的 MLP/GNN。" tone={shadowLineageCount || plannedShadowCount ? 'ok' : 'warn'} />
              <SignalInsightCard title="Research Benchmarks / 研究基準" value={String(benchmarkCount)} detail="TabM、iTransformer、TimesFM 不投票，只做 benchmark evidence。" tone="warn" />
              <SignalInsightCard title="IC 缺口" value={String(weakIc)} detail={`0/NaN IC 或 sample 不足；sample gaps ${sampleGaps}`} tone={weakIc || sampleGaps ? 'warn' : 'ok'} />
            </div>

            <FamilyBalancePanel counts={counts} total={activeModels || modelList.length} />
            <ArtifactLifecycleSummaryPanel
              selection={artifactSelection.data}
              pointers={championPointers.data}
              queue={artifactPromotionQueue.data}
            />
            <ChampionPointerPanel pointers={championPointers.data} />
            <ArtifactRegistryPanel selection={artifactSelection.data} />
            <PromotionQueuePanel
              queue={artifactPromotionQueue.data}
              isPromoting={promotionController.isPending}
              promotionResult={promotionController.data}
              onPromote={(artifactId, approved, confirm) => promotionController.mutate({ artifactId, approved, confirm })}
            />
            <ServingDiagnosticsPanel payload={servingDiagnostics.data} />
            <LiveShadowEvidencePanel selection={artifactSelection.data} />
            <ArtifactDiffPanel selection={artifactSelection.data} pointers={championPointers.data} />
            <UpgradeTrackPanel experiments={researchData?.experiments ?? []} />

            <WorkstationPanel title="模型健康矩陣" kicker="IC, samples, coverage, metadata, challenger">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] border-collapse font-mono text-[11px]">
                  <thead className="bg-[#0c1420] text-[#70809b]">
                    <tr>
                      {['Model / 模型', 'Status / 狀態', 'IC 4W', 'Samples / 樣本', 'Metadata', 'Coverage / 覆蓋率', 'Shadow Challenger', 'Root cause / 根因'].map((label) => (
                        <th key={label} className="border border-[#263247] px-2 py-2 text-left font-medium uppercase tracking-[0.14em]">{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {modelList.map(([name, model]) => <ModelHealthRow key={name} name={name} model={model} />)}
                  </tbody>
                </table>
              </div>
            </WorkstationPanel>

            <WorkstationPanel title="State-space Overlays / 狀態空間 Overlay" kicker="regime risk overlay, not alpha vote model">
              <div className="space-y-2 p-3 text-xs text-muted-foreground">
                <p>
                  Kalman / Markov 只扮演 regime、noise、risk overlay：協助市場狀態、波動雜訊、sizing 與風控判斷；不進 8 alpha model 投票分母，也不進 alpha IC promote gate。
                </p>
                <div className="grid gap-2 md:grid-cols-2">
                  {overlayList.map(([name, overlay]) => (
                    <div key={name} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold text-foreground">{name}</div>
                          <div className="mt-1 text-[11px]">{overlay.role ?? overlay.model_type ?? 'state-space overlay'}</div>
                        </div>
                        <WorkstationPill tone={toneFromStatus(overlay.status)}>{overlay.status ?? 'active'}</WorkstationPill>
                      </div>
                      <div className="mt-2 break-all font-mono text-[10px]">{overlay.gcs_path ?? 'default hyperparams'}</div>
                      {overlay.note && <div className="mt-2 text-[11px]">{overlay.note}</div>}
                    </div>
                  ))}
                  {!overlayList.length && (
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">No state-space overlay registered.</div>
                  )}
                </div>
              </div>
            </WorkstationPanel>

            <WorkstationPanel title="最近生命週期事件" kicker="promote, degrade, restore, retire audit">
              <div className="space-y-2 p-3">
                {(data?.events ?? []).slice().reverse().slice(0, 20).map((event, index) => (
                  <div key={index} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2 text-[11px]">
                    <span className="font-mono text-sky-300">{fmt(event.model)}</span>
                    <span className="mx-2 text-muted-foreground">{fmt(event.transition)}</span>
                    <span className="text-muted-foreground">{fmt(event.at)}</span>
                    {event.reason && <div className="mt-1 text-muted-foreground">{fmt(event.reason)}</div>}
                  </div>
                ))}
                {(data?.events ?? []).length === 0 && (
                  <div className="text-sm text-muted-foreground">No lifecycle events recorded yet.</div>
                )}
              </div>
            </WorkstationPanel>
          </>
        )}
      </div>
    </AppShell>
  )
}
