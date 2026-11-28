import { completedPendingBuys, currentDisplayPrice } from '@/lib/pendingBuyDisplay'
import { visiblePendingBuys, debateObservationLabel, positionL4View } from '@/lib/paperDecisionUi'
/**
 * 模擬交易室 — Auto Trade Bot 專頁
 *
 * Design: Dark Mode + Mobile-first, inspired by FreqUI + 3Commas
 * Sections: Portfolio Summary → Signals → Positions → Trade History → Bot Status
 */
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { paperApi, marketApi, backtestApi, adaptiveApi, recommendationsApi } from '@/lib/api'
import { useAuth } from '@/_core/hooks/useAuth'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Bot, Shield, ShieldCheck, ShieldAlert, ArrowUpRight, ArrowDownRight } from 'lucide-react'
import { StockFactorTrajectoryPanel } from '@/components/PitFactorTrajectoryPanel'
import AppShell from '@/components/AppShell'
import { DeferredRender } from '@/components/DeferredRender'
import { stocksApi } from '@/lib/api'
import { explainExecutionEvent, formatExecutionEvent } from '@/lib/executionEvent'
import { formatCanonicalTradeLifecycleBadge, formatPositionRiskPlan, formatS12HoldingDefenseBadge } from '@/lib/pendingBuyExecutionUi'
import { formatTwDateTimeShort } from '@/lib/twTime'
import { marketRiskShield, tradingMarketRisk } from '@/lib/marketRiskLevel'
import { activePaperTrajectorySymbols, paperOrdersFromPayload, paperPendingBuysFromPayload, paperPositionsFromPayload } from '@/lib/paperPayload'
import { benchmarkReturnSince, sortedSnapshots } from '@/lib/paperPerformanceSeries'
import { formatDrawdownPct, thresholdTone, type ThresholdTone } from '@/lib/backtestCardView'
import {
  WorkstationCatCard,
} from '@/components/workstation/WorkstationChrome'
import { SimRoom, Sparkline, type DailyBar } from '@/components/simroom/SimRoom'
import { buildCompletedRow, buildSimRow, defaultView, isClosedDay, marketTrend, selectSimQuote, sessionPhase, twClock, type SimroomView, type TwClock } from '@/lib/simroomModel'
import { DataState } from '@/components/ui/data-state'
import { StatusBadge, StatusIcon, StatusText } from '@/components/ui/status'
import { priceToneClass, STATUS_CHIP } from '@/lib/colorTokens'
import { gateCalibrationView } from '@/lib/gateCalibrationView'
import { formatDate, formatDateShort, formatNumber, formatPrice, formatSignedPct, formatSignedTwd, formatTime } from '@/lib/format'
import { humanEntryReason, humanExitReason, humanOrderReason } from '@/lib/orderReason'
import { listRefreshState } from '@/lib/listRefreshState'

const CandlestickChart = lazy(() => import('@/components/CandlestickChart'))
const PaperTradePerformanceChart = lazy(() => import('@/components/charts/PaperTradePerformanceChart'))

// ─── Helpers ────────────────────────────────────────────────────────────────

const OBSERVATIONAL_POTENTIAL_BUY_POLICY = 'non_executable_formal_ml_observation_missing_expected_return_v1'

function isTWMarketOpen(): boolean {
  const tw = new Date(Date.now() + 8 * 3600_000)
  if ([0,6].includes(tw.getUTCDay())) return false
  const h = tw.getUTCHours()
  const m = new Date().getUTCMinutes()
  return h >= 9 && (h < 13 || (h === 13 && m <= 30))
}

