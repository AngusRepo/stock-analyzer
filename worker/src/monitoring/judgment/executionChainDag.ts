// Copied from frontend/src/components/observability/ExecutionChainPanel.tsx (P3 of the Grafana migration):
// the DAG topology, stage catalog and status classification, without React or icons. The frontend copy
// stays until the OBS retirement phase; buildScopedJobMap/currentStage/scopeProgress are the panel's
// useMemo/derived-state bodies as pure functions.
import type { SchedulerJob } from './schedulerJob'
import { buildAttemptAwareJobMap } from './executionChainAttemptState'
import { dailyPhaseForStage, PREMARKET_READINESS_IDS } from './dailyReadinessPhases'
import { eveningClosureDisplay } from './eveningClosureDisplay'
import { FINLAB_STAGE_CARDS, expandFinlabStages, finlabStageCards } from './finlabStageCards'
import { isMissedWatchdog } from './missedWatchdog'
import { PIPELINE_STAGE_CARDS, expandPipelineStages, pipelineStageCards } from './pipelineStageCards'
import { postcloseDispatchLabel, withPostcloseDispatchWait } from './postcloseDispatchWait'

/** frontend/src/lib/schedulerDisplay.ts */
export function attentionSkipReason(job?: Pick<SchedulerJob, 'lastStatus' | 'attentionReason'>): string | null {
  return job?.lastStatus === 'skip' ? job.attentionReason ?? null : null
}

export type VisualStatus = 'completed' | 'noop' | 'running' | 'waiting' | 'blocked' | 'out_of_window' | 'not_started' | 'skipped' | 'stale' | 'attention'

export type StageDefinition = {
  id: string
  label: string
  optional?: boolean
  dependsOn?: string
}

export type ChainBranch = {
  id: string
  label: string
  description: string
  anchorId: string
  relation: 'evidence' | 'shared_context'
  columns: string[][]
}

export type ChainScope = {
  id: 'daily_readiness' | 'intraday' | 'weekly' | 'monthly'
  label: string
  title: string
  description: string
  relation: 'event' | 'mixed'
  columns: string[][]
  orchestratorId?: string
  branches?: ChainBranch[]
}

