/**
 * StockReportPage — 整頁式 AI 個股完整報告
 * 路由: /report/:symbol
 * 自動 fetch 所有資料（ML 預測 + AI Summary + LLM 摘要/技術/交易）
 */
import { useEffect, type ReactNode } from 'react'
import { useRoute, Link } from 'wouter'
import { useQuery, useMutation } from '@tanstack/react-query'
import { stocksApi, mlApi, llmApi, dashboardV4Api } from '@/lib/api'
import DashboardV4LightweightChart from '@/components/charts/DashboardV4LightweightChart'
import AppShell from '@/components/AppShell'
import {
  ArrowLeft, TrendingUp, TrendingDown, Brain, BarChart2,
  Shield, Target, Zap, RefreshCw, Tag, Building2, DollarSign,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatTwDateTimeShort } from '@/lib/twTime'
import { buildScoreBreakdownViewModel } from '@/lib/scoreV2ViewModel'
import { WorkstationPageTitle } from '@/components/workstation/WorkstationChrome'

// ─── Signal 設定 ───────────────────────────────────────────────────────────────
const SIGNAL_CFG: Record<string, { label: string; accent: string; bg: string; border: string }> = {
  STRONG_BUY:  { label: '強力買進', accent: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/30' },
  BUY:         { label: '買進',     accent: 'text-orange-400',  bg: 'bg-orange-500/10',  border: 'border-orange-500/30' },
  HOLD:        { label: '持有觀望', accent: 'text-yellow-400',  bg: 'bg-yellow-500/10',  border: 'border-yellow-500/30' },
  SELL:        { label: '賣出',     accent: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30' },
  STRONG_SELL: { label: '強力賣出', accent: 'text-emerald-300', bg: 'bg-emerald-400/10', border: 'border-emerald-400/30' },
  NO_SIGNAL:   { label: '訊號不明', accent: 'text-muted-foreground', bg: 'bg-muted/20', border: 'border-border' },
}
const MODEL_COLORS: Record<string, string> = {
  ARIMA: '#818cf8', XGBoost: '#fb923c', LightGBM: '#34d399',
  Prophet: '#60a5fa', LSTM: '#f472b6',
  PatchTST: '#a78bfa', Chronos: '#fbbf24', KalmanFilter: '#3b82f6', MarkovSwitching: '#f97316',
  RandomForest: '#2dd4bf', GradientBoosting: '#fb7185',
}

const STATE_SPACE_OVERLAYS = new Set(['KalmanFilter', 'MarkovSwitching'])

function modelDisplayName(name: string): string {
  return STATE_SPACE_OVERLAYS.has(name) ? `${name} overlay` : name
}

function SectionCard({ title, icon: Icon, children, className }: {
  title: string; icon?: any; children: ReactNode; className?: string
}) {
  return (
    <div className={cn('sv-content-card rounded-2xl p-5 shadow-[0_14px_50px_rgba(0,0,0,0.16)] backdrop-blur-sm', className)}>
      <div className="flex items-center gap-2 mb-4">
        {Icon && <Icon className="sv-accent-text w-4 h-4" />}
        <h3 className="sv-title-text text-sm font-bold">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function ScoreBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="sv-muted-text min-w-16 shrink-0">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-[color:var(--sv-panel-raised)]">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="sv-muted-text w-14 text-right font-mono">{value}/{max}</span>
    </div>
  )
}

function StockSignalTile({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string
  value: ReactNode
  detail: ReactNode
  tone?: 'buy' | 'sell' | 'warn' | 'info' | 'neutral'
}) {
  const valueClass = tone === 'buy'
    ? 'text-red-300'
    : tone === 'sell'
      ? 'text-emerald-300'
      : tone === 'warn'
        ? 'text-[#ffd87f]'
        : tone === 'info'
          ? 'text-[#a5e7ff]'
          : 'sv-title-text'

  return (
    <div className="sv-content-card rounded-xl p-3">
      <p className="sv-muted-text font-mono text-[10px] uppercase tracking-[0.16em]">{label}</p>
      <div className={`mt-2 font-['Space_Grotesk'] text-xl font-semibold ${valueClass}`}>{value}</div>
      <p className="sv-muted-text mt-1 truncate text-xs">{detail}</p>
    </div>
  )
}

export default function StockReportPage() {
  const [, params] = useRoute('/report/:symbol')
  const symbol = (params as { symbol?: string })?.symbol ?? ''

  // 1) 查 stock ID by symbol
  const { data: searchResults } = useQuery({
    queryKey: ['stock-search', symbol],
    queryFn: () => stocksApi.search(symbol, 1),
    enabled: !!symbol,
  })
  const stock = searchResults?.[0]
  const stockId = stock?.id

  // 2) AI Summary（推薦 + tags + 籌碼 + 基本面）
  const { data: aiData, isLoading: aiLoading } = useQuery({
    queryKey: ['stocks', 'ai-summary', stockId],
    queryFn: () => stocksApi.aiSummary(stockId!),
    enabled: !!stockId,
    staleTime: 5 * 60_000,
  })

  // 3) ML 預測
  const { data: mlData, isLoading: mlLoading } = useQuery({
    queryKey: ['ml', 'predict', stockId],
    queryFn: () => mlApi.getPredict(stockId!),
    enabled: !!stockId,
    retry: false,
  })

  const { data: chartPacket, isLoading: chartLoading, error: chartError } = useQuery({
    queryKey: ['dashboard-v4-chart', 'report', stockId],
    queryFn: () => dashboardV4Api.stockChart(stockId!, { days: 365 }),
    enabled: !!stockId,
    staleTime: 5 * 60_000,
  })

  // 4) LLM: 自動觸發摘要/技術/交易（只觸發一次）
  const summaryMut = useMutation({ mutationFn: () => llmApi.analystSummary(stockId!) })
  const techMut = useMutation({ mutationFn: () => llmApi.technicalAnalysis(stockId!) })
  const tradeMut = useMutation({ mutationFn: () => llmApi.tradingAdvice(stockId!) })

  useEffect(() => {
    if (!stockId) return
    // 自動觸發 3 個 LLM 分析
    summaryMut.mutate()
    techMut.mutate()
    tradeMut.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockId])

  const rec = aiData?.recommendation
  const tags = aiData?.tags ?? []
  const chip = aiData?.chip5d
  const fin = aiData?.financials
  const profile = aiData?.profile
  const ml = mlData as any
  const signalKey = ml?.signal ?? rec?.signal ?? 'NO_SIGNAL'
  const cfg = SIGNAL_CFG[signalKey] ?? SIGNAL_CFG.NO_SIGNAL
  const scoreViewModel = rec ? buildScoreBreakdownViewModel(rec) : null

  const isLoading = aiLoading || mlLoading
  const signalTone = signalKey.includes('BUY')
    ? 'buy'
    : signalKey.includes('SELL')
      ? 'sell'
      : signalKey === 'HOLD'
        ? 'warn'
        : 'neutral'
  const reportScore = scoreViewModel?.finalScore != null ? Math.round(scoreViewModel.finalScore) : null
  const forecastText = ml?.forecast_pct != null ? `${(ml.forecast_pct * 100).toFixed(1)}%` : '-'
  const consensusText = ml?.consensus != null ? `${(ml.consensus * 100).toFixed(0)}%` : '-'
  const latestDate = stock?.latestPriceDate ?? stock?.latestChipDate ?? chartPacket?.generatedAt ?? '-'

  if (!symbol) return null

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl space-y-5 p-4 lg:p-6">
        <WorkstationPageTitle
          kicker="Stock note"
          title={`${stock?.name ?? symbol} / ${symbol}`}
          description="先看價格、信號、分數、ML 共識與資料時間，再下鑽 Dashboard V4 K 線、模型投票、籌碼、基本面與 LLM 分析，避免個股頁一開場就變成長表格。"
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Link href="/">
                <button className="inline-flex items-center gap-1 rounded-full border border-[color:var(--sv-accent-border)] bg-[color:var(--sv-accent-soft)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] sv-accent-text">
                  <ArrowLeft className="h-3 w-3" /> Home
                </button>
              </Link>
              {stock?.market && (
                <span className="sv-surface-chip rounded-full px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em]">
                  {stock.market}
                </span>
              )}
              <span className="sv-muted-text font-mono text-[10px]">{new Date().toLocaleDateString('zh-TW')}</span>
            </div>
          }
        />

        <section data-testid="stock-report-signal-board" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <StockSignalTile
            label="Price"
            value={stock?.close != null ? `$${stock.close.toLocaleString()}` : '-'}
            detail={stock?.change_pct != null ? `${stock.change_pct >= 0 ? '+' : ''}${stock.change_pct.toFixed(2)}%` : 'quote pending'}
            tone={stock?.change_pct == null ? 'neutral' : stock.change_pct >= 0 ? 'buy' : 'sell'}
          />
          <StockSignalTile label="Signal" value={cfg.label} detail={signalKey} tone={signalTone} />
          <StockSignalTile label="Score V2" value={reportScore ?? 'N/A'} detail={scoreViewModel ? 'final score' : 'score payload missing'} tone={reportScore == null ? 'neutral' : reportScore >= 70 ? 'buy' : reportScore >= 55 ? 'warn' : 'neutral'} />
          <StockSignalTile label="ML Consensus" value={consensusText} detail={`5d forecast ${forecastText}`} tone={ml?.forecast_pct == null ? 'neutral' : ml.forecast_pct >= 0 ? 'buy' : 'sell'} />
          <StockSignalTile label="Freshness" value={latestDate === '-' ? '-' : formatTwDateTimeShort(String(latestDate))} detail="price / chip / chart" tone="info" />
        </section>

        {isLoading && (
          <div className="sv-content-card flex items-center justify-center gap-3 rounded-xl py-20">
            <RefreshCw className="sv-accent-text h-5 w-5 animate-spin" />
            <span className="sv-muted-text text-sm">載入分析資料中…</span>
          </div>
        )}

        {!isLoading && (
          <>
            <DashboardV4LightweightChart
              packet={chartPacket}
              loading={chartLoading}
              error={chartError}
            />

            {/* ═══ Section 1: 信號總覽 ═══ */}
            <SectionCard title="投資信號總覽" icon={Zap}>
              <div className={cn('rounded-xl border-2 p-4 mb-4', cfg.bg, cfg.border)}>
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">綜合信號</p>
                    <p className={cn('text-3xl font-bold', cfg.accent)}>{cfg.label}</p>
                    <div className="flex flex-wrap gap-4 mt-3 text-sm">
                      {rec && (
                        <>
                          <span className="text-muted-foreground">
                            評分 <span className="text-foreground font-bold">{Math.round(scoreViewModel?.finalScore ?? 0)}</span>
                          </span>
                          <span className="text-muted-foreground">
                            信心 <span className="text-foreground font-bold">{((rec.confidence ?? 0) * 100).toFixed(0)}%</span>
                          </span>
                        </>
                      )}
                      {ml?.consensus != null && (
                        <span className="text-muted-foreground">
                          ML 共識 <span className="text-foreground font-bold">{((ml.consensus) * 100).toFixed(0)}%</span>
                        </span>
                      )}
                      {ml?.forecast_pct != null && (
                        <span className="text-muted-foreground">
                          5日預測{' '}
                          <span className={cn('font-bold', ml.forecast_pct >= 0 ? 'text-red-400' : 'text-emerald-400')}>
                            {(ml.forecast_pct * 100).toFixed(1)}%
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                  {signalKey !== 'NO_SIGNAL' && (
                    <div className="shrink-0">
                      {signalKey.includes('BUY') ? (
                        <TrendingUp className={cn('w-10 h-10', cfg.accent)} />
                      ) : signalKey.includes('SELL') ? (
                        <TrendingDown className={cn('w-10 h-10', cfg.accent)} />
                      ) : (
                        <BarChart2 className={cn('w-10 h-10', cfg.accent)} />
                      )}
                    </div>
                  )}
                </div>
                {rec?.reason && (
                  <p className="mt-3 text-xs text-muted-foreground/80 leading-relaxed border-t border-white/[0.06] pt-3">
                    {rec.reason}
                  </p>
                )}
              </div>

              {/* 評分拆解 */}
              {scoreViewModel && scoreViewModel.rows.length > 0 && (
                <div className="space-y-2">
                  {scoreViewModel?.rows.map((item) => (
                    <ScoreBar key={item.key} label={item.label} value={item.value} max={item.max} color={item.color} />
                  ))}
                </div>
              )}

              {/* 進場 / 停損 / 目標 */}
              {ml && signalKey !== 'NO_SIGNAL' && (
                <div className="grid grid-cols-4 gap-2 mt-4">
                  {[
                    { label: '進場參考', value: ml.entry_price, cls: 'text-foreground' },
                    { label: '停損',     value: ml.stop_loss,   cls: 'text-emerald-400' },
                    { label: '目標 1',   value: ml.target1,     cls: 'text-red-400' },
                    { label: '目標 2',   value: ml.target2,     cls: 'text-red-300' },
                  ].map(item => (
                    <div key={item.label} className="rounded-lg border border-white/[0.08] bg-muted/20 p-3 text-center">
                      <p className="text-[10px] text-muted-foreground mb-1">{item.label}</p>
                      <p className={cn('text-sm font-bold font-mono', item.cls)}>
                        {typeof item.value === 'number' ? `$${item.value.toFixed(2)}` : '—'}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>

            {/* ═══ Section 2: 模型投票 ═══ */}
            {ml?.models?.length > 0 && (
              <SectionCard title="ML 模型投票明細" icon={Brain}>
                <div className="space-y-3">
                  {ml.models.map((m: any) => (
                    <div key={m.name} className="flex items-center gap-2 text-xs">
                      <span
                        className="w-20 text-[10px] font-medium px-2 py-0.5 rounded-full text-black text-center shrink-0"
                        style={{ backgroundColor: MODEL_COLORS[m.name] ?? '#888' }}
                      >
                        {modelDisplayName(m.name)}
                      </span>
                      <span className={cn('w-8 text-center', m.direction === 'up' ? 'text-red-400' : 'text-emerald-400')}>
                        {m.direction === 'up' ? '↑ 漲' : '↓ 跌'}
                      </span>
                      <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${(m.confidence * 100).toFixed(0)}%`, backgroundColor: MODEL_COLORS[m.name] ?? '#888' }}
                        />
                      </div>
                      <span className="text-muted-foreground w-10 text-right font-mono">{(m.confidence * 100).toFixed(0)}%</span>
                      <span className="text-muted-foreground/60 w-16 text-right">
                        準確 {(m.direction_accuracy * 100).toFixed(0)}%
                      </span>
                    </div>
                  ))}
                </div>
                {ml.reasoning && (
                  <p className="mt-4 text-xs text-muted-foreground/70 leading-relaxed border-t border-white/[0.06] pt-3">
                    {ml.reasoning}
                  </p>
                )}
              </SectionCard>
            )}

            {/* ═══ Section 3: 概念標籤 + 法人 + 基本面（三欄）═══ */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* 概念標籤 */}
              <SectionCard title="概念標籤" icon={Tag}>
                {tags.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((t: any) => (
                      <span key={t.tag} className="text-xs px-2 py-1 rounded-lg bg-primary/10 text-primary/80 border border-primary/20">
                        {t.tag}
                        {t.weight < 1 && <span className="text-muted-foreground/50 ml-1">{t.weight.toFixed(1)}</span>}
                      </span>
                    ))}
                  </div>
                ) : <p className="text-xs text-muted-foreground/50">尚未分類</p>}
                {profile?.business_desc && (
                  <p className="mt-3 text-[11px] text-muted-foreground/60 leading-relaxed line-clamp-4 border-t border-white/[0.05] pt-3">
                    {profile.business_desc.replace(/\*\*/g, '').slice(0, 300)}
                  </p>
                )}
              </SectionCard>

              {/* 法人籌碼 */}
              <SectionCard title="法人近 5 日" icon={Building2}>
                {chip ? (
                  <div className="space-y-3">
                    {[
                      { label: '外資', value: chip.foreign_net },
                      { label: '投信', value: chip.trust_net },
                    ].map(row => (
                      <div key={row.label} className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">{row.label}</span>
                        <span className={cn('text-sm font-bold font-mono',
                          (row.value ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {row.value != null ? `${row.value >= 0 ? '+' : ''}${(row.value / 1000).toFixed(0)}張` : '-'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : <p className="text-xs text-muted-foreground/50">無資料</p>}
              </SectionCard>

              {/* 基本面 */}
              <SectionCard title="基本面" icon={DollarSign}>
                {fin ? (
                  <div className="space-y-3">
                    {[
                      { label: 'P/E', value: fin.pe != null ? Number(fin.pe).toFixed(1) : '-' },
                      { label: 'ROE', value: fin.roe != null ? `${Number(fin.roe).toFixed(1)}%` : '-' },
                      { label: 'EPS', value: fin.eps != null ? Number(fin.eps).toFixed(2) : '-' },
                    ].map(row => (
                      <div key={row.label} className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">{row.label}</span>
                        <span className="text-sm font-bold font-mono">{row.value}</span>
                      </div>
                    ))}
                  </div>
                ) : <p className="text-xs text-muted-foreground/50">無資料</p>}
              </SectionCard>
            </div>

            {/* ═══ Section 4: LLM 分析報告 ═══ */}
            <div className="space-y-4">
              {/* 分析師摘要 */}
              <LLMSection
                title="分析師摘要"
                icon={Brain}
                data={summaryMut.data}
                isPending={summaryMut.isPending}
                field="summary"
              />

              {/* 技術分析 */}
              <LLMSection
                title="技術分析"
                icon={BarChart2}
                data={techMut.data}
                isPending={techMut.isPending}
                field="analysis"
              />

              {/* 交易建議 */}
              <LLMSection
                title="交易建議"
                icon={Shield}
                data={tradeMut.data}
                isPending={tradeMut.isPending}
                field="advice"
              />
            </div>

            {/* ═══ Footer ═══ */}
            <div className="text-center text-[10px] text-muted-foreground/40 py-6 border-t border-white/[0.05]">
              <p>⚠ AI 分析僅供參考，不構成投資建議。投資有風險，請獨立判斷。</p>
              <p className="mt-1">StockVision AI Report · Generated {formatTwDateTimeShort(new Date().toISOString())}</p>
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}

function LLMSection({ title, icon: Icon, data, isPending, field }: {
  title: string; icon: any; data: any; isPending: boolean; field: string
}) {
  const text = data?.[field] ?? data?.result ?? (typeof data === 'string' ? data : null)

  return (
    <SectionCard title={title} icon={Icon}>
      {isPending ? (
        <div className="flex items-center gap-2 py-4">
          <RefreshCw className="w-4 h-4 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground animate-pulse">AI 分析中…</span>
        </div>
      ) : text ? (
        <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/85">
          {text}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground/50 py-2">分析產生中或無資料</p>
      )}
    </SectionCard>
  )
}
