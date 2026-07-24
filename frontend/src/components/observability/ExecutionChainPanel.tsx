import { useEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  Archive,
  BarChart3,
  BookOpenCheck,
  BrainCircuit,
  CircleGauge,
  Database,
  FileCheck2,
  GitBranch,
  Layers3,
  Link2,
  Microscope,
  MoonStar,
  Radar,
  RefreshCw,
  ScanSearch,
  Settings2,
  ShieldCheck,
  Target,
  TimerReset,
  Waypoints,
  Workflow,
  Wrench,
  Zap,
} from 'lucide-react'
import type { SchedulerJob } from '@/lib/api'
import StandaloneJobRegistry from './StandaloneJobRegistry'
import './ExecutionChainPanel.css'

type VisualStatus = 'completed' | 'noop' | 'running' | 'waiting' | 'blocked' | 'not_started' | 'skipped'

type StageDefinition = {
  id: string
  label: string
  icon: LucideIcon
  optional?: boolean
}

type ChainScope = {
  id: 'daily_readiness' | 'intraday' | 'monthly'
  label: string
  title: string
  description: string
  relation: 'event' | 'mixed'
  columns: string[][]
}

const STAGES: Record<string, StageDefinition> = {
  'market-close-refresh': { id: 'market-close-refresh', label: 'Close refresh', icon: RefreshCw },
  'evening-chain': { id: 'evening-chain', label: 'Evening root', icon: Link2 },
  'finlab-v4-backfill': { id: 'finlab-v4-backfill', label: 'FinLab canonical', icon: Database },
  'finlab-backfill-watchdog': { id: 'finlab-backfill-watchdog', label: 'FinLab watchdog', icon: Radar, optional: true },
  update: { id: 'update', label: 'Market update', icon: BarChart3 },
  'indicator-queue': { id: 'indicator-queue', label: 'Indicator queue', icon: CircleGauge },
  screener: { id: 'screener', label: 'Screener', icon: ScanSearch },
  'regime-compute': { id: 'regime-compute', label: 'HMM regime', icon: Activity },
  'allocator-ev-readiness': { id: 'allocator-ev-readiness', label: 'Allocator EV', icon: CircleGauge },
  pipeline: { id: 'pipeline', label: 'Pipeline', icon: Workflow },
  'ml-predict': { id: 'ml-predict', label: 'ML predict', icon: BrainCircuit },
  recommendation: { id: 'recommendation', label: 'Recommendation', icon: Target },
  'post-pipeline-chain': { id: 'post-pipeline-chain', label: 'Pipeline callback', icon: GitBranch },
  'verify-v2': { id: 'verify-v2', label: 'Verify', icon: ShieldCheck },
  'post-verify-chain': { id: 'post-verify-chain', label: 'Verify callback', icon: GitBranch },
  'model-ic-rolling': { id: 'model-ic-rolling', label: 'Model IC rolling', icon: Activity },
  'linucb-reward-ledger': { id: 'linucb-reward-ledger', label: 'Reward ledger', icon: BookOpenCheck },
  adapt: { id: 'adapt', label: 'Adapt params', icon: Settings2 },
  'daily-report': { id: 'daily-report', label: 'Daily report', icon: FileCheck2 },
  'paper-active-postmarket': { id: 'paper-active-postmarket', label: 'Paper active', icon: Zap, optional: true },
  'obsidian-sync': { id: 'obsidian-sync', label: 'Obsidian sync', icon: Archive, optional: true },
  'meta-learning-shadow': { id: 'meta-learning-shadow', label: 'Meta shadow', icon: MoonStar, optional: true },
  'strategy-learning': { id: 'strategy-learning', label: 'Strategy learning', icon: BrainCircuit, optional: true },
  'morning-setup': { id: 'morning-setup', label: 'Morning setup', icon: Settings2 },
  'pre-market-warmup': { id: 'pre-market-warmup', label: 'Pre-market', icon: CircleGauge },
  'intraday-check': { id: 'intraday-check', label: 'Intraday check', icon: Radar },
  'intraday-rescore': { id: 'intraday-rescore', label: 'Intraday re-score', icon: BarChart3 },
  'eod-exit': { id: 'eod-exit', label: 'EOD exit', icon: Target },
  'post-close-price-refresh': { id: 'post-close-price-refresh', label: 'Close price', icon: RefreshCw },
  'daily-snapshot': { id: 'daily-snapshot', label: 'Daily snapshot', icon: Database },
  'us-leading': { id: 'us-leading', label: 'US leading', icon: Activity },
  'news-analyst': { id: 'news-analyst', label: 'News analyst', icon: Microscope },
  'morning-briefing': { id: 'morning-briefing', label: 'Morning briefing', icon: FileCheck2 },
  'external-evidence': { id: 'external-evidence', label: 'External evidence', icon: Layers3 },
  'artifact-reconcile': { id: 'artifact-reconcile', label: 'Artifact reconcile', icon: Archive },
  'legacy-hot-data-retirement': { id: 'legacy-hot-data-retirement', label: 'Hot-data retire', icon: Archive, optional: true },
  'legacy-evidence-migration': { id: 'legacy-evidence-migration', label: 'Evidence migrate', icon: Database, optional: true },
  'legacy-strategy-evidence-migration': { id: 'legacy-strategy-evidence-migration', label: 'Strategy migrate', icon: Database, optional: true },
  'd1-evidence-scrub': { id: 'd1-evidence-scrub', label: 'D1 scrub', icon: Wrench, optional: true },
  'r2-retention-sweep': { id: 'r2-retention-sweep', label: 'R2 retention', icon: Archive, optional: true },
  'orphan-reachability-gc': { id: 'orphan-reachability-gc', label: 'Reachability GC', icon: Wrench, optional: true },
  'cleanup-dlq-replay': { id: 'cleanup-dlq-replay', label: 'DLQ replay', icon: RefreshCw, optional: true },
  'storage-health-check': { id: 'storage-health-check', label: 'Storage health', icon: ShieldCheck },
  'weekly-backtest': { id: 'weekly-backtest', label: 'Validation / MC', icon: BarChart3 },
  'alpha-quality': { id: 'alpha-quality', label: 'Alpha quality', icon: Activity },
  'weekly-audit': { id: 'weekly-audit', label: 'Weekly audit', icon: ShieldCheck },
  'weekly-optuna': { id: 'weekly-optuna', label: 'Drift research', icon: Microscope, optional: true },
  'adaptive-meta-policy-replay': { id: 'adaptive-meta-policy-replay', label: 'Meta replay', icon: BrainCircuit, optional: true },
  'strategy-threshold-calibration': { id: 'strategy-threshold-calibration', label: 'Threshold calibration', icon: Settings2, optional: true },
  'linucb-multiplier-replay': { id: 'linucb-multiplier-replay', label: 'LinUCB replay', icon: BrainCircuit, optional: true },
  'active8-oof-weekly': { id: 'active8-oof-weekly', label: 'Active-8 OOF', icon: Layers3 },
  'sector-leaders': { id: 'sector-leaders', label: 'Sector leaders', icon: Target, optional: true },
  'monthly-strategy-mining': { id: 'monthly-strategy-mining', label: 'Strategy mining', icon: ScanSearch },
  'monthly-optuna': { id: 'monthly-optuna', label: 'Monthly search', icon: Microscope },
  'monthly-retrain': { id: 'monthly-retrain', label: 'Monthly retrain', icon: BrainCircuit },
  'active8-oof-monthly': { id: 'active8-oof-monthly', label: 'Active-8 cohort', icon: Layers3 },
  'storage-capacity-report': { id: 'storage-capacity-report', label: 'Storage capacity', icon: Database, optional: true },
}