export const STAGES: Record<string, StageDefinition> = {
  ...Object.fromEntries(FINLAB_STAGE_CARDS.map(card => [card.id, { id: card.id, label: card.label }])),
  'market-close-refresh': { id: 'market-close-refresh', label: 'Close refresh' },
  'evening-chain': { id: 'evening-chain', label: 'Evening root' },
  'finlab-v4-backfill': { id: 'finlab-v4-backfill', label: 'FinLab canonical' },
  'finlab-backfill-watchdog': { id: 'finlab-backfill-watchdog', label: 'FinLab watchdog', optional: true },
  update: { id: 'update', label: 'Market update' },
  'indicator-queue': { id: 'indicator-queue', label: 'Indicator queue' },
  screener: { id: 'screener', label: 'Screener' },
  'regime-compute': { id: 'regime-compute', label: 'HMM regime' },
  'allocator-ev-readiness': { id: 'allocator-ev-readiness', label: 'Allocator EV' },
  'strategy-learning-mature-evidence': { id: 'strategy-learning-mature-evidence', label: '成熟策略證據' },
  ...Object.fromEntries(PIPELINE_STAGE_CARDS.map(card => [card.id, { id: card.id, label: card.label }])),
  pipeline: { id: 'pipeline', label: 'Pipeline · 整體進度' },
  'ml-predict': { id: 'ml-predict', label: 'ML Predict · L3 預測' },
  recommendation: { id: 'recommendation', label: 'Recommendation · L4 推薦' },
  'post-pipeline-chain': { id: 'post-pipeline-chain', label: 'Pipeline callback' },
  'dataset-snapshot-export': { id: 'dataset-snapshot-export', label: 'Research snapshot' },
  'allocator-ev-feature-snapshot-backfill': { id: 'allocator-ev-feature-snapshot-backfill', label: 'EV feature snapshot' },
  'verify-v2': { id: 'verify-v2', label: 'Verify' },
  'post-verify-chain': { id: 'post-verify-chain', label: 'Verify callback' },
  'allocator-ev-lifecycle-watchdog': { id: 'allocator-ev-lifecycle-watchdog', label: 'EV lifecycle', optional: true },
  'model-ic-rolling': { id: 'model-ic-rolling', label: 'Model IC rolling' },
  'linucb-reward-ledger': { id: 'linucb-reward-ledger', label: 'Reward ledger' },
  adapt: { id: 'adapt', label: 'Adapt params' },
  'daily-report': { id: 'daily-report', label: 'Daily report' },
  'paper-active-postmarket': { id: 'paper-active-postmarket', label: 'Paper active', optional: true },
  'obsidian-sync': { id: 'obsidian-sync', label: 'Obsidian sync', optional: true },
  'meta-learning-shadow': { id: 'meta-learning-shadow', label: 'Meta shadow', optional: true },
  'strategy-learning': { id: 'strategy-learning', label: 'Strategy learning', optional: true },
  'evening-closure': { id: 'evening-closure', label: '全鏈完成收據', dependsOn: 'strategy-learning' },
  'morning-setup': { id: 'morning-setup', label: 'Morning setup' },
  'pre-market-warmup': { id: 'pre-market-warmup', label: 'Pre-market' },
  'intraday-check': { id: 'intraday-check', label: 'Intraday check' },
  'rescore-10': { id: 'rescore-10', label: '10:00 re-score' },
  'rescore-11': { id: 'rescore-11', label: '11:00 re-score' },
  'rescore-12': { id: 'rescore-12', label: '12:00 re-score' },
  'rescore-1230': { id: 'rescore-1230', label: '12:30 re-score' },
  'eod-exit': { id: 'eod-exit', label: 'EOD exit' },
  'post-close-price-refresh': { id: 'post-close-price-refresh', label: 'Close price' },
  'daily-snapshot': { id: 'daily-snapshot', label: 'Daily snapshot' },
  'us-leading': { id: 'us-leading', label: 'US leading' },
  'news-analyst': { id: 'news-analyst', label: 'News analyst' },
  'premarket-evidence-watchdog': { id: 'premarket-evidence-watchdog', label: '盤前鏈監看', optional: true },
  'external-evidence': { id: 'external-evidence', label: 'External evidence' },
  'artifact-reconcile': { id: 'artifact-reconcile', label: 'Artifact reconcile' },
  'legacy-hot-data-retirement': { id: 'legacy-hot-data-retirement', label: 'Hot-data retire', optional: true },
  'legacy-evidence-migration': { id: 'legacy-evidence-migration', label: 'Evidence migrate', optional: true },
  'legacy-strategy-evidence-migration': { id: 'legacy-strategy-evidence-migration', label: 'Strategy migrate', optional: true },
  'd1-evidence-scrub': { id: 'd1-evidence-scrub', label: 'D1 scrub', optional: true },
  'r2-retention-sweep': { id: 'r2-retention-sweep', label: 'R2 retention', optional: true },
  'orphan-reachability-gc': { id: 'orphan-reachability-gc', label: 'Reachability GC', optional: true },
  'cleanup-dlq-replay': { id: 'cleanup-dlq-replay', label: 'DLQ replay', optional: true },
  'storage-health-check': { id: 'storage-health-check', label: 'Storage health' },
  'weekly-backtest': { id: 'weekly-backtest', label: 'Validation / MC' },
  'alpha-quality': { id: 'alpha-quality', label: 'Alpha quality' },
  'weekly-audit': { id: 'weekly-audit', label: 'Weekly audit' },
  'weekly-readiness': { id: 'weekly-readiness', label: 'Weekly root' },
  'storage-integrity-audit': { id: 'storage-integrity-audit', label: 'Storage integrity' },
  'model-ic-full-check': { id: 'model-ic-full-check', label: 'Model IC full' },
  'weekly-cleanup': { id: 'weekly-cleanup', label: 'Weekly cleanup' },
  'weekly-optuna': { id: 'weekly-optuna', label: 'Drift research', optional: true },
  'adaptive-meta-policy-replay': { id: 'adaptive-meta-policy-replay', label: 'Meta replay', optional: true },
  's12-smcvwap-calibration': { id: 's12-smcvwap-calibration', label: 'S12 calibration', optional: true },
  'linucb-multiplier-replay': { id: 'linucb-multiplier-replay', label: 'LinUCB replay', optional: true },
  'active8-oof-daily': { id: 'active8-oof-daily', label: 'Active-8 daily evidence' },
  'active8-oof-weekly': { id: 'active8-oof-weekly', label: 'Active-8 weekly cohort / validation-release' },
  'sector-leaders': { id: 'sector-leaders', label: 'Sector leaders', optional: true },
  'monthly-strategy-mining': { id: 'monthly-strategy-mining', label: 'Strategy mining' },
  'monthly-readiness': { id: 'monthly-readiness', label: 'Monthly root' },
  'monthly-optuna': { id: 'monthly-optuna', label: 'Monthly search' },
  'active8-oof-monthly': { id: 'active8-oof-monthly', label: 'Active-8 monthly release / validation' },
}

