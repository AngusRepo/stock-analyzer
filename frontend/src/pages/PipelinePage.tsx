/**
 * PipelinePage — 每日選股流程總覽
 *
 * 顯示完整 pipeline：Screener → ML → Recommendation → T2 Debate
 * 讓使用者看到每個階段選了哪些股票、為什麼選
 */
import { useQuery } from '@tanstack/react-query'
import { recommendationsApi, paperApi } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import AppShell from '@/components/AppShell'
import {
  Filter, Brain, Star, Scale, ChevronDown, ChevronUp,
  TrendingUp, TrendingDown, Minus, Zap, ArrowRight,
} from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '@/_core/hooks/useAuth'

// ─── Signal config ─────────────────────────────────────────────────────────
const SIGNAL_STYLE: Record<string, { label: string; cls: string }> = {
  STRONG_BUY: { label: '強烈買進', cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
  BUY:        { label: '買進',     cls: 'bg-red-500/10 text-red-400 border-red-500/20' },
  HOLD:       { label: '觀望',     cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' },
  SELL:       { label: '賣出',     cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
  STRONG_SELL:{ label: '強烈賣出', cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
}

function fmt(n: number | null | undefined, decimals = 0): string {
  if (n == null) return '-'
  return n.toLocaleString('zh-TW', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

// ─── Step indicator ────────────────────────────────────────────────────────
function StepHeader({ step, icon: Icon, title, subtitle, count, color }: {
  step: number; icon: any; title: string; subtitle: string; count?: number; color: string
}) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold ${color}`}>
        {step}
      </div>
      <Icon className="w-4 h-4 text-muted-foreground" />
      <div className="flex-1">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </div>
      {count != null && (
        <Badge variant="outline" className="font-mono text-xs">{count} 檔</Badge>
      )}
    </div>
  )
}

// ─── Score bar ─────────────────────────────────────────────────────────────
function ScoreBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-8 text-muted-foreground shrink-0">{label}</span>
      <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right font-mono text-muted-foreground">{value}/{max}</span>
    </div>
  )
}

// ─── Expandable stock row ──────────────────────────────────────────────────
function StockRow({ rec, rank }: { rec: any; rank: number }) {
  const [expanded, setExpanded] = useState(false)
  const sig = SIGNAL_STYLE[rec.signal] ?? SIGNAL_STYLE['HOLD']

  return (
    <div className={`border rounded-lg transition-all ${expanded ? 'border-border bg-card' : 'border-transparent hover:bg-card/50'}`}>
      <div
        className="flex items-center gap-3 px-3 py-2 cursor-pointer select-none"
        onClick={() => setExpanded(v => !v)}
      >
        <span className="text-xs text-muted-foreground font-mono w-5 text-right">{rank}</span>
        <span className="font-semibold text-sm w-14 font-mono">{rec.symbol}</span>
        <span className="text-xs text-muted-foreground truncate flex-1 max-w-[80px]">{rec.name}</span>
        {rec.sector && <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0">{rec.sector}</Badge>}
        <Badge className={`text-[10px] px-1.5 py-0 border ${sig.cls}`}>{sig.label}</Badge>
        <span className="text-sm font-bold font-mono text-primary w-8 text-right">{Math.round(rec.score)}</span>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
      </div>
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border space-y-2">
          <div className="space-y-1">
            <ScoreBar label="籌碼" value={rec.chip_score ?? 0} max={40} color="bg-blue-500" />
            <ScoreBar label="技術" value={rec.tech_score ?? 0} max={30} color="bg-purple-500" />
            <ScoreBar label="ML" value={rec.ml_score ?? 0} max={30} color="bg-emerald-500" />
          </div>
          {rec.reason && (
            <p className="text-xs text-muted-foreground leading-relaxed">{rec.reason}</p>
          )}
          <div className="flex gap-4 text-[11px] text-muted-foreground">
            {rec.current_price && <span>現價 <span className="font-mono">${fmt(rec.current_price, 2)}</span></span>}
            {rec.rsi14 && <span>RSI <span className="font-mono">{rec.rsi14.toFixed(1)}</span></span>}
            {rec.confidence && <span>信心度 <span className="font-mono">{(rec.confidence * 100).toFixed(0)}%</span></span>}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── T2 Pending Buy row ────────────────────────────────────────────────────
function T2BuyRow({ buy, rank }: { buy: any; rank: number }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={`border rounded-lg transition-all ${expanded ? 'border-primary/20 bg-card' : 'border-transparent hover:bg-card/50'}`}>
      <div
        className="flex items-center gap-3 px-3 py-2 cursor-pointer select-none"
        onClick={() => setExpanded(v => !v)}
      >
        <span className="text-xs text-muted-foreground font-mono w-5 text-right">{rank}</span>
        <span className="font-semibold text-sm w-14 font-mono">{buy.symbol}</span>
        <span className="text-xs text-muted-foreground truncate flex-1 max-w-[80px]">{buy.name}</span>
        <Badge className="text-[10px] px-1.5 py-0 border bg-red-500/10 text-red-400 border-red-500/20">
          {buy.signal ?? 'BUY'}
        </Badge>
        {buy.confidence != null && (
          <span className="text-xs font-mono text-muted-foreground">信心度 {(buy.confidence * 100).toFixed(0)}%</span>
        )}
        <span className="text-sm font-bold font-mono text-primary w-8 text-right">{Math.round(buy.score ?? 0)}</span>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
      </div>
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border space-y-2 text-xs text-muted-foreground">
          <div className="grid grid-cols-3 gap-2">
            <div>限價 <span className="font-mono text-foreground">${fmt(buy.ml_entry_price, 1)}</span></div>
            <div>停損 <span className="font-mono text-emerald-400">${fmt(buy.ml_stop_loss, 1)}</span></div>
            <div>目標 <span className="font-mono text-red-400">${fmt(buy.ml_target1, 1)}</span></div>
          </div>
          {buy.reason && <p className="leading-relaxed">{buy.reason}</p>}
          <div className="flex gap-3">
            {buy.chip_score != null && <span>籌碼 <span className="font-mono">{buy.chip_score}/40</span></span>}
            {buy.tech_score != null && <span>技術 <span className="font-mono">{buy.tech_score}/30</span></span>}
            {buy.ml_score != null && <span>ML <span className="font-mono">{buy.ml_score}/30</span></span>}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Pipeline Page ────────────────────────────────────────────────────
export default function PipelinePage() {
  const { isAuthenticated, login } = useAuth()
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  // Stage 1+2+3: Daily recommendations (screener → ML → filtered)
  const { data: recData, isLoading: recLoading } = useQuery({
    queryKey: ['recommendations', 'daily', today],
    queryFn: () => recommendationsApi.daily(),
    staleTime: 10 * 60_000,
  })

  // Stage 4: T2 Debate filtered pending buys
  const { data: pbData, isLoading: pbLoading } = useQuery({
    queryKey: ['paper', 'pending-buys'],
    queryFn: () => paperApi.pendingBuys(),
    staleTime: 10 * 60_000,
  })

  // Quadrant filter
  const { data: qfData } = useQuery({
    queryKey: ['paper', 'quadrant-filter'],
    queryFn: () => paperApi.quadrantFilter(),
    staleTime: 10 * 60_000,
  })

  const allRecs = recData?.recommendations ?? []
  const recDate = recData?.date ?? today
  const pendingBuys = pbData?.pendingBuys ?? []
  const pbDate = pbData?.date ?? ''
  const qfList = Array.isArray(qfData?.filters) ? qfData.filters : Array.isArray(qfData) ? qfData : []

  // Stage breakdown
  const screenerPassed = allRecs // All 25 from screener
  const mlBuy = allRecs.filter((r: any) => ['BUY', 'STRONG_BUY'].includes(r.signal))
  const mlHold = allRecs.filter((r: any) => r.signal === 'HOLD')
  const mlSell = allRecs.filter((r: any) => ['SELL', 'STRONG_SELL'].includes(r.signal))
  const mlNoSignal = allRecs.filter((r: any) => !r.signal || r.signal === 'NO_SIGNAL')

  const isLoading = recLoading || pbLoading

  if (!isAuthenticated) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-full p-4">
          <div className="rounded-2xl border border-[#3a3125] bg-[#171714]/90 p-6 text-center space-y-4">
            <Filter className="w-12 h-12 mx-auto text-[#d6a85f]/80" />
            <p className="text-[#b9b1a1]">請先登入以查看每日流程</p>
            <button onClick={login} className="rounded-full border border-[#d6a85f]/35 bg-[#d6a85f]/90 px-4 py-2 text-sm text-[#171714] hover:bg-[#f1c16f]">
              Google 登入
            </button>
          </div>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="p-4 lg:p-5 space-y-4 text-sm max-w-6xl">

        {/* Page header */}
        <div className="rounded-2xl border border-[#3a3125] bg-[linear-gradient(135deg,#1f211c,#171714_58%,#241a11)] p-4 shadow-[0_18px_70px_rgba(0,0,0,0.18)] flex items-center justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#d6a85f]">Daily flow</p>
            <h1 className="mt-1 text-lg font-bold text-[#fff7e8]">每日流程</h1>
            <p className="mt-1 text-xs text-[#b9b1a1]">{recDate} 從初篩、模型、推薦到模擬掛單的節奏總覽</p>
          </div>
          <div className="hidden items-center gap-2 rounded-full border border-[#3a3125] bg-[#171714] px-3 py-2 text-xs text-[#b9b1a1] md:flex">
            <span className="font-mono">882 → {screenerPassed.length} → {mlBuy.length} 買進 → {pendingBuys.length} 掛單</span>
          </div>
        </div>

        {/* Pipeline flow indicator */}
        <div className="flex items-center gap-2 overflow-x-auto rounded-2xl border border-[#3a3125] bg-[#171714] px-4 py-3">
          {[
            { label: '初篩', count: screenerPassed.length, color: 'text-[#9fcca1]' },
            { label: '模型判斷', count: allRecs.filter((r: any) => r.ml_score != null).length, color: 'text-[#d7b98c]' },
            { label: '推薦整理', count: mlBuy.length + mlHold.length, color: 'text-[#f1c16f]' },
            { label: '辯論掛單', count: pendingBuys.length, color: 'text-[#d6a85f]' },
          ].map((step, i) => (
            <div key={step.label} className="flex items-center gap-2 shrink-0">
              {i > 0 && <ArrowRight className="w-3.5 h-3.5 text-muted-foreground/40" />}
              <div className="flex items-center gap-1.5">
                <span className={`text-lg font-bold font-mono ${step.color}`}>{step.count}</span>
                <span className="text-xs text-muted-foreground">{step.label}</span>
              </div>
            </div>
          ))}
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map(i => <div key={i} className="h-24 rounded-xl bg-muted/40 animate-pulse" />)}
          </div>
        ) : (
          <div className="space-y-4">

            {/* ═══ Step 1: Screener ═══ */}
            <Card className="border-border bg-card">
              <CardContent className="pt-4 pb-3">
                <StepHeader
                  step={1} icon={Filter}
                  title="自下而上初篩"
                  subtitle="全市場約 882 檔 → 多因子評分（籌碼 0-40、技術 0-30、動能 0-20）→ 同產業去重 → 前 25 名"
                  count={screenerPassed.length}
                  color="bg-blue-500/20 text-blue-400"
                />
                <div className="space-y-0.5 max-h-[400px] overflow-y-auto">
                  {screenerPassed
                    .sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0))
                    .map((rec: any, i: number) => (
                      <StockRow key={rec.symbol ?? i} rec={rec} rank={i + 1} />
                    ))
                  }
                </div>
              </CardContent>
            </Card>

            {/* ═══ Step 2: ML Predict ═══ */}
            <Card className="border-border bg-card">
              <CardContent className="pt-4 pb-3">
                <StepHeader
                  step={2} icon={Brain}
                  title="模型判斷"
                  subtitle="整合多模型投票與 signal_score，先分出買進、觀望與賣出，再交給下一層整理。"
                  count={allRecs.filter((r: any) => r.ml_score != null).length}
                  color="bg-purple-500/20 text-purple-400"
                />
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <TrendingUp className="w-3.5 h-3.5 text-red-400" />
                      <span className="text-xs font-medium text-red-400">BUY ({mlBuy.length})</span>
                    </div>
                    <div className="space-y-0.5">
                      {mlBuy.sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0)).map((r: any, i: number) => (
                        <div key={r.symbol} className="flex items-center gap-2 px-2 py-1 text-xs rounded hover:bg-muted/30">
                          <span className="font-mono font-semibold w-12">{r.symbol}</span>
                          <span className="text-muted-foreground truncate flex-1">{r.name}</span>
                          <span className="font-mono text-primary">{Math.round(r.score)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Minus className="w-3.5 h-3.5 text-yellow-400" />
                      <span className="text-xs font-medium text-yellow-400">HOLD ({mlHold.length})</span>
                    </div>
                    <div className="space-y-0.5">
                      {mlHold.sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0)).map((r: any, i: number) => (
                        <div key={r.symbol} className="flex items-center gap-2 px-2 py-1 text-xs rounded hover:bg-muted/30">
                          <span className="font-mono font-semibold w-12">{r.symbol}</span>
                          <span className="text-muted-foreground truncate flex-1">{r.name}</span>
                          <span className="font-mono text-muted-foreground">{Math.round(r.score)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <TrendingDown className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-xs font-medium text-emerald-400">賣出 / 無訊號 ({mlSell.length + mlNoSignal.length})</span>
                    </div>
                    <div className="space-y-0.5">
                      {[...mlSell, ...mlNoSignal].map((r: any) => (
                        <div key={r.symbol} className="flex items-center gap-2 px-2 py-1 text-xs rounded hover:bg-muted/30">
                          <span className="font-mono font-semibold w-12">{r.symbol}</span>
                          <span className="text-muted-foreground truncate flex-1">{r.name}</span>
                          <span className="font-mono text-muted-foreground/60">{r.signal ?? '—'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* ═══ Step 3: Recommendation Filter ═══ */}
            <Card className="border-border bg-card">
              <CardContent className="pt-4 pb-3">
                <StepHeader
                  step={3} icon={Star}
                  title="推薦整理"
                  subtitle="買進與觀望保留為觀察清單，賣出與無訊號排除；再補上可閱讀的推薦理由。"
                  count={mlBuy.length + mlHold.length}
                  color="bg-amber-500/20 text-amber-400"
                />
                <div className="space-y-0.5 max-h-[350px] overflow-y-auto">
                  {[...mlBuy, ...mlHold]
                    .sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0))
                    .map((rec: any, i: number) => (
                      <StockRow key={rec.symbol ?? i} rec={rec} rank={i + 1} />
                    ))
                  }
                </div>
              </CardContent>
            </Card>

            {/* ═══ Step 4: T2 Debate ═══ */}
            <Card className="border-border bg-card border-primary/20">
              <CardContent className="pt-4 pb-3">
                <StepHeader
                  step={4} icon={Scale}
                  title="辯論與模擬掛單"
                  subtitle={`Morning Setup 辯論 → RRG 象限過濾 → 限價掛單（${pbDate}）`}
                  count={pendingBuys.length}
                  color="bg-primary/20 text-primary"
                />
                {pendingBuys.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-6">
                    尚無 T2 掛單（每日 07:15 產生）
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {pendingBuys.map((buy: any, i: number) => (
                      <T2BuyRow key={buy.symbol} buy={buy} rank={i + 1} />
                    ))}
                  </div>
                )}

                {/* Quadrant filter log */}
                {qfList.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-border">
                    <p className="text-xs text-muted-foreground mb-2">RRG 象限過濾結果</p>
                    <div className="flex flex-wrap gap-1.5">
                      {qfList.map((q: any) => {
                        const qColor = q.quadrant === 'Leading' ? 'text-emerald-400' :
                                       q.quadrant === 'Improving' ? 'text-blue-400' :
                                       q.quadrant === 'Weakening' ? 'text-amber-400' : 'text-red-400'
                        return (
                          <Badge key={q.symbol} variant="outline" className="text-[10px] gap-1">
                            <span className="font-mono">{q.symbol}</span>
                            <span className={qColor}>{q.quadrant}</span>
                            <span className="text-muted-foreground">{q.action}</span>
                          </Badge>
                        )
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

          </div>
        )}
      </div>
    </AppShell>
  )
}
