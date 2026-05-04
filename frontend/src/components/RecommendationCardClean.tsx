import { useState, type ElementType } from 'react'
import {
  AlertCircle,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Minus,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { explainExecutionEvent, parseExecutionEvent } from '@/lib/executionEvent'
import { cn } from '@/lib/utils'

type AlphaContext = {
  bucket?: string
  regime?: string
  sizing?: number | null
  scoreAdjustment?: number | null
  volatility?: string
  liquidity?: string
  skip?: boolean
  poc?: string | number | null
  fairValueLow?: string | number | null
  fairValueHigh?: string | number | null
  location?: string
  window?: string | null
  latestClose?: string | number | null
}

type MlVoteSummary = {
  bullish?: number
  bearish?: number
  flat?: number
  reported?: number
  missing?: number
  total?: number
  forecastPct?: number | null
  forecast_pct?: number | null
  thresholds?: {
    bullish?: number
    bearish?: number
    regime?: string
    adjustment?: number
  }
}

type ScoreComponents = {
  chip?: number | null
  tech?: number | null
  screenerMomentum?: number | null
  ml?: number | null
  persona?: number | null
  rawScore?: number | null
  alphaAdjustment?: number | null
  finalScore?: number | null
  formula?: string | null
  alphaReason?: {
    bucket?: string | null
    regime?: string | null
    riskFlags?: string[] | null
  } | null
}

const ALPHA_PREDICTION_MODEL_NAMES = [
  'XGBoost',
  'CatBoost',
  'ExtraTrees',
  'LightGBM',
  'FT-Transformer',
  'Chronos',
  'DLinear',
  'PatchTST',
] as const

const ALPHA_PREDICTION_MODEL_SET = new Set<string>(ALPHA_PREDICTION_MODEL_NAMES)

function isAlphaPredictionModelName(raw: unknown): boolean {
  return ALPHA_PREDICTION_MODEL_SET.has(String(raw ?? ''))
}

export const AI_TOP_PICK_EXPLANATION =
  '名詞解釋：基礎分 = 籌碼 + 技術 + ML；Alpha 調整是風控與市場狀態對分數的加減；Slate 是清單分散與配置順序，不會再直接加到預測分數。'

function fmtNumber(value: number | string | null | undefined, decimals = 1): string {
  if (value == null || value === '') return '-'
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return String(value)
  return numeric.toFixed(decimals)
}

function fmtOptionalNumber(value: number | string | null | undefined, decimals = 1): string | null {
  if (value == null || value === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return numeric.toFixed(decimals)
}

function fmtChipAmount(billion: number | null | undefined): string {
  if (billion == null) return '-'
  const abs = Math.abs(billion)
  if (abs < 0.01 && abs > 0) {
    const wan = Math.round(billion * 10000)
    return `${wan > 0 ? '+' : ''}${wan} 萬`
  }
  return `${billion > 0 ? '+' : ''}${billion.toFixed(2)} 億`
}

const SIGNAL_CONFIG: Record<string, { label: string; color: string; icon: ElementType }> = {
  STRONG_BUY: { label: '強買', color: 'bg-red-500 text-white', icon: Zap },
  BUY: { label: '買進', color: 'bg-orange-500 text-white', icon: TrendingUp },
  HOLD: { label: '觀望', color: 'bg-yellow-500 text-white', icon: Minus },
  SELL: { label: '賣出', color: 'bg-blue-500 text-white', icon: TrendingDown },
  STRONG_SELL: { label: '強賣', color: 'bg-purple-600 text-white', icon: TrendingDown },
}

const ALPHA_BUCKET_TEXT: Record<string, { label: string; help: string }> = {
  trend_following: {
    label: '順勢追蹤',
    help: '代表系統認為主要優勢來自「趨勢延續」。重點是價格已經有方向，進場不是撿便宜，而是順著強勢走。',
  },
  mean_reversion: {
    label: '均值回歸',
    help: '代表系統認為價格短線偏離合理區，可能有修復空間。重點是避免接刀，要看支撐、量能與大盤是否穩住。',
  },
  breakout_vol_expansion: {
    label: '突破 / 波動擴張',
    help: '代表系統偵測到突破或波動放大。這種機會可能跑很快，但也最容易追高，所以 sizing 和停損要更嚴格。',
  },
  defensive_accumulation: {
    label: '防守型累積',
    help: '代表訊號不是強攻型，而是偏防守、慢慢累積。適合小部位或觀察，不應解讀成無腦追價。',
  },
}

const REGIME_TEXT: Record<string, string> = {
  bull: '多頭環境：系統會較願意給順勢與突破策略權重，但仍需注意是否過熱。',
  bear: '空頭環境：系統會提高防守與風險控管權重，買進訊號要更保守。',
  sideways: '盤整環境：追突破容易假突破，均值回歸與區間交易通常更重要。',
  volatile: '高波動環境：價格容易大幅跳動，重點是降倉、避開滑價與避免追高。',
}

const VOL_TEXT: Record<string, string> = {
  normal: '波動正常：價格變動沒有明顯失控，風控可用標準參數。',
  high: '波動偏高：容易震盪掃停損，進場價、部位大小與停損距離都要更保守。',
  extreme: '波動極端：容易出現跳空與急殺，通常不適合自動追價。',
  unknown: '波動資料不足：不要過度解讀，需要等更多價格資料。',
}

const LIQUIDITY_TEXT: Record<string, string> = {
  normal: '流動性正常：成交量足夠，理論上較不容易因買賣造成明顯滑價。',
  thin: '流動性偏薄：掛單可能比較難成交，或成交價偏離預期。',
  low: '流動性低：滑價與流動性風險高，通常應跳過或大幅降倉。',
  unknown: '流動性資料不足：無法可靠估計成交與滑價風險。',
}

const LOCATION_TEXT: Record<string, string> = {
  below_fair_value: '低於公平價區：看起來偏便宜，但要確認不是弱勢破位。',
  in_fair_value: '位於公平價區：價格相對合理，不算明顯追高或折價。',
  above_fair_value: '高於公平價區：偏追高，若同時高波動或量薄就要特別小心。',
  unknown: '公平價位置不足：資料不夠完整，不能過度解讀。',
}

function labelFor(value: unknown, table?: Record<string, string>): string {
  if (typeof value !== 'string' || !value) return 'unknown'
  return ALPHA_BUCKET_TEXT[value]?.label ?? table?.[value] ?? value.replace(/_/g, ' ')
}

function shortLabelFor(value: unknown, table?: Record<string, string>): string {
  const label = labelFor(value, table)
  return label.split('：')[0]
}

function normalizeWatchPoints(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
  } catch {
    return [raw]
  }
}

function extractValue(text: string, key: string): string | null {
  const match = text.match(new RegExp(`${key}=([^,]+)`))
  return match?.[1]?.trim() ?? null
}

function extractSizing(text: string): number | null {
  const match = text.match(/sizing\s*x\s*([0-9.]+)/i)
  const value = Number(match?.[1] ?? NaN)
  return Number.isFinite(value) ? value : null
}

function contextFromWatchPoints(points: string[]): AlphaContext | null {
  const alphaPoint = points.find((point) => point.startsWith('Alpha bucket:') || point.startsWith('Alpha overlay:'))
  const structurePoint = points.find((point) => point.startsWith('Market structure:'))
  if (!alphaPoint && !structurePoint) return null

  const risk = extractValue(alphaPoint ?? '', 'risk')
  const [volatility, liquidity] = risk ? risk.split('/') : []
  const fairValue = extractValue(structurePoint ?? '', 'fair_value')
  const [fairValueLow, fairValueHigh] = fairValue ? fairValue.split('~') : []

  const legacyAlpha = alphaPoint?.match(/^Alpha (?:bucket|overlay):\s*([^,/]+)(?:\s*\/\s*([^,]+))?/)

  return {
    bucket: legacyAlpha?.[1]?.trim(),
    regime: extractValue(alphaPoint ?? '', 'regime') ?? legacyAlpha?.[2]?.trim() ?? undefined,
    sizing: extractSizing(alphaPoint ?? '') ?? undefined,
    volatility,
    liquidity,
    poc: extractValue(structurePoint ?? '', 'POC'),
    fairValueLow,
    fairValueHigh,
    location: extractValue(structurePoint ?? '', 'location') ?? undefined,
    window: extractValue(structurePoint ?? '', 'window'),
    latestClose: extractValue(structurePoint ?? '', 'latest_close'),
  }
}

function extractMlSummary(reason: unknown): string | null {
  if (typeof reason !== 'string') return null
  const bracket = reason.match(/【ML】\s*([^｜\n]+)/)
  if (bracket?.[1]) return bracket[1].trim()
  const plain = reason.match(/\[ML\]\s*([^|\n]+)/)
  return plain?.[1]?.trim() ?? null
}

function parseForecastData(raw: unknown): any | null {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function parseObject(raw: unknown): any | null {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function screenerFunnelFromRec(rec: any): { rank: number | null; chips: string[]; notes: string[] } | null {
  const evidence = parseObject(rec.screener_funnel_evidence)
  if (!evidence && rec.screener_funnel_rank == null) return null

  const chips: string[] = []
  if (rec.screener_funnel_rank != null) chips.push(`入選排名 #${rec.screener_funnel_rank}`)
  if (evidence?.industry) chips.push(`產業：${evidence.industry}`)
  if (Array.isArray(evidence?.strategy_tags) && evidence.strategy_tags.length > 0) {
    chips.push(...evidence.strategy_tags.slice(0, 3).map((tag: unknown) => String(tag)))
  }

  const notes: string[] = []
  if (evidence?.chip_score != null) notes.push(`籌碼 ${fmtNumber(evidence.chip_score, 1)}`)
  if (evidence?.tech_score != null) notes.push(`技術 ${fmtNumber(evidence.tech_score, 1)}`)
  if (evidence?.momentum_score != null) notes.push(`動能 ${fmtNumber(evidence.momentum_score, 1)}`)
  const rrg = parseObject(evidence?.rrg_overlay)
  if (rrg?.quadrant) {
    const adjustment = fmtOptionalNumber(rrg.adjustment, 1)
    notes.push(`RRG：${rrg.tag ?? '題材'} / ${rrg.quadrant}${adjustment ? `，調整 ${adjustment}` : ''}`)
  }
  const buzz = parseObject(evidence?.buzz_evidence)
  if (buzz?.concept) {
    const bonus = fmtOptionalNumber(buzz.buzzBonus, 1)
    notes.push(`熱門題材：${buzz.concept}${bonus ? `，加權 ${bonus}` : ''}`)
  }
  const cooldown = Array.isArray(evidence?.diversity_cooldown) ? evidence.diversity_cooldown : []
  for (const item of cooldown.slice(0, 2)) {
    const row = parseObject(item)
    if (row?.reason_code === 'high_frequency_cooldown') {
      notes.push(`重複入選降溫：20日 ${row.freq20d ?? '-'} 次`)
    } else if (row?.reason_code === 'new_money_boost') {
      notes.push('新進候選加權：避免清單每天長一樣')
    }
  }
  if (evidence?.freq20d != null) notes.push(`20日入選 ${evidence.freq20d} 次`)
  if (evidence?.highFreq) notes.push('重複入選已降溫')
  if (evidence?.newMoney) notes.push('新進資金/新題材加權')
  if (Array.isArray(evidence?.decision_path) && evidence.decision_path.length > 0) {
    notes.push(`漏斗路徑：${evidence.decision_path.map((step: any) => step.stage).filter(Boolean).join(' → ')}`)
  }

  return {
    rank: rec.screener_funnel_rank ?? null,
    chips,
    notes,
  }
}

function mlVoteSummaryFromRec(rec: any): MlVoteSummary | null {
  const persisted = parseObject(rec.ml_vote_summary)
  if (persisted && Number(persisted.total ?? 0) <= ALPHA_PREDICTION_MODEL_NAMES.length) {
    const reported = Number(persisted.reported ?? 0)
    const evidence = Number(persisted.bullish ?? 0) + Number(persisted.bearish ?? 0) + Number(persisted.flat ?? 0)
    if (reported > 0 || evidence > 0 || Number(rec.ml_score ?? 0) <= 0) {
      return persisted
    }
  }
  const forecast = parseForecastData(rec.prediction_forecast_data)
  const models = Array.isArray(forecast?.models)
    ? forecast.models.filter((model: any) => isAlphaPredictionModelName(model?.name ?? model?.model_name ?? model))
    : []
  const weights = forecast?.ensemble_v2?.weights && typeof forecast.ensemble_v2.weights === 'object'
    ? forecast.ensemble_v2.weights
    : {}
  const trackedWeightKeys = Object.keys(weights).filter(isAlphaPredictionModelName)
  const total = Math.max(ALPHA_PREDICTION_MODEL_NAMES.length, trackedWeightKeys.length, models.length)
  if (!forecast || total <= 0) return null
  const bullish = models.filter((model: any) => String(model?.direction ?? '').toLowerCase().includes('up')).length
  const bearish = models.filter((model: any) => String(model?.direction ?? '').toLowerCase().includes('down')).length
  return {
    bullish,
    bearish,
    flat: Math.max(0, models.length - bullish - bearish),
    reported: models.length,
    missing: Math.max(0, total - models.length),
    total,
    forecastPct: forecast.ensemble_v2?.forecast_pct ?? null,
  }
}

function mlMetadataGapText(rec: any, summary: MlVoteSummary | null): string | null {
  const mlScore = Number(rec.ml_score ?? 0)
  if (!Number.isFinite(mlScore) || mlScore <= 0) return null
  const reported = Number(summary?.reported ?? 0)
  const votes = Number(summary?.bullish ?? 0) + Number(summary?.bearish ?? 0) + Number(summary?.flat ?? 0)
  if (summary && (reported > 0 || votes > 0)) return null
  return `ML 分數 ${fmtNumber(mlScore, 1)} 來自後端 scalar score，但投票明細尚未對齊 business date，暫不顯示 0/8 這種誤導訊息。`
}

function formatMlVoteSummary(summary: MlVoteSummary | null): string | null {
  if (!summary) return null
  const total = Number(summary.total ?? 0)
  if (!Number.isFinite(total) || total <= 0) return null
  const bullish = Number(summary.bullish ?? 0)
  const bearish = Number(summary.bearish ?? 0)
  const missing = Number(summary.missing ?? Math.max(0, total - bullish - bearish - Number(summary.flat ?? 0)))
  const reported = Number(summary.reported ?? total - missing)
  if (reported <= 0 || bullish + bearish + Number(summary.flat ?? 0) <= 0) {
    return `ML 投票資料不足（${Math.max(0, reported)}/${total} 回報）`
  }
  const forecastRaw = summary.forecastPct ?? summary.forecast_pct
  const forecast = typeof forecastRaw === 'number' && Number.isFinite(forecastRaw)
    ? `，預期${forecastRaw >= 0 ? '+' : ''}${forecastRaw.toFixed(1)}%`
    : ''
  const missingText = missing > 0 ? `，${missing}/${total}未回傳` : ''
  const flat = Number(summary.flat ?? Math.max(0, total - bullish - bearish - missing))
  const flatText = flat > 0 ? `、${flat}/${total}觀望` : ''
  return `${bullish}/${total}看漲、${bearish}/${total}看跌${flatText}${missingText}${forecast}`
}

function formatMlThresholdText(summary: MlVoteSummary | null): string | null {
  const bullish = summary?.thresholds?.bullish
  const bearish = summary?.thresholds?.bearish
  if (typeof bullish !== 'number' || typeof bearish !== 'number') return null
  const regime = summary?.thresholds?.regime && summary.thresholds.regime !== 'unknown'
    ? `，regime=${summary.thresholds.regime}`
    : ''
  return `投票門檻：rank score >= ${bullish.toFixed(3)} 算看漲，<= ${bearish.toFixed(3)} 算看跌，中間為觀望${regime}。`
}

function translateRecommendationReason(reason: unknown): string {
  if (typeof reason !== 'string') return ''
  return reason
    .replace(
      /Signal Provenance \(ensemble Top-K\): BUY forced at ensemble layer \(signal_raw=([^,)]*), avg_rank=([^)]+)\)\. Judge on business merit and industry context, not raw signal strength\./g,
      '訊號來源：此檔由 ensemble Top-K 納入，原始訊號為 $1，平均排名 $2；代表它是排序入選，不是模型自然強買。',
    )
    .replace(
      /Signal Provenance \(ranking promoted\): BUY flipped at recommendation layer \(ensemble_v2\.signal=([^,)]*), avg_rank=([^)]+)\)\. Treat as ranking promotion, not a naturally strong BUY\./g,
      '訊號來源：此檔由推薦層從 $1 提升為買進，平均排名 $2；需用分數、產業脈絡與盤中再評估輔助判讀。',
    )
    .trim()
}

