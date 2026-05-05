import { useMemo } from 'react'
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
  if (event.domain === 'validation') return ShieldCheck
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
      <WorkstationPill tone={tone}>{job.lastStatus || 'unknown'}</WorkstationPill>
      <span className="text-[#8a92a6]">{job.lastDuration || '-'}</span>
      <span className="truncate text-right text-[#70809b]">{job.group}</span>
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
  const drilldown = useQuery({
    queryKey: ['obs', 'drilldown'],
    queryFn: () => observabilityApi.drilldown(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const resourceAudit = useQuery({
    queryKey: ['obs', 'resource-audit'],
    queryFn: opsApi.resourceAudit,
    refetchInterval: 300_000,
    staleTime: 120_000,
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

  const contractEvents = observability.data?.events ?? []
  const visibleEvents = (contractEvents.filter(event => event.severity !== 'ok').length
    ? contractEvents.filter(event => event.severity !== 'ok')
    : contractEvents).slice(0, 8)
  const auditEvents = observability.data?.audit?.recent ?? []
  const resourceItems = resourceAudit.data?.items ?? []

  return (
    <AppShell>
      <div className="space-y-4 p-4 lg:p-5">
        <WorkstationPageTitle
          kicker="OBS command center"
          title="Reliability Mission Control"
          description="把 Scheduler、Data Quality、Deploy Gate、Model Pool、Resource Audit 收到同一個可觀測性入口：先看影響面，再 drill down 到原始頁面。"
          action={
            <div className="flex flex-wrap gap-2">
              <WorkstationPill tone={statusTone(dataQuality.data?.overall)}>DQ {formatStatus(dataQuality.data?.overall)}</WorkstationPill>
              <WorkstationPill tone={statusTone(deployGate.data?.decision)}>Gate {formatStatus(deployGate.data?.decision)}</WorkstationPill>
              <WorkstationPill tone={severityTone(observability.data?.overall)}>OBS {formatStatus(observability.data?.overall)}</WorkstationPill>
              <WorkstationPill tone={system.error ? 'error' : 'ok'}>System {system.error ? 'ERROR' : 'ONLINE'}</WorkstationPill>
            </div>
          }
        />

        <AudienceRoleStrip />

        <DecisionTraceRail
          title="Reliability Decision Trace"
          compact
          steps={[
            { label: 'Symptom', detail: '先看空畫面、失敗排程、IC=0、資料過期、callback 異常。', tone: 'warn' },
            { label: 'Impact', detail: '確認影響 Dashboard、Bot、ML、Data Quality 或 execution 哪一層。', tone: 'info' },
            { label: 'Root Cause', detail: '用 run_id、owner、source_of_truth 找到責任邊界，避免 split-brain。', tone: 'error' },
            { label: 'Action', detail: '只給 read-only 診斷與下一步，破壞性清理仍需人工核准。', tone: 'ok' },
          ]}
        />

        <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <WorkstationCatCard
            src="/stockvision-cats/05_stockvision_alert_first_seen.png"
            title="先抓兇手"
            caption="OBS 不只顯示紅燈，還要講清楚 root cause、影響股票、run_id 與下一步。"
            tone="warn"
          />
          <WorkstationCatCard
            src="/stockvision-cats/06_stockvision_monitoring_normal.png"
            title="穩定巡邏"
            caption="正常時也要留下 freshness、IC、callback contract、owner boundary 的健康證據。"
            tone="ok"
          />
        </section>

        <section className="grid grid-cols-1 gap-px border border-[#263247] bg-[#263247] md:grid-cols-4">
          <MetricCell
            label="Scheduler Success"
            value={`${scheduler.data?.stats?.successRate7d ?? 0}%`}
            tone={(scheduler.data?.stats?.failed24h ?? 0) > 0 ? 'warn' : 'ok'}
            detail={`failed24h ${scheduler.data?.stats?.failed24h ?? '-'}`}
          />
          <MetricCell
            label="Data Quality"
            value={formatStatus(dataQuality.data?.overall)}
            tone={statusTone(dataQuality.data?.overall)}
            detail={dataQuality.data?.date ?? '-'}
          />
          <MetricCell
            label="Deploy Gate"
            value={formatStatus(deployGate.data?.decision)}
            tone={statusTone(deployGate.data?.decision)}
            detail={deployGate.data?.generated_at ?? '-'}
          />
          <MetricCell
            label="Model Pool"
            value={`${modelStats.active}/${modelStats.total}`}
            tone={modelStats.weakIc || modelStats.missingMeta ? 'warn' : 'ok'}
            detail={`${modelStats.challenger} challenger`}
          />
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <WorkstationPanel title="Root Cause Cockpit" kicker="answer first, logs second">
            <div>
              {visibleEvents.length ? visibleEvents.slice(0, 4).map((event) => {
                const Icon = eventIcon(event)
                return (
                  <div key={event.id} className="grid grid-cols-[28px_1fr_auto] gap-3 border-b border-[#263247] p-3 last:border-b-0">
                    <Icon className={`mt-0.5 h-4 w-4 ${event.severity === 'ok' ? 'text-emerald-300' : event.severity === 'warn' ? 'text-amber-300' : event.severity === 'error' ? 'text-rose-300' : 'text-sky-300'}`} />
                    <div>
                      <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-slate-100">{event.title}</p>
                      <p className="mt-1 text-xs leading-5 text-[#8a92a6]">{event.summary}</p>
                      <p className="mt-1 text-xs leading-5 text-slate-500">Next: {event.next_action}</p>
                    </div>
                    <WorkstationPill tone={severityTone(event.severity)}>{event.severity}</WorkstationPill>
                  </div>
                )
              }) : (
                <div className="p-4 text-sm text-slate-500">目前沒有 OBS event payload；請部署後用 live smoke 驗證事件來源。</div>
              )}
            </div>
          </WorkstationPanel>

          <WorkstationPanel title="Owner Boundary" kicker="single owner, no split-brain">
            <div className="grid grid-cols-1 gap-px bg-[#263247] font-mono text-[11px] sm:grid-cols-2">
              {(observability.data?.owner_boundaries ?? [
                { owner: 'GCP Scheduler', responsibility: 'canonical job trigger', source_of_truth: 'scheduler registry' },
                { owner: 'Worker API', responsibility: 'read APIs and callback state', source_of_truth: 'D1/KV' },
                { owner: 'Cloud Run', responsibility: 'pipeline orchestration', source_of_truth: 'job run_id' },
                { owner: 'Modal', responsibility: 'heavy ML runtime', source_of_truth: 'artifact manifest' },
                { owner: 'D1 / KV', responsibility: 'serving state and logs', source_of_truth: 'versioned records' },
                { owner: 'Frontend', responsibility: 'read-only cockpit', source_of_truth: 'admin APIs' },
              ]).map((row) => {
                const domain = observability.data?.domains?.find(item => item.owner === row.owner)
                return (
                  <div key={row.owner} className="bg-[#070a10] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-slate-100">{row.owner}</p>
                      <WorkstationPill tone={severityTone(domain?.severity ?? 'ok')}>{domain?.severity ?? 'ok'}</WorkstationPill>
                    </div>
                    <p className="mt-2 text-[#70809b]">{row.responsibility} / {row.source_of_truth}</p>
                  </div>
                )
              })}
            </div>
          </WorkstationPanel>
        </section>

        <WorkstationPanel title="Incident Drilldown" kicker="where, why, affected run, next action">
          <div>
            {(drilldown.data?.incidents ?? []).slice(0, 6).map((incident) => (
              <div key={incident.id} className="grid gap-3 border-b border-[#263247] p-3 last:border-b-0 lg:grid-cols-[1fr_1.2fr_0.9fr_auto]">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">{incident.domain}</p>
                  <p className="mt-1 font-mono text-[12px] uppercase tracking-[0.12em] text-slate-100">{incident.title}</p>
                  <p className="mt-1 text-xs text-[#8a92a6]">{incident.owner}</p>
                </div>
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">Root cause</p>
                  <p className="mt-1 text-xs leading-5 text-[#8a92a6]">{incident.root_cause}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{incident.impact}</p>
                </div>
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-sky-200">Affected</p>
                  <p className="mt-1 text-xs leading-5 text-[#8a92a6]">run: {incident.run_ids.join(', ') || '-'}</p>
                  <p className="mt-1 text-xs leading-5 text-[#8a92a6]">symbols: {incident.affected_symbols.slice(0, 8).join(', ') || '-'}</p>
                </div>
                <div className="flex flex-col items-start gap-2 lg:items-end">
                  <WorkstationPill tone={severityTone(incident.severity)}>{incident.status}</WorkstationPill>
                  <p className="max-w-[220px] text-xs leading-5 text-[#8a92a6] lg:text-right">{incident.next_action}</p>
                </div>
              </div>
            ))}
            {!drilldown.data?.incidents?.length && (
              <div className="p-4 text-sm text-slate-500">尚未取得 drilldown incident；部署後請用 live smoke 打 OBS drilldown API。</div>
            )}
          </div>
        </WorkstationPanel>

        <WorkstationPanel title="Resource Audit" kicker="read-only cleanup intelligence">
          <div className="grid gap-px bg-[#263247] md:grid-cols-2">
            {resourceItems.map((item) => (
              <div key={item.id} className="bg-[#070a10] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">{item.owner}</p>
                    <p className="mt-1 font-mono text-[12px] uppercase tracking-[0.12em] text-slate-100">{item.id}</p>
                  </div>
                  <WorkstationPill tone={statusTone(item.status)}>{item.status}</WorkstationPill>
                </div>
                <p className="mt-3 text-xs leading-5 text-[#8a92a6]">{item.summary}</p>
                <p className="mt-2 text-xs leading-5 text-slate-500">{item.next_action}</p>
              </div>
            ))}
            {!resourceItems.length && (
              <div className="bg-[#070a10] p-4 text-sm text-slate-500 md:col-span-2">尚未取得 resource audit；這個區塊只讀取 D1/KV 指標，不會做任何清理或刪除。</div>
            )}
          </div>
        </WorkstationPanel>

        <WorkstationPanel title="Unified Event Contract" kicker="one schema for scheduler, data, deploy, lifecycle">
          <div>
            {visibleEvents.length ? (
              visibleEvents.map((event) => <ObservabilityEventRow key={event.id} event={event} />)
            ) : (
              <div className="p-4 text-sm text-slate-500">OBS event payload unavailable；請確認 Worker route 與 D1 audit snapshot writer。</div>
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
                尚未看到 OBS audit snapshot。部署後 smoke test 要確認 snapshot writer 有把事件寫入 D1。
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
                <div className="p-4 text-sm text-slate-500">尚未取得 scheduler payload；請檢查 API、callback contract 與 GCP Scheduler 狀態。</div>
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
                  <WorkstationPill tone={statusTone(check.status)}>{check.status}</WorkstationPill>
                </div>
              ))}
              {!dataQuality.data?.checks?.length && (
                <div className="p-4 text-sm text-slate-500">尚未取得 data quality payload；請確認 P6/P9 gate 是否有寫入 freshness/schema/parity 結果。</div>
              )}
            </div>
          </WorkstationPanel>
        </section>

        <WorkstationPanel title="名詞解釋" kicker="same words, same meaning">
          <div className="grid gap-px bg-[#263247] md:grid-cols-2 xl:grid-cols-4">
            {[
              ['DQ', 'Data Quality，檢查價格、籌碼、feature schema、train/serve parity 是否可信。'],
              ['IC', 'Information Coefficient，衡量模型預測排序和後續報酬排序的相關性。'],
              ['POC', '近期成交量最集中的價格，用來理解市場接受的主要成本區。'],
              ['Fair value', '系統估計的合理價格帶，不是保證目標價，要搭配風險與流動性看。'],
              ['Alpha bucket', '股票目前更接近哪種 edge：趨勢、均值回歸、突破、或防守累積。'],
              ['Market structure', '價格、量、POC、fair value、波動與流動性的市場結構摘要。'],
              ['partially_filled', '部分成交，代表只有一部分股數成交，剩餘股數要進入重掛、取消或等待策略。'],
              ['stale_quote', '報價過期，系統不能用舊 bid/ask 或昨日收盤價幻想成交。'],
              ['quote_unavailable', '缺少即時 bid/ask 報價時 fail-closed，不用假價格進場。'],
              ['Owner boundary', '每個決策只允許一個 owner 與 source of truth，避免新舊流程並行。'],
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
            detail={`weak IC ${modelStats.weakIc}；metadata gaps ${modelStats.missingMeta}。OBS 只做摘要，細節仍 drill down 到 Model Pool。`}
            tone={modelStats.weakIc || modelStats.missingMeta ? 'warn' : 'ok'}
          />
          <SignalInsightCard
            title="Data Trust"
            value={formatStatus(dataQuality.data?.overall)}
            detail="資料品質是推薦、IC、backtest、execution 可信度的第一層 gate。"
            tone={statusTone(dataQuality.data?.overall)}
          />
          <SignalInsightCard
            title="Run Health"
            value={`${scheduler.data?.stats?.successRate7d ?? 0}%`}
            detail={`failed24h ${scheduler.data?.stats?.failed24h ?? '-'}；失敗時先看 run_id 與 callback contract。`}
            tone={(scheduler.data?.stats?.failed24h ?? 0) > 0 ? 'warn' : 'ok'}
          />
        </div>

        <ObsDrilldownMap />

        <section className="grid gap-4 md:grid-cols-3">
          {[
            { icon: Activity, title: 'Trace Contract', body: 'Scheduler、pipeline、ML、verify 使用同一套可觀測狀態語意。' },
            { icon: TimerReset, title: 'Freshness Contract', body: '資料 freshness 是信任推薦與 IC 前的第一個硬門檻。' },
            { icon: XCircle, title: 'No Silent Fallback', body: '空畫面、舊資料、metadata gap、owner drift 都必須被 OBS 解釋。' },
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
