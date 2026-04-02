/**
 * BotDashboard — Auto Trade Bot 專頁
 *
 * Design: Dark Mode + Mobile-first, inspired by FreqUI + 3Commas
 * Sections: Portfolio Summary → Signals → Positions → Trade History → Bot Status
 */
import { useState, Fragment } from 'react'
import { useQuery } from '@tanstack/react-query'
import { paperApi, marketApi, recommendationsApi, systemApi, backtestApi, cronApi, adaptiveApi, getToken } from '@/lib/api'
import { useAuth } from '@/_core/hooks/useAuth'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Activity, TrendingUp, TrendingDown, DollarSign, Wallet, BarChart3,
  Bot, ShieldCheck, ShieldAlert, Clock, ArrowUpRight, ArrowDownRight,
  Minus, RefreshCw, Percent, Shield, Award, Scale, Cpu,
} from 'lucide-react'
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { BotThemeFlowPanel, RecommendationCard } from '@/components/DailyRecommendationPanel'
import CandlestickChart from '@/components/CandlestickChart'
import { stocksApi } from '@/lib/api'

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
  if (pct > 0) return 'text-emerald-400'
  if (pct < 0) return 'text-red-400'
  return 'text-zinc-400'
}

function signalBadge(signal: string) {
  const s = signal?.toUpperCase() ?? ''
  // 暗綠 #228B22, 暗紅 #B22222 — Gemini 建議的沉穩配色
  if (s.includes('STRONG_BUY')) return <Badge className="border text-[10px] px-1.5 py-0" style={{ background: 'rgba(34,139,34,0.15)', color: '#228B22', borderColor: 'rgba(34,139,34,0.3)' }}>STRONG BUY</Badge>
  if (s.includes('BUY'))        return <Badge className="border text-[10px] px-1.5 py-0" style={{ background: 'rgba(34,139,34,0.15)', color: '#228B22', borderColor: 'rgba(34,139,34,0.3)' }}>BUY</Badge>
  if (s.includes('STRONG_SELL'))return <Badge className="border text-[10px] px-1.5 py-0" style={{ background: 'rgba(178,34,34,0.15)', color: '#B22222', borderColor: 'rgba(178,34,34,0.3)' }}>STRONG SELL</Badge>
  if (s.includes('SELL'))       return <Badge className="border text-[10px] px-1.5 py-0" style={{ background: 'rgba(178,34,34,0.15)', color: '#B22222', borderColor: 'rgba(178,34,34,0.3)' }}>SELL</Badge>
  if (s.includes('NO_SIGNAL'))  return <Badge className="bg-zinc-800/50 text-zinc-500 border-zinc-700/30 text-[10px] px-1.5 py-0">—</Badge>
  return <Badge className="bg-zinc-800/50 text-zinc-500 border-zinc-700/30 text-[10px] px-1.5 py-0">HOLD</Badge>
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-emerald-400' : 'bg-red-400'}`} />
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
  if (win === null) return <span className="text-zinc-600 text-xs">-</span>
  return win
    ? <span className="text-xs font-bold text-emerald-400">勝</span>
    : <span className="text-xs font-bold text-red-400">負</span>
}

