import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw } from 'lucide-react'
import AppShell from '@/components/AppShell'
import ModelPoolNewFlowWorkbench from '@/components/model-pool/ModelPoolNewFlowWorkbench'
import { SignalInsightCard } from '@/components/workstation/DecisionArchitecture'
import { WorkstationPageTitle, WorkstationPanel, WorkstationPill, type WorkstationTone } from '@/components/workstation/WorkstationChrome'
import { Button } from '@/components/ui/button'
import {
  modelPoolApi,
  strategyLabApi,
  type ModelArtifactActionContext,
  type ModelArtifactPromotionControllerResponse,
  type ModelArtifactPromotionQueueResponse,
  type ModelChampionPointersResponse,
  type ModelPoolLineage,
  type ModelPoolLineageModel,
  type ModelPoolStateOverlay,
  type ModelUpgradeResearchStatusRow,
  type ResearchExperiment,
} from '@/lib/api'
import {
  MODEL_POOL_NEAR_PRODUCTION_IDS,
  MODEL_POOL_RETIRED_MODEL_IDS,
  MODEL_UPGRADE_CANDIDATES,
} from '@/lib/modelUpgradeTrack'

const RETIRED_MODEL_NAMES = new Set<string>(MODEL_POOL_RETIRED_MODEL_IDS)
const NEAR_PRODUCTION_MODEL_NAMES = new Set<string>(MODEL_POOL_NEAR_PRODUCTION_IDS)

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

function isRetiredModelName(name: string): boolean {
  return RETIRED_MODEL_NAMES.has(name)
}

function isNearProductionModelName(name: string): boolean {
  return NEAR_PRODUCTION_MODEL_NAMES.has(name)
}

function isStateSpaceOverlay(name: string, model: ModelPoolLineageModel) {
  return (
    name === 'KalmanFilter' ||
    name === 'MarkovSwitching' ||
    model.model_type === 'state_space_overlay' ||
    model.balance_family === 'state_space'
  )
}

function shortEvidenceId(value?: string | null): string {
  if (!value) return '-'
  return value.length > 44 ? `${value.slice(0, 26)}...${value.slice(-10)}` : value
}

