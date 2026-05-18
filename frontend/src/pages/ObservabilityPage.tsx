import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ExternalLink } from 'lucide-react'
import AppShell from '@/components/AppShell'
import ObservabilityEventTimeline from '@/components/charts/ObservabilityEventTimeline'
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

function MiniBar({ value, tone }: { value: number; tone: WorkstationTone }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
      <div className="h-full rounded-full" style={{ width: `${clamped}%`, backgroundColor: toneColor(tone) }} />
    </div>
  )
}

function Sparkline({ values, tone = 'info' }: { values: number[]; tone?: WorkstationTone }) {
  const safe = values.length ? values : [0, 0, 0, 0, 0, 0, 0]
  const max = Math.max(...safe, 1)
  const points = safe
    .map((value, index) => {
      const x = (index / Math.max(1, safe.length - 1)) * 100
      const y = 28 - (Math.max(0, value) / max) * 24
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg viewBox="0 0 100 32" className="h-8 w-full" role="img" aria-label="sparkline">
      <polyline fill="none" stroke={toneColor(tone)} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" points={points} />
    </svg>
  )
}

function MetricCell({
  label,
  value,
  tone = 'neutral',
  count,
  detail,
}: {
  label: string
  value: string
  tone?: WorkstationTone
  count?: string
  detail?: string
}) {
  return (
    <div className="border border-[#2b3a49] bg-[#070a10] p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#7f8ba0]">{label}</p>
        <WorkstationPill tone={tone}>{count ?? tone}</WorkstationPill>
      </div>
      <p className={`mt-2 text-2xl font-semibold ${tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'error' ? 'text-rose-300' : tone === 'info' ? 'text-sky-300' : 'text-slate-200'}`}>
        {value}
      </p>
      <MiniBar value={tone === 'error' ? 100 : tone === 'warn' ? 64 : tone === 'ok' ? 92 : 48} tone={tone} />
      {detail && <p className="mt-2 text-xs leading-4 text-slate-500">{detail}</p>}
    </div>
  )
}

function SchedulerRunsPanel({ jobs }: { jobs: SchedulerJob[] }) {
  if (!jobs.length) return <div className="p-4 text-sm text-slate-500">目前沒有 scheduler payload。</div>
  const sortedJobs = [...jobs].sort((a, b) => {
    const statusRank = (status: string) => status === 'failed' ? 0 : status === 'running' ? 1 : status === 'waiting' ? 2 : status === 'success' ? 3 : status === 'sleep' ? 4 : status === 'skip' ? 5 : 6
    return statusRank(a.lastStatus) - statusRank(b.lastStatus) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name)
  })
  return (
    <div className="space-y-3">
      <SchedulerExecutionMap jobs={jobs} />
      <div className="overflow-hidden rounded-xl border border-[#263247] bg-[#05070c]">
        {sortedJobs.map((job) => (
          <div key={job.id} className="grid gap-2 border-b border-[#263247] bg-[#05070c] p-2 text-xs last:border-0 xl:grid-cols-[minmax(0,1fr)_0.75fr_0.7fr_120px]">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <WorkstationPill tone={statusTone(job.lastStatus)}>{schedulerStatusLabel(job.lastStatus)}</WorkstationPill>
                <p className="truncate text-sm font-semibold text-slate-100">{job.name}</p>
              </div>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[#70809b]">{job.group} / {job.schedule}</p>
            </div>
            <div className="min-w-0 font-mono text-slate-400">
              <p>發生 {job.lastRun || '-'}</p>
              <p className="text-slate-600">next {job.nextRun || '-'}</p>
            </div>
            <div className="min-w-0 font-mono text-slate-400">
              <p>{job.lastDuration || '-'}</p>
              <p className="text-slate-600">7d {job.rate7d || '-'}</p>
            </div>
            <a href="/scheduler" className="inline-flex items-center justify-end gap-1 self-start font-mono text-[10px] uppercase tracking-[0.14em] text-sky-200 hover:text-sky-100">
              Drilldown <ExternalLink className="h-3 w-3" />
            </a>
            <div className={`xl:col-span-4 grid gap-2 rounded-lg border border-[#263247] bg-[#070a10] p-2 text-xs leading-5 ${schedulerHasRootCause(job) ? 'md:grid-cols-3' : 'md:grid-cols-1'}`}>
              <p className="text-slate-400">
                <span className="font-semibold text-slate-200">狀態紀錄：</span>{schedulerStatusLog(job)}
              </p>
              {schedulerHasRootCause(job) && (
                <>
                  <p className="text-rose-300">
                    <span className="font-semibold text-slate-200">Root cause：</span>{schedulerRootCause(job)}
                  </p>
                  <p className="text-slate-400">
                    <span className="font-semibold text-slate-200">可能影響：</span>{schedulerImpact(job)}
                  </p>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const SCHEDULER_FLOW = [
  { id: 'evening-chain', label: 'Chain root' },
  { id: 'indicator-queue', label: 'Indicators' },
  { id: 'screener', label: 'Screener' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'ml-predict', label: 'ML predict' },
  { id: 'recommendation', label: 'Recommendation' },
  { id: 'verify-v2', label: 'Verify' },
  { id: 'model-ic-tracker', label: 'IC tracker' },
  { id: 'linucb-reward-ledger', label: 'Reward ledger' },
  { id: 'meta-learning-shadow', label: 'Meta shadow' },
] as const

function SchedulerExecutionMap({ jobs }: { jobs: SchedulerJob[] }) {
  const jobById = new Map(jobs.map((job) => [job.id, job]))
  const stages = SCHEDULER_FLOW.map((stage) => {
    const job = jobById.get(stage.id)
    const status = String(job?.lastStatus ?? 'waiting').toLowerCase()
    return {
      ...stage,
      job,
      status,
      tone: statusTone(status),
    }
  })
  const active = stages.find((stage) => ['running', 'waiting', 'failed'].includes(stage.status)) ?? stages.find((stage) => stage.status !== 'success')
  const waiting = active ? stages.slice(stages.indexOf(active) + 1).filter((stage) => stage.status !== 'success').map((stage) => stage.label) : []

  return (
    <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">Execution dependency map / 執行依賴地圖</p>
          <p className="mt-1 text-xs text-slate-400">
            目前階段：{active?.label ?? 'complete'}；等待：{waiting.slice(0, 4).join(' -> ') || 'none'}
          </p>
        </div>
        <a href="/scheduler" className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-sky-200 hover:text-sky-100">
          Full scheduler <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      <div className="flex flex-wrap items-stretch gap-2">
        {stages.map((stage, index) => (
          <div key={stage.id} className="flex items-center gap-2">
            <div className={`min-w-[118px] rounded-lg border px-2 py-2 ${
              stage.tone === 'ok' ? 'border-emerald-500/25 bg-emerald-500/10'
                : stage.tone === 'warn' ? 'border-amber-500/25 bg-amber-500/10'
                  : stage.tone === 'error' ? 'border-rose-500/25 bg-rose-500/10'
                    : stage.tone === 'neutral' ? 'border-slate-600/30 bg-slate-800/20'
                      : 'border-sky-500/25 bg-sky-500/10'
            }`}>
              <p className="truncate text-xs font-semibold text-slate-100">{stage.label}</p>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em]" style={{ color: toneColor(stage.tone) }}>
                {schedulerStatusLabel(stage.status)}
              </p>
              <p className="mt-1 truncate font-mono text-[10px] text-slate-500">{stage.job?.lastDuration || '-'}</p>
            </div>
            {index < stages.length - 1 && <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-600" />}
          </div>
        ))}
      </div>
    </div>
  )
}

function checkScore(status: string) {
  if (status === 'ok') return 100
  if (status === 'warn') return 55
  return 0
}

function DataQualityScoreBar({ score, tone }: { score: number; tone: WorkstationTone }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0))
  return (
    <div className="min-w-[120px]">
      <div className="flex items-center justify-between font-mono text-[10px] text-slate-500">
        <span>score</span>
        <span className={tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : 'text-rose-300'}>{clamped}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div className="h-full rounded-full" style={{ width: `${clamped}%`, backgroundColor: toneColor(tone) }} />
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
  return (
    <div className="overflow-hidden rounded-xl border border-[#263247] bg-[#05070c]">
      {sortedChecks.map((check) => {
        const tone = statusTone(check.status)
        return (
          <div key={check.id} className={`grid gap-3 border-b p-2 text-xs last:border-0 xl:grid-cols-[0.75fr_minmax(0,1fr)_120px_90px] ${check.status === 'fail' ? 'border-rose-500/25 bg-rose-950/15' : check.status === 'warn' ? 'border-amber-500/25 bg-amber-950/10' : 'border-[#263247]'}`}>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <WorkstationPill tone={tone}>{check.status}</WorkstationPill>
                <p className="min-w-0 break-words text-sm font-semibold text-slate-100">{check.label}</p>
              </div>
              <p className="mt-1 break-all font-mono text-[10px] uppercase tracking-[0.12em] text-[#70809b]">{check.id}</p>
            </div>
            <p className="min-w-0 whitespace-normal break-words leading-5 text-slate-400 [overflow-wrap:anywhere]">{check.summary}</p>
            <DataQualityScoreBar score={checkScore(check.status)} tone={tone} />
            <a href={`/data-quality?focus=${check.id}`} className="inline-flex items-start justify-end gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-200 hover:text-emerald-100">
              Inspect <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )
      })}
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

function AdaptiveMetaPanel({ events }: { events: ObservabilityEvent[] }) {
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
  const metaLearners: Array<[string, string, string, string]> = []
  const tone = severityTone(adaptive?.severity ?? ga?.severity)

  return (
    <WorkstationPanel title="Adaptive / Meta Evidence" kicker="threshold, bandit, GA">
      <div className="grid gap-3 p-3 xl:grid-cols-3">
        <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">Threshold Policy</p>
            <WorkstationPill tone={tone}>{adaptive?.status ?? 'missing'}</WorkstationPill>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div>
              <p className="text-slate-500">effective delta</p>
              <p className="font-mono text-lg text-sky-200">{fmtNumber(threshold.effective_delta ?? evidence.confidence_delta)}</p>
            </div>
            <div>
              <p className="text-slate-500">regime</p>
              <p className="font-mono text-lg text-slate-100">{String(thresholdInputs.regime ?? asRecord(evidence.provenance).regime ?? '-')}</p>
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
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">LinUCB Guard</p>
            <WorkstationPill tone={bandit.decision ? 'ok' : 'warn'}>{String(bandit.decision ?? 'missing')}</WorkstationPill>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <div>
              <p className="text-slate-500">max mult</p>
              <p className="font-mono text-lg text-emerald-300">{fmtNumber(evidence.bandit_max_mult, 2)}</p>
            </div>
            <div>
              <p className="text-slate-500">loss rate</p>
              <p className="font-mono text-lg text-amber-200">{bandit.loss_rate == null ? '-' : `${fmtNumber(bandit.loss_rate, 2)}`}</p>
            </div>
            <div>
              <p className="text-slate-500">samples</p>
              <p className="font-mono text-lg text-slate-100">{String(bandit.total_5d ?? '-')}</p>
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
              LinUCB baseline 會用 reward ledger 追蹤每個 arm 的樣本與報酬；NeuralUCB / NeuralTS 只能拿這些 evidence 做 shadow 訓練，不會直接改 production。
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">GA Promotion</p>
            <WorkstationPill tone={severityTone(ga?.severity)}>{String(promotion.level ?? 'L0')}</WorkstationPill>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div>
              <p className="text-slate-500">status</p>
              <p className="font-mono text-lg text-slate-100">{String(promotion.status ?? ga?.status ?? '-')}</p>
            </div>
            <div>
              <p className="text-slate-500">next</p>
              <p className="font-mono text-lg text-amber-200">{String(promotion.nextLevel ?? '-')}</p>
            </div>
            <div>
              <p className="text-slate-500">best score</p>
              <p className="font-mono text-lg text-emerald-300">{fmtNumber(gaEvidence.best_score, 4)}</p>
            </div>
            <div>
              <p className="text-slate-500">score delta</p>
              <p className="font-mono text-lg text-sky-200">{scoreDelta(historyTail)}</p>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-slate-400">
            <span>population {String(gaEvidence.population_size ?? '-')}</span>
            <span>generations {String(gaEvidence.generations ?? '-')}</span>
            <span>history {String(gaEvidence.history_count ?? '-')}</span>
            <span>PBO {fmtNumber(bestMetrics.pbo, 3)}</span>
            <span>MDD95 {fmtNumber(bestMetrics.mdd_95th, 3)}</span>
            <span>Sharpe {fmtNumber(bestMetrics.sharpe, 2)}</span>
          </div>
          <p className="mt-3 rounded-lg border border-[#263247] bg-[#070a10] p-2 text-[11px] leading-5 text-slate-300">
            learned policy: {summarizeLearnedPolicy(learnedPolicy)}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <WorkstationPill tone={gaEvidence.mutates_trading_config === false ? 'ok' : 'error'}>
              config mutate {gaEvidence.mutates_trading_config === false ? 'blocked' : 'unknown'}
            </WorkstationPill>
            <WorkstationPill tone={promotion.approvalRequiredForNextLevel ? 'warn' : 'ok'}>
              approval {promotion.approvalRequiredForNextLevel ? 'required' : 'not yet'}
            </WorkstationPill>
          </div>
          <div className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/[0.05] p-2 text-[11px] leading-5 text-amber-100">
            <p className="font-semibold text-amber-200">L3 晉級規則</p>
            <p>GA 會自動學習並產生 candidate，但 L3/L4 會先停在 approval gate：必須看到 fitness、PBO/MC、candidate diff 都合格，且由 Wei 審核後才允許寫入 production trading:config。</p>
            <a href="/strategy-lab" className="mt-2 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-200 hover:text-amber-100">
              Review GA candidate <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </div>
      <div className="border-t border-[#263247] p-3">
        <div className="grid gap-2 xl:grid-cols-5">
          {metaLearners.map(([name, description, stage, evidenceNeed]) => (
            <div key={String(name)} className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">{String(name)}</p>
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

function DependencyMap() {
  const nodes = [
    ['GCP Scheduler', 'trigger'],
    ['Cloud Run', 'orchestrate'],
    ['Modal', 'heavy ML'],
    ['Worker', 'callback'],
    ['D1/KV', 'state'],
    ['Frontend', 'read'],
  ]
  return (
    <div className="p-3">
      <div className="grid grid-cols-2 gap-2">
        {nodes.map(([name, role], index) => (
          <div key={name} className="rounded border border-[#263247] bg-[#05070c] p-2">
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-200">{name}</p>
              {index < nodes.length - 1 && <ArrowRight className="h-3 w-3 text-amber-300" />}
            </div>
            <p className="mt-1 text-xs text-slate-500">{role}</p>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t border-[#263247] pt-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">Execution realism watch</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {EXECUTION_REALISM_STATES.map((item) => (
            <WorkstationPill key={item} tone={item.includes('unavailable') || item.includes('stale') ? 'warn' : 'info'}>
              {item.replace(/_/g, ' ')}
            </WorkstationPill>
          ))}
        </div>
      </div>
    </div>
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
  const text = String(job.summary ?? '').toLowerCase()
  return /error|fail|failed|stale|timeout|sla|not ready|missing|incomplete|unauthorized|blocked/.test(text)
}

function schedulerRootCause(job: SchedulerJob) {
  if (job.lastError) return job.lastError
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

  const events = observability.data?.events ?? []
  const jobs = scheduler.data?.jobs ?? []
  const dqChecks = dataQuality.data?.checks ?? []
  const schedulerScore = Number(scheduler.data?.stats?.successRate7d ?? 0)
  const dataQualityScore = computeDataQualityScore(dataQuality.data)
  const deployScore = deployGate.data?.decision === 'PASS' ? 100 : deployGate.data?.decision === 'WARN' ? 70 : 30
  const failedJobs = jobs.filter((job) => job.lastStatus === 'failed').length
  const failedChecks = dqChecks.filter((check) => check.status === 'fail').length

  return (
    <AppShell>
      <div className="space-y-4 p-4 lg:p-5">
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

        <ObservabilityEventTimeline
          report={observability.data}
          loading={observability.isLoading}
          error={observability.error}
        />

        <section className="grid gap-4 xl:grid-cols-[minmax(0,4fr)_minmax(260px,1fr)]">
          <AdaptiveMetaPanel events={events} />
          <WorkstationPanel title="Dependency Map / 依賴地圖" kicker="blast radius">
            <DependencyMap />
          </WorkstationPanel>
        </section>

        <WorkstationPanel title="Operational Drilldown / 維運追蹤" kicker="full rows, not fake tabs">
          <div className="border-b border-[#263247] p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs leading-5 text-slate-400">
                Scheduler row 直接顯示 root cause、發生時間與可能影響；OBS 不再另外維護重複的事件收件匣。
              </p>
              <div className="flex flex-wrap gap-2 text-[11px]">
                <a href="/scheduler" className="inline-flex items-center gap-1 rounded border border-sky-500/25 bg-sky-500/10 px-3 py-1.5 font-mono text-sky-200 hover:border-sky-300/50">
                  Scheduler <ExternalLink className="h-3 w-3" />
                </a>
                <a href={`/data-quality${dataQuality.data?.date ? `?date=${dataQuality.data.date}` : ''}`} className="inline-flex items-center gap-1 rounded border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 font-mono text-emerald-200 hover:border-emerald-300/50">
                  Data Quality <ExternalLink className="h-3 w-3" />
                </a>
                <a href={`/data-quality?focus=price_freshness${dataQuality.data?.date ? `&date=${dataQuality.data.date}` : ''}`} className="inline-flex items-center gap-1 rounded border border-amber-500/25 bg-amber-500/10 px-3 py-1.5 font-mono text-amber-200 hover:border-amber-300/50">
                  Price Data <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          </div>
          <div className="grid gap-3 p-3 xl:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center justify-between gap-4">
                <p className="shrink-0 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">Scheduler Runs / 排程執行</p>
                <div className="hidden w-32 shrink-0 sm:block">
                  <Sparkline values={(jobs.length ? jobs : []).slice(0, 12).map((job) => job.lastStatus === 'success' ? 100 : job.lastStatus === 'waiting' ? 70 : job.lastStatus === 'sleep' || job.lastStatus === 'skip' ? 45 : 5)} tone={failedJobs ? 'warn' : 'ok'} />
                </div>
              </div>
              <SchedulerRunsPanel jobs={jobs} />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between gap-4">
                <p className="shrink-0 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">Data Quality / 資料品質</p>
                <div className="hidden items-center gap-3 sm:flex">
                  <span className={`font-mono text-xs ${failedChecks ? 'text-rose-300' : 'text-emerald-300'}`}>{dataQualityScore}%</span>
                  <div className="w-32 shrink-0">
                    <Sparkline values={(dqChecks.length ? dqChecks : []).slice(0, 12).map((check) => check.status === 'ok' ? 100 : check.status === 'warn' ? 55 : 5)} tone={failedChecks ? 'error' : 'ok'} />
                  </div>
                </div>
              </div>
              <DataQualityPanel checks={dqChecks} />
            </div>
          </div>
        </WorkstationPanel>
      </div>
    </AppShell>
  )
}
