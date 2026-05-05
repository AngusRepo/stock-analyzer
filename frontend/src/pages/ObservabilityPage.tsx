import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
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

type ObsTab = 'incidents' | 'scheduler' | 'dataQuality' | 'modelHealth' | 'resource'

const TAB_LABELS: Record<ObsTab, string> = {
  incidents: '事件 / Incidents',
  scheduler: '排程 / Scheduler Runs',
  dataQuality: '資料品質 / Data Quality',
  modelHealth: '模型健康 / Model Health Snapshot',
  resource: '資源 / Cost / Resource',
}

function statusTone(status?: string): WorkstationTone {
  const s = String(status ?? '').toLowerCase()
  if (['ok', 'pass', 'success', 'active', 'online', 'allow'].includes(s)) return 'ok'
  if (['warn', 'warning', 'running', 'skip', 'skipped', 'manual_required', 'watch'].includes(s)) return 'warn'
  if (['fail', 'failed', 'block', 'blocked', 'error', 'open'].includes(s)) return 'error'
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

function isStateSpaceOverlayModel(name: string, model: Record<string, unknown>) {
  return (
    name === 'KalmanFilter' ||
    name === 'MarkovSwitching' ||
    model.model_type === 'state_space_overlay' ||
    model.balance_family === 'state_space'
  )
}

function domainLabel(domain?: string) {
  const labels: Record<string, string> = {
    scheduler: '排程',
    data_quality: '資料品質',
    deploy_gate: '部署閘門',
    model_pool: '模型池',
    validation: '驗證治理',
    adaptive_meta: '自適應參數',
    owner_boundary: 'Owner 邊界',
  }
  return `${labels[domain ?? ''] ?? '系統'} / ${domain ?? 'system'}`
}

function eventIcon(event: Pick<ObservabilityEvent, 'domain' | 'severity'>) {
  if (event.severity === 'ok') return CheckCircle2
  if (event.domain === 'data_quality') return Database
  if (event.domain === 'model_pool') return GitBranch
  if (event.domain === 'adaptive_meta') return Network
  if (event.domain === 'scheduler') return TimerReset
  return ShieldCheck
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
  const color = tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'error' ? 'text-rose-300' : 'text-slate-100'
  return (
    <div className="min-w-0 border-r border-[#263247] bg-[#070a10] p-3 last:border-r-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8a92a6]">{label}</p>
      <p className={`mt-2 truncate font-mono text-xl font-semibold ${color}`}>{value}</p>
      {detail && <p className="mt-1 line-clamp-2 text-xs text-slate-500">{detail}</p>}
    </div>
  )
}

function MiniDonut({ value, tone = 'ok', label }: { value: number; tone?: WorkstationTone; label: string }) {
  const safe = Math.max(0, Math.min(100, value))
  const dash = `${safe} ${100 - safe}`
  const stroke = tone === 'ok' ? '#34d399' : tone === 'warn' ? '#fbbf24' : tone === 'error' ? '#fb7185' : '#38bdf8'
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 42 42" className="h-14 w-14" role="img" aria-label={label}>
        <circle cx="21" cy="21" r="15.9" fill="transparent" stroke="#263247" strokeWidth="4" />
        <circle
          cx="21"
          cy="21"
          r="15.9"
          fill="transparent"
          stroke={stroke}
          strokeWidth="4"
          strokeDasharray={dash}
          strokeDashoffset="25"
          strokeLinecap="round"
        />
        <text x="21" y="23" textAnchor="middle" className="fill-slate-100 text-[8px] font-semibold">
          {Math.round(safe)}
        </text>
      </svg>
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-100">{label}</p>
        <p className="mt-1 text-xs leading-5 text-[#8a92a6]">圓環越滿代表狀態越健康，顏色代表嚴重度。</p>
      </div>
    </div>
  )
}

