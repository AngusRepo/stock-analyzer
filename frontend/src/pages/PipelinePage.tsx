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
import { buildScoreBreakdownViewModel, buildScoreV2PayloadFromProjectedScores } from '@/lib/scoreV2ViewModel'

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

function scoreComponentValue(rec: any, key: string): number {
  const row = buildScoreBreakdownViewModel(rec ?? {}).rows.find((item) => item.key === key)
  return Number.isFinite(row?.value) ? Number(row?.value) : 0
}

function scoreFinalValue(rec: any): number {
  return buildScoreBreakdownViewModel(rec ?? {}).finalScore
}

function hasScorePayload(rec: any): boolean {
  return buildScoreBreakdownViewModel(rec ?? {}).hasBackendPayload
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
    }
    row.count += 1
    row.scoreSum += scoreFinalValue(rec)
    row.chipSum += scoreComponentValue(rec, 'chipFlow')
    row.techSum += scoreComponentValue(rec, 'technicalStructure')
    if (rec.symbol && row.symbols.length < 4) row.symbols.push(String(rec.symbol))
    if (rec.screener_funnel_reason) row.reasons.add(String(rec.screener_funnel_reason))
    const evidence = parseMaybeJson(rec.screener_funnel_evidence)
    const rrg = parseMaybeJson(evidence.rrg_overlay ?? evidence.rrg)
    if (rrg.quadrant) row.reasons.add(`RRG ${rrg.quadrant}`)
    if (evidence.buzz_score != null || evidence.buzz_z != null) row.reasons.add('題材熱度')
    if (evidence.cooldown_penalty != null) row.reasons.add('冷卻檢查')
    if (evidence.diversity_slot != null || evidence.diversity_reason) row.reasons.add('分散控管')
    bySector.set(sector, row)
  }

  return [...bySector.values()]
    .map((row) => ({
      ...row,
      avgScore: row.count ? row.scoreSum / row.count : 0,
      avgChip: row.count ? row.chipSum / row.count : 0,
      avgTech: row.count ? row.techSum / row.count : 0,
      reasonText: [...row.reasons].slice(0, 3).join(' / ') || '多因子通過',
    }))
    .sort((a, b) => b.count - a.count || b.avgScore - a.avgScore)
    .slice(0, 8)
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
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="min-w-14 text-muted-foreground shrink-0">{label}</span>
      <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-12 text-right font-mono text-muted-foreground">{value}/{max}</span>
    </div>
  )
}