function PortfolioSummary() {
  const { data: account } = useQuery({ queryKey: ['paper', 'account'], queryFn: paperApi.account, staleTime: 60_000 })
  const { data: positions } = useQuery({ queryKey: ['paper', 'positions'], queryFn: paperApi.positions, staleTime: 30_000, refetchInterval: isTWMarketOpen() ? 60_000 : false })
  const { data: pnlData } = useQuery({ queryKey: ['paper', 'pnl'], queryFn: paperApi.pnl, staleTime: 5 * 60_000 })
  // 歷史已實現損益（從 sell orders 計算）
  const { data: ordersData } = useQuery({ queryKey: ['paper', 'orders', 'all'], queryFn: () => paperApi.orders(999), staleTime: 5 * 60_000 })
  const sellOrders = (Array.isArray(ordersData) ? ordersData : (ordersData as any)?.orders ?? []).filter((o: any) => o.side === 'sell')
  const totalRealizedPnl = sellOrders.reduce((sum: number, o: any) => {
    try {
      const note = typeof o.note === 'string' ? JSON.parse(o.note) : o.note
      const entry = note?.entry_price ?? o.price
      return sum + (o.price - entry) * o.shares
    } catch {
      // note 是純文字（舊格式），用 buy order 的 entry_price 回推
      const buyOrder = (Array.isArray(ordersData) ? ordersData : (ordersData as any)?.orders ?? [])
        .find((b: any) => b.side === 'buy' && b.symbol === o.symbol)
      const entryFromBuy = buyOrder?.price ?? o.price
      return sum + (o.price - entryFromBuy) * o.shares
    }
  }, 0)

  const acc = account?.account ?? account ?? {}
  const cash = acc?.cash ?? 0
  const initialCash = acc?.initial_cash ?? 1_000_000
  const posArr = positions?.positions ?? positions ?? []
  const positionValue = Array.isArray(posArr)
    ? posArr.reduce((s: number, p: any) => s + (p.current_price ?? p.avg_cost ?? 0) * (p.shares ?? 0), 0)
    : 0
  const totalAssets = cash + positionValue
  const totalReturn = initialCash > 0 ? (totalAssets - initialCash) / initialCash : 0

  // PnL snapshots for advanced metrics
  const snapshots: any[] = pnlData?.snapshots ?? pnlData?.daily ?? []
  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null
  const first = snapshots.length > 0 ? snapshots[0] : null

  // 年化報酬
  const daysSinceStart = first?.date
    ? Math.max(1, (Date.now() - new Date(first.date).getTime()) / 86400000)
    : 1
  const annualizedReturn = daysSinceStart > 0 ? totalReturn * (365 / daysSinceStart) : 0

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
    <div className="grid grid-cols-[auto_repeat(4,minmax(0,1fr))_auto_auto] items-baseline gap-x-5 gap-y-0 mb-2 overflow-x-auto whitespace-nowrap">
      {/* 總資產 */}
      <div className="shrink-0">
        <div className="text-[11px] text-zinc-500 uppercase tracking-wide">總資產</div>
        <div className="text-2xl font-mono text-zinc-100 leading-tight">${fmt(totalAssets)}</div>
        <span className={`text-sm font-mono ${pctClass(totalReturn)}`}>{totalReturn >= 0 ? '+' : ''}{(totalReturn * 100).toFixed(2)}%</span>
      </div>
      {/* 指標列 */}
      {[
        { label: '已實現', val: `${totalRealizedPnl >= 0 ? '+' : ''}$${fmt(Math.round(totalRealizedPnl))}`, sub: `${sellOrders.length}筆`, cls: pctClass(totalRealizedPnl) },
        { label: '年化', val: `${annualizedReturn >= 0 ? '+' : ''}${(annualizedReturn * 100).toFixed(1)}%`, sub: `${Math.round(daysSinceStart)}天`, cls: pctClass(annualizedReturn) },
        { label: 'MDD', val: `-${(maxDrawdown * 100).toFixed(1)}%`, sub: '', cls: maxDrawdown > 0.1 ? 'text-red-400' : maxDrawdown > 0.05 ? 'text-amber-400' : 'text-emerald-400' },
        { label: 'Sharpe', val: sharpe30d != null ? sharpe30d.toFixed(2) : '-', sub: '30d', cls: sharpe30d != null ? (sharpe30d > 1 ? 'text-emerald-400' : sharpe30d > 0 ? 'text-zinc-200' : 'text-red-400') : 'text-zinc-500' },
      ].map(m => (
        <div key={m.label} className="shrink-0 min-w-[3.5rem]">
          <div className="text-[11px] text-zinc-500 uppercase tracking-wide">{m.label}</div>
          <div className={`text-base font-mono leading-tight ${m.cls}`}>{m.val}</div>
          <span className="text-[10px] text-zinc-600">{m.sub || '\u00A0'}</span>
        </div>
      ))}
      {/* vs 0050 */}
      <div className="shrink-0">
        <div className="text-[11px] text-zinc-500 uppercase tracking-wide">vs 0050</div>
        <div className="flex gap-2 mt-0.5">
          {[{ l: '週', w: beatsBenchmark(retWeek, bmWeek) }, { l: '月', w: beatsBenchmark(retMonth, bmMonth) }, { l: '季', w: beatsBenchmark(retQuarter, bmQuarter) }].map(b => (
            <div key={b.l} className="text-center"><div className="text-[9px] text-zinc-500">{b.l}</div><WinLossBadge win={b.w} /></div>
          ))}
        </div>
        <span className="text-[10px] text-zinc-600">{'\u00A0'}</span>
      </div>
      {/* 近期 */}
      <div className="shrink-0">
        <div className="text-[11px] text-zinc-500 uppercase tracking-wide">近期</div>
        <div className="flex gap-3 mt-0.5">
          {[{ l: '週', v: retWeek }, { l: '月', v: retMonth }, { l: '季', v: retQuarter }].map(({ l, v }) => (
            <div key={l} className="text-center">
              <div className="text-[9px] text-zinc-500">{l}</div>
              <div className={`text-xs font-mono ${v != null ? pctClass(v) : 'text-zinc-600'}`}>{v != null ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '-'}</div>
            </div>
          ))}
        </div>
        <span className="text-[10px] text-zinc-600">{'\u00A0'}</span>
      </div>
    </div>
  )
}

