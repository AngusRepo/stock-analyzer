import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, ArrowRight, Clock3, Database, ExternalLink, GitBranch, ShieldCheck } from 'lucide-react'
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

function formatEvidenceValue(value: unknown) {
  if (Array.isArray(value)) return value.length ? value.slice(0, 4).join(', ') : '-'
  if (value == null || value === '') return '-'
  return String(value)
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
  const schedulerTone = schedulerOk >= 95 ? 'ok' : schedulerOk >= 85 ? 'warn' : 'error'
  const dataTone = dataQualityOk >= 90 ? 'ok' : dataQualityOk >= 70 ? 'warn' : 'error'
  const deployTone = deployOk >= 90 ? 'ok' : deployOk >= 60 ? 'warn' : 'error'
  const incidentTone = incidents ? 'warn' : 'ok'
  const traceTone = traceOk ? 'ok' : 'warn'
  const steps: Array<{ label: string; value: string; tone: WorkstationTone; icon: React.ReactNode; note: string }> = [
    { label: 'Incident', value: `${incidents}`, tone: incidentTone, icon: <Activity className="h-4 w-4" />, note: 'root-cause group count' },
    { label: 'Scheduler', value: `${schedulerOk}%`, tone: schedulerTone, icon: <Clock3 className="h-4 w-4" />, note: 'job SLO' },
    { label: 'Data', value: `${dataQualityOk}%`, tone: dataTone, icon: <Database className="h-4 w-4" />, note: 'freshness/schema/parity' },
    { label: 'Gate', value: `${deployOk}%`, tone: deployTone, icon: <ShieldCheck className="h-4 w-4" />, note: 'predeploy safety' },
    { label: 'Trace', value: `${traceOk}`, tone: traceTone, icon: <GitBranch className="h-4 w-4" />, note: 'event evidence' },
  ]
  return (
    <WorkstationPanel title="Reliability Map / 可靠度地圖" kicker="dependency order, not duplicate KPI">
      <div className="grid gap-3 p-3 lg:grid-cols-[1fr_340px]">
        <div className="grid gap-2 md:grid-cols-5">
          {steps.map((step, index) => (
            <div key={step.label} className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-slate-400">
                  {step.icon}
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em]">{step.label}</span>
                </div>
                {index < steps.length - 1 && <ArrowRight className="h-3 w-3 text-amber-300" />}
              </div>
              <div className="mt-3 flex items-end justify-between gap-2">
                <p className={`font-mono text-xl font-semibold ${step.tone === 'ok' ? 'text-emerald-300' : step.tone === 'warn' ? 'text-amber-300' : step.tone === 'error' ? 'text-rose-300' : 'text-sky-300'}`}>{step.value}</p>
                <WorkstationPill tone={step.tone}>{step.tone}</WorkstationPill>
              </div>
              <p className="mt-2 text-[11px] leading-4 text-slate-500">{step.note}</p>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">How to read / 怎麼看</p>
          <p className="mt-2 text-xs leading-5 text-slate-400">
            上方 KPI 只回答健康分數；這裡固定用事件流順序看 blast radius：先看 root-cause inbox，再看 scheduler 是否完成、資料是否可信、deploy gate 是否阻擋，最後用 trace event 找證據。
          </p>
          <Sparkline values={[incidents ? 40 : 100, schedulerOk, dataQualityOk, deployOk, Math.min(100, traceOk * 8)]} tone={incidents || deployOk < 90 ? 'warn' : 'ok'} />
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
    <div className="divide-y divide-[#263247]">
      {incidents.map((incident) => {
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
                  <span>first {formatObsTime(timing.firstSeen)}</span>
                  <span>last {formatObsTime(timing.lastSeen)}</span>
                  <span>age {timing.duration}</span>
                  <span>{incident.source_event_ids?.length ?? 0} events</span>
                </div>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-400">{incident.root_cause || incident.impact || '-'}</p>
                <MiniBar value={tone === 'error' ? 100 : tone === 'warn' ? 65 : 35} tone={tone} />
              </div>
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-amber-200">
                查看 / Open <ArrowRight className="h-3 w-3" />
              </span>
            </div>
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
      </div>
    )
  }

  const timing = incidentTiming(incident, fallbackEvents)
  const tone = severityTone(incident.severity)
  const evidence = asRecord(incident.evidence)
  const statuses = formatEvidenceValue(evidence.statuses)
  const sources = formatEvidenceValue(evidence.sources)
  const eventCount = formatEvidenceValue(evidence.event_count ?? incident.source_event_ids?.length)
  const isGaPromotionGate =
    incident.title.toLowerCase().includes('ga optimizer') ||
    String(incident.root_cause ?? '').toLowerCase().includes('adaptive_meta:shadow_config') ||
    String(evidence.sources ?? '').toLowerCase().includes('ga_optimizer')
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
        <MetricCell label="First seen / 首次發生" value={formatObsTime(timing.firstSeen)} tone="info" detail="來自 OBS audit / event ts，不是頁面開啟時間" />
        <MetricCell label="Last seen / 最後更新" value={formatObsTime(timing.lastSeen)} tone={incident.status === 'resolved' ? 'ok' : 'warn'} detail="判斷是不是新問題" />
        <MetricCell label="Age / 持續時間" value={timing.duration} tone={incident.status === 'open' ? 'warn' : 'ok'} detail="first seen 到 last seen" />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">Root Cause / 為什麼壞</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">{incident.root_cause || '-'}</p>
        </div>
        <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-sky-200">Impact / 影響</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">{incident.impact || '-'}</p>
        </div>
        <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-200">Next Action / 要怎麼處理</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">{incident.next_action || '-'}</p>
        </div>
      </div>

      {isGaPromotionGate && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">GA Promotion Gate / GA 進級門檻</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            這不是個股錯誤，也不是 scheduler 沒跑。它代表 GA optimizer 已產生一組學到的候選策略參數，但目前停在 L2 審核階段；production 的 trading:config 還沒被改動。要進下一階，需要看 fitness、PBO/MC、candidate diff 與風險門檻，通過後才會自動往 L3/L4 推進並通知。
          </p>
          <div className="mt-3 grid gap-2 md:grid-cols-3">
            <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
              <p className="text-[11px] text-slate-500">Runs 為 0</p>
              <p className="text-xs leading-5 text-slate-300">GA 是 config/meta 層事件，不是單一股票 run。</p>
            </div>
            <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
              <p className="text-[11px] text-slate-500">Symbols 為 0</p>
              <p className="text-xs leading-5 text-slate-300">它調整門檻/權重，不直接掛在某檔股票。</p>
            </div>
            <div className="rounded-lg border border-[#263247] bg-[#05070c] p-2">
              <p className="text-[11px] text-slate-500">Evidence</p>
              <p className="text-xs leading-5 text-slate-300">用來追 GA 候選、gate 與 promotion ladder。</p>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-2 md:grid-cols-3">
        <MetricCell label="Runs" value={String(incident.run_ids?.length ?? 0)} tone="info" detail={(incident.run_ids ?? []).slice(0, 2).join(', ') || '-'} />
        <MetricCell label="Symbols" value={String(incident.affected_symbols?.length ?? 0)} tone={(incident.affected_symbols?.length ?? 0) ? 'warn' : 'ok'} detail={(incident.affected_symbols ?? []).slice(0, 4).join(', ') || '-'} />
        <MetricCell label="Evidence / 證據" value={`${eventCount} events`} tone={statusTone(incident.status)} detail={`${sources}; ${statuses}`} />
      </div>
    </div>
  )
}

function IncidentInboxV2({
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
        <WorkstationPill tone="ok">No active incidents / 目前無事件</WorkstationPill>
      </div>
    )
  }

  return (
    <div className="divide-y divide-[#263247]">
      {incidents.map((incident) => {
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
                  <span className="font-mono text-[10px] text-slate-500">{incident.source_event_ids?.length ?? 0} events</span>
                </div>
                <p className="mt-2 truncate text-sm font-semibold text-slate-100">{incident.title}</p>
                <div className="mt-2 grid gap-1 font-mono text-[10px] text-slate-500">
                  <span>first {formatObsTime(timing.firstSeen)} · last {formatObsTime(timing.lastSeen)}</span>
                  <span>age {timing.duration}</span>
                </div>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-400">{incident.root_cause || incident.impact || '-'}</p>
                <MiniBar value={tone === 'error' ? 100 : tone === 'warn' ? 65 : 35} tone={tone} />
              </div>
              <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-amber-200">
                Open <ArrowRight className="h-3 w-3" />
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

function SelectedIncidentDetailV2({
  incident,
  fallbackEvents,
}: {
  incident?: ObservabilityIncident
  fallbackEvents: ObservabilityEvent[]
}) {
  if (!incident) {
    return (
      <div className="p-4">
        <WorkstationPill tone="ok">No selected incident / 尚未選擇事件</WorkstationPill>
      </div>
    )
  }

  const timing = incidentTiming(incident, fallbackEvents)
  const tone = severityTone(incident.severity)
  const evidence = asRecord(incident.evidence)
  const statuses = formatEvidenceValue(evidence.statuses)
  const sources = formatEvidenceValue(evidence.sources)
  const eventCount = formatEvidenceValue(evidence.event_count ?? incident.source_event_ids?.length)
  const isGaPromotionGate =
    incident.title.toLowerCase().includes('ga optimizer') ||
    String(incident.root_cause ?? '').toLowerCase().includes('adaptive_meta:shadow_config') ||
    String(evidence.sources ?? '').toLowerCase().includes('ga_optimizer')

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">Incident / 事件</p>
          <h2 className="mt-1 text-xl font-semibold text-slate-100">{incident.title}</h2>
        </div>
        <WorkstationPill tone={tone}>{incident.severity}</WorkstationPill>
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        <MetricCell label="First seen / 首次發生" value={formatObsTime(timing.firstSeen)} tone="info" detail="第一次被歸入此 root-cause 群組" />
        <MetricCell label="Last seen / 最後更新" value={formatObsTime(timing.lastSeen)} tone={incident.status === 'resolved' ? 'ok' : 'warn'} detail="最後一筆相關 event / audit log" />
        <MetricCell label="Age / 持續時間" value={timing.duration} tone={incident.status === 'open' ? 'warn' : 'ok'} detail="first seen 到 last seen" />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">Root Cause / 根因</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">{incident.root_cause || '-'}</p>
        </div>
        <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-sky-200">Impact / 影響</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">{incident.impact || '-'}</p>
        </div>
        <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-200">Next Action / 下一步</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">{incident.next_action || '-'}</p>
        </div>
      </div>

      {isGaPromotionGate && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">GA Promotion Gate / GA 晉級門檻</p>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            這不是排程失敗，而是 GA optimizer 已產生候選參數但尚未通過 promotion ladder。Production trading:config 會保持不變，直到 fitness、PBO/MC 與 candidate diff 都通過門檻。
          </p>
        </div>
      )}

      <div className="grid gap-2 md:grid-cols-3">
        <MetricCell label="Runs / 執行" value={String(incident.run_ids?.length ?? 0)} tone="info" detail={(incident.run_ids ?? []).slice(0, 2).join(', ') || '-'} />
        <MetricCell label="Symbols / 股票" value={String(incident.affected_symbols?.length ?? 0)} tone={(incident.affected_symbols?.length ?? 0) ? 'warn' : 'ok'} detail={(incident.affected_symbols ?? []).slice(0, 4).join(', ') || '-'} />
        <MetricCell label="Evidence / 證據" value={`${eventCount} events`} tone={statusTone(incident.status)} detail={`${sources}; ${statuses}`} />
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
              <p>last {job.lastRun || '-'}</p>
              <p className="text-slate-600">next {job.nextRun || '-'}</p>
            </div>
            <div className="min-w-0 font-mono text-slate-400">
              <p>{job.lastDuration || '-'}</p>
              <p className="text-slate-600">7d {job.rate7d || '-'}</p>
            </div>
            <a href="/scheduler" className="inline-flex items-center justify-end gap-1 self-start font-mono text-[10px] uppercase tracking-[0.14em] text-sky-200 hover:text-sky-100">
              Drilldown <ExternalLink className="h-3 w-3" />
            </a>
            {job.lastError && <p className="lg:col-span-4 text-xs leading-5 text-rose-300">{job.lastError}</p>}
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

export default function ObservabilityPage() {
  const [selectedIncidentId, setSelectedIncidentId] = useState<string>()

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

        <div className="rounded-2xl border border-[#2b3a49] bg-[#0b111b]">
          <div className="border-b border-[#2b3a49] px-3 py-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#fff1cf]">Reliability Map / 可靠度地圖</p>
            <p className="mt-1 text-xs text-slate-500">同一列看 SLO，不用箭頭假裝它們有直接相依。</p>
          </div>
        <section className="grid grid-cols-1 overflow-hidden bg-[#2b3a49] md:grid-cols-5">
          <MetricCell label="Incidents / 事件" value={String(incidents.length)} tone={incidents.length ? 'warn' : 'ok'} count={`${events.length} events`} detail="grouped root-cause inbox" />
          <MetricCell label="Scheduler SLO / 排程" value={`${schedulerScore}%`} tone={failedJobs ? 'warn' : 'ok'} count={`${jobs.length} jobs`} detail={`${failedJobs} failed`} />
          <MetricCell label="Data Trust / 資料" value={`${dataQualityScore}%`} tone={statusTone(dataQuality.data?.overall)} count={`${dqChecks.length} checks`} detail={`${failedChecks} failed`} />
          <MetricCell label="Deploy Gate / 上線" value={formatStatus(deployGate.data?.decision)} tone={statusTone(deployGate.data?.decision)} count="gate" detail="predeploy safety" />
          <MetricCell label="Trace / 追蹤" value={String(events.length)} tone={observability.error ? 'warn' : 'info'} count="logs" detail={observability.data?.date ?? '-'} />
        </section>
        </div>

        <AdaptiveMetaPanel events={events} />

        <section className="grid gap-4 xl:grid-cols-[360px_1fr_300px]">
          <WorkstationPanel title="Incident Inbox / 事件收件匣" kicker="time, count, owner">
            <IncidentInboxV2 incidents={incidents} selectedId={selectedIncident?.id} events={events} onOpen={openIncident} />
          </WorkstationPanel>

          <WorkstationPanel title="Selected Incident Detail / 事件根因" kicker="impact + next action">
            <SelectedIncidentDetailV2 incident={selectedIncident} fallbackEvents={events} />
          </WorkstationPanel>

          <WorkstationPanel title="Dependency Map / 依賴地圖" kicker="blast radius">
            <DependencyMap />
          </WorkstationPanel>
        </section>

        <WorkstationPanel title="Operational Drilldown / 維運追蹤" kicker="full rows, not fake tabs">
          <div className="border-b border-[#263247] p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs leading-5 text-slate-400">
                保留完整 row 與 drilldown 入口；狀態用下方 sparkline / 分數條呈現，避免重複膠囊噪音。
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
