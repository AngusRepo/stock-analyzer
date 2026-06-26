import { useCallback, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw } from 'lucide-react'
import AppShell from '@/components/AppShell'
import ModelPoolNewFlowWorkbench from '@/components/model-pool/ModelPoolNewFlowWorkbench'
import { SignalInsightCard } from '@/components/workstation/DecisionArchitecture'
import {
  WorkstationPageTitle,
  WorkstationPanel,
  WorkstationPill,
  type WorkstationTone,
} from '@/components/workstation/WorkstationChrome'
import { Button } from '@/components/ui/button'
import {
  modelPoolApi,
  type ModelArtifactCompare,
  strategyLabApi,
  type ModelArtifactActionContext,
  type ModelArtifactPromotionControllerResponse,
  type ModelArtifactPromotionQueueResponse,
  type ModelArtifactSelectionResponse,
  type ModelChampionPointersResponse,
  type ModelPoolLineage,
  type ModelPoolLineageModel,
  type ModelPoolStateOverlay,
  type ModelUpgradeResearchStatusRow,
} from '@/lib/api'
import {
  MODEL_POOL_RETIRED_MODEL_IDS,
} from '@/lib/modelUpgradeTrack'

const RETIRED_MODEL_NAMES = new Set<string>(MODEL_POOL_RETIRED_MODEL_IDS)

type OverlayEntry = [string, ModelPoolStateOverlay]

type ModelPoolWorkbenchSnapshot = {
  lineage: ModelPoolLineage
  selection: ModelArtifactSelectionResponse
  promotionQueue: ModelArtifactPromotionQueueResponse
  pointers: ModelChampionPointersResponse
  statusRows: ModelUpgradeResearchStatusRow[]
  capturedAt: number
}

function toneFromStatus(status?: string | null): WorkstationTone {
  if (status === 'active' || status === 'ok' || status === 'ready_for_review' || status === 'approved_for_patch') return 'ok'
  if (status === 'degraded' || status === 'warn' || status === 'coverage_low' || status === 'evaluation_pending') return 'warn'
  if (status === 'retired' || status === 'failed' || status === 'error' || status === 'artifact_mismatch') return 'error'
  return 'neutral'
}

function isRetiredModelName(name: string): boolean {
  return RETIRED_MODEL_NAMES.has(name)
}

function isStateSpaceOverlay(name: string, model: ModelPoolLineageModel): boolean {
  return (
    name === 'KalmanFilter' ||
    name === 'MarkovSwitching' ||
    model.model_type === 'state_space_overlay' ||
    model.balance_family === 'state_space'
  )
}

function promotionMetricNumber(result: ModelArtifactPromotionControllerResponse, keys: string[]): number | null {
  const evidence = result.evidence ?? {}
  const metrics = evidence.metrics && typeof evidence.metrics === 'object' ? evidence.metrics as Record<string, unknown> : evidence
  for (const key of keys) {
    const n = Number(metrics[key])
    if (Number.isFinite(n)) return n
  }
  return null
}

function promotionMetric(result: ModelArtifactPromotionControllerResponse, keys: string[], digits = 4): string {
  const value = promotionMetricNumber(result, keys)
  if (value == null) return 'N/A'
  return digits > 0 ? value.toFixed(digits) : Math.round(value).toLocaleString()
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
    ? approvalRequired ? 'beats champion; Wei approval required' : 'beats champion'
    : hasLiveComparison ? 'does not beat champion yet' : 'live comparison missing'
  return { icDelta, hasLiveComparison, beatsChampion, blockers, approvalRequired, resultLabel }
}

function governanceMetric(value: number | string | null | undefined, digits = 4): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 'N/A'
  return numeric.toFixed(digits)
}