function fmt(n: number | null | undefined, decimals = 0): string {
  if (n == null) return '-'
  return n.toLocaleString('zh-TW', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** 損益／報酬：台股紅漲綠跌（token），零與缺值中性。 */
function pctClass(pct: number | null): string {
  return priceToneClass(pct)
}

function RotationAudit() {
  const {data,error,refetch}=useQuery({queryKey:['paper','rotation-audit'],queryFn:paperApi.rotationAudit,refetchInterval:60000})
  // 背景刷新失敗時保留上一份資料，只標「更新失敗」；第一次就失敗才整塊顯示讀取失敗。
  if(error && !data)return <DataState kind="error" title="換倉追蹤讀取失敗" onRetry={() => { void refetch() }} className="mt-3 border-t border-border" />
  if(!data?.policy_active)return null
  const items: any[] = Array.isArray(data.items) ? data.items : []
  return <BotSection title={`L4 換倉追蹤 · ${items.length} 筆`} kicker="原股賣出後 20 個交易日 vs 換入部位淨損益">
    <div className="px-4 pb-2">
    {error && <DataState kind="stale" title="更新失敗，顯示上次的資料" onRetry={() => { void refetch() }} className="px-0 py-1" />}
    {!items.length ? <DataState kind="empty" title="尚無 L4 換倉紀錄" className="px-0" /> : (
      <div>{items.map((r:any)=>{
        const floating = Number(r.floating_pnl_pct)
        return <div key={r.order_id} className="border-b border-border py-2 text-xs last:border-b-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="sv-num text-muted-foreground">委託 #{r.order_id}</span>
            <span className={priceToneClass(floating)}>浮盈 {Number.isFinite(floating) ? formatSignedPct(floating * 100, 2) : '—'}</span>
            <StatusBadge tone={r.status==='mature'?'ok':r.status==='missing_data'?'warn':'na'}>{r.status==='mature'?'已滿 20 日':r.status==='missing_data'?'缺資料':'觀察中'}</StatusBadge>
          </div>
          {r.exit_reason && <p className="mt-1 break-words text-muted-foreground">{humanExitReason(r.exit_reason, '依出場規則賣出')}</p>}
          <RotationOriginalTrend sessions={Array.isArray(r.original_next_20_sessions) ? r.original_next_20_sessions : []} />
          {r.replacement_status==='not_replaced'?<p className="mt-1">未換入，資金保留現金</p>:r.replacements?.map((p:any)=><p className="mt-1 sv-num" key={p.order_id}>{p.symbol} · {p.status==='mature'?'20 日':'觀察中'} · 淨損益 {p.net_pnl==null?'待完整資料':<span className={priceToneClass(p.net_pnl)}>{formatSignedTwd(p.net_pnl)}</span>} · 截至 {formatDate(p.as_of_date)}</p>)}
        </div>})}
      </div>
    )}
    <p className="pt-1 text-[11px] text-muted-foreground">未成熟與缺資料不算成零；同批資金共用，不推定一對一因果。</p>
    </div>
  </BotSection>
}

/** 賣出後原股走勢：折線＋首尾日期與收盤，不列整串價格。 */
function RotationOriginalTrend({ sessions }: { sessions: Array<{ date: string; close: number }> }) {
  const points = sessions.filter((p) => Number.isFinite(Number(p.close)))
  if (!points.length) return <p className="mt-1 text-muted-foreground">原股：尚無後續收盤</p>
  const first = points[0]
  const last = points[points.length - 1]
  const change = (Number(last.close) / Number(first.close) - 1) * 100
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 sv-num">
      <span className="text-muted-foreground">原股 {points.length} 日</span>
      <Sparkline values={points.map((p) => Number(p.close))} width={160} height={28} />
      <span>{formatDateShort(first.date)} ${formatPrice(first.close)} → {formatDateShort(last.date)} ${formatPrice(last.close)}</span>
      {Number.isFinite(change) && <span className={priceToneClass(change)}>{formatSignedPct(change, 1)}</span>}
    </div>
  )
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

// ─── Portfolio Summary（FinLab 風格 6 卡）───────────────────────────────────

function WinLossBadge({ win }: { win: boolean | null }) {
  if (win === null) return <span className="text-muted-foreground text-xs">-</span>
  return win
    ? <span className="text-xs font-bold text-up">勝</span>
    : <span className="text-xs font-bold text-down">負</span>
}

function PortfolioSummary() {
  const { data: account, isError: accountError } = useQuery({ queryKey: ['paper', 'account'], queryFn: paperApi.account, staleTime: 60_000 })
  const { data: positions, error: positionsError, refetch: refetchPositions } = useQuery({
    queryKey: ['paper', 'positions'],
    queryFn: paperApi.positions,
    staleTime: 30_000,
    refetchInterval: isTWMarketOpen() ? 60_000 : 5 * 60_000,
    refetchOnWindowFocus: true,
  })
  const { data: pnlData, isError: pnlError } = useQuery({ queryKey: ['paper', 'pnl'], queryFn: paperApi.pnl, staleTime: 5 * 60_000 })
  // 讀取中／讀取失敗時，依快照算的指標一律顯示「—」，不拿預設值算出假數字。
  const pnlUnavailable = !pnlData
  const pnlSub = pnlError ? '讀取失敗' : '載入中'
  // 歷史已實現損益（Server-side 全歷史計算）
  const { data: realizedData, error: realizedError } = useQuery({ queryKey: ['paper', 'realized'], queryFn: paperApi.realized, staleTime: 5 * 60_000 })
  const totalRealizedPnl = realizedData?.totalRealizedPnl ?? 0
  const realizedUnavailable = Boolean(realizedError) && !realizedData
  const sellOrderCount = realizedData?.tradeCount ?? 0

  const acc = account?.account ?? account ?? {}
  const positionSummary = positions?.summary ?? null
  const cash = positionSummary?.cash ?? acc?.cash ?? 0
  // 本金只能來自帳戶或持倉摘要；兩者都還沒有時，報酬率不用預設 100 萬去算。
  const initialCash: number | null = acc?.initial_cash ?? positionSummary?.initial_cash ?? (account ? 1_000_000 : null)
  const posArr = paperPositionsFromPayload(positions)
  const positionValue = Array.isArray(posArr)
    ? posArr.reduce((s: number, p: any) => s + (p.current_price ?? p.avg_cost ?? 0) * (p.shares ?? 0), 0)
    : 0
  const netUnsettledSettlement = positionSummary?.net_unsettled_settlement ?? 0
  const valuationPending = positionSummary?.valuation_complete === false
  const totalAssets = valuationPending ? null : positionSummary?.total_value ?? (cash + positionValue + netUnsettledSettlement)
  const totalReturn = totalAssets == null || initialCash == null ? null : initialCash > 0 ? (totalAssets - initialCash) / initialCash : 0

  // PnL snapshots for advanced metrics
  const snapshots = sortedSnapshots(pnlData)
  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null
  const first = snapshots.length > 0 ? snapshots[0] : null

  // 年化報酬
  const daysSinceStart = first?.date
    ? Math.max(1, (Date.now() - new Date(first.date).getTime()) / 86400000)
    : 1
  const annualizedReturn = totalReturn == null ? null : typeof latest?.cagr === 'number' && Number.isFinite(latest.cagr)
    ? latest.cagr
    : daysSinceStart > 0
      ? Math.pow(1 + totalReturn, 365 / daysSinceStart) - 1
      : 0

  // 最大回撤
  const maxDrawdown = snapshots.length > 0
    ? Math.max(...snapshots.map((s: any) => s.max_drawdown_to_date ?? 0))
    : 0

  // Sharpe (30d)
  const sharpe30d = latest?.sharpe_30d ?? null

  // 近期報酬（週/月/季）
  function getReturnSince(daysAgo: number): number | null {
    if (valuationPending) return null
    if (snapshots.length < 2) return null
    const cutoff = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)
    const ref = snapshots.find((s: any) => s.date >= cutoff) ?? snapshots[0]
    const refVal = ref?.total_value ?? ref?.portfolio_value
    const curVal = latest?.total_value ?? latest?.portfolio_value
    if (!refVal || !curVal) return null
    return (curVal - refVal) / refVal
  }
  const retWeek = getReturnSince(7)
  const retMonth = getReturnSince(30)
  const retQuarter = getReturnSince(90)

  // 大盤比較：和資產曲線同一個 0050 價格基礎（etf_benchmarks['0050'] adj_close；舊 Worker 才用收盤價），由 lib 決定。
  const bmWeek = benchmarkReturnSince(snapshots, '0050', 7)
  const bmMonth = benchmarkReturnSince(snapshots, '0050', 30)
  const bmQuarter = benchmarkReturnSince(snapshots, '0050', 90)

  function beatsBenchmark(botRet: number | null, bmRet: number | null): boolean | null {
    if (botRet === null || bmRet === null) return null
    return botRet > bmRet
  }

  // 持倉讀不到時總資產、報酬都算不出來；不要用 0 冒充。
  if (positionsError && !positions) {
    return <DataState kind="error" title="資產摘要讀取失敗" code={positionsError instanceof Error ? positionsError.message : undefined} onRetry={() => { void refetchPositions() }} />
  }

  const assetSub = [
    totalReturn == null ? (accountError && initialCash == null ? '帳戶讀取失敗' : '報酬率待評估') : null,
    `現金 $${fmt(Math.round(cash))}`,
    netUnsettledSettlement !== 0 ? `含未交割 ${netUnsettledSettlement > 0 ? '+' : ''}$${fmt(Math.round(netUnsettledSettlement))}` : null,
  ].filter(Boolean).join(' · ')
  const metrics: { label: string; val: string; sub: string; cls: string }[] = [
    { label: '已實現', val: realizedUnavailable ? '—' : formatSignedTwd(Math.round(totalRealizedPnl)), sub: realizedUnavailable ? '讀取失敗' : `${sellOrderCount} 筆`, cls: realizedUnavailable ? 'text-muted-foreground' : pctClass(totalRealizedPnl) },
    { label: '年化', val: annualizedReturn == null || pnlUnavailable ? '—' : `${annualizedReturn >= 0 ? '+' : ''}${(annualizedReturn * 100).toFixed(1)}%`, sub: valuationPending ? '待估值' : pnlUnavailable ? pnlSub : `${Math.round(daysSinceStart)} 天`, cls: pnlUnavailable ? 'text-muted-foreground' : pctClass(annualizedReturn) },
    // 上色規則：報酬與回撤＝漲跌色（MDD 是虧損 → down）；Sharpe 是風險調整比值，不上漲跌色。
    { label: 'MDD', val: valuationPending || pnlUnavailable ? '—' : `-${(maxDrawdown * 100).toFixed(1)}%`, sub: valuationPending ? '待估值' : pnlUnavailable ? pnlSub : '成立以來', cls: !valuationPending && !pnlUnavailable && maxDrawdown > 0 ? pctClass(-maxDrawdown) : 'text-muted-foreground' },
    { label: 'Sharpe', val: !valuationPending && !pnlUnavailable && sharpe30d != null ? sharpe30d.toFixed(2) : '—', sub: valuationPending ? '待估值' : pnlUnavailable ? pnlSub : '30 日', cls: !valuationPending && sharpe30d != null ? 'text-foreground' : 'text-muted-foreground' },
  ]

  // 和交易室上方同一種 KPI 列：無框、細線分格、標題 11px／數字 16px。
  return (
    <div className="grid grid-cols-2 sm:flex sm:flex-wrap">
      <Kpi label="總資產" className="col-span-2" sub={assetSub}>
        <span className="text-foreground">{valuationPending ? 'NAV 待估值' : `$${fmt(totalAssets)}`}</span>
        {totalReturn != null && <span className={`ml-2 text-sm ${pctClass(totalReturn)}`}>{`${totalReturn >= 0 ? '+' : ''}${(totalReturn * 100).toFixed(2)}%`}</span>}
      </Kpi>
      {metrics.map(m => (
        <Kpi key={m.label} label={m.label} sub={m.sub}><span className={m.cls}>{m.val}</span></Kpi>
      ))}
      <Kpi label="vs 0050" sub={pnlUnavailable ? pnlSub : '含息調整價'}>
        <span className="flex gap-3 text-xs font-normal">
          {[{ l: '週', w: beatsBenchmark(retWeek, bmWeek) }, { l: '月', w: beatsBenchmark(retMonth, bmMonth) }, { l: '季', w: beatsBenchmark(retQuarter, bmQuarter) }].map(b => (
            <span key={b.l} className="flex items-center gap-1"><span className="text-muted-foreground">{b.l}</span><WinLossBadge win={b.w} /></span>
          ))}
        </span>
      </Kpi>
      <Kpi label="近期報酬" sub="週 · 月 · 季">
        <span className="flex gap-3 text-sm">
          {[retWeek, retMonth, retQuarter].map((v, i) => (
            <span key={i} className={v != null ? pctClass(v) : 'text-muted-foreground'}>{v != null ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '—'}</span>
          ))}
        </span>
      </Kpi>
      {valuationPending && (
        <div className="col-span-2 w-full border-t border-border px-4 py-1.5 text-[11px] text-warn">
          權利尚無可靠市價；資產區間 ${fmt(positionSummary.nav_lower_bound)}–${fmt(positionSummary.nav_upper_bound)}。不是已實現損失，也不計晉級證據。
        </div>
      )}
    </div>
  )
}

function Kpi({ label, sub, className, children }: { label: string; sub?: string; className?: string; children: ReactNode }) {
  return (
    <div className={`min-w-0 border-b border-r border-border px-4 py-2 sm:border-b-0 sm:last-of-type:border-r-0 ${className ?? ''}`}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="flex items-baseline sv-num text-base font-semibold leading-snug">{children}</div>
      <div className="text-[11px] text-muted-foreground">{sub || '\u00A0'}</div>
    </div>
  )
}

function executionToneClass(tone: string): string {
  if (tone === 'ok') return STATUS_CHIP.ok
  if (tone === 'warn') return STATUS_CHIP.warn
  if (tone === 'error') return STATUS_CHIP.fail
  if (tone === 'info') return STATUS_CHIP.na
  return STATUS_CHIP.na
}

function usePaperDisplayQuotes(symbols: string[]) {
  const unique = [...new Set(symbols)].sort()
  return useQuery({
    queryKey:['paper','display-quotes',unique.join(',')],
    queryFn:({signal})=>paperApi.displayQuotes(unique,{signal,timeoutMs:5000}),
    enabled:unique.length>0 && isTWMarketOpen(), staleTime:10_000,
    refetchInterval:()=>isTWMarketOpen()?10_000:false, refetchIntervalInBackground:false, retry:false,
  })
}

// ─── 推薦候選（模擬交易室）─────────────────────────────────────────────────────

const RUN_STATE_VIEW: Record<string, { tone: 'ok' | 'warn' | 'fail' | 'na'; label: string }> = {
  ready_to_execute: { tone: 'ok', label: '待執行' },
  debate_pending: { tone: 'na', label: '辯論觀察中' },
  filled: { tone: 'ok', label: '已成交' },
  skipped: { tone: 'na', label: '已跳過' },
  expired: { tone: 'na', label: '已過期' },
  closed: { tone: 'na', label: '已結束' },
  error: { tone: 'fail', label: '流程失敗' },
  halted: { tone: 'fail', label: '風控暫停' },
  base_ready: { tone: 'warn', label: '基礎名單就緒' },
  empty_after_hard_safety: { tone: 'na', label: '硬性風控後無候選' },
  empty_after_soft_risk: { tone: 'na', label: '軟性風險後無候選' },
  empty: { tone: 'na', label: '沒有候選' },
}

/** 待買清單的來源與批次：小徽章一排，原始代碼與事件只放 tooltip。 */
function PendingBuyStateBadges({ state, stale, meta, policy }: { state?: any; stale?: boolean; meta?: any; policy?: any }) {
  const events = Array.isArray(meta?.execution_events) ? meta.execution_events.slice(-3) : []
  const executionPolicy = policy?.execution_pool_policy ?? 'l4_sparse_final_buy_only'
  const sourceRecoDate = policy?.source_reco_date ?? meta?.source_reco_date ?? null
  const watchFallbackOff = policy?.watch_fallback_allowed === false
  const run = RUN_STATE_VIEW[String(state?.state ?? 'empty')] ?? { tone: 'na' as const, label: '狀態不明' }
  const eventText = events.map((event: any) => {
    const raw = formatExecutionEvent({ kind: 'execution', status: event.status, reason: event.reason, detail: event.detail })
    return `${event.symbol} ${explainExecutionEvent(raw) ?? `${event.status}: ${event.reason}`}`
  }).join('\n')
  // 一行小字：執行狀態（帶色）· 清單來源 · 推薦資料日 · 最近事件；不加框，和下方表格同一種樣式。
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sv-num text-[11px] text-muted-foreground">
      <StatusText tone={run.tone} title={state?.error_message || undefined}>{run.label} {state?.active_count ?? 0}/{state?.total_count ?? 0}</StatusText>
      <span aria-hidden="true">·</span>
      <span title={`${executionPolicy}${watchFallbackOff ? ' · watch fallback off' : ''}：只有 L4 終選的買進列進入待買清單，每日推薦在 L4 選中前只是證據`}>L4 終選清單</span>
      {sourceRecoDate && <><span aria-hidden="true">·</span><span>依 {formatDateShort(sourceRecoDate)} 推薦</span></>}
      {stale && <><span aria-hidden="true">·</span><StatusText tone="warn">資料過期</StatusText></>}
      {eventText && <><span aria-hidden="true">·</span><span className="underline decoration-dotted" title={eventText}>最近事件 {events.length}</span></>}
    </div>
  )
}

