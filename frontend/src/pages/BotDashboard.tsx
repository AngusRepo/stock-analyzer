/**
 * BotDashboard — Auto Trade Bot 專頁
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
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { BotThemeFlowPanel } from '@/components/DailyRecommendationPanel'
import { AI_TOP_PICK_EXPLANATION, RecommendationCardClean as RecommendationCard } from '@/components/RecommendationCardClean'
import CandlestickChart from '@/components/CandlestickChart'
import AppShell from '@/components/AppShell'
import { Input } from '@/components/ui/input'
import { stocksApi } from '@/lib/api'
import { explainExecutionEvent, formatExecutionEvent } from '@/lib/executionEvent'
import { WorkstationCatCard, WorkstationPageTitle, WorkstationPanel, WorkstationPill } from '@/components/workstation/WorkstationChrome'
import { splitRecommendationLanes } from '@/lib/recommendationLanes'

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
  if (s.includes('STRONG_BUY')) return <Badge className="border text-[10px] px-1.5 py-0" style={{ background: 'rgba(178,34,34,0.15)', color: '#B22222', borderColor: 'rgba(178,34,34,0.3)' }}>STRONG BUY</Badge>
  if (s.includes('BUY'))        return <Badge className="border text-[10px] px-1.5 py-0" style={{ background: 'rgba(178,34,34,0.15)', color: '#B22222', borderColor: 'rgba(178,34,34,0.3)' }}>BUY</Badge>
  if (s.includes('STRONG_SELL'))return <Badge className="border text-[10px] px-1.5 py-0" style={{ background: 'rgba(34,139,34,0.15)', color: '#228B22', borderColor: 'rgba(34,139,34,0.3)' }}>STRONG SELL</Badge>
  if (s.includes('SELL'))       return <Badge className="border text-[10px] px-1.5 py-0" style={{ background: 'rgba(34,139,34,0.15)', color: '#228B22', borderColor: 'rgba(34,139,34,0.3)' }}>SELL</Badge>
  if (s.includes('NO_SIGNAL'))  return <Badge className="bg-muted/50 text-muted-foreground border-border/30 text-[10px] px-1.5 py-0">—</Badge>
  return <Badge className="bg-muted/50 text-muted-foreground border-border/30 text-[10px] px-1.5 py-0">HOLD</Badge>
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
      <text x={cx} y={cy - 2} textAnchor="middle" fill={color} fontSize={size * 0.22} fontFamily="monospace" fontWeight="bold">
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
  const { data: positions } = useQuery({ queryKey: ['paper', 'positions'], queryFn: paperApi.positions, staleTime: 30_000, refetchInterval: isTWMarketOpen() ? 60_000 : false })
  const { data: pnlData } = useQuery({ queryKey: ['paper', 'pnl'], queryFn: paperApi.pnl, staleTime: 5 * 60_000 })
  // 歷史已實現損益（Server-side 全歷史計算）
  const { data: realizedData } = useQuery({ queryKey: ['paper', 'realized'], queryFn: paperApi.realized, staleTime: 5 * 60_000 })
  const totalRealizedPnl = realizedData?.totalRealizedPnl ?? 0
  const sellOrderCount = realizedData?.tradeCount ?? 0

  const acc = account?.account ?? account ?? {}
  const positionSummary = positions?.summary ?? null
  const cash = positionSummary?.cash ?? acc?.cash ?? 0
  const initialCash = acc?.initial_cash ?? positionSummary?.initial_cash ?? 1_000_000
  const posArr = positions?.positions ?? positions ?? []
  const positionValue = Array.isArray(posArr)
    ? posArr.reduce((s: number, p: any) => s + (p.current_price ?? p.avg_cost ?? 0) * (p.shares ?? 0), 0)
    : 0
  const netUnsettledSettlement = positionSummary?.net_unsettled_settlement ?? 0
  const totalAssets = positionSummary?.total_value ?? (cash + positionValue + netUnsettledSettlement)
  const totalReturn = initialCash > 0 ? (totalAssets - initialCash) / initialCash : 0

  // PnL snapshots for advanced metrics
  const snapshots: any[] = pnlData?.snapshots ?? pnlData?.daily ?? []
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
        <div className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-1">總資產</div>
        <div className="text-3xl font-mono font-bold text-foreground leading-tight">${fmt(totalAssets)}</div>
        <span className={`text-sm font-mono font-semibold ${pctClass(totalReturn)}`}>{totalReturn >= 0 ? '+' : ''}{(totalReturn * 100).toFixed(2)}%</span>
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
        { label: 'MDD', val: `-${(maxDrawdown * 100).toFixed(1)}%`, sub: '', cls: maxDrawdown > 0.1 ? 'text-red-400' : maxDrawdown > 0.05 ? 'text-amber-400' : 'text-emerald-400' },
        { label: 'Sharpe', val: sharpe30d != null ? sharpe30d.toFixed(2) : '-', sub: '30d', cls: sharpe30d != null ? (sharpe30d > 1 ? 'text-emerald-400' : sharpe30d > 0 ? 'text-foreground' : 'text-red-400') : 'text-muted-foreground' },
      ].map(m => (
        <div key={m.label}>
          <div className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-1">{m.label}</div>
          <div className={`text-xl font-mono font-semibold leading-tight ${m.cls}`}>{m.val}</div>
          <span className="text-[11px] text-muted-foreground/60">{m.sub || '\u00A0'}</span>
        </div>
      ))}
      {/* vs 0050 */}
      <div>
        <div className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-1">vs 0050</div>
        <div className="flex gap-4 mt-0.5">
          {[{ l: '週', w: beatsBenchmark(retWeek, bmWeek) }, { l: '月', w: beatsBenchmark(retMonth, bmMonth) }, { l: '季', w: beatsBenchmark(retQuarter, bmQuarter) }].map(b => (
            <div key={b.l} className="text-center"><div className="text-[11px] text-muted-foreground">{b.l}</div><WinLossBadge win={b.w} /></div>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground/60">{'\u00A0'}</span>
      </div>
      {/* 近期報酬 */}
      <div>
        <div className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-1">近期報酬</div>
        <div className="flex gap-5 mt-0.5">
          {[{ l: '週', v: retWeek }, { l: '月', v: retMonth }, { l: '季', v: retQuarter }].map(({ l, v }) => (
            <div key={l} className="text-center">
              <div className="text-[11px] text-muted-foreground">{l}</div>
              <div className={`text-base font-mono font-semibold ${v != null ? pctClass(v) : 'text-muted-foreground/60'}`}>{v != null ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '-'}</div>
            </div>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground/60">{'\u00A0'}</span>
      </div>
    </div>
  )
}

// ─── Today's ML Signals ─────────────────────────────────────────────────────

function PendingBuyStateBadges({ state, stale, meta }: { state?: any; stale?: boolean; meta?: any }) {
  const execution = state?.execution_counts ?? {}
  const events = Array.isArray(meta?.execution_events) ? meta.execution_events.slice(-3) : []
  const stateClass =
    state?.state === 'ready_to_execute' ? 'border-emerald-500/30 text-emerald-400'
      : state?.state === 'debate_pending' ? 'border-sky-500/30 text-sky-400'
        : state?.state === 'filled' ? 'border-teal-500/30 text-teal-300'
          : state?.state === 'skipped' || state?.state === 'expired' || state?.state === 'closed' ? 'border-zinc-500/30 text-zinc-300'
            : state?.state === 'error' || state?.state === 'halted' ? 'border-red-500/40 text-red-300'
              : state?.state === 'base_ready' ? 'border-amber-500/30 text-amber-300'
                : 'border-muted-foreground/30 text-muted-foreground'

  return (
    <div className="px-1 flex items-center gap-2 flex-wrap text-[10px] font-mono">
      <Badge variant="outline" className={`h-5 px-1.5 text-[9px] ${stateClass}`}>
        {state?.label ?? 'pending buys'}
      </Badge>
      <Badge variant="outline" className="h-5 px-1.5 text-[9px] border-emerald-500/30 text-emerald-400">
        active {state?.active_count ?? 0}/{state?.total_count ?? 0}
      </Badge>
      {(execution.filled ?? 0) > 0 && (
        <Badge variant="outline" className="h-5 px-1.5 text-[9px] border-cyan-500/30 text-cyan-300">
          filled {execution.filled}
        </Badge>
      )}
      {(execution.skipped ?? 0) > 0 && (
        <Badge variant="outline" className="h-5 px-1.5 text-[9px] border-amber-500/30 text-amber-300">
          skipped {execution.skipped}
        </Badge>
      )}
      {(execution.cancelled ?? 0) > 0 && (
        <Badge variant="outline" className="h-5 px-1.5 text-[9px] border-zinc-500/30 text-zinc-300">
          cancelled {execution.cancelled}
        </Badge>
      )}
      {(execution.expired ?? 0) > 0 && (
        <Badge variant="outline" className="h-5 px-1.5 text-[9px] border-zinc-500/30 text-zinc-400">
          expired {execution.expired}
        </Badge>
      )}
      {stale && (
        <Badge variant="outline" className="h-5 px-1.5 text-[9px] border-amber-500/40 text-amber-400">
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

function pendingBuyEmptyMessage(meta?: any): string {
  const counts = meta?.execution_counts ?? {}
  const cancelled = Number(counts.cancelled ?? 0)
  const filled = Number(counts.filled ?? 0)
  const skipped = Number(counts.skipped ?? 0)
  const expired = Number(counts.expired ?? 0)
  const terminal = cancelled + filled + skipped + expired
  if (cancelled > 0 && terminal > 0) {
    return '今日執行池的 pending buys 已被風控取消；AI Top Picks 仍顯示今日推薦候選，明早 morning setup / debate 會重新產生下一個交易日的 pending buys。'
  }
  if (terminal > 0) {
    return '今日執行池的 pending buys 已進入終態；AI Top Picks 仍顯示今日推薦候選，明早 morning setup / debate 會重新產生下一個交易日的 pending buys。'
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

  if (isLoading) return <div className="text-muted-foreground text-sm p-4 font-mono">Loading...</div>

  // 如果沒有 pending buys，fallback 到 daily recommendations
  if (!buys.length) {
    return (
      <div className="space-y-3">
        <FallbackRecommendations onSelectSymbol={onSelectSymbol} selectedSymbol={selectedSymbol} />
        <div className="px-1 text-[10px] text-muted-foreground/60 font-mono">{showingDate || 'today'} pending buys execution state</div>
        <PendingBuyStateBadges state={pendingState} stale={isStalePending} meta={pendingMeta} />
        <div className="rounded-xl border border-muted/40 bg-background/40 p-3 text-xs text-muted-foreground">
          {pendingBuyEmptyMessage(pendingMeta)}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="px-1 text-[10px] text-muted-foreground/60 font-mono">{showingDate} · T2 篩選後掛單</div>
      <PendingBuyStateBadges state={pendingState} stale={isStalePending} meta={pendingMeta} />
      {buys.map((b: any, idx: number) => {
        const qf = qfMap.get(b.symbol)
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
          symbol: b.symbol, name: b.name, signal: b.signal, confidence: b.confidence,
          current_price: b.ml_entry_price, score: b.score ?? 0, sector: qf?.quadrant ?? '',
          reason: cleanReason ? `${priceLine}\n\n${cleanReason}` : priceLine,
          watch_points: b.watch_points ?? null,
          chip_score: b.chip_score ?? null, tech_score: b.tech_score ?? null, ml_score: b.ml_score ?? null,
          alpha_context: b.alpha_context ?? null,
          alpha_allocation: b.alpha_allocation ?? null,
          ml_vote_summary: b.ml_vote_summary ?? null,
          prediction_forecast_data: b.prediction_forecast_data ?? null,
        }
        return (
          <div key={b.symbol} className={`relative ${selectedSymbol === b.symbol ? 'ring-1 ring-emerald-500/40 rounded-xl' : ''}`}>
            <RecommendationCard rec={rec} rank={idx + 1} />
            <div className="mx-2 -mt-2 mb-2 rounded-lg border border-muted/40 bg-background/40 px-3 py-2 text-[10px] font-mono text-muted-foreground">
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                <span>execution: {b.execution_status ?? 'pending'}</span>
                <span>debate: {b.debate_status ?? 'pending'}</span>
                <span>source: {b.source ?? 'morning_setup'}</span>
                <span>retry: {b.retry_count ?? 0}</span>
              </div>
              <div className="mt-1 text-muted-foreground/70">
                base {b.original_entry ? `$${b.original_entry}` : 'N/A'} {'->'} limit {b.ml_entry_price ? `$${b.ml_entry_price}` : 'N/A'} | risk {(Number(b.risk_pct ?? 0) * 100).toFixed(1)}%
              </div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onSelectSymbol?.(b.symbol) }}
              className="absolute top-2 right-10 p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
              title="查看 K 線"
            >
              <Activity className="w-3.5 h-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

// Fallback: 無掛單時顯示最新 daily recommendations
function FallbackRecommendations({ onSelectSymbol, selectedSymbol }: { onSelectSymbol?: (s: string) => void; selectedSymbol?: string | null }) {
  const { data: recData, isLoading } = useQuery({
    queryKey: ['recommendations', 'daily', 'latest'],
    queryFn: () => recommendationsApi.daily(),
    staleTime: 5 * 60_000,
  })
  const { tradable: tradableRecs, emerging: emergingRecs } = splitRecommendationLanes<any>(recData)
  const recs = tradableRecs
  if (isLoading) return <div className="text-muted-foreground text-sm p-4 font-mono">Loading...</div>
  if (!recs.length && !emergingRecs.length) return <div className="text-center py-6 text-muted-foreground/60 text-xs">目前沒有 Daily Recommendations 可顯示</div>
  return (
      <div className="space-y-2">
        <div className="px-1 text-[10px] text-muted-foreground/60 font-mono">{recData?.date} 今日推薦候選（與 Dashboard 同源）</div>
      <div className="px-1 flex items-center gap-2 flex-wrap text-[10px] font-mono">
        <Badge variant="outline" className="h-5 px-1.5 text-[9px] border-sky-500/30 text-sky-400">
          source: daily recommendations
        </Badge>
        <span className="text-muted-foreground/70">這是 pipeline 產出的推薦候選；下一個交易日 morning setup / debate 後才會產生 pending buys。</span>
      </div>
      {recs.slice(0, 12).map((r: any, idx: number) => (
        <div key={r.symbol} className={`relative ${selectedSymbol === r.symbol ? 'ring-1 ring-emerald-500/40 rounded-xl' : ''}`}>
          <RecommendationCard rec={r} rank={idx + 1} />
          <button
            onClick={(e) => { e.stopPropagation(); onSelectSymbol?.(r.symbol) }}
            className="absolute top-2 right-10 p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
            title="查看 K 線"
          >
            <Activity className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      {emergingRecs.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3 space-y-2">
          <div className="flex items-center justify-between px-1">
            <div>
              <p className="text-[11px] font-semibold text-amber-300">興櫃觀察名單</p>
              <p className="text-[10px] text-muted-foreground/70">研究用，不進 morning setup / pending buys。</p>
            </div>
            <Badge variant="outline" className="h-5 px-1.5 text-[9px] border-amber-500/30 text-amber-300">
              {emergingRecs.length} 檔
            </Badge>
          </div>
          {emergingRecs.slice(0, 8).map((r: any, idx: number) => (
            <div key={`emerging-${r.symbol}`} className={`relative ${selectedSymbol === r.symbol ? 'ring-1 ring-amber-500/40 rounded-xl' : ''}`}>
              <RecommendationCard rec={r} rank={idx + 1} />
              <button
                onClick={(e) => { e.stopPropagation(); onSelectSymbol?.(r.symbol) }}
                className="absolute top-2 right-10 p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
                title="查看 K 線"
              >
                <Activity className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Open Positions（完整庫存）──────────────────────────────────────────────

function PositionsTable() {
  const { data, isLoading } = useQuery({
    queryKey: ['paper', 'positions'],
    queryFn: paperApi.positions,
    staleTime: 60_000,
    refetchInterval: 60 * 60_000, // 每小時更新現價
  })
  const { data: ordersData } = useQuery({
    queryKey: ['paper', 'orders'],
    queryFn: () => paperApi.orders(200),
    staleTime: 60_000,
  })

  const positions = data?.positions ?? data ?? []
  const summary = (data as any)?.summary
  const orders = Array.isArray(ordersData) ? ordersData : (ordersData as any)?.orders ?? []

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
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Wallet className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p>目前無持倉</p>
        <p className="text-xs mt-1">Bot 會在 ML 訊號觸發時自動建倉</p>
        {summary && (
          <div className="mt-4 text-xs text-muted-foreground/60">
            現金 ${fmt(summary.cash)} | 總資產 ${fmt(summary.total_value)}
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
            <tr className="text-muted-foreground text-xs uppercase border-b border-border">
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
              const entry = p.entry_price ?? p.avg_cost ?? 0
              const current = p.current_price ?? entry
              const shares = p.shares ?? 0
              const lots = shares >= 1000 ? `${Math.floor(shares / 1000)}張` : `${shares}股`
              const pnlPct = entry > 0 ? (current - entry) / entry : 0
              const pnlAmt = (current - entry) * shares
              const marketValue = current * shares
              const costBasis = entry * shares
              totalUnrealized += pnlAmt
              totalCostBasis += costBasis

              // 持有天數
              const daysHeld = p.entry_date
                ? Math.round((Date.now() - new Date(p.entry_date).getTime()) / 86400000)
                : null

              return (
                <tr key={p.symbol} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="p-2">
                    <div className="font-mono text-foreground">{p.symbol}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.name}
                      {daysHeld != null && <span className="ml-1 text-muted-foreground/60">({daysHeld}天)</span>}
                    </div>
                  </td>
                  <td className="p-2 text-right font-mono text-foreground/80">{lots}</td>
                  <td className="p-2 text-right font-mono text-foreground/80">${fmt(entry, 1)}</td>
                  <td className="p-2 text-right font-mono text-foreground/80">${fmt(current, 1)}</td>
                  <td className="p-2 text-right">
                    {p.trailing_stop ? (
                      <div className="font-mono text-red-400 text-xs">${fmt(p.trailing_stop, 1)}</div>
                    ) : p.initial_stop ? (
                      <div className="font-mono text-red-400/60 text-xs">${fmt(p.initial_stop, 1)}</div>
                    ) : <span className="text-muted-foreground/60">—</span>}
                  </td>
                  <td className="p-2 text-right">
                    {p.tp1_price && (
                      <div className={`font-mono text-xs ${p.tp1_hit ? 'text-muted-foreground line-through' : 'text-red-400'}`}>
                        T1 ${fmt(p.tp1_price, 1)}
                      </div>
                    )}
                    {p.tp2_price && (
                      <div className="font-mono text-xs text-red-300">T2 ${fmt(p.tp2_price, 1)}</div>
                    )}
                    {!p.tp1_price && !p.tp2_price && <span className="text-muted-foreground/60">—</span>}
                  </td>
                  <td className="p-2 text-right">
                    <div className={`font-mono ${pctClass(pnlPct)}`}>
                      {pnlPct >= 0 ? '+' : ''}{(pnlPct * 100).toFixed(2)}%
                    </div>
                    <div className={`text-xs font-mono ${pctClass(pnlAmt)}`}>
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

  const orders = Array.isArray(data) ? data : (data as any)?.orders ?? []
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
          <tr className="text-muted-foreground text-xs uppercase border-b border-border">
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
                <td className="p-2 text-xs text-muted-foreground font-mono whitespace-nowrap">
                  {o.created_at ? new Date(new Date(o.created_at).getTime() + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ') : '-'}
                </td>
                <td className="p-2">
                  <span className="font-mono text-foreground">{o.symbol}</span>
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
                <td className="p-2 text-right font-mono text-foreground/80">{fmt(o.shares)}</td>
                <td className="p-2 text-right font-mono text-foreground/80">${fmt(o.price, 1)}</td>
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
          <span className={`font-mono font-semibold ${riskColor}`}>{riskScore}</span>
          <span className="text-muted-foreground text-xs ml-1">/ 100</span>
          <Badge className="ml-2 bg-muted/50 text-muted-foreground border-border/30 text-xs">{riskLevel}</Badge>
        </div>
      </div>

      {/* Scheduler run details live on the Scheduler Dashboard. */}
      <GateCalibrationPanel />

      <div className="text-center py-4 text-muted-foreground text-sm">
        <p>Scheduler runs moved to <a href="/scheduler" className="text-sky-400 hover:underline">Scheduler Dashboard</a></p>
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
                <div className="text-[10px] uppercase text-muted-foreground/60">{item.label}</div>
                <div className={`font-mono text-sm ${item.cls}`}>{item.value}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 space-y-1.5">
            {topRows.map((row, idx) => (
              <div key={`${row.status}-${row.reason}-${idx}`} className="flex items-start justify-between gap-3 text-[11px]">
                <span className="leading-relaxed text-muted-foreground/80">{describeGate(row)}</span>
                <span className="shrink-0 font-mono text-foreground/70">x{row.count}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

const PERIODS = [
  { key: '1W', days: 7, label: '1W' },
  { key: '1M', days: 30, label: '1M' },
  { key: '3M', days: 90, label: '3M' },
  { key: 'ALL', days: 9999, label: 'ALL' },
] as const

function PerformanceChart() {
  const [period, setPeriod] = useState<string>('ALL')
  const { data } = useQuery({
    queryKey: ['paper', 'pnl'],
    queryFn: paperApi.pnl,
    staleTime: 5 * 60_000,
  })

  const rawSnapshots: any[] = data?.snapshots ?? data?.daily ?? []
  // 確保按日期升序排列（左→右 = 舊→新）
  const allSnapshots = [...rawSnapshots].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))

  if (!Array.isArray(allSnapshots) || allSnapshots.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Activity className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p>No performance data yet</p>
        <p className="text-xs mt-1">Chart will appear after the first trading day</p>
      </div>
    )
  }

  // Filter by period
  const periodDays = PERIODS.find(p => p.key === period)?.days ?? 9999
  const cutoffDate = new Date(Date.now() - periodDays * 86400000).toISOString().slice(0, 10)
  const snapshots = period === 'ALL' ? allSnapshots : allSnapshots.filter((s: any) => s.date >= cutoffDate)

  if (snapshots.length === 0) return null

  // Base values for % calc（第一天 = 0%）
  const baseVal = snapshots[0]?.total_value ?? snapshots[0]?.portfolio_value ?? 1_000_000
  const baseBm = snapshots[0]?.benchmark_value
  const baseTwii = snapshots[0]?.twii_value
  const hasBenchmark = baseBm != null && baseBm > 0
  const hasTwii = baseTwii != null && baseTwii > 0

  const chartData = snapshots.map((s: any) => {
    const val = s.total_value ?? s.portfolio_value ?? baseVal
    const bm = s.benchmark_value
    const twii = s.twii_value
    return {
      date: s.date?.slice(5) ?? '',
      bot: ((val / baseVal) - 1) * 100,
      ...(hasBenchmark && bm != null ? { benchmark: ((bm / baseBm) - 1) * 100 } : {}),
      ...(hasTwii && twii != null ? { twii: ((twii / baseTwii) - 1) * 100 } : {}),
    }
  })

  const nameMap: Record<string, string> = { bot: 'Bot', benchmark: '0050', twii: '加權' }

  return (
    <div>
      {/* Period selector pills */}
      <div className="flex items-center gap-1 mb-3">
        {PERIODS.map(p => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              period === p.key
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'text-muted-foreground hover:text-foreground/80 border border-transparent'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={chartData}>
          <defs>
            <linearGradient id="botGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#228B22" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#228B22" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" tick={{ fill: '#52525b', fontSize: 10 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: '#52525b', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v.toFixed(1)}%`} width={45} />
          <Tooltip
            contentStyle={{ background: '#1a1d21', border: '1px solid #333', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#71717a' }}
            formatter={(v: number, name: string) => [`${v.toFixed(2)}%`, nameMap[name] ?? name]}
          />
          <Area type="monotone" dataKey="bot" stroke="#228B22" strokeWidth={2} fill="url(#botGrad)" dot={false} name="bot" />
          {hasBenchmark && (
            <Area type="monotone" dataKey="benchmark" stroke="#6366f1" strokeWidth={1} fill="none" dot={false} strokeDasharray="4 2" name="benchmark" />
          )}
          {hasTwii && (
            <Area type="monotone" dataKey="twii" stroke="#a78bfa" strokeWidth={1} fill="none" dot={false} strokeDasharray="2 2" name="twii" />
          )}
          <Legend formatter={(value) => <span className="text-[10px] text-muted-foreground">{nameMap[value] ?? value}</span>} iconSize={8} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
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
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Scale className="w-4 h-4" /> Backtest
          <span className="text-muted-foreground/60 text-xs ml-auto">{data.run_date} · {data.strategy}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-3">
          {metrics.map(m => (
            <div key={m.label} className="text-center" title={m.hint}>
              <div className="text-muted-foreground text-[10px] uppercase tracking-wider">{m.label}</div>
              <div className={`text-sm font-mono mt-0.5 ${m.good ? 'text-emerald-400' : 'text-red-400'}`}>
                {m.value}
              </div>
            </div>
            ))}
        </div>
        <div className="mt-3 rounded-md border border-white/[0.06] bg-white/[0.03] p-2 text-[10px] leading-relaxed text-muted-foreground/80">
          <div className="mb-1 font-medium text-foreground/70">怎麼讀這張卡</div>
          <div>先看 MDD / Calmar 判斷風險是否可承受，再看 Sharpe / Sortino 判斷報酬品質，最後用 PF / Expectancy 確認每筆交易是否真的有正期望；Trades 太少時所有結論都只能當觀察，不應直接 go-live。</div>
        </div>
        {/* MC + PBO go-live verdicts */}
        {(mcVerdict || pboVerdict) && (
          <div className="flex items-center gap-2 mt-3 pt-2 border-t border-white/[0.06]">
            {mcVerdict && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${mcBadge}`}>
                MC 95th: {mcData.mdd_95th != null ? `${(mcData.mdd_95th * 100).toFixed(1)}%` : '-'} {mcVerdict}
              </span>
            )}
            {pboVerdict && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${pboBadge}`}>
                PBO: {pboData.pbo != null ? `${(pboData.pbo * 100).toFixed(0)}%` : '-'} {pboVerdict}
              </span>
            )}
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
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Cpu className="w-4 h-4" /> Adaptive Params
          <span className="text-muted-foreground/60 text-xs ml-auto">v{version} · {computedAt}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <div className="text-center">
            <div className="text-muted-foreground text-[10px] uppercase tracking-wider">信心門檻</div>
            <div className={`text-sm font-mono mt-0.5 ${confColor}`}>{confThreshold.toFixed(2)}</div>
          </div>
          <div className="text-center">
            <div className="text-muted-foreground text-[10px] uppercase tracking-wider">Risk Score</div>
            <div className={`text-sm font-mono mt-0.5 ${riskScore > 70 ? 'text-red-400' : riskScore > 40 ? 'text-amber-400' : 'text-emerald-400'}`}>{riskScore}</div>
          </div>
          <div className="text-center">
            <div className="text-muted-foreground text-[10px] uppercase tracking-wider">30d 準確率</div>
            <div className={`text-sm font-mono mt-0.5 ${acc30d >= 0.6 ? 'text-emerald-400' : 'text-amber-400'}`}>{(acc30d * 100).toFixed(0)}%</div>
          </div>
          <div className="text-center">
            <div className="text-muted-foreground text-[10px] uppercase tracking-wider">Bandit</div>
            <div className={`text-sm font-mono mt-0.5 ${forceExplore ? 'text-red-400' : 'text-foreground/80'}`}>
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

function TradeJournalAnalytics() {
  const { data: journalData } = useQuery({
    queryKey: ['paper', 'journal'],
    queryFn: paperApi.journal,
    staleTime: 5 * 60_000,
  })

  const metrics = journalData?.metrics ?? null

  if (!metrics) {
    return (
      <Card className="bg-card border-border backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">交易分析</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground/60 text-xs">尚無已實現交易</p>
        </CardContent>
      </Card>
    )
  }

  const kpis = [
    { label: '勝率', value: `${(metrics.winRate * 100).toFixed(1)}%`, cls: metrics.winRate >= 0.5 ? 'text-red-400' : 'text-emerald-400' },
    { label: '平均持有', value: `${metrics.avgHoldDays}天`, cls: 'text-foreground/80' },
    { label: '最佳交易', value: metrics.best ? `${metrics.best.symbol} +$${fmt(Math.round(metrics.best.pnl))}` : '-', cls: 'text-red-400' },
    { label: '最差交易', value: metrics.worst ? `${metrics.worst.symbol} $${fmt(Math.round(metrics.worst.pnl))}` : '-', cls: 'text-emerald-400' },
    { label: '平均獲利', value: `$${fmt(Math.round(metrics.avgWin))}`, cls: 'text-red-400' },
    { label: '平均虧損', value: `-$${fmt(Math.round(metrics.avgLoss))}`, cls: 'text-emerald-400' },
    { label: 'Profit Factor', value: metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2), cls: metrics.profitFactor >= 1.5 ? 'text-red-400' : metrics.profitFactor >= 1 ? 'text-foreground/80' : 'text-emerald-400' },
    { label: 'Expectancy', value: `${metrics.expectancy >= 0 ? '+' : ''}$${fmt(Math.round(metrics.expectancy))}`, cls: pctClass(metrics.expectancy) },
  ]

  return (
    <Card className="bg-card border-border backdrop-blur-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          交易分析 <span className="text-muted-foreground/60 text-xs ml-2">{metrics.totalTrades} 筆</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {kpis.map(k => (
            <div key={k.label} className="text-center">
              <div className="text-muted-foreground text-[10px] uppercase tracking-wider">{k.label}</div>
              <div className={`text-sm font-mono mt-0.5 ${k.cls}`}>{k.value}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Position Sizing Calculator ─────────────────────────────────────────────

function PositionSizer() {
  const { data: account } = useQuery({
    queryKey: ['paper', 'account'],
    queryFn: paperApi.account,
    staleTime: 60_000,
  })
  const acc = account?.account ?? account ?? {}
  const defaultCash = acc?.cash ?? 1_000_000

  const [cash, setCash] = useState<string>('')
  const [riskPct, setRiskPct] = useState<string>('2')
  const [entryPrice, setEntryPrice] = useState<string>('')
  const [stopLoss, setStopLoss] = useState<string>('')

  const cashVal = parseFloat(cash) || defaultCash
  const riskVal = (parseFloat(riskPct) || 2) / 100
  const entry = parseFloat(entryPrice) || 0
  const sl = parseFloat(stopLoss) || 0

  const riskAmt = cashVal * riskVal
  const priceRisk = entry > 0 && sl > 0 ? Math.abs(entry - sl) : 0
  const shares = priceRisk > 0 ? Math.floor(riskAmt / priceRisk) : 0
  const lots = Math.floor(shares / 1000)
  const positionValue = shares * entry
  const allocation = cashVal > 0 ? (positionValue / cashVal) * 100 : 0

  const canCalc = entry > 0 && sl > 0 && entry !== sl

  return (
    <Card className="bg-card border-border backdrop-blur-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">部位計算器</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Inputs */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider">帳戶資金</label>
            <Input
              type="number"
              placeholder={fmt(Math.round(defaultCash))}
              value={cash}
              onChange={e => setCash(e.target.value)}
              className="h-8 text-sm font-mono mt-0.5"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider">風險 %</label>
            <Input
              type="number"
              placeholder="2"
              value={riskPct}
              onChange={e => setRiskPct(e.target.value)}
              className="h-8 text-sm font-mono mt-0.5"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider">進場價</label>
            <Input
              type="number"
              placeholder="0"
              value={entryPrice}
              onChange={e => setEntryPrice(e.target.value)}
              className="h-8 text-sm font-mono mt-0.5"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider">停損價</label>
            <Input
              type="number"
              placeholder="0"
              value={stopLoss}
              onChange={e => setStopLoss(e.target.value)}
              className="h-8 text-sm font-mono mt-0.5"
            />
          </div>
        </div>

        {/* Results */}
        {canCalc && (
          <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border/50">
            {[
              { label: '風險金額', value: `$${fmt(Math.round(riskAmt))}` },
              { label: '價差風險', value: `$${fmt(priceRisk, 1)}` },
              { label: '股數', value: fmt(shares) },
              { label: '張數', value: `${lots} 張` },
              { label: '部位價值', value: `$${fmt(Math.round(positionValue))}` },
              { label: '佔比', value: `${allocation.toFixed(1)}%` },
            ].map(r => (
              <div key={r.label} className="text-center">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{r.label}</div>
                <div className="text-sm font-mono text-foreground/80 mt-0.5">{r.value}</div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Main Dashboard ─────────────────────────────────────────────────────────

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
              kicker="Execution workstation"
              title="Bot Trading Desk"
              description="登入後查看 pending buys、debate、fills、slippage、T1/T2/Stop 與資產計算；未登入時只顯示工作台預覽，不讀交易資料。"
              action={<WorkstationPill tone="warn">Login Required</WorkstationPill>}
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
            <div className="border border-[#263247] bg-[#070a10]/90 p-6 text-center">
              <Bot className="mx-auto h-12 w-12 text-emerald-400/70" />
              <p className="mt-3 text-sm text-muted-foreground">請先登入以查看 Bot Dashboard</p>
              <button onClick={login} className="mt-4 border border-emerald-500/30 bg-emerald-600/80 px-4 py-2 text-sm hover:bg-emerald-500">
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
          kicker="Execution workstation"
          title="Bot Trading Desk"
          description="Pending buys、debate、fills、slippage、T1/T2/Stop 與資產計算集中在同一張交易桌；資料來源與交易邏輯維持原 API。"
          action={
            <div className="flex flex-wrap gap-2">
              <WorkstationPill tone="warn">Paper Trading</WorkstationPill>
              <WorkstationPill tone={isTWMarketOpen() ? 'ok' : 'neutral'}>{isTWMarketOpen() ? 'Market Open' : 'Market Closed'}</WorkstationPill>
            </div>
          }
        />

        <WorkstationPanel title="Portfolio Strip" kicker="cash, settlement, pnl" className="sticky top-0 z-20">
          <div className="px-4 pb-2 pt-3">
            <PortfolioSummary />
          </div>
        </WorkstationPanel>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <WorkstationCatCard
            src="/stockvision-cats/02_red_market_royal_cat.png"
            title="紅盤也要端著"
            caption="帳面變漂亮時先查交割、滑價與未實現損益，不讓紙上富貴偷灌資產。"
            tone="warn"
          />
          <WorkstationCatCard
            src="/stockvision-cats/03_ai_signal_skewer_stall.png"
            title="AI 串燒別亂買"
            caption="推薦只是候選，進場前仍要過 debate、T2、quote sanity 與 execution guard。"
            tone="info"
          />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <WorkstationPanel title="Equity Curve" kicker="paper trading performance">
            <div className="px-3 pb-2 pt-1">
              <PerformanceChart />
            </div>
          </WorkstationPanel>
          <WorkstationPanel title="Positions" kicker="open risk and holdings">
            <PositionsTable />
          </WorkstationPanel>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <WorkstationPanel
            title="AI Top Picks"
            kicker="post-debate execution candidates"
            action={<WorkstationPill tone="info">T2 aware</WorkstationPill>}
          >
            <div className="border-b border-[#263247] px-4 pb-2 pt-3">
              <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 font-mono uppercase tracking-wider">
                <TrendingUp className="w-3.5 h-3.5" /> AI Top Picks
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/70">
                {AI_TOP_PICK_EXPLANATION}
              </p>
            </div>
            <div className="p-2">
              <SignalTable onSelectSymbol={setSelectedSymbol} selectedSymbol={selectedSymbol} />
            </div>
          </WorkstationPanel>
          <WorkstationPanel title="Trade History" kicker="orders and fills audit">
            <TradeHistory />
          </WorkstationPanel>
        </div>

        {/* K-Line Dialog (popup on stock click) */}
        <Dialog open={!!selectedStockId} onOpenChange={(open) => { if (!open) setSelectedSymbol(null) }}>
          <DialogContent className="max-w-4xl bg-card border-border">
            <DialogHeader>
              <DialogTitle className="text-sm font-mono">{selectedSymbol} K 線圖</DialogTitle>
            </DialogHeader>
            {selectedStockId && <CandlestickChart stockId={selectedStockId} />}
          </DialogContent>
        </Dialog>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <TradeJournalAnalytics />
          <BotThemeFlowPanel />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          <BacktestCard />
          <AdaptiveParamsCard />
          <PositionSizer />
        </div>

        <details className="group">
          <summary className="flex items-center gap-2 border border-[#263247] bg-[#070a10] px-4 py-2.5 cursor-pointer hover:border-amber-300/30 transition-colors text-xs font-medium text-muted-foreground select-none">
            <Bot className="w-3.5 h-3.5" />
            <span className="font-mono uppercase tracking-wider">Bot Status & Scheduler Runs</span>
            <svg className="w-3.5 h-3.5 ml-auto transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M19 9l-7 7-7-7" /></svg>
          </summary>
          <WorkstationPanel title="Bot Status" kicker="scheduler runs and market risk" className="mt-2">
            <div className="p-3">
              <BotStatusPanel />
            </div>
          </WorkstationPanel>
        </details>

      </div>
    </AppShell>
  )
}
