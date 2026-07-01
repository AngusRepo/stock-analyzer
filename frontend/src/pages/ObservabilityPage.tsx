import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  CheckCircle2,
  Database,
  ExternalLink,
  Loader2,
  RadioTower,
  ShieldAlert,
  TimerReset,
  Workflow,
} from 'lucide-react'
import AppShell from '@/components/AppShell'
import { Button } from '@/components/ui/button'
import {
  WorkstationPageTitle,
  WorkstationPanel,
  WorkstationPill,
  type WorkstationTone,
} from '@/components/workstation/WorkstationChrome'
import {
  dataQualityApi,
  deployGateApi,
  observabilityApi,
  schedulerApi,
  systemApi,
  type DataQualityCheck,
  type DataQualityReport,
  type ObservabilityEvent,
  type ObservabilitySeverity,
  type SchedulerJob,
} from '@/lib/api'

function statusTone(status?: string | null): WorkstationTone {
  const value = String(status ?? '').toLowerCase()
  if (['ok', 'pass', 'success', 'resolved'].includes(value)) return 'ok'
  if (['warn', 'warning', 'watch', 'running'].includes(value)) return 'warn'
  if (value === 'waiting') return 'info'
  if (['sleep', 'skip', 'skipped'].includes(value)) return 'neutral'
  if (['fail', 'failed', 'error', 'block', 'blocked'].includes(value)) return 'error'
  return 'info'
}

function schedulerStatusLabel(status?: string | null) {
  const value = String(status ?? '').toLowerCase()
  if (value === 'waiting') return 'WAITING'
  if (value === 'sleep') return 'NOT TODAY'
  if (value === 'skip' || value === 'skipped') return 'SKIPPED'
  return status || 'unknown'
}

const EXECUTION_REALISM_STATES = [
  'checked_waiting',
  'quote_unavailable',
  'stale_quote',
  'requoted',
  'partially_filled',
  'expired',
] as const

function severityTone(severity?: ObservabilitySeverity | null): WorkstationTone {
  if (severity === 'error') return 'error'
  if (severity === 'warn') return 'warn'
  if (severity === 'ok') return 'ok'
  return 'info'
}

function toneColor(tone: WorkstationTone) {
  if (tone === 'ok') return '#34d399'
  if (tone === 'warn') return '#fbbf24'
  if (tone === 'error') return '#fb7185'
  if (tone === 'info') return '#38bdf8'
  return '#94a3b8'
}

function formatStatus(status?: string | null) {
  return status ? String(status).toUpperCase() : 'N/A'
}

function computeDataQualityScore(report?: DataQualityReport) {
  const checks = report?.checks ?? []
  if (!checks.length) return 0
  const score = checks.reduce((sum, check) => {
    if (check.status === 'ok') return sum + 1
    if (check.status === 'warn') return sum + 0.5
    return sum
  }, 0)
  return Math.round((score / checks.length) * 100)
}

function errorMessage(error: unknown) {
  if (!error) return null
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function MiniBar({ value, tone }: { value: number; tone: WorkstationTone }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
      <div className="h-full rounded-full" style={{ width: `${clamped}%`, backgroundColor: toneColor(tone) }} />
    </div>
  )
}

type ReadinessStatus = 'ready' | 'running' | 'waiting' | 'blocked' | 'pending'

type ReadinessStage = {
  id: string
  label: string
  owner: string
  detail: string
  status: ReadinessStatus
  tone: WorkstationTone
  job?: SchedulerJob
  nextAction: string
}

type ReadinessGate = {
  id: string
  label: string
  status: ReadinessStatus
  tone: WorkstationTone
  value: string
  source: string
  detail: string
  latestDate?: string | null
}

type MarketMaterializationItem = {
  key: string
  label: string
  status: string
  rows: number
  latest_date: string | null
  lag_days: number | null
  required: boolean
  source: string
  scope: string
  root_cause: string | null
}

const READINESS_STAGES: Array<{
  id: string
  label: string
  owner: string
  detail: string
  jobIds: string[]
  nextAction: string
}> = [
  {
    id: 'market-close-refresh',
    label: '收盤資料刷新',
    owner: 'FinLab / TWSE-TPEX',
    detail: '價格、成交額、指數、期貨與信用交易先進 canonical。',
    jobIds: ['market-close-refresh', 'finlab-v4-backfill', 'update'],
    nextAction: '等待 FinLab canonical callback 或 TWSE/TPEX supplemental refresh。',
  },
  {
    id: 'source-readiness',
    label: '資料就緒閘門',
    owner: 'readiness probe',
    detail: '檢查 primary canonical 與官方補件是否達到今日交易日。',
    jobIds: ['source-readiness-probe', 'evening-chain'],
    nextAction: '若未 ready，持續 polling；超時才標記 degraded。',
  },
  {
    id: 'indicator-queue',
    label: '指標計算',
    owner: 'worker queue',
    detail: '技術、籌碼、題材、風險特徵入庫後才放行 screener。',
    jobIds: ['indicator-queue'],
    nextAction: '補齊指標產物，確認 downstream row count。',
  },
  {
    id: 'screener',
    label: '候選池',
    owner: 'screener',
    detail: 'L0-L2 篩選產生可辯論候選，不在 OBS 手動跳關。',
    jobIds: ['screener'],
    nextAction: '確認候選數與 hard gate reason 分布。',
  },
  {
    id: 'ml-pipeline',
    label: '模型與推薦',
    owner: 'pipeline-v2',
    detail: 'pipeline、ML predict、recommendation 必須共用同一 run date。',
    jobIds: ['pipeline', 'ml-predict', 'recommendation'],
    nextAction: '若卡住，先看前序 readiness，不直接 rerun recommendation。',
  },
  {
    id: 'post-verify',
    label: '驗證與回饋',
    owner: 'verify / learner',
    detail: 'verify、IC、LinUCB、adaptive evidence 回寫後形成隔日 guard。',
    jobIds: ['verify-v2', 'model-ic-tracker', 'linucb-reward-ledger', 'adapt'],
    nextAction: '確認 reward ledger 與 adaptive meta 沒有 stale evidence。',
  },
]

function readinessTone(status: ReadinessStatus): WorkstationTone {
  if (status === 'ready') return 'ok'
  if (status === 'running') return 'info'
  if (status === 'waiting' || status === 'pending') return 'warn'
  return 'error'
}

function readinessLabel(status: ReadinessStatus) {
  if (status === 'ready') return 'READY'
  if (status === 'running') return 'RUNNING'
  if (status === 'waiting') return 'WAITING'
  if (status === 'blocked') return 'BLOCKED'
  return 'PENDING'
}

function readinessStatusFromScheduler(status?: string | null): ReadinessStatus {
  const value = String(status ?? '').toLowerCase()
  if (value === 'success') return 'ready'
  if (value === 'running') return 'running'
  if (value === 'failed' || value === 'error') return 'blocked'
  if (value === 'waiting') return 'waiting'
  if (value === 'sleep' || value === 'skip' || value === 'skipped') return 'pending'
  return 'pending'
}

function chooseRepresentativeJob(jobs: SchedulerJob[], ids: string[]) {
  const byId = new Map(jobs.map((job) => [job.id, job]))
  const candidates = ids.map((id) => byId.get(id)).filter((job): job is SchedulerJob => Boolean(job))
  return candidates.find((job) => ['failed', 'running', 'waiting'].includes(job.lastStatus)) ?? candidates.find((job) => job.lastStatus === 'success') ?? candidates[0]
}

function stageFromDefinition(def: typeof READINESS_STAGES[number], jobs: SchedulerJob[]): ReadinessStage {
  const job = chooseRepresentativeJob(jobs, def.jobIds)
  const status = readinessStatusFromScheduler(job?.lastStatus)
  return {
    id: def.id,
    label: def.label,
    owner: def.owner,
    detail: job?.summary || def.detail,
    status,
    tone: readinessTone(status),
    job,
    nextAction: status === 'ready' ? '已放行下一段；保留 evidence 供 drilldown。' : def.nextAction,
  }
}

function parseMarketMaterialization(checks: DataQualityCheck[]): { check?: DataQualityCheck; items: MarketMaterializationItem[] } {
  const check = checks.find((row) => row.id === 'market_dashboard_materialization')
  const raw = check?.metrics?.materialization_checks
  return {
    check,
    items: Array.isArray(raw) ? raw as MarketMaterializationItem[] : [],
  }
}