function alphaContextFromRec(rec: any, points: string[]): AlphaContext | null {
  const alpha = rec.alpha_context
  if (!alpha) return contextFromWatchPoints(points)

  const risk = alpha.risk_overlay ?? {}
  const structure = risk.structure_detail ?? {}
  return {
    bucket: alpha.edge_bucket,
    regime: alpha.regime,
    sizing: alpha.sizing_multiplier,
    scoreAdjustment: alpha.score_adjustment,
    volatility: risk.volatility_level,
    liquidity: risk.liquidity_level,
    skip: risk.skip,
    poc: structure.poc_price,
    fairValueLow: structure.fair_value_low,
    fairValueHigh: structure.fair_value_high,
    location: structure.price_location,
    window: structure.window_start_date && structure.window_end_date
      ? `${structure.window_start_date}~${structure.window_end_date}`
      : undefined,
    latestClose: structure.latest_close,
  }
}

function ScoreBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const safeValue = Number.isFinite(value) ? value : 0
  const pct = Math.max(0, Math.min(100, Math.round((safeValue / max) * 100)))
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-12 text-right font-mono text-muted-foreground">
        {fmtNumber(safeValue, 1)}/{max}
      </span>
    </div>
  )
}

function ScoreBreakdown({ rec }: { rec: any }) {
  const chip = Number(rec.chip_score ?? 0)
  const tech = Number(rec.tech_score ?? 0)
  const ml = Number(rec.ml_score ?? 0)
  const base = Math.round((chip + tech + ml) * 10) / 10
  const alphaAdj = Number(rec.alpha_context?.score_adjustment ?? 0)
  const finalScore = Number(rec.score ?? base + alphaAdj)
  const residual = Math.round((finalScore - base - alphaAdj) * 10) / 10

  return (
    <div className="rounded-lg border border-border/50 bg-background/50 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-muted-foreground">分數公式</span>
        <span className="font-mono text-foreground">
          {fmtNumber(finalScore, 1)} = {fmtNumber(base, 1)}
          {alphaAdj >= 0 ? ' + ' : ' - '}{fmtNumber(Math.abs(alphaAdj), 1)}
          {Math.abs(residual) >= 0.1 && `${residual >= 0 ? ' + ' : ' - '}${fmtNumber(Math.abs(residual), 1)}`}
        </span>
      </div>
      <div className="grid gap-1.5 text-muted-foreground sm:grid-cols-2">
        <span>基礎分：籌碼 + 技術 + ML = {fmtNumber(base, 1)}</span>
        <span>Alpha 調整：{alphaAdj >= 0 ? '+' : ''}{fmtNumber(alphaAdj, 1)}</span>
        {Math.abs(residual) >= 0.1 && (
          <span>其他調整：{residual >= 0 ? '+' : ''}{fmtNumber(residual, 1)}</span>
        )}
        <span>最終分數：{fmtNumber(finalScore, 1)}</span>
      </div>
      {Math.abs(residual) >= 0.1 && (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
          其他調整是來源總分與目前可拆解欄位的差額，常見於舊 pending buy 未帶完整 metadata；不是額外 ML 預測報酬。
        </p>
      )}
    </div>
  )
}