function HealthMap({
  incidents,
  schedulerOk,
  dataQualityOk,
  modelOk,
  resourceOk,
}: {
  incidents: number
  schedulerOk: number
  dataQualityOk: number
  modelOk: number
  resourceOk: number
}) {
  const nodes = [
    { label: 'Scheduler', zh: '排程', value: schedulerOk, tone: schedulerOk >= 95 ? 'ok' : 'warn' as WorkstationTone },
    { label: 'Data Quality', zh: '資料品質', value: dataQualityOk, tone: dataQualityOk >= 90 ? 'ok' : 'error' as WorkstationTone },
    { label: 'Model Pool', zh: '模型池', value: modelOk, tone: modelOk >= 90 ? 'ok' : 'warn' as WorkstationTone },
    { label: 'Resource', zh: '資源', value: resourceOk, tone: 'info' as WorkstationTone },
  ]
  return (
    <WorkstationPanel title="Health Map / 系統健康地圖" kicker="grafana-style first glance">
      <div className="grid gap-3 p-3 lg:grid-cols-[1.1fr_1fr]">
        <div className="relative min-h-[180px] overflow-hidden border border-[#263247] bg-[radial-gradient(circle_at_30%_20%,rgba(56,189,248,.16),transparent_30%),radial-gradient(circle_at_76%_58%,rgba(251,191,36,.14),transparent_28%),#05070c] p-4">
          <div className="absolute left-1/2 top-1/2 h-px w-[72%] -translate-x-1/2 bg-gradient-to-r from-transparent via-sky-300/50 to-transparent" />
          <div className="grid grid-cols-2 gap-3">
            {nodes.map((node) => (
              <div key={node.label} className="relative border border-[#263247] bg-[#070a10]/88 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-slate-100">{node.zh}</p>
                    <p className="mt-0.5 text-[10px] text-[#70809b]">{node.label}</p>
                  </div>
                  <WorkstationPill tone={node.tone}>{node.value}%</WorkstationPill>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#172033]">
                  <div className="h-full rounded-full bg-gradient-to-r from-sky-300 via-emerald-300 to-amber-300" style={{ width: `${node.value}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="grid gap-3">
          <MiniDonut value={Math.max(0, 100 - incidents * 20)} tone={incidents ? 'warn' : 'ok'} label="Incident Load / 事件負載" />
          <div className="border border-[#263247] bg-[#05070c] p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">How to read / 怎麼看</p>
            <p className="mt-2 text-xs leading-5 text-[#8a92a6]">
              OBS 第一眼看「哪裡壞、影響誰、下一步做什麼」。細節仍放在 Scheduler、Data Quality、Model Pool drilldown，避免四個頁面互相複製。
            </p>
          </div>
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
        <WorkstationPill tone="ok">無事件 / No active incidents</WorkstationPill>
        <p className="mt-3 text-sm leading-6 text-slate-400">目前沒有 active incident；若有異常，會在這裡依 domain 與 owner 分組，不再塞滿重複 dashboard。</p>
      </div>
    )
  }

  return (
    <VirtualizedList
      items={incidents}
      height={420}
      itemHeight={104}
      getKey={(incident) => incident.id}
      renderItem={(incident) => (
        <button
          type="button"
          aria-pressed={selectedId === incident.id}
          onClick={() => onOpen(incident.id)}
          className={`grid h-[104px] w-full grid-cols-[1fr_auto] gap-3 border-b border-[#263247] p-3 text-left transition-colors ${
            selectedId === incident.id ? 'bg-amber-400/[0.10] ring-1 ring-amber-300/40' : 'bg-[#070a10] hover:bg-sky-400/[0.06]'
          }`}
        >
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">{domainLabel(incident.domain)} / {incident.owner}</p>
            <p className="mt-1 truncate font-mono text-[12px] uppercase tracking-[0.12em] text-slate-100">{incident.title}</p>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#8a92a6]">{incident.impact || incident.root_cause}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <WorkstationPill tone={severityTone(incident.severity)}>{incident.status}</WorkstationPill>
            <span className="border border-sky-400/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-sky-300">
              查看 / Open
            </span>
          </div>
        </button>
      )}
    />
  )
}

function SelectedIncidentDetail({ incident, fallbackEvents }: { incident?: ObservabilityIncident; fallbackEvents: ObservabilityEvent[] }) {
  if (!incident) {
    return (
      <div className="p-4">
        <WorkstationPill tone="ok">無事件 / No active incidents</WorkstationPill>
        <p className="mt-3 text-sm leading-6 text-slate-400">沒有 incident 時，下面會顯示最近事件，方便確認系統仍有資料流入。</p>
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
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#70809b]">Selected Incident Detail / 事件詳情</p>
          <h2 className="mt-1 text-lg font-semibold text-[#fff1cf]">{incident.title}</h2>
          <p className="mt-1 text-xs text-slate-500">{domainLabel(incident.domain)} / owner {incident.owner}</p>
        </div>
        <WorkstationPill tone={severityTone(incident.severity)}>{incident.severity}</WorkstationPill>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">Root cause / 根因</p>
          <p className="mt-2 text-xs leading-5 text-[#8a92a6]">{incident.root_cause || '尚未定位 root cause；請看 run_id、source event 與 specialist drilldown。'}</p>
        </div>
        <div className="border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-sky-200">Impact / 影響</p>
          <p className="mt-2 text-xs leading-5 text-[#8a92a6]">{incident.impact || '尚未回報影響範圍。'}</p>
        </div>
      </div>

      <div className="grid gap-px border border-[#263247] bg-[#263247] md:grid-cols-3">
        <MetricCell label="run_id / 執行批次" value={incident.run_ids?.[0] ?? '-'} tone="info" detail={(incident.run_ids ?? []).slice(1).join(', ') || 'primary'} />
        <MetricCell label="symbols / 影響股票" value={String(incident.affected_symbols?.length ?? 0)} tone={(incident.affected_symbols?.length ?? 0) ? 'warn' : 'neutral'} detail={(incident.affected_symbols ?? []).slice(0, 5).join(', ') || '-'} />
        <MetricCell label="next action / 下一步" value={incident.status} tone={severityTone(incident.severity)} detail={incident.next_action} />
      </div>
    </div>
  )
}

function DependencyMap() {
  const nodes = [
    ['GCP Scheduler', 'trigger', TimerReset],
    ['Cloud Run', 'orchestrate', Network],
    ['Modal', 'heavy ML', Activity],
    ['Worker', 'API/callback', ShieldCheck],
    ['D1/KV', 'serving state', Database],
    ['Frontend', 'read-only UI', CheckCircle2],
  ] as const
  return (
    <div className="p-3">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-[#70809b]">Dependency Map / 依賴地圖</p>
      <div className="grid gap-2">
        {nodes.map(([name, role, Icon], index) => (
          <div key={name} className="grid grid-cols-[28px_1fr_18px] items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center border border-[#263247] bg-[#05070c] text-sky-300">
              <Icon className="h-3.5 w-3.5" />
            </div>
            <div className="border border-[#263247] bg-[#05070c] px-3 py-2">
              <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-slate-100">{name}</p>
              <p className="mt-1 text-[10px] text-[#70809b]">{role}</p>
            </div>
            {index < nodes.length - 1 ? <ArrowRight className="h-3.5 w-3.5 text-amber-300" /> : <span />}
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
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[#70809b]">Execution Watch / 交易真實性</p>
      <div className="flex flex-wrap gap-2">
        {states.map((state) => (
          <WorkstationPill key={state} tone={state === 'partially_filled' || state === 'requoted' ? 'warn' : 'info'}>
            {state}
          </WorkstationPill>
        ))}
      </div>
      <p className="mt-2 text-xs leading-5 text-[#8a92a6]">這裡只顯示會影響下單真實性的狀態，例如報價不可用、過期、重掛與部分成交。</p>
    </div>
  )
}

function SchedulerRunsTab({ jobs }: { jobs: SchedulerJob[] }) {
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
      <VirtualizedList
        items={jobs}
        height={360}
        itemHeight={58}
        getKey={(job) => job.id}
        empty={<div className="p-4 text-sm text-slate-500">沒有 scheduler payload。</div>}
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
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">Scheduler Drilldown / 排程細節</p>
        <p className="mt-2 text-xs leading-5 text-[#8a92a6]">OBS 只回答「有沒有壞」。排程頁負責 run log、callback、duration anomaly、skip reason。</p>
        <a href="/scheduler" className="mt-3 inline-flex border border-sky-400/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-sky-300">
          打開 /scheduler
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
      {!checks.length && <div className="p-4 text-sm text-slate-500">Data Quality Drilldown 沒有 checks。</div>}
      <a href="/data-quality" className="border border-sky-400/30 bg-[#05070c] p-3 font-mono text-[10px] uppercase tracking-[0.14em] text-sky-300">
        打開 /data-quality
      </a>
    </div>
  )
}

export default function ObservabilityPage() {
  const [activeTab, setActiveTab] = useState<ObsTab>('incidents')
  const [selectedIncidentId, setSelectedIncidentId] = useState<string>()
  const detailRef = useRef<HTMLDivElement>(null)

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

  const tabs: Array<{ id: ObsTab; tone: WorkstationTone }> = [
    { id: 'incidents', tone: incidents.length ? 'warn' : 'ok' },
    { id: 'scheduler', tone: (scheduler.data?.stats?.failed24h ?? 0) ? 'warn' : 'ok' },
    { id: 'dataQuality', tone: statusTone(dataQuality.data?.overall) },
    { id: 'modelHealth', tone: modelStats.weakIc || modelStats.missingMeta ? 'warn' : 'ok' },
    { id: 'resource', tone: 'info' },
  ]

  const schedulerScore = Number(scheduler.data?.stats?.successRate7d ?? 0)
  const dataQualityScore = dataQuality.data?.overall === 'ok' ? 100 : dataQuality.data?.overall === 'warn' ? 65 : 35
  const modelScore = modelStats.total ? Math.round(((modelStats.total - modelStats.weakIc - modelStats.missingMeta) / modelStats.total) * 100) : 0
  const resourceScore = resourceAudit.data?.items?.length ? 80 : 100

  function openIncident(id: string) {
    setSelectedIncidentId(id)
    setActiveTab('incidents')
    window.setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0)
  }

  return (
    <AppShell>
      <div className="space-y-4 p-4 lg:p-5">
        <WorkstationPageTitle
          kicker="OBS command center"
          title="Reliability Mission Control / 可觀測指揮中心"
          description="第一層只看系統健康、事故、影響半徑與下一步；細節再 drilldown 到 Scheduler、Data Quality、Model Pool，避免資訊重複與滿版文字。"
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
          <MetricCell label="事件 / Incidents" value={String(incidents.length)} tone={incidents.length ? 'warn' : 'ok'} detail="grouped inbox" />
          <MetricCell label="排程 / Scheduler" value={`${scheduler.data?.stats?.successRate7d ?? 0}%`} tone={(scheduler.data?.stats?.failed24h ?? 0) ? 'warn' : 'ok'} detail={`failed24h ${scheduler.data?.stats?.failed24h ?? '-'}`} />
          <MetricCell label="資料品質 / Data Quality" value={formatStatus(dataQuality.data?.overall)} tone={statusTone(dataQuality.data?.overall)} detail={dataQuality.data?.date ?? '-'} />
          <MetricCell label="模型池 / Model Pool" value={`${modelStats.active}/${modelStats.total}`} tone={modelStats.weakIc || modelStats.missingMeta ? 'warn' : 'ok'} detail={`${modelStats.challenger} shadow challenger`} />
          <MetricCell label="資源 / Resource" value={String(resourceAudit.data?.items?.length ?? 0)} tone="info" detail="audit items" />
        </section>

        <HealthMap
          incidents={incidents.length}
          schedulerOk={schedulerScore}
          dataQualityOk={dataQualityScore}
          modelOk={modelScore}
          resourceOk={resourceScore}
        />

        <section className="grid gap-4 xl:grid-cols-[360px_1fr_320px]">
          <WorkstationPanel title="Incident Inbox / 事件收件匣" kicker="grouped problems, not duplicated dashboards">
            <IncidentInbox incidents={incidents} selectedId={selectedIncident?.id} onOpen={openIncident} />
          </WorkstationPanel>

          <WorkstationPanel title="Selected Incident Detail / 事件詳情" kicker="impact, root cause, next action">
            <div ref={detailRef}>
              <SelectedIncidentDetail incident={selectedIncident} fallbackEvents={events} />
            </div>
          </WorkstationPanel>

          <WorkstationPanel title="Dependency Map / 依賴地圖" kicker="blast radius">
            <DependencyMap />
            <ExecutionRealityStrip />
          </WorkstationPanel>
        </section>

        <WorkstationPanel title="OBS Drilldown / 深入追查" kicker="compact tabs, specialist pages stay available">
          <div className="flex flex-wrap gap-2 border-b border-[#263247] p-3">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`min-h-11 cursor-pointer border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
                  activeTab === tab.id ? 'border-amber-300/50 bg-amber-300/10 text-amber-200' : 'border-[#263247] bg-[#05070c] text-[#8a92a6] hover:border-sky-400/40 hover:text-sky-200'
                }`}
              >
                {TAB_LABELS[tab.id]}
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
                <MetricCell label="active alpha / 投票模型" value={`${modelStats.active}/${modelStats.total}`} tone="ok" />
                <MetricCell label="weak IC / IC缺口" value={String(modelStats.weakIc)} tone={modelStats.weakIc ? 'warn' : 'ok'} />
                <MetricCell label="metadata gaps / metadata缺口" value={String(modelStats.missingMeta)} tone={modelStats.missingMeta ? 'warn' : 'ok'} />
                <a href="/model-pool" className="border border-sky-400/30 bg-[#05070c] p-3 font-mono text-[10px] uppercase tracking-[0.14em] text-sky-300">
                  打開 /model-pool
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
                {!resourceAudit.data?.items?.length && <div className="p-4 text-sm text-slate-500">沒有 resource audit payload。</div>}
              </div>
            )}
          </div>
        </WorkstationPanel>
      </div>
    </AppShell>
  )
}
