/**
 * 模擬交易室 — Auto Trade Bot 專頁
 *
 * Design: Dark Mode + Mobile-first, inspired by FreqUI + 3Commas
 * Sections: Portfolio Summary → Signals → Positions → Trade History → Bot Status
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { paperApi, marketApi, recommendationsApi, systemApi, backtestApi, cronApi, adaptiveApi } from '@/lib/api'
import { useAuth } from '@/_core/hooks/useAuth'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Activity, TrendingUp, Wallet, Bot, ShieldCheck, ShieldAlert,
  Clock, ArrowUpRight, ArrowDownRight, Scale, Cpu,
} from 'lucide-react'
import { BotThemeFlowPanel } from '@/components/DailyRecommendationPanel'
import { RecommendationCardClean as RecommendationCard } from '@/components/RecommendationCardClean'
import CandlestickChart from '@/components/CandlestickChart'
import AppShell from '@/components/AppShell'
import PaperTradePerformanceChart from '@/components/charts/PaperTradePerformanceChart'
import { stocksApi } from '@/lib/api'
import { explainExecutionEvent, formatExecutionEvent } from '@/lib/executionEvent'
import { formatCanonicalTradeLifecycleBadge, formatPartialFillRemaining, formatPendingBuyExecutionBadge, formatS12HoldingDefenseBadge, formatS12IntradayStructureBadge } from '@/lib/pendingBuyExecutionUi'
import { describeAllocatorDecision } from '@/lib/pendingBuyAllocatorUi'
import { formatTwDateTimeShort } from '@/lib/twTime'
import { paperOrdersFromPayload, paperPendingBuysFromPayload, paperPnlSnapshotsFromPayload, paperPositionsFromPayload } from '@/lib/paperPayload'
import {
  WorkstationCatCard,
  WorkstationPageTitle,
  WorkstationPanel,
  WorkstationPill,
} from '@/components/workstation/WorkstationChrome'
import { buildScoreV2PayloadFromProjectedScores } from '@/lib/scoreV2ViewModel'

// ─── Helpers ────────────────────────────────────────────────────────────────

function isTWMarketOpen(): boolean {
  const h = (new Date().getUTCHours() + 8) % 24
  const m = new Date().getUTCMinutes()
  return h >= 9 && (h < 13 || (h === 13 && m <= 30))
}

function fmt(n: number | null | undefined, decimals = 0): string {
  if (n == null) return '-'
  return n.toLocaleString('zh-TW', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function pctClass(pct: number): string {
  if (pct > 0) return 'text-red-400'
  if (pct < 0) return 'text-emerald-400'
  return 'text-muted-foreground'
}

function signalBadge(signal: string) {
  const s = signal?.toUpperCase() ?? ''
  // 台股慣例：紅=買/漲, 綠=賣/跌
  if (s.includes('POTENTIAL_BUY')) return <Badge className="border border-yellow-200/70 bg-yellow-300/28 px-2 py-0.5 text-[11px] text-yellow-50">POTENTIAL BUY</Badge>
  if (s.includes('STRONG_BUY')) return <Badge className="border border-red-300/55 bg-red-500/85 px-2 py-0.5 text-[11px] text-white">STRONG BUY</Badge>
  if (s.includes('BUY'))        return <Badge className="border border-red-300/45 bg-red-500/80 px-2 py-0.5 text-[11px] text-white">BUY</Badge>
  if (s.includes('STRONG_SELL'))return <Badge className="border border-emerald-300/45 bg-emerald-500/20 px-2 py-0.5 text-[11px] text-emerald-100">STRONG SELL</Badge>
  if (s.includes('SELL'))       return <Badge className="border border-emerald-300/35 bg-emerald-500/18 px-2 py-0.5 text-[11px] text-emerald-100">SELL</Badge>
  if (s.includes('NO_SIGNAL'))  return <Badge className="border border-sky-200/45 bg-sky-500/28 px-2 py-0.5 text-[11px] text-sky-50">—</Badge>
  return <Badge className="border border-sky-200/45 bg-sky-500/28 px-2 py-0.5 text-[11px] text-sky-50">HOLD</Badge>
}

function recommendationSignalText(rec: any): string {
  return String(rec?.signal ?? rec?.trade_signal ?? rec?.tradeSignal ?? rec?.signal_raw ?? '').toUpperCase()
}

function isBuySignalRecommendation(rec: any): boolean {
  if (rec?.has_buy_signal === 1 || rec?.has_buy_signal === true) return true
  return ['BUY', 'STRONG_BUY'].includes(recommendationSignalText(rec))
}

function recommendationRowsFromPayload(payload: any): any[] {
  const explicitAll = Array.isArray(payload?.all_recommendations) ? payload.all_recommendations : []
  const direct = Array.isArray(payload?.recommendations)
    ? payload.recommendations
    : Array.isArray(payload?.data)
      ? payload.data
      : []
  const merged = explicitAll.length
    ? explicitAll
    : [
        ...direct,
        ...(Array.isArray(payload?.tradable_recommendations) ? payload.tradable_recommendations : []),
        ...(Array.isArray(payload?.research_only_recommendations) ? payload.research_only_recommendations : []),
      ]

  const seen = new Set<string>()
  return merged.filter((row: any, index: number) => {
    const key = String(row?.stock_id ?? row?.symbol ?? index)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseRecommendationRecord(value: unknown): Record<string, any> | null {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : null
  } catch {
    return null
  }
}

function isPotentialBuyRecommendation(rec: any): boolean {
  if (recommendationSignalText(rec) === 'POTENTIAL_BUY') return true
  const allocation = parseRecommendationRecord(rec?.alpha_allocation)
  if (allocation?.potential_buy === true || allocation?.potential_buy === 1) return true
  const points = Array.isArray(rec?.watch_points)
    ? rec.watch_points
    : typeof rec?.watch_points === 'string'
      ? [rec.watch_points]
      : []
  return points.some((point: any) => String(point).includes('allocation:potential_buy'))
}

// ─── Conviction Gauge（半圓 SVG）──────────────────────────────────────────────
function ConvictionGauge({ value, size = 48 }: { value: number; size?: number }) {
  const pct = Math.max(0, Math.min(100, value * 100))
  const r = size * 0.4
  const cx = size / 2
  const cy = size * 0.55
  const circumHalf = Math.PI * r
  const filled = (pct / 100) * circumHalf
  const color = pct >= 75 ? '#22c55e' : pct >= 55 ? '#eab308' : '#ef4444'
  return (
    <svg width={size} height={size * 0.6} viewBox={`0 0 ${size} ${size * 0.65}`}>
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
        fill="none" stroke="#27272a" strokeWidth={4} strokeLinecap="round" />
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
        fill="none" stroke={color} strokeWidth={4} strokeLinecap="round"
        strokeDasharray={`${filled} ${circumHalf}`} />
      <text x={cx} y={cy - 2} textAnchor="middle" fill={color} fontSize={size * 0.22} fontFamily="Manrope, Noto Sans TC, system-ui, sans-serif" fontWeight="bold">
        {pct.toFixed(0)}
      </text>
    </svg>
  )
}

// ─── Micro RRG 2×2 方格 ──────────────────────────────────────────────────────
function MicroRRG({ quadrant }: { quadrant?: string }) {
  const cells = [
    { q: 'Improving', x: 0, y: 0, color: '#3b82f6' },
    { q: 'Leading',   x: 1, y: 0, color: '#22c55e' },
    { q: 'Lagging',   x: 0, y: 1, color: '#ef4444' },
    { q: 'Weakening', x: 1, y: 1, color: '#eab308' },
  ]
  return (
    <svg width={24} height={24} viewBox="0 0 24 24">
      {cells.map(c => (
        <rect key={c.q} x={c.x * 12} y={c.y * 12} width={11} height={11} rx={2}
          fill={c.q === quadrant ? c.color : '#27272a'}
          opacity={c.q === quadrant ? 0.9 : 0.3} />
      ))}
    </svg>
  )
}

// ─── Portfolio Summary（FinLab 風格 6 卡）───────────────────────────────────

function WinLossBadge({ win }: { win: boolean | null }) {
  if (win === null) return <span className="text-muted-foreground/60 text-xs">-</span>
  return win
    ? <span className="text-xs font-bold text-red-400">勝</span>
    : <span className="text-xs font-bold text-emerald-400">負</span>
}

function PortfolioSummary() {
  const { data: account } = useQuery({ queryKey: ['paper', 'account'], queryFn: paperApi.account, staleTime: 60_000 })
  const { data: positions } = useQuery({
    queryKey: ['paper', 'positions'],
    queryFn: paperApi.positions,
    staleTime: 30_000,
    refetchInterval: isTWMarketOpen() ? 60_000 : 5 * 60_000,
    refetchOnWindowFocus: true,
  })
  const { data: pnlData } = useQuery({ queryKey: ['paper', 'pnl'], queryFn: paperApi.pnl, staleTime: 5 * 60_000 })
  // 歷史已實現損益（Server-side 全歷史計算）
  const { data: realizedData } = useQuery({ queryKey: ['paper', 'realized'], queryFn: paperApi.realized, staleTime: 5 * 60_000 })
  const totalRealizedPnl = realizedData?.totalRealizedPnl ?? 0
  const sellOrderCount = realizedData?.tradeCount ?? 0

  const acc = account?.account ?? account ?? {}
  const positionSummary = positions?.summary ?? null
  const cash = positionSummary?.cash ?? acc?.cash ?? 0
  const initialCash = acc?.initial_cash ?? positionSummary?.initial_cash ?? 1_000_000
  const posArr = paperPositionsFromPayload(positions)
  const positionValue = Array.isArray(posArr)
    ? posArr.reduce((s: number, p: any) => s + (p.current_price ?? p.avg_cost ?? 0) * (p.shares ?? 0), 0)
    : 0
  const netUnsettledSettlement = positionSummary?.net_unsettled_settlement ?? 0
  const totalAssets = positionSummary?.total_value ?? (cash + positionValue + netUnsettledSettlement)
  const totalReturn = initialCash > 0 ? (totalAssets - initialCash) / initialCash : 0

  // PnL snapshots for advanced metrics
  const snapshots = paperPnlSnapshotsFromPayload(pnlData)
  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null
  const first = snapshots.length > 0 ? snapshots[0] : null

  // 年化報酬
  const daysSinceStart = first?.date
    ? Math.max(1, (Date.now() - new Date(first.date).getTime()) / 86400000)
    : 1
  const annualizedReturn = typeof latest?.cagr === 'number' && Number.isFinite(latest.cagr)
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

  // 大盤比較（0050 benchmark）
  function getBenchmarkReturnSince(daysAgo: number): number | null {
    if (snapshots.length < 2) return null
    const cutoff = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)
    const ref = snapshots.find((s: any) => s.date >= cutoff) ?? snapshots[0]
    const refBm = ref?.benchmark_value
    const curBm = latest?.benchmark_value
    if (!refBm || !curBm) return null
    return (curBm - refBm) / refBm
  }
  const bmWeek = getBenchmarkReturnSince(7)
  const bmMonth = getBenchmarkReturnSince(30)
  const bmQuarter = getBenchmarkReturnSince(90)

  function beatsBenchmark(botRet: number | null, bmRet: number | null): boolean | null {
    if (botRet === null || bmRet === null) return null
    return botRet > bmRet
  }

  return (
    <div className="grid grid-cols-[1.2fr_repeat(4,1fr)_1fr_1.2fr] items-baseline gap-6 py-1 overflow-x-auto whitespace-nowrap">
      {/* 總資產 */}
      <div>
        <div className="text-xs text-muted-foreground normal-case font-medium mb-1">總資產</div>
        <div className="text-3xl sv-num font-bold text-foreground leading-tight">${fmt(totalAssets)}</div>
        <span className={`text-sm sv-num font-semibold ${pctClass(totalReturn)}`}>{totalReturn >= 0 ? '+' : ''}{(totalReturn * 100).toFixed(2)}%</span>
        {netUnsettledSettlement !== 0 && (
          <div className="text-[11px] text-muted-foreground/70 mt-1">
            含未交割 {netUnsettledSettlement > 0 ? '+' : ''}${fmt(Math.round(netUnsettledSettlement))}
          </div>
        )}
      </div>
      {/* 指標列 */}
      {[
        { label: '已實現', val: `${totalRealizedPnl >= 0 ? '+' : ''}$${fmt(Math.round(totalRealizedPnl))}`, sub: `${sellOrderCount}筆`, cls: pctClass(totalRealizedPnl) },
        { label: '年化', val: `${annualizedReturn >= 0 ? '+' : ''}${(annualizedReturn * 100).toFixed(1)}%`, sub: `${Math.round(daysSinceStart)}天`, cls: pctClass(annualizedReturn) },
        { label: 'MDD', val: `-${(maxDrawdown * 100).toFixed(1)}%`, sub: '', cls: maxDrawdown > 0 ? pctClass(-maxDrawdown) : 'text-muted-foreground' },
        { label: 'Sharpe', val: sharpe30d != null ? sharpe30d.toFixed(2) : '-', sub: '30d', cls: sharpe30d != null ? (sharpe30d > 1 ? 'text-emerald-400' : sharpe30d > 0 ? 'text-foreground' : 'text-red-400') : 'text-muted-foreground' },
      ].map(m => (
        <div key={m.label}>
          <div className="text-xs text-muted-foreground normal-case font-medium mb-1">{m.label}</div>
          <div className={`text-xl sv-num font-semibold leading-tight ${m.cls}`}>{m.val}</div>
          <span className="text-[11px] text-muted-foreground/60">{m.sub || '\u00A0'}</span>
        </div>
      ))}
      {/* vs 0050 */}
      <div>
        <div className="text-xs text-muted-foreground normal-case font-medium mb-1">vs 0050</div>
        <div className="flex gap-4 mt-0.5">
          {[{ l: '週', w: beatsBenchmark(retWeek, bmWeek) }, { l: '月', w: beatsBenchmark(retMonth, bmMonth) }, { l: '季', w: beatsBenchmark(retQuarter, bmQuarter) }].map(b => (
            <div key={b.l} className="text-center"><div className="text-[11px] text-muted-foreground">{b.l}</div><WinLossBadge win={b.w} /></div>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground/60">{'\u00A0'}</span>
      </div>
      {/* 近期報酬 */}
      <div>
        <div className="text-xs text-muted-foreground normal-case font-medium mb-1">近期報酬</div>
        <div className="flex gap-5 mt-0.5">
          {[{ l: '週', v: retWeek }, { l: '月', v: retMonth }, { l: '季', v: retQuarter }].map(({ l, v }) => (
            <div key={l} className="text-center">
              <div className="text-[11px] text-muted-foreground">{l}</div>
              <div className={`text-base sv-num font-semibold ${v != null ? pctClass(v) : 'text-muted-foreground/60'}`}>{v != null ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '-'}</div>
            </div>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground/60">{'\u00A0'}</span>
      </div>
    </div>
  )
}

// ─── Today's ML Signals ─────────────────────────────────────────────────────

function PendingBuyStateBadges({ state, stale, meta, policy }: { state?: any; stale?: boolean; meta?: any; policy?: any }) {
  const execution = state?.execution_counts ?? {}
  const events = Array.isArray(meta?.execution_events) ? meta.execution_events.slice(-3) : []
  const executionPolicy = policy?.execution_pool_policy ?? 'l4_sparse_final_buy_only'
  const sourceRecoDate = policy?.source_reco_date ?? meta?.source_reco_date ?? null
  const watchFallbackOff = policy?.watch_fallback_allowed === false
  const stateClass =
    state?.state === 'ready_to_execute' ? 'border-emerald-500/30 text-emerald-400'
      : state?.state === 'debate_pending' ? 'border-sky-500/30 text-sky-400'
        : state?.state === 'filled' ? 'border-teal-500/30 text-teal-300'
          : state?.state === 'skipped' || state?.state === 'expired' || state?.state === 'closed' ? 'border-zinc-500/30 text-zinc-300'
            : state?.state === 'error' || state?.state === 'halted' ? 'border-red-500/40 text-red-300'
              : state?.state === 'base_ready' ? 'border-amber-500/30 text-amber-300'
                : 'border-muted-foreground/30 text-muted-foreground'

  return (
    <div className="px-1 flex items-center gap-2 flex-wrap text-xs sv-num">
      <Badge variant="outline" className={`h-6 px-2 text-[11px] ${stateClass}`}>
        {state?.label ?? 'pending buys'}
      </Badge>
      <Badge variant="outline" className="h-6 px-2 text-[11px] border-emerald-500/30 text-emerald-400">
        active {state?.active_count ?? 0}/{state?.total_count ?? 0}
      </Badge>
      <Badge
        variant="outline"
        title={executionPolicy}
        className="h-6 px-2 text-[11px] border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      >
        L4 sparse final BUY
      </Badge>
      {watchFallbackOff && (
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-zinc-500/30 text-zinc-300">
          watch fallback off
        </Badge>
      )}
      {sourceRecoDate && (
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-sky-500/30 text-sky-300">
          src {sourceRecoDate}
        </Badge>
      )}
      {(execution.filled ?? 0) > 0 && (
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-cyan-500/30 text-cyan-300">
          filled {execution.filled}
        </Badge>
      )}
      {(execution.partially_filled ?? 0) > 0 && (
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-amber-500/30 text-amber-300">
          partial {execution.partially_filled}
        </Badge>
      )}
      {(execution.submitted ?? 0) > 0 && (
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-sky-500/30 text-sky-300">
          submitted {execution.submitted}
        </Badge>
      )}
      {(execution.checked_waiting ?? 0) > 0 && (
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-amber-500/30 text-amber-300">
          checked waiting {execution.checked_waiting}
        </Badge>
      )}
      {(execution.requoted ?? 0) > 0 && (
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-amber-500/30 text-amber-300">
          requoted {execution.requoted}
        </Badge>
      )}
      {(execution.stale_quote ?? 0) > 0 && (
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-amber-500/30 text-amber-300">
          stale quote {execution.stale_quote}
        </Badge>
      )}
      {(execution.quote_unavailable ?? 0) > 0 && (
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-red-500/40 text-red-300">
          quote missing {execution.quote_unavailable}
        </Badge>
      )}
      {(execution.skipped ?? 0) > 0 && (
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-amber-500/30 text-amber-300">
          skipped {execution.skipped}
        </Badge>
      )}
      {(execution.cancelled ?? 0) > 0 && (
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-zinc-500/30 text-zinc-300">
          cancelled {execution.cancelled}
        </Badge>
      )}
      {(execution.expired ?? 0) > 0 && (
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-zinc-500/30 text-zinc-400">
          expired {execution.expired}
        </Badge>
      )}
      {(execution.rejected ?? 0) > 0 && (
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-red-500/40 text-red-300">
          rejected {execution.rejected}
        </Badge>
      )}
      {stale && (
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-amber-500/40 text-amber-400">
          stale
        </Badge>
      )}
      {state?.error_message && <span className="text-red-300/80">{state.error_message}</span>}
      {events.map((event: any, idx: number) => {
        const raw = formatExecutionEvent({
          kind: 'execution',
          status: event.status,
          reason: event.reason,
          detail: event.detail,
        })
        return (
          <span key={`${event.symbol}-${event.status}-${idx}`} className="text-muted-foreground/70">
            {event.symbol} {explainExecutionEvent(raw) ?? `${event.status}: ${event.reason}`}
          </span>
        )
      })}
    </div>
  )
}

function executionToneClass(tone: string): string {
  if (tone === 'ok') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
  if (tone === 'warn') return 'border-amber-500/25 bg-amber-500/10 text-amber-200'
  if (tone === 'error') return 'border-red-500/30 bg-red-500/10 text-red-200'
  if (tone === 'info') return 'border-sky-500/25 bg-sky-500/10 text-sky-200'
  return 'border-zinc-500/25 bg-zinc-500/10 text-zinc-200'
}

function pendingBuyEmptyMessage(meta?: any): string {
  const counts = meta?.execution_counts ?? {}
  const cancelled = Number(counts.cancelled ?? 0)
  const filled = Number(counts.filled ?? 0)
  const skipped = Number(counts.skipped ?? 0)
  const expired = Number(counts.expired ?? 0)
  const terminal = cancelled + filled + skipped + expired
  if (cancelled > 0 && terminal > 0) {
    return '今日執行池的 pending buys 已被風控取消；AI 候選清單仍顯示今日推薦候選，明早 morning setup / debate 會重新產生下一個交易日的 pending buys。'
  }
  if (terminal > 0) {
    return '今日執行池的 pending buys 已進入終態；AI 候選清單仍顯示今日推薦候選，明早 morning setup / debate 會重新產生下一個交易日的 pending buys。'
  }
  return 'pending buys 尚未產生；這是正常狀態，因為 pending buys 會在下一個交易日早上的 morning setup / debate 後產生。'
}

function SignalTable({ onSelectSymbol, selectedSymbol }: { onSelectSymbol?: (s: string) => void; selectedSymbol?: string | null }) {
  // T2 過濾後的掛單（非 raw recommendations）
  const { data: pbData, isLoading } = useQuery({
    queryKey: ['paper', 'pending-buys'],
    queryFn: () => paperApi.pendingBuys(),
    staleTime: 5 * 60_000,
  })
  const buys: any[] = Array.isArray(pbData?.pendingBuys) ? pbData.pendingBuys : []
  const showingDate = pbData?.date ?? ''
  const isStalePending = Boolean(pbData?.is_stale)
  const pendingState = pbData?.state
  const pendingMeta = pbData?.meta
  const pendingExecutionPolicy = pbData?.execution_policy
  const pendingSourceRecoDate = typeof pendingExecutionPolicy?.source_reco_date === 'string'
    ? pendingExecutionPolicy.source_reco_date
    : typeof pendingMeta?.source_reco_date === 'string'
      ? pendingMeta.source_reco_date
      : undefined

  const { data: recContextData } = useQuery({
    queryKey: ['recommendations', 'daily', 'pending-buy-context', pendingSourceRecoDate ?? 'latest'],
    queryFn: () => recommendationsApi.daily(pendingSourceRecoDate),
    enabled: buys.length > 0,
    staleTime: 5 * 60_000,
  })
  const recContextBySymbol = new Map(
    recommendationRowsFromPayload(recContextData).map((row: any) => [String(row?.symbol ?? '').trim(), row]),
  )

  // Quadrant filter
  const { data: qfData } = useQuery({
    queryKey: ['paper', 'quadrant-filter'],
    queryFn: () => paperApi.quadrantFilter(),
    staleTime: 5 * 60_000,
  })
  const qfList: any[] = Array.isArray(qfData?.filters) ? qfData.filters : Array.isArray(qfData) ? qfData : []
  const qfMap = new Map<string, { quadrant: string; action: string }>(
    qfList.map((q: any) => [q.symbol, { quadrant: q.quadrant, action: q.action }])
  )

  if (isLoading) return <div className="text-muted-foreground text-sm p-4 sv-num">Loading...</div>

  // 如果沒有 pending buys，fallback 到 daily recommendations
  if (!buys.length) {
    return (
      <div className="space-y-3">
        <FallbackRecommendations onSelectSymbol={onSelectSymbol} selectedSymbol={selectedSymbol} />
        <div className="px-1 text-xs text-muted-foreground/60 sv-num">{showingDate || 'today'} pending buys execution state</div>
        <PendingBuyStateBadges state={pendingState} stale={isStalePending} meta={pendingMeta} policy={pendingExecutionPolicy} />
        <div className="rounded-xl border border-muted/40 bg-background/40 p-3 text-xs text-muted-foreground">
          {pendingBuyEmptyMessage(pendingMeta)}
          <div className="mt-2 sv-num text-xs text-muted-foreground/70">
            Only L4 sparse final BUY rows enter pending buys; daily recommendations stay evidence until L4 selects them.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="px-1 text-xs text-muted-foreground/60 sv-num">{showingDate} · L4 sparse final-buy execution pool</div>
      <PendingBuyStateBadges state={pendingState} stale={isStalePending} meta={pendingMeta} policy={pendingExecutionPolicy} />
      {buys.map((b: any, idx: number) => {
        const qf = qfMap.get(b.symbol)
        const sourceRec = recContextBySymbol.get(String(b.symbol ?? '').trim())
        const executionBadge = formatPendingBuyExecutionBadge(b)
        const s12Badge = formatS12IntradayStructureBadge(b.watch_points)
        const partialRemaining = formatPartialFillRemaining(b.watch_points)
        const allocatorSummary = describeAllocatorDecision(b.watch_points)
        // 2026-04-22 fix: use backend b.reason (LLM 推薦理由) when present,
        // prefix with price line. Previously price line 100% replaced reason.
        // Also strip "⚠️ Signal Provenance ..." English debate-only preamble
        // that shouldn't be shown to end users (it's a hint for debate LLM).
        const priceLine = `限價 $${b.ml_entry_price} · 停損 $${b.ml_stop_loss} · TP1 $${b.ml_target1}`
        const stripProvenance = (s: string): string => {
          // Remove "⚠️ Signal Provenance (...): ... Judge on ... context." paragraph.
          // Preserves zh-TW LLM reason that follows (separated by blank line or period).
          return s.replace(/^[\s\S]*?Judge on fundamental merit\s*\/\s*industry context\.\s*/, '').trim()
        }
        const cleanReason = b.reason ? stripProvenance(b.reason) : ''
        const rec = {
          ...(sourceRec ?? {}),
          symbol: b.symbol ?? sourceRec?.symbol,
          name: b.name ?? sourceRec?.name,
          signal: b.signal ?? sourceRec?.signal,
          confidence: b.confidence ?? sourceRec?.confidence,
          current_price: b.ml_entry_price ?? sourceRec?.current_price,
          score: b.score ?? sourceRec?.score ?? b.score_v2?.finalScore ?? b.score_v2?.total ?? 0,
          sector: qf?.quadrant ?? sourceRec?.sector ?? '',
          reason: cleanReason ? `${priceLine}\n\n${cleanReason}` : priceLine,
          watch_points: b.watch_points ?? sourceRec?.watch_points ?? null,
          chip_score: sourceRec?.chip_score ?? b.chip_score ?? null,
          tech_score: sourceRec?.tech_score ?? b.tech_score ?? null,
          ml_score: sourceRec?.ml_score ?? b.ml_score ?? null,
          score_components: sourceRec?.score_components ?? b.score_components ?? b.score_v2 ?? buildScoreV2PayloadFromProjectedScores(sourceRec ?? b),
          alpha_context: b.alpha_context ?? sourceRec?.alpha_context ?? null,
          alpha_allocation: b.alpha_allocation ?? sourceRec?.alpha_allocation ?? null,
          ml_vote_summary: b.ml_vote_summary ?? sourceRec?.ml_vote_summary ?? null,
          prediction_forecast_data: b.prediction_forecast_data ?? sourceRec?.prediction_forecast_data ?? null,
          institutional_raw_today: b.institutional_raw_today ?? sourceRec?.institutional_raw_today ?? null,
          broker_top_flows_today: b.broker_top_flows_today ?? sourceRec?.broker_top_flows_today ?? null,
        }
        return (
          <div key={b.symbol} className={`relative ${selectedSymbol === b.symbol ? 'ring-1 ring-emerald-500/40 rounded-xl' : ''}`}>
            <RecommendationCard rec={rec} rank={idx + 1} />
            <div className="mx-2 -mt-2 mb-2 rounded-xl border border-muted/40 bg-background/45 px-4 py-3 text-[12px] leading-relaxed sv-num text-muted-foreground md:text-[13px]">
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                <span>execution: {executionBadge.label}</span>
                <span>debate: {b.debate_status ?? 'pending'}</span>
                <span>source: {b.source ?? 'morning_setup'}</span>
                <span className="break-all">policy: {pendingExecutionPolicy?.execution_pool_policy ?? 'l4_sparse_final_buy_only'}</span>
                <span>retry: {b.retry_count ?? 0}</span>
              </div>
              <div className="mt-2 text-[12px] text-muted-foreground/80 md:text-[13px]">
                base {b.original_entry ? `$${b.original_entry}` : 'N/A'} {'->'} limit {b.ml_entry_price ? `$${b.ml_entry_price}` : 'N/A'} | risk {(Number(b.risk_pct ?? 0) * 100).toFixed(1)}%
              </div>
              <div className={[
                'mt-2 rounded-lg border px-3 py-2',
                executionToneClass(executionBadge.tone),
              ].join(' ')}>
                <div className="text-[13px] font-semibold md:text-sm">盤中原因：{executionBadge.label}</div>
                <div className="mt-1 text-[12px] leading-5 text-muted-foreground/90 md:text-[13px]">
                  {executionBadge.description}{partialRemaining ? ` | ${partialRemaining}` : ''}
                </div>
              </div>
              {s12Badge && (
                <div className={[
                  'mt-2 rounded-lg border px-3 py-2',
                  executionToneClass(s12Badge.tone),
                ].join(' ')}>
                  <div className="text-[13px] font-semibold md:text-sm">S12 盤中結構：{s12Badge.label}</div>
                  <div className="mt-1 text-[12px] leading-5 text-muted-foreground/90 md:text-[13px]">{s12Badge.description}</div>
                </div>
              )}
              {allocatorSummary && (
                <div className={[
                  'mt-2 rounded-lg border px-3 py-2',
                  allocatorSummary.tone === 'ok'
                    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
                    : allocatorSummary.tone === 'warn'
                      ? 'border-amber-500/25 bg-amber-500/10 text-amber-200'
                      : 'border-zinc-500/25 bg-zinc-500/10 text-zinc-200',
                ].join(' ')}>
                  <div className="text-[13px] font-semibold md:text-sm">{allocatorSummary.title}</div>
                  <div className="mt-1 text-[12px] leading-5 text-muted-foreground/90 md:text-[13px]">{allocatorSummary.detail}</div>
                </div>
              )}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onSelectSymbol?.(b.symbol) }}
              className="absolute top-3 right-10 p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
              title="查看 K 線"
            >
              <Activity className="h-4 w-4" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

// Fallback: 無掛單時顯示最新 daily recommendations
function CandidateRecommendationColumn({
  title,
  subtitle,
  tone,
  rows,
  selectedSymbol,
  onSelectSymbol,
}: {
  title: string
  subtitle: string
  tone: 'buy' | 'potential'
  rows: any[]
  selectedSymbol?: string | null
  onSelectSymbol?: (s: string) => void
}) {
  const toneClass = tone === 'buy'
    ? {
        box: 'border-red-500/18 bg-red-500/[0.03]',
        label: 'text-red-300',
        badge: 'border-red-300/40 bg-red-500/12 text-red-100',
        ring: 'ring-red-500/40',
      }
    : {
        box: 'border-yellow-300/24 bg-yellow-300/[0.055]',
        label: 'text-yellow-100',
        badge: 'border-yellow-200/55 bg-yellow-300/20 text-yellow-50',
        ring: 'ring-yellow-300/45',
      }

  return (
    <div className={`space-y-2 rounded-[20px] border p-2 ${toneClass.box}`}>
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="min-w-0">
          <p className={`text-[13px] font-semibold ${toneClass.label}`}>{title}</p>
          <p className="text-[11px] leading-4 text-muted-foreground/75">{subtitle}</p>
        </div>
        <Badge variant="outline" className={`h-6 px-2 text-[11px] ${toneClass.badge}`}>
          {rows.length} 檔
        </Badge>
      </div>
      <div className="grid grid-cols-1 gap-3">
        {rows.map((r: any, idx: number) => (
          <div key={r.symbol ?? r.stock_id ?? idx} className={`relative ${selectedSymbol === r.symbol ? `ring-1 ${toneClass.ring} rounded-xl` : ''}`}>
            <RecommendationCard rec={r} rank={idx + 1} />
            <button
              onClick={(e) => { e.stopPropagation(); onSelectSymbol?.(r.symbol) }}
              className="absolute top-3 right-10 p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
              title="查看 K 線"
            >
              <Activity className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      {!rows.length && (
        <div className="rounded-lg border border-muted/30 bg-background/35 p-3 text-xs text-muted-foreground">
          今日沒有{title}候選。
        </div>
      )}
    </div>
  )
}

function FallbackRecommendations({ onSelectSymbol, selectedSymbol }: { onSelectSymbol?: (s: string) => void; selectedSymbol?: string | null }) {
  const { data: recData, isLoading } = useQuery({
    queryKey: ['recommendations', 'daily', 'latest'],
    queryFn: () => recommendationsApi.daily(),
    staleTime: 5 * 60_000,
  })
  const rows = recommendationRowsFromPayload(recData)
  const buyRecs = rows.filter(isBuySignalRecommendation)
  const potentialBuyRecs = rows.filter((row) => !isBuySignalRecommendation(row) && isPotentialBuyRecommendation(row))
  const strategyPortfolioHealth = recData?.strategy_portfolio_intelligence_health
  if (isLoading) return <div className="text-muted-foreground text-sm p-4 sv-num">Loading...</div>
  return (
    <div className="bot-fallback-recommendations space-y-3">
      <div className="px-1 text-[11px] text-muted-foreground/60 sv-num">{recData?.date} BUY SIGNAL 候選（與晨間概覽同源）</div>
      <div className="px-1 flex items-center gap-2 flex-wrap text-[11px] sv-num">
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-red-300/40 bg-red-500/12 text-red-100">
          BUY {buyRecs.length}
        </Badge>
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-yellow-200/55 bg-yellow-300/20 text-yellow-50">
          potential BUY {potentialBuyRecs.length}
        </Badge>
        <Badge variant="outline" className="h-6 px-2 text-[11px] border-sky-500/30 text-sky-300">
          source: daily recommendations
        </Badge>
        {strategyPortfolioHealth && (
          <Badge
            variant="outline"
            title={strategyPortfolioHealth.degraded_reason ?? strategyPortfolioHealth.source ?? 'L1.25 strategy portfolio intelligence'}
            className={[
              'h-6 px-2 text-[11px]',
              strategyPortfolioHealth.used_live_strategy_asset_metrics
                ? 'border-teal-500/30 bg-teal-500/10 text-teal-300'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-300',
            ].join(' ')}
          >
            L1.25 {strategyPortfolioHealth.portfolio_metric_status ?? 'unknown'} metrics {strategyPortfolioHealth.metric_count_max ?? 0}
          </Badge>
        )}
        <span className="text-muted-foreground/70">以 daily recommendations 的正式 BUY SIGNAL 為準；pending buys 仍由 L4 / debate / quote sanity 決定。</span>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <CandidateRecommendationColumn
          title="BUY 候選"
          subtitle="evening chain 正式買進訊號，可進入 L4 / pending-buy 決策。"
          tone="buy"
          rows={buyRecs}
          selectedSymbol={selectedSymbol}
          onSelectSymbol={onSelectSymbol}
        />
        <CandidateRecommendationColumn
          title="potential BUY 候選"
          subtitle="正期望值但 sparse allocation 未給權重，保留作次順位觀察。"
          tone="potential"
          rows={potentialBuyRecs}
          selectedSymbol={selectedSymbol}
          onSelectSymbol={onSelectSymbol}
        />
      </div>
    </div>
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

function summarizeOrderReason(order: any): string {
  const note = parseOrderNote(order?.note)
  if (note.reason) return String(note.reason)
  if (note.ml_entry) return `entry ${note.ml_entry} / stop ${note.ml_stop ?? '-'} / T1 ${note.ml_t1 ?? '-'} / T2 ${note.ml_t2 ?? '-'}`
  return typeof order?.note === 'string' ? order.note : '-'
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
  const { data, isLoading } = useQuery({
    queryKey: ['paper', 'positions'],
    queryFn: paperApi.positions,
    staleTime: 60_000,
    refetchInterval: isTWMarketOpen() ? 60_000 : 5 * 60_000,
    refetchOnWindowFocus: true,
  })
  const { data: ordersData } = useQuery({
    queryKey: ['paper', 'orders'],
    queryFn: () => paperApi.orders(200),
    staleTime: 60_000,
  })

  const positions = paperPositionsFromPayload(data)
  const summary = (data as any)?.summary
  const orders = paperOrdersFromPayload(ordersData)

  // 已實現損益 = 所有 sell orders 的 (proceeds - cost)
  const realizedPnl = orders
    .filter((o: any) => o.side === 'sell')
    .reduce((sum: number, o: any) => {
      const cost = (o.avg_cost ?? o.price) * o.shares
      const proceeds = o.total_cost ?? (o.price * o.shares)
      return sum + (proceeds - cost)
    }, 0)

  if (isLoading) return <div className="text-muted-foreground text-sm p-4">Loading...</div>
  if (!Array.isArray(positions) || positions.length === 0) {
    const latestOrder = orders[0]
    const latestIsSell = latestOrder?.side === 'sell'
    const latestIsBuy = latestOrder?.side === 'buy'
    const latestReason = summarizeOrderReason(latestOrder)

    return (
      <div className="p-4">
        <div className="grid gap-3 lg:grid-cols-[0.8fr_1.2fr]">
          <div className="rounded-xl border border-[#2b3a49] bg-[#070a10] p-4">
            <Wallet className="mb-3 h-8 w-8 text-[#d6a85f]/70" />
            <WorkstationPill tone={latestIsBuy ? 'error' : latestIsSell ? 'warn' : 'neutral'}>
              {latestIsSell ? '無持倉：最新紀錄為賣出' : latestIsBuy ? '資料需檢查' : '目前無持倉'}
            </WorkstationPill>
            <p className="mt-3 text-sm font-semibold text-[#e6edf3]">
              {latestIsSell
                ? `${latestOrder.symbol} 已於 ${formatTwOrderTime(latestOrder.created_at)} 出場`
                : latestIsBuy
                  ? `${latestOrder.symbol} 有買進紀錄但 position 為空`
                  : '目前沒有 open position'}
            </p>
            <p className="mt-2 text-xs leading-5 text-[#8b9bab]">
              {latestIsSell
                ? '持倉 API 仍正常；畫面為空是因為 D1 的 paper_positions 已無 shares > 0。'
                : latestIsBuy
                  ? '這代表 order 與 position 可能不同步，應檢查 paper_positions upsert / exit audit。'
                  : 'Bot 會在 pending buy 通過 quote sanity 與 execution guard 後建立持倉。'}
            </p>
            {summary && (
              <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg border border-[#2b3a49] bg-[#0d141d] p-2">
                  <p className="text-[#8b9bab]">現金</p>
                  <p className="sv-num text-[#e6edf3]">${fmt(summary.cash)}</p>
                </div>
                <div className="rounded-lg border border-[#2b3a49] bg-[#0d141d] p-2">
                  <p className="text-[#8b9bab]">總資產</p>
                  <p className="sv-num text-[#e6edf3]">${fmt(summary.total_value)}</p>
                </div>
              </div>
            )}
          </div>

          {latestOrder && (
            <div className="rounded-xl border border-[#3a3125] bg-[linear-gradient(135deg,#15130d,#0b1118)] p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <p className="sv-num text-[10px] normal-case text-[#d6a85f]/80">
                    latest order evidence
                  </p>
                  <h3 className="mt-1 text-sm font-semibold text-[#f2ead8]">最近交易證據</h3>
                </div>
                <WorkstationPill tone={latestIsSell ? 'warn' : 'info'}>{latestOrder.side}</WorkstationPill>
              </div>
              <div className="grid gap-2 text-xs sm:grid-cols-4">
                <div>
                  <p className="text-[#8b9bab]">標的</p>
                  <p className="sv-num text-[#e6edf3]">{latestOrder.symbol} {latestOrder.name}</p>
                </div>
                <div>
                  <p className="text-[#8b9bab]">股數</p>
                  <p className="sv-num text-[#e6edf3]">{fmt(latestOrder.shares)}</p>
                </div>
                <div>
                  <p className="text-[#8b9bab]">價格</p>
                  <p className="sv-num text-[#e6edf3]">${fmt(latestOrder.price, 1)}</p>
                </div>
                <div>
                  <p className="text-[#8b9bab]">時間</p>
                  <p className="sv-num text-[#e6edf3]">{formatTwOrderTime(latestOrder.created_at)}</p>
                </div>
              </div>
              <div className="mt-3 rounded-lg border border-[#2b3a49] bg-[#070a10] p-3">
                <p className="text-[10px] normal-case text-[#8b9bab]">原因 / note</p>
                <p className="mt-1 text-xs leading-5 text-[#c8d3df]">{latestReason}</p>
              </div>
            </div>
          )}

          {!latestOrder && (
            <div className="rounded-xl border border-[#2b3a49] bg-[#070a10] p-4 text-sm text-muted-foreground">
              交易紀錄也為空，代表目前 paper trading 尚未建立任何 open/closed order。
            </div>
          )}
        </div>
        {realizedPnl !== 0 && (
          <div className="mt-3 text-right text-xs text-muted-foreground">
            已實現損益粗估 <span className={pctClass(realizedPnl)}>{realizedPnl >= 0 ? '+' : ''}${fmt(Math.round(realizedPnl))}</span>
          </div>
        )}
      </div>
    )
  }

  // 計算未實現損益總計
  let totalUnrealized = 0
  let totalCostBasis = 0

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground text-xs normal-case border-b border-border">
              <th className="text-left p-2">股票</th>
              <th className="text-right p-2">張數</th>
              <th className="text-right p-2">買入價</th>
              <th className="text-right p-2">現價</th>
              <th className="text-right p-2">止損</th>
              <th className="text-right p-2">停利</th>
              <th className="text-right p-2">未實現</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p: any) => {
              const entry = p.avg_cost ?? p.entry_price ?? 0
              const current = p.current_price ?? entry
              const shares = p.shares ?? 0
              const lots = formatTaiwanShareLots(shares)
              const pnlPct = entry > 0 ? (current - entry) / entry : 0
              const pnlAmt = (current - entry) * shares
              const marketValue = current * shares
              const costBasis = entry * shares
              const s12HoldingDefense = formatS12HoldingDefenseBadge(p.s12_holding_defense)
              const lifecycleBadge = formatCanonicalTradeLifecycleBadge(p.canonical_trade_lifecycle)
              totalUnrealized += pnlAmt
              totalCostBasis += costBasis

              // 持有天數
              const daysHeld = p.entry_date
                ? Math.round((Date.now() - new Date(p.entry_date).getTime()) / 86400000)
                : null

              return (
                <tr key={p.symbol} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="p-2">
                    <div className="sv-num text-foreground">{p.symbol}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.name}
                      {daysHeld != null && <span className="ml-1 text-muted-foreground/60">({daysHeld}天)</span>}
                    </div>
                    {s12HoldingDefense && (
                      <div className={[
                        'mt-1 inline-flex max-w-[220px] rounded-full border px-2 py-0.5 text-[11px] leading-4',
                        executionToneClass(s12HoldingDefense.tone),
                      ].join(' ')} title={s12HoldingDefense.description}>
                        {s12HoldingDefense.label}
                      </div>
                    )}
                    {lifecycleBadge && (
                      <div className={[
                        'mt-1 inline-flex max-w-[240px] rounded-full border px-2 py-0.5 text-[11px] leading-4',
                        executionToneClass(lifecycleBadge.tone),
                      ].join(' ')} title={lifecycleBadge.description}>
                        {lifecycleBadge.label}
                      </div>
                    )}
                  </td>
                  <td className="p-2 text-right sv-num text-foreground/80">{lots}</td>
                  <td className="p-2 text-right sv-num text-foreground/80">${fmt(entry, 1)}</td>
                  <td className="p-2 text-right sv-num text-foreground/80">${fmt(current, 1)}</td>
                  <td className="p-2 text-right">
                    {p.trailing_stop ? (
                      <div className="sv-num text-red-400 text-xs">${fmt(p.trailing_stop, 1)}</div>
                    ) : p.initial_stop ? (
                      <div className="sv-num text-red-400/60 text-xs">${fmt(p.initial_stop, 1)}</div>
                    ) : <span className="text-muted-foreground/60">—</span>}
                  </td>
                  <td className="p-2 text-right">
                    {p.tp1_price && (
                      <div className={`sv-num text-xs ${p.tp1_hit ? 'text-muted-foreground line-through' : 'text-red-400'}`}>
                        T1 ${fmt(p.tp1_price, 1)}
                      </div>
                    )}
                    {p.tp2_price && (
                      <div className="sv-num text-xs text-red-300">T2 ${fmt(p.tp2_price, 1)}</div>
                    )}
                    {!p.tp1_price && !p.tp2_price && <span className="text-muted-foreground/60">—</span>}
                  </td>
                  <td className="p-2 text-right">
                    <div className={`sv-num ${pctClass(pnlPct)}`}>
                      {pnlPct >= 0 ? '+' : ''}{(pnlPct * 100).toFixed(2)}%
                    </div>
                    <div className={`text-xs sv-num ${pctClass(pnlAmt)}`}>
                      {pnlAmt >= 0 ? '+' : ''}${fmt(Math.round(pnlAmt))}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Summary bar */}
      <div className="flex items-center justify-between px-3 py-2 mt-2 bg-muted/40 rounded text-xs">
        <div className="flex gap-4">
          <span className="text-muted-foreground">持倉 <span className="text-foreground/80">{positions.length}</span> 檔</span>
          <span className="text-muted-foreground">成本 <span className="text-foreground/80">${fmt(Math.round(totalCostBasis))}</span></span>
        </div>
        <div className="flex gap-4">
          <span className="text-muted-foreground">未實現 <span className={pctClass(totalUnrealized)}>{totalUnrealized >= 0 ? '+' : ''}${fmt(Math.round(totalUnrealized))}</span></span>
          {summary && <span className="text-muted-foreground">現金 <span className="text-foreground/80">${fmt(Math.round(summary.cash))}</span></span>}
        </div>
      </div>
    </div>
  )
}

// ─── Trade History ──────────────────────────────────────────────────────────

function TradeHistory() {
  const { data, isLoading } = useQuery({
    queryKey: ['paper', 'orders'],
    queryFn: () => paperApi.orders(30),
    staleTime: 60_000,
  })

  const orders = paperOrdersFromPayload(data)
  if (isLoading) return <div className="text-muted-foreground text-sm p-4">Loading...</div>
  if (!orders.length) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Clock className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p>No trades yet</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground text-xs normal-case border-b border-border">
            <th className="text-left p-2">Time</th>
            <th className="text-left p-2">Symbol</th>
            <th className="text-left p-2">Side</th>
            <th className="text-right p-2">Shares</th>
            <th className="text-right p-2">Price</th>
            <th className="text-left p-2 hidden md:table-cell">Note</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o: any, i: number) => {
            const isBuy = o.side === 'buy'
            let noteDisplay = ''
            try {
              const n = typeof o.note === 'string' ? JSON.parse(o.note) : o.note
              if (n?.ml_entry) noteDisplay = `entry:${n.ml_entry} stop:${n.ml_stop}`
              else if (n?.reason) noteDisplay = n.reason
              else noteDisplay = o.note ?? ''
            } catch { noteDisplay = o.note ?? '' }
            return (
              <tr key={o.id ?? i} className="border-b border-border/50 hover:bg-muted/30">
                <td className="p-2 text-xs text-muted-foreground sv-num whitespace-nowrap">
                  {formatTwOrderTime(o.created_at)}
                </td>
                <td className="p-2">
                  <span className="sv-num text-foreground">{o.symbol}</span>
                  <span className="text-xs text-muted-foreground ml-1">{o.name}</span>
                </td>
                <td className="p-2">
                  <Badge className={isBuy
                    ? 'bg-red-500/20 text-red-400 border-red-500/30'
                    : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                  }>
                    {isBuy ? <ArrowUpRight className="w-3 h-3 mr-1" /> : <ArrowDownRight className="w-3 h-3 mr-1" />}
                    {o.side?.toUpperCase()}
                  </Badge>
                </td>
                <td className="p-2 text-right sv-num text-foreground/80">{fmt(o.shares)}</td>
                <td className="p-2 text-right sv-num text-foreground/80">${fmt(o.price, 1)}</td>
                <td className="p-2 text-xs text-muted-foreground hidden md:table-cell max-w-[200px] truncate">
                  {noteDisplay}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Bot Status（Live Scheduler Runs）────────────────────────────────────────

function BotStatusPanel() {
  const { data: risk } = useQuery({
    queryKey: ['market', 'risk'],
    queryFn: marketApi.risk,
    staleTime: 5 * 60_000,
  })

  const riskScore = risk?.risk_score ?? risk?.riskScore ?? 50
  const riskLevel = risk?.risk_level ?? risk?.riskLevel ?? 'medium'
  const riskColor = riskScore > 70 ? 'text-red-400' : riskScore > 40 ? 'text-amber-400' : 'text-emerald-400'

  return (
    <div className="space-y-4">
      {/* Market Risk */}
      <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
        <div className="flex items-center gap-2">
          {riskScore > 70 ? <ShieldAlert className="w-4 h-4 text-red-400" /> : <ShieldCheck className="w-4 h-4 text-emerald-400" />}
          <span className="text-sm text-foreground/80">Market Risk</span>
        </div>
        <div className="text-right">
          <span className={`sv-num font-semibold ${riskColor}`}>{riskScore}</span>
          <span className="text-muted-foreground text-xs ml-1">/ 100</span>
          <Badge className="ml-2 bg-muted/50 text-muted-foreground border-border/30 text-xs">{riskLevel}</Badge>
        </div>
      </div>

      {/* 排程執行細節集中在排程節奏頁。 */}
      <GateCalibrationPanel />

      <div className="text-center py-4 text-muted-foreground text-sm">
        <p>排程紀錄已移到 <a href="/scheduler" className="text-sky-400 hover:underline">排程節奏</a></p>
      </div>
    </div>
  )
}

// ─── Performance Chart（Benchmark overlay + Period selector）────────────────

function GateCalibrationPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['paper', 'gate-calibration', 7],
    queryFn: () => paperApi.gateCalibration(7),
    staleTime: 60_000,
    refetchInterval: isTWMarketOpen() ? 60_000 : false,
  })

  const rows: any[] = Array.isArray(data?.rows) ? data.rows : []
  const total = data?.total_events ?? 0
  const deferred = data?.deferred_events ?? 0
  const filled = data?.filled_events ?? 0
  const skipped = data?.skipped_events ?? 0
  const deferRate = total > 0 ? deferred / total : 0
  const topRows = rows.slice(0, 5)

  function describeGate(row: any): string {
    const raw = formatExecutionEvent({
      kind: 'execution',
      status: row.status ?? 'unknown',
      reason: row.reason ?? 'unknown',
      detail: null,
    })
    return explainExecutionEvent(raw) ?? `${row.status}: ${row.reason}`
  }

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-foreground/80">進場卡控校準</div>
          <div className="mt-1 text-[11px] text-muted-foreground/75">
            近 7 天統計 execution gate 是否過度保守；這裡看原因分布，不再用感覺判斷。
          </div>
        </div>
        <Badge variant="outline" className={`h-6 text-[10px] ${deferRate > 0.8 ? 'border-amber-500/40 text-amber-300' : 'border-emerald-500/30 text-emerald-300'}`}>
          defer {(deferRate * 100).toFixed(0)}%
        </Badge>
      </div>

      {isLoading ? (
        <div className="mt-3 text-xs text-muted-foreground/60">Loading...</div>
      ) : total === 0 ? (
        <div className="mt-3 text-xs text-muted-foreground/60">近 7 天尚無 execution event，可等下一輪 intraday 後觀察。</div>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            {[
              { label: 'filled', value: filled, cls: 'text-emerald-300' },
              { label: 'deferred', value: deferred, cls: 'text-amber-300' },
              { label: 'skipped', value: skipped, cls: 'text-zinc-300' },
            ].map((item) => (
              <div key={item.label} className="rounded-md bg-black/20 px-2 py-1.5">
                <div className="text-[10px] normal-case text-muted-foreground/60">{item.label}</div>
                <div className={`sv-num text-sm ${item.cls}`}>{item.value}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 space-y-1.5">
            {topRows.map((row, idx) => (
              <div key={`${row.status}-${row.reason}-${idx}`} className="flex items-start justify-between gap-3 text-[11px]">
                <span className="leading-relaxed text-muted-foreground/80">{describeGate(row)}</span>
                <span className="shrink-0 sv-num text-foreground/70">x{row.count}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function PerformanceChart() {
  const { data, isLoading } = useQuery({
    queryKey: ['paper', 'pnl'],
    queryFn: paperApi.pnl,
    staleTime: 5 * 60_000,
  })
  const { data: ordersData } = useQuery({
    queryKey: ['paper', 'orders', 'performance-chart'],
    queryFn: () => paperApi.orders(200),
    staleTime: 60_000,
  })
  const { data: pendingData } = useQuery({
    queryKey: ['paper', 'pending-buys', 'performance-chart'],
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
    />
  )
}

// ─── Backtest Card (skeleton) ────────────────────────────────────────────────

function BacktestCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['backtest', 'latest'],
    queryFn: backtestApi.latest,
    staleTime: 30 * 60_000,
  })
  const { data: mcData } = useQuery({
    queryKey: ['backtest', 'monte-carlo'],
    queryFn: backtestApi.monteCarlo,
    staleTime: 30 * 60_000,
  })
  const { data: pboData } = useQuery({
    queryKey: ['backtest', 'pbo'],
    queryFn: backtestApi.pbo,
    staleTime: 30 * 60_000,
  })

  if (isLoading) {
    return (
      <Card className="bg-card border-border backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Scale className="w-4 h-4" /> Backtest
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground/60 text-xs">Loading...</p>
        </CardContent>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card className="bg-card border-border backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Scale className="w-4 h-4" /> Backtest
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground/60 text-xs">尚無回測結果</p>
        </CardContent>
      </Card>
    )
  }

  const metrics = [
    { label: 'Sharpe', value: data.sharpe != null ? data.sharpe.toFixed(2) : '-', good: (data.sharpe ?? 0) > 1, hint: '每承擔一單位波動換到多少超額報酬；>1 才算有基本效率。' },
    { label: 'Sortino', value: data.sortino != null ? data.sortino.toFixed(2) : '-', good: (data.sortino ?? 0) > 1.5, hint: '只看下跌波動的風險調整報酬；比 Sharpe 更貼近實際痛感。' },
    { label: 'MDD', value: data.max_drawdown != null ? `${(data.max_drawdown * 100).toFixed(1)}%` : '-', good: (data.max_drawdown ?? 1) < 0.15, hint: '歷史最大資金回撤；代表策略最壞連續虧損壓力。' },
    { label: 'Win Rate', value: data.win_rate != null ? `${(data.win_rate * 100).toFixed(1)}%` : '-', good: (data.win_rate ?? 0) > 0.5, hint: '交易勝率；要搭配 PF/Expectancy 看，單獨高不一定好。' },
    { label: 'PF', value: data.profit_factor != null ? data.profit_factor.toFixed(2) : '-', good: (data.profit_factor ?? 0) > 1.5, hint: '總獲利 / 總虧損；>1 表示有正收益，>1.5 較健康。' },
    { label: 'CAGR', value: data.cagr != null ? `${(data.cagr * 100).toFixed(1)}%` : '-', good: (data.cagr ?? 0) > 0, hint: '年化複合報酬；用來比較不同期間策略。' },
    { label: 'Calmar', value: data.calmar != null ? data.calmar.toFixed(2) : '-', good: (data.calmar ?? 0) > 1, hint: 'CAGR / MDD；衡量報酬是否值得承受最大回撤。' },
    { label: 'Trades', value: data.total_trades ?? '-', good: true, hint: '樣本數；太少時 Sharpe、勝率、PF 都容易失真。' },
    { label: 'Expectancy', value: data.expectancy != null ? data.expectancy.toFixed(4) : '-', good: (data.expectancy ?? 0) > 0, hint: '每筆交易平均期望值；>0 才代表長期下注有正期望。' },
  ]

  // MC MDD verdict badge
  const mcVerdict = mcData?.go_live_verdict
  const mcBadge = mcVerdict === 'PASS' ? 'bg-emerald-500/20 text-emerald-400'
    : mcVerdict === 'CAUTION' ? 'bg-yellow-500/20 text-yellow-400'
    : mcVerdict === 'FAIL' ? 'bg-red-500/20 text-red-400' : ''

  // PBO verdict badge
  const pboVerdict = pboData?.go_live_verdict
  const pboBadge = pboVerdict === 'PASS' ? 'bg-emerald-500/20 text-emerald-400'
    : pboVerdict === 'FAIL' ? 'bg-red-500/20 text-red-400' : ''

  return (
    <Card className="bg-card border-border backdrop-blur-sm">
      <CardHeader className="py-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Scale className="w-4 h-4" /> Backtest
          <span className="text-muted-foreground/60 text-xs ml-auto">{data.run_date} · {data.strategy}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        <div className="grid grid-cols-3 gap-3">
          {metrics.map(m => (
            <div key={m.label} className="text-center" title={m.hint}>
              <div className="text-muted-foreground text-[10px] normal-case">{m.label}</div>
              <div className={`text-sm sv-num mt-0.5 ${m.good ? 'text-emerald-400' : 'text-red-400'}`}>
                {m.value}
              </div>
            </div>
            ))}
        </div>
        <div className="mt-3 rounded-md border border-white/[0.06] bg-white/[0.03] p-2 text-[10px] leading-relaxed text-muted-foreground/80">
          <div className="mb-1 font-medium text-foreground/70">怎麼讀這張卡</div>
          <div>先看 MDD / Calmar 判斷風險是否可承受，再看 Sharpe / Sortino 判斷報酬品質，最後用 PF / Expectancy 確認每筆交易是否真的有正期望；Trades 太少時所有結論都只能當觀察，不應直接 go-live。</div>
        </div>
        {/* Weekly Validation split: PBO credibility, MC tail risk, backtest consistency */}
        {(mcVerdict || pboVerdict) && (
          <div className="mt-3 grid gap-2 border-t border-white/[0.06] pt-2 md:grid-cols-3">
            <div className="rounded-md border border-white/[0.06] bg-white/[0.03] p-2">
              <div className="text-[10px] normal-case text-muted-foreground">PBO alpha credibility</div>
              <div className={`mt-1 inline-flex px-2 py-0.5 text-[10px] sv-num ${pboBadge || 'bg-white/5 text-muted-foreground'}`}>
                PBO {pboData?.pbo != null ? `${(pboData.pbo * 100).toFixed(0)}%` : '-'} {pboVerdict ?? 'N/A'}
              </div>
            </div>
            <div className="rounded-md border border-white/[0.06] bg-white/[0.03] p-2">
              <div className="text-[10px] normal-case text-muted-foreground">MC tail risk</div>
              <div className={`mt-1 inline-flex px-2 py-0.5 text-[10px] sv-num ${mcBadge || 'bg-white/5 text-muted-foreground'}`}>
                95th {mcData?.mdd_95th != null ? `${(mcData.mdd_95th * 100).toFixed(1)}%` : '-'} {mcVerdict ?? 'N/A'}
              </div>
              {String((mcData as any)?.raw_distribution ?? '').includes('LOW_SAMPLE_TAIL_RISK') && (
                <div className="mt-1 text-[10px] text-amber-300">LOW_SAMPLE_TAIL_RISK</div>
              )}
            </div>
            <div className="rounded-md border border-white/[0.06] bg-white/[0.03] p-2">
              <div className="text-[10px] normal-case text-muted-foreground">Backtest consistency</div>
              <div className="mt-1 text-[10px] sv-num text-slate-200">
                MDD {data.max_drawdown != null ? `${(data.max_drawdown * 100).toFixed(1)}%` : '-'} / Trades {data.total_trades ?? '-'}
              </div>
            </div>
          </div>
        )}
        {data.timerange && (
          <div className="text-muted-foreground/60 text-[10px] mt-2 text-center">{data.timerange}</div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Adaptive Params Card ────────────────────────────────────────────────────

function AdaptiveParamsCard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['adaptive', 'params'],
    queryFn: adaptiveApi.get,
    staleTime: 5 * 60_000,
  })

  if (isLoading) {
    return (
      <Card className="bg-card border-border backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Cpu className="w-4 h-4" /> Adaptive Params
          </CardTitle>
        </CardHeader>
        <CardContent><p className="text-muted-foreground/60 text-xs">Loading...</p></CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className="bg-card border-border backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Cpu className="w-4 h-4" /> Adaptive Params
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-red-400 text-xs">載入失敗：{error instanceof Error ? error.message : 'unknown error'}</p>
        </CardContent>
      </Card>
    )
  }

  if (!data || !data.computed_at) {
    return (
      <Card className="bg-card border-border backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Cpu className="w-4 h-4" /> Adaptive Params
          </CardTitle>
        </CardHeader>
        <CardContent><p className="text-muted-foreground/60 text-xs">尚未計算（今日 16:05 後可用）</p></CardContent>
      </Card>
    )
  }

  const confThreshold = data.confidence_threshold ?? 0.60
  const riskScore     = data.market_risk_score ?? 50
  const acc30d        = data.recent_accuracy_30d ?? 0
  const banditMult    = data.bandit_max_mult ?? 2.5
  const forceExplore  = data.bandit_force_explore ?? false
  const slOverride    = data.sl_tp_override
  const version       = data.version ?? 0
  const computedAt    = data.computed_at ? data.computed_at.slice(0, 16).replace('T', ' ') : '-'

  const confColor = confThreshold > 0.65 ? 'text-amber-400' : confThreshold < 0.58 ? 'text-emerald-400' : 'text-foreground/80'

  return (
    <Card className="bg-card border-border backdrop-blur-sm">
      <CardHeader className="py-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Cpu className="w-4 h-4" /> Adaptive Params
          <span className="text-muted-foreground/60 text-xs ml-auto">v{version} · {computedAt}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2">
            <div className="text-muted-foreground text-[10px] normal-case">信心門檻</div>
            <div className={`text-sm sv-num mt-0.5 ${confColor}`}>{confThreshold.toFixed(2)}</div>
          </div>
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2">
            <div className="text-muted-foreground text-[10px] normal-case">Risk Score</div>
            <div className={`text-sm sv-num mt-0.5 ${riskScore > 70 ? 'text-red-400' : riskScore > 40 ? 'text-amber-400' : 'text-emerald-400'}`}>{riskScore}</div>
          </div>
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2">
            <div className="text-muted-foreground text-[10px] normal-case">30d 準確率</div>
            <div className={`text-sm sv-num mt-0.5 ${acc30d >= 0.6 ? 'text-emerald-400' : 'text-amber-400'}`}>{(acc30d * 100).toFixed(0)}%</div>
          </div>
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2">
            <div className="text-muted-foreground text-[10px] normal-case">Bandit</div>
            <div className={`text-sm sv-num mt-0.5 ${forceExplore ? 'text-red-400' : 'text-foreground/80'}`}>
              {forceExplore ? '強制探索' : `×${banditMult.toFixed(1)}`}
            </div>
          </div>
        </div>
        {slOverride && (
          <div className="text-xs text-amber-400/80 bg-amber-500/5 border border-amber-500/20 rounded px-2 py-1">
            SL +{slOverride.sl_add} ATR / TP +{slOverride.tp_add} ATR（高風險 regime 加寬）
          </div>
        )}
      </CardContent>
    </Card>
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

  if (!isAuthenticated) {
    return (
      <AppShell>
        <div className="flex min-h-full items-center justify-center p-4 lg:p-5">
          <div className="w-full max-w-4xl space-y-3">
            <WorkstationPageTitle
              kicker="Paper trading companion"
              title="模擬交易室"
              description="登入後查看待買清單、辯論結果、成交、滑價、停利停損與資產變化；未登入時只顯示預覽，不讀交易資料。"
              action={<WorkstationPill tone="warn">需要登入</WorkstationPill>}
            />
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
                caption="推薦只是候選，真正進場前還要過 debate、T2 與 quote sanity。"
                tone="info"
              />
            </div>
            <div className="rounded-2xl border border-[#3a3125] bg-[#171714]/90 p-6 text-center">
              <Bot className="mx-auto h-12 w-12 text-[#d6a85f]/80" />
              <p className="mt-3 text-sm text-[#b9b1a1]">請先登入以查看模擬交易室</p>
              <button onClick={login} className="mt-4 rounded-full border border-[#d6a85f]/35 bg-[#d6a85f]/90 px-4 py-2 text-sm text-[#171714] hover:bg-[#f1c16f]">
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
      <div className="p-4 lg:p-5 space-y-3 text-sm">
        <WorkstationPageTitle
          kicker="Paper trading companion"
          title="模擬交易室"
          description="把待買清單、辯論結果、成交、滑價、停利停損與資產變化放在同一張交易桌；資料來源與交易邏輯維持原 API。"
          action={
            <div className="flex flex-wrap gap-2">
              <WorkstationPill tone="warn">模擬交易</WorkstationPill>
              <WorkstationPill tone={isTWMarketOpen() ? 'ok' : 'neutral'}>{isTWMarketOpen() ? '台股盤中' : '台股休息'}</WorkstationPill>
            </div>
          }
        />

        <WorkstationPanel title="資產摘要" kicker="cash, settlement, pnl">
          <div className="px-4 pb-2 pt-3">
            <PortfolioSummary />
          </div>
        </WorkstationPanel>

        <WorkstationPanel title="持倉與風險" kicker="open risk and holdings">
          <PositionsTable />
        </WorkstationPanel>

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,0.85fr)_minmax(420px,1.15fr)]">
          <WorkstationPanel title="資產曲線" kicker="paper trading performance">
            <div className="px-3 pb-2 pt-1">
              <PerformanceChart />
            </div>
          </WorkstationPanel>
          <BotThemeFlowPanel />
        </div>

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.5fr)_minmax(380px,1fr)]">
          <WorkstationPanel
            title="推薦候選"
            kicker="daily trading candidates"
            action={<WorkstationPill tone="info">latest</WorkstationPill>}
          >
            <div className="border-b border-[#263247] px-4 pb-2 pt-3">
              <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 sv-num normal-case">
                <TrendingUp className="w-3.5 h-3.5" /> 推薦候選
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/70">與晨間概覽同源，點開牌卡查看個股資訊與交易計劃。</p>
            </div>
            <div className="p-2">
              <SignalTable onSelectSymbol={setSelectedSymbol} selectedSymbol={selectedSymbol} />
            </div>
          </WorkstationPanel>

          <WorkstationPanel title="交易紀錄" kicker="orders and fills audit">
            <TradeHistory />
          </WorkstationPanel>
        </div>

        {/* K-Line Dialog (popup on stock click) */}
        <Dialog open={!!selectedStockId} onOpenChange={(open) => { if (!open) setSelectedSymbol(null) }}>
          <DialogContent className="max-w-4xl bg-card border-border">
            <DialogHeader>
              <DialogTitle className="text-sm sv-num">{selectedSymbol} K 線圖</DialogTitle>
            </DialogHeader>
            {selectedStockId && <CandlestickChart stockId={selectedStockId} />}
          </DialogContent>
        </Dialog>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <BacktestCard />
          <AdaptiveParamsCard />
        </div>

        <details className="group">
          <summary className="flex items-center gap-2 border border-[#263247] bg-[#070a10] px-4 py-2.5 cursor-pointer hover:border-amber-300/30 transition-colors text-xs font-medium text-muted-foreground select-none">
            <Bot className="w-3.5 h-3.5" />
            <span className="sv-num normal-case">Bot 狀態與排程紀錄</span>
            <svg className="w-3.5 h-3.5 ml-auto transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M19 9l-7 7-7-7" /></svg>
          </summary>
          <WorkstationPanel title="Bot 狀態" kicker="scheduler runs and market risk" className="mt-2">
            <div className="p-3">
              <BotStatusPanel />
            </div>
          </WorkstationPanel>
        </details>

      </div>
    </AppShell>
  )
}