export const SCOPES: ChainScope[] = [
  {
    id: 'daily_readiness',
    label: 'Daily readiness',
    title: 'Daily readiness execution chain',
    description: '晚間資料、模型驗證與次日盤前準備分段查看；狀態與日期以各階段執行收據為準。',
    relation: 'event',
    orchestratorId: 'evening-chain',
    columns: [
      ['market-close-refresh'],
      ['finlab-v4-backfill', 'finlab-backfill-watchdog'],
      ['update'],
      ['indicator-queue'],
      ['regime-compute'],
      ['strategy-learning-mature-evidence'],
      ['screener'],
      ['allocator-ev-readiness'],
      ['pipeline'],
      ['ml-predict'],
      ['post-pipeline-chain'],
      ['allocator-ev-feature-snapshot-backfill'],
      ['verify-v2'],
      ['post-verify-chain'],
      ['model-ic-rolling'],
      ['linucb-reward-ledger'],
      ['adapt'],
      ['daily-report'],
      ['paper-active-postmarket'],
      ['obsidian-sync'],
      ['meta-learning-shadow', 'strategy-learning'],
      ['evening-closure'],
      ['us-leading', 'news-analyst'],
      ['morning-setup'],
      ['recommendation'],
      ['pre-market-warmup'],
    ],
    branches: [
      {
        id: 'premarket-chain-watchdog',
        label: '盤前鏈監看',
        description: '定期檢查盤前事件鏈並恢復未完成階段；等待下游期間不代表持續運算。',
        anchorId: 'news-analyst',
        relation: 'shared_context',
        columns: [['premarket-evidence-watchdog']],
      },
      {
        id: 'post-close-evidence-extension',
        label: 'Post-close evidence extension',
        description: 'Detached compute snapshot 完成後，以 durable ticket 事件接續 Active-8 daily evidence；不等待固定 watchdog，也不執行 retrain。',
        anchorId: 'post-pipeline-chain',
        relation: 'evidence',
        columns: [
          ['dataset-snapshot-export'],
          ['active8-oof-daily'],
        ],
      },
      {
        id: 'allocator-ev-lifecycle-recovery',
        label: 'Allocator EV lifecycle recovery',
        description: '獨立每 10 分鐘檢查 replay maturity 與 lineage；不是 Verify callback 的下游，也不代表主鏈可越過 blocker。',
        anchorId: 'allocator-ev-readiness',
        relation: 'shared_context',
        columns: [
          ['allocator-ev-lifecycle-watchdog'],
        ],
      },
    ],
  },
  {
    id: 'intraday',
    label: 'Intraday guard',
    title: 'Intraday execution & account chain',
    description: '盤中執行、持倉保護與收盤帳務。US、新聞及盤前定案請查看 Daily readiness。',
    relation: 'mixed',
    columns: [
      ['intraday-check'],
      ['eod-exit'],
      ['post-close-price-refresh'],
      ['daily-snapshot'],
    ],
    branches: [
      {
        id: 'intraday-rescore-spots',
        label: 'Intraday Re-score branch',
        description: '10:00 / 11:00 / 12:00 / 12:30；與 heartbeat 共用持倉與 broker quotes，但由獨立排程觸發。',
        anchorId: 'intraday-check',
        relation: 'shared_context',
        columns: [
          ['rescore-10'],
          ['rescore-11'],
          ['rescore-12'],
          ['rescore-1230'],
        ],
      },
    ],
  },
  {
    id: 'weekly',
    label: 'Weekly research',
    title: 'Weekly validation & research chain',
    description: 'Point-in-time validation, adaptive research, calibration, and approval-gated retrain evidence.',
    orchestratorId: 'weekly-readiness',
    relation: 'mixed',
    columns: [
      ['weekly-audit', 'storage-integrity-audit', 'model-ic-full-check'],
      ['weekly-backtest', 'alpha-quality', 'active8-oof-weekly'],
      ['weekly-optuna', 'sector-leaders'],
      ['adaptive-meta-policy-replay', 's12-smcvwap-calibration', 'linucb-multiplier-replay'],
      ['weekly-cleanup'],
    ],
  },
  {
    id: 'monthly',
    label: 'Monthly artifact',
    title: 'Monthly artifact chain',
    orchestratorId: 'monthly-readiness',
    description: '策略挖掘、搜尋與 Active-8 月度 full-fit／ensemble validation；weekly 與 monthly 都可在整合 bundle 通過時 promotion。',
    relation: 'mixed',
    columns: [
      ['monthly-strategy-mining'],
      ['monthly-optuna'],
      ['active8-oof-monthly'],
    ],
  },
]