const SCOPES: ChainScope[] = [
  {
    id: 'daily_readiness',
    label: 'Daily readiness',
    title: 'Daily readiness execution chain',
    description: 'Callback、readiness gate 與 pipeline stage 的正式 runtime 狀態。',
    relation: 'event',
    columns: [
      ['market-close-refresh'],
      ['evening-chain'],
      ['finlab-v4-backfill', 'finlab-backfill-watchdog'],
      ['update'],
      ['indicator-queue'],
      ['screener', 'regime-compute', 'allocator-ev-readiness'],
      ['pipeline'],
      ['ml-predict', 'recommendation'],
      ['post-pipeline-chain'],
      ['verify-v2'],
      ['post-verify-chain'],
      ['model-ic-rolling'],
      ['linucb-reward-ledger'],
      ['adapt'],
      ['daily-report'],
      ['paper-active-postmarket'],
      ['obsidian-sync'],
      ['meta-learning-shadow', 'strategy-learning'],
    ],
  },
  {
    id: 'intraday',
    label: 'Intraday guard',
    title: 'Intraday readiness guard',
    description: '只呈現已證實的盤前 dependency；re-score、EOD、close price 與 snapshot 是獨立時間觸發，留在下方分區。',
    relation: 'mixed',
    columns: [
      ['morning-setup'],
      ['pre-market-warmup'],
      ['intraday-check'],
    ],
  },
  {
    id: 'monthly',
    label: 'Monthly artifact',
    title: 'Monthly artifact chain',
    description: '策略挖掘、搜尋、重訓與月度 cohort；promotion evidence 由模型池承接。',
    relation: 'mixed',
    columns: [
      ['monthly-strategy-mining'],
      ['monthly-optuna'],
      ['monthly-retrain'],
      ['active8-oof-monthly'],
      ['storage-capacity-report'],
    ],
  },
]

