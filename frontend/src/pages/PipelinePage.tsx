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
import DailyPipelineRunLane from '@/components/charts/DailyPipelineRunLane'
import {
  Filter, Brain, Star, Scale, ChevronDown, ChevronUp,
  TrendingUp, TrendingDown, Minus,
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

function parseMaybeJson(raw: unknown): Record<string, any> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, any>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function buildScreenerSectorSummary(recs: any[]) {
  const bySector = new Map<string, {
    sector: string
    count: number
    scoreSum: number
    chipSum: number
    techSum: number
    symbols: string[]
    reasons: Set<string>
    themeReasons: Set<string>
    flowReasons: Set<string>
    rotationReasons: Set<string>
    strategyReasons: Set<string>
  }>()

  for (const rec of recs) {
    const sector = String(rec.industry || rec.sector || rec.market_segment || '未分類')
    const row = bySector.get(sector) ?? {
      sector,
      count: 0,
      scoreSum: 0,
      chipSum: 0,
      techSum: 0,
      symbols: [],
      reasons: new Set<string>(),
      themeReasons: new Set<string>(),
      flowReasons: new Set<string>(),
      rotationReasons: new Set<string>(),
      strategyReasons: new Set<string>(),
    }
    row.count += 1
    row.scoreSum += Number(rec.score ?? 0)
    row.chipSum += Number(rec.chip_score ?? 0)
    row.techSum += Number(rec.tech_score ?? 0)
    if (rec.symbol && row.symbols.length < 4) row.symbols.push(String(rec.symbol))
    if (rec.screener_funnel_reason) row.reasons.add(String(rec.screener_funnel_reason))
    const evidence = parseMaybeJson(rec.screener_funnel_evidence)
    const rrg = parseMaybeJson(evidence.rrg_overlay ?? evidence.rrg)
    const strategyIds = evidence.strategy_ids ?? rec.strategy_pool_ids ?? []
    const keywords = [
      ...(Array.isArray(evidence.keywords) ? evidence.keywords : []),
      ...(Array.isArray(evidence.theme_keywords) ? evidence.theme_keywords : []),
      ...(Array.isArray(evidence.top_keywords) ? evidence.top_keywords : []),
    ].filter(Boolean).slice(0, 3)
    if (rrg.quadrant) row.rotationReasons.add(`RRG ${rrg.quadrant}`)
    if (evidence.buzz_score != null || evidence.buzz_z != null) {
      row.themeReasons.add(keywords.length ? `題材熱度：${keywords.join('、')}` : '題材熱度升溫')
    }
    if (evidence.theme_sources) row.themeReasons.add(`來源：${String(evidence.theme_sources).slice(0, 32)}`)
    if (Number(rec.chip_score ?? 0) >= 28) row.flowReasons.add('籌碼分數偏強')
    if (Number(rec.tech_score ?? 0) >= 22) row.rotationReasons.add('技術動能偏強')
    if (evidence.broker_flow || evidence.foreign_flow || evidence.chip_flow) row.flowReasons.add('資金/券商流向支撐')
    if (evidence.sector_flow || evidence.diversity_slot != null || evidence.diversity_reason) row.rotationReasons.add('族群輪動/分散控管')
    if (Array.isArray(strategyIds) && strategyIds.length) row.strategyReasons.add(`策略池：${strategyIds.slice(0, 3).join('、')}`)
    if (rec.strategy_pool_reason || evidence.strategy_pool_reason) row.strategyReasons.add(String(rec.strategy_pool_reason ?? evidence.strategy_pool_reason).slice(0, 48))
    if (evidence.cooldown_penalty != null) row.reasons.add('冷卻檢查')
    bySector.set(sector, row)
  }

  return [...bySector.values()]
    .map((row) => ({
      ...row,
      avgScore: row.count ? row.scoreSum / row.count : 0,
      avgChip: row.count ? row.chipSum / row.count : 0,
      avgTech: row.count ? row.techSum / row.count : 0,
      themeText: [...row.themeReasons].slice(0, 2).join(' / ') || '題材未提供明確關鍵字',
      flowText: [...row.flowReasons].slice(0, 2).join(' / ') || '資金流以分數代理',
      rotationText: [...row.rotationReasons].slice(0, 2).join(' / ') || '族群輪動無明確標籤',
      strategyText: [...row.strategyReasons].slice(0, 2).join(' / ') || '未標策略池',
      reasonText: [...row.reasons].slice(0, 2).join(' / ') || '多因子通過',
    }))
    .sort((a, b) => b.count - a.count || b.avgScore - a.avgScore)
    .slice(0, 8)
}

// ─── Step indicator ────────────────────────────────────────────────────────
const CANDIDATE_SOURCE_BUCKETS = [
  { key: 'strategy', label: '策略池', color: 'bg-cyan-300' },
  { key: 'theme', label: '題材/新聞', color: 'bg-amber-300' },
  { key: 'taxonomy', label: '產業分類', color: 'bg-violet-300' },
  { key: 'chipTech', label: '籌碼/技術', color: 'bg-emerald-300' },
  { key: 'ml', label: 'ML 投票', color: 'bg-sky-300' },
] as const

type CandidateSourceKey = typeof CANDIDATE_SOURCE_BUCKETS[number]['key']

function hasCandidateSource(rec: any, key: CandidateSourceKey) {
  const evidence = parseMaybeJson(rec.screener_funnel_evidence)
  const strategyIds = evidence.strategy_ids ?? rec.strategy_pool_ids ?? []
  const haystack = [
    rec.reason,
    rec.screener_funnel_reason,
    rec.strategy_pool_reason,
    evidence.reason,
    evidence.reason_code,
    evidence.diversity_reason,
    evidence.source,
    evidence.sources,
    evidence.theme_sources,
  ].filter(Boolean).join(' ').toLowerCase()

  if (key === 'strategy') {
    return (Array.isArray(strategyIds) && strategyIds.length > 0) || Boolean(rec.strategy_pool_reason || evidence.strategy_pool_reason)
  }
  if (key === 'theme') {
    return evidence.buzz_score != null || evidence.buzz_z != null || /ptt|anue|avenue|cnyes|gdelt|news|buzz|keyword|theme|題材|新聞|熱度/.test(haystack)
  }
  if (key === 'taxonomy') {
    return Boolean(rec.industryTheme || rec.industry || rec.sector || evidence.taxonomy || evidence.industry_theme || evidence.diversity_slot)
  }
  if (key === 'chipTech') {
    return Number(rec.chip_score ?? 0) > 0 || Number(rec.tech_score ?? 0) > 0 || /chip|broker|foreign|technical|籌碼|法人|券商|技術|rrg/.test(haystack)
  }
  if (key === 'ml') {
    return rec.ml_score != null || Boolean(rec.signal) || /ml|model|alpha|vote|predict/.test(haystack)
  }
  return false
}

function buildCandidateSourceProfile(rows: any[]) {
  const counts = CANDIDATE_SOURCE_BUCKETS.map((bucket) => ({
    ...bucket,
    count: rows.filter((rec) => hasCandidateSource(rec, bucket.key)).length,
  }))
  const totalEvidence = counts.reduce((sum, item) => sum + item.count, 0)
  return { counts, totalEvidence }
}

function CandidateSourceMixChart({
  screener,
  recommendations,
  pending,
}: {
  screener: any[]
  recommendations: any[]
  pending: any[]
}) {
  const rows = [
    { label: '初篩候選', items: screener },
    { label: '推薦池', items: recommendations },
    { label: 'T2 pending', items: pending },
  ].filter((row) => row.items.length > 0)

  if (!rows.length) return null

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">候選來源組成</CardTitle>
        <p className="text-xs text-muted-foreground">把同一批候選拆成策略、題材新聞、分類、籌碼技術與 ML evidence；用來檢查是不是每天都靠同一種來源在推股。</p>
      </CardHeader>
      <CardContent className="grid gap-3 xl:grid-cols-3">
        {rows.map((row) => {
          const profile = buildCandidateSourceProfile(row.items)
          return (
            <div key={row.label} className="rounded-xl border border-border/80 bg-background/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">{row.label}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{row.items.length} 檔 / {profile.totalEvidence} 個 evidence tag</p>
                </div>
                <Badge variant="outline" className="font-mono text-[10px]">{row.items.length}</Badge>
              </div>
              <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-muted">
                {profile.counts.map((bucket) => (
                  <div
                    key={bucket.key}
                    className={`${bucket.color} min-w-[2px]`}
                    style={{ width: `${profile.totalEvidence ? Math.max(3, (bucket.count / profile.totalEvidence) * 100) : 0}%` }}
                    title={`${bucket.label}: ${bucket.count}`}
                  />
                ))}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {profile.counts.map((bucket) => (
                  <div key={bucket.key} className="rounded-lg border border-border/70 bg-background/50 px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${bucket.color}`} />
                      <span className="text-[11px] text-muted-foreground">{bucket.label}</span>
                    </div>
                    <div className="mt-1 font-mono text-sm font-semibold">{bucket.count}</div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

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
function DebateTurnsList({ turns }: { turns: any[] }) {
  const cleanTurns = Array.isArray(turns)
    ? turns.filter((turn) => turn && typeof turn === 'object' && (turn.summary || turn.agent))
    : []
  if (!cleanTurns.length) {
    return (
      <div className="rounded-lg border border-border/70 bg-background/45 p-2 text-[11px] leading-5 text-muted-foreground">
        這筆是舊 run 或 controller 尚未回傳 agent turns；目前只保存 verdict / execution terminal。
      </div>
    )
  }
  const agentLabel: Record<string, string> = {
    theme: 'Theme Agent',
    bull: 'Bull Agent',
    bear: 'Bear Agent',
    risk: 'Risk Agent',
    judge: 'Final Judge',
    zealot: 'Bull Agent',
    reaper: 'Bear/Risk Agent',
    fulcrum: 'Final Judge',
  }
  return (
    <div className="space-y-1 rounded-lg border border-border/70 bg-background/45 p-2">
      <p className="text-[11px] font-semibold text-foreground">逐輪辯論</p>
      {cleanTurns.slice(0, 8).map((turn, i) => {
        const key = String(turn.agent ?? '').toLowerCase()
        const label = agentLabel[key] ?? String(turn.agent ?? `Round ${i + 1}`)
        return (
          <div key={`${label}-${i}`} className="grid gap-1 rounded-md border border-border/50 px-2 py-1.5 text-[11px] md:grid-cols-[120px_minmax(0,1fr)]">
            <div>
              <span className="font-semibold text-primary">{label}</span>
              {turn.round != null ? <span className="ml-1 font-mono text-muted-foreground">R{turn.round}</span> : null}
            </div>
            <p className="leading-5 text-muted-foreground">{String(turn.summary ?? turn.text ?? '-')}</p>
          </div>
        )
      })}
    </div>
  )
}

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
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/70 bg-background/45 p-2">
            <span>debate <b className="font-mono text-foreground">{buy.debate_verdict ?? buy.debate_status ?? '-'}</b></span>
            <span>execution <b className="font-mono text-foreground">{buy.execution_status ?? 'pending'}</b></span>
          </div>
          <DebateTurnsList turns={buy.debate_turns ?? buy.debateTurns ?? []} />
          {Array.isArray(buy.watch_points) && buy.watch_points.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {buy.watch_points.slice(0, 5).map((point: string) => (
                <Badge key={point} variant="outline" className="text-[10px]">{point}</Badge>
              ))}
            </div>
          )}
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
  const screenerPassed = allRecs
  const mlBuy = allRecs.filter((r: any) => ['BUY', 'STRONG_BUY'].includes(r.signal))
  const mlHold = allRecs.filter((r: any) => r.signal === 'HOLD')
  const mlSell = allRecs.filter((r: any) => ['SELL', 'STRONG_SELL'].includes(r.signal))
  const mlNoSignal = allRecs.filter((r: any) => !r.signal || r.signal === 'NO_SIGNAL')
  const screenerPreview = [...screenerPassed]
    .sort((a: any, b: any) => (b.chip_score ?? 0) + (b.tech_score ?? 0) - ((a.chip_score ?? 0) + (a.tech_score ?? 0)))
    .slice(0, 10)
  const screenerSectorSummary = buildScreenerSectorSummary(screenerPassed)
  const recommendationPreview = [...mlBuy, ...mlHold]
    .sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 10)

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
      <div className="p-4 lg:p-5 space-y-4 text-sm">

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

        <DailyPipelineRunLane
          recommendations={allRecs}
          pendingBuys={pendingBuys}
          quadrantFilters={qfList}
          recDate={recDate}
          loading={isLoading}
        />

        {!isLoading && (
          <CandidateSourceMixChart
            screener={screenerPassed}
            recommendations={recommendationPreview.length ? recommendationPreview : screenerPreview}
            pending={pendingBuys}
          />
        )}

        {/* Pipeline flow indicator */}
        <div className="grid gap-2 rounded-2xl border border-[#3a3125] bg-[#171714] px-4 py-3 md:grid-cols-4">
          {[
            { label: '初篩', count: screenerPassed.length, color: 'text-[#9fcca1]' },
            { label: '模型判斷', count: allRecs.filter((r: any) => r.ml_score != null).length, color: 'text-[#d7b98c]' },
            { label: '推薦整理', count: mlBuy.length + mlHold.length, color: 'text-[#f1c16f]' },
            { label: '辯論掛單', count: pendingBuys.length, color: 'text-[#d6a85f]' },
          ].map((step, i) => (
            <div key={step.label} className="flex items-center gap-2 shrink-0">
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
          <div className="grid gap-4 xl:grid-cols-4">

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
                <div className="space-y-2">
                  {screenerSectorSummary.map((row, i) => (
                    <div key={row.sector} className="rounded-lg border border-border bg-background/35 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{i + 1}. {row.sector}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {row.reasonText}；代表股 {row.symbols.join('、') || '-'}
                          </p>
                        </div>
                        <Badge variant="outline" className="font-mono text-[10px]">{row.count} 檔</Badge>
                      </div>
                      <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
                        <p><span className="text-amber-300">題材</span>：{row.themeText}</p>
                        <p><span className="text-emerald-300">資金</span>：{row.flowText}</p>
                        <p><span className="text-sky-300">族群輪動</span>：{row.rotationText}</p>
                        <p><span className="text-violet-300">策略</span>：{row.strategyText}</p>
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-muted-foreground">
                        <span>均分 <b className="font-mono text-foreground">{fmt(row.avgScore, 1)}</b></span>
                        <span>籌碼 <b className="font-mono text-foreground">{fmt(row.avgChip, 1)}</b></span>
                        <span>技術 <b className="font-mono text-foreground">{fmt(row.avgTech, 1)}</b></span>
                      </div>
                    </div>
                  ))}
                  {screenerPassed.length > screenerPreview.length && (
                    <p className="px-3 pt-1 text-[11px] text-muted-foreground">初篩摘要以產業/題材聚合呈現；完整股票清單往後看 ML 與推薦整理。</p>
                  )}
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
                <div className="grid grid-cols-1 gap-3">
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
                <div className="space-y-0.5">
                  {recommendationPreview
                    .map((rec: any, i: number) => (
                      <StockRow key={rec.symbol ?? i} rec={rec} rank={i + 1} />
                    ))
                  }
                  {(mlBuy.length + mlHold.length) > recommendationPreview.length && (
                    <p className="px-3 pt-2 text-[11px] text-muted-foreground">另有 {(mlBuy.length + mlHold.length) - recommendationPreview.length} 檔保留觀察；這格只看 ML/Alpha 後排序。</p>
                  )}
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
                    目前沒有 active pending buys；若今天曾產生候選但已被 skipped/cancelled/expired/rejected，請到模擬交易頁查看 terminal 狀態。
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