function ScoreBreakdownV2({ rec }: { rec: any }) {
  const components = parseObject(rec.score_components) as ScoreComponents | null
  const chip = Number(components?.chip ?? rec.chip_score ?? 0)
  const tech = Number(components?.tech ?? rec.tech_score ?? 0)
  const screenerMomentum = Number(components?.screenerMomentum ?? rec.momentum_score ?? 0)
  const ml = Number(components?.ml ?? rec.ml_score ?? 0)
  const persona = Number(components?.persona ?? rec.persona_score ?? 0)
  const rawScore = Number(components?.rawScore ?? Math.round((chip + tech + ml + persona) * 10) / 10)
  const alphaAdj = Number(components?.alphaAdjustment ?? rec.alpha_context?.score_adjustment ?? 0)
  const finalScore = Number(components?.finalScore ?? rec.score ?? rawScore + alphaAdj)
  const residual = Math.round((finalScore - rawScore - alphaAdj) * 10) / 10
  const hasBackendComponents = Boolean(components)
  const riskFlags = components?.alphaReason?.riskFlags?.filter(Boolean) ?? []
  const riskText = riskFlags.length > 0 ? riskFlags.join(', ') : '無額外風控旗標'

  return (
    <div className="rounded-lg border border-border/50 bg-background/50 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-muted-foreground">分數公式</span>
        <span className="font-mono text-foreground">
          {fmtNumber(finalScore, 1)} = {fmtNumber(rawScore, 1)}
          {alphaAdj >= 0 ? ' + ' : ' - '}{fmtNumber(Math.abs(alphaAdj), 1)}
          {Math.abs(residual) >= 0.1 && `${residual >= 0 ? ' + ' : ' - '}${fmtNumber(Math.abs(residual), 1)}`}
        </span>
      </div>
      <div className="grid gap-1.5 text-muted-foreground sm:grid-cols-2">
        <span>籌碼：{fmtNumber(chip, 1)}</span>
        <span>技術：{fmtNumber(tech, 1)}</span>
        {Math.abs(screenerMomentum) >= 0.1 && <span>Screener 動能：{fmtNumber(screenerMomentum, 1)}</span>}
        <span>ML：{fmtNumber(ml, 1)}</span>
        {Math.abs(persona) >= 0.1 && <span>Persona：{persona >= 0 ? '+' : ''}{fmtNumber(persona, 1)}</span>}
        <span>基礎分：籌碼 + 技術 + ML{Math.abs(persona) >= 0.1 ? ' + Persona' : ''} = {fmtNumber(rawScore, 1)}</span>
        <span>Alpha 調整：{alphaAdj >= 0 ? '+' : ''}{fmtNumber(alphaAdj, 1)}</span>
        {Math.abs(residual) >= 0.1 && (
          <span>未拆解差額：{residual >= 0 ? '+' : ''}{fmtNumber(residual, 1)}</span>
        )}
        <span>最後分數：{fmtNumber(finalScore, 1)}</span>
      </div>
      {hasBackendComponents && (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
          後端已提供 score_components；Alpha 扣加分主要由 edge bucket、regime 權重與風控旗標決定。風控旗標：{riskText}。
        </p>
      )}
      {Math.abs(residual) >= 0.1 && (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
          這不是額外預測報酬，而是後端尚未提供完整 score_components 時，來源總分與可拆解欄位之間的差值；部署 schema 後應該逐步消失。
        </p>
      )}
    </div>
  )
}