function preflightLabel(row?: ModelUpgradeResearchStatusRow): string {
  if (!row) return 'blocked'
  if (row.registry_preflight_ready) return 'ready'
  const missing = row.artifact_intent_missing_fields?.slice(0, 3).join(', ')
  return missing ? `blocked; missing ${missing}` : 'blocked'
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

function experimentEvidence(candidateId: string, experiments: ResearchExperiment[], statusRows: ModelUpgradeResearchStatusRow[] = []) {
  const matched = candidateExperiments(candidateId, experiments)
  const latest = matched[0]
  const statusRow = statusRows.find((row) => row.candidate_id.toLowerCase() === candidateId.toLowerCase())
  const isEvidenceReady = Boolean(
    statusRow?.registry_status === 'ready_for_review' ||
    statusRow?.registry_status === 'approved_for_patch' ||
    latest &&
    (latest.status === 'ready_for_review' || latest.status === 'approved_for_patch' || latest.status === 'completed' || latest.status === 'reviewed') &&
    latest.metrics?.some((metric) => /oos|ic|pbo|cpcv|cost|slice/i.test(metric)),
  )
  return {
    matched,
    latest,
    statusRow,
    metricText: latest?.metrics?.length ? latest.metrics.join(', ') : 'missing',
    isEvidenceReady,
  }
}

function upgradeRegistryLabel(label: string) {
  if (label === 'experiment_missing') return '尚未建立 Strategy Lab 實驗'
  if (label === 'evaluation_pending') return '等待 dry-run 驗證'
  if (label === 'ready_for_review') return 'evidence ready'
  if (label === 'needs_attention') return '需檢查 blockers'
  if (label === 'approved_for_patch') return 'approved for patch'
  return label
}

function promotionMetric(result: ModelArtifactPromotionControllerResponse, keys: string[], digits = 4): string {
  const value = promotionMetricNumber(result, keys)
  if (value == null) return 'N/A'
  return digits > 0 ? value.toFixed(digits) : Math.round(value).toLocaleString()
}

function promotionMetricNumber(result: ModelArtifactPromotionControllerResponse, keys: string[]): number | null {
  const evidence = result.evidence ?? {}
  const metrics = evidence.metrics && typeof evidence.metrics === 'object' ? evidence.metrics as Record<string, unknown> : evidence
  for (const key of keys) {
    const value = metrics[key]
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
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
    ? approvalRequired ? 'beats champion, Wei approval required' : 'beats champion'
    : hasLiveComparison ? 'does not beat champion yet' : 'live comparison missing'
  return { shadowIc, productionIc, icDelta, hasLiveComparison, beatsChampion, blockers, approvalRequired, resultLabel }
}

function ActionContextNote({ context }: { context?: ModelArtifactActionContext }) {
  if (!context) return null
  const blockers = Array.isArray(context.blockers) ? context.blockers : []
  return (
    <div className="mt-2 rounded-lg border border-[#263247] bg-[#070a10] p-2 text-[11px] leading-5 text-[#8a92a6]">
      <div className="font-mono text-amber-200">root: {context.root_cause}</div>
      <div>impact: {context.impact}</div>
      <div>next: {context.next_action}</div>
      {context.scheduler_dependency?.length ? (
        <div className="mt-1 text-sky-200">needs: {context.scheduler_dependency.join(' -> ')}</div>
      ) : null}
      {blockers.length > 0 && (
        <div className="mt-2 space-y-1 rounded-lg border border-amber-400/20 bg-amber-400/[0.04] p-2">
          <div className="font-mono text-amber-200">blockers</div>
          {blockers.slice(0, 5).map((blocker) => (
            <div key={blocker.code} className="border-l border-amber-300/30 pl-2">
              <div className="font-semibold text-slate-100">{blocker.label}</div>
              <div className="text-[#9aa7bd]">{blocker.next_action}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PromotionControllerResultPanel({ result }: { result: ModelArtifactPromotionControllerResponse }) {
  const summary = promotionComparisonSummary(result)
  const tone: WorkstationTone = summary.beatsChampion ? 'ok' : summary.hasLiveComparison ? 'error' : 'warn'

  return (
    <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3 text-xs leading-5 lg:col-span-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <WorkstationPill tone={tone}>{result.decision ?? result.status}</WorkstationPill>
        <WorkstationPill tone={summary.approvalRequired ? 'warn' : 'neutral'}>
          {summary.approvalRequired ? 'approval required' : 'approval not required'}
        </WorkstationPill>
        <span className="font-mono text-[#fff1cf]">{result.artifact_id ?? 'artifact N/A'}</span>
      </div>
      <div className="grid gap-2 md:grid-cols-4">
        <div className="rounded-lg border border-[#263247] bg-[#070a10] p-2">
          <p className="font-mono text-[#70809b]">shadow IC</p>
          <p className="mt-1 text-slate-100">{promotionMetric(result, ['shadow_ic', 'shadowIc'], 4)}</p>
        </div>
        <div className="rounded-lg border border-[#263247] bg-[#070a10] p-2">
          <p className="font-mono text-[#70809b]">champion IC</p>
          <p className="mt-1 text-slate-100">{promotionMetric(result, ['production_ic', 'productionIc'], 4)}</p>
        </div>
        <div className="rounded-lg border border-[#263247] bg-[#070a10] p-2">
          <p className="font-mono text-[#70809b]">delta</p>
          <p className="mt-1 text-slate-100">{summary.icDelta == null ? 'N/A' : summary.icDelta.toFixed(4)}</p>
        </div>
        <div className="rounded-lg border border-[#263247] bg-[#070a10] p-2">
          <p className="font-mono text-[#70809b]">target</p>
          <p className="mt-1 text-slate-100">{result.target_state ?? 'N/A'}</p>
        </div>
      </div>
      <p className="mt-3 text-[#d0d8e8]">{summary.resultLabel}</p>
      {result.next_action && <p className="mt-1 text-[#8a92a6]">next: {result.next_action}</p>}
      {summary.blockers.length > 0 && (
        <div className="mt-2 rounded-lg border border-rose-400/25 bg-rose-400/[0.05] p-2 text-rose-100">
          blockers: {summary.blockers.join(', ')}
        </div>
      )}
    </div>
  )
}

function UpgradeTrackPanelV2({ experiments = [], statusRows = [] }: { experiments?: ResearchExperiment[]; statusRows?: ModelUpgradeResearchStatusRow[] }) {
  const candidates = MODEL_UPGRADE_CANDIDATES.filter((candidate) => isNearProductionModelName(candidate.id))

  return (
    <WorkstationPanel title="Near-production L3 Model Tracks / 近 production 模型軌道" kicker="TabM, GNN, iTransformer, TimesFM only">
      <div className="border-b border-[#263247] bg-[#05070c] p-3 text-xs leading-5 text-[#9aa7bd]">
        這裡只放新流程要補進 L3 family vote 的模型。已淘汰模型不在本頁呈現；GAOptimizer 屬於參數學習，Kalman/Markov 屬於 L4 overlay。
      </div>
      <div className="grid gap-3 p-3 lg:grid-cols-2">
        {candidates.map((candidate) => {
          const evidence = experimentEvidence(candidate.id, experiments, statusRows)
          const registryLabel = evidence.statusRow?.registry_status
            ?? (evidence.isEvidenceReady
              ? 'ready_for_review'
              : evidence.latest
                ? 'evaluation_pending'
                : 'experiment_missing')
          const statusTone: WorkstationTone = evidence.isEvidenceReady
            ? 'ok'
            : evidence.latest || evidence.statusRow
              ? 'warn'
              : 'info'
          return (
            <div key={candidate.id} className="rounded-xl border border-[#263247] bg-[#070a10] p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-[13px] font-semibold text-[#fff1cf]">{candidate.id}</p>
                  <p className="mt-1 text-[11px] text-[#70809b]">{candidate.layer} / {candidate.family}</p>
                </div>
                <WorkstationPill tone={statusTone}>{upgradeRegistryLabel(registryLabel)}</WorkstationPill>
              </div>
              <p className="mt-2 text-xs leading-5 text-[#9aa7bd]">{candidate.roleZh}</p>
              <div className="mt-3 grid gap-2 text-[11px] md:grid-cols-2">
                <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
                  <p className="font-mono text-[#70809b]">registry</p>
                  <p className="mt-1 text-slate-200">{evidence.latest?.id ?? evidence.statusRow?.latest_experiment_id ?? 'not created'}</p>
                </div>
                <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
                  <p className="font-mono text-[#70809b]">evaluation</p>
                  <p className="mt-1 text-slate-200">{evidence.statusRow?.latest_evaluation_verdict ?? 'pending'}</p>
                </div>
                <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
                  <p className="font-mono text-[#70809b]">artifact intent</p>
                  <p className="mt-1 text-slate-200">{evidence.statusRow?.latest_artifact_intent_status ?? 'pending'}</p>
                </div>
                <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
                  <p className="font-mono text-[#70809b]">preflight</p>
                  <p className="mt-1 text-slate-200">{preflightLabel(evidence.statusRow)}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1">
                {candidate.requiredEvidence.map((item) => (
                  <WorkstationPill key={item} tone="neutral">{item}</WorkstationPill>
                ))}
              </div>
              <p className="mt-3 rounded-lg border border-sky-400/20 bg-sky-400/[0.04] p-2 text-[11px] leading-5 text-sky-100">
                下一步：Strategy Lab 補齊 evidence matrix；通過 OOS IC、CPCV/PBO、成本與 slice stability 後，才可進 L3 production weight gate。
              </p>
            </div>
          )
        })}
      </div>
    </WorkstationPanel>
  )
}

function PromotionQueuePanelV2({
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
  const blockedCount = rows.filter((row) => row.promotion_decision.includes('blocked') || (row.blockers?.length ?? 0) > 0).length
  const suppressedCount = queue?.suppressed_count ?? queue?.suppressed?.length ?? 0

  return (
    <WorkstationPanel
      title="Promotion & Parameter Governance / 參數與版本晉升"
      kicker="artifact candidate, final compare, approval, champion pointer"
    >
      <div className="grid gap-3 p-3 md:grid-cols-4">
        <SignalInsightCard title="Auto candidates" value={String(autoCount)} detail="monthly release passed live gate and final compare" tone={autoCount ? 'ok' : 'neutral'} />
        <SignalInsightCard title="Approval required" value={String(approvalCount)} detail="weekly/manual changes still require Wei approval" tone={approvalCount ? 'warn' : 'neutral'} />
        <SignalInsightCard title="Superseded weekly" value={String(suppressedCount)} detail="newer monthly release hides older weekly approval rows" tone={suppressedCount ? 'info' : 'neutral'} />
        <SignalInsightCard title="Blocked" value={String(blockedCount)} detail="missing champion pointer, weak evidence, or final compare gap" tone={blockedCount ? 'error' : 'ok'} />
      </div>
      <div className="border-t border-[#263247] bg-[#05070c] p-3 text-xs leading-5 text-[#9aa7bd]">
        這區保留參數比較與晉升操作：Optuna/GA/allocator knobs 只產 candidate，artifact candidate 先做 final compare，再經 approval gate 更新 champion pointer。它不是 L2/L3 模型家族投票圖。
      </div>
      <div className="grid gap-3 border-t border-[#263247] p-3 lg:grid-cols-2">
        {rows.length ? rows.map((row) => {
          const blockers = Array.isArray(row.blockers) ? row.blockers : []
          const isBlocked = row.promotion_decision.includes('blocked') || blockers.length > 0
          return (
            <div key={row.artifact_id ?? `${row.model_name}-${row.candidate_version}`} className="rounded-xl border border-[#263247] bg-[#070a10] p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-[12px] font-semibold text-slate-100">{row.model_name}</p>
                  <p className="mt-1 font-mono text-[11px] text-[#70809b]">
                    {row.current_champion_version ?? 'champion N/A'} -&gt; {row.candidate_version ?? 'candidate N/A'}
                  </p>
                </div>
                <WorkstationPill tone={row.promotion_decision === 'auto_promote_candidate' ? 'ok' : row.approval_required ? 'warn' : isBlocked ? 'error' : 'info'}>
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
              {blockers.length > 0 && (
                <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] p-3 text-[12px] leading-5">
                  <div className="mb-2 font-mono text-amber-200">Promotion blockers</div>
                  <div className="grid gap-2 md:grid-cols-2">
                    {blockers.map((blocker) => (
                      <div key={blocker.code} className="rounded-lg border border-[#33415c] bg-[#05070c] p-2">
                        <div className="font-semibold text-slate-100">{blocker.label}</div>
                        <div className="mt-1 text-[#9aa7bd]">{blocker.next_action}</div>
                        <div className="mt-1 font-mono text-[10px] text-[#70809b]">{blocker.code}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!row.artifact_id || isPromoting || isBlocked}
                  className="rounded-full border-emerald-400/30 text-emerald-200 hover:bg-emerald-400/10"
                  onClick={() => row.artifact_id && onPromote(row.artifact_id, false, false)}
                >
                  Final compare dry-run
                </Button>
                {row.approval_required ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!row.artifact_id || isPromoting || isBlocked}
                    className="rounded-full border-amber-400/30 text-amber-200 hover:bg-amber-400/10"
                    onClick={() => row.artifact_id && onPromote(row.artifact_id, true, true)}
                  >
                    Wei approve + promote pointer
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!row.artifact_id || isPromoting || isBlocked}
                    className="rounded-full border-sky-400/30 text-sky-200 hover:bg-sky-400/10"
                    onClick={() => row.artifact_id && onPromote(row.artifact_id, false, true)}
                  >
                    Auto promote pointer
                  </Button>
                )}
              </div>
            </div>
          )
        }) : (
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

type OverlayEntry = [string, ModelPoolStateOverlay]

export default function ModelPoolPage() {
  const queryClient = useQueryClient()
  const { data, error, isLoading, isFetching, refetch } = useQuery<ModelPoolLineage>({
    queryKey: ['model-pool', 'lineage'],
    queryFn: modelPoolApi.lineage,
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
  })
  const researchData = useQuery({
    queryKey: ['strategy-lab', 'experiments'],
    queryFn: strategyLabApi.experiments,
    retry: false,
    staleTime: 60_000,
  })
  const modelUpgradeStatus = useQuery({
    queryKey: ['strategy-lab', 'model-upgrade-status'],
    queryFn: strategyLabApi.modelUpgradeStatus,
    retry: false,
    staleTime: 60_000,
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
  const championPointers = useQuery<ModelChampionPointersResponse>({
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
  const modelList = Object.entries(models).filter(([name, model]) => !isStateSpaceOverlay(name, model) && !isRetiredModelName(name))
  const legacyOverlayList: OverlayEntry[] = Object.entries(models)
    .filter(([name, model]) => isStateSpaceOverlay(name, model))
    .map(([name, model]) => [name, {
      status: model.status,
      version: model.version,
      model_type: model.model_type,
      balance_family: model.balance_family,
      role: 'regime_risk_overlay',
      gcs_path: model.gcs_path,
      note: 'Legacy lineage entry rendered as state-space overlay; excluded from alpha model IC counts.',
    }])
  const overlayList: OverlayEntry[] = [
    ...Object.entries(data?.state_overlays ?? {}),
    ...legacyOverlayList,
  ]

  return (
    <AppShell>
      <div className="space-y-6 p-4 lg:p-6">
        <WorkstationPageTitle
          kicker="Model care"
          title="模型池"
          description="對齊新 screener：L2 coarse、L3 family ML、近 production 候選、參數晉升與 champion pointer；L1 策略 diversity 回到 Strategy Lab，單次流程追蹤回到 Pipeline Trace。"
          action={
            <div className="flex flex-wrap items-center gap-2">
              {isFetching && <WorkstationPill tone="info">更新中</WorkstationPill>}
              <Button
                size="sm"
                variant="outline"
                className="rounded-full border-[#d6a85f]/30 text-[#f1c16f]"
                onClick={() => {
                  refetch()
                  artifactSelection.refetch()
                  artifactPromotionQueue.refetch()
                  championPointers.refetch()
                  researchData.refetch()
                  modelUpgradeStatus.refetch()
                }}
              >
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
            <ModelPoolNewFlowWorkbench
              models={modelList}
              selection={artifactSelection.data}
              pointers={championPointers.data}
              promotionQueue={artifactPromotionQueue.data}
              statusRows={modelUpgradeStatus.data?.candidates ?? []}
            />

            <PromotionQueuePanelV2
              queue={artifactPromotionQueue.data}
              isPromoting={promotionController.isPending}
              promotionResult={promotionController.data}
              onPromote={(artifactId, approved, confirm) => promotionController.mutate({ artifactId, approved, confirm })}
            />

            <UpgradeTrackPanelV2
              experiments={researchData.data?.experiments ?? []}
              statusRows={modelUpgradeStatus.data?.candidates ?? []}
            />

            <WorkstationPanel title="State-space Overlays / 狀態空間 Overlay" kicker="regime risk overlay, not alpha vote model">
              <div className="space-y-2 p-3 text-xs text-muted-foreground">
                <p>
                  Kalman / Markov 只提供 regime、noise、risk overlay，服務 L4 allocation/sizing/context；不算 L3 alpha model，也不進 alpha IC promotion gate。
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
