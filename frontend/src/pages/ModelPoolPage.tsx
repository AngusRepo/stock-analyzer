import { useCallback, useEffect, useRef, useState } from 'react'
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
import {
  ApprovalReviewPanel,
  type ApprovalReviewGate,
  type ApprovalReviewImpact,
  type ApprovalReviewMetric,
} from '@/components/workstation/ApprovalReviewPanel'
import { Button } from '@/components/ui/button'
import {
  modelPoolApi,
  type ModelArtifactCompare,
  strategyLabApi,
  type ModelArtifactPromotionControllerResponse,
  type ModelArtifactPromotionQueueResponse,
  type ModelPoolWorkbenchEvidenceResponse,
  type ModelPoolWorkbenchSummaryResponse,
  type ModelPoolLineageModel,
  type ModelPoolStateOverlay,
} from '@/lib/api'
import {
  MODEL_POOL_RETIRED_MODEL_IDS,
} from '@/lib/modelUpgradeTrack'

const RETIRED_MODEL_NAMES = new Set<string>(MODEL_POOL_RETIRED_MODEL_IDS)

type OverlayEntry = [string, ModelPoolStateOverlay]

const MODEL_POOL_SUMMARY_KEY = ['model-pool', 'workbench', 'summary'] as const

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

function humanizeGovernanceToken(value: string | null | undefined): string {
  const text = String(value ?? '').trim()
  return text ? text.replace(/[_-]+/g, ' ') : 'pending'
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
        <span className="sv-num text-[#fff1cf]">{result.artifact_id ?? 'artifact N/A'}</span>
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
    <WorkstationPanel title="Promotion Decisions / Promotion & Parameter Governance" kicker="reason, candidate vs champion, gates, decision source, rollback target">
      <div className="grid gap-3 p-3 md:grid-cols-4">
        <SignalInsightCard title="Auto candidates" value={String(autoCount)} detail="canonical OOF release passed its evidence gates and final compare" tone={autoCount ? 'ok' : 'neutral'} />
        <SignalInsightCard title="Approval required" value={String(approvalCount)} detail="weekly/manual changes still require Wei approval" tone={approvalCount ? 'warn' : 'neutral'} />
        <SignalInsightCard title="Historical ignored" value={String(suppressedCount)} detail="noncanonical legacy rows stay immutable audit-only and never enter selection" tone={suppressedCount ? 'info' : 'neutral'} />
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
          const compare = row.artifact_compare
          const context = row.action_context
          const offlineStatus = String(row.offline_gate_decision ?? '').toLowerCase()
          const liveStatus = String(row.live_gate_status ?? '').toLowerCase()
          const finalCompareReady = Boolean(row.final_compared_to)
          const approvalTone: WorkstationTone = isBlocked ? 'error' : row.approval_required ? 'warn' : row.promotion_decision === 'auto_promote_candidate' ? 'ok' : 'info'
          const isAutoPromotion = !row.approval_required && row.promotion_decision === 'auto_promote_candidate'
          const gateSummary = `${row.offline_gate_decision ?? 'offline missing'} / ${row.live_gate_status ?? 'live missing'} / ${finalCompareReady ? 'compare linked' : 'compare missing'}`
          const promotionReason = isBlocked
            ? `Blocked：${blockers.map((item) => item.label ?? item.code).join('、') || row.next_action}`
            : isAutoPromotion
              ? `Auto promotion：offline、live 與 final champion compare 已形成可稽核證據；controller 不需要人工點擊。`
              : row.approval_required
                ? 'Manual approval：證據可 review，但此 candidate type 仍在 Wei approval boundary。'
                : `Controller decision：${humanizeGovernanceToken(row.promotion_decision)}。`
          const reviewMetrics: ApprovalReviewMetric[] = [
            {
              label: 'OOS IC',
              candidate: governanceMetric(compare?.candidate_oos_ic),
              champion: governanceMetric(compare?.champion_oos_ic),
              delta: signedGovernanceMetric(compare?.oos_ic_delta),
              detail: compare?.metric_status ?? 'candidate minus current champion',
              tone: artifactCompareTone(compare),
            },
            {
              label: 'Offline / live gate',
              value: `${row.offline_gate_decision ?? '-'} / ${row.live_gate_status ?? '-'}`,
              detail: 'offline gate 與 live gate 必須同時可解釋；缺任一邊不應直接 promote。',
              tone: offlineStatus.includes('pass') && (liveStatus.includes('pass') || liveStatus.includes('ok')) ? 'ok' : 'warn',
            },
            {
              label: 'Final compare',
              value: row.final_compared_to ?? 'pending',
              detail: 'promotion 前必須知道候選 artifact 是跟哪個 current champion 比。',
              tone: finalCompareReady ? 'ok' : 'warn',
            },
            {
              label: 'Candidate type',
              value: row.candidate_type,
              detail: `state ${row.state}`,
              tone: row.approval_required ? 'warn' : 'info',
            },
          ]
          const reviewGates: ApprovalReviewGate[] = [
            {
              label: 'Offline evidence',
              status: offlineStatus.includes('pass') || offlineStatus.includes('allow') ? 'pass' : offlineStatus ? 'warn' : 'missing',
              detail: row.offline_gate_decision ?? 'offline gate missing',
            },
            {
              label: 'Live evidence',
              status: liveStatus.includes('pass') || liveStatus.includes('ok') ? 'pass' : liveStatus ? 'warn' : 'missing',
              detail: row.live_gate_status ?? 'live gate missing',
            },
            {
              label: 'Candidate vs champion compare',
              status: finalCompareReady ? 'pass' : 'missing',
              detail: row.final_compared_to ?? 'final compare not linked to champion pointer',
            },
            {
              label: 'Approval boundary',
              status: row.approval_required ? 'warn' : 'pass',
              detail: row.approval_required ? '此列需要 Wei approval 才能 promote pointer。' : '此列可走 auto promote，但仍需 final compare 可讀。',
            },
            ...blockers.slice(0, 4).map((blocker) => ({
              label: blocker.label ?? blocker.code,
              status: 'fail' as const,
              detail: blocker.next_action,
            })),
          ]
          const reviewImpacts: ApprovalReviewImpact[] = [
            {
              label: 'Decision source',
              value: isAutoPromotion ? 'AUTO / promotion controller' : row.approval_required ? 'WEI APPROVAL' : humanizeGovernanceToken(row.promotion_decision),
              detail: isAutoPromotion ? '自動決策；UI 只提供稽核，不提供手動 auto-promote。' : 'manual governance boundary',
              tone: isAutoPromotion ? 'ok' : 'warn',
            },
            {
              label: 'Candidate artifact',
              value: row.candidate_version ?? row.artifact_id ?? 'candidate N/A',
              detail: row.artifact_id ?? 'artifact id not exposed',
              tone: row.artifact_id ? 'ok' : 'warn',
            },
            {
              label: 'Rollback target',
              value: row.current_champion_version ?? 'not exposed',
              detail: row.final_compared_to ? `final compared to ${row.final_compared_to}` : 'final compare target missing',
              tone: row.current_champion_version ? 'info' : 'warn',
            },
            {
              label: 'Decision time',
              value: 'API not exposed',
              detail: 'queue contract 尚未提供 decided_at；不可用 local refresh time 代替。',
              tone: 'warn',
            },
            {
              label: 'Downstream',
              value: context?.affected_downstream?.join(' / ') || 'L3 model serving',
              detail: context?.impact ?? 'promotion changes production model artifact pointer only after controller approval.',
              tone: row.approval_required ? 'warn' : 'info',
            },
          ]
          return (
            <ApprovalReviewPanel
              key={row.artifact_id ?? `${row.model_name}-${row.candidate_version}`}
              title={`${row.model_name} artifact promotion`}
              kicker="model artifact / champion pointer audit"
              status={row.promotion_decision}
              statusTone={approvalTone}
              candidate={
                <>
                  <div>{row.candidate_version ?? 'candidate N/A'}</div>
                  <div>{row.artifact_id ?? 'artifact N/A'}</div>
                  <div>{row.candidate_type} / {row.state}</div>
                </>
              }
              champion={
                <>
                  <div>{row.current_champion_version ?? 'champion N/A'}</div>
                  <div>baseline {row.evaluation_baseline_version ?? 'N/A'}</div>
                  <div>final compared to {row.final_compared_to ?? 'pending'}</div>
                </>
              }
              summary={
                <span>
                  <span className="font-semibold text-[#f1c16f]">Promotion reason：</span>{promotionReason}
                  <span className="mt-1 block text-[#7f8da3]">gate evidence: {gateSummary}</span>
                </span>
              }
              metrics={reviewMetrics}
              gates={reviewGates}
              impacts={reviewImpacts}
              blockers={blockers.map((blocker) => `${blocker.label ?? blocker.code}: ${blocker.next_action}`)}
              nextAction={context?.next_action ?? row.next_action}
              actions={
                <>
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
                    <div className="rounded-full border border-emerald-400/25 bg-emerald-400/[0.08] px-3 py-1.5 text-xs font-semibold text-emerald-200">
                      Auto promotion由 controller 執行 · UI audit only
                    </div>
                  )}
                </>
              }
            />
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
            <p className="sv-num text-[11px] normal-case text-[#90a0b8]">Superseded / suppressed versions</p>
            <WorkstationPill tone="info">{suppressedRows.length} superseded</WorkstationPill>
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {suppressedRows.slice(0, 8).map((row) => (
              <div key={row.artifact_id ?? `${row.model_name}-${row.candidate_version}`} className="rounded-lg border border-[#263247] bg-[#070a10] p-2 text-[11px] leading-5 text-[#9aa7bd]">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="sv-num text-slate-100">{row.model_name} {row.candidate_version ?? ''}</p>
                    <p>{humanizeGovernanceToken(row.reason)}</p>
                  </div>
                  <span className="sv-num text-[#70809b]">{row.candidate_type}</span>
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
  // Two halves of ONE verified controller observation: the summary (lineage, V5 bundle/pointer
  // readiness, overview) paints first; the evidence half (selection + promotion queue) is read by
  // the summary's snapshot id, so both always describe the same observation.
  const summaryQuery = useQuery<ModelPoolWorkbenchSummaryResponse>({
    queryKey: MODEL_POOL_SUMMARY_KEY,
    queryFn: () => modelPoolApi.workbenchSummary(false),
    retry: false,
    staleTime: 60_000,
    refetchOnMount: 'always',
  })
  const summary = summaryQuery.data
  const snapshotId = summary?.snapshot?.id ?? null
  // The evidence half sometimes comes inline: a degraded observation (not stored, so not readable
  // by id) and a pre-split Worker (rollback) that answers with the full payload.
  const inlineEvidence = summary && ('selection' in summary || 'promotion_queue' in summary)
    ? { status: summary.status, selection: summary.selection ?? undefined, promotion_queue: summary.promotion_queue ?? undefined }
    : undefined
  const evidenceQuery = useQuery<ModelPoolWorkbenchEvidenceResponse>({
    queryKey: ['model-pool', 'workbench', 'evidence', snapshotId],
    queryFn: () => modelPoolApi.workbenchEvidence(snapshotId!),
    enabled: Boolean(snapshotId) && !inlineEvidence,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const modelUpgradeStatus = useQuery({
    queryKey: ['strategy-lab', 'model-upgrade-status'],
    queryFn: strategyLabApi.modelUpgradeStatus,
    retry: false,
    staleTime: 60_000,
    refetchOnMount: 'always',
  })
  const [refreshesInFlight, setRefreshesInFlight] = useState(0)
  const refreshing = refreshesInFlight > 0
  const [refreshError, setRefreshError] = useState<Error | null>(null)
  const revalidatedSnapshot = useRef<string | null>(null)
  // Only the most recently issued refresh may replace the summary: a background revalidate that
  // started before a promotion can answer after the post-promotion fresh read.
  const refreshGeneration = useRef(0)

  // A new observation costs the controller ~50 s; the cached one stays on screen meanwhile. The
  // request stays open until the observation lands: the Worker runs it inside this request, so
  // it is not cut off by the post-response waitUntil limit.
  const replaceSummary = useCallback(async (load: () => Promise<ModelPoolWorkbenchSummaryResponse>) => {
    const generation = ++refreshGeneration.current
    setRefreshesInFlight((count) => count + 1)
    setRefreshError(null)
    try {
      const next = await load()
      if (generation === refreshGeneration.current) queryClient.setQueryData(MODEL_POOL_SUMMARY_KEY, next)
    } catch (error) {
      if (generation === refreshGeneration.current) setRefreshError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      setRefreshesInFlight((count) => Math.max(0, count - 1))
    }
  }, [queryClient])

  // Refresh button and after a promotion: a new observation started after the click.
  const refreshModelPoolSnapshot = useCallback(async () => {
    await replaceSummary(async () => {
      const [fresh] = await Promise.all([
        modelPoolApi.workbenchSummary(true),
        modelUpgradeStatus.refetch(),
      ])
      return fresh
    })
  }, [modelUpgradeStatus, replaceSummary])

  // An old cached snapshot is shown immediately and replaced once, in the background.
  useEffect(() => {
    if (!summary?.snapshot?.stale || !snapshotId || revalidatedSnapshot.current === snapshotId) return
    revalidatedSnapshot.current = snapshotId
    void replaceSummary(() => modelPoolApi.workbenchRevalidate(snapshotId))
  }, [replaceSummary, snapshotId, summary?.snapshot?.stale])

  // The evidence half outlived its snapshot (replaced or expired): re-read the summary once per
  // snapshot id. A new id changes the evidence key; the same id again surfaces as an error.
  const evidenceExpired = String((evidenceQuery.error as Error | null)?.message ?? '').includes('model_pool_snapshot_expired')
  const expiredSnapshot = useRef<string | null>(null)
  const refetchSummary = summaryQuery.refetch
  useEffect(() => {
    if (!evidenceExpired || !snapshotId || expiredSnapshot.current === snapshotId) return
    expiredSnapshot.current = snapshotId
    void refetchSummary()
  }, [evidenceExpired, refetchSummary, snapshotId])

  const data = summary?.lineage
  const evidence = inlineEvidence ?? (evidenceQuery.data?.snapshot?.id === snapshotId ? evidenceQuery.data : undefined)
  const overview = { data: summary?.overview ?? undefined, error: summaryQuery.error, isFetching: summaryQuery.isFetching }
  const promotionController = useMutation({
    mutationFn: ({ artifactId, approved, confirm }: { artifactId: string; approved: boolean; confirm: boolean }) => modelPoolApi.promotionController({
      artifact_id: artifactId,
      confirm,
      approved,
      approved_by: approved ? 'Wei' : undefined,
      reason: approved ? 'wei_approval_from_model_pool_ui' : confirm ? 'auto_promotion_from_model_pool_ui' : 'dry_run_from_model_pool_ui',
    }),
    onSuccess: async () => {
      await refreshModelPoolSnapshot()
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
      note: 'Lineage entry rendered as state-space overlay; excluded from alpha model IC counts.',
    }])
  const overlayList: OverlayEntry[] = [
    ...Object.entries(data?.state_overlays ?? {}),
    ...legacyOverlayList,
  ]
  const modelPoolSnapshotReady = Boolean(summary?.lineage && summary?.champion_pointers)
  const modelPoolError = (summaryQuery.error ?? null) as Error | null
  const evidenceRecovering = evidenceExpired && (expiredSnapshot.current !== snapshotId || summaryQuery.isFetching)
  const evidenceError = !evidenceRecovering ? (evidenceQuery.error as Error | null) : null
  const evidencePending = modelPoolSnapshotReady && !evidence && !evidenceError
  const modelPoolInitialLoading = !modelPoolSnapshotReady && !modelPoolError
  const capturedAt = summary?.snapshot?.captured_at ? Date.parse(summary.snapshot.captured_at) : undefined

  return (
    <AppShell>
      <div className="space-y-6 p-4 lg:p-6">
        <WorkstationPageTitle
          kicker="Model registry"
          title="Model Pool"
          description="正式 ensemble、八模型角色、證據成熟度與下一個 cohort。模型選擇與服務狀態分開呈現。"
          action={
            <div className="flex flex-wrap items-center gap-2">
              {modelPoolSnapshotReady && refreshing && <WorkstationPill tone="info">refreshing snapshot</WorkstationPill>}
              {summary?.snapshot?.degraded && <span title="controller overview 讀取失敗；這份觀測只顯示給你，不會快取"><WorkstationPill tone="warn">overview 缺</WorkstationPill></span>}
              <Button
                size="sm"
                variant="outline"
                className="rounded-full border-[#d6a85f]/30 text-[#f1c16f]"
                onClick={refreshModelPoolSnapshot}
                disabled={refreshing}
              >
                <RefreshCw className="mr-1 h-3 w-3" /> Refresh
              </Button>
            </div>
          }
        />

        {modelPoolInitialLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading model-pool summary...
          </div>
        )}

        {(modelPoolError || refreshError) && (
          <div className="border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300" role="status">{modelPoolSnapshotReady ? '更新失敗，保留上次成功快照：' : '讀取失敗：'}{(refreshError ?? modelPoolError)!.message}</div>
        )}
        {evidenceError && (
          <div className="border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300" role="status">模型證據讀取失敗：{evidenceError.message}</div>
        )}

        {modelPoolSnapshotReady && (
          <>
            <ModelPoolNewFlowWorkbench
              models={modelList}
              overview={overview.error ? undefined : overview.data}
              overviewLoading={overview.isFetching}
              capturedAt={capturedAt}
              stale={Boolean(refreshError || modelPoolError)}
              selection={evidence?.selection}
              pointers={summary!.champion_pointers}
              promotionQueue={evidence?.promotion_queue}
              evidencePending={evidencePending}
              statusRows={modelUpgradeStatus.data?.candidates ?? []}
              modelUpgradeStatusReady={Boolean(modelUpgradeStatus.data)}
              promotionResult={promotionController.data}
              finalComparePending={promotionController.isPending}
              onDryRunFinalCompare={(artifactId) => promotionController.mutate({ artifactId, approved: false, confirm: false })}
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
                      <div className="mt-2 break-all sv-num text-[11px]">{overlay.gcs_path ?? 'default hyperparams'}</div>
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
