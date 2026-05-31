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
  TrendingUp, TrendingDown, Minus,
} from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '@/_core/hooks/useAuth'
import { buildScoreBreakdownViewModel, type ScoreBreakdownViewModel } from '@/lib/scoreV2ViewModel'

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

function scoreFinalValue(rec: any): number {
  return buildScoreBreakdownViewModel(rec ?? {}).finalScore
}

function scoreComponentValue(scoreViewModel: ScoreBreakdownViewModel, key: string): number {
  return scoreViewModel.rows.find((row) => row.key === key)?.value ?? 0
}

function stageRetentionPct(current: number, previous: number): number {
  if (previous <= 0) return current > 0 ? 100 : 0
  return Math.max(0, Math.min(100, Math.round((current / previous) * 100)))
}

function PipelineCompressionVisual({
  stages,
  dropoffs,
}: {
  stages: Array<{
    key: string
    label: string
    detail: string
    count: number
    previousCount?: number
    icon: any
    color: string
    barColor: string
  }>
  dropoffs: Array<{ label: string; count: number; color: string }>
}) {
  const maxStageCount = Math.max(1, ...stages.map((stage) => stage.count))
  const maxDropoffCount = Math.max(1, ...dropoffs.map((item) => item.count))

  return (
    <section
      data-testid="pipeline-compression-visual"
      className="sv-content-card-selected rounded-2xl p-3"
    >
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="sv-accent-text font-mono text-[10px] uppercase tracking-[0.18em]">Pipeline Compression Map</p>
          <h2 className="sv-title-text mt-1 text-sm font-semibold">候選如何被壓縮成可執行清單</h2>
        </div>
        <div className="sv-surface-chip rounded-full px-3 py-1.5 font-mono text-[11px]">
          {stages[0]?.count ?? 0} → {stages[stages.length - 1]?.count ?? 0}
        </div>
      </div>

      <div className="grid gap-2 lg:grid-cols-4">
        {stages.map(({ key, label, detail, count, previousCount, icon: Icon, color, barColor }) => {
          const retention = previousCount == null ? 100 : stageRetentionPct(count, previousCount)
          const width = Math.max(8, Math.round((count / maxStageCount) * 100))
          return (
            <div key={key} className="sv-content-card rounded-xl p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Icon className={`h-4 w-4 shrink-0 ${color}`} />
                  <div className="min-w-0">
                    <p className="sv-title-text truncate text-xs font-semibold">{label}</p>
                    <p className="sv-muted-text mt-0.5 truncate text-[10px]">{detail}</p>
                  </div>
                </div>
                <span className="sv-title-text font-mono text-lg font-bold">{count}</span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-[color:var(--sv-panel-raised)]">
                <div className={`h-full rounded-full ${barColor}`} style={{ width: `${width}%` }} />
              </div>
              <div className="sv-muted-text mt-2 flex items-center justify-between font-mono text-[10px]">
                <span>{previousCount == null ? 'base pool' : `${retention}% kept`}</span>
                <span>{previousCount == null ? '100%' : `${Math.max(0, previousCount - count)} drop`}</span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-3">
        {dropoffs.map(({ label, count, color }) => {
          const width = Math.max(count > 0 ? 8 : 2, Math.round((count / maxDropoffCount) * 100))
          return (
            <div key={label} className="sv-content-card rounded-lg px-3 py-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="sv-muted-text truncate text-[11px]">{label}</span>
                <span className="sv-title-text font-mono text-xs">{count}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[color:var(--sv-panel-raised)]">
                <div className={`h-full rounded-full ${color}`} style={{ width: `${width}%` }} />
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function buildScreenerSectorSummary(recs: any[]) {
  const bySector = new Map<string, {
    sector: string
    count: number
    scoreSum: number
    chipFlowSum: number
    technicalStructureSum: number
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
      chipFlowSum: 0,
      technicalStructureSum: 0,
      symbols: [],
      reasons: new Set<string>(),
      themeReasons: new Set<string>(),
      flowReasons: new Set<string>(),
      rotationReasons: new Set<string>(),
      strategyReasons: new Set<string>(),
    }
    const scoreViewModel = buildScoreBreakdownViewModel(rec ?? {})
    const chipFlow = scoreComponentValue(scoreViewModel, 'chipFlow')
    const technicalStructure = scoreComponentValue(scoreViewModel, 'technicalStructure')
    row.count += 1
    row.scoreSum += scoreViewModel.finalScore
    row.chipFlowSum += chipFlow
    row.technicalStructureSum += technicalStructure
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
    if (chipFlow >= 18) row.flowReasons.add('Score V2 籌碼流偏強')
    if (technicalStructure >= 18) row.rotationReasons.add('Score V2 技術結構偏強')
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
      avgChipFlow: row.count ? row.chipFlowSum / row.count : 0,
      avgTechnicalStructure: row.count ? row.technicalStructureSum / row.count : 0,
      themeText: [...row.themeReasons].slice(0, 2).join(' / ') || '題材未提供明確關鍵字',
      flowText: [...row.flowReasons].slice(0, 2).join(' / ') || '資金流以分數代理',
      rotationText: [...row.rotationReasons].slice(0, 2).join(' / ') || '族群輪動無明確標籤',
      strategyText: [...row.strategyReasons].slice(0, 2).join(' / ') || '未標策略池',
      reasonText: [...row.reasons].slice(0, 2).join(' / ') || '多因子通過',
    }))
    .sort((a, b) => b.count - a.count || b.avgScore - a.avgScore)
    .slice(0, 8)
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
      <span className="w-24 truncate text-muted-foreground shrink-0">{label}</span>
      <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-14 text-right font-mono text-muted-foreground">{fmt(value, 1)}/{max}</span>
    </div>
  )
}

// ─── Expandable stock row ──────────────────────────────────────────────────
function StockRow({ rec, rank }: { rec: any; rank: number }) {
  const [expanded, setExpanded] = useState(false)
  const sig = SIGNAL_STYLE[rec.signal] ?? SIGNAL_STYLE['HOLD']
  const scoreViewModel = buildScoreBreakdownViewModel(rec ?? {})

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
        <span className="text-sm font-bold font-mono text-primary w-8 text-right">{Math.round(scoreViewModel.finalScore)}</span>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
      </div>
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border space-y-2">
          <div className="space-y-1">
            {scoreViewModel.rows.map((row) => (
              <ScoreBar key={row.key} label={row.label} value={row.value} max={row.max} color={row.color} />
            ))}
            {scoreViewModel.technicalRows.length > 0 && (
              <div className="pt-1 space-y-1 border-t border-border/60">
                {scoreViewModel.technicalRows.map((row) => (
                  <ScoreBar key={row.key} label={row.label} value={row.value} max={row.max} color={row.color} />
                ))}
              </div>
            )}
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

function cleanDecisionReason(reason: unknown): string {
  const text = String(reason ?? '').trim()
  if (!text) return ''
  return text
    .replace(/^[\s\S]*?Judge on fundamental merit\s*\/\s*industry context\.\s*/i, '')
    .replace(/^Signal Provenance \([^)]*\): [\s\S]*?(?:Judge on business merit and industry context, not raw signal strength\.|Treat as ranking promotion, not a naturally strong BUY\.)\s*/i, '')
    .trim()
}

function T2BuyRow({ buy, rank }: { buy: any; rank: number }) {
  const [expanded, setExpanded] = useState(false)
  const reason = cleanDecisionReason(buy.reason)
  const scoreViewModel = buildScoreBreakdownViewModel(buy ?? {})
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
        <span className="text-sm font-bold font-mono text-primary w-8 text-right">{Math.round(scoreViewModel.finalScore)}</span>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
      </div>
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border space-y-2 text-xs text-muted-foreground">
          <div className="grid grid-cols-3 gap-2">
            <div>限價 <span className="font-mono text-foreground">${fmt(buy.ml_entry_price, 1)}</span></div>
            <div>停損 <span className="font-mono text-emerald-400">${fmt(buy.ml_stop_loss, 1)}</span></div>
            <div>目標 <span className="font-mono text-red-400">${fmt(buy.ml_target1, 1)}</span></div>
          </div>
          {reason && <p className="leading-relaxed">{reason}</p>}
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
          <div className="grid grid-cols-2 gap-2">
            {scoreViewModel.rows.map((row) => (
              <span key={row.key}>
                {row.label} <span className="font-mono">{fmt(row.value, 1)}/{row.max}</span>
              </span>
            ))}
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
  const mlSignalCount = allRecs.filter((r: any) => r.signal && r.signal !== 'NO_SIGNAL').length
  const recommendationCount = mlBuy.length + mlHold.length
  const screenerPreview = [...screenerPassed]
    .sort((a: any, b: any) => scoreFinalValue(b) - scoreFinalValue(a))
    .slice(0, 10)
  const screenerSectorSummary = buildScreenerSectorSummary(screenerPassed)
  const recommendationPreview = [...mlBuy, ...mlHold]
    .sort((a: any, b: any) => scoreFinalValue(b) - scoreFinalValue(a))
    .slice(0, 10)
  const pipelineStages = [
    {
      key: 'screener',
      label: '初篩',
      detail: 'sector/theme breadth',
      count: screenerPassed.length,
      icon: Filter,
      color: 'text-sky-300',
      barColor: 'bg-sky-300',
    },
    {
      key: 'model_signal',
      label: '模型判斷',
      detail: 'non-empty signal',
      count: mlSignalCount,
      previousCount: screenerPassed.length,
      icon: Brain,
      color: 'text-violet-300',
      barColor: 'bg-violet-300',
    },
    {
      key: 'recommendation',
      label: '推薦整理',
      detail: 'BUY + HOLD watchlist',
      count: recommendationCount,
      previousCount: mlSignalCount,
      icon: Star,
      color: 'text-amber-300',
      barColor: 'bg-amber-300',
    },
    {
      key: 'pending_buy',
      label: '辯論掛單',
      detail: 'debate + T2 executable',
      count: pendingBuys.length,
      previousCount: recommendationCount,
      icon: Scale,
      color: 'text-emerald-300',
      barColor: 'bg-emerald-300',
    },
  ]
  const pipelineDropoffs = [
    { label: '無訊號 / 排除', count: mlNoSignal.length + mlSell.length, color: 'bg-emerald-400' },
    { label: '觀察未掛單', count: Math.max(0, recommendationCount - pendingBuys.length), color: 'bg-amber-300' },
    { label: 'RRG / debate filter', count: qfList.length, color: 'bg-sky-300' },
  ]

  const isLoading = recLoading || pbLoading

  if (!isAuthenticated) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-full p-4">
          <div className="sv-login-panel space-y-4 rounded-2xl p-6 text-center">
            <Filter className="sv-accent-text mx-auto h-12 w-12 opacity-80" />
            <p className="text-[color:var(--sv-text-soft)]">請先登入以查看每日流程</p>
            <button onClick={login} className="sv-surface-button rounded-full px-4 py-2 text-sm">
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
        <div className="sv-page-title flex items-center justify-between rounded-2xl p-4">
          <div>
            <p className="sv-accent-text text-[10px] font-semibold uppercase tracking-[0.2em]">Daily flow</p>
            <h1 className="sv-title-text mt-1 text-lg font-bold">每日流程</h1>
            <p className="mt-1 text-xs text-[color:var(--sv-text-soft)]">{recDate} 從初篩、模型、推薦到模擬掛單的節奏總覽</p>
          </div>
          <div className="sv-surface-chip hidden items-center gap-2 rounded-full px-3 py-2 text-xs md:flex">
            <span className="font-mono">882 → {screenerPassed.length} → {mlBuy.length} 買進 → {pendingBuys.length} 掛單</span>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map(i => <div key={i} className="h-24 rounded-xl bg-muted/40 animate-pulse" />)}
          </div>
        ) : (
          <>
            <PipelineCompressionVisual stages={pipelineStages} dropoffs={pipelineDropoffs} />

            <details
              data-testid="pipeline-stage-drilldown"
              className="sv-disclosure group rounded-2xl"
            >
              <summary className="sv-disclosure-summary flex cursor-pointer select-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold transition-colors hover:text-[color:var(--sv-accent)]">
                <span>Stage drilldown</span>
                <span className="sv-muted-text font-mono text-[10px] uppercase tracking-[0.16em]">
                  sector / signal / recommendation / pending
                </span>
              </summary>
              <div className="grid gap-4 p-3 xl:grid-cols-4">

            {/* ═══ Step 1: Screener ═══ */}
            <Card className="border-border bg-card">
              <CardContent className="pt-4 pb-3">
                <StepHeader
                  step={1} icon={Filter}
                  title="自下而上初篩"
                  subtitle="全市場約 882 檔 → Score V2 五構面評分 → 同產業去重 → 前 25 名"
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
                        <span>籌碼流 <b className="font-mono text-foreground">{fmt(row.avgChipFlow, 1)}</b></span>
                        <span>技術結構 <b className="font-mono text-foreground">{fmt(row.avgTechnicalStructure, 1)}</b></span>
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
                  count={allRecs.filter((r: any) => r.signal && r.signal !== 'NO_SIGNAL').length}
                  color="bg-purple-500/20 text-purple-400"
                />
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <TrendingUp className="w-3.5 h-3.5 text-red-400" />
                      <span className="text-xs font-medium text-red-400">BUY ({mlBuy.length})</span>
                    </div>
                    <div className="space-y-0.5">
                      {mlBuy.sort((a: any, b: any) => scoreFinalValue(b) - scoreFinalValue(a)).map((r: any, i: number) => (
                        <div key={r.symbol} className="flex items-center gap-2 px-2 py-1 text-xs rounded hover:bg-muted/30">
                          <span className="font-mono font-semibold w-12">{r.symbol}</span>
                          <span className="text-muted-foreground truncate flex-1">{r.name}</span>
                          <span className="font-mono text-primary">{Math.round(scoreFinalValue(r))}</span>
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
                      {mlHold.sort((a: any, b: any) => scoreFinalValue(b) - scoreFinalValue(a)).map((r: any, i: number) => (
                        <div key={r.symbol} className="flex items-center gap-2 px-2 py-1 text-xs rounded hover:bg-muted/30">
                          <span className="font-mono font-semibold w-12">{r.symbol}</span>
                          <span className="text-muted-foreground truncate flex-1">{r.name}</span>
                          <span className="font-mono text-muted-foreground">{Math.round(scoreFinalValue(r))}</span>
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
            </details>
          </>
        )}
      </div>
    </AppShell>
  )
}
