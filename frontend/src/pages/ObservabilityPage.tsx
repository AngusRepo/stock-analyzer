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

type ObsTab = 'scheduler' | 'dataQuality'

const TAB_LABELS: Record<ObsTab, string> = {
  scheduler: 'Scheduler Runs / 排程執行',
  dataQuality: 'Data Quality / 資料品質',
}

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
  onOpen,
}: {
  incidents: ObservabilityIncident[]
  selectedId?: string
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
      {incidents.map((incident) => (
        <button
          key={incident.id}
          type="button"
          onClick={() => onOpen(incident.id)}
          className={`w-full border-b border-[#263247] p-3 text-left transition-colors hover:bg-[#152033] ${
            selectedId === incident.id ? 'bg-amber-300/10' : 'bg-[#05070c]'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">{incident.domain} / {incident.owner}</p>
              <p className="mt-1 text-sm font-semibold text-slate-100">{incident.title}</p>
            </div>
            <WorkstationPill tone={severityTone(incident.severity)}>{incident.status}</WorkstationPill>
          </div>
          <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-400">{incident.impact || incident.next_action}</p>
        </button>
      ))}
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
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {jobs.map((job) => (
        <div key={job.id} className="border border-[#263247] bg-[#05070c] p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">{job.group} / {job.schedule}</p>
              <p className="mt-1 text-sm font-semibold text-slate-100">{job.name}</p>
            </div>
            <WorkstationPill tone={statusTone(job.lastStatus)}>{job.lastStatus}</WorkstationPill>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-slate-400">
            <span>last {job.lastRun || '-'}</span>
            <span>duration {job.lastDuration || '-'}</span>
            <span>next {job.nextRun || '-'}</span>
          </div>
          {job.lastError && <p className="mt-2 text-xs leading-5 text-rose-300">{job.lastError}</p>}
        </div>
      ))}
    </div>
  )
}

function DataQualityTab({ checks }: { checks: DataQualityCheck[] }) {
  if (!checks.length) return <div className="p-4 text-sm text-slate-500">目前沒有 data quality checks。</div>
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {checks.map((check) => (
        <div key={check.id} className={`border p-3 ${check.status === 'fail' ? 'border-rose-500/40 bg-rose-950/20' : check.status === 'warn' ? 'border-amber-500/40 bg-amber-950/20' : 'border-emerald-500/30 bg-emerald-950/10'}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">{check.id}</p>
              <p className="mt-1 text-sm font-semibold text-slate-100">{check.label}</p>
            </div>
            <WorkstationPill tone={statusTone(check.status)}>{check.status}</WorkstationPill>
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-400">{check.summary}</p>
          {check.metrics && (
            <pre className="mt-2 max-h-28 overflow-auto rounded border border-[#263247] bg-[#03060a] p-2 text-[10px] leading-4 text-slate-500">
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
  const [activeTab, setActiveTab] = useState<ObsTab>('scheduler')
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

  const tabs: Array<{ id: ObsTab; tone: WorkstationTone }> = [
    { id: 'scheduler', tone: (scheduler.data?.stats?.failed24h ?? 0) ? 'warn' : 'ok' },
    { id: 'dataQuality', tone: statusTone(dataQuality.data?.overall) },
  ]

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
            <IncidentInbox incidents={incidents} selectedId={selectedIncident?.id} onOpen={openIncident} />
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

        <WorkstationPanel title="Operational Drilldown / 維運追蹤" kicker="只保留 Scheduler Runs 與 Data Quality">
          <div className="flex flex-wrap gap-2 border-b border-[#263247] p-3">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`min-h-11 cursor-pointer border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
                  activeTab === tab.id ? 'border-sky-300/50 bg-sky-300/10 text-sky-200' : 'border-[#263247] bg-[#05070c] text-[#8a92a6] hover:border-sky-400/40 hover:text-sky-200'
                }`}
              >
                {TAB_LABELS[tab.id]}
                <span className="ml-2"><WorkstationPill tone={tab.tone}>{tab.tone}</WorkstationPill></span>
              </button>
            ))}
            <a href="/scheduler" className="min-h-11 border border-[#263247] bg-[#05070c] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400 hover:border-sky-400/40 hover:text-sky-200">
              Open scheduler / 開啟排程頁
            </a>
            <a href="/data-quality" className="min-h-11 border border-[#263247] bg-[#05070c] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400 hover:border-sky-400/40 hover:text-sky-200">
              Open data quality / 開啟資料品質
            </a>
          </div>
          <div className="p-3">
            {activeTab === 'scheduler' && <SchedulerRunsTab jobs={jobs} />}
            {activeTab === 'dataQuality' && <DataQualityTab checks={dqChecks} />}
          </div>
        </WorkstationPanel>
      </div>
    </AppShell>
  )
}
