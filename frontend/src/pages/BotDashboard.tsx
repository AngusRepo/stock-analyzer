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
  if (s.includes('STRONG_BUY')) return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">STRONG BUY</Badge>
  if (s.includes('BUY'))        return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">BUY</Badge>
  if (s.includes('STRONG_SELL'))return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">STRONG SELL</Badge>
  if (s.includes('SELL'))       return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">SELL</Badge>
  if (s.includes('NO_SIGNAL'))  return <Badge className="bg-zinc-500/20 text-zinc-400 border-zinc-500/30">NO SIGNAL</Badge>
  return <Badge className="bg-zinc-500/20 text-zinc-400 border-zinc-500/30">HOLD</Badge>
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-emerald-400' : 'bg-red-400'}`} />
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
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {/* 1. 總資產 + Total Return */}
      <Card className="bg-white/[0.03] border-white/[0.08] backdrop-blur-sm">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-zinc-500 uppercase tracking-wider">總資產</span>
            <DollarSign className="w-4 h-4 text-zinc-600" />
          </div>
          <div className="text-xl font-light text-zinc-100 font-mono">${fmt(totalAssets)}</div>
          <span className={`text-sm font-mono ${pctClass(totalReturn)}`}>
            {totalReturn >= 0 ? '+' : ''}{(totalReturn * 100).toFixed(2)}%
          </span>
        </CardContent>
      </Card>

      {/* 2. 年化報酬 */}
      <Card className="bg-white/[0.03] border-white/[0.08] backdrop-blur-sm">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-zinc-500 uppercase tracking-wider">年化報酬</span>
            <TrendingUp className="w-4 h-4 text-zinc-600" />
          </div>
          <div className={`text-xl font-light font-mono ${pctClass(annualizedReturn)}`}>
            {annualizedReturn >= 0 ? '+' : ''}{(annualizedReturn * 100).toFixed(1)}%
          </div>
          <span className="text-xs text-zinc-500">{Math.round(daysSinceStart)} 天</span>
        </CardContent>
      </Card>

      {/* 3. 最大回撤 */}
      <Card className="bg-white/[0.03] border-white/[0.08] backdrop-blur-sm">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-zinc-500 uppercase tracking-wider">最大回撤</span>
            <Shield className="w-4 h-4 text-zinc-600" />
          </div>
          <div className={`text-xl font-light font-mono ${maxDrawdown > 0.1 ? 'text-red-400' : maxDrawdown > 0.05 ? 'text-amber-400' : 'text-emerald-400'}`}>
            -{(maxDrawdown * 100).toFixed(1)}%
          </div>
        </CardContent>
      </Card>

      {/* 4. 夏普值 (30d) */}
      <Card className="bg-white/[0.03] border-white/[0.08] backdrop-blur-sm">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-zinc-500 uppercase tracking-wider">夏普值</span>
            <Award className="w-4 h-4 text-zinc-600" />
          </div>
          <div className={`text-xl font-light font-mono ${sharpe30d != null ? (sharpe30d > 1 ? 'text-emerald-400' : sharpe30d > 0 ? 'text-zinc-200' : 'text-red-400') : 'text-zinc-500'}`}>
            {sharpe30d != null ? sharpe30d.toFixed(2) : '-'}
          </div>
          <span className="text-xs text-zinc-500">30 日</span>
        </CardContent>
      </Card>

      {/* 5. 大盤比較（勝/負） */}
      <Card className="bg-white/[0.03] border-white/[0.08] backdrop-blur-sm">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-zinc-500 uppercase tracking-wider">大盤比較</span>
            <Scale className="w-4 h-4 text-zinc-600" />
          </div>
          <div className="flex items-center gap-3 mt-1">
            <div className="text-center">
              <div className="text-[10px] text-zinc-500">週</div>
              <WinLossBadge win={beatsBenchmark(retWeek, bmWeek)} />
            </div>
            <div className="text-center">
              <div className="text-[10px] text-zinc-500">月</div>
              <WinLossBadge win={beatsBenchmark(retMonth, bmMonth)} />
            </div>
            <div className="text-center">
              <div className="text-[10px] text-zinc-500">季</div>
              <WinLossBadge win={beatsBenchmark(retQuarter, bmQuarter)} />
            </div>
          </div>
          <span className="text-[10px] text-zinc-600 mt-1 block">vs 0050</span>
        </CardContent>
      </Card>

      {/* 6. 近期報酬 */}
      <Card className="bg-white/[0.03] border-white/[0.08] backdrop-blur-sm">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-zinc-500 uppercase tracking-wider">近期報酬</span>
            <Percent className="w-4 h-4 text-zinc-600" />
          </div>
          <div className="space-y-0.5 mt-1">
            {[
              { label: '週', val: retWeek },
              { label: '月', val: retMonth },
              { label: '季', val: retQuarter },
            ].map(({ label, val }) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-500">{label}</span>
                <span className={`text-xs font-mono ${val != null ? pctClass(val) : 'text-zinc-600'}`}>
                  {val != null ? `${val >= 0 ? '+' : ''}${(val * 100).toFixed(1)}%` : '-'}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Today's ML Signals ─────────────────────────────────────────────────────

function SignalTable() {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10) // TW date
  const yesterday = (() => { const d = new Date(Date.now() + 8 * 3600_000 - 86400_000); return d.toISOString().slice(0, 10) })()

  const [expanded, setExpanded] = useState<string | null>(null)

  // 先查今天
  const { data: todayData, isLoading } = useQuery({
    queryKey: ['recommendations', 'daily', today],
    queryFn: () => recommendationsApi.daily(today),
    staleTime: 5 * 60_000,
  })
  const todayRecs = todayData?.recommendations ?? todayData?.data ?? []

  // 今天沒資料 → fallback 昨天
  const { data: yesterdayData } = useQuery({
    queryKey: ['recommendations', 'daily', yesterday],
    queryFn: () => recommendationsApi.daily(yesterday),
    staleTime: 5 * 60_000,
    enabled: !isLoading && todayRecs.length === 0,
  })
  const yesterdayRecs = yesterdayData?.recommendations ?? yesterdayData?.data ?? []

  const recs = todayRecs.length > 0 ? todayRecs : yesterdayRecs
  const showingDate = todayRecs.length > 0 ? today : yesterday

  if (isLoading) return <div className="text-zinc-500 text-sm p-4">Loading signals...</div>
  if (!recs.length) return <div className="text-zinc-500 text-sm p-4">No signals available</div>

  return (
    <div className="overflow-x-auto">
      <div className="px-2 py-1 text-[10px] text-zinc-500">
        {showingDate === today ? `${today} 推薦` : `${showingDate} 推薦 → 今日執行`}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-zinc-500 text-xs uppercase border-b border-zinc-800">
            <th className="text-left p-2">Symbol</th>
            <th className="text-left p-2">Signal</th>
            <th className="text-right p-2">Conf</th>
            <th className="text-right p-2 hidden sm:table-cell">Price</th>
            <th className="text-right p-2 hidden md:table-cell">Score</th>
          </tr>
        </thead>
        <tbody>
          {recs.slice(0, 20).map((r: any) => {
            const isOpen = expanded === r.symbol
            const watchPoints = Array.isArray(r.watch_points) ? r.watch_points : []
            return (
              <Fragment key={r.symbol}>
                <tr className="border-b border-zinc-800/50 hover:bg-zinc-800/30 cursor-pointer"
                  onClick={() => setExpanded(isOpen ? null : r.symbol)}>
                  <td className="p-2">
                    <div className="font-mono text-zinc-200">{r.symbol}</div>
                    <div className="text-xs text-zinc-500">{r.name}</div>
                  </td>
                  <td className="p-2">{signalBadge(r.signal)}</td>
                  <td className="p-2 text-right font-mono text-zinc-300">{(r.confidence * 100).toFixed(0)}%</td>
                  <td className="p-2 text-right font-mono text-zinc-300 hidden sm:table-cell">${fmt(r.current_price, 1)}</td>
                  <td className="p-2 text-right font-mono text-zinc-400 hidden md:table-cell">{r.score?.toFixed(1) ?? '-'}</td>
                </tr>
                {isOpen && (
                  <tr className="bg-zinc-900/50">
                    <td colSpan={5} className="p-3 space-y-2">
                      {/* Score breakdown */}
                      <div className="flex gap-3 text-xs">
                        <span className="text-zinc-400">籌碼 <span className="text-zinc-200 font-mono">{r.chip_score ?? 0}</span>/40</span>
                        <span className="text-zinc-400">技術 <span className="text-zinc-200 font-mono">{r.tech_score ?? 0}</span>/30</span>
                        <span className="text-zinc-400">ML <span className="text-zinc-200 font-mono">{r.ml_score ?? 0}</span>/30</span>
                        <span className="text-zinc-500">{r.sector}</span>
                      </div>
                      {/* Reason */}
                      {r.reason && (
                        <p className="text-xs text-zinc-300 leading-relaxed">{r.reason}</p>
                      )}
                      {/* Watch points */}
                      {watchPoints.length > 0 && (
                        <ul className="text-xs text-amber-400/80 space-y-0.5">
                          {watchPoints.map((w: string, i: number) => (
                            <li key={i}>- {w}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
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
              <th className="text-right p-2">市值</th>
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
                  <td className="p-2 text-right font-mono text-zinc-400">${fmt(marketValue)}</td>
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
                  {o.created_at?.slice(5, 16)?.replace('T', ' ') ?? '-'}
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
                      {log.timestamp.slice(11, 19)} UTC
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

  const allSnapshots: any[] = data?.snapshots ?? data?.daily ?? []
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

  // Base values for % calc
  const baseVal = snapshots[0]?.total_value ?? snapshots[0]?.portfolio_value ?? 1_000_000
  const baseBm = snapshots[0]?.benchmark_value
  const hasBenchmark = baseBm != null && baseBm > 0

  const chartData = snapshots.map((s: any) => {
    const val = s.total_value ?? s.portfolio_value ?? baseVal
    const bm = s.benchmark_value
    return {
      date: s.date?.slice(5) ?? '',
      bot: ((val / baseVal) - 1) * 100,
      ...(hasBenchmark && bm != null ? { benchmark: ((bm / baseBm) - 1) * 100 } : {}),
    }
  })

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

      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={chartData}>
          <XAxis dataKey="date" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v.toFixed(1)}%`} />
          <Tooltip
            contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }}
            labelStyle={{ color: '#a1a1aa' }}
            formatter={(v: number, name: string) => [
              `${v.toFixed(2)}%`,
              name === 'bot' ? 'Bot' : '0050',
            ]}
          />
          <Line type="monotone" dataKey="bot" stroke="#10b981" strokeWidth={2} dot={false} name="bot" />
          {hasBenchmark && (
            <Line type="monotone" dataKey="benchmark" stroke="#6366f1" strokeWidth={1.5} dot={false} strokeDasharray="4 2" name="benchmark" />
          )}
          <Legend
            formatter={(value) => <span className="text-xs text-zinc-400">{value === 'bot' ? 'Bot' : '0050'}</span>}
            iconSize={10}
          />
        </LineChart>
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
  const [tab, setTab] = useState('signals')
  const { isAuthenticated, login } = useAuth()

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 z-0">
          <div className="absolute" style={{ left: '-15%', top: '10%', width: '55vw', height: '55vh', background: 'radial-gradient(ellipse at center, rgba(20,184,166,0.20) 0%, transparent 70%)' }} />
          <div className="absolute" style={{ right: '-10%', top: '0%', width: '45vw', height: '55vh', background: 'radial-gradient(ellipse at center, rgba(255,255,255,0.08) 0%, transparent 70%)' }} />
        </div>
        <div className="relative z-10 text-center space-y-4">
          <Bot className="w-12 h-12 mx-auto text-emerald-400/60" />
          <p className="text-zinc-400">請先登入以查看 Bot Dashboard</p>
          <button onClick={login} className="px-4 py-2 bg-emerald-600/80 hover:bg-emerald-500 border border-emerald-500/30 backdrop-blur-sm rounded-lg text-sm">
            Google 登入
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 relative overflow-x-hidden">
      {/* Background Glow Blobs */}
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute" style={{ left: '-15%', top: '10%', width: '55vw', height: '55vh', background: 'radial-gradient(ellipse at center, rgba(20,184,166,0.20) 0%, transparent 70%)' }} />
        <div className="absolute" style={{ right: '-10%', top: '0%', width: '45vw', height: '55vh', background: 'radial-gradient(ellipse at center, rgba(255,255,255,0.08) 0%, transparent 70%)' }} />
        <div className="absolute" style={{ left: '20%', bottom: '5%', width: '35vw', height: '35vh', background: 'radial-gradient(ellipse at center, rgba(16,185,129,0.12) 0%, transparent 70%)' }} />
      </div>
      {/* Header */}
      <header className="border-b border-white/[0.08] px-4 py-3 flex items-center justify-between sticky top-0 bg-zinc-950/80 backdrop-blur-xl z-10">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-emerald-400" />
          <h1 className="text-lg font-light tracking-tight">StockVision Bot</h1>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">
            <StatusDot ok={true} />
            <span className="ml-1">Online</span>
          </Badge>
          <a href="/" className="text-xs text-zinc-500 hover:text-zinc-300 ml-2">Dashboard</a>
        </div>
      </header>

      <main className="relative z-10 max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Portfolio Summary */}
        <PortfolioSummary />

        {/* Performance Chart */}
        <Card className="bg-white/[0.03] border-white/[0.08] backdrop-blur-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-zinc-400 flex items-center gap-2">
              <Activity className="w-4 h-4" /> Performance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <PerformanceChart />
          </CardContent>
        </Card>

        {/* Backtest Results */}
        <BacktestCard />

        {/* Adaptive Params */}
        <AdaptiveParamsCard />

        {/* Tabbed Content */}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm p-1">
            <TabsTrigger value="signals" className="data-[state=active]:bg-white/[0.1] text-xs">
              <TrendingUp className="w-3.5 h-3.5 mr-1" /> Signals
            </TabsTrigger>
            <TabsTrigger value="positions" className="data-[state=active]:bg-white/[0.1] text-xs">
              <BarChart3 className="w-3.5 h-3.5 mr-1" /> Positions
            </TabsTrigger>
            <TabsTrigger value="history" className="data-[state=active]:bg-white/[0.1] text-xs">
              <Clock className="w-3.5 h-3.5 mr-1" /> History
            </TabsTrigger>
            <TabsTrigger value="status" className="data-[state=active]:bg-white/[0.1] text-xs">
              <Bot className="w-3.5 h-3.5 mr-1" /> Status
            </TabsTrigger>
          </TabsList>

          <Card className="bg-white/[0.03] border-white/[0.08] backdrop-blur-sm mt-3">
            <CardContent className="p-0">
              <TabsContent value="signals" className="mt-0"><SignalTable /></TabsContent>
              <TabsContent value="positions" className="mt-0"><PositionsTable /></TabsContent>
              <TabsContent value="history" className="mt-0"><TradeHistory /></TabsContent>
              <TabsContent value="status" className="mt-0 p-4"><BotStatusPanel /></TabsContent>
            </CardContent>
          </Card>
        </Tabs>
      </main>
    </div>
  )
}
