/**
 * PipelinePage — 每日選股流程總覽
 *
 * 顯示完整 pipeline：Screener → ML → Recommendation → T2 Debate
 * 讓使用者看到每個階段選了哪些股票、為什麼選
 */
import { useQuery } from '@tanstack/react-query'
import { dashboardV4Api, recommendationsApi, paperApi, type DailyPipelineView } from '@/lib/api'
import { queryTtl } from '@/lib/queryPolicy'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import AppShell from '@/components/AppShell'
import {
  Filter,
} from 'lucide-react'
import { useState } from 'react'
import { DataState } from '@/components/ui/data-state'
import { ListDetailLayout, selectableRowProps } from '@/components/ui/list-detail'
import { StatusIcon, StatusText } from '@/components/ui/status'
import { formatDate, formatNumber } from '@/lib/format'
import { humanizeId, looksInternal, strategyDisplayLabel } from '@/lib/humanLabels'
import type { StatusTone } from '@/lib/colorTokens'
import { useAuth } from '@/_core/hooks/useAuth'
import { buildScoreBreakdownViewModel } from '@/lib/scoreV2ViewModel'
import PipelineMaturityContribution from '@/components/PipelineMaturityContribution'
import L4DistributionPanel from '@/components/L4DistributionPanel'
import type { PipelineDecisionMaturityPacket } from '@/lib/pipelineMaturityContract'

// ─── Signal config ─────────────────────────────────────────────────────────
// 買賣訊號是模型評等，不是當日漲跌：用中性深淺表強弱（實心＝強、外框＝一般），文字與圖示表方向。
// 紅綠只留給價格與報酬（batch3 顏色規則；Wei 可否決）。
const SIGNAL_STYLE: Record<string, { label: string; cls: string }> = {
  STRONG_BUY: { label: '▲ 強烈買進', cls: 'bg-white/[0.14] text-foreground border-white/35 font-bold' },
  BUY:        { label: '▲ 買進',     cls: 'bg-white/[0.06] text-foreground border-white/20' },
  HOLD:       { label: '觀望',       cls: 'bg-transparent text-muted-foreground border-border' },
  SELL:       { label: '▼ 賣出',     cls: 'bg-transparent text-foreground border-white/25' },
  STRONG_SELL:{ label: '▼ 強烈賣出', cls: 'bg-transparent text-foreground border-white/40 font-bold' },
}

// 顏色少而有語意：分層／策略／產業卡不再各自配彩虹色，一律中性外框。
const NEUTRAL_ACCENT = { border: 'border-white/[0.08]', bg: 'bg-white/[0.03]', text: 'text-slate-100', bar: 'bg-slate-300/70' }

// 內部識別 → 中文短名；原始鍵只進 title tooltip。
const SOURCE_OF_TRUTH_LABELS: Record<string, string> = {
  'legacy_fallback:screener_funnel_items.l1_candidate_seed_after_overlay': '來源：L1 候選名單（備援）',
  canonical_v4: '來源：正式策略矩陣',
}

function sourceOfTruthLabel(raw: unknown): string {
  if (typeof raw === 'string' && raw.startsWith('legacy_fallback')) return SOURCE_OF_TRUTH_LABELS[raw] ?? '來源：舊版彙總（備援）'
  return humanizeId(raw, SOURCE_OF_TRUTH_LABELS, '來源：策略彙總')
}

const RISK_REASON_LABELS: Record<string, string> = {
  TRADING_ATTENTION_RISK_EVIDENCE: '注意股風險',
}

const RISK_STAGE: Record<string, { label: string; tone: StatusTone }> = {
  hard_safety: { label: '硬性安全', tone: 'fail' },
  soft_risk_overlay: { label: '軟性風控', tone: 'warn' },
}

function riskReasonLabel(raw: unknown): string {
  return humanizeId(raw, RISK_REASON_LABELS, '風控檢查')
}

