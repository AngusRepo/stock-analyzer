import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, ArrowRight, Clock3, Database, ExternalLink, GitBranch, ShieldCheck } from 'lucide-react'
import AppShell from '@/components/AppShell'
import { VirtualizedList } from '@/components/performance/VirtualizedList'
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
  type ObservabilityIncident,
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

function formatObsTime(value?: string | null) {
  if (!value) return '-'
  const ts = new Date(value).getTime()
  if (!Number.isFinite(ts)) return String(value)
  return new Date(ts).toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(start?: string | null, end?: string | null) {
  const from = start ? new Date(start).getTime() : NaN
  const to = end ? new Date(end).getTime() : Date.now()
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return '-'
  const minutes = Math.round((to - from) / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function incidentTiming(incident: ObservabilityIncident, events: ObservabilityEvent[] = []) {
  const sourceEvents = events.filter((event) => incident.source_event_ids?.includes(event.id))
  const eventTimes = sourceEvents.map((event) => event.ts).filter(Boolean).sort()
  const firstSeen = incident.first_seen ?? eventTimes[0] ?? ''
  const lastSeen = incident.last_seen ?? eventTimes[eventTimes.length - 1] ?? firstSeen
  return {
    firstSeen,
    lastSeen,
    duration: formatDuration(firstSeen, lastSeen),
  }
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

function HistoryStrip({ history }: { history: Array<'success' | 'failed' | 'skip'> }) {
  const items = history.length ? history : ['skip', 'skip', 'skip', 'skip', 'skip', 'skip', 'skip']
  return (
    <div className="flex gap-1" aria-label="7 day status strip">
      {items.map((status, index) => (
        <span
          key={`${status}-${index}`}
          className={`h-2 flex-1 rounded-full ${
            status === 'success' ? 'bg-emerald-400' : status === 'failed' ? 'bg-rose-400' : 'bg-slate-700'
          }`}
        />
      ))}
    </div>
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
      {detail && <p className="mt-2 truncate text-xs text-slate-500">{detail}</p>}
    </div>
  )
}

function ScoreTile({ label, value, tone, icon }: { label: string; value: string; tone: WorkstationTone; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-slate-400">
          {icon}
          <span className="font-mono text-[10px] uppercase tracking-[0.16em]">{label}</span>
        </div>
        <WorkstationPill tone={tone}>{tone}</WorkstationPill>
      </div>
      <p className={`mt-3 font-mono text-2xl font-semibold ${tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'error' ? 'text-rose-300' : 'text-sky-300'}`}>
        {value}
      </p>
      <MiniBar value={Number.parseFloat(value) || 0} tone={tone} />
    </div>
  )
}

function ReliabilityMap({
  incidents,
  schedulerOk,
  dataQualityOk,
  deployOk,
  traceOk,
}: {
  incidents: number
  schedulerOk: number
  dataQualityOk: number
  deployOk: number
  traceOk: number
}) {
  const incidentHealth = Math.max(0, 100 - incidents * 20)
  const traceHealth = Math.min(100, traceOk * 8)
  return (
    <WorkstationPanel title="Reliability Map / 可靠度地圖" kicker="grafana style overview">
      <div className="grid gap-3 p-3 lg:grid-cols-[1fr_360px]">
        <div className="grid gap-3 md:grid-cols-4">
          <ScoreTile label="Incident Load" value={`${incidentHealth}%`} tone={incidents ? 'warn' : 'ok'} icon={<Activity className="h-4 w-4" />} />
          <ScoreTile label="Scheduler SLO" value={`${schedulerOk}%`} tone={schedulerOk >= 95 ? 'ok' : schedulerOk >= 85 ? 'warn' : 'error'} icon={<Clock3 className="h-4 w-4" />} />
          <ScoreTile label="Data Trust" value={`${dataQualityOk}%`} tone={dataQualityOk >= 90 ? 'ok' : dataQualityOk >= 70 ? 'warn' : 'error'} icon={<Database className="h-4 w-4" />} />
          <ScoreTile label="Deploy Gate" value={`${deployOk}%`} tone={deployOk >= 90 ? 'ok' : deployOk >= 60 ? 'warn' : 'error'} icon={<ShieldCheck className="h-4 w-4" />} />
        </div>
        <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">Trace Throughput</p>
            <WorkstationPill tone={traceOk ? 'ok' : 'warn'}>{traceOk} events</WorkstationPill>
          </div>
          <Sparkline values={[incidentHealth, schedulerOk, dataQualityOk, deployOk, traceHealth]} tone={incidents ? 'warn' : 'ok'} />
          <div className="mt-2 grid grid-cols-5 gap-1">
            {['Inc', 'Sch', 'DQ', 'Gate', 'Trace'].map((item) => (
              <span key={item} className="text-center font-mono text-[10px] text-slate-500">{item}</span>
            ))}
          </div>
        </div>
      </div>
    </WorkstationPanel>
  )
}

function IncidentInbox({
  incidents,
  selectedId,
  events,
  onOpen,
}: {
  incidents: ObservabilityIncident[]
  selectedId?: string
  events: ObservabilityEvent[]
  onOpen: (id: string) => void
}) {
  if (!incidents.length) {
    return (
      <div className="p-4">
        <WorkstationPill tone="ok">No active incidents / 無事件</WorkstationPill>
      </div>
    )
  }

  return (
    <div className="max-h-[420px] overflow-hidden">
      <VirtualizedList
        items={incidents}
        itemHeight={112}
        height={Math.min(420, incidents.length * 112)}
        getKey={(incident) => incident.id}
        renderItem={(incident) => {
        const timing = incidentTiming(incident, events)
        const tone = severityTone(incident.severity)
        return (
          <button
            key={incident.id}
            type="button"
            onClick={() => onOpen(incident.id)}
            aria-pressed={selectedId === incident.id}
            className={`w-full border-b border-[#263247] p-3 text-left transition-colors hover:bg-[#152033] ${
              selectedId === incident.id ? 'bg-amber-300/10' : 'bg-[#05070c]'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <WorkstationPill tone={tone}>{incident.status}</WorkstationPill>
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#70809b]">{incident.domain}</span>
                </div>
                <p className="mt-2 truncate text-sm font-semibold text-slate-100">{incident.title}</p>
                <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] text-slate-500">
                  <span>last {formatObsTime(timing.lastSeen)}</span>
                  <span>age {timing.duration}</span>
                  <span>{incident.source_event_ids?.length ?? 0} events</span>
                </div>
                <MiniBar value={tone === 'error' ? 100 : tone === 'warn' ? 65 : 35} tone={tone} />
              </div>
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-amber-200">
                查看 / Open <ArrowRight className="h-3 w-3" />
              </span>
            </div>
          </button>
        )
      }}
      />
    </div>
  )
}

function SelectedIncidentDetail({
  incident,
  fallbackEvents,
}: {
  incident?: ObservabilityIncident
  fallbackEvents: ObservabilityEvent[]
}) {
  if (!incident) {
    return (
      <div className="p-4">
        <WorkstationPill tone="ok">No selected incident / 無事件</WorkstationPill>
      </div>
    )
  }

  const timing = incidentTiming(incident, fallbackEvents)
  const tone = severityTone(incident.severity)
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">Root cause / 事件根因</p>
          <h2 className="mt-1 text-xl font-semibold text-slate-100">{incident.title}</h2>
        </div>
        <WorkstationPill tone={tone}>{incident.severity}</WorkstationPill>
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        <MetricCell label="First seen / 首次" value={formatObsTime(timing.firstSeen)} tone="info" detail="事件第一次被歸入此群組" />
        <MetricCell label="Last seen / 最新" value={formatObsTime(timing.lastSeen)} tone={incident.status === 'resolved' ? 'ok' : 'warn'} detail="判斷是不是新問題" />
        <MetricCell label="Age / 年齡" value={timing.duration} tone={incident.status === 'open' ? 'warn' : 'ok'} detail="first seen 到 last seen" />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">Root Cause</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">{incident.root_cause || '-'}</p>
        </div>
        <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-sky-200">Impact</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">{incident.impact || '-'}</p>
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        <MetricCell label="Runs" value={String(incident.run_ids?.length ?? 0)} tone="info" detail={(incident.run_ids ?? []).slice(0, 2).join(', ') || '-'} />
        <MetricCell label="Symbols" value={String(incident.affected_symbols?.length ?? 0)} tone={(incident.affected_symbols?.length ?? 0) ? 'warn' : 'ok'} detail={(incident.affected_symbols ?? []).slice(0, 4).join(', ') || '-'} />
        <MetricCell label="Next action" value={incident.status} tone={statusTone(incident.status)} detail={incident.next_action} />
      </div>
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
    <div className="overflow-hidden rounded-xl border border-[#263247] bg-[#05070c]">
      <VirtualizedList
        items={sortedJobs}
        itemHeight={88}
        height={Math.min(420, sortedJobs.length * 88)}
        getKey={(job) => job.id}
        renderItem={(job) => (
        <div className="grid gap-2 border-b border-[#263247] bg-[#05070c] p-2 text-xs last:border-0 lg:grid-cols-[1fr_0.75fr_0.7fr_120px]">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <WorkstationPill tone={statusTone(job.lastStatus)}>{schedulerStatusLabel(job.lastStatus)}</WorkstationPill>
              <p className="truncate text-sm font-semibold text-slate-100">{job.name}</p>
            </div>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[#70809b]">{job.group} / {job.schedule}</p>
            <div className="mt-2 max-w-[220px]">
              <HistoryStrip history={job.history7d ?? []} />
            </div>
          </div>
          <div className="font-mono text-slate-400">
            <p>last {job.lastRun || '-'}</p>
            <p className="text-slate-600">next {job.nextRun || '-'}</p>
          </div>
          <div className="font-mono text-slate-400">
            <p>{job.lastDuration || '-'}</p>
            <p className="text-slate-600">7d {job.rate7d || '-'}</p>
          </div>
          <a href="/scheduler" className="inline-flex items-center justify-end gap-1 self-start font-mono text-[10px] uppercase tracking-[0.14em] text-sky-200 hover:text-sky-100">
            Drilldown <ExternalLink className="h-3 w-3" />
          </a>
          {job.lastError && <p className="lg:col-span-4 text-xs leading-5 text-rose-300">{job.lastError}</p>}
        </div>
      )}
      />
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
          <div key={check.id} className={`grid gap-2 border-b p-2 text-xs last:border-0 lg:grid-cols-[0.85fr_1fr_110px] ${check.status === 'fail' ? 'border-rose-500/25 bg-rose-950/15' : check.status === 'warn' ? 'border-amber-500/25 bg-amber-950/10' : 'border-[#263247]'}`}>
            <div>
              <div className="flex items-center gap-2">
                <WorkstationPill tone={tone}>{check.status}</WorkstationPill>
                <p className="text-sm font-semibold text-slate-100">{check.label}</p>
              </div>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[#70809b]">{check.id}</p>
              <MiniBar value={check.status === 'ok' ? 96 : check.status === 'warn' ? 62 : 100} tone={tone} />
            </div>
            <p className="line-clamp-2 leading-5 text-slate-400">{check.summary}</p>
            <a href={`/data-quality?focus=${check.id}`} className="inline-flex items-start justify-end gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-200 hover:text-emerald-100">
              Inspect <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )
      })}
    </div>
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

export default function ObservabilityPage() {
  const [selectedIncidentId, setSelectedIncidentId] = useState<string>()
  const detailRef = useRef<HTMLDivElement>(null)

  const scheduler = useQuery({ queryKey: ['obs', 'scheduler'], queryFn: schedulerApi.status, refetchInterval: 60_000, staleTime: 30_000 })
  const dataQuality = useQuery({ queryKey: ['obs', 'data-quality'], queryFn: () => dataQualityApi.status(), refetchInterval: 60_000, staleTime: 30_000 })
  const deployGate = useQuery({ queryKey: ['obs', 'deploy-gate'], queryFn: () => deployGateApi.predeploy(), refetchInterval: 60_000, staleTime: 30_000 })
  const system = useQuery({ queryKey: ['obs', 'system'], queryFn: systemApi.status, refetchInterval: 60_000, staleTime: 30_000 })
  const observability = useQuery({ queryKey: ['obs', 'events'], queryFn: () => observabilityApi.events(), refetchInterval: 60_000, staleTime: 30_000 })
  const drilldown = useQuery({ queryKey: ['obs', 'drilldown'], queryFn: () => observabilityApi.drilldown(), refetchInterval: 60_000, staleTime: 30_000 })

  const incidents = drilldown.data?.incidents ?? []
  const selectedIncident = incidents.find((incident) => incident.id === selectedIncidentId) ?? incidents[0]
  const events = observability.data?.events ?? []
  const jobs = scheduler.data?.jobs ?? []
  const dqChecks = dataQuality.data?.checks ?? []
  const schedulerScore = Number(scheduler.data?.stats?.successRate7d ?? 0)
  const dataQualityScore = computeDataQualityScore(dataQuality.data)
  const deployScore = deployGate.data?.decision === 'PASS' ? 100 : deployGate.data?.decision === 'WARN' ? 70 : 30
  const failedJobs = jobs.filter((job) => job.lastStatus === 'failed').length
  const failedChecks = dqChecks.filter((check) => check.status === 'fail').length

  function openIncident(id: string) {
    setSelectedIncidentId(id)
    window.setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0)
  }

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

        <section className="grid grid-cols-1 overflow-hidden rounded-2xl border border-[#2b3a49] bg-[#2b3a49] md:grid-cols-5">
          <MetricCell label="Incidents / 事件" value={String(incidents.length)} tone={incidents.length ? 'warn' : 'ok'} count={`${events.length} events`} detail="grouped root-cause inbox" />
          <MetricCell label="Scheduler SLO / 排程" value={`${schedulerScore}%`} tone={failedJobs ? 'warn' : 'ok'} count={`${jobs.length} jobs`} detail={`${failedJobs} failed`} />
          <MetricCell label="Data Trust / 資料" value={`${dataQualityScore}%`} tone={statusTone(dataQuality.data?.overall)} count={`${dqChecks.length} checks`} detail={`${failedChecks} failed`} />
          <MetricCell label="Deploy Gate / 上線" value={formatStatus(deployGate.data?.decision)} tone={statusTone(deployGate.data?.decision)} count="gate" detail="predeploy safety" />
          <MetricCell label="Trace / 追蹤" value={String(events.length)} tone={observability.error ? 'warn' : 'info'} count="logs" detail={observability.data?.date ?? '-'} />
        </section>

        <ReliabilityMap
          incidents={incidents.length}
          schedulerOk={schedulerScore}
          dataQualityOk={dataQualityScore}
          deployOk={deployScore}
          traceOk={events.length}
        />

        <section className="grid gap-4 xl:grid-cols-[360px_1fr_300px]">
          <WorkstationPanel title="Incident Inbox / 事件收件匣" kicker="time, count, owner">
            <IncidentInbox incidents={incidents} selectedId={selectedIncident?.id} events={events} onOpen={openIncident} />
          </WorkstationPanel>

          <WorkstationPanel title="Selected Incident Detail / 事件根因" kicker="impact + next action">
            <div ref={detailRef}>
              <SelectedIncidentDetail incident={selectedIncident} fallbackEvents={events} />
            </div>
          </WorkstationPanel>

          <WorkstationPanel title="Dependency Map / 依賴地圖" kicker="blast radius">
            <DependencyMap />
          </WorkstationPanel>
        </section>

        <WorkstationPanel title="Operational Drilldown / 維運追蹤" kicker="full rows, not fake tabs">
          <div className="border-b border-[#263247] p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <WorkstationPill tone={(scheduler.data?.stats?.failed24h ?? 0) ? 'warn' : 'ok'}>{scheduler.data?.stats?.failed24h ?? 0} failed jobs</WorkstationPill>
                <WorkstationPill tone={statusTone(dataQuality.data?.overall)}>{dataQualityScore}% data trust</WorkstationPill>
                <WorkstationPill tone={events.length ? 'info' : 'warn'}>{events.length} traces</WorkstationPill>
              </div>
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
              <div className="mb-2 flex items-center justify-between">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">Scheduler Runs / 排程執行</p>
                <Sparkline values={(jobs.length ? jobs : []).slice(0, 12).map((job) => job.lastStatus === 'success' ? 100 : job.lastStatus === 'waiting' ? 70 : job.lastStatus === 'sleep' || job.lastStatus === 'skip' ? 45 : 5)} tone={failedJobs ? 'warn' : 'ok'} />
              </div>
              <SchedulerRunsPanel jobs={jobs} />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">Data Quality / 資料品質</p>
                <Sparkline values={(dqChecks.length ? dqChecks : []).slice(0, 12).map((check) => check.status === 'ok' ? 100 : check.status === 'warn' ? 55 : 5)} tone={failedChecks ? 'error' : 'ok'} />
              </div>
              <DataQualityPanel checks={dqChecks} />
            </div>
          </div>
        </WorkstationPanel>
      </div>
    </AppShell>
  )
}
