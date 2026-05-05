import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import AppShell from '@/components/AppShell'
import {
  dataQualityApi,
  deployGateApi,
  modelPoolApi,
  observabilityApi,
  opsApi,
  schedulerApi,
  systemApi,
  type DataQualityCheck,
  type ObservabilityEvent,
  type ObservabilityIncident,
  type SchedulerJob,
} from '@/lib/api'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  GitBranch,
  Network,
  ShieldCheck,
  TimerReset,
} from 'lucide-react'
import {
  WorkstationPageTitle,
  WorkstationPanel,
  WorkstationPill,
  type WorkstationTone,
} from '@/components/workstation/WorkstationChrome'
import { VirtualizedList } from '@/components/performance/VirtualizedList'

type ObsTab = 'incidents' | 'scheduler' | 'dataQuality' | 'modelHealth' | 'resource'

function statusTone(status?: string): WorkstationTone {
  const s = String(status ?? '').toLowerCase()
  if (['ok', 'pass', 'success', 'active', 'online'].includes(s)) return 'ok'
  if (['warn', 'warning', 'running', 'skip', 'skipped', 'manual_required'].includes(s)) return 'warn'
  if (['fail', 'failed', 'block', 'blocked', 'error'].includes(s)) return 'error'
  return 'neutral'
}

function severityTone(severity?: string): WorkstationTone {
  if (severity === 'error') return 'error'
  if (severity === 'warn') return 'warn'
  if (severity === 'ok') return 'ok'
  if (severity === 'info') return 'info'
  return 'neutral'
}

function formatStatus(status?: string) {
  return status ? String(status).toUpperCase() : 'UNKNOWN'
}

function eventIcon(event: Pick<ObservabilityEvent, 'domain' | 'severity'>) {
  if (event.severity === 'ok') return CheckCircle2
  if (event.domain === 'data_quality') return Database
  if (event.domain === 'model_pool') return GitBranch
  if (event.domain === 'adaptive_meta') return Network
  if (event.domain === 'scheduler') return AlertTriangle
  return ShieldCheck
}

function isStateSpaceOverlayModel(name: string, model: Record<string, unknown>) {
  return (
    name === 'KalmanFilter' ||
    name === 'MarkovSwitching' ||
    model.model_type === 'state_space_overlay' ||
    model.balance_family === 'state_space'
  )
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
    <div className="border-r border-[#263247] bg-[#070a10] p-3 last:border-r-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8a92a6]">{label}</p>
      <p className={`mt-2 font-mono text-xl font-semibold ${tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'error' ? 'text-rose-300' : 'text-slate-100'}`}>
        {value}
      </p>
      {detail && <p className="mt-1 text-xs text-slate-500">{detail}</p>}
    </div>
  )
}

function IncidentInbox({
  incidents,
  selectedId,
  onSelect,
}: {
  incidents: ObservabilityIncident[]
  selectedId?: string
  onSelect: (id: string) => void
}) {
  if (!incidents.length) {
    return (
      <div className="p-4">
        <WorkstationPill tone="ok">No active incidents</WorkstationPill>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          目前沒有需要處理的 active incident。請看下方 compact drilldown 確認最近一次成功 run、資料品質與模型健康。
        </p>
      </div>
    )
  }

  return (
    <VirtualizedList
      items={incidents}
      height={420}
      itemHeight={92}
      getKey={(incident) => incident.id}
      renderItem={(incident) => (
        <button
          type="button"
          onClick={() => onSelect(incident.id)}
          className={`grid h-[92px] w-full grid-cols-[1fr_auto] gap-3 border-b border-[#263247] p-3 text-left transition-colors ${
            selectedId === incident.id ? 'bg-amber-400/[0.08]' : 'bg-[#070a10] hover:bg-sky-400/[0.05]'
          }`}
        >
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">{incident.domain} / {incident.owner}</p>
            <p className="mt-1 truncate font-mono text-[12px] uppercase tracking-[0.12em] text-slate-100">{incident.title}</p>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#8a92a6]">{incident.impact || incident.root_cause}</p>
          </div>
          <WorkstationPill tone={severityTone(incident.severity)}>{incident.status}</WorkstationPill>
        </button>
      )}
    />
  )
}