function fmt(n: number | null | undefined, decimals = 0): string {
  return formatNumber(n, decimals, '-')
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

function signalText(rec: any): string {
  return String(rec?.signal ?? rec?.trade_signal ?? rec?.tradeSignal ?? rec?.signal_raw ?? '').toUpperCase()
}

function isBuySignalRecommendation(rec: any): boolean {
  if (rec?.has_buy_signal === 1 || rec?.has_buy_signal === true) return true
  return ['BUY', 'STRONG_BUY'].includes(signalText(rec))
}

function recommendationRowsFromPayload(payload: any): any[] {
  const source = Array.isArray(payload?.all_recommendations)
    ? payload.all_recommendations
    : Array.isArray(payload?.recommendations)
      ? payload.recommendations
      : Array.isArray(payload?.data)
        ? payload.data
        : []
  const seen = new Set<string>()
  return source.filter((row: any, index: number) => {
    const key = String(row?.stock_id ?? row?.symbol ?? index)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

type LayerTraceRow = {
  layer: string
  title: string
  status: string
  detail: string
  metrics: string[]
}

function evidenceObject(raw: unknown): Record<string, any> | null {
  const obj = parseMaybeJson(raw)
  return Object.keys(obj).length > 0 ? obj : null
}

function textMetric(raw: unknown, fallback = '-'): string {
  if (raw == null || raw === '') return fallback
  if (typeof raw === 'boolean') return raw ? 'yes' : 'no'
  return String(raw).replace(/_/g, ' ')
}

function numberMetric(raw: unknown, decimals = 1): string {
  const value = Number(raw)
  return Number.isFinite(value) ? fmt(value, decimals) : '-'
}

function percentMetric(raw: unknown): string {
  const value = Number(raw)
  if (!Number.isFinite(value)) return '-'
  const pct = Math.abs(value) <= 1 ? value * 100 : value
  return `${fmt(pct, 1)}%`
}

// Missing funnel evidence (e.g. a row dropped by the D1 persistence cap) is unknown, not blocked.
const UNKNOWN_EVIDENCE_LABEL = '未知（無資料）'

function boolMetric(raw: unknown, yes = 'yes', no = 'no'): string {
  if (raw === true || raw === 1) return yes
  if (raw === false || raw === 0) return no
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase()
    if (['true', '1', 'yes', 'pass', 'selected'].includes(value)) return yes
    if (['false', '0', 'no', 'wait', 'blocked'].includes(value)) return no
  }
  return '-'
}

function layerTraceRowsFromRec(rec: any): LayerTraceRow[] {
  const evidence = evidenceObject(rec?.screener_funnel_evidence) ?? {}
  const l0 = evidenceObject(evidence.layer0_universe_features)
  const l05 = evidenceObject(evidence.layer05_hard_gate)
  const l1 = evidenceObject(evidence.layer1_strategy_labeler)
  const l125 = evidenceObject(evidence.layer125_finlab_portfolio_intelligence)
  const l15 = evidenceObject(evidence.layer15_multi_strategy_router) ?? evidenceObject(evidence.layer1_breadth)
  const l2 = evidenceObject(evidence.layer2_timesfm_enrichment) ?? evidenceObject(evidence.layer2_3ml_coarse) ?? evidenceObject(evidence.layer2_coarse_ml) ?? evidenceObject(evidence.layer2_queue_seed)
  const l3 = evidenceObject(evidence.layer3_8ml_formal) ?? evidenceObject(evidence.layer3_6ml_formal) ?? evidenceObject(evidence.layer3_formal_ml)
  const l35 = evidenceObject(evidence.layer35_evidence_fusion)
  const l4 = evidenceObject(rec?.l4_sparse_allocation)
    ?? evidenceObject(evidence.layer4_sparse_allocation)
    ?? evidenceObject(rec?.alpha_allocation)

  return [
    {
      layer: 'L0',
      title: 'Universe / Features',
      status: l0
        ? l0.universe_passed == null
          ? UNKNOWN_EVIDENCE_LABEL
          : boolMetric(l0.universe_passed, 'pass', textMetric(l0.universe_decision, 'review'))
        : 'no evidence',
      detail: l0?.decision_policy ?? 'feature materialization evidence not found',
      metrics: [
        `source ${numberMetric(l0?.source_universe_count, 0)}`,
        `groups ${numberMetric(l0?.feature_group_count ?? l0?.feature_groups?.length, 0)}`,
        `base ${numberMetric(l0?.base_score, 1)}（僅顯示）`,
      ],
    },
    {
      layer: 'L0.5',
      title: 'Hard Gate',
      status: l05 ? boolMetric(l05.pending_buy_blocked, 'blocked', 'allowed') : 'no evidence',
      detail: l05?.decision_policy ?? 'tradability/data-trust gate evidence not found',
      metrics: [
        `lane ${textMetric(l05?.recommendation_lane)}`,
        `board ${textMetric(l05?.board_type ?? l05?.market_segment)}`,
        `ML ${boolMetric(l05?.ml_slate_allowed ?? l05?.eligible_for_ml, 'allowed', 'blocked')}`,
        `liquidity ${l05 && l05.liquidity_capacity_passed != null ? boolMetric(l05.liquidity_capacity_passed, 'pass', 'blocked') : UNKNOWN_EVIDENCE_LABEL}`,
      ],
    },
    {
      layer: 'L1',
      title: 'Strategy Labeler',
      status: l1 ? textMetric(l1.decision ?? 'labeled') : 'no evidence',
      detail: l1?.selection_policy ?? 'strategy labeler evidence not found',
      metrics: [
        `strategies ${numberMetric(l1?.strategy_count, 0)}`,
        `families ${numberMetric(l1?.family_count, 0)}`,
        `max ${numberMetric(l1?.max_strategy_affinity, 2)}`,
      ],
    },
    {
      layer: 'L1.25',
      title: 'Portfolio Intelligence',
      status: l125 ? textMetric(l125.portfolio_metric_status ?? 'available') : 'no evidence',
      detail: l125?.selection_policy ?? 'strategy-as-asset portfolio evidence not found',
      metrics: [
        `metrics ${numberMetric(l125?.portfolio_metric_count, 0)}`,
        `reliability ${percentMetric(l125?.strategy_reliability)}`,
        `crowding ${percentMetric(l125?.strategy_crowding_score)}`,
      ],
    },
    {
      layer: 'L1.5',
      title: 'Strategy Router',
      status: l15 ? textMetric(l15.strategy_router_decision ?? 'routed') : 'no evidence',
      detail: l15?.selection_policy ?? 'multi-strategy router evidence not found',
      metrics: [
        `route ${percentMetric(l15?.route_score)}`,
        `formal L2 ${boolMetric(l15?.formal_l2_queue, 'queue', 'observe')}`,
        `teachers ${numberMetric(l15?.teacher_label_count, 0)}`,
      ],
    },
    {
      layer: 'L2',
      title: '3ML Coarse / TimesFM Enrichment',
      status: l2 ? boolMetric(l2.l2_feature_input_active, 'active', textMetric(l2.reason_code, 'observe')) : 'no evidence',
      detail: l2?.decision_policy ?? 'TimesFM L2 enrichment evidence not found',
      metrics: [
        `expected ${numberMetric(l2?.expected_model_count, 0)}`,
        `features ${numberMetric(l2?.populated_feature_count, 0)}`,
        `direct ${boolMetric(l2?.direct_alpha_blocked, 'blocked', 'allowed')}`,
      ],
    },
    {
      layer: 'L3',
      title: 'Formal ML Family Vote',
      status: l3 ? textMetric(l3.decision ?? 'formal vote') : 'no evidence',
      detail: l3?.decision_policy ?? 'formal family-vote evidence not found',
      metrics: [
        `family ${percentMetric(l3?.formal_family_score)}`,
        `active ${numberMetric(l3?.active_l3_model_count ?? l3?.contributing_model_count, 0)}`,
        `families ${numberMetric(l3?.active_family_count, 0)}`,
      ],
    },
    {
      layer: 'L3.5',
      title: 'L1.5 ↔ L3 Conflict Audit',
      status: `observe-only · ${l35 ? textMetric(l35.conflict_level ?? l35.decision ?? 'fused') : 'no evidence'}`,
      detail: `${l35?.selection_policy ?? 'L1.5/L3 conflict evidence not found'}; telemetry only, never a serving gate`,
      metrics: [
        `route ${percentMetric(l35?.layer1_route_score)}`,
        `family ${percentMetric(l35?.layer3_formal_family_score)}`,
        `owner ${textMetric(l35?.final_allocation_owner)}`,
      ],
    },
    {
      layer: 'L4',
      title: 'Sparse Allocation',
      status: l4 ? boolMetric(l4.selected, 'selected', 'hold') : 'no evidence',
      detail: l4?.selection_policy ?? 'final sparse allocation evidence not found',
      metrics: [
        `weight ${percentMetric(l4?.allocation_weight)}`,
        `signals ${numberMetric(l4?.buy_signal_count, 0)}`,
        `engine ${textMetric(l4?.engine ?? l4?.allocation_method)}`,
      ],
    },
  ]
}

function LayerTracePanel({ rec }: { rec: any }) {
  const rows = layerTraceRowsFromRec(rec)
  return (
    <div className="rounded-lg border border-border/70 bg-background/45 p-2">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold text-foreground">Layer Evidence Trace</p>
        <span className="sv-num text-[10px] text-muted-foreground">L0-L4 / screener_funnel_evidence</span>
      </div>
      <div className="grid gap-1.5">
        {rows.map((row) => (
          <div key={row.layer} className="grid gap-2 rounded-md border border-border/50 px-2 py-1.5 text-[11px] md:grid-cols-[86px_minmax(0,1fr)]">
            <div>
              <div className="sv-num font-semibold text-primary">{row.layer}</div>
              <Badge variant="outline" className="mt-1 h-auto max-w-full whitespace-normal break-words px-1.5 py-0 text-[9px]">
                {row.status}
              </Badge>
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-foreground">{row.title}</p>
              <p className="mt-0.5 break-words leading-5 text-muted-foreground">{row.detail}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {row.metrics.map((metric) => (
                  <span key={metric} className="rounded border border-border/40 bg-background/60 px-1.5 py-0.5 sv-num text-[10px] text-muted-foreground">
                    {metric}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
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
    row.scoreSum += scoreFinalValue(rec)
    row.chipSum += Number(rec.chip_score ?? 0)
    row.techSum += Number(rec.tech_score ?? 0)
    if (rec.symbol && row.symbols.length < 4) row.symbols.push(String(rec.symbol))
    if (rec.screener_funnel_reason) row.reasons.add(String(rec.screener_funnel_reason))
    const evidence = parseMaybeJson(rec.screener_funnel_evidence)
    const strategyIds = evidence.strategy_ids ?? rec.strategy_pool_ids ?? []
    const keywords = [
      ...(Array.isArray(evidence.keywords) ? evidence.keywords : []),
      ...(Array.isArray(evidence.theme_keywords) ? evidence.theme_keywords : []),
      ...(Array.isArray(evidence.top_keywords) ? evidence.top_keywords : []),
    ].filter(Boolean).slice(0, 3)
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

// ─── Score bar ─────────────────────────────────────────────────────────────
function ScoreBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-8 text-muted-foreground shrink-0">{label}</span>
      <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right sv-num text-muted-foreground">{value}/{max}</span>
    </div>
  )
}

// ─── Stock list + detail panel ─────────────────────────────────────────────
// 點列切換右側（窄欄時在下方）的固定明細區，不再用展開／收合。
function rowKey(row: any, index: number): string {
  return String(row?.symbol ?? index)
}

function rowClass(selected: boolean, selectedCls: string): string {
  return `flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${selected ? selectedCls : 'border-transparent hover:bg-card/50'}`
}

const DETAIL_PANEL_CLS = 'border-t border-border pt-3 @min-[34rem]:border-t-0 @min-[34rem]:border-l @min-[34rem]:pl-3 @min-[34rem]:pt-0'

function StockRowSummary({ rec, rank }: { rec: any; rank: number }) {
  const sig = SIGNAL_STYLE[rec.signal] ?? SIGNAL_STYLE['HOLD']
  const scoreViewModel = buildScoreBreakdownViewModel(rec ?? {})
  return (
    <>
      <span className="text-xs text-muted-foreground sv-num w-5 text-right">{rank}</span>
      <span className="font-semibold text-sm w-14 sv-num">{rec.symbol}</span>
      <span className="text-xs text-muted-foreground truncate flex-1 max-w-[80px]">{rec.name}</span>
      {rec.sector && <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0">{rec.sector}</Badge>}
      <Badge className={`text-[10px] px-1.5 py-0 border ${sig.cls}`}>{sig.label}</Badge>
      <span className="text-sm font-bold sv-num text-primary w-8 text-right">{Math.round(scoreViewModel.finalScore)}</span>
    </>
  )
}

function StockDetail({ rec }: { rec: any }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold"><span className="sv-num">{rec.symbol}</span> <span className="text-muted-foreground">{rec.name}</span></p>
      <div className="space-y-1">
        <ScoreBar label="籌碼" value={rec.chip_score ?? 0} max={40} color="bg-blue-500" />
        <ScoreBar label="技術" value={rec.tech_score ?? 0} max={30} color="bg-purple-500" />
        <ScoreBar label="ML" value={rec.ml_score ?? 0} max={30} color="bg-indigo-400" />
      </div>
      {rec.reason && (
        <p className="text-xs text-muted-foreground leading-relaxed">{rec.reason}</p>
      )}
      <LayerTracePanel rec={rec} />
      <div className="flex gap-4 text-[11px] text-muted-foreground">
        {rec.current_price && <span>現價 <span className="sv-num">${fmt(rec.current_price, 2)}</span></span>}
        {rec.rsi14 && <span>RSI <span className="sv-num">{rec.rsi14.toFixed(1)}</span></span>}
        {rec.confidence && <span>信心度 <span className="sv-num">{(rec.confidence * 100).toFixed(0)}%</span></span>}
      </div>
    </div>
  )
}

// 目前沒有頁面渲染這份清單（HEAD 起 StockRow 即未被引用）；保留為列表＋明細形式。
function StockListDetail({ recs }: { recs: any[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  const currentIndex = Math.max(0, recs.findIndex((rec, i) => rowKey(rec, i) === selected))
  const current = recs[currentIndex]
  if (!current) return null
  return (
    <ListDetailLayout
      listWidth="narrow"
      detailKey={rowKey(current, currentIndex)}
      listLabel="推薦標的"
      detailLabel="標的明細"
      detailClassName={DETAIL_PANEL_CLS}
      list={recs.map((rec, i) => (
        <div key={rowKey(rec, i)} className={rowClass(i === currentIndex, 'border-border bg-card')} {...selectableRowProps(i === currentIndex, () => setSelected(rowKey(rec, i)))}>
          <StockRowSummary rec={rec} rank={i + 1} />
        </div>
      ))}
      detail={<StockDetail rec={current} />}
    />
  )
}

// ─── T2 Pending Buy row ────────────────────────────────────────────────────
function DebateTurnsList({ turns, verdict, status }: { turns: any[]; verdict: string; status: string }) {
  const cleanTurns = Array.isArray(turns)
    ? turns.filter((turn) => turn && typeof turn === 'object' && typeof turn.summary === 'string' && turn.summary.trim())
    : []
  const verdictLabel = verdict === 'APPROVE' ? '通過' : verdict === 'DOWNGRADE' ? '降級通過' : verdict === 'REJECT' ? '否決' : '待裁決'
  const judge = cleanTurns.find((turn) => ['judge', 'fulcrum'].includes(String(turn.agent).toLowerCase()))
  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-background/45 p-3">
      <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
        <span>兩輪多空辯論與裁決</span>
        <Badge variant="outline" className="text-[10px]">{verdictLabel}</Badge>
      </div>
      {!cleanTurns.length ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {status === 'completed'
            ? '這次裁決沒有保存兩輪發言原文，無法還原；裁決結果仍保留。'
            : '辯論尚未完成，暫無逐輪發言。'}
        </p>
      ) : (
        <>
          {[1, 2].map((round) => {
            const roundTurns = cleanTurns.filter((turn) => Number(turn.round) === round && ['bull', 'zealot', 'bear', 'reaper'].includes(String(turn.agent).toLowerCase()))
            return (
              <section key={round} className="space-y-2">
                <h4 className="text-xs font-semibold text-foreground">第 {round} 輪</h4>
                {roundTurns.length ? roundTurns.map((turn, index) => (
                  <div key={`${round}-${turn.agent}-${index}`} className="rounded-md border border-border/50 px-3 py-2">
                    <p className="mb-1 text-xs font-semibold text-primary">{['bull', 'zealot'].includes(String(turn.agent).toLowerCase()) ? '多方' : '空方'}</p>
                    <p className="whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground">{turn.summary}</p>
                  </div>
                )) : <p className="text-xs text-muted-foreground">本輪原文未保存。</p>}
              </section>
            )
          })}
          <section className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2">
            <h4 className="mb-1 text-xs font-semibold text-foreground">最終裁決 · {verdictLabel}</h4>
            <p className="whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground">{judge?.summary || '裁決理由原文未保存。'}</p>
          </section>
        </>
      )}
    </div>
  )
}

function T2BuyRowSummary({ buy, rank }: { buy: any; rank: number }) {
  const scoreViewModel = buildScoreBreakdownViewModel(buy ?? {})
  return (
    <>
      <span className="text-xs text-muted-foreground sv-num w-5 text-right">{rank}</span>
      <span className="font-semibold text-sm w-14 sv-num">{buy.symbol}</span>
      <span className="text-xs text-muted-foreground truncate flex-1 max-w-[80px]">{buy.name}</span>
      <Badge className="text-[10px] px-1.5 py-0 border bg-up/10 text-up border-up/20">
        {buy.signal ?? 'BUY'}
      </Badge>
      {buy.confidence != null && (
        <span className="text-xs sv-num text-muted-foreground">信心度 {(buy.confidence * 100).toFixed(0)}%</span>
      )}
      <span className="text-sm font-bold sv-num text-primary w-8 text-right">{Math.round(scoreViewModel.finalScore)}</span>
    </>
  )
}

function T2BuyDetail({ buy }: { buy: any }) {
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p className="text-sm font-semibold text-foreground"><span className="sv-num">{buy.symbol}</span> <span className="text-muted-foreground">{buy.name}</span></p>
      <div className="grid grid-cols-3 gap-2">
        <div>限價 <span className="sv-num text-foreground">${fmt(buy.ml_entry_price, 1)}</span></div>
        <div>停損 <span className="sv-num text-down">${fmt(buy.ml_stop_loss, 1)}</span></div>
        <div>目標 <span className="sv-num text-up">${fmt(buy.ml_target1, 1)}</span></div>
      </div>
      <DebateTurnsList
        turns={buy.debate_turns ?? buy.debateTurns ?? []}
        verdict={String(buy.debate_verdict ?? 'PENDING').toUpperCase()}
        status={String(buy.debate_status ?? 'pending').toLowerCase()}
      />
    </div>
  )
}

function T2BuyListDetail({ pendingBuys }: { pendingBuys: any[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  const currentIndex = Math.max(0, pendingBuys.findIndex((buy, i) => rowKey(buy, i) === selected))
  const current = pendingBuys[currentIndex]
  if (!current) return null
  return (
    <ListDetailLayout
      listWidth="narrow"
      detailKey={rowKey(current, currentIndex)}
      listLabel="T2 待買"
      detailLabel="待買明細與辯論"
      detailClassName={DETAIL_PANEL_CLS}
      list={pendingBuys.map((buy, i) => (
        <div key={rowKey(buy, i)} className={rowClass(i === currentIndex, 'border-primary/20 bg-card')} {...selectableRowProps(i === currentIndex, () => setSelected(rowKey(buy, i)))}>
          <T2BuyRowSummary buy={buy} rank={i + 1} />
        </div>
      ))}
      detail={<T2BuyDetail buy={current} />}
    />
  )
}

function countValue(value: unknown): string {
  if (value == null || value === '') return 'N/A'
  const numeric = Number(value)
  return Number.isFinite(numeric) ? fmt(numeric, 0) : 'N/A'
}

function finiteCount(value: unknown): number | null {
  if (value == null || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function ratioValue(value: unknown): string {
  if (value == null || value === '') return 'N/A'
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric.toFixed(3) : 'N/A'
}

function PipelineColumn({
  title,
  subtitle,
  children,
  className = '',
}: {
  title: string
  subtitle: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <Card className={`max-w-full overflow-clip border-[#283140] bg-[#111319]/95 shadow-[0_18px_60px_rgba(0,0,0,0.18)] ${className}`}>
      <CardHeader className="min-w-0 pb-2">
        <CardTitle className="text-base text-[#f5f7fb]">{title}</CardTitle>
        <div className="break-words text-xs leading-5 text-[#8f9bb0]">{subtitle}</div>
      </CardHeader>
      <CardContent className="min-w-0 space-y-3 overflow-clip pt-0">
        {children}
      </CardContent>
    </Card>
  )
}

function PipelineColumnLoading({ title, subtitle, className = '' }: { title: string; subtitle: string; className?: string }) {
  return (
    <PipelineColumn title={title} subtitle={subtitle} className={className}>
      <DataState kind="loading" title={`${title}載入中`} />
    </PipelineColumn>
  )
}

function PipelineColumnError({
  title,
  message,
  onRetry,
  className = '',
}: {
  title: string
  message: string
  onRetry: () => void
  className?: string
}) {
  return (
    <PipelineColumn title={title} subtitle="其他流程欄位仍可獨立顯示。" className={className}>
      <DataState kind="error" title="資料暫時讀不到" hint="可重試" code={message} onRetry={onRetry} />
    </PipelineColumn>
  )
}
function FunnelSummaryColumn({ summary, fallbackCount }: {
  summary: any
  fallbackCount: number
}) {
  const layers = Array.isArray(summary?.layers) ? summary.layers : []
  return (
    <PipelineColumn
      title="篩選、模型證據與交易訊號"
      subtitle={summary?.run_id
        ? <span title="資料日＝這批推薦對應的交易日">資料日 {formatDate(summary.date)} · 已發布 {countValue(summary?.recommendation_count)} 檔</span>
        : `已觀測 ${countValue(fallbackCount)} 檔；完整批次統計尚未提供。`}
    >
      <div className="space-y-2">
        {layers.length ? layers.map((row: any) => {
          const metrics = Array.isArray(row.metrics) ? row.metrics : []
          const complete = row.availability === 'available'
          return (
            <div key={row.layer} className={`rounded-xl border ${NEUTRAL_ACCENT.border} ${NEUTRAL_ACCENT.bg} p-3`}>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className={`sv-num text-base font-semibold ${NEUTRAL_ACCENT.text}`}>{row.layer}</p>
                  <p className="mt-1 text-xs text-[#9aa4b7]">{row.label}</p>
                </div>
                <StatusText tone={complete ? 'ok' : 'warn'} className="text-[10px]" title={row.availability}>
                  {complete ? '完整統計' : '資料未完整'}
                </StatusText>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                {metrics.map((metric: any) => (
                  <div key={metric.label} className="rounded-md border border-white/10 bg-white/[0.04] p-2">
                    <p className="text-[10px] text-[#9aa4b7]">{metric.label}</p>
                    <p className="mt-1 sv-num text-lg font-semibold text-[#f5f7fb]">{countValue(metric.value)}</p>
                  </div>
                ))}
              </div>
              {row.note && <p className="mt-2 text-[11px] leading-relaxed text-[#9aa4b7]">{row.note}</p>}
            </div>
          )
        }) : <DataState kind="empty" title="篩選分層統計尚未提供" />}
      </div>
    </PipelineColumn>
  )
}

/** L4 配置直接就地呈現（全寬），不收在窄欄的收合區裡。 */
function L4AllocationSection({ l4Distribution, loading, error, onRetry }: {
  l4Distribution?: PipelineDecisionMaturityPacket['l4_distribution']
  loading: boolean
  error: Error | null
  onRetry: () => void
}) {
  // l4_distribution rides on the maturity query; its loading / failure must not read as "no L4 data".
  return (
    <section className="rounded-2xl border border-[#283140] bg-[#111319]/95 p-4" aria-labelledby="l4-allocation-title">
      <h2 id="l4-allocation-title" className="mb-2 text-sm font-semibold text-[#f5f7fb]">L4 · 配置詳情</h2>
      {l4Distribution ? <L4DistributionPanel data={l4Distribution} />
        : loading ? <DataState kind="loading" title="讀取 L4 配置" />
        : error ? <DataState kind="error" title="L4 配置讀取失敗" code={error.message || 'pipeline/maturity'} onRetry={onRetry} />
        : <DataState kind="empty" title="尚未取得 L4 配置資料" />}
    </section>
  )
}

function StrategySummaryColumn({ summary, sectors }: { summary: any; sectors: Array<{ sector: string; count: number; symbols: string[]; themeText: string; rotationText: string }> }) {
  const strategies = Array.isArray(summary?.strategies) ? summary.strategies : []
  // display_name 由 Worker 從策略註冊表帶出（舊 Worker 沒有 → 機械轉換）；配對列也用同一張表。
  const displayNames = new Map<string, unknown>(strategies.map((row: any) => [String(row?.strategy_id ?? ''), row?.display_name]))
  const strategyName = (id: unknown) => strategyDisplayLabel(id, displayNames.get(String(id ?? '')))
  // 後端每列帶 status：'active'＝註冊表正式策略、'observed'＝當日證據命中的觀察策略。兩組分開列，不再都叫「活躍」。
  const activeStrategies = strategies.filter((row: any) => row?.status !== 'observed')
  const observedStrategies = strategies.filter((row: any) => row?.status === 'observed')
  const canonicalMatrixReady = summary?.raw_matrix_status === 'canonical_v4'
  // Worker caps strategies at 64 rows and sends strategies_total_count; counts must come from the totals, not the capped list.
  const totalStrategyCount = finiteCount(summary?.strategies_total_count) ?? strategies.length
  const strategiesTruncated = summary?.strategies_truncated === true && totalStrategyCount > strategies.length
  const activeTotal = finiteCount(summary?.active_strategy_count)
  // Worker pre-seeds every registry-active id into the hit map, so total − active is exactly the observed count.
  // (Its observed_strategy_count field is that whole map's size, i.e. the total, so it is not used here.)
  const activeCount = strategiesTruncated ? activeTotal : (activeStrategies.length || activeTotal)
  const observedCount = strategiesTruncated
    ? (activeTotal == null ? null : Math.max(0, totalStrategyCount - activeTotal))
    : observedStrategies.length
  const pairwise = Array.isArray(summary?.pairwise) ? summary.pairwise : []
  const pairwiseTruncated = summary?.pairwise_truncated === true
  const strongestPairs = [...pairwise]
    .sort((a: any, b: any) => Number(b.jaccard ?? -1) - Number(a.jaccard ?? -1))
    .slice(0, 4)
  return (
    <PipelineColumn
      className="xl:col-span-2"
      title="策略彙總"
      subtitle={summary?.source_of_truth
        ? <span title={String(summary.source_of_truth)}>{sourceOfTruthLabel(summary.source_of_truth)}</span>
        : '策略彙總尚未產生；等待後端篩選彙總。'}
    >
      {!canonicalMatrixReady && (
        <p className="flex items-start gap-1.5 rounded-xl border border-warn/25 bg-warn/[0.06] px-3 py-2 text-xs leading-5 text-slate-200" title={summary?.raw_matrix_status ? `raw_matrix_status：${summary.raw_matrix_status}` : undefined}>
          <StatusIcon tone="warn" />
          <span>今日正式策略矩陣尚未就緒；下方為備援名單，命中數以「—」表示，不是 0。</span>
        </p>
      )}
      {/* 平面格線（gap-px＋底色），不在欄卡片裡再套圓角卡片。 */}
      <div className="grid min-w-0 grid-cols-2 gap-px border-y border-white/[0.06] bg-white/[0.06] text-sm sm:grid-cols-4">
        <div className="bg-[#111319] px-3 py-2" title="策略註冊表中 status=active 的正式策略">
          <p className="text-xs text-[#9aa4b7]">正式啟用</p>
          <p className="mt-1 sv-num text-xl font-semibold text-[#f5f7fb]">{countValue(activeCount)}</p>
        </div>
        <div className="bg-[#111319] px-3 py-2" title="不在正式名單、但當日篩選證據裡有命中的觀察策略">
          <p className="text-xs text-[#9aa4b7]">當日命中的觀察策略</p>
          <p className="mt-1 sv-num text-xl font-semibold text-[#f5f7fb]">{countValue(observedCount)}</p>
        </div>
        <div className="bg-[#111319] px-3 py-2" title={`選股集合兩兩重疊程度（0～1），越高越重複；${totalStrategyCount} 個策略（正式＋觀察）共 ${totalStrategyCount * (totalStrategyCount - 1) / 2} 組配對的平均`}>
          <p className="text-xs text-[#9aa4b7]">平均重疊 Jaccard <span className="sv-num">· {totalStrategyCount} 個策略兩兩平均</span></p>
          <p className="mt-1 sv-num text-xl font-semibold text-[#f5f7fb]">{ratioValue(summary?.avg_jaccard)}</p>
        </div>
        <div className="bg-[#111319] px-3 py-2" title={`策略分數兩兩相關係數平均；${totalStrategyCount} 個策略（正式＋觀察）共 ${totalStrategyCount * (totalStrategyCount - 1) / 2} 組配對的平均`}>
          <p className="text-xs text-[#9aa4b7]">平均相關 <span className="sv-num">· {totalStrategyCount} 個策略兩兩平均</span></p>
          <p className="mt-1 sv-num text-xl font-semibold text-[#f5f7fb]">{ratioValue(summary?.avg_corr)}</p>
        </div>
      </div>
      {strategiesTruncated && (
        <p className="text-[11px] text-muted-foreground">
          名單依命中數只列前 <span className="sv-num">{strategies.length}</span> 個（共 <span className="sv-num">{totalStrategyCount}</span> 個）；上方計數與平均是全部策略。
        </p>
      )}

      {/* 策略名單兩組並排佔滿欄寬（名稱不截斷），重疊與相關排在下方。 */}
      <div className="grid min-w-0 gap-4">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          {[
            { key: 'active', title: '正式啟用', hint: '策略註冊表 status=active', rows: activeStrategies, total: activeCount },
            { key: 'observed', title: '當日命中的觀察策略', hint: '不在正式名單，當日篩選證據有命中', rows: observedStrategies, total: observedCount },
          ].map((group) => (
            <div key={group.key} className="min-w-0" data-strategy-group={group.key}>
              <div className="mb-2 flex items-center justify-between gap-3" title={group.hint}>
                <p className="text-sm font-semibold text-[#f5f7fb]">{group.title}</p>
                <span className="sv-num text-[11px] text-muted-foreground" title={strategiesTruncated ? `列出 ${group.rows.length} 個；全部 ${countValue(group.total)} 個` : undefined}>
                  {strategiesTruncated ? `${group.rows.length}／${countValue(group.total)}` : group.rows.length}
                </span>
              </div>
              <div className="grid gap-1">
                {group.rows.length ? group.rows.map((row: any, index: number) => {
                  const selectedCount = Number(row.selected_count ?? 0)
                  return (
                    <div key={row.strategy_id ?? index} className="grid grid-cols-[minmax(0,1fr)_56px_32px] items-center gap-2 border-b border-white/[0.06] py-1 text-xs">
                      <span className="min-w-0 truncate text-[#d7deea]" title={row.strategy_id}>{strategyDisplayLabel(row.strategy_id, row.display_name)}</span>
                      {canonicalMatrixReady
                        ? <div className="h-1.5 overflow-hidden rounded-full bg-black/30" title={`命中 ${countValue(row.selected_count)} 檔`}>
                            <div className="h-full rounded-full bg-sky-400/70" style={{ width: selectedCount > 0 ? `${Math.min(100, Math.max(8, selectedCount * 12))}%` : '0%' }} />
                          </div>
                        : <span className="text-[10px] text-muted-foreground" title="正式策略矩陣未就緒，命中數未知">—</span>}
                      <span className="text-right sv-num text-[11px] text-muted-foreground">{canonicalMatrixReady ? countValue(row.selected_count) : '—'}</span>
                    </div>
                  )
                }) : (
                  <DataState kind="empty" title={group.key === 'active' ? '沒有正式啟用策略資料' : '今日沒有觀察策略命中'} code="strategy_pool_ids" />
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="min-w-0">
          <p className="mb-2 text-sm font-semibold text-[#f5f7fb]" title={pairwiseTruncated ? `取自重疊檔數最多的 ${pairwise.length} 組（共 ${countValue(summary?.pairwise_total_count)} 組）` : undefined}>策略重疊與相關</p>
          <div className="grid min-w-0 gap-px border-y border-white/[0.06] bg-white/[0.06] md:grid-cols-2">
            {strongestPairs.length ? strongestPairs.map((row: any) => {
              const accent = NEUTRAL_ACCENT
              return (
                <div key={`${row.left}-${row.right}`} className="min-w-0 overflow-hidden bg-[#111319] px-3 py-2 text-xs">
                  <div className={`min-w-0 break-words font-semibold ${accent.text}`} title={`${row.left} / ${row.right}`}>{strategyName(row.left)} / {strategyName(row.right)}</div>
                  <div className="mt-2 grid min-w-0 grid-cols-3 gap-2 text-[#9aa4b7]">
                    <span className="min-w-0">重疊 <b className="sv-num text-[#f5f7fb]">{countValue(row.overlap)}</b></span>
                    <span className="min-w-0">J <b className="sv-num text-[#f5f7fb]">{ratioValue(row.jaccard)}</b></span>
                    <span className="min-w-0">相關 <b className="sv-num text-[#f5f7fb]">{ratioValue(row.corr)}</b></span>
                  </div>
                </div>
              )
            }) : (
              <DataState kind="empty" title="至少需要 2 個策略且有選股集合才能比較" className="bg-[#111319] md:col-span-2" />
            )}
          </div>
        </div>
      </div>

      {sectors.length > 0 && (
        <div className="border-t border-white/[0.08] pt-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-[#f5f7fb]">產業／題材脈絡</p>
            <span className="text-xs text-[#8f9bb0]">依推薦列彙總</span>
          </div>
          <div className="grid gap-px border-y border-white/[0.06] bg-white/[0.06] md:grid-cols-2 xl:grid-cols-4">
            {sectors.slice(0, 8).map((row) => {
              const accent = NEUTRAL_ACCENT
              return (
                <div key={row.sector} className="bg-[#111319] px-3 py-2 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <p className={`font-semibold ${accent.text}`}>{row.sector}</p>
                    <span className="rounded-full border border-white/[0.12] bg-black/20 px-2 py-0.5 sv-num text-[10px] text-[#dfe7f5]">{row.count} 檔</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {row.symbols.map((symbol) => (
                      <span key={symbol} className="rounded-full border border-white/[0.08] bg-black/20 px-2 py-0.5 sv-num text-[10px] text-[#dfe7f5]">{symbol}</span>
                    ))}
                  </div>
                  <p className="mt-2 leading-5 text-[#a5afc2]">{row.themeText}</p>
                  <p className="mt-1 leading-5 text-[#7f8da3]">{row.rotationText}</p>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </PipelineColumn>
  )
}

function ExecutionFlowColumn({
  pendingBuys,
  pbDate,
  sourceRecoDate,
  riskAuditList,
  candidateCount,
  riskAuditError,
  onRetryRiskAudit,
}: {
  pendingBuys: any[]
  pbDate: string
  sourceRecoDate?: string
  riskAuditList: any[]
  candidateCount: number | null
  riskAuditError?: Error | null
  onRetryRiskAudit?: () => void
}) {
  const steps = [
    { label: '候選', value: countValue(candidateCount), detail: '買進訊號配置' },
    { label: '辯論', value: String(pendingBuys.length), detail: 'T2 待買' },
    { label: '報價', value: String(riskAuditList.length), detail: '風控／報價檢查' },
    { label: '掛單', value: String(pendingBuys.filter((buy: any) => String(buy.execution_status ?? '').toLowerCase().includes('filled')).length), detail: '模擬成交' },
  ]
  // 掛單日通常是推薦資料日的下一個交易日，標清楚避免和左欄日期看起來差一天。
  const subtitleDate = pbDate
    ? `掛單日 ${formatDate(pbDate)}${sourceRecoDate ? ` · 依 ${formatDate(sourceRecoDate)} 推薦` : ''}`
    : '最新一批'
  return (
    <PipelineColumn title="辯論與模擬掛單" subtitle={<span title="買進訊號 → 多空辯論 → 報價檢查 → 模擬掛單">{subtitleDate}</span>}>
      <div className="grid gap-2">
        {steps.map((step, index) => (
          <div key={step.label} className={`grid grid-cols-[2rem_minmax(0,1fr)_4rem] items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] p-2 text-sm text-slate-200`}>
            <span className="flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.12] bg-black/25 sv-num">{index + 1}</span>
            <div>
              <p className="font-semibold text-[#f5f7fb]">{step.label}</p>
              <p className="text-xs text-[#9aa4b7]">{step.detail}</p>
            </div>
            <span className="text-right sv-num text-base font-semibold">{step.value}</span>
          </div>
        ))}
      </div>

      {pendingBuys.length === 0 ? (
        <DataState kind="empty" title="目前沒有待買" hint="已略過、取消或過期的單請到模擬交易室查看" />
      ) : (
        // 點列切換明細區（含辯論全文），不展開／收合。
        <T2BuyListDetail pendingBuys={pendingBuys} />
      )}

      {riskAuditError ? (
        <DataState kind="error" title="晨間風控紀錄暫時讀不到" code={riskAuditError.message} onRetry={onRetryRiskAudit} />
      ) : null}

      {riskAuditList.length > 0 && (
        <div className="border-t border-border pt-3">
          <p className="mb-2 text-xs text-muted-foreground">晨間風控與報價檢查紀錄</p>
          <div className="flex flex-wrap gap-1.5">
            {riskAuditList.map((entry: any) => {
              const stage = RISK_STAGE[String(entry.stage ?? '')]
              const rawReason = entry.reason_code ?? entry.action
              return (
                <Badge
                  key={`${entry.symbol}-${rawReason}`}
                  variant="outline"
                  className="gap-1 text-[10px]"
                  title={[rawReason, entry.stage].filter(Boolean).join(' · ')}
                >
                  <StatusIcon tone={stage?.tone ?? 'na'} size={10} />
                  <span className="sv-num">{entry.symbol}</span>
                  <span className="text-slate-200">{riskReasonLabel(rawReason)}</span>
                  <span className="text-muted-foreground">{stage?.label ?? (looksInternal(entry.stage) ? '檢查' : entry.stage ?? '檢查')}</span>
                </Badge>
              )
            })}
          </div>
        </div>
      )}
    </PipelineColumn>
  )
}

// ─── Main Pipeline Page ────────────────────────────────────────────────────
export default function PipelinePage() {
  const { isAuthenticated, login } = useAuth()
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  // Stage 1+2+3: Daily recommendations (screener → ML → filtered)
  const {
    data: recData,
    isLoading: recLoading,
    isError: recIsError,
    error: recError,
    refetch: refetchRecommendations,
  } = useQuery<DailyPipelineView>({
    queryKey: ['recommendations', 'daily', today, 'pipeline-view-v1'],
    queryFn: ({ signal }) => recommendationsApi.daily<DailyPipelineView>(undefined, { view: 'pipeline', signal, timeoutMs: 15_000 }),
    staleTime: queryTtl.dailyDecision,
    refetchInterval: queryTtl.dailyDecision,
    retry: 1,
  })

  // Stage 4: T2 Debate filtered pending buys
  const {
    data: pbData,
    isLoading: pbLoading,
    isError: pbIsError,
    error: pbError,
    refetch: refetchPendingBuys,
  } = useQuery({
    queryKey: ['paper', 'pending-buys'],
    queryFn: ({ signal }) => paperApi.pendingBuys({ signal, timeoutMs: 10_000 }),
    staleTime: queryTtl.dashboard,
    refetchInterval: queryTtl.dashboard,
    retry: 1,
  })

  // Legacy endpoint now serves generic morning risk and quote-sanity audit rows.
  const {
    data: riskAuditData,
    isError: riskAuditIsError,
    error: riskAuditError,
    refetch: refetchRiskAudit,
  } = useQuery({
    queryKey: ['paper', 'risk-audit'],
    queryFn: ({ signal }) => paperApi.riskAudit(undefined, { signal, timeoutMs: 8_000 }),
    staleTime: queryTtl.dashboard,
    refetchInterval: queryTtl.dashboard,
    retry: 1,
  })

  const recDate = recData?.date ?? today
  const pendingBuys = Array.isArray(pbData?.pendingBuys) ? pbData.pendingBuys : []

  const {
    data: maturityData,
    isLoading: maturityLoading,
    error: maturityError,
    refetch: refetchMaturity,
  } = useQuery<PipelineDecisionMaturityPacket>({
    queryKey: ['pipeline', 'decision-maturity', today],
    // Recommendation fallback may legitimately display the last completed day.
    // Maturity is a separate evidence owner and must advance independently.
    queryFn: () => dashboardV4Api.pipelineMaturity(today) as Promise<PipelineDecisionMaturityPacket>,
    enabled: isAuthenticated && Boolean(today),
    // The Worker shares one 5-minute copy (each rebuild ~12 s / ~1.4 MB); polling faster only
    // re-reads that copy.
    staleTime: 120_000,
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  })

  const pbDate = pbData?.date ?? ''
  const pendingSourceRecoDate = typeof pbData?.execution_policy?.source_reco_date === 'string'
    ? pbData.execution_policy.source_reco_date
    : typeof pbData?.meta?.source_reco_date === 'string'
      ? pbData.meta.source_reco_date
      : undefined
  const rawRiskAuditList = Array.isArray(riskAuditData?.filters)
    ? riskAuditData.filters
    : Array.isArray(riskAuditData)
      ? riskAuditData
      : []
  const riskAuditList = rawRiskAuditList.filter((entry: any) => (
    !/\bRRG\b|rrg_|relative rotation/i.test(JSON.stringify({
      action: entry?.action,
      reason_code: entry?.reason_code,
      details: entry?.details,
    }))
  ))

  // Stage breakdown comes from the dedicated aggregate view; no recommendation-row payload is required.
  const funnelSummary = recData?.funnel_summary ?? null
  const pipelineCounts = recData?.counts ?? funnelSummary ?? {}
  const screenerSectorSummary = Array.isArray(recData?.sector_summary) ? recData.sector_summary : []
  const l4BuyCount = Number.isFinite(Number(pipelineCounts.buy_signal_count))
    ? Number(pipelineCounts.buy_signal_count)
    : null
  const publishedCount = Number.isFinite(Number(pipelineCounts.recommendation_count ?? funnelSummary?.final_count))
    ? Number(pipelineCounts.recommendation_count ?? funnelSummary?.final_count)
    : null
  const holdCount = Number.isFinite(Number(pipelineCounts.hold_count))
    ? Number(pipelineCounts.hold_count)
    : null
  const pendingCount = pbLoading || pbIsError ? null : pendingBuys.length

  if (!isAuthenticated) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-full p-4">
          <div className="rounded-lg border border-border bg-card p-6 text-center space-y-4">
            <Filter className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">請先登入以查看每日流程</p>
            <button onClick={login} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90">
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
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-[15px] font-semibold text-foreground">每日流程</h1>
          <span className="text-[11px] text-muted-foreground">資料日 {formatDate(recDate)} · 從初篩、模型、推薦到模擬掛單</span>
          <span className="sv-num text-[11px] text-muted-foreground md:ml-auto">
            L4 BUY {countValue(l4BuyCount)} · 推薦 {countValue(publishedCount)} · HOLD {countValue(holdCount)} · 掛單 {countValue(pendingCount)}
          </span>
        </div>

        {/* items-start：各欄依內容高度，不被最高的一欄撐出空洞。 */}
        <div className="grid items-start gap-4 xl:grid-cols-4">
          {recIsError ? (
            <PipelineColumnError
              title="每日推薦與策略彙總讀取失敗"
              message={String((recError as Error | null)?.message ?? 'recommendations/daily?view=pipeline API error')}
              onRetry={() => { void refetchRecommendations() }}
              className="xl:col-span-3"
            />
          ) : recLoading ? (
            <>
              <PipelineColumnLoading title="篩選、模型證據與交易訊號" subtitle="讀取篩選彙總" />
              <PipelineColumnLoading title="策略彙總" subtitle="讀取策略與產業彙總" className="xl:col-span-2" />
            </>
          ) : (
            <>
              <FunnelSummaryColumn summary={funnelSummary} fallbackCount={publishedCount ?? 0} />
              <StrategySummaryColumn summary={recData?.strategy_summary} sectors={screenerSectorSummary} />
            </>
          )}

          {pbIsError ? (
            <PipelineColumnError
              title="辯論與模擬掛單讀取失敗"
              message={String((pbError as Error | null)?.message ?? 'paper/pending-buys API error')}
              onRetry={() => { void refetchPendingBuys() }}
            />
          ) : pbLoading ? (
            <PipelineColumnLoading title="辯論與模擬掛單" subtitle="讀取待買與掛單紀錄" />
          ) : (
            <ExecutionFlowColumn
              pendingBuys={pendingBuys}
              pbDate={pbDate}
              sourceRecoDate={pendingSourceRecoDate}
              riskAuditList={riskAuditList}
              candidateCount={l4BuyCount}
              riskAuditError={riskAuditIsError ? riskAuditError as Error : null}
              onRetryRiskAudit={() => { void refetchRiskAudit() }}
            />
          )}
        </div>

        <L4AllocationSection
          l4Distribution={maturityData?.l4_distribution}
          loading={maturityLoading}
          error={maturityError as Error | null}
          onRetry={() => { void refetchMaturity() }}
        />

        <PipelineMaturityContribution
          data={maturityData}
          loading={maturityLoading}
          error={maturityError as Error | null}
          onRetry={() => { void refetchMaturity() }}
        />
      </div>
    </AppShell>
  )
}