function pendingEmptyState(state: any, meta: any, view: SimroomView, closed: boolean, tradingDay: boolean | null) {
  if (closed) return <DataState kind="empty" title="今日休市" hint="持倉保護照常；下一個交易日盤前再出計畫" />
  const s = String(state?.state ?? 'empty')
  if (s === 'error') return <DataState kind="error" title="今日沒有可執行的盤前決策" hint="流程未完成，今天不會掛新單" code={state?.error_message ?? meta?.error_message ?? null} />
  if (s === 'halted') return <DataState kind="error" title="風控暫停新進場" hint="持倉保護照常" code={state?.error_message ?? null} />
  const counts = meta?.execution_counts ?? {}
  const terminal = ['cancelled', 'filled', 'skipped', 'expired'].reduce((acc, key) => acc + Number(counts[key] ?? 0), 0)
  if (terminal > 0) return <DataState kind="empty" title="今日待買已全部結束" hint="下一交易日盤前 L4 會產生新清單" />
  if (s === 'empty_after_hard_safety' || s === 'empty_after_soft_risk') return <DataState kind="empty" title="今日無計畫" hint={`${RUN_STATE_VIEW[s].label}；持倉保護照常`} />
  // trading_day＝true 才確定是交易日；null（舊 Worker 或查詢失敗）時不斷言是否休市。
  if (view === 'premarket') return <DataState kind="empty" title="尚未封存" hint={tradingDay === true ? '盤前資訊到齊、L4 完成配置後出現（08:45 前）' : '交易日盤前資訊到齊、L4 完成配置後出現（08:45 前）；休市日不產生計畫'} />
  return <DataState kind="empty" title="今日沒有待買計畫" hint={tradingDay === true ? '持倉保護照常' : '休市日也不會有；持倉保護照常'} />
}

// 5 秒一跳：報價 90 秒過期的判斷最多晚 5 秒（原本 30 秒一跳，fetch 失敗時要約 120 秒才標過期）。
function useTwClock(intervalMs = 5_000): TwClock & { nowMs: number } {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return { ...twClock(nowMs), nowMs }
}

/** 各檔近 20 日 K 棒（舊到新）：一次查詢帶全部代號（worker 走索引，不逐檔 search），30 分鐘內不重抓。 */
function useBarHistory(symbols: string[]): Record<string, DailyBar[]> {
  const key = [...new Set(symbols)].sort()
  const { data } = useQuery({
    queryKey: ['paper', 'bars20', key.join(',')],
    queryFn: () => stocksApi.dailyBars(key, 20),
    enabled: key.length > 0,
    staleTime: 30 * 60_000,
  })
  return data?.bars ?? {}
}

function SignalTable({ onSelectSymbol }: { onSelectSymbol?: (s: string) => void }) {
  // T2 過濾後的掛單（非 raw recommendations）
  const { data: pbData, isLoading, isFetching, dataUpdatedAt, error, refetch } = useQuery({
    queryKey: ['paper', 'pending-buys'],
    queryFn: () => paperApi.pendingBuys(),
    staleTime: 0,
    refetchInterval: () => isTWMarketOpen() ? 30_000 : 5 * 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
  })
  const clock = useTwClock()
  const [manualView, setManualView] = useState<SimroomView | null>(null)
  // 辯論只是觀察：待買清單不依 debate 狀態或結論過濾。
  const allPendingBuys = visiblePendingBuys(pbData)
  const buys = allPendingBuys
  const completed = completedPendingBuys(pbData)
  // 沒有待買時用 0050 探一次 Worker 的交易時段（休市時 Worker 依 holiday:* 回 outside_session）。
  const quoteSymbols = allPendingBuys.length ? allPendingBuys.map((row) => row.symbol) : ['0050']
  const { data: liveQuotes, dataUpdatedAt: quotesUpdatedAt, isError: quotesError } = usePaperDisplayQuotes(quoteSymbols)
  const displayNow = Math.max(clock.nowMs, quotesUpdatedAt)
  const tradingDay: boolean | null = typeof pbData?.trading_day === 'boolean' ? pbData.trading_day : null
  const closed = isClosedDay(clock, liveQuotes?.status ?? null, pbData ? { session_date: pbData.session_date, trading_day: pbData.trading_day } : null)
  const view = manualView ?? defaultView(sessionPhase(clock.minutes))

  const pendingState = pbData?.state
  const pendingMeta = pbData?.meta
  const pendingExecutionPolicy = pbData?.execution_policy
  const rows = useMemo(() => {
    const live = buys.map((b: any) => {
      const dailyReference = b.execution_preview?.daily_assessment ?? b.execution_preview?.last_or15_assessment ?? b.execution_preview?.or15
      const live = liveQuotes?.prices?.[b.symbol]
      // 90 秒內的報價優先；過期的不丟掉，交給 buildSimRow 依原始時間標「舊 Ns」（盤後就是最後價）。
      return buildSimRow(b, selectSimQuote(live, b.market_price, displayNow, dailyReference), displayNow)
    })
    const seen = new Set(live.map((row) => row.symbol))
    return [...live, ...completed.filter((row: any) => !seen.has(row.symbol)).map(buildCompletedRow)]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pbData, liveQuotes, displayNow])
  const quoteAges = rows.map((row) => row.quoteAgeSec).filter((age): age is number => age != null)
  const quoteAgeSec = quoteAges.length ? Math.min(...quoteAges) : null
  const dataDate = typeof pbData?.date === 'string' ? pbData.date : typeof pbData?.session_date === 'string' ? pbData.session_date : null

  const bars = useBarHistory(view === 'premarket' ? rows.map((row) => row.symbol) : [])

  if (isLoading) return <DataState kind="loading" title="推薦候選載入中" minHeight={160} />
  if (error && !pbData) return <DataState kind="error" title="推薦候選讀取失敗" onRetry={() => { void refetch() }} code={String((error as Error)?.message ?? '')} />

  const sync = error
    ? <DataState kind="stale" title={`更新失敗，顯示 ${dataUpdatedAt ? formatTime(dataUpdatedAt) : '上次'} 的資料`} onRetry={() => { void refetch() }} className="px-0 py-1" />
    : <span className="text-[11px] text-muted-foreground" title={isTWMarketOpen() ? '盤中每 30 秒自動更新' : '非盤中每 5 分鐘自動更新'}>
        {isFetching ? '更新中' : dataUpdatedAt ? `同步 ${formatTime(dataUpdatedAt)}` : '等待同步'}
      </span>

  return (
    <SimRoom
      clock={clock}
      closed={closed}
      rows={rows}
      view={view}
      onViewChange={(next) => setManualView(next === defaultView(sessionPhase(clock.minutes)) ? null : next)}
      quoteAgeSec={view === 'intraday' ? quoteAgeSec : null}
      trend={marketTrend(allPendingBuys)}
      onOpenChart={onSelectSymbol}
      quoteError={quotesError && view === 'intraday'}
      status={<>
        <PendingBuyStateBadges state={pendingState} stale={Boolean(pbData?.is_stale)} meta={pendingMeta} policy={pendingExecutionPolicy} />
        <span className="ml-auto">{sync}</span>
      </>}
      dataDate={dataDate}
      bars={bars}
      empty={pendingEmptyState(pendingState, pendingMeta, view, closed, tradingDay)}
    />
  )
}