export function scopeExecutionStageIds(scope: ChainScope): string[] {
  return [
    ...scope.columns.flat(),
    ...(scope.branches ?? []).flatMap((branch) => branch.columns.flat()),
  ]
}

export function scopeStageIds(scope: ChainScope): string[] {
  return [
    ...(scope.orchestratorId ? [scope.orchestratorId] : []),
    ...scopeExecutionStageIds(scope),
  ]
}

export const MAPPED_JOB_IDS = new Set(SCOPES.flatMap(scopeStageIds))

export function duplicateScopeJobIds(scopes: ChainScope[]): string[] {
  const owners = new Map<string, string[]>()
  for (const scope of scopes) {
    for (const jobId of scopeStageIds(scope)) {
      owners.set(jobId, [...(owners.get(jobId) ?? []), scope.id])
    }
  }
  return [...owners.entries()]
    .filter(([, scopeIds]) => new Set(scopeIds).size > 1)
    .map(([jobId]) => jobId)
    .sort()
}

const DUPLICATE_SCOPE_JOB_IDS = duplicateScopeJobIds(SCOPES)
if (DUPLICATE_SCOPE_JOB_IDS.length > 0) {
  throw new Error(`scheduler DAG jobs assigned to multiple cadence scopes: ${DUPLICATE_SCOPE_JOB_IDS.join(',')}`)
}

export const STATUS_LABEL: Record<VisualStatus, string> = {
  stale: '待確認',
  completed: 'Completed',
  noop: 'Checked · no action',
  running: 'Running',
  waiting: 'Waiting',
  blocked: 'Blocked',
  out_of_window: 'Not in window',
  not_started: 'Not started',
  skipped: 'Skipped',
  attention: 'Skipped · 未正式執行',
}

export function isAllocatorSafeAbstention(job?: SchedulerJob): boolean {
  if (!job || job.id !== 'allocator-ev-readiness' || job.lastStatus !== 'failed') return false
  const evidence = [job.lastError, job.summary, ...(job.details ?? [])]
    .filter(Boolean)
    .join(' ')
  return /no_validated_expected_return_lane|no_eligible_owner|expected_return_serving_state=no_eligible_owner/i.test(evidence)
}