const MAPPED_JOB_IDS = new Set(SCOPES.flatMap((scope) => scope.columns.flat()))

const STATUS_LABEL: Record<VisualStatus, string> = {
  completed: 'Completed',
  noop: 'Checked · no action',
  running: 'Running',
  waiting: 'Waiting',
  blocked: 'Blocked',
  not_started: 'Not started',
  skipped: 'Skipped',
}

function visualStatus(job?: SchedulerJob): VisualStatus {
  if (!job) return 'not_started'
  if (job.lastStatus === 'success') return 'completed'
  if (job.id === 'intraday-check' && job.lastStatus === 'skip') return 'noop'
  if (job.lastStatus === 'running') return 'running'
  if (job.lastStatus === 'waiting') return 'waiting'
  if (job.lastStatus === 'failed') return 'blocked'
  if (job.lastStatus === 'skip') return 'skipped'
  return 'not_started'
}

function statusPriority(status: VisualStatus): number {
  if (status === 'running') return 0
  if (status === 'blocked') return 1
  if (status === 'waiting') return 2
  if (status === 'completed' || status === 'noop') return 3
  if (status === 'not_started') return 4
  return 5
}

function connectorStatus(previousJobs: Array<SchedulerJob | undefined>, nextJobs: Array<SchedulerJob | undefined>): VisualStatus {
  const previous = previousJobs.map(visualStatus)
  const next = nextJobs.map(visualStatus)
  if (previous.includes('blocked')) return 'blocked'
  if (previous.includes('running') || next.includes('running')) return 'running'
  if (previous.length > 0 && previous.every((status) => status === 'completed' || status === 'noop' || status === 'skipped')) return 'completed'
  if (next.includes('waiting')) return 'waiting'
  return 'not_started'
}

function stageDetails(job?: SchedulerJob): string[] {
  if (!job) return []
  const details = Array.isArray(job.details) ? job.details.filter(Boolean) : []
  return details.slice(0, 8)
}

function formatUpdatedAt(value: number): string {
  if (!value) return 'waiting for API'
  return new Intl.DateTimeFormat('zh-TW', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value))
}

function statusSummary(job?: SchedulerJob): string {
  if (!job) return '正式 API 尚未回傳此 job。'
  if (job.lastError) return job.lastError
  if (job.summary) return job.summary
  if (job.lastStatus === 'running') return '已收到 start/trigger evidence，等待 final callback。'
  if (job.lastStatus === 'waiting') return '等待 upstream callback 或 readiness gate。'
  if (job.lastStatus === 'success') return 'Final callback 已完成並寫入 scheduler log。'
  if (job.lastStatus === 'sleep') return '目前不在執行窗口。'
  return '目前沒有新的 runtime evidence。'
}