// ─── Open Positions（完整庫存）──────────────────────────────────────────────

function parseOrderNote(note: unknown): Record<string, any> {
  if (!note) return {}
  if (typeof note === 'object') return note as Record<string, any>
  if (typeof note !== 'string') return {}
  try {
    const parsed = JSON.parse(note)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return { reason: note }
  }
}

function formatTwOrderTime(createdAt?: string | null): string {
  return formatTwDateTimeShort(createdAt)
}

function realizedPnlFromOrder(order: any): { pnl: number; pct: number | null } | null {
  if (String(order?.side ?? '').toLowerCase() !== 'sell') return null
  const note = parseOrderNote(order?.note)
  const pnl = finiteNumber(order?.realized_pnl ?? note.realized_pnl)
  if (pnl == null) {
    const entryPrice = finiteNumber(note.entry_price)
    const exitPrice = finiteNumber(order?.price)
    const shares = finiteNumber(order?.shares)
    if (entryPrice == null || exitPrice == null || shares == null || entryPrice <= 0 || shares <= 0) return null
    const commission = finiteNumber(order?.commission) ?? 0
    const tax = finiteNumber(order?.tax) ?? 0
    const computedPnl = Math.round((exitPrice - entryPrice) * shares - commission - tax)
    return {
      pnl: computedPnl,
      pct: Math.round((computedPnl / (entryPrice * shares) * 100) * 100) / 100,
    }
  }
  return {
    pnl,
    pct: finiteNumber(order?.realized_pnl_pct ?? note.realized_pnl_pct),
  }
}

function formatTaiwanShareLots(sharesInput: unknown): string {
  const shares = Math.max(0, Math.floor(Number(sharesInput ?? 0)))
  const lots = Math.floor(shares / 1000)
  const oddLotShares = shares % 1000
  if (lots > 0 && oddLotShares > 0) return `${lots}張${oddLotShares.toLocaleString('zh-TW')}股`
  if (lots > 0) return `${lots}張`
  return `${oddLotShares.toLocaleString('zh-TW')}股`
}