function gateStatusFromQuality(status?: string | null): ReadinessStatus {
  const value = String(status ?? '').toLowerCase()
  if (value === 'ok' || value === 'success' || value === 'ready') return 'ready'
  if (value === 'warn' || value === 'waiting') return 'waiting'
  if (value === 'fail' || value === 'failed' || value === 'blocked') return 'blocked'
  return 'pending'
}

function buildReadinessGates(checks: DataQualityCheck[]): ReadinessGate[] {
  const { check, items } = parseMarketMaterialization(checks)
  if (items.length) {
    return items.map((item) => {
      const status = gateStatusFromQuality(item.status)
      const freshness = item.lag_days == null ? 'lag n/a' : `lag ${item.lag_days}d`
      return {
        id: item.key,
        label: item.label,
        status,
        tone: readinessTone(status),
        value: `${Number(item.rows ?? 0).toLocaleString()} rows`,
        source: item.source || 'canonical',
        detail: item.root_cause || `${item.scope || 'market dashboard'} / ${freshness}`,
        latestDate: item.latest_date,
      }
    })
  }

  const fallbackIds = ['price_freshness', 'market_dashboard_materialization', 'recommendation_payload', 'canonical_chip_daily']
  const selected = checks.filter((checkRow) => fallbackIds.some((id) => checkRow.id.includes(id))).slice(0, 8)
  if (selected.length) {
    return selected.map((checkRow) => {
      const status = gateStatusFromQuality(checkRow.status)
      return {
        id: checkRow.id,
        label: checkRow.label,
        status,
        tone: readinessTone(status),
        value: checkRow.status.toUpperCase(),
        source: 'data-quality report',
        detail: checkRow.summary,
        latestDate: null,
      }
    })
  }

  return [
    {
      id: 'finlab-canonical',
      label: 'FinLab canonical',
      status: 'pending',
      tone: 'warn',
      value: '待 API payload',
      source: 'data-quality API',
      detail: '目前 OBS 尚未取得 market_dashboard_materialization；local preview 只顯示結構。',
    },
    {
      id: 'official-supplement',
      label: 'TWSE/TPEX 補件',
      status: 'pending',
      tone: 'warn',
      value: '待 API payload',
      source: 'official supplemental',
      detail: '補件包含券商分點、融資融券與市場缺口修補。',
    },
  ]
}

function statusRingClass(tone: WorkstationTone) {
  if (tone === 'ok') return 'border-emerald-400/35 bg-emerald-400/10 text-emerald-200 shadow-[0_0_28px_rgba(16,185,129,0.10)]'
  if (tone === 'warn') return 'border-amber-400/35 bg-amber-400/10 text-amber-100 shadow-[0_0_28px_rgba(251,191,36,0.10)]'
  if (tone === 'error') return 'border-rose-400/35 bg-rose-400/10 text-rose-100 shadow-[0_0_28px_rgba(244,63,94,0.10)]'
  if (tone === 'info') return 'border-sky-400/35 bg-sky-400/10 text-sky-100 shadow-[0_0_28px_rgba(56,189,248,0.10)]'
  return 'border-slate-500/35 bg-slate-500/10 text-slate-200'
}

function ReadinessGauge({ score, tone }: { score: number; tone: WorkstationTone }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0))
  const color = toneColor(tone)
  return (
    <div className="relative grid h-28 w-28 shrink-0 place-items-center rounded-full border border-[#2b3a49] bg-[#070a10]">
      <div
        className="absolute inset-2 rounded-full"
        style={{ background: `conic-gradient(${color} ${clamped * 3.6}deg, rgba(148,163,184,0.14) 0deg)` }}
      />
      <div className="relative grid h-[74px] w-[74px] place-items-center rounded-full bg-[#0f151d] shadow-[inset_0_0_20px_rgba(0,0,0,0.45)]">
        <div className="text-center">
          <p className="sv-num text-2xl font-semibold text-[#f2ead8]">{clamped}</p>
          <p className="sv-num text-[10px] normal-case text-[#7f8ba0]">readiness</p>
        </div>
      </div>
    </div>
  )
}

function ReadinessFlowMap({ stages }: { stages: ReadinessStage[] }) {
  return (
    <div className="overflow-visible pb-1 md:overflow-x-auto">
      <div className="grid gap-2 md:flex md:min-w-[920px] md:items-stretch">
        {stages.map((stage, index) => (
          <div key={stage.id} className="grid min-w-0 gap-2 md:flex md:flex-1 md:items-center">
            <div className={`min-h-[148px] flex-1 rounded-2xl border p-3 ${statusRingClass(stage.tone)}`}>
              <div className="flex items-start justify-between gap-3">
                <span className="grid h-8 w-8 place-items-center rounded-xl border border-white/10 bg-black/20 sv-num text-[12px] text-[#ffd87f]">{index + 1}</span>
                <WorkstationPill tone={stage.tone}>{readinessLabel(stage.status)}</WorkstationPill>
              </div>
              <p className="mt-3 text-base font-semibold text-[#f8efe0]">{stage.label}</p>
              <p className="mt-1 sv-num text-[11px] normal-case text-[#9badbf]">{stage.owner}</p>
              <p className="mt-3 line-clamp-2 text-xs leading-5 text-[#a8b6c5]">{stage.detail}</p>
              <p className="mt-2 truncate sv-num text-[11px] normal-case text-[#70809b]">{stage.job?.lastRun || stage.job?.nextRun || 'no runtime evidence yet'}</p>
            </div>
            {index < stages.length - 1 && <ArrowRight className="hidden h-4 w-4 shrink-0 text-[#4d5b70] md:block" />}
          </div>
        ))}
      </div>
    </div>
  )
}