// ─── Today's ML Signals ─────────────────────────────────────────────────────

function SignalTable({ onSelectSymbol, selectedSymbol }: { onSelectSymbol?: (s: string) => void; selectedSymbol?: string | null }) {
  // T2 過濾後的掛單（非 raw recommendations）
  const { data: pbData, isLoading } = useQuery({
    queryKey: ['paper', 'pending-buys'],
    queryFn: () => paperApi.pendingBuys(),
    staleTime: 5 * 60_000,
  })
  const buys: any[] = Array.isArray(pbData?.pendingBuys) ? pbData.pendingBuys : []
  const showingDate = pbData?.date ?? ''

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

  if (isLoading) return <div className="text-zinc-500 text-sm p-4 font-mono">Loading...</div>

  // 如果沒有 pending buys，fallback 到 daily recommendations
  if (!buys.length) {
    return <FallbackRecommendations onSelectSymbol={onSelectSymbol} selectedSymbol={selectedSymbol} />
  }

  return (
    <div className="space-y-2">
      <div className="px-1 text-[10px] text-zinc-600 font-mono">{showingDate} · T2 篩選後掛單</div>
      {buys.map((b: any, idx: number) => {
        const qf = qfMap.get(b.symbol)
        const rec = {
          symbol: b.symbol, name: b.name, signal: b.signal, confidence: b.confidence,
          current_price: b.ml_entry_price, score: b.score ?? 0, sector: qf?.quadrant ?? '',
          reason: `限價 $${b.ml_entry_price} · 停損 $${b.ml_stop_loss} · TP1 $${b.ml_target1}`,
          chip_score: b.chip_score ?? null, tech_score: b.tech_score ?? null, ml_score: b.ml_score ?? null,
        }
        return (
          <div key={b.symbol} onClick={() => onSelectSymbol?.(b.symbol)}
            className={selectedSymbol === b.symbol ? 'ring-1 ring-emerald-500/40 rounded-xl' : ''}>
            <RecommendationCard rec={rec} rank={idx + 1} />
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
  const recs = recData?.recommendations ?? recData?.data ?? []
  if (isLoading) return <div className="text-zinc-500 text-sm p-4 font-mono">Loading...</div>
  if (!recs.length) return <div className="text-center py-6 text-zinc-600 text-xs">尚無推薦</div>
  return (
    <div className="space-y-2">
      <div className="px-1 text-[10px] text-zinc-600 font-mono">{recData?.date} · 推薦（未經 T2 篩選）</div>
      {recs.slice(0, 12).map((r: any, idx: number) => (
        <div key={r.symbol} onClick={() => onSelectSymbol?.(r.symbol)}
          className={selectedSymbol === r.symbol ? 'ring-1 ring-emerald-500/40 rounded-xl' : ''}>
          <RecommendationCard rec={r} rank={idx + 1} />
        </div>
      ))}
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

  if (isLoading) return <div className="text-zinc-500 text-sm p-4">Loading...</div>
  if (!Array.isArray(positions) || positions.length === 0) {
    return (
      <div className="text-center py-12 text-zinc-500">
        <Wallet className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p>目前無持倉</p>
        <p className="text-xs mt-1">Bot 會在 ML 訊號觸發時自動建倉</p>
        {summary && (
          <div className="mt-4 text-xs text-zinc-600">
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
            <tr className="text-zinc-500 text-xs uppercase border-b border-zinc-800">
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
                <tr key={p.symbol} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                  <td className="p-2">
                    <div className="font-mono text-zinc-200">{p.symbol}</div>
                    <div className="text-xs text-zinc-500">
                      {p.name}
                      {daysHeld != null && <span className="ml-1 text-zinc-600">({daysHeld}天)</span>}
                    </div>
                  </td>
                  <td className="p-2 text-right font-mono text-zinc-300">{lots}</td>
                  <td className="p-2 text-right font-mono text-zinc-300">${fmt(entry, 1)}</td>
                  <td className="p-2 text-right font-mono text-zinc-300">${fmt(current, 1)}</td>
                  <td className="p-2 text-right">
                    {p.trailing_stop ? (
                      <div className="font-mono text-red-400 text-xs">${fmt(p.trailing_stop, 1)}</div>
                    ) : p.initial_stop ? (
                      <div className="font-mono text-red-400/60 text-xs">${fmt(p.initial_stop, 1)}</div>
                    ) : <span className="text-zinc-600">—</span>}
                  </td>
                  <td className="p-2 text-right">
                    {p.tp1_price && (
                      <div className={`font-mono text-xs ${p.tp1_hit ? 'text-zinc-500 line-through' : 'text-emerald-400'}`}>
                        T1 ${fmt(p.tp1_price, 1)}
                      </div>
                    )}
                    {p.tp2_price && (
                      <div className="font-mono text-xs text-emerald-300">T2 ${fmt(p.tp2_price, 1)}</div>
                    )}
                    {!p.tp1_price && !p.tp2_price && <span className="text-zinc-600">—</span>}
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
      <div className="flex items-center justify-between px-3 py-2 mt-2 bg-zinc-800/40 rounded text-xs">
        <div className="flex gap-4">
          <span className="text-zinc-500">持倉 <span className="text-zinc-300">{positions.length}</span> 檔</span>
          <span className="text-zinc-500">成本 <span className="text-zinc-300">${fmt(Math.round(totalCostBasis))}</span></span>
        </div>
        <div className="flex gap-4">
          <span className="text-zinc-500">未實現 <span className={pctClass(totalUnrealized)}>{totalUnrealized >= 0 ? '+' : ''}${fmt(Math.round(totalUnrealized))}</span></span>
          {summary && <span className="text-zinc-500">現金 <span className="text-zinc-300">${fmt(Math.round(summary.cash))}</span></span>}
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
  if (isLoading) return <div className="text-zinc-500 text-sm p-4">Loading...</div>
  if (!orders.length) {
    return (
      <div className="text-center py-12 text-zinc-500">
        <Clock className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p>No trades yet</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-zinc-500 text-xs uppercase border-b border-zinc-800">
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
              <tr key={o.id ?? i} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                <td className="p-2 text-xs text-zinc-500 font-mono whitespace-nowrap">
                  {o.created_at ? new Date(new Date(o.created_at).getTime() + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ') : '-'}
                </td>
                <td className="p-2">
                  <span className="font-mono text-zinc-200">{o.symbol}</span>
                  <span className="text-xs text-zinc-500 ml-1">{o.name}</span>
                </td>
                <td className="p-2">
                  <Badge className={isBuy
                    ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                    : 'bg-red-500/20 text-red-400 border-red-500/30'
                  }>
                    {isBuy ? <ArrowUpRight className="w-3 h-3 mr-1" /> : <ArrowDownRight className="w-3 h-3 mr-1" />}
                    {o.side?.toUpperCase()}
                  </Badge>
                </td>
                <td className="p-2 text-right font-mono text-zinc-300">{fmt(o.shares)}</td>
                <td className="p-2 text-right font-mono text-zinc-300">${fmt(o.price, 1)}</td>
                <td className="p-2 text-xs text-zinc-500 hidden md:table-cell max-w-[200px] truncate">
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

// ─── Bot Status（Live Cron Logs）─────────────────────────────────────────────

function BotStatusPanel() {
  const [expanded, setExpanded] = useState<string | null>(null)
  const { data: risk } = useQuery({
    queryKey: ['market', 'risk'],
    queryFn: marketApi.risk,
    staleTime: 5 * 60_000,
  })
  const { data: cronData } = useQuery({
    queryKey: ['paper', 'cronLogs'],
    queryFn: () => paperApi.cronLogs(),
    staleTime: 60_000,
  })
  const { data: scheduleData } = useQuery({
    queryKey: ['cron', 'schedule'],
    queryFn: cronApi.schedule,
    staleTime: 30 * 60_000, // 排程幾乎不變，30 min cache
  })
  const cronTimes: Record<string, string> = Object.fromEntries(
    (scheduleData?.schedule ?? []).map(s => [s.task, s.tw_time])
  )

  const riskScore = risk?.risk_score ?? risk?.riskScore ?? 50
  const riskLevel = risk?.risk_level ?? risk?.riskLevel ?? 'medium'
  const riskColor = riskScore > 70 ? 'text-red-400' : riskScore > 40 ? 'text-amber-400' : 'text-emerald-400'

  const logs: any[] = cronData?.logs ?? []

  return (
    <div className="space-y-4">
      {/* Market Risk */}
      <div className="flex items-center justify-between p-3 bg-zinc-800/50 rounded-lg">
        <div className="flex items-center gap-2">
          {riskScore > 70 ? <ShieldAlert className="w-4 h-4 text-red-400" /> : <ShieldCheck className="w-4 h-4 text-emerald-400" />}
          <span className="text-sm text-zinc-300">Market Risk</span>
        </div>
        <div className="text-right">
          <span className={`font-mono font-semibold ${riskColor}`}>{riskScore}</span>
          <span className="text-zinc-500 text-xs ml-1">/ 100</span>
          <Badge className="ml-2 bg-zinc-700/50 text-zinc-400 border-zinc-600/30 text-xs">{riskLevel}</Badge>
        </div>
      </div>

      {/* Cron Logs */}
      <div className="space-y-1">
        {logs.map((log: any) => {
          const isSuccess = log.status === 'success'
          const isError = log.status === 'error'
          const isPending = log.status === 'skipped'
          const isExpanded = expanded === log.task
          const time = cronTimes[log.task] ?? ''

          return (
            <div key={log.task}>
              <div
                className={`flex items-center justify-between p-2 rounded cursor-pointer hover:bg-zinc-800/30 ${isExpanded ? 'bg-zinc-800/40' : ''}`}
                onClick={() => setExpanded(isExpanded ? null : log.task)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                    isSuccess ? 'bg-emerald-400' : isError ? 'bg-red-400' : 'bg-zinc-600'
                  }`} />
                  <span className="text-sm text-zinc-300 truncate">{log.task.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {!isPending && (
                    <span className="text-[10px] text-zinc-500 font-mono hidden sm:inline">
                      {log.duration_ms > 0 ? `${(log.duration_ms / 1000).toFixed(1)}s` : ''}
                    </span>
                  )}
                  <span className="text-xs text-zinc-500 font-mono">{time}</span>
                </div>
              </div>
              {isExpanded && !isPending && (
                <div className="ml-6 px-3 py-2 text-xs bg-zinc-800/30 rounded-b mb-1">
                  <div className={isError ? 'text-red-400' : 'text-zinc-400'}>{log.summary}</div>
                  {log.timestamp && (
                    <div className="text-zinc-600 mt-1">
                      {new Date(new Date(log.timestamp).getTime() + 8 * 3600_000).toISOString().slice(11, 19)} TW
                    </div>
                  )}
                  {log.error && <div className="text-red-500/70 mt-1 font-mono text-[10px] break-all">{log.error.slice(0, 200)}</div>}
                </div>
              )}
            </div>
          )
        })}
        {logs.length === 0 && (
          <div className="text-center py-8 text-zinc-500 text-sm">
            <Clock className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p>今日尚無 Cron 執行紀錄</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Performance Chart（Benchmark overlay + Period selector）────────────────

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
      <div className="text-center py-12 text-zinc-500">
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
                : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
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
          <Legend formatter={(value) => <span className="text-[10px] text-zinc-500">{nameMap[value] ?? value}</span>} iconSize={8} />
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

  if (isLoading) {
    return (
      <Card className="bg-white/[0.03] border-white/[0.08] backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-zinc-400 flex items-center gap-2">
            <Scale className="w-4 h-4" /> Backtest
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-zinc-600 text-xs">Loading...</p>
        </CardContent>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card className="bg-white/[0.03] border-white/[0.08] backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-zinc-400 flex items-center gap-2">
            <Scale className="w-4 h-4" /> Backtest
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-zinc-600 text-xs">尚無回測結果</p>
        </CardContent>
      </Card>
    )
  }

  const metrics = [
    { label: 'Sharpe', value: data.sharpe != null ? data.sharpe.toFixed(2) : '-', good: (data.sharpe ?? 0) > 1 },
    { label: 'MDD', value: data.max_drawdown != null ? `${(data.max_drawdown * 100).toFixed(1)}%` : '-', good: (data.max_drawdown ?? 1) < 0.15 },
    { label: 'Win Rate', value: data.win_rate != null ? `${(data.win_rate * 100).toFixed(1)}%` : '-', good: (data.win_rate ?? 0) > 0.5 },
    { label: 'PF', value: data.profit_factor != null ? data.profit_factor.toFixed(2) : '-', good: (data.profit_factor ?? 0) > 1.5 },
    { label: 'Trades', value: data.total_trades ?? '-', good: true },
    { label: 'Expectancy', value: data.expectancy != null ? data.expectancy.toFixed(4) : '-', good: (data.expectancy ?? 0) > 0 },
  ]

  return (
    <Card className="bg-white/[0.03] border-white/[0.08] backdrop-blur-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Scale className="w-4 h-4" /> Backtest
          <span className="text-zinc-600 text-xs ml-auto">{data.run_date} · {data.strategy}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
          {metrics.map(m => (
            <div key={m.label} className="text-center">
              <div className="text-zinc-500 text-[10px] uppercase tracking-wider">{m.label}</div>
              <div className={`text-sm font-mono mt-0.5 ${m.good ? 'text-emerald-400' : 'text-red-400'}`}>
                {m.value}
              </div>
            </div>
          ))}
        </div>
        {data.timerange && (
          <div className="text-zinc-600 text-[10px] mt-2 text-center">{data.timerange}</div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Adaptive Params Card ────────────────────────────────────────────────────

function AdaptiveParamsCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['adaptive', 'params'],
    queryFn: adaptiveApi.get,
    staleTime: 5 * 60_000,
  })

  if (isLoading) {
    return (
      <Card className="bg-white/[0.03] border-white/[0.08] backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-zinc-400 flex items-center gap-2">
            <Cpu className="w-4 h-4" /> Adaptive Params
          </CardTitle>
        </CardHeader>
        <CardContent><p className="text-zinc-600 text-xs">Loading...</p></CardContent>
      </Card>
    )
  }

  if (!data || !data.computed_at) {
    return (
      <Card className="bg-white/[0.03] border-white/[0.08] backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-zinc-400 flex items-center gap-2">
            <Cpu className="w-4 h-4" /> Adaptive Params
          </CardTitle>
        </CardHeader>
        <CardContent><p className="text-zinc-600 text-xs">尚未計算（今日 16:05 後可用）</p></CardContent>
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

  const confColor = confThreshold > 0.65 ? 'text-amber-400' : confThreshold < 0.58 ? 'text-emerald-400' : 'text-zinc-300'

  return (
    <Card className="bg-white/[0.03] border-white/[0.08] backdrop-blur-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Cpu className="w-4 h-4" /> Adaptive Params
          <span className="text-zinc-600 text-xs ml-auto">v{version} · {computedAt}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <div className="text-center">
            <div className="text-zinc-500 text-[10px] uppercase tracking-wider">信心門檻</div>
            <div className={`text-sm font-mono mt-0.5 ${confColor}`}>{confThreshold.toFixed(2)}</div>
          </div>
          <div className="text-center">
            <div className="text-zinc-500 text-[10px] uppercase tracking-wider">Risk Score</div>
            <div className={`text-sm font-mono mt-0.5 ${riskScore > 70 ? 'text-red-400' : riskScore > 40 ? 'text-amber-400' : 'text-emerald-400'}`}>{riskScore}</div>
          </div>
          <div className="text-center">
            <div className="text-zinc-500 text-[10px] uppercase tracking-wider">30d 準確率</div>
            <div className={`text-sm font-mono mt-0.5 ${acc30d >= 0.6 ? 'text-emerald-400' : 'text-amber-400'}`}>{(acc30d * 100).toFixed(0)}%</div>
          </div>
          <div className="text-center">
            <div className="text-zinc-500 text-[10px] uppercase tracking-wider">Bandit</div>
            <div className={`text-sm font-mono mt-0.5 ${forceExplore ? 'text-red-400' : 'text-zinc-300'}`}>
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
      <div className="min-h-screen text-zinc-100 flex items-center justify-center" style={{ background: '#1A1D21' }}>
        <div className="text-center space-y-4">
          <Bot className="w-12 h-12 mx-auto text-emerald-400/60" />
          <p className="text-zinc-400">請先登入以查看 Bot Dashboard</p>
          <button onClick={login} className="px-4 py-2 bg-emerald-600/80 hover:bg-emerald-500 border border-emerald-500/30 rounded-lg text-sm">
            Google 登入
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen text-zinc-100 relative overflow-x-hidden" style={{ background: '#1A1D21' }}>
      {/* Background Glow Blobs */}
      <div className="pointer-events-none fixed inset-0 z-[1]" style={{ mixBlendMode: 'screen' }}>
        <div className="absolute" style={{ left: '-10%', top: '5%', width: '60vw', height: '60vh', background: 'radial-gradient(ellipse at center, rgba(34,139,34,0.30) 0%, transparent 65%)', animation: 'blob-drift-1 18s ease-in-out infinite', willChange: 'transform' }} />
        <div className="absolute" style={{ right: '-5%', top: '-5%', width: '50vw', height: '60vh', background: 'radial-gradient(ellipse at center, rgba(255,255,255,0.06) 0%, transparent 65%)', animation: 'blob-drift-2 22s ease-in-out infinite', willChange: 'transform' }} />
        <div className="absolute" style={{ left: '20%', bottom: '-5%', width: '50vw', height: '45vh', background: 'radial-gradient(ellipse at center, rgba(34,139,34,0.20) 0%, transparent 65%)', animation: 'blob-drift-3 15s ease-in-out infinite', willChange: 'transform' }} />
      </div>

      {/* Header */}
      <header className="border-b border-white/[0.06] px-4 py-2 flex items-center justify-between sticky top-0 z-10" style={{ background: 'rgba(26,29,33,0.85)', backdropFilter: 'blur(12px)' }}>
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-emerald-500" />
          <h1 className="text-sm font-medium tracking-tight font-mono">StockVision Bot</h1>
        </div>
        <div className="flex items-center gap-3">
          <details className="relative">
            <summary className="flex items-center gap-1.5 cursor-pointer list-none text-xs text-zinc-500 hover:text-zinc-300">
              <StatusDot ok={true} />
              <span className="hidden sm:inline font-mono">Online</span>
            </summary>
            <div className="absolute right-0 top-full mt-2 w-80 border border-white/[0.08] rounded-xl shadow-2xl p-3 z-50" style={{ background: 'rgba(26,29,33,0.97)', backdropFilter: 'blur(16px)' }}>
              <BotStatusPanel />
            </div>
          </details>
          <a href="/" className="text-xs text-zinc-600 hover:text-zinc-400 font-mono">Dashboard</a>
        </div>
      </header>

      <main className="relative z-10 w-full px-2 sm:px-3 lg:px-4 py-2 sm:py-3 space-y-2 sm:space-y-3 text-sm">

        {/* ═══ Top Banner：Portfolio+Chart(40) | Positions(30) | History(30) ═══ */}
        <div className="grid grid-cols-1 xl:grid-cols-[2fr_1.5fr_1.5fr] gap-3">
          <Card className="border-white/[0.06]" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <CardContent className="pt-3 pb-2 px-4">
              <PortfolioSummary />
              <PerformanceChart />
            </CardContent>
          </Card>
          <Card className="border-white/[0.06]" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <CardHeader className="pb-0 pt-2 px-3">
              <CardTitle className="text-xs font-medium text-zinc-500 font-mono uppercase tracking-wider">Positions</CardTitle>
            </CardHeader>
            <CardContent className="p-0"><PositionsTable /></CardContent>
          </Card>
          <Card className="border-white/[0.06]" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <CardHeader className="pb-0 pt-2 px-3">
              <CardTitle className="text-xs font-medium text-zinc-500 font-mono uppercase tracking-wider">History</CardTitle>
            </CardHeader>
            <CardContent className="p-0"><TradeHistory /></CardContent>
          </Card>
        </div>

        {/* ═══ 三欄主體：族群(40) | AI Picks(30) | Backtest+Adaptive+K線(30) ═══ */}
        <div className="grid grid-cols-1 xl:grid-cols-[2fr_1.5fr_1.5fr] gap-3">

          {/* ── 左欄：族群資金流 ── */}
          <BotThemeFlowPanel />

          {/* ── 中欄：AI 推薦 ── */}
          <Card className="border-white/[0.06]" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <CardHeader className="pb-1 pt-3 px-4">
              <CardTitle className="text-xs font-medium text-zinc-500 flex items-center gap-1.5 font-mono uppercase tracking-wider">
                <TrendingUp className="w-3.5 h-3.5" /> AI Top Picks
              </CardTitle>
            </CardHeader>
            <CardContent className="p-2">
              <SignalTable onSelectSymbol={setSelectedSymbol} selectedSymbol={selectedSymbol} />
            </CardContent>
          </Card>

          {/* ── 右欄：Backtest + Adaptive + K線 ── */}
          <div className="space-y-3">
            <BacktestCard />
            <AdaptiveParamsCard />
            {selectedStockId ? (
              <Card className="border-white/[0.06]" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <CardHeader className="pb-1 pt-2 px-3">
                  <CardTitle className="text-xs font-medium text-zinc-500 font-mono uppercase tracking-wider">
                    {selectedSymbol} Chart
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-1">
                  <CandlestickChart stockId={selectedStockId} />
                </CardContent>
              </Card>
            ) : (
              <div className="rounded-xl border border-dashed border-white/[0.06] p-8 text-center text-zinc-600 text-xs">
                點擊推薦股票載入 K 線
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