export function isExpectedEvidenceNoop(job?: SchedulerJob): boolean {
  if (!job || job.lastStatus !== 'skip') return false
  const evidence = [job.lastError, job.summary, ...(job.details ?? [])]
    .filter(Boolean)
    .join(' ')
  if (job.id === 'allocator-ev-feature-snapshot-backfill') {
    return /not applicable: Active8 evidence-only authority attested[\s\S]*actionable=0[\s\S]*production_effect=0/i.test(evidence)
  }
  if (job.id === 'verify-v2') {
    return /pending predictions do not yet have five stock-specific trading sessions[\s\S]*verified=0/i.test(evidence)
  }
  return false
}

export function visualStatus(job?: SchedulerJob): VisualStatus {
  if (!job) return 'not_started'
  if (job.stageVisualStatus) return job.stageVisualStatus
  if (job.lastStatus === 'success') return 'completed'
  // Should-have-run work: never the neutral skipped look, and never counted as done.
  if (attentionSkipReason(job)) return 'attention'
  if (isAllocatorSafeAbstention(job)) return 'noop'
  if (isExpectedEvidenceNoop(job)) return 'noop'
  if (job.id === 'intraday-check' && job.lastStatus === 'skip') return 'noop'
  if (job.lastStatus === 'running') return 'running'
  if (job.lastStatus === 'waiting') return 'waiting'
  if (job.lastStatus === 'blocked') return 'blocked'
  if (job.lastStatus === 'failed') return 'blocked'
  if (job.lastStatus === 'sleep') return 'out_of_window'
  if (job.lastStatus === 'skip') return 'skipped'
  return 'not_started'
}

export function formatReplayDate(runDate?: string | null): string {
  if (!runDate) return ''
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(runDate)
  if (!parts) return runDate
  return `${Number(parts[2])}/${Number(parts[3])}`
}

export function statusLabel(job?: SchedulerJob): string {
  if (job?.finlabPhase && job.summary.startsWith('無階段紀錄')) return '無階段紀錄'
  if (job?.lastStatus === 'blocked') return job.id === 'evening-closure' ? '全鏈中止' : '上游阻擋 · 未執行'
  const label = STATUS_LABEL[visualStatus(job)]
  if (isAllocatorSafeAbstention(job)) return 'Checked · safe abstention'
  if (isExpectedEvidenceNoop(job)) {
    return job?.id === 'verify-v2' ? 'Checked · awaiting maturity' : 'Checked · not applicable'
  }
  if (job?.recoveredFromStatus === 'failed' && job.lastStatus === 'success') {
    const replay = job.statusScope === 'historical_replay' && job.statusRunDate ? `Historical replay \u00b7 ${formatReplayDate(job.statusRunDate)} \u00b7 ` : ''
    return `${replay}Recovered`
  }
  if (job?.statusScope !== 'historical_replay' || !job.statusRunDate) return label
  return `Historical replay · ${formatReplayDate(job.statusRunDate)} · ${label}`
}

export function runtimeEvidence(job?: SchedulerJob): string {
  if (!job) return 'no runtime evidence'
  if (job.lastRun && job.lastRun !== 'N/A') {
    return `${job.lastRunBasis === 'started' ? 'Started ' : ''}${job.lastRun}`
  }
  return job.nextRun || 'no runtime evidence'
}

export function statusPriority(status: VisualStatus): number {
  if (status === 'blocked') return 0
  if (status === 'running') return 1
  if (status === 'waiting') return 2
  if (status === 'completed' || status === 'noop') return 3
  if (status === 'out_of_window') return 4
  if (status === 'not_started') return 5
  return 5
}