function JobStatusSummary({ job, fallback }: { job?: SchedulerJob; fallback?: string }) {
  const summary = job ? statusSummary(job) : (fallback ?? 'No runtime evidence.')
  if (!job?.lastError) return <p className="obs-chain__summary">{summary}</p>

  return (
    <details className="obs-chain__error-disclosure">
      <summary><strong>Error log</strong><span aria-hidden="true" /></summary>
      <p className="obs-chain__error-preview">{summary}</p>
      <p className="obs-chain__error-full">{summary}</p>
    </details>
  )
}


export function schedulerRefreshInterval(jobs?: SchedulerJob[]): number {
  return jobs?.some((job) => job.lastStatus === 'running') ? 3_000 : 15_000
}

export default function ExecutionChainPanel({
  jobs,
  isFetching,
  dataUpdatedAt,
  apiError,
}: {
  jobs: SchedulerJob[]
  isFetching: boolean
  dataUpdatedAt: number
  apiError?: string | null
}) {
  const [scopeId, setScopeId] = useState<ChainScope['id']>('daily_readiness')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [justCompleted, setJustCompleted] = useState<Set<string>>(new Set())
  const previousStatuses = useRef<Record<string, SchedulerJob['lastStatus']>>({})
  const trackRef = useRef<HTMLDivElement | null>(null)

  const jobMap = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs])
  const scope = SCOPES.find((item) => item.id === scopeId) ?? SCOPES[0]
  const scopedJobMap = jobMap
  const stageIds = scope.columns.flat()
  const scopeJobs = stageIds.map((id) => scopedJobMap.get(id))
  const availableJobs = scopeJobs.filter((job): job is SchedulerJob => Boolean(job))
  const currentJob = [...availableJobs]
    .filter((job) => ['running', 'blocked', 'waiting'].includes(visualStatus(job)))
    .sort((a, b) => statusPriority(visualStatus(a)) - statusPriority(visualStatus(b)))[0]
    ?? [...availableJobs].reverse().find((job) => visualStatus(job) === 'completed')
    ?? availableJobs[0]
  const currentId = currentJob?.id ?? stageIds[0]
  const selectedJob = scopedJobMap.get(selectedId ?? currentId)
  const selectedDefinition = STAGES[selectedId ?? currentId] ?? STAGES[currentId]

  const expectedJobs = scopeJobs.filter((job): job is SchedulerJob => Boolean(job && visualStatus(job) !== 'skipped'))
  const progressJobs = expectedJobs.length > 0 ? expectedJobs : scopeJobs.filter((job): job is SchedulerJob => Boolean(job))
  const completedCount = progressJobs.filter((job) => ['completed', 'noop'].includes(visualStatus(job))).length
  const progress = progressJobs.length > 0 ? Math.round((completedCount / progressJobs.length) * 100) : 0
  const running = scopeJobs.some((job) => job?.lastStatus === 'running')
  const blockedCurrent = visualStatus(currentJob) === 'blocked'
  const progressActive = running || blockedCurrent

  const currentColumnIndex = Math.max(0, scope.columns.findIndex((column) => column.includes(currentId)))
  const nextColumn = scope.columns.slice(currentColumnIndex + 1).find((column) => column.some((id) => visualStatus(scopedJobMap.get(id)) === 'waiting'))
    ?? scope.columns.slice(currentColumnIndex + 1).find((column) => column.some((id) => visualStatus(scopedJobMap.get(id)) === 'not_started'))
  const nextId = nextColumn?.find((id) => visualStatus(scopedJobMap.get(id)) === 'waiting') ?? nextColumn?.[0]
  const nextJob = nextId ? scopedJobMap.get(nextId) : undefined
  const nextDefinition = nextId ? STAGES[nextId] : undefined
  const prerequisiteColumn = nextColumn ? scope.columns[Math.max(0, scope.columns.indexOf(nextColumn) - 1)] : []

  useEffect(() => {
    const nextStatuses = Object.fromEntries(jobs.map((job) => [job.id, job.lastStatus]))
    const completed = jobs
      .filter((job) => previousStatuses.current[job.id] && previousStatuses.current[job.id] !== 'success' && job.lastStatus === 'success')
      .map((job) => job.id)
    previousStatuses.current = nextStatuses
    if (!completed.length) return
    setJustCompleted(new Set(completed))
    const timer = window.setTimeout(() => setJustCompleted(new Set()), 1_600)
    return () => window.clearTimeout(timer)
  }, [jobs])

  useEffect(() => {
    setSelectedId(currentId)
    const timer = window.setTimeout(() => {
      trackRef.current?.querySelector<HTMLElement>(`[data-chain-stage="${currentId}"]`)?.scrollIntoView({
        behavior: 'smooth', block: 'nearest', inline: 'center',
      })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [scopeId, currentId])

  return (
    <section className="obs-chain" aria-labelledby="obs-chain-title">
      <div className="obs-chain__header">
        <div className="obs-chain__heading">
          <div className="obs-chain__heading-icon"><Waypoints aria-hidden="true" /></div>
          <div>
            <p className="obs-chain__kicker">Execution chain</p>
            <h3 id="obs-chain-title">{scope.title}</h3>
            <p>{scope.description}</p>
          </div>
        </div>
        <div className="obs-chain__live" aria-live="polite">
          <div className={`obs-chain__live-dot ${isFetching ? 'is-fetching' : ''}`} />
          <div>
            <strong>{apiError ? 'API unavailable' : isFetching ? 'Syncing callback state' : 'Callback sync active'}</strong>
            <span className="sv-num">{apiError ?? `active 3s · idle 15s · ${formatUpdatedAt(dataUpdatedAt)}`}</span>
          </div>
        </div>
      </div>

      <div className="obs-chain__toolbar">
        <div className="obs-chain__scopes" role="tablist" aria-label="Scheduler execution scope">
          {SCOPES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={item.id === scopeId}
              className={item.id === scopeId ? 'is-active' : ''}
              onClick={() => setScopeId(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="obs-chain__phase sv-num">
          <span>{scope.relation === 'event' ? 'event-driven' : 'mixed triggers'}</span>
          <strong>{Math.min(currentColumnIndex + 1, scope.columns.length)} / {scope.columns.length}</strong>
        </div>
      </div>

      <div className="obs-chain__viewport" ref={trackRef}>
        <div className="obs-chain__sequence">
          {scope.columns.map((column, index) => {
            const previousColumn = scope.columns[index - 1] ?? []
            const connection = connectorStatus(
              previousColumn.map((id) => scopedJobMap.get(id)),
              column.map((id) => scopedJobMap.get(id)),
            )
            return (
              <div className="obs-chain__segment" key={`${scope.id}-${column.join('-')}`}>
                {index > 0 && <div className={`obs-chain__connector is-${connection}`} aria-hidden="true"><span /></div>}
                <div className={`obs-chain__column ${column.length > 1 ? 'is-parallel' : ''}`}>
                  {column.map((id, stageIndex) => {
                    const definition = STAGES[id] ?? { id, label: id, icon: Workflow }
                    const job = scopedJobMap.get(id)
                    const status = visualStatus(job)
                    const Icon = definition.icon
                    return (
                      <button
                        type="button"
                        key={id}
                        data-chain-stage={id}
                        className={`obs-chain__stage is-${status} ${currentId === id ? 'is-current' : ''} ${selectedId === id ? 'is-selected' : ''} ${justCompleted.has(id) ? 'just-completed' : ''}`}
                        onClick={() => setSelectedId(id)}
                        aria-label={`${definition.label}: ${STATUS_LABEL[status]}`}
                        aria-current={currentId === id ? 'step' : undefined}
                      >
                        <span className="obs-chain__ordinal sv-num">{index + 1}{column.length > 1 ? String.fromCharCode(97 + stageIndex) : ''}</span>
                        <span className="obs-chain__orb">
                          <Icon aria-hidden="true" />
                          <span className="obs-chain__state-mark" aria-hidden="true">
                            {status === 'completed' || status === 'noop' ? '✓' : status === 'blocked' ? '×' : status === 'running' ? '↻' : status === 'waiting' ? '⌛' : '○'}
                          </span>
                        </span>
                        <span className="obs-chain__stage-copy">
                          <strong>{definition.label}</strong>
                          <span>{job?.name ?? id}</span>
                          <small className="sv-num">{job?.lastRun || job?.nextRun || 'no runtime evidence'}</small>
                          <em>{STATUS_LABEL[status]}{definition.optional ? ' · optional' : ''}</em>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="obs-chain__progress">
        <div className="obs-chain__progress-label">
          <span><Activity aria-hidden="true" /> Overall progress</span>
          <strong className="sv-num">{completedCount} / {progressJobs.length} completed · {progress}%</strong>
        </div>
        <div className={`obs-chain__progress-track ${progressActive ? 'is-active' : ''} ${blockedCurrent ? 'is-blocked' : ''}`} aria-label={`Overall progress ${progress}%`}>
          <div className={`obs-chain__progress-fill ${running ? 'is-running' : ''} ${blockedCurrent ? 'is-blocked' : ''}`} style={{ transform: `scaleX(${progress / 100})` }} />
        </div>
      </div>

      <div className="obs-chain__details">
        <article className={`obs-chain__detail obs-chain__detail--selected ${selectedJob?.lastError ? 'has-error' : ''}`}>
          <div className="obs-chain__detail-title">
            <span className={`obs-chain__detail-dot is-${visualStatus(selectedJob)}`} />
            <div>
              <p>Selected stage</p>
              <h4>{selectedDefinition?.label ?? selectedJob?.name ?? 'No stage selected'}</h4>
            </div>
          </div>
          <JobStatusSummary job={selectedJob} />
          <dl className="obs-chain__metrics">
            <div><dt>Status</dt><dd>{STATUS_LABEL[visualStatus(selectedJob)]}</dd></div>
            <div><dt>Last run</dt><dd className="sv-num">{selectedJob?.lastRun ?? '—'}</dd></div>
            <div><dt>Duration</dt><dd className="sv-num">{selectedJob?.lastDuration ?? '—'}</dd></div>
          </dl>
          {stageDetails(selectedJob).length > 0 && (
            <div className="obs-chain__evidence">
              {stageDetails(selectedJob).map((detail) => <span key={detail}>{detail}</span>)}
            </div>
          )}
        </article>

        <article className="obs-chain__detail obs-chain__detail--next">
          <div className="obs-chain__detail-title">
            <TimerReset aria-hidden="true" />
            <div>
              <p>Next up</p>
              <h4>{nextDefinition?.label ?? 'Chain complete'}</h4>
            </div>
          </div>
          <JobStatusSummary job={nextJob} fallback="目前 scope 沒有下一個 waiting stage。" />
          <dl className="obs-chain__metrics obs-chain__metrics--two">
            <div><dt>Trigger</dt><dd>{scope.relation === 'event' ? 'Callback / gate' : 'Callback / schedule'}</dd></div>
            <div><dt>Next run</dt><dd className="sv-num">{nextJob?.nextRun ?? '—'}</dd></div>
          </dl>
          <div className="obs-chain__prerequisites">
            <p>Prerequisites</p>
            <div>
              {(prerequisiteColumn.length ? prerequisiteColumn : ['chain-root']).map((id) => {
                const prerequisite = id === 'chain-root' ? undefined : scopedJobMap.get(id)
                return (
                  <span key={id} className={`is-${visualStatus(prerequisite)}`}>
                    {['completed', 'noop'].includes(visualStatus(prerequisite)) ? '✓' : '○'} {id === 'chain-root' ? 'No upstream stage' : (STAGES[id]?.label ?? prerequisite?.name ?? id)}
                  </span>
                )
              })}
            </div>
          </div>
        </article>
      </div>
      <StandaloneJobRegistry jobs={jobs} mappedJobIds={MAPPED_JOB_IDS} />
    </section>
  )
}