function PositionsTable() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['paper', 'positions'],
    queryFn: paperApi.positions,
    staleTime: 60_000,
    refetchInterval: isTWMarketOpen() ? 60_000 : 5 * 60_000,
    refetchOnWindowFocus: true,
  })
  const { data: ordersData, isLoading: ordersLoading, error: ordersError, refetch: refetchOrders } = useQuery({
    queryKey: ['paper', 'orders'],
    queryFn: () => paperApi.orders(200),
    staleTime: 60_000,
  })

  const positions = paperPositionsFromPayload(data)
  const {data: positionQuotes, dataUpdatedAt: positionQuotesAt} = usePaperDisplayQuotes(positions.map((p:any)=>p.symbol))
  const positionDisplayNow = Math.max(Date.now(),positionQuotesAt)
  const summary = (data as any)?.summary
  const orders = paperOrdersFromPayload(ordersData)

  if (isLoading) return <DataState kind="loading" />
  if (error && !data) return <DataState kind="error" title="持倉讀取失敗" code={error instanceof Error ? error.message : undefined} onRetry={() => { void refetch() }} />
  if (!Array.isArray(positions) || positions.length === 0) {
    const latestOrder = orders[0]
    const latestIsSell = latestOrder?.side === 'sell'
    const latestIsBuy = latestOrder?.side === 'buy'
    const latestReason = humanOrderReason(latestOrder)

    if (!latestOrder && ordersError && !ordersData) {
      return <DataState kind="error" title="成交紀錄讀取失敗" code={ordersError instanceof Error ? ordersError.message : undefined} onRetry={() => { void refetchOrders() }} />
    }
    // 沒持倉只寫一行：狀態 · 最後一筆成交；現金、總資產已在上方 KPI 列。
    return (
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-2.5 text-xs text-muted-foreground">
        <StatusText tone={latestIsBuy ? 'warn' : 'na'}>{latestIsBuy ? '持倉與成交對不上' : '目前無持倉'}</StatusText>
        <span aria-hidden="true">·</span>
        {latestOrder ? (
          <span className="sv-num">
            最後一筆 {formatTwOrderTime(latestOrder.created_at)}{' '}
            <span className={latestIsSell ? 'text-down' : latestIsBuy ? 'text-up' : ''}>{latestIsSell ? '賣出' : latestIsBuy ? '買進' : '—'}</span>{' '}
            <span className="text-foreground">{latestOrder.symbol} {latestOrder.name}</span> {fmt(latestOrder.shares)} 股 ${fmt(latestOrder.price, 1)} · {latestReason.text}
            {latestIsBuy && ' · 持倉清單是空的，需檢查同步'}
          </span>
        ) : ordersLoading ? <span>最後一筆成交讀取中</span> : <span>還沒有任何模擬成交；候選通過送單前檢查並成交後才會出現在這裡</span>}
      </div>
    )
  }

  // 計算未實現損益總計
  let totalUnrealized = 0
  let totalCostBasis = 0

  return (
    <div>
      <div className="divide-y divide-border/60">
        {positions.map((position: any) => {
          const live = currentDisplayPrice(positionQuotes?.prices?.[position.symbol],
            {price:position.current_price,as_of:position.quote_as_of},positionDisplayNow)
          const p = live ? {...position,current_price:live.price,quote_as_of:live.as_of,quote_status:'fresh'} : {...position,quote_status:position.quote_status==='fresh'?'stale':position.quote_status}
          const entry = p.avg_cost ?? p.entry_price ?? 0
          const current = p.current_price ?? entry
          const shares = p.shares ?? 0
          const lots = formatTaiwanShareLots(shares)
          const pnlPct = entry > 0 ? (current - entry) / entry : 0
          const pnlAmt = (current - entry) * shares
          const costBasis = entry * shares
          const s12HoldingDefense = formatS12HoldingDefenseBadge(p.s12_holding_defense)
          const lifecycleBadge = formatCanonicalTradeLifecycleBadge(p.canonical_trade_lifecycle)
          const riskPlan = formatPositionRiskPlan(p)
          const l4 = positionL4View(p.l4_assessment)
          const riskContractBadge = riskPlan.primaryS12 ? null : lifecycleBadge
          totalUnrealized += pnlAmt
          totalCostBasis += costBasis

          // 持有天數
          const daysHeld = p.entry_date
            ? Math.round((Date.now() - new Date(p.entry_date).getTime()) / 86400000)
            : null

          return (
            <div key={p.symbol} className="px-4 py-2.5 text-[13px]">
              <div className="flex flex-wrap items-start gap-x-6 gap-y-1.5">
                <div className="min-w-[8.5rem]">
                  <span className="sv-num font-medium text-foreground">{p.symbol}</span> <span className="text-foreground">{p.name}</span>
                  {daysHeld != null && <div className="text-[11px] text-muted-foreground">持有 {daysHeld} 天</div>}
                </div>
                <PosCell label="股數"><span className="sv-num">{lots}</span></PosCell>
                <PosCell label="含費均成本"><span className="sv-num">${fmt(entry, 2)}</span></PosCell>
                <PosCell label="現價">
                  <span className="sv-num">${fmt(current, 1)}</span>{' '}
                  <span className={`text-[10px] ${p.quote_status === 'fresh' ? 'text-ok' : p.quote_status === 'stale' ? 'text-warn' : 'text-fail'}`}>
                    {p.quote_status === 'fresh' ? '即時' : p.quote_status === 'stale' ? '盤中末筆' : '即時報價不可用'}
                    {p.quote_as_of ? ` · ${formatTwDateTimeShort(p.quote_as_of)}` : ''}
                  </span>
                </PosCell>
                <PosCell label="未實現" className="ml-auto text-right">
                  <span className={`sv-num ${pctClass(pnlPct)}`}>{pnlPct >= 0 ? '+' : ''}{(pnlPct * 100).toFixed(2)}%</span>{' '}
                  <span className={`text-xs sv-num ${pctClass(pnlAmt)}`}>{formatSignedTwd(Math.round(pnlAmt))}</span>
                </PosCell>
              </div>
              <div className="mt-2 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
                <PosCell label="L4 持倉判斷">
                  <div className="text-[13px] font-medium">{l4.label}</div>
                  {l4.weights && <div className="mt-0.5 sv-num">{l4.weights}</div>}
                  <div className="mt-0.5 text-muted-foreground">{l4.detail}</div>
                </PosCell>
                <PosCell label="防守價">
                  {riskPlan.stop ? (
                    <>
                      <div className={`sv-num text-[13px] ${riskPlan.stopTone === 'warn' ? 'text-warn' : 'text-down'}`}>${riskPlan.stop}</div>
                      {riskPlan.stopSource && <div className="mt-0.5 text-muted-foreground">{riskPlan.stopSource}</div>}
                    </>
                  ) : <span className="text-muted-foreground">—</span>}
                </PosCell>
                <PosCell label="出場規則">
                  {riskPlan.tp1 && (
                    <div className={`sv-num ${riskPlan.tp1Hit ? 'text-muted-foreground line-through' : 'text-up'}`}>
                      {riskPlan.fusionV2 ? 'Fusion TP1' : riskPlan.primaryS12 ? 'S12 TP1' : 'T1'} ${riskPlan.tp1}
                    </div>
                  )}
                  {riskPlan.tp2 && <div className="sv-num text-up">{riskPlan.primaryS12 ? 'S12 主出場' : 'T2'} ${riskPlan.tp2}</div>}
                  {riskPlan.tp3 && <div className="sv-num text-up">TP3 ${riskPlan.tp3}</div>}
                  {riskPlan.tp4 && <div className="sv-num text-up">TP4 ${riskPlan.tp4}</div>}
                  {riskPlan.nearPressure && <div className="sv-num text-warn">S12 近端壓力 ${riskPlan.nearPressure}</div>}
                  {riskPlan.nearPressureSource && <div className="mt-0.5 text-muted-foreground">{riskPlan.nearPressureSource}</div>}
                  {riskPlan.tpSource && <div className="mt-0.5 text-muted-foreground">{riskPlan.tpSource}</div>}
                  {!riskPlan.tp1 && !riskPlan.tp2 && !riskPlan.tp3 && !riskPlan.tp4 && !riskPlan.tpSource && !riskPlan.nearPressure && <span className="text-muted-foreground">—</span>}
                </PosCell>
              </div>
              {(s12HoldingDefense || riskContractBadge) && (
                <div className="mt-2 grid grid-cols-1 gap-1.5">
                  {s12HoldingDefense && (
                    <div className={['border-0 border-l-2 px-3 py-1 text-xs leading-5', executionToneClass(s12HoldingDefense.tone)].join(' ')}>
                      <span className="font-semibold">S12 持倉分析：{s12HoldingDefense.label}</span>
                      <span className="ml-2 text-muted-foreground">{s12HoldingDefense.description}</span>
                    </div>
                  )}
                  {riskContractBadge && (
                    <div className={['border-0 border-l-2 px-3 py-1 text-xs leading-5', executionToneClass(riskContractBadge.tone)].join(' ')}>
                      <span className="font-semibold">止損 / 停利 contract：{riskContractBadge.label}</span>
                      <span className="ml-2 text-muted-foreground">{riskContractBadge.description}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Summary bar */}
      <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs">
        <div className="flex gap-4">
          <span className="text-muted-foreground">持倉 <span className="text-foreground/80">{positions.length}</span> 檔</span>
          <span className="text-muted-foreground">成本 <span className="text-foreground/80">${fmt(Math.round(totalCostBasis))}</span></span>
        </div>
        <div className="flex gap-4">
          <span className="text-muted-foreground">未實現 <span className={pctClass(totalUnrealized)}>{formatSignedTwd(Math.round(totalUnrealized))}</span></span>
        </div>
      </div>
    </div>
  )
}

/** 持倉的一格：小標在上、數值在下。 */
function PosCell({ label, className = '', children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  )
}

/** 本頁區塊外框：和交易室同一種標題（14px 標題＋11px 副標同一行）。 */
function BotSection({ title, kicker, children }: { title: string; kicker?: string; children?: ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-border bg-card">
      <header className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 py-2 ${children ? 'border-b border-border' : ''}`}>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {kicker && <span className="text-[11px] text-muted-foreground">{kicker}</span>}
      </header>
      {children}
    </section>
  )
}

/** 右欄卡片內的子區塊：13px 小標＋右側日期／版本，區塊間細線分隔。 */
function SubBlock({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <div className="border-b border-border px-4 py-2.5 last:border-b-0">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-[13px] font-medium text-foreground">{title}</span>
        {meta && <span className="sv-num text-[11px] text-muted-foreground">{meta}</span>}
      </div>
      {children}
    </div>
  )
}

/** 持倉／待買強弱軌跡：沒有可畫的股票時只寫一行，不留空框。 */
function TrajectorySection() {
  const pending = useQuery({ queryKey: ['paper', 'pending-buys'], queryFn: () => paperApi.pendingBuys(), staleTime: 60_000 })
  const positions = useQuery({ queryKey: ['paper', 'positions'], queryFn: paperApi.positions, staleTime: 60_000 })
  const symbols = activePaperTrajectorySymbols(pending.data, positions.data)
  // 與 StockFactorTrajectoryPanel 預設 10 日視窗同一個 query key，React Query 會共用結果。
  const flow = useQuery({
    queryKey: ['recommendations', 'factor-flow-map', 'stocks', 10, symbols.join(',')],
    queryFn: () => recommendationsApi.factorFlowMap({ days: 10, symbols, includeMovers: 0 }),
    enabled: symbols.length > 0,
    staleTime: 5 * 60_000,
    retry: 1,
  })
  if (pending.isLoading || positions.isLoading || (symbols.length > 0 && flow.isLoading)) return <BotSection title="持倉／待買強弱軌跡" kicker="讀取中" />
  if (symbols.length === 0) return <BotSection title="持倉／待買強弱軌跡" kicker="目前沒有持倉，也沒有辯論通過的待買股，沒有軌跡可畫" />
  if (flow.data && (flow.data.stock_series ?? []).length === 0) {
    return <BotSection title="持倉／待買強弱軌跡" kicker={`${symbols.join('、')} 近 10 個交易日沒有軌跡資料`} />
  }
  return <StockFactorTrajectoryPanel />
}

// ─── Trade History ──────────────────────────────────────────────────────────

function TradeHistory() {
  const [page, setPage] = useState(1)
  const pageSize = 10
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['paper', 'orders', 'history', page],
    queryFn: () => paperApi.orders(pageSize, page),
    staleTime: 60_000,
  })

  const orders = paperOrdersFromPayload(data)
  const total = Number(data?.total ?? orders.length)
  const totalPages = Math.max(1, Number(data?.totalPages ?? Math.ceil(total / pageSize)))
  const currentPage = Number(data?.page ?? page)
  const listState = listRefreshState({ isLoading, isError, hasData: !!data, count: orders.length })
  if (listState === 'loading') return <DataState kind="loading" />
  if (listState === 'error') return <DataState kind="error" title="成交歷史讀取失敗" onRetry={() => { void refetch() }} />
  if (listState === 'empty' || listState === 'empty-stale') {
    return (
      <div className="space-y-2">
        {listState === 'empty-stale' && <DataState kind="stale" title="更新失敗，上次讀到的成交是空的" onRetry={() => { void refetch() }} className="px-3 py-1" />}
        <DataState kind="empty" title="還沒有模擬成交" hint="候選股成交後會逐筆記在這裡。" />
      </div>
    )
  }

  return (
    <div className="space-y-2 pt-1">
      {listState === 'list-stale' && <DataState kind="stale" title="更新失敗，顯示上次的資料" onRetry={() => { void refetch() }} className="px-3 py-1" />}
      <div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-muted-foreground text-[11px] border-b border-border">
            <th className="font-normal text-left px-1 py-1.5 sm:px-2">時間</th>
            <th className="font-normal text-left px-1 py-1.5 sm:px-2">股票</th>
            <th className="font-normal text-left px-1 py-1.5 sm:px-2">方向</th>
            <th className="font-normal text-right px-1 py-1.5 sm:px-2 hidden sm:table-cell">股數</th>
            <th className="font-normal text-right px-1 py-1.5 sm:px-2">價格</th>
            <th className="font-normal text-right px-1 py-1.5 sm:px-2">已實現</th>
            <th className="font-normal text-left px-1 py-1.5 sm:px-2 hidden md:table-cell">原因</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o: any, i: number) => {
            const isBuy = o.side === 'buy'
            const realized = realizedPnlFromOrder(o)
            const noteView = humanOrderReason(o)
            return (
              <tr key={o.id ?? i} className="border-b border-border/50 hover:bg-muted/30">
                <td className="px-1 py-1.5 sm:px-2 text-[12px] text-muted-foreground sv-num sm:whitespace-nowrap">
                  {formatTwOrderTime(o.created_at)}
                </td>
                <td className="px-1 py-1.5 sm:px-2">
                  <span className="sv-num text-foreground">{o.symbol}</span>
                  <span className="block text-xs text-muted-foreground sm:ml-1 sm:inline">{o.name}</span>
                </td>
                <td className="px-1 py-1.5 sm:px-2">
                  <span className={`inline-flex items-center text-xs font-medium ${isBuy ? 'text-up' : 'text-down'}`}>
                    {isBuy ? <ArrowUpRight className="w-3 h-3 mr-0.5" /> : <ArrowDownRight className="w-3 h-3 mr-0.5" />}
                    {isBuy ? '買進' : '賣出'}
                  </span>
                </td>
                <td className="px-1 py-1.5 sm:px-2 text-right sv-num text-foreground/80 hidden sm:table-cell">{fmt(o.shares)}</td>
                <td className="px-1 py-1.5 sm:px-2 text-right sv-num text-foreground/80">${fmt(o.price, 1)}</td>
                <td className="px-1 py-1.5 sm:px-2 text-right sv-num">
                  {isBuy ? (
                    <span className="text-muted-foreground">—</span>
                  ) : realized ? (
                    <span className={`sm:whitespace-nowrap ${pctClass(realized.pnl)}`}>
                      {formatSignedTwd(Math.round(realized.pnl))}
                      {realized.pct != null && <span className="block text-[11px] sm:ml-1 sm:inline">{realized.pct >= 0 ? '+' : ''}{realized.pct.toFixed(2)}%</span>}
                    </span>
                  ) : (
                    <span className="text-xs text-warn" title="這筆賣出缺成本或成交資料，還算不出已實現損益">待補</span>
                  )}
                </td>
                <td className="px-1 py-1.5 sm:px-2 text-[12px] text-muted-foreground hidden md:table-cell min-w-[220px] break-words">
                  {noteView.text}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3 text-xs text-muted-foreground">
        <span>第 {currentPage} / {totalPages} 頁 · 共 {total} 筆，每頁 {pageSize} 筆</span>
        <div className="flex items-center gap-2">
          <button type="button" className="rounded border border-border px-3 py-1.5 disabled:opacity-40" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一頁</button>
          <button type="button" className="rounded border border-border px-3 py-1.5 disabled:opacity-40" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>下一頁</button>
        </div>
      </div>
    </div>
  )
}

// ─── Bot Status（Live Scheduler Runs）────────────────────────────────────────

function BotStatusPanel() {
  const { data: risk, isError: riskError, refetch: refetchRisk } = useQuery({
    queryKey: ['market', 'risk'],
    queryFn: marketApi.risk,
    staleTime: 5 * 60_000,
  })

  // The level Paper buys/halts use (GET /market/risk runtimeRisk); the UI applies no score cuts.
  const trading = tradingMarketRisk(risk)
  const ShieldIcon = { alert: ShieldAlert, check: ShieldCheck, neutral: Shield }[marketRiskShield(trading)]

  return (
    <div className="divide-y divide-border">
      {/* 市場風險 */}
      <div className="flex items-center justify-between px-4 py-2.5">
        <div className="flex items-center gap-2">
          <ShieldIcon className={`w-4 h-4 ${trading.style.color}`} />
          <span className="text-sm text-foreground/80">市場風險</span>
        </div>
        {riskError && !risk ? (
          <span className="inline-flex items-center gap-2 text-xs text-fail">
            <StatusIcon tone="fail" /> 讀取失敗
            <button type="button" className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground" onClick={() => { void refetchRisk() }}>重試</button>
          </span>
        ) : <div className="text-right">
          {trading.score == null
            ? <span className="text-muted-foreground text-xs">—</span>
            : <><span className={`sv-num font-semibold ${trading.style.color}`}>{Math.round(trading.score)}</span>
              <span className="text-muted-foreground text-xs ml-1">/ 100</span></>}
          <Badge className={`ml-2 text-xs ${trading.style.bg} ${trading.style.color} ${trading.style.border}`}>{trading.label}</Badge>
        </div>}
      </div>

      <GateCalibrationPanel />
      {/* 排程執行細節集中在排程節奏頁。 */}
      <p className="px-4 py-1.5 text-[11px] text-muted-foreground">排程紀錄在 <a href="/scheduler" className="text-primary hover:underline">排程節奏</a></p>
    </div>
  )
}

// ─── Performance Chart（Benchmark overlay + Period selector）────────────────

// 成交＝ok、等待＝warn（與模擬交易室「等待中」同色）、擋單＝fail、略過＝中性灰（已結束、非錯誤）。
const GATE_BUCKET_COLOR: Record<string, string> = { filled: 'var(--ok)', deferred: 'var(--warn)', blocked: 'var(--fail)', skipped: 'var(--muted-foreground)' }

function GateCalibrationPanel() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['paper', 'gate-calibration', 7],
    queryFn: () => paperApi.gateCalibration(7),
    staleTime: 60_000,
    refetchInterval: isTWMarketOpen() ? 60_000 : false,
  })

  const view = gateCalibrationView(data, 7)
  const rows: any[] = Array.isArray(data?.rows) ? data.rows : []
  const topRows = rows.slice(0, 5)
  const maxCount = Math.max(1, ...topRows.map((row) => Number(row.count ?? 0)))

  const GATE_STATUS_PREFIX: Record<string, string> = { deferred: '等待：', blocked: '擋單：', skipped: '略過：', cancelled: '取消：' }
  function describeGate(row: any): string {
    if ((row.outcome ?? row.status) === 'filled') return '已成交'
    return `${GATE_STATUS_PREFIX[row.outcome ?? row.status] ?? ''}${humanEntryReason(row.reason, '其他原因')}`
  }

  return (
    <div className="px-4 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="text-[13px] font-medium text-foreground">進場卡控</div>
        {!isLoading && !isError && <div className="sv-num text-[11px] text-muted-foreground" title="分母＝統計窗內每檔每次進場檢查一筆＋模擬買進成交；成交＋等待＋擋單＋略過＝分母">
          {view.windowLabel ?? `近 ${view.days} 天`} · 分母 {formatNumber(view.total)} 次
        </div>}
      </div>

      {isLoading ? (
        <DataState kind="loading" className="px-0" />
      ) : isError ? (
        <DataState kind="error" title="進場卡控讀取失敗" onRetry={() => { void refetch() }} className="px-0" />
      ) : view.total === 0 ? (
        <DataState kind="empty" title={`近 ${view.days} 天沒有進場檢查紀錄`} className="px-0" />
      ) : (
        <>
          {view.consistent ? (
            <>
              <div className="mt-2 flex h-2.5 overflow-hidden rounded-sm bg-muted" role="img" aria-label={view.buckets.map((b) => `${b.label} ${b.value}`).join('、')}>
                {view.buckets.map((bucket) => (
                  <div key={bucket.key} style={{ width: `${(bucket.value ?? 0) / view.total * 100}%`, background: GATE_BUCKET_COLOR[bucket.key] }} title={`${bucket.label} ${bucket.value}`} />
                ))}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 sv-num text-[11px]">
                {view.buckets.map((bucket) => (
                  <span key={bucket.key} className="inline-flex items-center gap-1 text-muted-foreground">
                    <i className="inline-block h-2 w-2 rounded-sm" style={{ background: GATE_BUCKET_COLOR[bucket.key] }} />
                    {bucket.label} <b className="text-foreground">{formatNumber(bucket.value)}</b>
                    <span>{formatNumber((bucket.value ?? 0) / view.total * 100, 0)}%</span>
                  </span>
                ))}
              </div>
            </>
          ) : (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-warn" title="Worker 回傳的成交／等待／略過加總不等於總數（舊版統計字彙對不上），不顯示誤導的 0">
              <StatusIcon tone="warn" /> 口徑不一致：分項加總 ≠ {formatNumber(view.total)}，分項暫不顯示
            </div>
          )}
          <div className="mt-2 space-y-1">
            {topRows.map((row, idx) => (
              <div key={`${row.status}-${row.reason}-${idx}`} className="grid grid-cols-[minmax(0,1fr)_64px_40px] items-center gap-2 text-[11px]">
                <span className="break-words text-muted-foreground">{describeGate(row)}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-muted"><span className="block h-full bg-slate-400/70" style={{ width: `${Number(row.count ?? 0) / maxCount * 100}%` }} /></span>
                <span className="text-right sv-num text-foreground">{formatNumber(Number(row.count ?? 0))}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function PerformanceChart() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['paper', 'pnl'],
    queryFn: paperApi.pnl,
    staleTime: 5 * 60_000,
  })
  // Same keys as the order list and SignalTable, so one page visit fetches each payload once.
  const { data: ordersData } = useQuery({
    queryKey: ['paper', 'orders'],
    queryFn: () => paperApi.orders(200),
    staleTime: 60_000,
  })
  const { data: pendingData } = useQuery({
    queryKey: ['paper', 'pending-buys'],
    queryFn: () => paperApi.pendingBuys(),
    staleTime: 60_000,
  })
  const orders = paperOrdersFromPayload(ordersData)
  const pendingBuys = paperPendingBuysFromPayload(pendingData)

  return (
    <PaperTradePerformanceChart
      pnl={data}
      orders={orders}
      pendingBuys={pendingBuys}
      loading={isLoading}
      error={error}
      onRetry={() => { void refetch() }}
    />
  )
}

// ─── Backtest Card (skeleton) ────────────────────────────────────────────────

function BacktestCard() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['backtest', 'latest'],
    queryFn: backtestApi.latest,
    staleTime: 30 * 60_000,
  })
  const { data: mcData, isError: mcError } = useQuery({
    queryKey: ['backtest', 'monte-carlo'],
    queryFn: backtestApi.monteCarlo,
    staleTime: 30 * 60_000,
  })
  const { data: pboData, isError: pboError } = useQuery({
    queryKey: ['backtest', 'pbo'],
    queryFn: backtestApi.pbo,
    staleTime: 30 * 60_000,
  })

  if (isLoading) return <SubBlock title="回測"><DataState kind="loading" className="px-0" /></SubBlock>
  if (!data) {
    return (
      <SubBlock title="回測">
        {error
          ? <DataState kind="error" title="回測結果讀取失敗" code={error instanceof Error ? error.message : undefined} onRetry={() => { void refetch() }} className="px-0" />
          : <DataState kind="empty" title="尚無回測結果" className="px-0" />}
      </SubBlock>
    )
  }

  // 上色規則：CAGR、期望值是報酬 → 漲跌色；MDD 是虧損 → down；其餘比值依門檻判斷 → 狀態色＋圖示；交易數中性。
  type Metric = { label: string; value: string | number; hint: string; kind: 'return' | 'loss' | 'threshold' | 'neutral'; raw?: number | null; tone?: ThresholdTone }
  const metrics: Metric[] = [
    { label: 'Sharpe', value: data.sharpe != null ? data.sharpe.toFixed(2) : '-', kind: 'threshold', tone: thresholdTone(data.sharpe, 1), hint: '每承擔一單位波動換到多少超額報酬；>1 才算有基本效率。' },
    { label: 'Sortino', value: data.sortino != null ? data.sortino.toFixed(2) : '-', kind: 'threshold', tone: thresholdTone(data.sortino, 1.5), hint: '只看下跌波動的風險調整報酬；比 Sharpe 更貼近實際痛感。' },
    { label: 'MDD', value: formatDrawdownPct(data.max_drawdown), kind: 'loss', raw: data.max_drawdown, hint: '歷史最大資金回撤；代表策略最壞連續虧損壓力（門檻 15%）。' },
    { label: '勝率', value: data.win_rate != null ? `${(data.win_rate * 100).toFixed(1)}%` : '-', kind: 'threshold', tone: thresholdTone(data.win_rate, 0.5), hint: '交易勝率；要搭配 PF／期望值看，單獨高不一定好。' },
    { label: 'PF', value: data.profit_factor != null ? data.profit_factor.toFixed(2) : '-', kind: 'threshold', tone: thresholdTone(data.profit_factor, 1.5), hint: '總獲利 / 總虧損；>1 表示有正收益，>1.5 較健康。' },
    { label: 'CAGR', value: data.cagr != null ? formatSignedPct(data.cagr * 100, 1) : '-', kind: 'return', raw: data.cagr, hint: '年化複合報酬；用來比較不同期間策略。' },
    { label: 'Calmar', value: data.calmar != null ? data.calmar.toFixed(2) : '-', kind: 'threshold', tone: thresholdTone(data.calmar, 1), hint: 'CAGR / MDD；衡量報酬是否值得承受最大回撤。' },
    { label: '交易數', value: data.total_trades ?? '-', kind: 'neutral', hint: '樣本數；太少時 Sharpe、勝率、PF 都容易失真。' },
    { label: '期望值', value: data.expectancy != null ? data.expectancy.toFixed(4) : '-', kind: 'return', raw: data.expectancy, hint: '每筆交易平均期望值；>0 才代表長期下注有正期望。' },
  ]

  const VERDICT_LABEL: Record<string, string> = { PASS: '通過', CAUTION: '注意', FAIL: '未通過', INSUFFICIENT_EVIDENCE: '樣本不足' }
  const VERDICT_TONE: Record<string, 'ok' | 'warn' | 'fail'> = { PASS: 'ok', CAUTION: 'warn', FAIL: 'fail', INSUFFICIENT_EVIDENCE: 'warn' }

  // MC MDD verdict
  const mcVerdict = mcData?.go_live_verdict

  // PBO uses the latest immutable attempt receipt. Historical numeric rows never masquerade as this week's attempt.
  const pboAttempt = pboData?.latest_attempt
  const pboNumeric = pboAttempt?.numeric_result
  const pboVerdict = pboAttempt?.status === 'insufficient_evidence'
    ? 'INSUFFICIENT_EVIDENCE'
    : pboNumeric?.go_live_verdict

  function Verdict({ code }: { code?: string | null }) {
    if (!code) return <span className="text-muted-foreground">—</span>
    const tone = VERDICT_TONE[code]
    return tone ? <StatusBadge tone={tone} title={code}>{VERDICT_LABEL[code]}</StatusBadge> : <span className="text-muted-foreground" title={code}>未知判定</span>
  }

  return (
    <SubBlock title="回測" meta={`${formatDate(data.run_date)}${data.timerange ? ` · ${data.timerange}` : ''}`}>
      <div className="grid grid-cols-3 gap-x-3 gap-y-2">
        {metrics.map(m => {
          const cls = m.kind === 'return' ? priceToneClass(m.raw) : m.kind === 'loss' ? (m.raw ? 'text-down' : 'text-muted-foreground') : m.kind === 'threshold' ? (m.tone === 'ok' ? 'text-ok' : m.tone === 'fail' ? 'text-fail' : 'text-muted-foreground') : 'text-foreground'
          return (
            <div key={m.label} title={m.hint}>
              <div className="text-[11px] text-muted-foreground">{m.label}</div>
              <div className={`inline-flex items-center gap-1 text-sm sv-num ${cls}`}>
                {m.kind === 'threshold' && <StatusIcon tone={m.tone ?? 'na'} title={m.tone === 'na' ? '尚無數值，未檢查' : undefined} />} {m.value}
              </div>
            </div>
          )
        })}
      </div>
      {/* Weekly Validation split: PBO credibility, MC tail risk, backtest consistency */}
      {(mcVerdict || pboVerdict || mcError || pboError) && (
        <div className="mt-2 divide-y divide-border border-t border-border text-[12px]">
          <div className="py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground" title="PBO：過度擬合機率">PBO 可信度</span>
              <span className="flex items-center gap-1.5 sv-num">
                PBO {pboNumeric?.pbo != null ? `${(pboNumeric.pbo * 100).toFixed(0)}%` : '-'}
                {pboError && !pboData ? <span className="text-fail">讀取失敗</span> : pboVerdict ? <Verdict code={pboVerdict} /> : <span className="text-muted-foreground">本週尚未檢定</span>}
              </span>
            </div>
            {pboError && !pboData ? null : pboAttempt ? (
              <div className="mt-0.5 text-right text-[11px] text-muted-foreground">
                {formatDate(pboAttempt.run_date)} · 樣本 {pboAttempt.observed_trades}/{pboAttempt.required_trades} · 不影響實盤
              </div>
            ) : (
              <div className="mt-0.5 text-right text-[11px] text-warn" title="不沿用舊 numeric result 作為本週狀態">
                本週還沒有 PBO 檢定紀錄；舊的數值不拿來當本週狀態。
              </div>
            )}
          </div>
          <div className="py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground" title="Monte Carlo 模擬的 95 百分位最大回撤">尾端風險（MC）</span>
              <span className="flex items-center gap-1.5 sv-num">
                95 分位回撤 {mcData?.mdd_95th != null ? `${(mcData.mdd_95th * 100).toFixed(1)}%` : '-'}
                {mcError && !mcData ? <span className="text-fail">讀取失敗</span> : <Verdict code={mcVerdict} />}
              </span>
            </div>
            {String((mcData as any)?.raw_distribution ?? '').includes('LOW_SAMPLE_TAIL_RISK') && (
              <div className="mt-0.5 text-right text-[11px] text-warn">樣本少，尾端風險估計不穩</div>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 py-1.5">
            <span className="text-muted-foreground">回測一致性</span>
            <span className="sv-num text-foreground">MDD {formatDrawdownPct(data.max_drawdown)} · 交易 {data.total_trades ?? '—'}</span>
          </div>
        </div>
      )}
    </SubBlock>
  )
}

// ─── Adaptive Params Card ────────────────────────────────────────────────────

function AdaptiveParamsCard() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['adaptive', 'params'],
    queryFn: adaptiveApi.get,
    staleTime: 5 * 60_000,
  })

  if (isLoading) return <SubBlock title="調整參數"><DataState kind="loading" className="px-0" /></SubBlock>
  if (error && !data) {
    return (
      <SubBlock title="調整參數">
        <DataState kind="error" title="調整參數讀取失敗" code={error instanceof Error ? error.message : undefined} onRetry={() => { void refetch() }} className="px-0" />
      </SubBlock>
    )
  }
  if (!data || !data.computed_at) return <SubBlock title="調整參數"><p className="text-muted-foreground text-xs">尚未計算（今日 16:05 後可用）</p></SubBlock>

  const confThreshold = data.confidence_threshold ?? 0.60
  // Score the adaptive update was computed with; it carries no level, so it is not colored as one.
  const riskScore     = typeof data.market_risk_score === 'number' && Number.isFinite(data.market_risk_score) ? data.market_risk_score : null
  const acc30d        = data.recent_accuracy_30d ?? 0
  const banditMult    = data.bandit_max_mult ?? 2.5
  const forceExplore  = data.bandit_force_explore ?? false
  const slOverride    = data.sl_tp_override
  const version       = data.version ?? 0
  const computedAt    = data.computed_at ? data.computed_at.slice(0, 16).replace('T', ' ') : '-'

  const confColor = confThreshold > 0.65 ? 'text-warn' : confThreshold < 0.58 ? 'text-ok' : 'text-foreground/80'

  const items: { label: string; value: string; cls: string }[] = [
    { label: '信心門檻', value: confThreshold.toFixed(2), cls: confColor },
    { label: '風險分數', value: riskScore == null ? '待接資料' : String(riskScore), cls: 'text-foreground/80' },
    { label: '30 日準確率', value: `${(acc30d * 100).toFixed(0)}%`, cls: acc30d >= 0.6 ? 'text-ok' : 'text-warn' },
    { label: 'Bandit 倍數', value: forceExplore ? '強制探索' : `×${banditMult.toFixed(1)}`, cls: forceExplore ? 'text-warn' : 'text-foreground/80' },
  ]
  return (
    <SubBlock title="調整參數" meta={`v${version} · ${computedAt}`}>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4 xl:grid-cols-2">
        {items.map((it) => (
          <div key={it.label}>
            <div className="text-[11px] text-muted-foreground">{it.label}</div>
            <div className={`text-sm sv-num ${it.cls}`}>{it.value}</div>
          </div>
        ))}
      </div>
      {slOverride && (
        <div className="mt-2 border-l-2 border-warn px-2 py-1 text-xs text-warn">
          SL +{slOverride.sl_add} ATR / TP +{slOverride.tp_add} ATR（高風險 regime 加寬）
        </div>
      )}
    </SubBlock>
  )
}

// ─── Trade Journal Analytics ────────────────────────────────────────────────


// ─── Position Sizing Calculator ─────────────────────────────────────────────


// ─── 模擬交易主頁 ─────────────────────────────────────────────────────────

export default function BotDashboard() {
  const { isAuthenticated, login } = useAuth()

  // ⚠ All hooks BEFORE conditional return（React rules of hooks — M15 教訓）
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null)
  const { data: searchResult } = useQuery({
    queryKey: ['stock-search', selectedSymbol],
    queryFn: () => stocksApi.search(selectedSymbol!, 1),
    enabled: !!selectedSymbol && isAuthenticated,
    staleTime: 60_000,
  })
  const selectedStockId = searchResult?.[0]?.id ?? null
  // 帳戶與持倉卡標題的檔數；與 PositionsTable 共用 query key。
  const { data: positionsPayload } = useQuery({
    queryKey: ['paper', 'positions'],
    queryFn: paperApi.positions,
    enabled: isAuthenticated,
    staleTime: 60_000,
  })
  const holdingCount = paperPositionsFromPayload(positionsPayload).length

  if (!isAuthenticated) {
    return (
      <AppShell>
        <div className="flex min-h-full items-center justify-center p-4 lg:p-5">
          <div className="w-full max-w-4xl space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-[15px] font-semibold text-foreground">模擬交易室</h1>
              <StatusBadge tone="warn">需要登入</StatusBadge>
              <span className="text-[11px] text-muted-foreground">登入後查看待買清單、成交、停利停損與資產變化；未登入不讀交易資料。</span>
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <WorkstationCatCard
                src="/stockvision-cats/02_red_market_royal_cat.png"
                title="紅盤也要端著"
                caption="登入後再看真實資產與持倉；紅歸紅，交割與滑價不能亂算。"
                tone="warn"
              />
              <WorkstationCatCard
                src="/stockvision-cats/03_ai_signal_skewer_stall.png"
                title="AI 串燒別亂買"
                caption="L4 產生待買清單，盤中依進場條件、風控與報價執行；辯論僅供觀察。"
                tone="info"
              />
            </div>
            <div className="rounded-lg border border-border p-6 text-center">
              <Bot className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 text-sm text-muted-foreground">請先登入以查看模擬交易室</p>
              <button onClick={login} className="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90">
                Google 登入
              </button>
            </div>
          </div>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="p-3 lg:p-4 space-y-3 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-[15px] font-semibold text-foreground">模擬交易室</h1>
          <span className="text-[11px] text-muted-foreground">模擬交易 · 待買、成交與資產變化</span>
        </div>

        {/* 第一屏留給推薦候選（依時段：盤前計畫／盤中／盤後結果）；持倉、紀錄、曲線往下移。 */}
        <section aria-label="推薦候選">
          <SignalTable onSelectSymbol={setSelectedSymbol} />
        </section>

        <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-12">
          {/* 左 8 欄：帳戶與持倉 → 績效比較圖 → 成交明細 */}
          <div className="min-w-0 space-y-3 xl:col-span-8">
            <BotSection title="帳戶與持倉" kicker={holdingCount > 0 ? `持倉 ${holdingCount} 檔 · 停利停損與 L4 判斷` : '持倉 0 檔'}>
              <PortfolioSummary />
              <div className="border-t border-border">
                <PositionsTable />
              </div>
            </BotSection>
            <DeferredRender minHeight={340}>
              <BotSection title="績效比較" kicker="與大盤 TWII、0050 同起點比較">
                <div className="px-3 pb-2 pt-1">
                  <Suspense fallback={<DataState kind="loading" title="圖表載入中" minHeight={280} />}>
                    <PerformanceChart />
                  </Suspense>
                </div>
              </BotSection>
            </DeferredRender>
            <DeferredRender minHeight={420}>
              <BotSection title="成交明細" kicker="委託與成交">
                <TradeHistory />
              </BotSection>
            </DeferredRender>
          </div>

          {/* 右 4 欄：狀態與檢查 */}
          <div className="min-w-0 space-y-3 xl:col-span-4">
            <BotSection title="市場風險與進場卡控" kicker="今日市場風險 · 近 7 天進場檢查">
              <BotStatusPanel />
            </BotSection>
            <RotationAudit />
            <BotSection title="回測與調整參數" kicker="先看 MDD／Calmar，再看 Sharpe／Sortino，最後 PF／期望值">
              <BacktestCard />
              <AdaptiveParamsCard />
            </BotSection>
          </div>
        </div>

        <TrajectorySection />

        {/* K-Line Dialog (popup on stock click) */}
        <Dialog open={!!selectedStockId} onOpenChange={(open) => { if (!open) setSelectedSymbol(null) }}>
          <DialogContent className="max-w-4xl bg-card border-border">
            <DialogHeader>
              <DialogTitle className="text-sm sv-num">{selectedSymbol} K 線圖</DialogTitle>
            </DialogHeader>
            {selectedStockId && (
              <Suspense fallback={<div className="grid min-h-80 place-items-center text-xs text-muted-foreground">K 線載入中…</div>}>
                <CandlestickChart stockId={selectedStockId} />
              </Suspense>
            )}
          </DialogContent>
        </Dialog>



      </div>
    </AppShell>
  )
}
