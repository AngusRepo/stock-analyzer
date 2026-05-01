import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import AppShell from '@/components/AppShell'
import {
  dataQualityApi,
  deployGateApi,
  modelPoolApi,
  observabilityApi,
  schedulerApi,
  systemApi,
  type DataQualityStatus,
  type ObservabilityEvent,
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
  XCircle,
} from 'lucide-react'
import {
  WorkstationPageTitle,
  WorkstationPanel,
  WorkstationPill,
  WorkstationCatCard,
  type WorkstationTone,
} from '@/components/workstation/WorkstationChrome'
import {
  AudienceRoleStrip,
  DecisionTraceRail,
  ObsDrilldownMap,
  SignalInsightCard,
} from '@/components/workstation/DecisionArchitecture'

function statusTone(status?: string): WorkstationTone {
  const s = String(status ?? '').toLowerCase()
  if (['ok', 'pass', 'success', 'active'].includes(s)) return 'ok'
  if (['warn', 'warning', 'running', 'skip', 'skipped'].includes(s)) return 'warn'
  if (['fail', 'failed', 'block', 'blocked', 'error'].includes(s)) return 'error'
  return 'neutral'
}

function formatStatus(status?: string) {
  return status ? String(status).toUpperCase() : 'UNKNOWN'
}

function hasPayload<T>(value: T | null | undefined): value is T {
  return value != null
}

function payloadState(isLoading: boolean, error: unknown) {
  if (isLoading) return '資料讀取中'
  if (error) return 'API 暫時讀不到資料，先視為需追查'
  return '目前沒有回傳資料'
}

function isStateSpaceOverlayModel(name: string, model: Record<string, unknown>) {
  return (
    name === 'KalmanFilter' ||
    name === 'MarkovSwitching' ||
    model.model_type === 'state_space_overlay' ||
    model.balance_family === 'state_space'
  )
}

function severityTone(severity?: string): WorkstationTone {
  if (severity === 'error') return 'error'
  if (severity === 'warn') return 'warn'
  if (severity === 'ok') return 'ok'
  if (severity === 'info') return 'info'
  return 'neutral'
}

function eventIcon(event: Pick<ObservabilityEvent, 'domain' | 'severity'>) {
  if (event.severity === 'ok') return CheckCircle2
  if (event.domain === 'data_quality') return Database
  if (event.domain === 'model_pool') return GitBranch
  if (event.domain === 'scheduler') return AlertTriangle
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
  return (
    <div className="border-r border-[#263247] bg-[#070a10] p-3 last:border-r-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8a92a6]">{label}</p>
      <p className={`mt-2 font-mono text-2xl font-semibold ${tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'error' ? 'text-rose-300' : 'text-slate-100'}`}>
        {value}
      </p>
      {detail && <p className="mt-1 text-xs text-slate-500">{detail}</p>}
    </div>
  )
}

function JobRow({ job }: { job: SchedulerJob }) {
  const tone = statusTone(job.lastStatus)
  return (
    <div className="grid grid-cols-[1fr_92px_78px_72px] items-center gap-2 border-b border-[#263247] px-3 py-2 font-mono text-[11px] last:border-b-0">
      <div className="min-w-0">
        <p className="truncate text-slate-100">{job.name}</p>
        <p className="truncate text-[#70809b]">{job.summary || job.schedule}</p>
      </div>
      <WorkstationPill tone={tone}>{job.lastStatus}</WorkstationPill>
      <span className="text-[#8a92a6]">{job.lastDuration || '-'}</span>
      <span className="truncate text-right text-[#70809b]">{job.group}</span>
    </div>
  )
}

function RootCauseItem({
  title,
  body,
  tone,
  icon: Icon,
}: {
  title: string
  body: string
  tone: WorkstationTone
  icon: typeof AlertTriangle
}) {
  return (
    <div className="grid grid-cols-[28px_1fr_auto] gap-3 border-b border-[#263247] p-3 last:border-b-0">
      <Icon className={`mt-0.5 h-4 w-4 ${tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'error' ? 'text-rose-300' : 'text-sky-300'}`} />
      <div>
        <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-slate-100">{title}</p>
        <p className="mt-1 text-xs leading-5 text-[#8a92a6]">{body}</p>
      </div>
      <WorkstationPill tone={tone}>{tone}</WorkstationPill>
    </div>
  )
}