function AlphaContextBlock({ context }: { context: AlphaContext | null }) {
  if (!context) return null
  const bucket = context.bucket ?? 'unknown'
  const regime = context.regime ?? 'unknown'
  const volatility = context.volatility ?? 'unknown'
  const liquidity = context.liquidity ?? 'unknown'
  const location = context.location ?? 'unknown'
  const fairValue = context.fairValueLow || context.fairValueHigh
    ? `${fmtNumber(context.fairValueLow, 2)} ~ ${fmtNumber(context.fairValueHigh, 2)}`
    : '-'
  const sizingText = fmtOptionalNumber(context.sizing, 2)
  const scoreAdjText = fmtOptionalNumber(context.scoreAdjustment, 1)
  return (
    <div className="rounded-lg border border-sky-500/20 bg-sky-500/[0.06] p-3">
      <p className="mb-2 flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-300">
        <ShieldCheck className="h-3 w-3" />
        Alpha / 市場結構解讀
      </p>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <span>Alpha bucket：{labelFor(bucket)}</span>
        <span>大盤狀態：{shortLabelFor(regime, REGIME_TEXT)}</span>
        <span>部位倍率：{sizingText ? `x${sizingText}` : '資料不足'}</span>
        <span>Alpha 調整：{scoreAdjText == null ? '資料不足' : `${Number(context.scoreAdjustment) >= 0 ? '+' : ''}${scoreAdjText}`}</span>
        <span>波動：{shortLabelFor(volatility, VOL_TEXT)}</span>
        <span>流動性：{shortLabelFor(liquidity, LIQUIDITY_TEXT)}</span>
        <span>POC：{fmtNumber(context.poc, 2)}</span>
        <span>Fair value：{fairValue}</span>
        {context.window && <span>計算區間：{context.window}</span>}
        {context.latestClose != null && <span>區間最後收盤價：{fmtNumber(context.latestClose, 2)}</span>}
        <span className="sm:col-span-2">價格位置：{shortLabelFor(location, LOCATION_TEXT)}</span>
      </div>
      <div className="mt-3 space-y-1.5 text-xs leading-relaxed text-muted-foreground/85">
        <p>{ALPHA_BUCKET_TEXT[bucket]?.help ?? 'Alpha bucket 是系統判斷這檔股票目前主要 edge 來源的分類。'}</p>
        <p>{REGIME_TEXT[regime] ?? 'Regime 是目前大盤狀態，用來調整不同策略類型的權重。'}</p>
        <p>{VOL_TEXT[volatility] ?? VOL_TEXT.unknown} {LIQUIDITY_TEXT[liquidity] ?? LIQUIDITY_TEXT.unknown}</p>
        <p>
          Market structure：POC 是計算區間內成交量重心，fair value 是同一區間估出的合理價格帶；
          {LOCATION_TEXT[location] ?? LOCATION_TEXT.unknown}
        </p>
      </div>
      {context.skip && (
        <p className="mt-2 text-xs font-medium text-amber-600">
          風控層已標記 skip：代表目前不建議自動進場。
        </p>
      )}
    </div>
  )
}