function SelectedIncidentDetail({ incident, fallbackEvents }: { incident?: ObservabilityIncident; fallbackEvents: ObservabilityEvent[] }) {
  if (!incident) {
    return (
      <div className="p-4">
        <WorkstationPill tone="ok">No active incidents</WorkstationPill>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          最近沒有 open incident。若你要查歷史，請從 Scheduler Runs、Data Quality 或 Model Health Snapshot 切入。
        </p>
        <div className="mt-4 space-y-2">
          {fallbackEvents.slice(0, 3).map((event) => {
            const Icon = eventIcon(event)
            return (
              <div key={event.id} className="grid grid-cols-[22px_1fr_auto] gap-3 border border-[#263247] bg-[#05070c] p-3">
                <Icon className="mt-0.5 h-4 w-4 text-sky-300" />
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-slate-100">{event.title}</p>
                  <p className="mt-1 text-xs text-slate-500">{event.summary}</p>
                </div>
                <WorkstationPill tone={severityTone(event.severity)}>{event.severity}</WorkstationPill>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#70809b]">Selected Incident Detail</p>
          <h2 className="mt-1 text-lg font-semibold text-[#fff1cf]">{incident.title}</h2>
          <p className="mt-1 text-xs text-slate-500">{incident.domain} / {incident.owner}</p>
        </div>
        <WorkstationPill tone={severityTone(incident.severity)}>{incident.severity}</WorkstationPill>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">Root cause</p>
          <p className="mt-2 text-xs leading-5 text-[#8a92a6]">{incident.root_cause || '尚未產出 root cause，請從對應 drilldown 追 run_id / source / model。'}</p>
        </div>
        <div className="border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-sky-200">Impact</p>
          <p className="mt-2 text-xs leading-5 text-[#8a92a6]">{incident.impact || '尚未標註影響範圍。'}</p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <MetricCell label="run_id" value={incident.run_ids?.[0] ?? '-'} tone="info" detail={(incident.run_ids ?? []).slice(1).join(', ') || 'primary'} />
        <MetricCell label="symbols" value={String(incident.affected_symbols?.length ?? 0)} tone={(incident.affected_symbols?.length ?? 0) ? 'warn' : 'neutral'} detail={(incident.affected_symbols ?? []).slice(0, 5).join(', ') || '-'} />
        <MetricCell label="status" value={incident.status} tone={severityTone(incident.severity)} detail={incident.next_action} />
      </div>
    </div>
  )
}

function DependencyMap() {
  const nodes = [
    ['GCP Scheduler', 'trigger'],
    ['Cloud Run', 'orchestrate'],
    ['Modal', 'heavy ML'],
    ['Worker', 'API/callback'],
    ['D1/KV', 'serving state'],
    ['Frontend', 'read-only UI'],
  ]
  return (
    <div className="p-3">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-[#70809b]">Dependency Map</p>
      <div className="flex flex-wrap items-center gap-2">
        {nodes.map(([name, role], index) => (
          <div key={name} className="flex items-center gap-2">
            <div className="border border-[#263247] bg-[#05070c] px-3 py-2">
              <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-slate-100">{name}</p>
              <p className="mt-1 text-[10px] text-[#70809b]">{role}</p>
            </div>
            {index < nodes.length - 1 && <span className="font-mono text-xs text-amber-300">→</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

function ExecutionRealityStrip() {
  const states = ['quote_unavailable', 'stale_quote', 'requoted', 'partially_filled', 'expired']
  return (
    <div className="border-t border-[#263247] p-3">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[#70809b]">Execution realism watch</p>
      <div className="flex flex-wrap gap-2">
        {states.map((state) => (
          <WorkstationPill key={state} tone={state === 'partially_filled' || state === 'requoted' ? 'warn' : 'info'}>
            {state}
          </WorkstationPill>
        ))}
      </div>
    </div>
  )
}

function SchedulerRunsTab({ jobs }: { jobs: SchedulerJob[] }) {
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_260px]">
      <VirtualizedList
        items={jobs}
        height={360}
        itemHeight={58}
        getKey={(job) => job.id}
        empty={<div className="p-4 text-sm text-slate-500">尚未取得 scheduler payload。</div>}
        renderItem={(job) => (
          <div className="grid h-[58px] grid-cols-[1fr_92px_78px_78px] items-center gap-2 border-b border-[#263247] px-3 font-mono text-[11px]">
            <div className="min-w-0">
              <p className="truncate text-slate-100">{job.name}</p>
              <p className="truncate text-[#70809b]">{job.summary || job.schedule}</p>
            </div>
            <WorkstationPill tone={statusTone(job.lastStatus)}>{job.lastStatus || 'unknown'}</WorkstationPill>
            <span className="text-[#8a92a6]">{job.lastDuration || '-'}</span>
            <span className="truncate text-right text-[#70809b]">{job.group}</span>
          </div>
        )}
      />
      <div className="border border-[#263247] bg-[#05070c] p-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">Scheduler Drilldown</p>
        <p className="mt-2 text-xs leading-5 text-[#8a92a6]">
          這裡只看 run state、callback、duration、skip/failed reason。完整歷史仍保留 deep link。
        </p>
        <a href="/scheduler" className="mt-3 inline-flex border border-sky-400/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-sky-300">
          open /scheduler
        </a>
      </div>
    </div>
  )
}

function DataQualityTab({ checks }: { checks: DataQualityCheck[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {checks.slice(0, 10).map((check) => (
        <div key={check.id} className="border border-[#263247] bg-[#05070c] p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-100">{check.label}</p>
              <p className="mt-1 text-xs leading-5 text-[#8a92a6]">{check.summary}</p>
            </div>
            <WorkstationPill tone={statusTone(check.status)}>{check.status}</WorkstationPill>
          </div>
        </div>
      ))}
      {!checks.length && <div className="p-4 text-sm text-slate-500">Data Quality Drilldown 尚未取得 checks。</div>}
      <a href="/data-quality" className="border border-sky-400/30 bg-[#05070c] p-3 font-mono text-[10px] uppercase tracking-[0.14em] text-sky-300">
        open /data-quality
      </a>
    </div>
  )
}

export default function ObservabilityPage() {
  const [activeTab, setActiveTab] = useState<ObsTab>('incidents')
  const [selectedIncidentId, setSelectedIncidentId] = useState<string>()

  const scheduler = useQuery({ queryKey: ['obs', 'scheduler'], queryFn: schedulerApi.status, refetchInterval: 60_000, staleTime: 30_000 })
  const dataQuality = useQuery({ queryKey: ['obs', 'data-quality'], queryFn: () => dataQualityApi.status(), refetchInterval: 60_000, staleTime: 30_000 })
  const deployGate = useQuery({ queryKey: ['obs', 'deploy-gate'], queryFn: () => deployGateApi.predeploy(), refetchInterval: 60_000, staleTime: 30_000 })
  const modelPool = useQuery({ queryKey: ['obs', 'model-pool-lineage'], queryFn: modelPoolApi.lineage, refetchInterval: 120_000, staleTime: 60_000 })
  const system = useQuery({ queryKey: ['obs', 'system'], queryFn: systemApi.status, refetchInterval: 60_000, staleTime: 30_000 })
  const observability = useQuery({ queryKey: ['obs', 'events'], queryFn: () => observabilityApi.events(), refetchInterval: 60_000, staleTime: 30_000 })
  const drilldown = useQuery({ queryKey: ['obs', 'drilldown'], queryFn: () => observabilityApi.drilldown(), refetchInterval: 60_000, staleTime: 30_000 })
  const resourceAudit = useQuery({ queryKey: ['obs', 'resource-audit'], queryFn: opsApi.resourceAudit, refetchInterval: 300_000, staleTime: 120_000 })

  const incidents = drilldown.data?.incidents ?? []
  const selectedIncident = incidents.find((incident) => incident.id === selectedIncidentId) ?? incidents[0]
  const events = observability.data?.events ?? []
  const jobs = scheduler.data?.jobs ?? []
  const dqChecks = dataQuality.data?.checks ?? []

  const modelStats = useMemo(() => {
    const models = Object.entries(modelPool.data?.models ?? {})
      .filter(([name, model]) => !isStateSpaceOverlayModel(name, model as Record<string, unknown>))
    const active = models.filter(([, model]) => model.status === 'active').length
    const challenger = models.filter(([, model]) => model.challenger).length
    const weakIc = models.filter(([, model]) => {
      const ic = model.ic_4w_avg ?? model.rolling_ic
      return ic == null || !Number.isFinite(Number(ic)) || Math.abs(Number(ic)) < 0.0001
    }).length
    const missingMeta = models.filter(([, model]) => model.metadata_exists === false).length
    return { total: models.length, active, challenger, weakIc, missingMeta }
  }, [modelPool.data])

  const tabs: Array<{ id: ObsTab; label: string; tone: WorkstationTone }> = [
    { id: 'incidents', label: 'Incidents', tone: incidents.length ? 'warn' : 'ok' },
    { id: 'scheduler', label: 'Scheduler Runs', tone: (scheduler.data?.stats?.failed24h ?? 0) ? 'warn' : 'ok' },
    { id: 'dataQuality', label: 'Data Quality', tone: statusTone(dataQuality.data?.overall) },
    { id: 'modelHealth', label: 'Model Health Snapshot', tone: modelStats.weakIc || modelStats.missingMeta ? 'warn' : 'ok' },
    { id: 'resource', label: 'Cost / Resource', tone: 'info' },
  ]

  return (
    <AppShell>
      <div className="space-y-4 p-4 lg:p-5">
        <WorkstationPageTitle
          kicker="OBS command center"
          title="Reliability Mission Control"
          description="主入口只回答：哪裡壞、影響誰、root cause 是什麼、下一步去哪裡查。Scheduler 與 Data Quality 收斂成 drilldown，不再四頁互相複製。"
          action={
            <div className="flex flex-wrap gap-2">
              <WorkstationPill tone={statusTone(dataQuality.data?.overall)}>DQ {formatStatus(dataQuality.data?.overall)}</WorkstationPill>
              <WorkstationPill tone={statusTone(deployGate.data?.decision)}>Gate {formatStatus(deployGate.data?.decision)}</WorkstationPill>
              <WorkstationPill tone={severityTone(observability.data?.overall)}>OBS {formatStatus(observability.data?.overall)}</WorkstationPill>
              <WorkstationPill tone={system.error ? 'error' : 'ok'}>System {system.error ? 'ERROR' : 'ONLINE'}</WorkstationPill>
            </div>
          }
        />

        <section className="grid grid-cols-1 gap-px border border-[#263247] bg-[#263247] md:grid-cols-5">
          <MetricCell label="Incidents" value={String(incidents.length)} tone={incidents.length ? 'warn' : 'ok'} detail="grouped inbox" />
          <MetricCell label="Scheduler" value={`${scheduler.data?.stats?.successRate7d ?? 0}%`} tone={(scheduler.data?.stats?.failed24h ?? 0) ? 'warn' : 'ok'} detail={`failed24h ${scheduler.data?.stats?.failed24h ?? '-'}`} />
          <MetricCell label="Data Quality" value={formatStatus(dataQuality.data?.overall)} tone={statusTone(dataQuality.data?.overall)} detail={dataQuality.data?.date ?? '-'} />
          <MetricCell label="Model Pool" value={`${modelStats.active}/${modelStats.total}`} tone={modelStats.weakIc || modelStats.missingMeta ? 'warn' : 'ok'} detail={`${modelStats.challenger} challenger`} />
          <MetricCell label="Resource" value={String(resourceAudit.data?.items?.length ?? 0)} tone="info" detail="audit items" />
        </section>

        <section className="grid gap-4 xl:grid-cols-[360px_1fr_320px]">
          <WorkstationPanel title="Incident Inbox" kicker="grouped problems, not duplicated dashboards">
            <IncidentInbox incidents={incidents} selectedId={selectedIncident?.id} onSelect={setSelectedIncidentId} />
          </WorkstationPanel>

          <WorkstationPanel title="Selected Incident Detail" kicker="impact, root cause, next action">
            <SelectedIncidentDetail incident={selectedIncident} fallbackEvents={events} />
          </WorkstationPanel>

          <WorkstationPanel title="Dependency Map" kicker="blast radius">
            <DependencyMap />
            <ExecutionRealityStrip />
          </WorkstationPanel>
        </section>

        <WorkstationPanel title="OBS Drilldown" kicker="compact tabs, deep links stay available">
          <div className="flex flex-wrap gap-2 border-b border-[#263247] p-3">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] ${
                  activeTab === tab.id ? 'border-amber-300/50 bg-amber-300/10 text-amber-200' : 'border-[#263247] bg-[#05070c] text-[#8a92a6] hover:border-sky-400/40 hover:text-sky-200'
                }`}
              >
                {tab.label}
                <span className="ml-2"><WorkstationPill tone={tab.tone}>{tab.tone}</WorkstationPill></span>
              </button>
            ))}
          </div>
          <div className="p-3">
            {activeTab === 'incidents' && <SelectedIncidentDetail incident={selectedIncident} fallbackEvents={events} />}
            {activeTab === 'scheduler' && <SchedulerRunsTab jobs={jobs} />}
            {activeTab === 'dataQuality' && <DataQualityTab checks={dqChecks} />}
            {activeTab === 'modelHealth' && (
              <div className="grid gap-3 md:grid-cols-4">
                <MetricCell label="active alpha" value={`${modelStats.active}/${modelStats.total}`} tone="ok" />
                <MetricCell label="weak IC" value={String(modelStats.weakIc)} tone={modelStats.weakIc ? 'warn' : 'ok'} />
                <MetricCell label="metadata gaps" value={String(modelStats.missingMeta)} tone={modelStats.missingMeta ? 'warn' : 'ok'} />
                <a href="/model-pool" className="border border-sky-400/30 bg-[#05070c] p-3 font-mono text-[10px] uppercase tracking-[0.14em] text-sky-300">
                  open /model-pool
                </a>
              </div>
            )}
            {activeTab === 'resource' && (
              <div className="grid gap-3 md:grid-cols-2">
                {(resourceAudit.data?.items ?? []).map((item) => (
                  <div key={item.id} className="border border-[#263247] bg-[#05070c] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">{item.owner}</p>
                        <p className="mt-1 font-mono text-[12px] uppercase tracking-[0.12em] text-slate-100">{item.id}</p>
                      </div>
                      <WorkstationPill tone={statusTone(item.status)}>{item.status}</WorkstationPill>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-[#8a92a6]">{item.summary}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">{item.next_action}</p>
                  </div>
                ))}
                {!resourceAudit.data?.items?.length && <div className="p-4 text-sm text-slate-500">目前沒有 resource audit payload。</div>}
              </div>
            )}
          </div>
        </WorkstationPanel>
      </div>
    </AppShell>
  )
}