function ObservabilityEventRow({ event }: { event: ObservabilityEvent }) {
  const Icon = eventIcon(event)
  return (
    <div className="grid grid-cols-[24px_116px_1fr_auto] gap-3 border-b border-[#263247] p-3 text-xs last:border-b-0">
      <Icon className={`mt-0.5 h-4 w-4 ${event.severity === 'ok' ? 'text-emerald-300' : event.severity === 'warn' ? 'text-amber-300' : event.severity === 'error' ? 'text-rose-300' : 'text-sky-300'}`} />
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#70809b]">
        <p>{event.domain}</p>
        <p className="mt-1 text-[#8a92a6]">{event.owner}</p>
      </div>
      <div className="min-w-0">
        <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-slate-100">{event.title}</p>
        <p className="mt-1 leading-5 text-[#8a92a6]">{event.summary}</p>
        <p className="mt-1 leading-5 text-slate-500">{event.next_action}</p>
      </div>
      <WorkstationPill tone={severityTone(event.severity)}>{event.severity}</WorkstationPill>
    </div>
  )
}

export default function ObservabilityPage() {
  const scheduler = useQuery({
    queryKey: ['obs', 'scheduler'],
    queryFn: schedulerApi.status,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const dataQuality = useQuery({
    queryKey: ['obs', 'data-quality'],
    queryFn: () => dataQualityApi.status(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const deployGate = useQuery({
    queryKey: ['obs', 'deploy-gate'],
    queryFn: () => deployGateApi.predeploy(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const modelPool = useQuery({
    queryKey: ['obs', 'model-pool-lineage'],
    queryFn: modelPoolApi.lineage,
    refetchInterval: 120_000,
    staleTime: 60_000,
  })
  const system = useQuery({
    queryKey: ['obs', 'system'],
    queryFn: systemApi.status,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const observability = useQuery({
    queryKey: ['obs', 'events'],
    queryFn: () => observabilityApi.events(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const failedJobs = useMemo(() => {
    return (scheduler.data?.jobs ?? []).filter(job => ['failed', 'running'].includes(job.lastStatus)).slice(0, 8)
  }, [scheduler.data])

  const staleQuality = useMemo(() => {
    return (dataQuality.data?.checks ?? []).filter(check => check.status !== 'ok').slice(0, 8)
  }, [dataQuality.data])

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

  const schedulerUnavailable = scheduler.isLoading || scheduler.isError || !hasPayload(scheduler.data)
  const dataQualityUnavailable = dataQuality.isLoading || dataQuality.isError || !hasPayload(dataQuality.data)
  const deployGateUnavailable = deployGate.isLoading || deployGate.isError || !hasPayload(deployGate.data)
  const modelPoolUnavailable = modelPool.isLoading || modelPool.isError || !hasPayload(modelPool.data)
  const observabilityUnavailable = observability.isLoading || observability.isError || !hasPayload(observability.data)
  const contractEvents = observability.data?.events ?? []
  const rootCauseEvents = contractEvents.filter((event) => event.severity !== 'ok')
  const visibleEvents = (rootCauseEvents.length ? rootCauseEvents : contractEvents).slice(0, 8)
  const auditEvents = observability.data?.audit?.recent ?? []

  const fallbackRootCause: Array<{
    title: string
    body: string
    tone: WorkstationTone
    icon: typeof AlertTriangle
  }> = [
    {
      title: 'Scheduler',
      body: schedulerUnavailable
        ? `Scheduler 狀態讀不到：${payloadState(scheduler.isLoading, scheduler.error)}`
        : failedJobs.length
          ? `${failedJobs.length} 個排程需要注意；優先看 ${failedJobs[0]?.name}`
          : '目前沒有失敗或卡住的排程。',
      tone: schedulerUnavailable ? 'warn' : failedJobs.length ? 'warn' : 'ok',
      icon: schedulerUnavailable || failedJobs.length ? AlertTriangle : CheckCircle2,
    },
    {
      title: 'Data Quality',
      body: dataQualityUnavailable
        ? `Data Quality 狀態讀不到：${payloadState(dataQuality.isLoading, dataQuality.error)}`
        : staleQuality.length
          ? `${staleQuality.length} 個資料品質檢查未通過；優先看 ${staleQuality[0]?.label}`
          : '目前 freshness 與 schema gate 都正常。',
      tone: dataQualityUnavailable ? 'warn' : staleQuality.length ? statusTone(staleQuality[0]?.status) : 'ok',
      icon: dataQualityUnavailable || staleQuality.length ? Database : CheckCircle2,
    },
    {
      title: 'Model Pool',
      body: modelPoolUnavailable
        ? `Model Pool 狀態讀不到：${payloadState(modelPool.isLoading, modelPool.error)}`
        : modelStats.weakIc || modelStats.missingMeta
          ? `${modelStats.weakIc} 組模型 IC 訊號偏弱或缺失；${modelStats.missingMeta} 組缺 metadata。`
          : '目前模型 metadata 與 IC lineage 看起來都有資料。',
      tone: modelPoolUnavailable ? 'warn' : modelStats.weakIc || modelStats.missingMeta ? 'warn' : 'ok',
      icon: modelPoolUnavailable || modelStats.weakIc || modelStats.missingMeta ? GitBranch : ShieldCheck,
    },
  ]

  return (
    <AppShell>
      <div className="space-y-4 p-4 lg:p-5">
        <WorkstationPageTitle
          kicker="OBS command center"
          title="Reliability Mission Control"
          description="統一觀察 Scheduler、Data Quality、Deploy Gate、Model Pool 與 System Health。這頁只讀既有 API，不改 backend。"
          action={
            <div className="flex flex-wrap gap-2">
              <WorkstationPill tone={dataQualityUnavailable ? 'warn' : statusTone(dataQuality.data?.overall)}>DQ {formatStatus(dataQuality.data?.overall)}</WorkstationPill>
              <WorkstationPill tone={deployGateUnavailable ? 'warn' : statusTone(deployGate.data?.decision)}>Gate {formatStatus(deployGate.data?.decision)}</WorkstationPill>
              <WorkstationPill tone={observabilityUnavailable ? 'warn' : severityTone(observability.data?.overall)}>OBS {formatStatus(observability.data?.overall)}</WorkstationPill>
              <WorkstationPill tone={system.error ? 'error' : 'ok'}>System {system.error ? 'ERROR' : 'ONLINE'}</WorkstationPill>
            </div>
          }
        />

        <AudienceRoleStrip />

        <DecisionTraceRail
          title="Reliability Decision Trace"
          compact
          steps={[
            { label: 'Symptom', detail: '先看使用者會感受到的症狀：空清單、髒價格、IC=0、scheduler fail。', tone: 'warn' },
            { label: 'Impact', detail: '標示影響範圍：Dashboard、Bot、ML、Data Quality 或 execution。', tone: 'info' },
            { label: 'Root Cause', detail: '把原因導向資料、排程、模型、owner boundary 或 deploy drift。', tone: 'error' },
            { label: 'Drilldown', detail: 'OBS 只給結論；細節連到 Scheduler / DataQuality / ModelPool。', tone: 'ok' },
          ]}
        />

        <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <WorkstationCatCard
            src="/stockvision-cats/05_stockvision_alert_first_seen.png"
            title="第一眼先抓鬼"
            caption="OBS 的任務不是報喜，是第一時間指出 scheduler、資料品質或模型治理哪裡斷線。"
            tone="warn"
          />
          <WorkstationCatCard
            src="/stockvision-cats/06_stockvision_monitoring_normal.png"
            title="正常也要監控"
            caption="綠燈不是放空，還要持續看 freshness、IC、callback contract 與 owner boundary。"
            tone="ok"
          />
        </section>

        <section className="grid grid-cols-1 gap-px border border-[#263247] bg-[#263247] md:grid-cols-4">
          <MetricCell
            label="Scheduler Success"
            value={`${scheduler.data?.stats?.successRate7d ?? 0}%`}
            tone={schedulerUnavailable ? 'warn' : (scheduler.data?.stats?.failed24h ?? 0) > 0 ? 'warn' : 'ok'}
            detail={`failed24h ${scheduler.data?.stats?.failed24h ?? '-'}`}
          />
          <MetricCell
            label="Data Quality"
            value={formatStatus(dataQuality.data?.overall)}
            tone={dataQualityUnavailable ? 'warn' : statusTone(dataQuality.data?.overall)}
            detail={dataQuality.data?.date ?? '-'}
          />
          <MetricCell
            label="Deploy Gate"
            value={formatStatus(deployGate.data?.decision)}
            tone={deployGateUnavailable ? 'warn' : statusTone(deployGate.data?.decision)}
            detail={deployGate.data?.generated_at ?? '-'}
          />
          <MetricCell
            label="Model Pool"
            value={`${modelStats.active}/${modelStats.total}`}
            tone={modelPoolUnavailable || modelStats.weakIc || modelStats.missingMeta ? 'warn' : 'ok'}
            detail={`${modelStats.challenger} challenger`}
          />
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <WorkstationPanel title="Root Cause Cockpit" kicker="answer first, logs second">
            <div>
              {observabilityUnavailable
                ? fallbackRootCause.map(item => (
                  <RootCauseItem key={item.title} {...item} />
                ))
                : visibleEvents.slice(0, 4).map((event) => (
                  <RootCauseItem
                    key={event.id}
                    title={event.title}
                    body={`${event.summary} Next: ${event.next_action}`}
                    tone={severityTone(event.severity)}
                    icon={eventIcon(event)}
                  />
                ))}
            </div>
          </WorkstationPanel>

          <WorkstationPanel title="Owner Boundary" kicker="single owner, no split-brain">
            <div className="grid grid-cols-1 gap-px bg-[#263247] font-mono text-[11px] sm:grid-cols-2">
              {[
                ...(observability.data?.owner_boundaries?.map((row) => [
                  row.owner,
                  `${row.responsibility} · ${row.source_of_truth}`,
                  observability.data?.domains?.find((domain) => domain.owner === row.owner)?.severity ?? 'ok',
                ]) ?? [
                  ['GCP Scheduler', 'triggers canonical jobs', schedulerUnavailable ? 'warn' : 'ok'],
                  ['Worker API', 'serves UI + state', system.error ? 'warn' : 'ok'],
                  ['Cloud Run', 'pipeline orchestration', schedulerUnavailable || failedJobs.length ? 'warn' : 'ok'],
                  ['Modal', 'heavy ML runtime', modelPoolUnavailable || modelStats.missingMeta ? 'warn' : 'ok'],
                  ['D1 / KV', 'serving state + run logs', dataQualityUnavailable ? 'warn' : 'ok'],
                  ['Frontend', 'read-only cockpit', 'ok'],
                ]),
              ].map(([owner, role, tone]) => (
                <div key={owner} className="bg-[#070a10] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-slate-100">{owner}</p>
                    <WorkstationPill tone={tone as WorkstationTone}>{tone}</WorkstationPill>
                  </div>
                  <p className="mt-2 text-[#70809b]">{role}</p>
                </div>
              ))}
            </div>
          </WorkstationPanel>
        </section>

        <WorkstationPanel title="Unified Event Contract" kicker="one schema for scheduler, data, deploy, lifecycle">
          <div>
            {observabilityUnavailable ? (
              <div className="p-4 text-sm text-slate-500">目前讀不到 OBS event payload；頁面先 fail-closed，不把未知狀態當健康。</div>
            ) : (
              visibleEvents.map((event) => <ObservabilityEventRow key={event.id} event={event} />)
            )}
          </div>
        </WorkstationPanel>

        <WorkstationPanel title="Audit Trail" kicker="persisted snapshots, not page-load side effects">
          <div>
            {auditEvents.length ? auditEvents.slice(0, 8).map((event) => (
              <ObservabilityEventRow key={`${event.id ?? event.event_id}-${event.created_at ?? event.ts}`} event={{
                ...event,
                id: event.id ?? event.event_id ?? `${event.domain}:${event.title}`,
                ts: event.ts ?? event.created_at ?? '',
              }} />
            )) : (
              <div className="p-4 text-sm text-slate-500">
                目前還沒有持久化的 OBS audit snapshot；部署後需由 smoke test 或 scheduler 觸發 snapshot writer，才會在 D1 留下稽核證據。
              </div>
            )}
          </div>
        </WorkstationPanel>

        <section className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
          <WorkstationPanel title="Scheduler Trace" kicker="recent jobs needing attention">
            <div>
              {(failedJobs.length ? failedJobs : (scheduler.data?.jobs ?? []).slice(0, 8)).map(job => (
                <JobRow key={job.id} job={job} />
              ))}
              {!scheduler.data?.jobs?.length && (
                <div className="p-4 text-sm text-slate-500">目前沒有 scheduler payload；請先看 API 權限、callback contract 或 GCP Scheduler 同步狀態。</div>
              )}
            </div>
          </WorkstationPanel>

          <WorkstationPanel title="Data Quality Gaps" kicker="freshness, schema, parity">
            <div>
              {(staleQuality.length ? staleQuality : (dataQuality.data?.checks ?? []).slice(0, 8)).map(check => (
                <div key={check.id} className="grid grid-cols-[1fr_auto] gap-3 border-b border-[#263247] p-3 last:border-b-0">
                  <div>
                    <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-slate-100">{check.label}</p>
                    <p className="mt-1 text-xs leading-5 text-[#8a92a6]">{check.summary}</p>
                  </div>
                  <WorkstationPill tone={statusTone(check.status as DataQualityStatus)}>{check.status}</WorkstationPill>
                </div>
              ))}
              {!dataQuality.data?.checks?.length && (
                <div className="p-4 text-sm text-slate-500">目前沒有 data quality payload；請先看 P6/P9 gate 是否有產出 freshness/schema/parity 檢查。</div>
              )}
            </div>
          </WorkstationPanel>
        </section>

        <WorkstationPanel title="名詞速查" kicker="same words, same meaning">
          <div className="grid gap-px bg-[#263247] md:grid-cols-2 xl:grid-cols-4">
            {[
              ['DQ', 'Data Quality，檢查價格、籌碼、feature schema、train/serve parity 是否可信。'],
              ['IC', 'Information Coefficient，模型預測排序與實際結果的相關性，用來判斷模型最近有沒有失準。'],
              ['POC', '近期成交量最集中的價格區，應只用新鮮且可追溯的量價資料。'],
              ['Fair value', '系統估算的合理價格帶，不是保證目標價；偏離過大時應先查資料新鮮度。'],
              ['Alpha bucket', '目前這檔股票比較像哪種交易 edge，例如趨勢、突破、均值回歸或防守累積。'],
              ['Market structure', '市場結構脈絡，包含 POC、合理價格帶、流動性與價格位置。'],
              ['Owner boundary', '每段流程只能有一個主責 owner，避免新舊 pipeline 並行互相覆蓋。'],
              ['Snapshot', '把當下 OBS 判斷寫入 D1，讓事後追 root cause 有證據，而不是只看當下畫面。'],
            ].map(([term, description]) => (
              <div key={term} className="bg-[#070a10] p-3">
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-amber-200">{term}</p>
                <p className="mt-2 text-xs leading-5 text-[#8a92a6]">{description}</p>
              </div>
            ))}
          </div>
        </WorkstationPanel>

        <div className="grid gap-3 md:grid-cols-3">
          <SignalInsightCard
            title="Model Health"
            value={`${modelStats.active}/${modelStats.total}`}
            detail={`OBS 只顯示模型健康摘要；完整 IC、metadata、challenger lineage 請進 Model Pool。weak IC ${modelStats.weakIc}，metadata gaps ${modelStats.missingMeta}。`}
            tone={modelPoolUnavailable || modelStats.weakIc || modelStats.missingMeta ? 'warn' : 'ok'}
          />
          <SignalInsightCard
            title="Data Trust"
            value={formatStatus(dataQuality.data?.overall)}
            detail="資料 freshness / schema / train-serve parity 是推薦與 IC 能不能相信的前置條件。"
            tone={dataQualityUnavailable ? 'warn' : statusTone(dataQuality.data?.overall)}
          />
          <SignalInsightCard
            title="Run Health"
            value={`${scheduler.data?.stats?.successRate7d ?? 0}%`}
            detail={`Scheduler 詳細 run log 留在 Scheduler drilldown；OBS 只顯示失敗是否影響今天決策。failed24h ${scheduler.data?.stats?.failed24h ?? '-'}`}
            tone={schedulerUnavailable ? 'warn' : (scheduler.data?.stats?.failed24h ?? 0) > 0 ? 'warn' : 'ok'}
          />
        </div>

        <ObsDrilldownMap />

        <section className="grid gap-4 md:grid-cols-3">
          {[
            { icon: Network, title: 'Trace Contract', body: 'Scheduler, pipeline, ML, verify use one observable status language.' },
            { icon: TimerReset, title: 'Freshness Contract', body: 'Data Quality is the first stop before trusting recommendations or IC.' },
            { icon: XCircle, title: 'No Silent Fallback', body: 'OBS should explain empty UI, stale data, metadata gaps, and owner boundary drift.' },
          ].map(item => {
            const Icon = item.icon
            return (
              <div key={item.title} className="border border-[#263247] bg-[#070a10]/90 p-4">
                <Icon className="h-5 w-5 text-sky-300" />
                <p className="mt-3 font-mono text-[12px] uppercase tracking-[0.12em] text-slate-100">{item.title}</p>
                <p className="mt-2 text-xs leading-5 text-[#8a92a6]">{item.body}</p>
              </div>
            )
          })}
        </section>
      </div>
    </AppShell>
  )
}