function normalizeWatchPoint(point: string): string {
  if (point.startsWith('Alpha bucket:') || point.startsWith('Alpha overlay:')) {
    const ctx = contextFromWatchPoints([point])
    const bucket = ctx?.bucket ?? 'unknown'
    const regime = ctx?.regime ?? 'unknown'
    const volatility = ctx?.volatility ?? 'unknown'
    const liquidity = ctx?.liquidity ?? 'unknown'
    const sizing = ctx?.sizing == null || Number.isNaN(ctx.sizing) ? '-' : `x${fmtNumber(ctx.sizing, 2)}`
    return `Alpha bucket：${shortLabelFor(bucket)}；大盤狀態：${shortLabelFor(regime, REGIME_TEXT)}；部位倍率：${sizing}；風險：${shortLabelFor(volatility, VOL_TEXT)} / ${shortLabelFor(liquidity, LIQUIDITY_TEXT)}。白話：這是在說目前適合哪一種交易邏輯，會影響 allocation、sizing 與風控。`
  }
  if (point.startsWith('Market structure:')) {
    const ctx = contextFromWatchPoints([point])
    const fairValue = ctx?.fairValueLow || ctx?.fairValueHigh
      ? `${fmtNumber(ctx?.fairValueLow, 2)} ~ ${fmtNumber(ctx?.fairValueHigh, 2)}`
      : '-'
    return `Market structure：POC=${fmtNumber(ctx?.poc, 2)}；fair value=${fairValue}；價格位置=${shortLabelFor(ctx?.location, LOCATION_TEXT)}。白話：POC 是近期量能重心，fair value 是合理價格帶，價格位置用來判斷是否追高或折價。`
  }
  if (point.startsWith('ML ensemble:')) {
    const bullish = point.match(/bullish=([^,]+)/)?.[1] ?? '-'
    const bearish = point.match(/bearish=([^,]+)/)?.[1] ?? '-'
    const flat = point.match(/flat=([^,]+)/)?.[1] ?? '0'
    const missing = point.match(/missing=([^,]+)/)?.[1] ?? '0'
    const forecast = point.match(/forecast=([^,%]+)%/)?.[1] ?? 'n/a'
    const bullishThreshold = point.match(/bullish_threshold=([^,]+)/)?.[1]
    const bearishThreshold = point.match(/bearish_threshold=([^,]+)/)?.[1]
    const thresholdText = bullishThreshold && bearishThreshold
      ? `目前門檻：>=${bullishThreshold} 看漲，<=${bearishThreshold} 看跌。`
      : '目前門檻會依 regime / trading config 調整。'
    return `ML ensemble：${bullish} 看漲、${bearish} 看跌、${flat} 觀望、${missing} 未回傳，預期報酬 ${forecast}%。白話：觀望不是模型沒跑，而是 rank score 落在看漲/看跌門檻中間，訊號強度不夠明確。${thresholdText}`
  }
  const executionExplanation = explainExecutionEvent(point)
  if (executionExplanation) return executionExplanation
  return point
}