// ─── Expandable stock row ──────────────────────────────────────────────────
function StockRow({ rec, rank }: { rec: any; rank: number }) {
  const [expanded, setExpanded] = useState(false)
  const sig = SIGNAL_STYLE[rec.signal] ?? SIGNAL_STYLE['HOLD']
  const scoreViewModel = buildScoreBreakdownViewModel(rec)

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
            {scoreViewModel.rows.map((item) => (
              <ScoreBar key={item.key} label={item.label} value={item.value} max={item.max} color={item.color} />
            ))}
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
  const scoreViewModel = buildScoreBreakdownViewModel({
    ...buy,
    score_components: buy.score_components ?? buildScoreV2PayloadFromProjectedScores(buy),
  })
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
          {buy.reason && <p className="leading-relaxed">{buy.reason}</p>}
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/70 bg-background/45 p-2">
            <span>debate <b className="font-mono text-foreground">{buy.debate_verdict ?? buy.debate_status ?? '-'}</b></span>
            <span>execution <b className="font-mono text-foreground">{buy.execution_status ?? 'pending'}</b></span>
          </div>
          {Array.isArray(buy.watch_points) && buy.watch_points.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {buy.watch_points.slice(0, 5).map((point: string) => (
                <Badge key={point} variant="outline" className="text-[10px]">{point}</Badge>
              ))}
            </div>
          )}
          <div className="flex gap-3">
            {scoreViewModel.rows.map((item) => (
              <span key={item.key}>{item.label} <span className="font-mono">{item.value}/{item.max}</span></span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function parseMaybeArray(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function compactEvidenceValue(value: unknown): string {
  if (value == null || value === '') return '-'
  if (typeof value === 'number') return Number.isFinite(value) ? value.toFixed(Math.abs(value) >= 10 ? 1 : 2) : '-'
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.slice(0, 3).join(', ')
  return JSON.stringify(value).slice(0, 80)
}

function stageLabel(stage: unknown): string {
  const value = String(stage ?? '')
  const labels: Record<string, string> = {
    scoring: '初篩打分',
    rrg_overlay: '產業/象限',
    buzz_evidence: '熱門題材',
    diversity_cooldown: '分散/冷卻',
    strategy_pool_ml_queue: '策略候選池',
    strategy_pool_research_only: '策略研究池',
    final_selection: '最終入列',
    recommendation: '推薦輸出',
  }
  return (labels[value] ?? value) || 'stage'
}

function extractStrategyIds(rec: any, evidence: Record<string, any>, timeline: any[]): string[] {
  const ids = [
    ...(Array.isArray(rec.strategy_pool_ids) ? rec.strategy_pool_ids : []),
    ...(Array.isArray(evidence.strategy_ids) ? evidence.strategy_ids : []),
    ...timeline.flatMap((item) => {
      const ev = parseMaybeJson(item?.evidence)
      return Array.isArray(ev.strategy_ids) ? ev.strategy_ids : []
    }),
  ]
  return [...new Set(ids.map((item) => String(item)).filter(Boolean))]
}

function extractHotKeywords(evidence: Record<string, any>, timeline: any[]): string[] {
  const buzz = parseMaybeJson(evidence.buzz_evidence)
  const fromTimeline = timeline.flatMap((item) => {
    const ev = parseMaybeJson(item?.evidence)
    return [
      ev.concept,
      ...(Array.isArray(ev.matchedHot) ? ev.matchedHot : []),
      ...(Array.isArray(ev.keywords) ? ev.keywords : []),
    ]
  })
  return [...new Set([
    buzz.concept,
    ...(Array.isArray(buzz.matchedHot) ? buzz.matchedHot : []),
    ...(Array.isArray(buzz.keywords) ? buzz.keywords : []),
    ...fromTimeline,
  ].map((item) => String(item ?? '').trim()).filter(Boolean))].slice(0, 10)
}

function StockSelectionTracePanel({ recs }: { recs: any[] }) {
  const rows = recs.map((rec) => {
    const evidence = parseMaybeJson(rec.screener_funnel_evidence)
    const timeline = parseMaybeArray(rec.screener_funnel_timeline)
    return {
      rec,
      evidence,
      timeline,
      strategyIds: extractStrategyIds(rec, evidence, timeline),
      hotKeywords: extractHotKeywords(evidence, timeline),
    }
  })
  if (!rows.length) return null
  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">選股決策流程紀錄</CardTitle>
        <p className="text-xs text-muted-foreground">逐檔顯示策略候選池、熱門關鍵字、分散控管、RRG 與最終入列；不再截斷 reasons。</p>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map(({ rec, evidence, timeline, strategyIds, hotKeywords }, i) => {
          const rrg = parseMaybeJson(evidence.rrg_overlay ?? evidence.rrg)
          const scoreViewModel = buildScoreBreakdownViewModel(rec)
          return (
            <details key={`${rec.symbol}-${i}`} className="rounded-xl border border-border/80 bg-background/40 p-3" open={i < 3}>
              <summary className="cursor-pointer list-none">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="font-mono text-sm font-semibold">{rec.symbol} <span className="font-sans text-muted-foreground">{rec.name}</span></p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      score {compactEvidenceValue(scoreViewModel.finalScore)} / chip {compactEvidenceValue(scoreComponentValue(rec, 'chipFlow'))} / tech {compactEvidenceValue(scoreComponentValue(rec, 'technicalStructure'))} / ML {compactEvidenceValue(scoreComponentValue(rec, 'mlEdge'))}
                    </p>
                  </div>
                  <Badge variant="outline" className="font-mono text-[10px]">#{i + 1}</Badge>
                </div>
              </summary>
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap gap-1">
                  {[...(strategyIds.length ? strategyIds : ['score_rank']), rec.industryTheme ?? rec.industry ?? rec.sector]
                    .filter(Boolean)
                    .map((label: string) => (
                      <Badge key={label} variant="outline" className="text-[10px]">{label}</Badge>
                    ))}
                </div>
                {hotKeywords.length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold text-muted-foreground">熱門關鍵字 / 題材</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {hotKeywords.map((label) => (
                        <Badge key={label} className="border-amber-500/25 bg-amber-500/10 text-[10px] text-amber-200">{label}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                <div className="grid gap-2 text-[11px] text-muted-foreground md:grid-cols-2">
                  <span>最終原因 <b className="text-foreground">{String(rec.screener_funnel_reason ?? '-')}</b></span>
                  <span>strategy <b className="text-foreground">{String(rec.strategy_pool_reason ?? evidence.strategy_pool_reason ?? '-')}</b></span>
                  <span>rrg <b className="text-foreground">{compactEvidenceValue(rrg.quadrant)}</b></span>
                  <span>buzz <b className="font-mono text-foreground">{compactEvidenceValue(evidence.buzz_score ?? evidence.buzz_z ?? parseMaybeJson(evidence.buzz_evidence).buzzBonus)}</b></span>
                </div>
                {rec.reason && (
                  <div className="rounded-lg border border-border/70 bg-background/45 p-2">
                    <p className="text-[11px] font-semibold text-muted-foreground">完整推薦描述</p>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-foreground/85">{String(rec.reason)}</p>
                  </div>
                )}
                <div>
                  <p className="text-[11px] font-semibold text-muted-foreground">逐步決策</p>
                  <div className="mt-1 space-y-1">
                    {(timeline.length ? timeline : [{ stage: 'recommendation', reason_code: rec.screener_funnel_reason ?? 'selected' }]).map((item: any, idx: number) => {
                      const ev = parseMaybeJson(item.evidence)
                      return (
                        <div key={idx} className="rounded-lg border border-border/60 bg-background/35 p-2 text-[11px]">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="w-24 shrink-0 font-mono text-primary">{stageLabel(item.stage ?? item.step)}</span>
                            <span className="text-foreground">{String(item.decision ?? item.reason_code ?? item.reasonCode ?? '-')}</span>
                            {item.rank != null && <Badge variant="outline" className="font-mono text-[10px]">rank {item.rank}</Badge>}
                            {item.score_before != null || item.score_after != null ? (
                              <span className="font-mono text-muted-foreground">{compactEvidenceValue(item.score_before)} → {compactEvidenceValue(item.score_after)}</span>
                            ) : null}
                          </div>
                          {item.reason_code && <p className="mt-1 text-muted-foreground">{String(item.reason_code)}</p>}
                          {Object.keys(ev).length > 0 && (
                            <p className="mt-1 break-words font-mono text-[10px] text-muted-foreground">{JSON.stringify(ev)}</p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </details>
          )
        })}
      </CardContent>
    </Card>
  )
}

function PendingBuyHistoryPanel({ history }: { history: any }) {
  const runs = Array.isArray(history?.runs) ? history.runs : []
  if (!runs.length) return null
  const latest = runs[0]
  const items = Array.isArray(latest?.items) ? latest.items : []
  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">當日 debate 決策流程</CardTitle>
        <p className="text-xs text-muted-foreground">只看最新一輪 T2 debate；顯示 Bull / Bear-Risk / Final Judge 的逐輪意見，不再重複牌卡摘要。</p>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline" className="font-mono">run {latest.run_id}</Badge>
          <span className="font-mono">{latest.trade_date}</span>
          <span className="text-muted-foreground">source {latest.source_reco_date ?? '-'}</span>
          <Badge variant="outline">{latest.status}</Badge>
          <Badge variant="outline">debate {latest.debate_status}</Badge>
          <span className="text-muted-foreground">execution {JSON.stringify(latest.execution_counts ?? {})}</span>
        </div>
        {items.length === 0 ? (
          <div className="rounded-xl border border-border/80 bg-background/40 p-3 text-xs text-muted-foreground">
            這輪沒有 pending buy item；可能已被風控、處置股、流動性或價格 gate 全部擋下。
          </div>
        ) : items.map((item: any) => {
          const turns = Array.isArray(item.debate_agent_turns) ? item.debate_agent_turns : []
          return (
            <details key={`${latest.run_id}-${item.symbol}`} className="rounded-xl border border-border/80 bg-background/40 p-3" open={turns.length > 0}>
              <summary className="cursor-pointer list-none">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono font-semibold text-foreground">{item.symbol}</span>
                  <span className="text-muted-foreground">{item.name}</span>
                  <Badge variant="outline">{item.debate_verdict ?? item.debate_status ?? '-'}</Badge>
                  <Badge variant="outline">{item.execution_status ?? 'pending'}</Badge>
                  <span className="text-muted-foreground">{turns.length ? `${turns.length} agent turns` : 'agent turns 未落庫'}</span>
                </div>
              </summary>
              {turns.length ? (
                <div className="mt-3 space-y-2">
                  {turns.map((turn: any, idx: number) => (
                    <div key={`${item.symbol}-${idx}`} className="rounded-lg border border-border/60 bg-background/45 p-2">
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <Badge variant="outline" className="font-mono text-[10px]">R{turn.round ?? idx + 1}</Badge>
                        <span className="font-semibold text-foreground">{turn.agent}</span>
                        {turn.stance && <span className="text-muted-foreground">{turn.stance}</span>}
                        {turn.conviction != null && <span className="font-mono text-primary">conv {turn.conviction}</span>}
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{String(turn.summary ?? '')}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 p-2 text-xs text-amber-100/80">
                  舊 run 只保存 verdict / execution terminal，沒有保存 Theme/Bull/Bear/Risk/Judge 逐輪內容；下一次 debate run 會寫入 agent turns。
                </div>
              )}
            </details>
          )
        })}
      </CardContent>
    </Card>
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
  const pendingHistory = pbData?.runHistory ?? null
  const pbDate = pbData?.date ?? ''
  const qfList = Array.isArray(qfData?.filters) ? qfData.filters : Array.isArray(qfData) ? qfData : []

  // Stage breakdown
  const screenerPassed = allRecs
  const mlBuy = allRecs.filter((r: any) => ['BUY', 'STRONG_BUY'].includes(r.signal))
  const mlHold = allRecs.filter((r: any) => r.signal === 'HOLD')
  const mlSell = allRecs.filter((r: any) => ['SELL', 'STRONG_SELL'].includes(r.signal))
  const mlNoSignal = allRecs.filter((r: any) => !r.signal || r.signal === 'NO_SIGNAL')
  const scorePayloadCount = allRecs.filter((r: any) => hasScorePayload(r)).length
  const screenerPreview = [...screenerPassed]
    .sort((a: any, b: any) =>
      scoreComponentValue(b, 'chipFlow') + scoreComponentValue(b, 'technicalStructure')
      - (scoreComponentValue(a, 'chipFlow') + scoreComponentValue(a, 'technicalStructure')),
    )
    .slice(0, 10)
  const screenerSectorSummary = buildScreenerSectorSummary(screenerPassed)
  const recommendationPreview = [...mlBuy, ...mlHold]
    .sort((a: any, b: any) => scoreFinalValue(b) - scoreFinalValue(a))
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

        {!isLoading && (
          <div className="grid gap-4 xl:grid-cols-2">
            <StockSelectionTracePanel recs={recommendationPreview.length ? recommendationPreview : screenerPreview} />
            <PendingBuyHistoryPanel history={pendingHistory} />
          </div>
        )}

        {/* Pipeline flow indicator */}
        <div className="grid gap-2 rounded-2xl border border-[#3a3125] bg-[#171714] px-4 py-3 md:grid-cols-4">
          {[
            { label: '初篩', count: screenerPassed.length, color: 'text-[#9fcca1]' },
            { label: '模型判斷', count: scorePayloadCount, color: 'text-[#d7b98c]' },
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
                  count={scorePayloadCount}
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
                    目前沒有 active pending buys；若今天曾產生候選但已 skipped/cancelled/expired/rejected，請看上方 T2 歷史與 terminal 狀態。
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