function signedGovernanceMetric(value: number | string | null | undefined, digits = 4): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 'N/A'
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(digits)}`
}

function artifactCompareTone(compare?: ModelArtifactCompare): WorkstationTone {
  const status = String(compare?.metric_status ?? '').toLowerCase()
  const delta = Number(compare?.oos_ic_delta)
  if (status.includes('missing')) return 'warn'
  if (Number.isFinite(delta)) return delta > 0 ? 'ok' : 'error'
  return 'neutral'
}

function ArtifactDeltaGrid({
  compare,
  context,
}: {
  compare?: ModelArtifactCompare
  context?: ModelArtifactActionContext
}) {
  const rootCause = context?.root_cause ?? compare?.metric_status ?? 'pending'
  const liveRootCause = rootCause === 'live_shadow_not_started'
    ? 'live shadow not started'
    : humanizeGovernanceToken(rootCause)
  return (
    <div className="mt-3 grid gap-2 text-[11px] text-[#9aa6bd] md:grid-cols-4">
      <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
        <p className="font-mono text-[#70809b]">Candidate OOS</p>
        <p className="mt-1 font-mono text-slate-100">{governanceMetric(compare?.candidate_oos_ic)}</p>
      </div>
      <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
        <p className="font-mono text-[#70809b]">Champion OOS</p>
        <p className="mt-1 font-mono text-slate-100">{governanceMetric(compare?.champion_oos_ic)}</p>
      </div>
      <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
        <p className="font-mono text-[#70809b]">Delta</p>
        <p className={`mt-1 font-mono ${artifactCompareTone(compare) === 'ok' ? 'text-emerald-200' : artifactCompareTone(compare) === 'error' ? 'text-rose-200' : 'text-amber-200'}`}>
          {signedGovernanceMetric(compare?.oos_ic_delta)}
        </p>
      </div>
      <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
        <p className="font-mono text-[#70809b]">Root cause</p>
        <p className="mt-1 text-slate-100">{liveRootCause}</p>
      </div>
    </div>
  )
}

function humanizeGovernanceToken(value: string | null | undefined): string {
  const text = String(value ?? '').trim()
  return text ? text.replace(/[_-]+/g, ' ') : 'pending'
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
        <SignalInsightCard title="Shadow IC" value={promotionMetric(result, ['shadow_ic', 'shadowIc'])} detail="candidate live evidence" />
        <SignalInsightCard title="Champion IC" value={promotionMetric(result, ['production_ic', 'productionIc'])} detail="current pointer evidence" />
        <SignalInsightCard title="Delta" value={summary.icDelta == null ? 'N/A' : summary.icDelta.toFixed(4)} detail="candidate minus champion" tone={summary.beatsChampion ? 'ok' : 'warn'} />
        <SignalInsightCard title="Target" value={result.target_state ?? 'N/A'} detail="promotion target state" />
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
  const blockedCount = rows.filter((row) => String(row.promotion_decision ?? '').includes('blocked') || (row.blockers?.length ?? 0) > 0).length
  const suppressedRows = queue?.suppressed ?? []
  const suppressedCount = queue?.suppressed_count ?? suppressedRows.length

  return (
    <WorkstationPanel title="Promotion & Parameter Governance" kicker="artifact candidate, final compare, approval, champion pointer">
      <div className="grid gap-3 p-3 md:grid-cols-4">
        <SignalInsightCard title="Auto candidates" value={String(autoCount)} detail="monthly release passed live gate and final compare" tone={autoCount ? 'ok' : 'neutral'} />
        <SignalInsightCard title="Approval required" value={String(approvalCount)} detail="weekly/manual changes still require Wei approval" tone={approvalCount ? 'warn' : 'neutral'} />
        <SignalInsightCard title="Superseded weekly" value={String(suppressedCount)} detail="newer monthly release hides older weekly approval rows" tone={suppressedCount ? 'info' : 'neutral'} />
        <SignalInsightCard title="Blocked" value={String(blockedCount)} detail="missing champion pointer, weak evidence, or final compare gap" tone={blockedCount ? 'error' : 'ok'} />
      </div>
      <div className="border-t border-[#263247] bg-[#05070c] p-3 text-xs leading-5 text-[#9aa7bd]">
        Optuna, GA, and allocator controllers emit parameter candidates. Artifact candidates still
        need final compare, approval gate, and champion pointer updates; this panel is governance,
        not the L2/L3 family vote graph.
      </div>
      <div className="grid gap-3 border-t border-[#263247] p-3 lg:grid-cols-2">
        {rows.length ? rows.map((row) => {
          const blockers = Array.isArray(row.blockers) ? row.blockers : []
          const isBlocked = String(row.promotion_decision ?? '').includes('blocked') || blockers.length > 0
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
              <ArtifactDeltaGrid compare={row.artifact_compare} context={row.action_context} />
              <p className="mt-3 text-[12px] leading-5 text-slate-300">{row.next_action}</p>
              <ActionContextNote context={row.action_context} />
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
            No artifact candidate is currently ready for live-gate promotion review.
          </div>
        )}
        {promotionResult && <PromotionControllerResultPanel result={promotionResult} />}
      </div>
      {suppressedRows.length > 0 && (
        <div className="border-t border-[#263247] p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-[#90a0b8]">Suppressed versions</p>
            <WorkstationPill tone="info">{suppressedRows.length} hidden</WorkstationPill>
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {suppressedRows.slice(0, 8).map((row) => (
              <div key={row.artifact_id ?? `${row.model_name}-${row.candidate_version}`} className="rounded-lg border border-[#263247] bg-[#070a10] p-2 text-[11px] leading-5 text-[#9aa7bd]">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-mono text-slate-100">{row.model_name} {row.candidate_version ?? ''}</p>
                    <p>{humanizeGovernanceToken(row.reason)}</p>
                  </div>
                  <span className="font-mono text-[#70809b]">{row.candidate_type}</span>
                </div>
                {row.action_context?.root_cause && (
                  <p className="mt-1 text-amber-200">root: {humanizeGovernanceToken(row.action_context.root_cause)}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </WorkstationPanel>
  )
}

export default function ModelPoolPage() {
  const queryClient = useQueryClient()
  const { data, error, isLoading, isFetching, refetch } = useQuery<ModelPoolLineage>({
    queryKey: ['model-pool', 'lineage'],
    queryFn: modelPoolApi.lineage,
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
  })
  const artifactPromotionQueue = useQuery({
    queryKey: ['model-pool', 'artifact-promotion-queue'],
    queryFn: () => modelPoolApi.artifactPromotionQueue(200),
    retry: false,
    staleTime: 60_000,
  })
  const championPointers = useQuery<ModelChampionPointersResponse>({
    queryKey: ['model-pool', 'champion-pointers'],
    queryFn: () => modelPoolApi.championPointers(200),
    retry: false,
    staleTime: 60_000,
  })
  const [modelPoolSnapshot, setModelPoolSnapshot] = useState<ModelPoolWorkbenchSnapshot | null>(null)
  const modelPoolFetching = (
    isFetching ||
    modelUpgradeStatus.isFetching ||
    artifactSelection.isFetching ||
    artifactPromotionQueue.isFetching ||
    championPointers.isFetching
  )
  const modelPoolHydrated = Boolean(
    data &&
    modelUpgradeStatus.data &&
    artifactSelection.data &&
    artifactPromotionQueue.data &&
    championPointers.data,
  )
  const refreshModelPoolSnapshot = useCallback(() => {
    void Promise.allSettled([
      refetch(),
      modelUpgradeStatus.refetch(),
      artifactSelection.refetch(),
      artifactPromotionQueue.refetch(),
      championPointers.refetch(),
    ])
  }, [artifactPromotionQueue, artifactSelection, championPointers, modelUpgradeStatus, refetch])

  useEffect(() => {
    if (!modelPoolHydrated || modelPoolFetching) return
    setModelPoolSnapshot({
      lineage: data!,
      selection: artifactSelection.data!,
      promotionQueue: artifactPromotionQueue.data!,
      pointers: championPointers.data!,
      statusRows: modelUpgradeStatus.data!.candidates ?? [],
      capturedAt: Date.now(),
    })
  }, [
    artifactPromotionQueue.data,
    artifactSelection.data,
    championPointers.data,
    data,
    modelPoolFetching,
    modelPoolHydrated,
    modelUpgradeStatus.data,
  ])

  useEffect(() => {
    const timer = window.setInterval(refreshModelPoolSnapshot, 60_000)
    return () => window.clearInterval(timer)
  }, [refreshModelPoolSnapshot])

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

  const models = modelPoolSnapshot?.lineage.models ?? {}
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
      note: 'Lineage entry rendered as state-space overlay; excluded from alpha model IC counts.',
    }])
  const overlayList: OverlayEntry[] = [
    ...Object.entries(modelPoolSnapshot?.lineage.state_overlays ?? {}),
    ...legacyOverlayList,
  ]
  const modelPoolSnapshotReady = Boolean(modelPoolSnapshot)
  const modelPoolError = (
    error ||
    modelUpgradeStatus.error ||
    artifactSelection.error ||
    artifactPromotionQueue.error ||
    championPointers.error
  ) as Error | null
  const modelPoolInitialLoading = !modelPoolSnapshotReady && !modelPoolError && (isLoading || modelPoolFetching || !modelPoolHydrated)

  return (
    <AppShell>
      <div className="space-y-6 p-4 lg:p-6">
        <WorkstationPageTitle
          kicker="Model registry"
          title="Model Pool"
          description="Registry, lineage, L2 TimesFM sidecar、L3 active-8 ML evidence, adaptive replay, promotion queue, and champion pointer governance. L1 strategy diversity stays in Strategy Lab; single-run tracing stays in Pipeline Trace."
          action={
            <div className="flex flex-wrap items-center gap-2">
              {modelPoolSnapshotReady && modelPoolFetching && <WorkstationPill tone="info">refreshing snapshot</WorkstationPill>}
              <Button
                size="sm"
                variant="outline"
                className="rounded-full border-[#d6a85f]/30 text-[#f1c16f]"
                onClick={refreshModelPoolSnapshot}
              >
                <RefreshCw className="mr-1 h-3 w-3" /> Refresh
              </Button>
            </div>
          }
        />

        {modelPoolInitialLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading complete model-pool evidence snapshot...
          </div>
        )}

        {modelPoolError && !modelPoolSnapshotReady && (
          <div className="border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{modelPoolError.message}</div>
        )}

        {modelPoolSnapshotReady && (
          <>
            <ModelPoolNewFlowWorkbench
              models={modelList}
              selection={modelPoolSnapshot!.selection}
              pointers={modelPoolSnapshot!.pointers}
              promotionQueue={modelPoolSnapshot!.promotionQueue}
              statusRows={modelPoolSnapshot!.statusRows}
              modelUpgradeStatusReady
              promotionResult={promotionController.data}
              finalComparePending={promotionController.isPending}
              onDryRunFinalCompare={(artifactId) => promotionController.mutate({ artifactId, approved: false, confirm: false })}
            />

            <PromotionQueuePanelV2
              queue={modelPoolSnapshot!.promotionQueue}
              isPromoting={promotionController.isPending}
              promotionResult={promotionController.data}
              onPromote={(artifactId, approved, confirm) => promotionController.mutate({ artifactId, approved, confirm })}
            />

            <WorkstationPanel title="State-space Overlays" kicker="regime risk overlay, not alpha vote model">
              <div className="space-y-2 p-3 text-xs text-muted-foreground">
                <p>
                  Kalman and Markov provide regime, noise, and risk overlay context for L4
                  allocation and sizing. They are not L3 alpha models and do not enter the
                  alpha IC promotion gate.
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
                      <div className="mt-2 break-all font-mono text-[11px]">{overlay.gcs_path ?? 'default hyperparams'}</div>
                      {overlay.note && <div className="mt-2 text-[11px]">{overlay.note}</div>}
                    </div>
                  ))}
                  {!overlayList.length && (
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">No state-space overlay registered.</div>
                  )}
                </div>
              </div>
            </WorkstationPanel>
          </>
        )}
      </div>
    </AppShell>
  )
}