function isContextWatchPoint(point: string): boolean {
  const normalized = point.trim()
  return normalized.startsWith('Alpha bucket:')
    || normalized.startsWith('Alpha overlay:')
    || normalized.startsWith('Market structure:')
    || normalized.startsWith('ML ensemble:')
    || normalized.startsWith('screener_funnel:')
    || normalized.startsWith('Alpha bucket：')
    || normalized.startsWith('Alpha overlay：')
    || normalized.startsWith('Market structure：')
    || normalized.startsWith('ML ensemble：')
}

function executionWatchPointKey(point: string): string {
  const event = parseExecutionEvent(point)
  if (!event) return point.trim()
  if (event.kind === 'execution' && event.status === 'deferred') {
    if (event.reason.startsWith('volume_ratio_low')) return 'execution:deferred:volume_ratio_low'
    if (event.reason.startsWith('momentum_unavailable')) return 'execution:deferred:momentum_unavailable'
    if (event.reason.startsWith('price_above_entry')) return 'execution:deferred:price_above_entry'
  }
  return `${event.kind}:${event.status}:${event.reason}`
}

function displayWatchPoints(points: string[]): string[] {
  const latestByKey = new Map<string, string>()
  for (const point of points) {
    if (isContextWatchPoint(point)) continue
    const key = executionWatchPointKey(point)
    if (latestByKey.has(key)) latestByKey.delete(key)
    latestByKey.set(key, point)
  }
  return [...latestByKey.values()]
}

