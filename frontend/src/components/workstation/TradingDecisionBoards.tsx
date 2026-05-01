import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Bot,
  CheckCircle2,
  Database,
  GitBranch,
  Layers3,
  LineChart,
  Network,
  Search,
  ShieldCheck,
  TimerReset,
  TrendingUp,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import StockSearchCombobox, { type StockSelection } from '@/components/StockSearchCombobox'
import { RecommendationCardClean, AI_TOP_PICK_EXPLANATION } from '@/components/RecommendationCardClean'
import {
  dataQualityApi,
  deployGateApi,
  marketApi,
  modelPoolApi,
  observabilityApi,
  paperApi,
  recommendationsApi,
  schedulerApi,
  systemApi,
  type DataQualityCheck,
  type ObservabilityEvent,
  type SchedulerJob,
} from '@/lib/api'

type Tone = 'ok' | 'warn' | 'error' | 'info' | 'neutral'

const toneLabel: Record<Tone, string> = {
  ok: 'OK',
  warn: '注意',
  error: '異常',
  info: '資訊',
  neutral: '觀察',
}

function toneFromStatus(status?: string): Tone {
  const s = String(status ?? '').toLowerCase()
  if (['ok', 'pass', 'success', 'active'].includes(s)) return 'ok'
  if (['warn', 'warning', 'running', 'skip', 'skipped'].includes(s)) return 'warn'
  if (['fail', 'failed', 'block', 'blocked', 'error'].includes(s)) return 'error'
  return 'neutral'
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

function StatusPill({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={cx('sv-status-pill', `sv-status-${tone}`)}>{children}</span>
}

function TerminalPanel({
  title,
  kicker,
  children,
  action,
  className,
}: {
  title: string
  kicker?: string
  children: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <section className={cx('sv-terminal-panel', className)}>
      <header className="sv-panel-header">
        <div className="min-w-0">
          {kicker && <p className="sv-kicker">{kicker}</p>}
          <h2>{title}</h2>
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

function MetricTile({
  label,
  value,
  tone = 'neutral',
  detail,
}: {
  label: string
  value: string
  tone?: Tone
  detail?: string
}) {
  return (
    <div className="sv-metric-tile">
      <p>{label}</p>
      <strong className={`sv-text-${tone}`}>{value}</strong>
      {detail && <span>{detail}</span>}
    </div>
  )
}

function CatAside({ src, title, body }: { src: string; title: string; body: string }) {
  return (
    <div className="sv-cat-aside">
      <img src={src} alt={title} loading="lazy" />
      <div>
        <StatusPill tone="info">{title}</StatusPill>
        <p>{body}</p>
      </div>
    </div>
  )
}

function splitRecommendations(payload: any) {
  const tradable = payload?.tradable_recommendations ?? payload?.recommendations ?? payload?.data ?? []
  const emerging = payload?.emerging_recommendations ?? []
  return {
    tradable: Array.isArray(tradable) ? tradable : [],
    emerging: Array.isArray(emerging) ? emerging : [],
  }
}

function marketSegmentLabel(rec: any) {
  const segment = String(rec?.market_segment ?? rec?.market ?? '').toUpperCase()
  if (segment === 'EMERGING') return '興櫃研究'
  if (segment === 'OTC') return '上櫃'
  if (segment === 'LISTED' || segment === 'TWSE') return '上市'
  return segment || '台股'
}

function RecommendationLane({
  title,
  subtitle,
  items,
  tone,
  limit = 8,
}: {
  title: string
  subtitle: string
  items: any[]
  tone: Tone
  limit?: number
}) {
  return (
    <TerminalPanel
      title={title}
      kicker={subtitle}
      action={<StatusPill tone={tone}>{items.length} 檔</StatusPill>}
    >
      <div className="sv-reco-lane">
        {items.length === 0 ? (
          <div className="sv-empty-state">目前沒有符合條件的推薦；先看資料品質與 pipeline 狀態，不硬湊清單。</div>
        ) : (
          items.slice(0, limit).map((rec, index) => (
            <div key={`${rec.symbol ?? rec.stock_id}-${index}`} className="sv-reco-shell">
              <div className="sv-card-strip">
                <span>{marketSegmentLabel(rec)}</span>
                <span>{rec.recommendation_lane ?? (rec.eligible_for_pending_buy === false ? 'research only' : 'execution lane')}</span>
              </div>
              <RecommendationCardClean rec={rec} rank={index + 1} />
            </div>
          ))
        )}
      </div>
    </TerminalPanel>
  )
}

export function DecisionDeskHome({
  onSelect,
  user,
}: {
  onSelect: (s: StockSelection) => void
  user: any
}) {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const recs = useQuery({
    queryKey: ['workstation', 'daily-recommendations', today],
    queryFn: () => recommendationsApi.daily(),
    staleTime: 5 * 60_000,
  })
  const indices = useQuery({
    queryKey: ['workstation', 'indices'],
    queryFn: marketApi.indices,
    staleTime: 5 * 60_000,
  })
  const dataQuality = useQuery({
    queryKey: ['workstation', 'dq'],
    queryFn: () => dataQualityApi.status(),
    staleTime: 60_000,
  })
  const modelPool = useQuery({
    queryKey: ['workstation', 'model-pool-lineage'],
    queryFn: modelPoolApi.lineage,
    staleTime: 120_000,
  })

  const { tradable, emerging } = splitRecommendations(recs.data)
  const modelEntries = Object.entries(modelPool.data?.models ?? {})
  const weakModels = modelEntries.filter(([, model]: any) => {
    const ic = Number(model.ic_4w_avg ?? model.rolling_ic)
    return !Number.isFinite(ic) || Math.abs(ic) < 0.0001 || model.last_ic_status !== 'computed'
  })
  const marketItems = Array.isArray(indices.data) ? indices.data.slice(0, 4) : []

  return (
    <div className="sv-workstation sv-decision-desk">
      <section className="sv-command-band">
        <div>
          <p className="sv-kicker">Market decision desk</p>
          <h1>選股作戰桌</h1>
          <p>先看資料可不可信，再看上市櫃候選，最後把興櫃拆成研究區。這裡不混 pending buys，也不偷渡舊清單。</p>
        </div>
        <div className="sv-command-search">
          <Search className="h-4 w-4" />
          <StockSearchCombobox onSelect={onSelect} />
        </div>
      </section>

      <section className="sv-metric-grid">
        <MetricTile label="推薦日期" value={recs.data?.date ?? today} tone={recs.isError ? 'error' : 'ok'} detail="daily_recommendations" />
        <MetricTile label="上市櫃候選" value={String(tradable.length)} tone={tradable.length ? 'ok' : 'warn'} detail="可進 morning/debate" />
        <MetricTile label="興櫃研究池" value={String(emerging.length)} tone={emerging.length ? 'info' : 'neutral'} detail="不自動交易" />
        <MetricTile label="ML lifecycle" value={`${Math.max(0, modelEntries.length - weakModels.length)}/${modelEntries.length || 8}`} tone={weakModels.length ? 'warn' : 'ok'} detail={weakModels.length ? `${weakModels.length} 模型需追蹤` : 'IC/metadata OK'} />
      </section>

      <section className="sv-workspace-grid">
        <div className="sv-left-rail">
          <CatAside
            src="/stockvision-cats/01_bull_market_train.png"
            title="盤面先問清楚"
            body="如果 price/chip freshness 或 IC lineage 不乾淨，推薦分數再漂亮也只能當研究，不該直接進交易。"
          />
          <TerminalPanel title="Market Tape" kicker="TWSE / OTC / macro pulse">
            <div className="sv-mini-table">
              {marketItems.length ? marketItems.map((item: any) => (
                <div key={item.symbol ?? item.name}>
                  <span>{item.name ?? item.symbol}</span>
                  <strong>{Number(item.close ?? item.price ?? 0).toLocaleString('zh-TW')}</strong>
                  <em className={Number(item.change ?? 0) >= 0 ? 'sv-text-ok' : 'sv-text-error'}>
                    {Number(item.changePct ?? 0).toFixed(2)}%
                  </em>
                </div>
              )) : <div className="sv-empty-state">市場指數載入中</div>}
            </div>
          </TerminalPanel>
          <TerminalPanel title="Quality Gate" kicker="can I trust this slate?">
            <div className="sv-check-list">
              {(dataQuality.data?.checks ?? []).slice(0, 5).map((check: DataQualityCheck) => (
                <div key={check.id}>
                  <StatusPill tone={toneFromStatus(check.status)}>{check.status}</StatusPill>
                  <span>{check.label}</span>
                </div>
              ))}
              {!dataQuality.data?.checks?.length && <div className="sv-empty-state">等待 data quality payload</div>}
            </div>
          </TerminalPanel>
        </div>

        <div className="sv-main-board">
          <TerminalPanel title="AI Top Picks Contract" kicker="score terms, no hidden boost">
            <div className="sv-explain-strip">
              <BarChart3 className="h-4 w-4" />
              <span>{AI_TOP_PICK_EXPLANATION}</span>
            </div>
          </TerminalPanel>
          <RecommendationLane
            title="上市櫃交易候選"
            subtitle="eligible for morning setup / debate / pending buys"
            items={tradable}
            tone="ok"
            limit={10}
          />
        </div>

        <div className="sv-right-rail">
          <RecommendationLane
            title="興櫃研究雷達"
            subtitle="research only, not auto execution"
            items={emerging}
            tone="warn"
            limit={8}
          />
          <TerminalPanel title="Operator Note" kicker="why this page exists">
            <div className="sv-narrative">
              <p>Dashboard 只負責「決策前觀察」。Bot 才負責「掛單與成交」。OBS 負責「找壞掉的 owner」。</p>
              <p>這樣 Dashboard 與 Bot 不會再各自 fallback，避免你一直看到兩邊清單不同步。</p>
              {!user && <p>未登入時仍可看決策框架；需要交易狀態時才要求登入。</p>}
            </div>
          </TerminalPanel>
        </div>
      </section>
    </div>
  )
}

function normalizePendingBuyToRecommendation(row: any) {
  const priceLine = row.ml_entry_price
    ? `建議限價 ${row.ml_entry_price}，停損 ${row.ml_stop_loss ?? '-'}，T1 ${row.ml_target1 ?? '-'}`
    : ''
  return {
    symbol: row.symbol,
    name: row.name,
    signal: row.signal,
    confidence: row.confidence,
    current_price: row.ml_entry_price ?? row.current_price,
    score: row.score ?? 0,
    sector: row.sector ?? '',
    reason: [priceLine, row.reason].filter(Boolean).join('\n\n'),
    watch_points: row.watch_points ?? null,
    chip_score: row.chip_score ?? null,
    tech_score: row.tech_score ?? null,
    ml_score: row.ml_score ?? null,
    alpha_context: row.alpha_context ?? null,
    alpha_allocation: row.alpha_allocation ?? null,
    ml_vote_summary: row.ml_vote_summary ?? null,
    prediction_forecast_data: row.prediction_forecast_data ?? null,
  }
}

export function ExecutionSignalBoard({
  onSelectSymbol,
  selectedSymbol,
}: {
  onSelectSymbol?: (symbol: string) => void
  selectedSymbol?: string | null
}) {
  const pending = useQuery({
    queryKey: ['workstation', 'pending-buys'],
    queryFn: () => paperApi.pendingBuys(),
    staleTime: 60_000,
  })
  const recs = useQuery({
    queryKey: ['workstation', 'daily-recommendations-fallback'],
    queryFn: () => recommendationsApi.daily(),
    staleTime: 5 * 60_000,
  })

  const pendingBuys: any[] = Array.isArray(pending.data?.pendingBuys) ? pending.data.pendingBuys : []
  const { tradable, emerging } = splitRecommendations(recs.data)
  const executionState = pending.data?.state?.state ?? (pendingBuys.length ? 'ready' : 'pre_debate')
  const displayRows = pendingBuys.length ? pendingBuys.map(normalizePendingBuyToRecommendation) : tradable
  const mode = pendingBuys.length ? 'post-debate pending buys' : 'pre-debate daily recommendations'

  return (
    <div className="sv-execution-board">
      <section className="sv-execution-header">
        <div>
          <p className="sv-kicker">Execution contract</p>
          <h3>{pendingBuys.length ? '已通過 Debate 的掛單池' : '尚未 Debate 的候選池'}</h3>
          <p>
            Bot 頁現在明確分狀態：早上 debate 前顯示 daily recommendations 候選；debate 後才切成 pending buys。
          </p>
        </div>
        <div className="sv-state-machine">
          {['daily', 'morning', 'debate', 'pending', 'filled/skipped'].map((step, index) => (
            <span key={step} className={index <= (pendingBuys.length ? 3 : 0) ? 'active' : ''}>{step}</span>
          ))}
        </div>
      </section>

      <section className="sv-metric-grid compact">
        <MetricTile label="顯示模式" value={mode} tone={pendingBuys.length ? 'ok' : 'info'} detail={pending.data?.date ?? recs.data?.date ?? '-'} />
        <MetricTile label="pending buys" value={String(pendingBuys.length)} tone={pendingBuys.length ? 'ok' : 'warn'} detail={executionState} />
        <MetricTile label="候選池" value={String(tradable.length)} tone={tradable.length ? 'ok' : 'warn'} detail="listed / OTC" />
        <MetricTile label="興櫃研究" value={String(emerging.length)} tone={emerging.length ? 'info' : 'neutral'} detail="not executable" />
      </section>

      <div className="sv-execution-grid">
        <TerminalPanel title="Execution Blotter" kicker={mode} className="sv-span-2">
          <div className="sv-reco-lane">
            {displayRows.length ? displayRows.slice(0, 12).map((rec, index) => (
              <div key={`${rec.symbol}-${index}`} className={cx('sv-reco-shell', selectedSymbol === rec.symbol && 'is-selected')}>
                <div className="sv-card-strip">
                  <span>{pendingBuys.length ? 'pending buy' : 'daily candidate'}</span>
                  <button type="button" onClick={() => onSelectSymbol?.(rec.symbol)}>看 K 線 <ArrowRight className="h-3 w-3" /></button>
                </div>
                <RecommendationCardClean rec={rec} rank={index + 1} />
              </div>
            )) : (
              <div className="sv-empty-state">目前沒有候選資料；先看 OBS 的 data quality 與 scheduler trace。</div>
            )}
          </div>
        </TerminalPanel>

        <TerminalPanel title="Safety Console" kicker="pre-order guardrails">
          <div className="sv-guard-list">
            {[
              ['價格不可穿越', '不允許用昨日收盤價假裝今日可成交', 'ok'],
              ['處置/興櫃隔離', '處置股阻擋；興櫃只進研究區', 'ok'],
              ['即時報價缺失', 'quote 404 是資料錯誤，不是正常暫緩', 'warn'],
              ['T+2 現金分離', '資產、庫存、市值不可混算', 'ok'],
            ].map(([title, body, tone]) => (
              <div key={title}>
                <StatusPill tone={tone as Tone}>{toneLabel[tone as Tone]}</StatusPill>
                <strong>{title}</strong>
                <span>{body}</span>
              </div>
            ))}
          </div>
        </TerminalPanel>
      </div>
    </div>
  )
}

function RootCauseCard({ event }: { event: ObservabilityEvent }) {
  const tone = event.severity === 'error' ? 'error' : event.severity === 'warn' ? 'warn' : event.severity === 'ok' ? 'ok' : 'info'
  const Icon = tone === 'error' ? XCircle : tone === 'warn' ? AlertTriangle : CheckCircle2
  return (
    <div className="sv-root-cause-card">
      <Icon className={`sv-text-${tone}`} />
      <div>
        <div className="sv-root-title">
          <strong>{event.title}</strong>
          <StatusPill tone={tone}>{event.status}</StatusPill>
        </div>
        <p>{event.summary}</p>
        <small>下一步：{event.next_action}</small>
      </div>
    </div>
  )
}

function DependencyStep({ label, status, owner }: { label: string; status: Tone; owner: string }) {
  return (
    <div className={`sv-dependency-step sv-dependency-${status}`}>
      <span>{label}</span>
      <strong>{owner}</strong>
    </div>
  )
}

export function ObservabilityCommandCenter() {
  const scheduler = useQuery({
    queryKey: ['obs-v2', 'scheduler'],
    queryFn: schedulerApi.status,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const dataQuality = useQuery({
    queryKey: ['obs-v2', 'data-quality'],
    queryFn: () => dataQualityApi.status(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const deployGate = useQuery({
    queryKey: ['obs-v2', 'deploy-gate'],
    queryFn: () => deployGateApi.predeploy(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const modelPool = useQuery({
    queryKey: ['obs-v2', 'model-pool'],
    queryFn: modelPoolApi.lineage,
    refetchInterval: 120_000,
    staleTime: 60_000,
  })
  const system = useQuery({
    queryKey: ['obs-v2', 'system'],
    queryFn: systemApi.status,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const observability = useQuery({
    queryKey: ['obs-v2', 'events'],
    queryFn: () => observabilityApi.events(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const jobs = scheduler.data?.jobs ?? []
  const failedJobs = jobs.filter((job: SchedulerJob) => ['failed', 'running'].includes(job.lastStatus))
  const dqChecks = dataQuality.data?.checks ?? []
  const dqBad = dqChecks.filter((check: DataQualityCheck) => check.status !== 'ok')
  const modelEntries = Object.entries(modelPool.data?.models ?? {})
  const modelWeak = modelEntries.filter(([, model]: any) => {
    const ic = Number(model.ic_4w_avg ?? model.rolling_ic)
    return !Number.isFinite(ic) || Math.abs(ic) < 0.0001 || model.last_ic_status !== 'computed' || model.metadata_exists === false
  })
  const events = observability.data?.events ?? []
  const actionableEvents = events.filter((event) => event.severity !== 'ok')
  const visibleEvents = actionableEvents.length ? actionableEvents : events

  const pipelineTone: Tone = failedJobs.length ? 'warn' : dataQuality.data?.overall === 'fail' ? 'error' : 'ok'
  const mlTone: Tone = modelWeak.length ? 'warn' : 'ok'

  return (
    <div className="sv-workstation sv-obs-center">
      <section className="sv-command-band">
        <div>
          <p className="sv-kicker">Reliability command center</p>
          <h1>OBS 可觀測性指揮中心</h1>
          <p>不是把 Scheduler、Model Pool、Data Quality 分散放，而是把症狀、證據、owner、修復路徑串成同一張事故地圖。</p>
        </div>
        <div className="sv-obs-mode">
          <StatusPill tone={observability.data?.overall === 'error' ? 'error' : observability.data?.overall === 'warn' ? 'warn' : 'ok'}>
            OBS {observability.data?.overall ?? 'loading'}
          </StatusPill>
          <StatusPill tone={system.error ? 'error' : 'ok'}>System {system.error ? 'ERROR' : 'ONLINE'}</StatusPill>
        </div>
      </section>

      <section className="sv-metric-grid">
        <MetricTile label="Latency / Pipeline" value={scheduler.data?.stats?.nextIn ?? '-'} tone={pipelineTone} detail={`failed24h ${scheduler.data?.stats?.failed24h ?? '-'}`} />
        <MetricTile label="Traffic / Runs" value={String(scheduler.data?.stats?.total ?? '-')} tone="info" detail={`${scheduler.data?.stats?.successRate7d ?? 0}% 7d success`} />
        <MetricTile label="Errors / Incidents" value={String(actionableEvents.length || failedJobs.length || dqBad.length)} tone={actionableEvents.length || failedJobs.length || dqBad.length ? 'warn' : 'ok'} detail="actionable events" />
        <MetricTile label="Saturation / ML Health" value={`${Math.max(0, modelEntries.length - modelWeak.length)}/${modelEntries.length || 8}`} tone={mlTone} detail={modelWeak.length ? `${modelWeak.length} weak or missing` : 'lineage OK'} />
      </section>

      <section className="sv-obs-grid">
        <TerminalPanel title="Root Cause Cockpit" kicker="what broke, why it matters" className="sv-span-2">
          <div className="sv-root-list">
            {visibleEvents.length ? visibleEvents.slice(0, 8).map((event) => (
              <RootCauseCard key={event.id} event={event} />
            )) : (
              <div className="sv-empty-state">OBS event payload 載入中；若一直空白，先查 /admin/observability/events 權限或 Worker route。</div>
            )}
          </div>
        </TerminalPanel>

        <TerminalPanel title="Signal Correlation" kicker="metrics + logs + owner boundary">
          <div className="sv-correlation-map">
            <DependencyStep label="Data Update" owner="GCP Scheduler" status={dqBad.some(c => c.id?.includes('price')) ? 'error' : 'ok'} />
            <DependencyStep label="Screener" owner="Cloud Run" status={pipelineTone} />
            <DependencyStep label="ML Predict" owner="Modal" status={mlTone} />
            <DependencyStep label="Recommendation" owner="Cloud Run" status={pipelineTone} />
            <DependencyStep label="Debate / Execution" owner="Worker" status={failedJobs.some(j => j.group === 'intraday') ? 'warn' : 'ok'} />
            <DependencyStep label="UI Contract" owner="Frontend" status="ok" />
          </div>
        </TerminalPanel>

        <TerminalPanel title="Freshness Heatmap" kicker="data quality evidence">
          <div className="sv-check-list dense">
            {dqChecks.length ? dqChecks.map((check: DataQualityCheck) => (
              <div key={check.id}>
                <StatusPill tone={toneFromStatus(check.status)}>{check.status}</StatusPill>
                <span>{check.label}</span>
              </div>
            )) : <div className="sv-empty-state">Data Quality 載入中</div>}
          </div>
        </TerminalPanel>

        <TerminalPanel title="Scheduler Trace" kicker="callback contract">
          <div className="sv-mini-table">
            {(failedJobs.length ? failedJobs : jobs.slice(0, 8)).map((job: SchedulerJob) => (
              <div key={job.id}>
                <span>{job.name}</span>
                <strong>{job.lastDuration || '-'}</strong>
                <StatusPill tone={toneFromStatus(job.lastStatus)}>{job.lastStatus}</StatusPill>
              </div>
            ))}
            {!jobs.length && <div className="sv-empty-state">Scheduler payload 載入中</div>}
          </div>
        </TerminalPanel>

        <TerminalPanel title="Model Lifecycle" kicker="alpha models only, overlays separated">
          <div className="sv-mini-table">
            {modelEntries.map(([name, model]: any) => (
              <div key={name}>
                <span>{name}</span>
                <strong>{model.last_ic_status ?? model.status ?? '-'}</strong>
                <em>{model.ic_4w_avg ?? model.rolling_ic ?? 'n/a'}</em>
              </div>
            ))}
            {!modelEntries.length && <div className="sv-empty-state">Model Pool lineage 載入中</div>}
          </div>
        </TerminalPanel>

        <TerminalPanel title="Runbook Console" kicker="action, not wall of numbers">
          <div className="sv-runbook-list">
            <div><Database /> <span>資料日期錯誤：先查 update job URI 是否帶 sync=1，再查 TWSE/TPEX segment counts。</span></div>
            <div><GitBranch /> <span>Model IC 為 0/NAN：先查 verified predictions，再查 rank_score/actual_return cross-sectional variance。</span></div>
            <div><Network /> <span>Dashboard/Bot 不一致：先查 display contract，禁止各頁自行 fallback。</span></div>
            <div><TimerReset /> <span>Scheduler 顯示綠燈但 duration 異常：查 callback final status，而不是只看 trigger 成功。</span></div>
          </div>
        </TerminalPanel>
      </section>
    </div>
  )
}