const ORCHESTRATOR_STAGE_HINTS: Array<[RegExp, string]> = [
  [/strategy-learning-mature-evidence|mature evidence/i, 'strategy-learning-mature-evidence'],
  [/strategy-learning/i, 'strategy-learning'],
  [/meta(?:-| )learning/i, 'meta-learning-shadow'],
  [/obsidian/i, 'obsidian-sync'],
  [/paper(?:-| )active/i, 'paper-active-postmarket'],
  [/daily report/i, 'daily-report'],
  [/adapt/i, 'adapt'],
  [/reward ledger|linucb/i, 'linucb-reward-ledger'],
  [/model ic|rolling ic/i, 'model-ic-rolling'],
  [/post(?:-| )verify/i, 'post-verify-chain'],
  [/verify/i, 'verify-v2'],
  [/snapshot callback|post(?:-| )pipeline|allocator snapshot/i, 'post-pipeline-chain'],
  [/pipeline/i, 'pipeline'],
  [/allocator ev readiness/i, 'allocator-ev-readiness'],
  [/regime/i, 'regime-compute'],
  [/screener/i, 'screener'],
  [/indicator/i, 'indicator-queue'],
  [/market data|market update|source readiness/i, 'update'],
  [/finlab/i, 'finlab-v4-backfill'],
]

export function inferOrchestratorStage(summary?: string | null): string | null {
  const normalized = String(summary ?? '').trim()
  if (!normalized) return null
  return ORCHESTRATOR_STAGE_HINTS.find(([pattern]) => pattern.test(normalized))?.[1] ?? null
}

export function connectorStatus(previousJobs: Array<SchedulerJob | undefined>, nextJobs: Array<SchedulerJob | undefined>): VisualStatus {
  const previous = previousJobs.map(visualStatus)
  const next = nextJobs.map(visualStatus)
  if (previous.includes('blocked')) return 'blocked'
  if (previous.includes('running') || next.includes('running')) return 'running'
  if (previous.includes('attention')) return 'attention'
  // Skips pass the flow on only next to real work; an all-skipped column completed nothing.
  if (previous.length > 0 && previous.every((status) => status === 'skipped')) return 'skipped'
  if (previous.length > 0 && previous.every((status) => status === 'completed' || status === 'noop' || status === 'skipped')) return 'completed'
  if (next.includes('waiting')) return 'waiting'
  return 'not_started'
}

export function stageDetails(job?: SchedulerJob): string[] {
  if (!job) return []
  const details = Array.isArray(job.details) ? job.details.filter(Boolean) : []
  return details.slice(0, 8)
}

export function statusSummary(job?: SchedulerJob): string {
  if (!job) return '正式 API 尚未回傳此 job。'
  if (isAllocatorSafeAbstention(job)) {
    return `No validated Fusion owner; BUY/allocation remains fail-closed. ${job?.summary ?? ''}`.trim()
  }
  if (job.lastError) return job.lastError
  if (job.summary) return job.summary
  if (job.lastStatus === 'running') return '已收到 start/trigger evidence，等待 final callback。'
  if (job.lastStatus === 'waiting') return '等待 upstream callback 或 readiness gate。'
  if (job.lastStatus === 'success') return 'Final callback 已完成並寫入 scheduler log。'
  if (job.lastStatus === 'sleep') return '目前不在執行窗口。'
  return '目前沒有新的 runtime evidence。'
}


export function scopeById(id: ChainScope['id']): ChainScope {
  const scope = SCOPES.find((item) => item.id === id)
  if (!scope) throw new Error(`unknown chain scope ${id}`)
  return scope
}

/** Display ids in panel order: FinLab and Pipeline parents expand into their stage cards on the daily scope. */
export function scopeDisplayStageIds(scope: ChainScope): string[] {
  return scope.id === 'daily_readiness'
    ? scopeExecutionStageIds(scope).flatMap(expandFinlabStages).flatMap(expandPipelineStages)
    : scopeExecutionStageIds(scope)
}

