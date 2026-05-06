import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  GitBranch,
  Network,
  ShieldCheck,
  TimerReset,
} from 'lucide-react'
import AppShell from '@/components/AppShell'
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
  if (['warn', 'warning', 'watch', 'running', 'skip', 'skipped'].includes(value)) return 'warn'
  if (['fail', 'failed', 'error', 'block', 'blocked'].includes(value)) return 'error'
  return 'info'
}

function severityTone(severity?: ObservabilitySeverity | null): WorkstationTone {
  if (severity === 'error') return 'error'
  if (severity === 'warn') return 'warn'
  if (severity === 'ok') return 'ok'
  return 'info'
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

function MetricCell({
  label,
  value,
  tone = 'neutral',
  detail,
}: {
  label: string
  value: string
  tone?: WorkstationTone
  detail?: string
}) {
  return (
    <div className="border border-[#2b3a49] bg-[#070a10] p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#7f8ba0]">{label}</p>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p className={`text-2xl font-semibold ${tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'error' ? 'text-rose-300' : 'text-sky-300'}`}>
          {value}
        </p>
        <WorkstationPill tone={tone}>{tone}</WorkstationPill>
      </div>
      {detail && <p className="mt-2 text-xs leading-5 text-slate-500">{detail}</p>}
    </div>
  )
}

function MiniDonut({ value, tone, label }: { value: number; tone: WorkstationTone; label: string }) {
  const color = tone === 'ok' ? '#34d399' : tone === 'warn' ? '#fbbf24' : tone === 'error' ? '#fb7185' : '#38bdf8'
  return (
    <div className="flex items-center gap-3 border border-[#263247] bg-[#05070c] p-3">
      <div
        className="grid h-14 w-14 place-items-center rounded-full text-xs font-bold text-slate-100"
        style={{ background: `conic-gradient(${color} ${Math.max(0, Math.min(100, value))}%, #1f2937 0)` }}
      >
        <div className="grid h-10 w-10 place-items-center rounded-full bg-[#05070c]">{value}%</div>
      </div>
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">{label}</p>
        <p className="mt-1 text-xs text-slate-400">越高代表越可靠；低分請從右側 root cause 與下方 drilldown 追。</p>
      </div>
    </div>
  )
}

function HealthMap({
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
  return (
    <WorkstationPanel title="Reliability Map / 可靠度地圖" kicker="用圖像先看哪一層不可信">
      <div className="grid gap-3 p-3 lg:grid-cols-[1.2fr_1fr]">
        <div className="grid gap-3 md:grid-cols-2">
          <MiniDonut value={Math.max(0, 100 - incidents * 20)} tone={incidents ? 'warn' : 'ok'} label="Incident Load / 事件負載" />
          <MiniDonut value={schedulerOk} tone={schedulerOk >= 95 ? 'ok' : 'warn'} label="Scheduler SLO / 排程可靠度" />
          <MiniDonut value={dataQualityOk} tone={dataQualityOk >= 90 ? 'ok' : dataQualityOk >= 70 ? 'warn' : 'error'} label="Data Trust / 資料可信度" />
          <MiniDonut value={deployOk} tone={deployOk >= 90 ? 'ok' : deployOk >= 60 ? 'warn' : 'error'} label="Deploy Gate / 發版安全" />
        </div>
        <div className="border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">Dependency flow / 依賴路徑</p>
          <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-xs">
            {['GCP Scheduler', 'Cloud Run', 'Modal ML', 'Worker API', 'D1/KV', 'Frontend'].map((node, index) => (
              <div key={node} className={index % 2 === 0 ? 'contents' : 'contents'}>
                <div className="border border-[#2b3a49] bg-[#0b111b] p-2 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-200">{node}</div>
                {index < 5 && <ArrowRight className="h-4 w-4 text-amber-300" />}
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs leading-5 text-slate-400">
            OBS 的用途不是塞滿所有報表，而是回答：哪一層壞了、誰是 owner、影響哪些資料、下一步要追哪個 drilldown。
          </p>
          <WorkstationPill tone={traceOk ? 'ok' : 'warn'}>Trace events {traceOk}</WorkstationPill>
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
        <p className="mt-3 text-sm leading-6 text-slate-400">目前沒有 active incident；若有異常，會依 domain 與 owner 分組顯示。</p>
      </div>
    )
  }

  return (
    <div className="max-h-[420px] overflow-y-auto">
      {incidents.map((incident) => {
        const timing = incidentTiming(incident, events)
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
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">{incident.domain} / {incident.owner}</p>
                <p className="mt-1 text-sm font-semibold text-slate-100">{incident.title}</p>
                <p className="mt-1 font-mono text-[10px] text-slate-500">last {formatObsTime(timing.lastSeen)} · age {timing.duration}</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <WorkstationPill tone={severityTone(incident.severity)}>{incident.status}</WorkstationPill>
                <span className="font-mono text-[10px] text-amber-200">查看 / Open</span>
              </div>
            </div>
            <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-400">{incident.impact || incident.next_action}</p>
          </button>
        )
      })}
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
        <p className="mt-3 text-sm leading-6 text-slate-400">沒有 incident 時，下面列最近 OBS events，確認資料流仍在更新。</p>
        <div className="mt-3 grid gap-2">
          {fallbackEvents.slice(0, 5).map((event) => (
            <div key={event.id} className="border border-[#263247] bg-[#05070c] p-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold text-slate-100">{event.title}</p>
                <WorkstationPill tone={severityTone(event.severity)}>{event.severity}</WorkstationPill>
              </div>
              <p className="mt-1 text-xs text-slate-500">{event.domain} / {event.owner} / {event.ts}</p>
              <p className="mt-2 text-xs leading-5 text-slate-400">{event.summary}</p>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const timing = incidentTiming(incident, fallbackEvents)

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">Impact, root cause, next action / 影響、原因、下一步</p>
          <h2 className="mt-1 text-xl font-semibold text-slate-100">{incident.title}</h2>
          <p className="mt-1 text-xs text-slate-500">{incident.domain} / {incident.owner}</p>
        </div>
        <WorkstationPill tone={severityTone(incident.severity)}>{incident.severity}</WorkstationPill>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        <MetricCell label="first seen / 首次發生" value={formatObsTime(timing.firstSeen)} tone="info" detail="事件第一次被 OBS 收進同一 root-cause group" />
        <MetricCell label="last seen / 最後更新" value={formatObsTime(timing.lastSeen)} tone={incident.status === 'resolved' ? 'ok' : 'warn'} detail="判斷是不是舊 log 的主要欄位" />
        <MetricCell label="age / 持續時間" value={timing.duration} tone={incident.status === 'open' ? 'warn' : 'ok'} detail="從 first seen 到 last seen" />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">Root Cause / 根因</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">{incident.root_cause || '尚未落 root cause。'}</p>
        </div>
        <div className="border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-sky-200">Impact / 影響</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">{incident.impact || '尚未標記影響範圍。'}</p>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <MetricCell label="run ids" value={String(incident.run_ids?.length ?? 0)} tone="info" detail={(incident.run_ids ?? []).slice(0, 2).join(', ') || '-'} />
        <MetricCell label="symbols" value={String(incident.affected_symbols?.length ?? 0)} tone={(incident.affected_symbols?.length ?? 0) ? 'warn' : 'ok'} detail={(incident.affected_symbols ?? []).slice(0, 4).join(', ') || '-'} />
        <MetricCell label="status" value={incident.status} tone={statusTone(incident.status)} detail={incident.next_action} />
      </div>
    </div>
  )
}

function SchedulerRunsTab({ jobs }: { jobs: SchedulerJob[] }) {
  if (!jobs.length) return <div className="p-4 text-sm text-slate-500">目前沒有 scheduler payload。</div>
  const sortedJobs = [...jobs].sort((a, b) => {
    const statusRank = (status: string) => status === 'failed' ? 0 : status === 'running' ? 1 : status === 'skip' ? 2 : 3
    return statusRank(a.lastStatus) - statusRank(b.lastStatus) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name)
  })
  return (
    <div className="overflow-hidden border border-[#263247] bg-[#05070c]">
      {sortedJobs.map((job) => (
        <div key={job.id} className="grid gap-2 border-b border-[#263247] p-2 text-xs last:border-0 lg:grid-cols-[1.15fr_0.8fr_0.8fr_0.65fr]">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-100">{job.name}</p>
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#70809b]">{job.group} / {job.schedule}</p>
          </div>
          <div className="font-mono text-slate-400">
            <p>last {job.lastRun || '-'}</p>
            <p className="text-slate-600">next {job.nextRun || '-'}</p>
          </div>
          <div className="font-mono text-slate-400">
            <p>duration {job.lastDuration || '-'}</p>
            <p className="text-slate-600">7d {job.rate7d || '-'}</p>
          </div>
          <div className="flex items-start justify-end">
            <WorkstationPill tone={statusTone(job.lastStatus)}>{job.lastStatus}</WorkstationPill>
          </div>
          {job.lastError && <p className="lg:col-span-4 text-xs leading-5 text-rose-300">{job.lastError}</p>}
        </div>
      ))}
    </div>
  )
}

function DataQualityTab({ checks }: { checks: DataQualityCheck[] }) {
  if (!checks.length) return <div className="p-4 text-sm text-slate-500">目前沒有 data quality checks。</div>
  const sortedChecks = [...checks].sort((a, b) => {
    const rank = (status: string) => status === 'fail' ? 0 : status === 'warn' ? 1 : 2
    return rank(a.status) - rank(b.status) || a.id.localeCompare(b.id)
  })
  return (
    <div className="overflow-hidden border border-[#263247] bg-[#05070c]">
      {sortedChecks.map((check) => (
        <div key={check.id} className={`grid gap-2 border-b p-2 text-xs last:border-0 lg:grid-cols-[0.85fr_1fr_auto] ${check.status === 'fail' ? 'border-rose-500/25 bg-rose-950/15' : check.status === 'warn' ? 'border-amber-500/25 bg-amber-950/10' : 'border-[#263247]'}`}>
          <div>
            <p className="text-sm font-semibold text-slate-100">{check.label}</p>
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#70809b]">{check.id}</p>
          </div>
          <p className="leading-5 text-slate-400">{check.summary}</p>
          <div className="flex justify-start lg:justify-end">
            <WorkstationPill tone={statusTone(check.status)}>{check.status}</WorkstationPill>
          </div>
          {check.metrics && (
            <pre className="max-h-20 overflow-auto rounded border border-[#263247] bg-[#03060a] p-2 text-[10px] leading-4 text-slate-500 lg:col-span-3">
              {JSON.stringify(check.metrics, null, 2)}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}

function DependencyMap() {
  const nodes = [
    ['GCP Scheduler', 'trigger'],
    ['Cloud Run', 'orchestrate'],
    ['Modal', 'heavy ML'],
    ['Worker', 'API / callback'],
    ['D1 / KV', 'serving state'],
    ['Frontend', 'read only UI'],
  ]
  return (
    <div className="p-3">
      <div className="grid grid-cols-2 gap-2">
        {nodes.map(([name, role], index) => (
          <div key={name} className="border border-[#263247] bg-[#05070c] p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-200">{name}</p>
            <p className="mt-1 text-xs text-slate-500">{role}</p>
            {index < nodes.length - 1 && <ArrowRight className="mt-2 h-4 w-4 text-amber-300" />}
          </div>
        ))}
      </div>
    </div>
  )
}

function ExecutionRealityStrip() {
  return (
    <div className="border-t border-[#263247] p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">Execution realism watch / 下單真實性</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {['quote_unavailable', 'stale_quote', 'requote', 'partially_filled', 'expired'].map((item) => (
          <WorkstationPill key={item} tone={item.includes('quote') ? 'warn' : 'info'}>{item}</WorkstationPill>
        ))}
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-400">若報價不可用，應 fail closed；不能把 404 或昨日收盤價偽裝成暫緩理由。</p>
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
          description="先看事件、可靠度與根因，再進 Scheduler Runs 或 Data Quality drilldown；Model Pool 與資源成本不在此重複堆資料。"
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
          <MetricCell label="Incidents / 事件" value={String(incidents.length)} tone={incidents.length ? 'warn' : 'ok'} detail="grouped root-cause inbox" />
          <MetricCell label="Scheduler SLO / 排程" value={`${scheduler.data?.stats?.successRate7d ?? 0}%`} tone={(scheduler.data?.stats?.failed24h ?? 0) ? 'warn' : 'ok'} detail={`24h failed ${scheduler.data?.stats?.failed24h ?? '-'}`} />
          <MetricCell label="Data Trust / 資料" value={formatStatus(dataQuality.data?.overall)} tone={statusTone(dataQuality.data?.overall)} detail={dataQuality.data?.date ?? '-'} />
          <MetricCell label="Deploy Gate / 發版" value={formatStatus(deployGate.data?.decision)} tone={statusTone(deployGate.data?.decision)} detail="predeploy safety" />
          <MetricCell label="Trace / 事件流" value={String(events.length)} tone={observability.error ? 'warn' : 'info'} detail="recent observability events" />
        </section>

        <HealthMap
          incidents={incidents.length}
          schedulerOk={schedulerScore}
          dataQualityOk={dataQualityScore}
          deployOk={deployScore}
          traceOk={events.length}
        />

        <section className="grid gap-4 xl:grid-cols-[360px_1fr_320px]">
          <WorkstationPanel title="Incident Inbox / 事件收件匣" kicker="grouped problems, not duplicated dashboards">
            <IncidentInbox incidents={incidents} selectedId={selectedIncident?.id} events={events} onOpen={openIncident} />
          </WorkstationPanel>

          <WorkstationPanel title="Selected Incident Detail / 事件根因" kicker="impact, root cause, next action">
            <div ref={detailRef}>
              <SelectedIncidentDetail incident={selectedIncident} fallbackEvents={events} />
            </div>
          </WorkstationPanel>

          <WorkstationPanel title="Dependency Map / 依賴圖" kicker="blast radius">
            <DependencyMap />
            <ExecutionRealityStrip />
          </WorkstationPanel>
        </section>

        <WorkstationPanel title="Operational Drilldown / 維運追蹤" kicker="scheduler + data quality + next action">
          <div className="border-b border-[#263247] p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">Grafana-style panel links / 保留上下文導頁</p>
                <p className="mt-1 text-xs text-slate-400">下方直接顯示完整排程與資料品質；需要細節再點 specialist page，不做假 tab。</p>
              </div>
              <div className="flex flex-wrap gap-2 text-[11px]">
                <a href="/scheduler" className="rounded border border-sky-500/25 bg-sky-500/10 px-3 py-1.5 font-mono text-sky-200 hover:border-sky-300/50">Open Scheduler</a>
                <a href={`/data-quality${dataQuality.data?.date ? `?date=${dataQuality.data.date}` : ''}`} className="rounded border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 font-mono text-emerald-200 hover:border-emerald-300/50">Open Data Quality</a>
                <a href={`/data-quality?focus=price_data${dataQuality.data?.date ? `&date=${dataQuality.data.date}` : ''}`} className="rounded border border-amber-500/25 bg-amber-500/10 px-3 py-1.5 font-mono text-amber-200 hover:border-amber-300/50">Price Data</a>
              </div>
            </div>
          </div>
          <div className="grid gap-3 p-3 xl:grid-cols-[1fr_1fr_300px]">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">Scheduler Runs / 排程執行</p>
                <div className="flex gap-2">
                  <WorkstationPill tone={(scheduler.data?.stats?.failed24h ?? 0) ? 'warn' : 'ok'}>{scheduler.data?.stats?.failed24h ?? 0} failed</WorkstationPill>
                  <WorkstationPill tone="info">{jobs.length} jobs</WorkstationPill>
                </div>
              </div>
              <SchedulerRunsTab jobs={jobs} />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">Data Quality / 資料品質</p>
                <div className="flex gap-2">
                  <WorkstationPill tone={statusTone(dataQuality.data?.overall)}>{dataQualityScore}% trust</WorkstationPill>
                  <WorkstationPill tone="info">{dqChecks.length} checks</WorkstationPill>
                </div>
              </div>
              <DataQualityTab checks={dqChecks} />
            </div>
            <div className="space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">Next Action / 下一步</p>
              <div className="border border-[#263247] bg-[#05070c] p-3">
                <p className="text-xs font-semibold text-slate-200">Deploy Gate</p>
                <p className="mt-1 text-sm text-slate-400">{formatStatus(deployGate.data?.decision)}</p>
                <p className="mt-2 text-[11px] leading-5 text-slate-500">Gate 不是 PASS 時，先處理資料品質與 callback round-trip，不要直接重跑 pipeline。</p>
              </div>
              <div className="border border-[#263247] bg-[#05070c] p-3">
                <p className="text-xs font-semibold text-slate-200">Recent Trace</p>
                <p className="mt-1 font-mono text-lg text-sky-200">{events.length}</p>
                <p className="mt-2 text-[11px] leading-5 text-slate-500">事件數只做線索入口；真正 root cause 仍以 run_id 與 owner contract 追。</p>
              </div>
            </div>
          </div>
        </WorkstationPanel>
      </div>
    </AppShell>
  )
}