function ReadinessGateMatrix({ gates, limit = 12 }: { gates: ReadinessGate[]; limit?: number }) {
  const visibleGates = limit > 0 ? gates.slice(0, limit) : gates
  return (
    <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-4">
      {visibleGates.map((gate) => (
        <div key={gate.id} className={`rounded-2xl border p-3 ${statusRingClass(gate.tone)}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[#f2ead8]">{gate.label}</p>
              <p className="mt-1 truncate sv-num text-[11px] normal-case text-[#7f8ba0]">{gate.source}</p>
            </div>
            <WorkstationPill tone={gate.tone}>{readinessLabel(gate.status)}</WorkstationPill>
          </div>
          <div className="mt-3 flex items-end justify-between gap-3">
            <p className="sv-num text-xl font-semibold" style={{ color: toneColor(gate.tone) }}>{gate.value}</p>
            <p className="sv-num text-[11px] normal-case text-[#8b9bab]">{gate.latestDate ?? 'date n/a'}</p>
          </div>
          <MiniBar value={gate.status === 'ready' ? 94 : gate.status === 'running' ? 72 : gate.status === 'waiting' ? 48 : gate.status === 'blocked' ? 100 : 28} tone={gate.tone} />
          <p className="mt-2 line-clamp-2 text-xs leading-5 text-[#9badbf]">{gate.detail}</p>
        </div>
      ))}
    </div>
  )
}

function DataQualityCompactMatrix({ gates }: { gates: ReadinessGate[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
      {gates.map((gate) => (
        <div key={gate.id} className={`min-h-[106px] rounded-xl border p-2 ${statusRingClass(gate.tone)}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-[#f2ead8]">{gate.label}</p>
              <p className="mt-0.5 truncate sv-num text-[10px] normal-case text-[#7f8ba0]">{gate.source}</p>
            </div>
            <span className="shrink-0 rounded-full border border-white/10 bg-black/20 px-1.5 py-0.5 sv-num text-[10px] normal-case" style={{ color: toneColor(gate.tone) }}>
              {readinessLabel(gate.status)}
            </span>
          </div>
          <div className="mt-2 flex items-end justify-between gap-2">
            <p className="truncate sv-num text-base font-semibold" style={{ color: toneColor(gate.tone) }}>{gate.value}</p>
            <p className="shrink-0 sv-num text-[10px] normal-case text-[#8b9bab]">{gate.latestDate ?? 'n/a'}</p>
          </div>
          <MiniBar value={gate.status === 'ready' ? 94 : gate.status === 'running' ? 72 : gate.status === 'waiting' ? 48 : gate.status === 'blocked' ? 100 : 28} tone={gate.tone} />
          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-[#9badbf]">{gate.detail}</p>
        </div>
      ))}
    </div>
  )
}

const SCHEDULER_GROUP_META: Record<SchedulerJob['group'], {
  label: string
  purpose: string
  tone: WorkstationTone
  expectedCount: number
  examples: string[]
}> = {
  pipeline_chain: {
    label: 'Daily readiness chain',
    purpose: '收盤資料、指標、推薦、驗證與隔日 evidence 的主鏈。',
    tone: 'info',
    expectedCount: 23,
    examples: ['Market Close Refresh', 'Readiness Probe', 'Pipeline', 'Verify'],
  },
  intraday: {
    label: 'Intraday execution',
    purpose: '盤中檢查、重評分與收盤前出場，和晚間 daily chain 分開看。',
    tone: 'ok',
    expectedCount: 3,
    examples: ['Intraday Check', 'Intraday Re-score', 'EOD Exit'],
  },
  daily: {
    label: 'Daily standalone',
    purpose: '晨間、新聞、快照、記憶保留與 queue 類日常排程。',
    tone: 'warn',
    expectedCount: 7,
    examples: ['US Leading', 'News Analyst', 'Morning Setup', 'Daily Snapshot'],
  },
  weekly: {
    label: 'Weekly research',
    purpose: '週度審計、回測、Optuna、adaptive replay 與品質檢查。',
    tone: 'neutral',
    expectedCount: 9,
    examples: ['Weekly Audit', 'Weekly Backtest', 'Alpha Quality', 'Sector Leaders'],
  },
  monthly: {
    label: 'Monthly gated',
    purpose: '月度挖礦、Optuna 與 retrain，偏研究或 approval-gated。',
    tone: 'error',
    expectedCount: 3,
    examples: ['Monthly Optuna', 'Strategy Mining', 'Universal Retrain'],
  },
}

const SCHEDULER_GROUP_ORDER: SchedulerJob['group'][] = ['pipeline_chain', 'intraday', 'daily', 'weekly', 'monthly']
const EXPECTED_SCHEDULER_COUNT = SCHEDULER_GROUP_ORDER.reduce(
  (sum, group) => sum + SCHEDULER_GROUP_META[group].expectedCount,
  0,
)
const SCHEDULER_GROUP_ANCHOR_PREFIX = 'scheduler-group-'

function schedulerGroupAnchor(group: SchedulerJob['group']) {
  return `${SCHEDULER_GROUP_ANCHOR_PREFIX}${group}`
}

function groupSchedulerJobs(jobs: SchedulerJob[]) {
  const jobsByGroup = new Map<SchedulerJob['group'], SchedulerJob[]>()
  for (const job of jobs) {
    const groupJobs = jobsByGroup.get(job.group) ?? []
    groupJobs.push(job)
    jobsByGroup.set(job.group, groupJobs)
  }
  return jobsByGroup
}

function schedulerStatusIs(job: SchedulerJob, statuses: string[]) {
  return statuses.includes(String(job.lastStatus ?? '').toLowerCase())
}

function summarizeSchedulerGroup(jobs: SchedulerJob[]) {
  const failed = jobs.filter((job) => schedulerStatusIs(job, ['failed', 'error'])).length
  const running = jobs.filter((job) => schedulerStatusIs(job, ['running'])).length
  const waiting = jobs.filter((job) => schedulerStatusIs(job, ['waiting'])).length
  const success = jobs.filter((job) => schedulerStatusIs(job, ['success'])).length
  const inactive = jobs.filter((job) => schedulerStatusIs(job, ['sleep', 'skip', 'skipped'])).length
  const tone: WorkstationTone = failed ? 'error' : running ? 'info' : waiting ? 'warn' : success ? 'ok' : 'neutral'
  const focus =
    jobs.find((job) => schedulerStatusIs(job, ['failed', 'error'])) ??
    jobs.find((job) => schedulerStatusIs(job, ['running'])) ??
    jobs.find((job) => schedulerStatusIs(job, ['waiting'])) ??
    jobs.find((job) => job.nextRun && job.nextRun !== 'N/A') ??
    jobs[0]

  return { failed, running, waiting, success, inactive, tone, focus }
}

function schedulerGroupHealthLabel(summary: ReturnType<typeof summarizeSchedulerGroup>, hasRuntimeJobs: boolean, groupJobCount: number) {
  if (!hasRuntimeJobs) return 'OFFLINE'
  if (!groupJobCount) return 'MISSING'
  if (summary.failed) return 'FAIL'
  if (summary.running) return 'RUN'
  if (summary.waiting) return 'WAIT'
  if (summary.success || summary.inactive) return 'OK'
  return 'IDLE'
}

function SchedulerCountChip({ label, value, tone }: { label: string; value: number; tone: WorkstationTone }) {
  return (
    <span className={`min-w-0 rounded-lg border px-1.5 py-1 text-center sv-num text-[10px] normal-case ${statusRingClass(tone)}`}>
      <span className="block leading-none">{label}</span>
      <span className="mt-1 block text-sm font-semibold leading-none">{value}</span>
    </span>
  )
}

function SchedulerShortcutCard({
  group,
  jobs,
  hasRuntimeJobs,
  className,
}: {
  group: SchedulerJob['group']
  jobs: SchedulerJob[]
  hasRuntimeJobs: boolean
  className?: string
}) {
  const meta = SCHEDULER_GROUP_META[group]
  const summary = summarizeSchedulerGroup(jobs)
  const cardTone: WorkstationTone = hasRuntimeJobs
    ? jobs.length
      ? summary.tone === 'neutral' ? 'neutral' : summary.tone
      : 'warn'
    : meta.tone
  const healthLabel = schedulerGroupHealthLabel(summary, hasRuntimeJobs, jobs.length)
  const focusText = summary.focus
    ? `${summary.focus.name} · ${schedulerStatusLabel(summary.focus.lastStatus)}`
    : `${meta.expectedCount} expected schedulers`

  return (
    <a
      href={`#${schedulerGroupAnchor(group)}`}
      className={`group min-w-0 rounded-xl border p-2.5 transition duration-200 hover:-translate-y-0.5 hover:border-sky-300/45 hover:bg-[#121b27] focus:outline-none focus:ring-2 focus:ring-sky-300/45 ${statusRingClass(cardTone)} ${className ?? ''}`}
      title={`Jump to ${meta.label}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[#f8efe0]">{meta.label}</p>
          <p className="mt-0.5 truncate sv-num text-[10px] normal-case text-[#7f8ba0]">{group}</p>
        </div>
        <WorkstationPill tone={cardTone}>{healthLabel}</WorkstationPill>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1">
        <SchedulerCountChip label="OK" value={summary.success} tone="ok" />
        <SchedulerCountChip label="RUN" value={summary.running} tone="info" />
        <SchedulerCountChip label="WAIT" value={summary.waiting} tone="warn" />
        <SchedulerCountChip label="FAIL" value={summary.failed} tone="error" />
      </div>
      <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
        <p className="truncate sv-num text-[11px] normal-case text-[#9badbf]">{focusText}</p>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[#6d7f97] transition group-hover:text-sky-200" />
      </div>
    </a>
  )
}

function SchedulerShortcutDeck({ jobs }: { jobs: SchedulerJob[] }) {
  const hasRuntimeJobs = jobs.length > 0
  const jobsByGroup = groupSchedulerJobs(jobs)
  const groupJobs = (group: SchedulerJob['group']) => jobsByGroup.get(group) ?? []

  return (
    <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-[minmax(0,1.18fr)_repeat(4,minmax(0,1fr))]">
      <SchedulerShortcutCard group="pipeline_chain" jobs={groupJobs('pipeline_chain')} hasRuntimeJobs={hasRuntimeJobs} />
      <SchedulerShortcutCard group="daily" jobs={groupJobs('daily')} hasRuntimeJobs={hasRuntimeJobs} />
      <SchedulerShortcutCard group="intraday" jobs={groupJobs('intraday')} hasRuntimeJobs={hasRuntimeJobs} />
      <SchedulerShortcutCard group="weekly" jobs={groupJobs('weekly')} hasRuntimeJobs={hasRuntimeJobs} />
      <SchedulerShortcutCard group="monthly" jobs={groupJobs('monthly')} hasRuntimeJobs={hasRuntimeJobs} />
    </div>
  )
}

function schedulerJobTone(job: SchedulerJob): WorkstationTone {
  const status = String(job.lastStatus ?? '').toLowerCase()
  if (status === 'failed' || status === 'error') return 'error'
  if (status === 'running' || status === 'waiting') return 'warn'
  if (status === 'success') return 'ok'
  if (status === 'sleep' || status === 'skip' || status === 'skipped') return 'neutral'
  return 'info'
}

function schedulerJobPriority(job: SchedulerJob) {
  const status = String(job.lastStatus ?? '').toLowerCase()
  if (status === 'failed' || status === 'error') return 0
  if (status === 'running') return 1
  if (status === 'waiting') return 2
  if (status === 'success') return 3
  if (status === 'sleep') return 4
  if (status === 'skip' || status === 'skipped') return 5
  return 6
}

function schedulerGroupSpanClass(group: SchedulerJob['group']) {
  if (group === 'pipeline_chain') return 'xl:col-span-2 2xl:col-span-4'
  if (group === 'daily' || group === 'weekly') return 'xl:col-span-2 2xl:col-span-2'
  return ''
}

function SchedulerJobRow({ job, compact = false }: { job: SchedulerJob; compact?: boolean }) {
  const tone = schedulerJobTone(job)
  return (
    <div className={`group min-w-0 overflow-hidden rounded-xl border bg-[#070a10]/88 transition duration-200 hover:-translate-y-0.5 hover:bg-[#0b1118] ${compact ? 'p-2.5' : 'p-3'}`} style={{ borderColor: `${toneColor(tone)}40` }}>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full shadow-[0_0_12px_currentColor]" style={{ color: toneColor(tone), backgroundColor: toneColor(tone) }} />
            <p className="truncate text-sm font-semibold text-[#f8efe0]">{job.name}</p>
          </div>
          <p className="mt-1 truncate sv-num text-[11px] normal-case text-[#7f8ba0]">{job.id} · {job.schedule}</p>
        </div>
        <WorkstationPill tone={tone}>{schedulerStatusLabel(job.lastStatus)}</WorkstationPill>
      </div>
      <div className="mt-2 grid min-w-0 grid-cols-1 gap-1 sv-num text-[11px] normal-case text-[#9badbf] sm:grid-cols-3">
        <span className="min-w-0 truncate rounded-lg border border-[#253244] bg-[#111824] px-2 py-1">last {job.lastRun || '-'}</span>
        <span className="min-w-0 truncate rounded-lg border border-[#253244] bg-[#111824] px-2 py-1">next {job.nextRun || '-'}</span>
        <span className="min-w-0 truncate rounded-lg border border-[#253244] bg-[#111824] px-2 py-1">7d {job.rate7d || '-'}</span>
      </div>
      {(job.summary || job.lastError || job.durationConcernReason) && (
        <p className={`mt-2 line-clamp-3 min-w-0 break-words text-xs leading-5 [overflow-wrap:anywhere] ${tone === 'error' ? 'text-rose-200' : tone === 'warn' ? 'text-amber-100' : 'text-[#9badbf]'}`}>
          {job.lastError || job.summary || job.durationConcernReason}
        </p>
      )}
    </div>
  )
}

function SchedulerInventoryPanel({ jobs }: { jobs: SchedulerJob[] }) {
  const hasRuntimeJobs = jobs.length > 0
  const jobsByGroup = groupSchedulerJobs(jobs)

  return (
    <div className="min-w-0 overflow-hidden rounded-2xl border border-[#2b3a49] bg-[#0f151d] p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Workflow className="h-4 w-4 text-[#ffd87f]" />
          <p className="text-sm font-semibold text-[#f2ead8]">Scheduler Inventory / 全排程分層</p>
        </div>
        <WorkstationPill tone={hasRuntimeJobs ? 'neutral' : 'warn'}>
          {hasRuntimeJobs ? `${jobs.length} runtime schedulers` : `${EXPECTED_SCHEDULER_COUNT} expected / API offline`}
        </WorkstationPill>
      </div>
      <div className="grid min-w-0 gap-3 xl:grid-cols-2 2xl:grid-cols-4">
        {SCHEDULER_GROUP_ORDER.map((group) => {
          const groupJobs = [...(jobsByGroup.get(group) ?? [])].sort((a, b) =>
            schedulerJobPriority(a) - schedulerJobPriority(b) ||
            Number(a.chainIndex ?? 999) - Number(b.chainIndex ?? 999) ||
            a.name.localeCompare(b.name),
          )
          const meta = SCHEDULER_GROUP_META[group]
          const summary = summarizeSchedulerGroup(groupJobs)
          const cardTone = hasRuntimeJobs ? (summary.tone === 'neutral' ? meta.tone : summary.tone) : meta.tone
          return (
            <div id={schedulerGroupAnchor(group)} key={group} className={`min-w-0 scroll-mt-24 overflow-hidden rounded-2xl border p-3 ${statusRingClass(cardTone)} ${schedulerGroupSpanClass(group)}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[#f8efe0]">{meta.label}</p>
                  <p className="mt-1 sv-num text-[11px] normal-case text-[#7f8ba0]">{group}</p>
                </div>
                <WorkstationPill tone={hasRuntimeJobs ? summary.tone : meta.tone}>
                  {hasRuntimeJobs ? groupJobs.length : `${meta.expectedCount} expected`}
                </WorkstationPill>
              </div>
              <p className="mt-3 min-h-10 text-xs leading-5 text-[#9badbf]">{meta.purpose}</p>
              {hasRuntimeJobs ? (
                <>
                  <div className="mt-3 grid grid-cols-4 gap-1 sv-num text-[11px] normal-case">
                    <span className="rounded-lg border border-emerald-400/15 bg-emerald-400/[0.06] px-2 py-1 text-emerald-200">ok {summary.success}</span>
                    <span className="rounded-lg border border-amber-400/15 bg-amber-400/[0.06] px-2 py-1 text-amber-200">run {summary.running}</span>
                    <span className="rounded-lg border border-amber-400/15 bg-amber-400/[0.06] px-2 py-1 text-amber-200">wait {summary.waiting}</span>
                    <span className="rounded-lg border border-rose-400/15 bg-rose-400/[0.06] px-2 py-1 text-rose-200">fail {summary.failed}</span>
                  </div>
                  <div className={`mt-3 grid min-w-0 gap-2 ${group === 'pipeline_chain' || group === 'daily' || group === 'weekly' ? 'lg:grid-cols-2' : ''}`}>
                    {groupJobs.map((job) => <SchedulerJobRow key={job.id} job={job} compact={group !== 'pipeline_chain'} />)}
                  </div>
                </>
              ) : (
                <div className="mt-3 rounded-xl border border-amber-400/15 bg-amber-400/[0.05] p-2 text-xs leading-5 text-amber-100">
                  Runtime 狀態等待 `/api/scheduler/status`；此卡只提示預期 job universe，不當作執行結果。
                </div>
              )}
              {!hasRuntimeJobs && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {meta.examples.map((label) => (
                    <span key={`${group}-${label}`} className="max-w-full truncate rounded-full border border-[#2f3c4c] bg-[#171d27] px-2 py-1 text-[11px] font-semibold text-[#dbeafe]" style={{ borderColor: `${toneColor(meta.tone)}55`, color: toneColor(meta.tone) }}>
                      {label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-xs leading-5 text-[#8b9bab]">
        上方 readiness flow 是把主鏈濃縮成 operator 需要看的 6 個放行階段；這裡保留完整 scheduler 拓撲，非 daily-chain 的盤中、週度、月度任務不混進 daily readiness 判斷。Runtime 資料仍以 `/api/scheduler/status` 為唯一狀態來源。
      </p>
    </div>
  )
}

function CriticalSchedulerErrors({ jobs }: { jobs: SchedulerJob[] }) {
  const failed = jobs
    .filter((job) => schedulerHasRootCause(job))
    .sort((a, b) => {
      const aTime = a.lastRunAt ? Date.parse(a.lastRunAt) : 0
      const bTime = b.lastRunAt ? Date.parse(b.lastRunAt) : 0
      return bTime - aTime
    })
    .slice(0, 6)

  if (!failed.length) return null

  return (
    <div className="mt-3 rounded-2xl border border-rose-400/25 bg-[linear-gradient(135deg,rgba(127,29,29,0.18),rgba(15,21,29,0.96)_42%,rgba(7,10,16,0.98))] p-3 shadow-[0_0_34px_rgba(244,63,94,0.08)]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-rose-300" />
          <p className="text-sm font-semibold text-[#f8efe0]">Critical Scheduler Errors / 錯誤追蹤</p>
        </div>
        <WorkstationPill tone="error">{failed.length} failed rows</WorkstationPill>
      </div>
      <div className="space-y-2">
        {failed.map((job) => (
          <div key={job.id} className="grid gap-3 rounded-2xl border border-rose-400/20 bg-[#070a10]/90 p-3 text-xs leading-5 xl:grid-cols-[minmax(180px,0.7fr)_minmax(0,1.15fr)_minmax(0,1.25fr)_minmax(0,1fr)_88px]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <WorkstationPill tone="error">{schedulerStatusLabel(job.lastStatus)}</WorkstationPill>
                <p className="truncate text-base font-semibold text-[#f8efe0]">{job.name}</p>
              </div>
              <p className="mt-1 truncate sv-num text-[11px] normal-case text-[#71839a]">{job.group} / {job.schedule}</p>
              <p className="mt-2 sv-num text-[11px] normal-case text-[#9badbf]">發生 {job.lastRun || '-'} · {job.lastDuration || '-'}</p>
            </div>
            <p className="min-w-0 text-[#a9d7ff]">
              <span className="font-semibold text-[#f8efe0]">狀態紀錄：</span>{schedulerStatusLog(job)}
            </p>
            <p className="min-w-0 text-rose-200">
              <span className="font-semibold text-[#f8efe0]">Root cause：</span>{schedulerRootCause(job)}
            </p>
            <p className="min-w-0 text-[#c5d3e2]">
              <span className="font-semibold text-[#f8efe0]">可能影響：</span>{schedulerImpact(job)}
            </p>
            <a href="/scheduler" className="inline-flex items-start justify-end gap-1 sv-num text-[11px] normal-case text-sky-200 hover:text-sky-100">
              Drilldown <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        ))}
      </div>
    </div>
  )
}

function OperationalReadinessDeck({
  jobs,
  checks,
  schedulerScore,
  dataQualityScore,
  deployScore,
  reportDate,
  deployDecision,
  apiErrors,
}: {
  jobs: SchedulerJob[]
  checks: DataQualityCheck[]
  schedulerScore: number
  dataQualityScore: number
  deployScore: number
  reportDate?: string
  deployDecision?: string
  apiErrors: Array<{ label: string; message: string }>
}) {
  const stages = READINESS_STAGES.map((stage) => stageFromDefinition(stage, jobs))
  const gates = buildReadinessGates(checks)
  const blockedStages = stages.filter((stage) => stage.status === 'blocked')
  const waitingStages = stages.filter((stage) => stage.status === 'waiting' || stage.status === 'running')
  const blockedGates = gates.filter((gate) => gate.status === 'blocked')
  const waitingGates = gates.filter((gate) => gate.status === 'waiting' || gate.status === 'pending')
  const score = Math.round((schedulerScore * 0.32) + (dataQualityScore * 0.48) + (deployScore * 0.20))
  const hasApiError = apiErrors.length > 0
  const authBlocked = hasApiError && apiErrors.every((item) => item.message.toLowerCase().includes('unauthorized'))
  const decisionTone: WorkstationTone = hasApiError || blockedStages.length || blockedGates.length || deployDecision === 'BLOCK'
    ? 'error'
    : waitingStages.length || waitingGates.length || deployDecision === 'WARN'
      ? 'warn'
      : 'ok'
  const currentStage = blockedStages[0] ?? waitingStages[0] ?? stages.find((stage) => stage.status !== 'ready')

  return (
    <div className="border-b border-[#263247] bg-[#080b11] p-3">
      <div className="grid gap-3">
        <div className="rounded-2xl border border-[#2b3a49] bg-[radial-gradient(circle_at_18%_0%,rgba(0,210,255,0.13),transparent_32%),linear-gradient(135deg,#10141d,#0b1118_58%,#141109)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <WorkstationPill tone={decisionTone}>{authBlocked ? 'AUTH REQUIRED' : hasApiError ? 'API OFFLINE' : deployDecision ?? readinessLabel(currentStage?.status ?? 'ready')}</WorkstationPill>
                <WorkstationPill tone="info">report {reportDate ?? 'latest'}</WorkstationPill>
              </div>
              <h3 className="mt-3 font-['Space_Grotesk'] text-2xl font-semibold text-[#f8efe0]">Readiness-gated Chain Control</h3>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-[#a8b6c5]">
                用資料 freshness 與 scheduler callback 決定是否放行，不靠固定晚上十點硬跑。錯誤細節集中在下方分組 scheduler rows，不再重複維護另一份阻塞清單。
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <ReadinessGauge score={score} tone={decisionTone} />
              <div className="grid gap-2 sv-num text-[11px] normal-case text-[#9badbf]">
                <span>Scheduler {Math.round(schedulerScore || 0)}%</span>
                <span>Data Quality {dataQualityScore}%</span>
                <span>Deploy Gate {deployScore}%</span>
              </div>
            </div>
          </div>

          <div className="mt-4 grid gap-2 md:grid-cols-3">
            <div className="rounded-2xl border border-sky-400/20 bg-sky-400/[0.06] p-3">
              <div className="flex items-center gap-2 text-sky-200">
                <RadioTower className="h-4 w-4" />
                <p className="text-sm font-semibold">目前階段</p>
              </div>
              <p className="mt-2 text-lg font-semibold text-[#f2ead8]">{currentStage?.label ?? '全段 ready'}</p>
              <p className="mt-1 text-xs leading-5 text-[#9badbf]">
                {authBlocked
                  ? '請先登入；未取得 admin token 時 OBS 只能顯示靜態結構，不能判斷 runtime。'
                  : hasApiError
                    ? '先修 API / auth / CORS 連線；UI 目前只顯示 local preview skeleton。'
                    : currentStage?.nextAction ?? '等待下一個交易日流程。'}
              </p>
            </div>
            <div className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] p-3">
              <div className="flex items-center gap-2 text-amber-200">
                <TimerReset className="h-4 w-4" />
                <p className="text-sm font-semibold">建議節奏</p>
              </div>
              <p className="mt-2 text-lg font-semibold text-[#f2ead8]">18:10 refresh → readiness polling → pipeline</p>
              <p className="mt-1 text-xs leading-5 text-[#9badbf]">資料晚到就等資料；超過 SLA 才 fallback 到原本 22:00 chain。</p>
            </div>
            <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.06] p-3">
              <div className="flex items-center gap-2 text-emerald-200">
                <CheckCircle2 className="h-4 w-4" />
                <p className="text-sm font-semibold">資料閘門</p>
              </div>
              <p className="mt-2 text-lg font-semibold text-[#f2ead8]">{gates.filter((gate) => gate.status === 'ready').length}/{gates.length} ready</p>
              <p className="mt-1 text-xs leading-5 text-[#9badbf]">只要 critical gate 未 ready，下游推薦不應直接更新。</p>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-3 2xl:grid-cols-[minmax(0,1fr)_minmax(560px,0.95fr)]">
        <div className="rounded-2xl border border-[#2b3a49] bg-[#0f151d] p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Workflow className="h-4 w-4 text-sky-300" />
              <p className="text-sm font-semibold text-[#f2ead8]">Readiness Flow / 放行路徑</p>
            </div>
            <WorkstationPill tone="neutral">scrollable</WorkstationPill>
          </div>
          <ReadinessFlowMap stages={stages} />
          <SchedulerShortcutDeck jobs={jobs} />
        </div>
        <div className="rounded-2xl border border-[#2b3a49] bg-[#0f151d] p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-emerald-300" />
              <p className="text-sm font-semibold text-[#f2ead8]">Source Gates / 資料就緒</p>
            </div>
            <a href="/data-quality" className="inline-flex items-center gap-1 sv-num text-[11px] normal-case text-emerald-200 hover:text-emerald-100">
              Data Quality <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <ReadinessGateMatrix gates={gates} />
        </div>
      </div>

      <div className="mt-3">
        <SchedulerInventoryPanel jobs={jobs} />
      </div>
    </div>
  )
}

function DataQualityPanel({ checks }: { checks: DataQualityCheck[] }) {
  if (!checks.length) return <div className="p-4 text-sm text-slate-500">目前沒有 data quality checks。</div>
  const sortedChecks = [...checks].sort((a, b) => {
    const rank = (status: string) => status === 'fail' ? 0 : status === 'warn' ? 1 : 2
    return rank(a.status) - rank(b.status) || a.id.localeCompare(b.id)
  })
  const gates: ReadinessGate[] = sortedChecks.map((check) => {
    const status = gateStatusFromQuality(check.status)
    return {
      id: check.id,
      label: check.label,
      status,
      tone: readinessTone(status),
      value: check.status.toUpperCase(),
      source: 'data-quality report',
      detail: check.summary,
      latestDate: null,
    }
  })
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-[#263247] bg-[#05070c] p-2">
      <DataQualityCompactMatrix gates={gates} />
    </div>
  )
}

function fmtNumber(value: unknown, digits = 4) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(digits) : '-'
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function scoreDelta(historyTail: unknown) {
  if (!Array.isArray(historyTail) || historyTail.length < 2) return '-'
  const prev = Number(asRecord(historyTail[historyTail.length - 2]).best_score)
  const last = Number(asRecord(historyTail[historyTail.length - 1]).best_score)
  if (!Number.isFinite(prev) || !Number.isFinite(last)) return '-'
  const delta = last - prev
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`
}

function summarizeLearnedPolicy(policy: Record<string, unknown>) {
  const allocation = asRecord(asRecord(policy.allocation).weights)
  const bull = asRecord(allocation.bull)
  const risk = asRecord(policy.riskOverlay)
  const scoring = asRecord(policy.scoring)
  const parts = [
    bull.trend_following != null ? `bull trend=${fmtNumber(bull.trend_following, 2)}` : null,
    bull.breakout_volatility_expansion != null ? `breakout=${fmtNumber(bull.breakout_volatility_expansion, 2)}` : null,
    risk.highVolThreshold != null ? `highVol=${fmtNumber(risk.highVolThreshold, 3)}` : null,
    scoring.buyThreshold != null ? `buy=${fmtNumber(scoring.buyThreshold, 2)}` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' / ') : 'learned params not exposed'
}

function AdaptiveMetaPanel({
  events,
  onGaReview,
  gaReviewPending = false,
  gaReviewError,
}: {
  events: ObservabilityEvent[]
  onGaReview?: (action: 'request' | 'approve' | 'reject', level: 'L3' | 'L4') => void
  gaReviewPending?: boolean
  gaReviewError?: string | null
}) {
  const adaptive = events.find((event) => event.domain === 'adaptive_meta' && event.source === 'adaptive_params')
  const ga = events.find((event) => event.domain === 'adaptive_meta' && event.source === 'ga_optimizer')
  const evidence = asRecord(adaptive?.evidence)
  const threshold = asRecord(evidence.threshold_components)
  const thresholdInputs = asRecord(threshold.inputs)
  const bandit = asRecord(evidence.bandit_context)
  const linucbLedger = asRecord(bandit.linucb_reward_ledger)
  const expandedContext = asRecord(bandit.expanded_context)
  const gaEvidence = asRecord(ga?.evidence)
  const promotion = asRecord(gaEvidence.promotion)
  const bestMetrics = asRecord(gaEvidence.best_metrics)
  const learnedPolicy = asRecord(gaEvidence.learned_alpha_framework)
  const historyTail = gaEvidence.history_tail
  const gaLearningUpdatedAt = String(gaEvidence.learning_updated_at ?? ga?.ts ?? '-')
  const gaRunPopulation = gaEvidence.run_population_size ?? gaEvidence.population_size
  const gaRunGenerations = gaEvidence.run_generations ?? gaEvidence.generations
  const requiredEvidence = Array.isArray(promotion.requiredEvidence)
    ? promotion.requiredEvidence.map(String)
    : Array.isArray(promotion.required_evidence)
      ? promotion.required_evidence.map(String)
      : []
  const missingEvidence = Array.isArray(promotion.missingEvidence)
    ? promotion.missingEvidence.map(String)
    : Array.isArray(promotion.missing_evidence)
      ? promotion.missing_evidence.map(String)
      : []
  const pendingApprovalRaw = String(promotion.pendingApprovalLevel ?? promotion.pending_approval_level ?? '').toUpperCase()
  const pendingApprovalLevel = (pendingApprovalRaw === 'L3' || pendingApprovalRaw === 'L4' ? pendingApprovalRaw : '') as '' | 'L3' | 'L4'
  const canRequestNextLevel = promotion.canRequestNextLevel === true || promotion.can_request_next_level === true
  const nextLevel = (String(promotion.nextLevel ?? promotion.next_level ?? 'L3').toUpperCase() === 'L4' ? 'L4' : 'L3') as 'L3' | 'L4'
  const gaNextAction = String(promotion.nextAction ?? ga?.next_action ?? '')
  const approvalRequiredForNextLevel =
    promotion.approvalRequiredForNextLevel === true || promotion.approval_required_for_next_level === true
  const l3Blockers = missingEvidence.length
    ? missingEvidence
    : canRequestNextLevel && approvalRequiredForNextLevel
      ? ['Wei approval']
      : pendingApprovalLevel
        ? [`pending ${pendingApprovalLevel}`]
        : ['keep collecting GA history']
  const metaLearners: Array<[string, string, string, string]> = []
  const tone = severityTone(adaptive?.severity ?? ga?.severity)

  return (
    <WorkstationPanel title="Adaptive / Meta Evidence" kicker="threshold, bandit, GA">
      <div className="grid gap-3 p-3 xl:grid-cols-3">
        <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="sv-num text-[10px] normal-case text-[#70809b]">Threshold Policy</p>
            <WorkstationPill tone={tone}>{adaptive?.status ?? 'missing'}</WorkstationPill>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div>
              <p className="text-slate-500">effective delta</p>
              <p className="sv-num text-lg text-sky-200">{fmtNumber(threshold.effective_delta ?? evidence.confidence_delta)}</p>
            </div>
            <div>
              <p className="text-slate-500">regime</p>
              <p className="sv-num text-lg text-slate-100">{String(thresholdInputs.regime ?? asRecord(evidence.provenance).regime ?? '-')}</p>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-slate-400">
            <span>risk {fmtNumber(threshold.risk_penalty)}</span>
            <span>model {fmtNumber(threshold.model_quality_penalty)}</span>
            <span>vol {fmtNumber(threshold.volatility_penalty)}</span>
            <span>credit {fmtNumber(Number(threshold.regime_opportunity_credit ?? 0) + Number(threshold.trend_quality_credit ?? 0))}</span>
          </div>
        </div>

        <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="sv-num text-[10px] normal-case text-[#70809b]">LinUCB Guard</p>
            <WorkstationPill tone={bandit.decision ? 'ok' : 'warn'}>{String(bandit.decision ?? 'missing')}</WorkstationPill>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <div>
              <p className="text-slate-500">max mult</p>
              <p className="sv-num text-lg text-emerald-300">{fmtNumber(evidence.bandit_max_mult, 2)}</p>
            </div>
            <div>
              <p className="text-slate-500">loss rate</p>
              <p className="sv-num text-lg text-amber-200">{bandit.loss_rate == null ? '-' : `${fmtNumber(bandit.loss_rate, 2)}`}</p>
            </div>
            <div>
              <p className="text-slate-500">samples</p>
              <p className="sv-num text-lg text-slate-100">{String(bandit.total_5d ?? '-')}</p>
            </div>
          </div>
          <div className="mt-3 rounded-lg border border-[#263247] bg-[#070a10] p-2 text-[11px] leading-5 text-slate-300">
            <div className="flex flex-wrap items-center gap-2">
              <WorkstationPill tone={linucbLedger.reward_ledger_status === 'updated' ? 'ok' : 'warn'}>
                ledger {String(linucbLedger.reward_ledger_status ?? 'missing')}
              </WorkstationPill>
              <span>arms {String(linucbLedger.arm_count ?? '-')}</span>
              <span>samples {String(linucbLedger.total_samples ?? linucbLedger.source_rows ?? '-')}</span>
              <span>ctx {String(expandedContext.version ?? linucbLedger.context_version ?? '-')}</span>
            </div>
            <p className="mt-2 text-[#70809b]">
              LinUCB reward ledger 由 post-verify chain 自動刷新；手動刷新只用於補跑或修復。NeuralUCB / NeuralTS 只使用這些 evidence 做 shadow 訓練，不直接改 production。
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="sv-num text-[10px] normal-case text-[#70809b]">GA Promotion</p>
            <WorkstationPill tone={severityTone(ga?.severity)}>{String(promotion.level ?? 'L0')}</WorkstationPill>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div>
              <p className="text-slate-500">status</p>
              <p className="sv-num text-lg text-slate-100">{String(promotion.status ?? ga?.status ?? '-')}</p>
            </div>
            <div>
              <p className="text-slate-500">next</p>
              <p className="sv-num text-lg text-amber-200">{String(promotion.nextLevel ?? '-')}</p>
            </div>
            <div>
              <p className="text-slate-500">L3 request</p>
              <p className={`sv-num text-lg ${canRequestNextLevel || pendingApprovalLevel ? 'text-emerald-300' : 'text-slate-100'}`}>
                {pendingApprovalLevel ? `pending ${pendingApprovalLevel}` : canRequestNextLevel ? 'ready for approval' : 'not ready'}
              </p>
            </div>
            <div>
              <p className="text-slate-500">best score</p>
              <p className="sv-num text-lg text-emerald-300">{fmtNumber(gaEvidence.best_score, 4)}</p>
            </div>
            <div>
              <p className="text-slate-500">score delta</p>
              <p className="sv-num text-lg text-sky-200">{scoreDelta(historyTail)}</p>
            </div>
            <div className="col-span-2">
              <p className="text-slate-500">last learned</p>
              <p className="sv-num text-sm text-slate-100">{gaLearningUpdatedAt}</p>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-slate-400">
            <span>run population {String(gaRunPopulation ?? '-')}</span>
            <span>run generations {String(gaRunGenerations ?? '-')}</span>
            <span>history {String(gaEvidence.history_count ?? '-')}</span>
            <span>PBO {fmtNumber(bestMetrics.pbo, 3)}</span>
            <span>MDD95 {fmtNumber(bestMetrics.mdd_95th, 3)}</span>
            <span>Sharpe {fmtNumber(bestMetrics.sharpe, 2)}</span>
          </div>
          <div className="mt-3 rounded-lg border border-[#263247] bg-[#070a10] p-2 text-[11px] leading-5 text-slate-300">
            <p className="font-semibold text-slate-100">L3 gate evidence</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {(requiredEvidence.length ? requiredEvidence : ['policy_candidate', 'primary_gate', 'stable_history', 'pbo_mc_cost_governance']).map((item) => (
                <WorkstationPill key={item} tone={missingEvidence.includes(item) ? 'warn' : 'ok'}>
                  {item} {missingEvidence.includes(item) ? 'missing' : 'ok'}
                </WorkstationPill>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <span className="text-[#70809b]">L3 blockers:</span>
              {l3Blockers.map((item) => (
                <WorkstationPill key={item} tone={item === 'Wei approval' || item.startsWith('pending') ? 'warn' : 'info'}>
                  {item}
                </WorkstationPill>
              ))}
            </div>
            <p className="mt-2 text-[#9badbf]">{gaNextAction || 'GA promotion state has not exposed a next action yet.'}</p>
          </div>
          <p className="mt-3 rounded-lg border border-[#263247] bg-[#070a10] p-2 text-[11px] leading-5 text-slate-300">
            learned policy: {summarizeLearnedPolicy(learnedPolicy)}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <WorkstationPill tone={gaEvidence.mutates_trading_config === false ? 'ok' : 'error'}>
              config mutate {gaEvidence.mutates_trading_config === false ? 'blocked' : 'unknown'}
            </WorkstationPill>
            <WorkstationPill tone={approvalRequiredForNextLevel ? 'warn' : 'ok'}>
              approval {approvalRequiredForNextLevel ? 'required' : 'not yet'}
            </WorkstationPill>
          </div>
          <div className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/[0.05] p-2 text-[11px] leading-5 text-amber-100">
            <p className="font-semibold text-amber-200">GA 學習節奏</p>
            <p>weekly 會跑小型 GA sweep（目前 12 population / 4 generations），monthly 會跑較大型 sweep（目前 36 / 12）。這些數字是單次 run 設定，不是累積進度；是否持續學習要看 last learned、history 與 best score 是否更新。L3/L4 仍需 approval gate，通過前不寫入 production trading config。</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {canRequestNextLevel && !pendingApprovalLevel && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!onGaReview || gaReviewPending}
                  className="h-7 rounded-full border-amber-400/30 px-3 text-[11px] text-amber-200 hover:bg-amber-400/10"
                  onClick={() => onGaReview?.('request', nextLevel)}
                >
                  {gaReviewPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                  Request {nextLevel} review
                </Button>
              )}
              {pendingApprovalLevel && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!onGaReview || gaReviewPending}
                    className="h-7 rounded-full border-emerald-400/30 px-3 text-[11px] text-emerald-200 hover:bg-emerald-400/10"
                    onClick={() => onGaReview?.('approve', pendingApprovalLevel)}
                  >
                    {gaReviewPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                    Approve {pendingApprovalLevel}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!onGaReview || gaReviewPending}
                    className="h-7 rounded-full border-rose-400/30 px-3 text-[11px] text-rose-200 hover:bg-rose-400/10"
                    onClick={() => onGaReview?.('reject', pendingApprovalLevel)}
                  >
                    Reject {pendingApprovalLevel}
                  </Button>
                </>
              )}
              <a href="/strategy-lab" className="inline-flex items-center gap-1 sv-num text-[10px] normal-case text-amber-200 hover:text-amber-100">
                Review GA candidate <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            {gaReviewError && <p className="mt-2 text-rose-200">{gaReviewError}</p>}
          </div>
        </div>
      </div>
      <div className="border-t border-[#263247] p-3">
        <div className="grid gap-2 xl:grid-cols-5">
          {metaLearners.map(([name, description, stage, evidenceNeed]) => (
            <div key={String(name)} className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="sv-num text-[10px] normal-case text-[#70809b]">{String(name)}</p>
                <WorkstationPill tone={stage === 'production baseline' ? 'ok' : stage === 'research only' ? 'warn' : 'info'}>
                  {String(stage)}
                </WorkstationPill>
              </div>
              <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-300">{String(description)}</p>
              <p className="mt-2 text-[11px] leading-5 text-slate-500">needs: {String(evidenceNeed)}</p>
            </div>
          ))}
          {!metaLearners.length && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5 text-amber-200 xl:col-span-5">
              Meta learner research cards are owned by Strategy Lab / Model Pool. OBS only shows operational evidence: threshold policy, LinUCB ledger, and GA promotion health.
            </div>
          )}
        </div>
      </div>
    </WorkstationPanel>
  )
}

function schedulerStatusLog(job: SchedulerJob) {
  if (job.summary) return job.summary
  if (job.lastStatus === 'success') return '已完成，產物可供後續流程使用。'
  if (job.lastStatus === 'waiting') return '等待前序 stage callback 完成。'
  if (job.lastStatus === 'sleep') return '今天不是此排程的執行日。'
  if (job.lastStatus === 'skip') return '被交易日曆、holiday policy 或執行條件跳過。'
  if (job.lastStatus === 'running') return '執行中，等待 final callback。'
  return job.lastRun ? `最近執行：${job.lastRun}` : '-'
}

function schedulerHasRootCause(job: SchedulerJob) {
  const status = String(job.lastStatus ?? '').toLowerCase()
  if (job.lastError) return true
  if (status === 'failed' || status === 'error') return true
  return Boolean(job.durationConcern && job.durationConcern !== 'expected_short')
}

function schedulerRootCause(job: SchedulerJob) {
  if (job.lastError) return job.lastError
  if (job.durationConcern && job.durationConcern !== 'expected_short') {
    return job.durationConcernReason || job.summary || job.durationConcern
  }
  if (schedulerHasRootCause(job) && job.summary) return job.summary
  if (job.lastStatus === 'waiting') return '等待前序 stage callback 完成。'
  if (job.lastStatus === 'sleep') return '今天不是此排程的執行日。'
  if (job.lastStatus === 'skip') return '沒有今日 run log，或被交易日曆 / policy 跳過。'
  return '-'
}

function schedulerImpact(job: SchedulerJob) {
  if (job.lastStatus === 'success') return '下游可使用此階段產物。'
  if (job.lastStatus === 'running') return '下游仍在等待；若超過 SLA，推薦、驗證或報表可能延遲。'
  if (job.lastStatus === 'waiting') return '目前等待前序 callback，不應手動跳階段。'
  if (job.lastStatus === 'failed') {
    if (job.id === 'evening-chain' || job.id === 'indicator-queue') return '價格、籌碼或技術指標可能不完整，後續推薦不可完全信任。'
    if (job.id === 'pipeline' || job.id === 'ml-predict' || job.id === 'recommendation') return 'AI Top Picks、ML 權重與 daily recommendation 可能仍是舊資料。'
    if (job.id === 'verify-v2' || job.id === 'model-ic-tracker') return 'IC、lifecycle、promotion/live gate evidence 會延遲更新。'
    return '相關下游資料可能 stale，需先修復此 scheduler。'
  }
  if (job.lastStatus === 'sleep') return '非今日執行項目，不影響今日 pipeline。'
  return '若今天應執行，請檢查 Scheduler job 或 holiday policy。'
}

export default function ObservabilityPage() {
  const scheduler = useQuery({ queryKey: ['obs', 'scheduler'], queryFn: schedulerApi.status, refetchInterval: 60_000, staleTime: 30_000 })
  const dataQuality = useQuery({ queryKey: ['obs', 'data-quality'], queryFn: () => dataQualityApi.status(), refetchInterval: 60_000, staleTime: 30_000 })
  const deployGate = useQuery({ queryKey: ['obs', 'deploy-gate'], queryFn: () => deployGateApi.predeploy(), refetchInterval: 60_000, staleTime: 30_000 })
  const system = useQuery({ queryKey: ['obs', 'system'], queryFn: systemApi.status, refetchInterval: 60_000, staleTime: 30_000 })
  const observability = useQuery({ queryKey: ['obs', 'events'], queryFn: () => observabilityApi.events(), refetchInterval: 60_000, staleTime: 30_000 })
  const gaReview = useMutation({
    mutationFn: ({ action, level }: { action: 'request' | 'approve' | 'reject'; level: 'L3' | 'L4' }) =>
      observabilityApi.reviewGaPromotion({ action, level, reason: `obs_ui_${action}` }),
    onSuccess: () => {
      observability.refetch()
    },
  })

  const events = observability.data?.events ?? []
  const jobs = scheduler.data?.jobs ?? []
  const dqChecks = dataQuality.data?.checks ?? []
  const schedulerScore = Number(scheduler.data?.stats?.successRate7d ?? 0)
  const dataQualityScore = computeDataQualityScore(dataQuality.data)
  const deployScore = deployGate.data ? deployGate.data.decision === 'PASS' ? 100 : deployGate.data.decision === 'WARN' ? 70 : 30 : 0
  const failedChecks = dqChecks.filter((check) => check.status === 'fail').length
  const initialLoading = [scheduler, dataQuality, deployGate, system, observability].some((query) => query.isLoading)
  const apiErrors = [
    { label: 'Scheduler API', message: errorMessage(scheduler.error) },
    { label: 'Data Quality API', message: errorMessage(dataQuality.error) },
    { label: 'Deploy Gate API', message: errorMessage(deployGate.error) },
    { label: 'OBS Events API', message: errorMessage(observability.error) },
    { label: 'System API', message: errorMessage(system.error) },
  ].filter((item): item is { label: string; message: string } => Boolean(item.message))

  return (
    <AppShell>
      <div className="relative min-h-[70vh] p-4 lg:p-5">
        {initialLoading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#05070c]/95 backdrop-blur-sm">
            <div className="rounded-xl border border-[#263247] bg-[#070a10] px-5 py-4 text-center shadow-xl">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-sky-300" />
              <p className="mt-3 sv-num text-[11px] normal-case text-sky-200">Loading OBS evidence</p>
              <p className="mt-1 text-xs text-slate-500">scheduler / data quality / deploy gate / model events</p>
            </div>
          </div>
        )}
        <div className={`space-y-4 ${initialLoading ? 'pointer-events-none opacity-0' : 'opacity-100 transition-opacity duration-300'}`}>
        <WorkstationPageTitle
          kicker="Observability"
          title="OBS 可觀測中心"
          description="用事件、時間、count、SLO 與 drilldown CTA 回答：哪裡壞、多久了、影響哪一層。"
          action={
            <div className="flex flex-wrap gap-2">
              <WorkstationPill tone={statusTone(dataQuality.data?.overall)}>DQ {formatStatus(dataQuality.data?.overall)}</WorkstationPill>
              <WorkstationPill tone={statusTone(deployGate.data?.decision)}>Gate {formatStatus(deployGate.data?.decision)}</WorkstationPill>
              <WorkstationPill tone={severityTone(observability.data?.overall)}>OBS {formatStatus(observability.data?.overall)}</WorkstationPill>
              <WorkstationPill tone={system.error ? 'error' : 'ok'}>System {system.error ? 'ERROR' : 'ONLINE'}</WorkstationPill>
            </div>
          }
        />

        <WorkstationPanel title="Operational Drilldown / 維運追蹤" kicker="full rows, not fake tabs">
          <OperationalReadinessDeck
            jobs={jobs}
            checks={dqChecks}
            schedulerScore={schedulerScore}
            dataQualityScore={dataQualityScore}
            deployScore={deployScore}
            reportDate={dataQuality.data?.date}
            deployDecision={deployGate.data?.decision}
            apiErrors={apiErrors}
          />
          <div className="border-b border-[#263247] p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs leading-5 text-slate-400">
                Scheduler row 直接顯示 root cause、發生時間與可能影響；OBS 不再另外維護重複的事件收件匣。
              </p>
              <div className="flex flex-wrap gap-2 text-[11px]">
                <a href="/scheduler" className="inline-flex items-center gap-1 rounded border border-sky-500/25 bg-sky-500/10 px-3 py-1.5 sv-num text-sky-200 hover:border-sky-300/50">
                  Scheduler <ExternalLink className="h-3 w-3" />
                </a>
                <a href={`/data-quality${dataQuality.data?.date ? `?date=${dataQuality.data.date}` : ''}`} className="inline-flex items-center gap-1 rounded border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 sv-num text-emerald-200 hover:border-emerald-300/50">
                  Data Quality <ExternalLink className="h-3 w-3" />
                </a>
                <a href={`/data-quality?focus=price_freshness${dataQuality.data?.date ? `&date=${dataQuality.data.date}` : ''}`} className="inline-flex items-center gap-1 rounded border border-amber-500/25 bg-amber-500/10 px-3 py-1.5 sv-num text-amber-200 hover:border-amber-300/50">
                  Price Data <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          </div>
          <div className="grid gap-3 p-3">
            <div>
              <div className="mb-2 flex items-center justify-between gap-4">
                <p className="shrink-0 whitespace-nowrap sv-num text-[10px] normal-case text-slate-400">Data Quality / 資料品質</p>
                <div className="hidden items-center gap-3 sm:flex">
                  <span className={`sv-num text-xs ${failedChecks ? 'text-rose-300' : 'text-emerald-300'}`}>{dataQualityScore}%</span>
                </div>
              </div>
              <DataQualityPanel checks={dqChecks} />
            </div>
          </div>
        </WorkstationPanel>

        <section>
          <AdaptiveMetaPanel
            events={events}
            onGaReview={(action, level) => gaReview.mutate({ action, level })}
            gaReviewPending={gaReview.isPending}
            gaReviewError={gaReview.error ? (gaReview.error as Error).message : null}
          />
        </section>
        </div>
      </div>
    </AppShell>
  )
}