/** ExecutionChainPanel's scopedJobMap useMemo body. */
export function buildScopedJobMap(jobMap: Map<string, SchedulerJob>, scope: ChainScope, now = Date.now()): Map<string, SchedulerJob> {
  // Morning receipts belong to their own trade date, not the previous evening root attempt.
  const attemptScope = scope.id === 'daily_readiness'
    ? { ...scope, columns: scope.columns.filter(column => !column.some(id => PREMARKET_READINESS_IDS.has(id))) } : scope
  const attemptAware = buildAttemptAwareJobMap(jobMap, attemptScope, inferOrchestratorStage)
  const next = new Map(attemptAware)
  if (scope.id === 'daily_readiness') {
    finlabStageCards(next.get('finlab-v4-backfill'), now).forEach(job => next.set(job.id, job))
    pipelineStageCards(jobMap.get('pipeline'), now).forEach(job => next.set(job.id, job))
    const rootClosure = next.get('evening-chain')
    if (rootClosure) next.set('evening-closure', eveningClosureDisplay(rootClosure))
    const dispatchLabel = postcloseDispatchLabel(rootClosure)
    next.forEach((job, id) => {
      if (dailyPhaseForStage(id) === 'evidence') next.set(id, withPostcloseDispatchWait(job, dispatchLabel))
    })
  }
  scopeExecutionStageIds(scope).forEach((id) => {
    const definition = STAGES[id]
    const job = next.get(id)
    const upstream = definition?.dependsOn ? next.get(definition.dependsOn) : undefined
    if (!job || !upstream || job.lastStatus !== 'sleep' || !['running', 'failed', 'waiting'].includes(upstream.lastStatus)) return
    next.set(id, {
      ...job,
      lastStatus: 'waiting',
      summary: `Waiting for ${definition.dependsOn} terminal callback`,
      statusScope: upstream.statusScope,
      statusRunDate: upstream.statusRunDate,
      displayNote: 'Callback-owned downstream stage has not started because its upstream owner is not complete.',
    })
  })
  return next
}

export type ChainCue = 'Running now' | 'Blocked here' | 'Waiting next' | 'No active runtime · latest checkpoint'

/** The panel's current-stage card: blocked > running > waiting (a missed watchdog never takes it), else the latest completed. */
export function currentStage(scopedJobMap: Map<string, SchedulerJob>, scope: ChainScope): { id: string; status: VisualStatus; cue: ChainCue; label: string } {
  const stageIds = scopeDisplayStageIds(scope)
  const availableJobs = stageIds.map((id) => scopedJobMap.get(id)).filter((job): job is SchedulerJob => Boolean(job))
  const currentJob = [...availableJobs]
    .filter((job) => ['running', 'blocked', 'waiting'].includes(visualStatus(job)) && !isMissedWatchdog(job))
    .sort((a, b) => statusPriority(visualStatus(a)) - statusPriority(visualStatus(b)))[0]
    ?? [...availableJobs].reverse().find((job) => visualStatus(job) === 'completed')
    ?? availableJobs[0]
  const status = visualStatus(currentJob)
  const cue: ChainCue = status === 'running' ? 'Running now' : status === 'blocked' ? 'Blocked here'
    : status === 'waiting' ? 'Waiting next' : 'No active runtime · latest checkpoint'
  const id = currentJob?.id ?? stageIds[0]
  return { id, status, cue, label: statusLabel(currentJob) }
}

/** The panel's progress bar: the daily scope counts missing receipts as incomplete (the denominator never shrinks). */
export function scopeProgress(scopedJobMap: Map<string, SchedulerJob>, scope: ChainScope): { completed: number; total: number; pct: number } {
  const scopeJobs = scopeDisplayStageIds(scope).map((id) => scopedJobMap.get(id))
  const expectedJobs = scopeJobs.filter((job): job is SchedulerJob => Boolean(
    job && visualStatus(job) !== 'skipped' && !STAGES[job.id]?.optional,
  ))
  const progressJobs = scope.id === 'daily_readiness'
    ? scope.columns.flat().flatMap(expandFinlabStages).flatMap(expandPipelineStages).map(id => scopedJobMap.get(id))
    : expectedJobs.length > 0 ? expectedJobs : scopeJobs.filter((job): job is SchedulerJob => Boolean(job))
  const completed = progressJobs.filter((job) => ['completed', 'noop'].includes(visualStatus(job))).length
  return { completed, total: progressJobs.length, pct: progressJobs.length > 0 ? Math.round((completed / progressJobs.length) * 100) : 0 }
}