export function RecommendationCardClean({ rec, rank }: { rec: any; rank: number }) {
  const [expanded, setExpanded] = useState(false)
  const sig = SIGNAL_CONFIG[rec.signal] ?? SIGNAL_CONFIG.HOLD
  const SigIcon = sig.icon
  const watchPoints = normalizeWatchPoints(rec.watch_points)
  const noticePoints = displayWatchPoints(watchPoints)
  const alphaContext = alphaContextFromRec(rec, watchPoints)
  const displayReason = translateRecommendationReason(rec.reason)
  const mlVoteSummary = mlVoteSummaryFromRec(rec)
  const mlSummary = formatMlVoteSummary(mlVoteSummary) ?? extractMlSummary(displayReason)
  const mlMetadataGap = mlMetadataGapText(rec, mlVoteSummary)
  const mlThresholdText = formatMlThresholdText(mlVoteSummary)
  const screenerFunnel = screenerFunnelFromRec(rec)
  const chip5dRaw = rec.chip_cash_total_5d ?? (
    (rec.chip_cash_foreign_5d ?? rec.foreign_net_5d ?? 0)
    + (rec.chip_cash_trust_5d ?? rec.trust_net_5d ?? 0)
    + (rec.dealer_net_5d ?? 0)
  )
  const chipPositive = chip5dRaw > 0

  return (
    <div className={cn(
      'rounded-xl border transition-all',
      rank === 1
        ? 'border-amber-500/40 bg-amber-500/[0.06] shadow-sm'
        : 'border-border/50 bg-card hover:border-border',
    )}>
      <div
        className="flex cursor-pointer select-none items-center gap-3 p-3 sm:p-4"
        onClick={() => setExpanded((value) => !value)}
      >
        <div className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold',
          rank === 1 ? 'bg-amber-400 text-white' :
          rank === 2 ? 'bg-gray-400 text-white' :
          rank === 3 ? 'bg-orange-400 text-white' :
          'bg-muted text-muted-foreground',
        )}>
          {rank}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{rec.symbol}</span>
            <span className="truncate text-sm text-muted-foreground">{rec.name}</span>
            {rec.sector && (
              <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">{rec.sector}</Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <Badge className={cn('px-1.5 py-0 text-[10px]', sig.color)}>
              <SigIcon className="mr-1 h-2.5 w-2.5" />
              {sig.label}
            </Badge>
            <span className={cn('flex items-center gap-1 text-xs', chipPositive ? 'text-red-500' : 'text-emerald-500')}>
              <Users className="h-3 w-3" />
              籌碼 {fmtChipAmount(chip5dRaw)}
            </span>
            {rec.rsi14 != null && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <BarChart3 className="h-3 w-3" />
                RSI {fmtNumber(rec.rsi14, 1)}
              </span>
            )}
            {(mlSummary || mlMetadataGap) && (
              <Badge variant="outline" className="max-w-full truncate border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0 text-[10px] text-emerald-700 dark:text-emerald-300">
                ML {mlSummary ?? `分數 ${fmtNumber(rec.ml_score, 1)}，投票明細待同步`}
              </Badge>
            )}
            {alphaContext?.bucket && (
              <Badge variant="outline" className="gap-1 border-sky-500/40 bg-sky-500/10 px-1.5 py-0 text-[10px] text-sky-700 dark:text-sky-300">
                <ShieldCheck className="h-2.5 w-2.5" />
                {labelFor(alphaContext.bucket)}
              </Badge>
            )}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className="text-lg font-bold text-primary">{Math.round(Number(rec.score ?? 0))}</div>
          <div className="text-[10px] text-muted-foreground">最終分</div>
        </div>

        {expanded ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </div>

      {expanded && (
        <div className="space-y-4 border-t border-border/40 px-4 pb-4 pt-3">
          <div className="space-y-1.5">
            <p className="mb-2 text-xs font-medium text-muted-foreground">基礎分數</p>
            <ScoreBar label="籌碼" value={Number(rec.chip_score ?? 0)} max={40} color="bg-blue-500" />
            <ScoreBar label="技術" value={Number(rec.tech_score ?? 0)} max={30} color="bg-purple-500" />
            <ScoreBar label="ML" value={Number(rec.ml_score ?? 0)} max={30} color="bg-emerald-500" />
          </div>

          <ScoreBreakdownV2 rec={rec} />

          {screenerFunnel && (
            <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.05] p-3 text-xs">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="font-medium text-cyan-700 dark:text-cyan-300">Screener 入選漏斗</p>
                {screenerFunnel.rank != null && (
                  <span className="font-mono text-cyan-700 dark:text-cyan-300">#{screenerFunnel.rank}</span>
                )}
              </div>
              {screenerFunnel.chips.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {screenerFunnel.chips.map((chip) => (
                    <Badge key={chip} variant="outline" className="border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0 text-[10px] text-cyan-700 dark:text-cyan-300">
                      {chip}
                    </Badge>
                  ))}
                </div>
              )}
              {screenerFunnel.notes.length > 0 && (
                <p className="leading-relaxed text-muted-foreground">
                  {screenerFunnel.notes.join('；')}
                </p>
              )}
            </div>
          )}

          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">推薦理由</p>
            <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">{displayReason}</p>
          </div>

          {(mlSummary || mlMetadataGap) && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-3 text-xs leading-relaxed text-muted-foreground">
              <p className="mb-1 font-medium text-emerald-700 dark:text-emerald-300">ML 解讀</p>
              <p>{mlSummary ? `${mlSummary}。這是模型投票/共識與預期報酬的摘要，用來輔助判斷，但仍要搭配 alpha bucket、market structure 和盤中再評估。` : mlMetadataGap}</p>
              {mlThresholdText && <p className="mt-1 text-muted-foreground/80">{mlThresholdText}</p>}
            </div>
          )}

          <AlphaContextBlock context={alphaContext} />

          {noticePoints.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <AlertCircle className="h-3 w-3" />
                注意事項
              </p>
              <ul className="space-y-1">
                {noticePoints.map((point, index) => (
                  <li key={`${point}-${index}`} className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
                    <span className="mt-0.5 shrink-0 text-amber-500">!</span>
                    {normalizeWatchPoint(point)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {rec.confidence != null && (
            <p className="text-[11px] text-muted-foreground">
              ML 信心度 {(Number(rec.confidence) * 100).toFixed(0)}%
              {rec.current_price != null && (
                <span className="ml-3">參考價 ${fmtNumber(rec.current_price, 2)}</span>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
