import { useEffect, useRef, useState, type ElementType } from 'react'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type ChartOptions,
  type DeepPartial,
  type IChartApi,
  type Time,
} from 'lightweight-charts'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  BarChart3,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Minus,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { explainExecutionEvent, parseExecutionEvent } from '@/lib/executionEvent'
import { stocksApi } from '@/lib/api'
import { buildScoreBreakdownViewModel } from '@/lib/scoreV2ViewModel'
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
  optimisticValueLow?: string | number | null
  optimisticValueHigh?: string | number | null
  optimisticValueStatus?: string | null
  upsideToOptimisticHighPct?: string | number | null
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
  activeWeightCount?: number | null
  zeroWeightModels?: string[]
  contributingModels?: string[]
  thresholds?: {
    bullish?: number
    bearish?: number
    regime?: string
    adjustment?: number
  }
  icWeightScope?: string
  validationBlockedModels?: string[]
}

type MlDiagnosticsSummary = {
  totalAlphaModels?: number
  activeWeightCount?: number
  zeroWeightModels?: string[]
  contributingModels?: string[]
  validationBlockedModels?: string[]
  icWeightScope?: string | null
  rankSignalThresholds?: Record<string, unknown> | null
  forecastCalibration?: {
    method?: string | null
    source?: string | null
    sampleCount?: number | null
    binSamples?: number | null
    bin?: string | number | null
  }
  dispersion?: {
    rawModelCount?: number | null
    rawRankStd?: number | null
    mergeCompression?: number | null
    weightHhi?: number | null
  }
}

type EvidenceLink = {
  source?: string
  title?: string
  url?: string
  published_at?: string
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
  '閱讀提示：基礎分由 ML Edge、籌碼流、技術結構、基本面與新聞題材組成；Alpha 調整會依風控與市場狀態加減分；Slate 只影響清單分散與配置順序，不再直接加到預測分數。ML 摘要提供模型共識與校準後預期報酬，最後仍要搭配 alpha bucket、market structure 與盤中再評估。'

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

function displayForecastPct(summary: MlVoteSummary | null): number | null {
  if (!summary) return null
  if (typeof summary.forecastPct === 'number' && Number.isFinite(summary.forecastPct)) {
    return summary.forecastPct
  }
  const raw = summary.forecast_pct
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return Math.abs(raw) <= 0.2 ? raw * 100 : raw
}

function normalizeForecastPctForUi(raw: unknown): number | null {
  const value = Number(raw)
  if (!Number.isFinite(value)) return null
  return Math.abs(value) <= 0.2 ? value * 100 : value
}

function normalizePersistedForecastPctForUi(summary: any): number | null {
  // Contract: `forecast_pct` is raw return fraction; legacy `forecastPct`
  // rows were also written as fraction before the 2026-05-13 contract fix.
  return normalizeForecastPctForUi(summary?.forecast_pct ?? summary?.forecastPct)
}

function finiteMetric(raw: unknown): number | null {
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
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
  const optimisticValue = extractValue(structurePoint ?? '', 'optimistic_value')
  const [optimisticValueLow, optimisticValueHigh] = optimisticValue ? optimisticValue.split('~') : []

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
    optimisticValueLow,
    optimisticValueHigh,
    optimisticValueStatus: extractValue(structurePoint ?? '', 'optimistic_status') ?? undefined,
    upsideToOptimisticHighPct: extractValue(structurePoint ?? '', 'upside_to_optimistic_high_pct') ?? undefined,
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

function scoreV2PayloadFromRec(rec: any): any | null {
  const raw = parseObject(rec?.score_v2)
  const nested = parseObject(raw?.payload)
  const payload = nested?.version === 'score_v2' || nested?.source === 'score_v2' ? nested : raw
  if (!payload) return null
  const hasScoreV2Marker = payload.version === 'score_v2' || payload.source === 'score_v2'
  const hasScoreV2Score = Number.isFinite(Number(payload.finalScore ?? payload.total))
  const hasScoreV2Components = parseObject(payload.components) != null
  return hasScoreV2Marker && (hasScoreV2Score || hasScoreV2Components)
    ? { ...payload, version: 'score_v2', source: payload.source ?? 'score_v2' }
    : null
}

function scoreComponentValue(rec: any, key: string): number {
  const row = buildScoreBreakdownViewModel(rec ?? {}).rows.find((item) => item.key === key)
  return Number.isFinite(row?.value) ? Number(row?.value) : 0
}

function mlVoteSummaryFromRec(rec: any): MlVoteSummary | null {
  const persisted = parseObject(rec.ml_vote_summary)
  if (persisted && Number(persisted.total ?? 0) <= ALPHA_PREDICTION_MODEL_NAMES.length) {
    const reported = Number(persisted.reported ?? 0)
    const evidence = Number(persisted.bullish ?? 0) + Number(persisted.bearish ?? 0) + Number(persisted.flat ?? 0)
    if (reported > 0 || evidence > 0 || scoreComponentValue(rec, 'mlEdge') <= 0) {
      return {
        ...persisted,
        forecastPct: normalizePersistedForecastPctForUi(persisted),
      }
    }
  }
  const forecast = parseForecastData(rec.prediction_forecast_data)
  const models = Array.isArray(forecast?.models)
    ? forecast.models.filter((model: any) => isAlphaPredictionModelName(model?.name ?? model?.model_name ?? model))
    : []
  const weights = forecast?.ensemble_v2?.weights && typeof forecast.ensemble_v2.weights === 'object'
    ? forecast.ensemble_v2.weights
    : {}
  const diagnostics = forecast?.ensemble_v2?.ic_weight_diagnostics && typeof forecast.ensemble_v2.ic_weight_diagnostics === 'object'
    ? forecast.ensemble_v2.ic_weight_diagnostics
    : {}
  const thresholds = forecast?.ensemble_v2?.rank_signal_thresholds && typeof forecast.ensemble_v2.rank_signal_thresholds === 'object'
    ? forecast.ensemble_v2.rank_signal_thresholds
    : null
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
    forecastPct: normalizeForecastPctForUi(forecast.ensemble_v2?.forecast_pct),
    icWeightScope: forecast.ensemble_v2?.ic_weight_scope ?? forecast.stock_meta?.market_segment ?? null,
    thresholds: thresholds
      ? {
          bullish: Number(thresholds.buyThreshold ?? thresholds.strongBuyThreshold),
          bearish: Number(thresholds.sellThreshold ?? thresholds.strongSellThreshold),
          adjustment: Number(thresholds.confidence_delta ?? 0),
        }
      : undefined,
    zeroWeightModels: Object.entries(weights)
      .filter(([name, value]) => isAlphaPredictionModelName(name) && Number(value) <= 0)
      .map(([name]) => name),
    validationBlockedModels: Object.entries(diagnostics)
      .filter(([, detail]: [string, any]) => String(detail?.validation_status ?? '').toUpperCase() === 'FAIL')
      .map(([name]) => name),
  }
}

function mlDiagnosticsFromRec(rec: any): MlDiagnosticsSummary | null {
  const persisted = parseObject(rec.ml_diagnostics)
  if (persisted) return persisted
  const forecast = parseForecastData(rec.prediction_forecast_data)
  if (!forecast) return null
  const ev2 = forecast?.ensemble_v2 && typeof forecast.ensemble_v2 === 'object'
    ? forecast.ensemble_v2
    : {}
  const weights = ev2?.weights && typeof ev2.weights === 'object'
    ? ev2.weights
    : {}
  const diagnostics = ev2?.ic_weight_diagnostics && typeof ev2.ic_weight_diagnostics === 'object'
    ? ev2.ic_weight_diagnostics
    : {}
  const dispersion = forecast?.dispersion_diagnostics && typeof forecast.dispersion_diagnostics === 'object'
    ? forecast.dispersion_diagnostics
    : {}
  const zeroWeightModels = Array.isArray(dispersion.zero_weight_models)
    ? dispersion.zero_weight_models.filter(isAlphaPredictionModelName)
    : Object.entries(weights)
      .filter(([name, value]) => isAlphaPredictionModelName(name) && Number(value) <= 0)
      .map(([name]) => name)

  return {
    totalAlphaModels: ALPHA_PREDICTION_MODEL_NAMES.length,
    activeWeightCount: Object.entries(weights).filter(([name, value]) => isAlphaPredictionModelName(name) && Number(value) > 0).length,
    zeroWeightModels,
    contributingModels: Array.isArray(ev2.contributing_models) ? ev2.contributing_models.filter(isAlphaPredictionModelName) : [],
    validationBlockedModels: Object.entries(diagnostics)
      .filter(([, detail]: [string, any]) => String(detail?.validation_status ?? '').toUpperCase() === 'FAIL')
      .map(([name]) => name)
      .filter(isAlphaPredictionModelName),
    icWeightScope: ev2.ic_weight_scope ?? forecast.stock_meta?.market_segment ?? null,
    forecastCalibration: {
      method: ev2.forecast_calibration_method ?? null,
      source: ev2.forecast_pct_source ?? null,
      sampleCount: Number.isFinite(Number(ev2.forecast_calibration_sample_count)) ? Number(ev2.forecast_calibration_sample_count) : null,
      binSamples: Number.isFinite(Number(ev2.forecast_calibration_bin_samples)) ? Number(ev2.forecast_calibration_bin_samples) : null,
      bin: ev2.forecast_calibration_bin ?? null,
    },
    dispersion: {
      rawModelCount: Number.isFinite(Number(dispersion.raw_model_count)) ? Number(dispersion.raw_model_count) : null,
      rawRankStd: Number.isFinite(Number(dispersion.raw_rank_std)) ? Number(dispersion.raw_rank_std) : null,
      mergeCompression: Number.isFinite(Number(dispersion.merge_compression)) ? Number(dispersion.merge_compression) : null,
      weightHhi: Number.isFinite(Number(dispersion.weight_hhi)) ? Number(dispersion.weight_hhi) : null,
    },
  }
}

function mlMetadataGapText(rec: any, summary: MlVoteSummary | null): string | null {
  const mlScore = scoreComponentValue(rec, 'mlEdge')
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
  const forecastPct = displayForecastPct(summary)
  const forecast = typeof forecastPct === 'number' && Number.isFinite(forecastPct)
    ? `，校準預期${forecastPct >= 0 ? '+' : ''}${forecastPct.toFixed(1)}%`
    : ''
  const missingText = missing > 0 ? `，${missing}/${total}未回傳` : ''
  const flat = Number(summary.flat ?? Math.max(0, total - bullish - bearish - missing))
  const flatText = flat > 0 ? `、${flat}/${total}觀望` : ''
  return `${bullish}/${total}看漲、${bearish}/${total}看跌${flatText}${missingText}${forecast}`
}

function formatMlVoteSummaryReadable(summary: MlVoteSummary | null): string | null {
  if (!summary) return null
  const total = Number(summary.total ?? 0)
  if (!Number.isFinite(total) || total <= 0) return null
  const bullish = Number(summary.bullish ?? 0)
  const bearish = Number(summary.bearish ?? 0)
  const flat = Number(summary.flat ?? 0)
  const reported = Number(summary.reported ?? bullish + bearish + flat)
  const missing = Number(summary.missing ?? Math.max(0, total - reported))
  if (reported <= 0 || bullish + bearish + flat <= 0) {
    return `ML 投票資料不足（${Math.max(0, reported)}/${total} 回報）`
  }
  const forecastPct = displayForecastPct(summary)
  const forecast = typeof forecastPct === 'number' && Number.isFinite(forecastPct)
    ? `，校準預期${forecastPct >= 0 ? '+' : ''}${forecastPct.toFixed(1)}%`
    : ''
  const flatText = flat > 0 ? `，${flat}/${total}中性` : ''
  const missingText = missing > 0 ? `，${missing}/${total}未回報` : ''
  const activeWeight = Number(summary.activeWeightCount ?? total - (summary.zeroWeightModels?.length ?? 0))
  const weightText = Number.isFinite(activeWeight)
    ? `；採信權重 ${Math.max(0, activeWeight)}/${total}`
    : ''
  const zeroWeightText = Array.isArray(summary.zeroWeightModels) && summary.zeroWeightModels.length > 0
    ? `（0 權重：${summary.zeroWeightModels.join('/')}，IC/lifecycle gate）`
    : ''
  return `${bullish}/${total}原始看漲、${bearish}/${total}原始看跌${flatText}${missingText}${forecast}${weightText}${zeroWeightText}`
}

function formatMlVoteSummaryForBadge(summary: MlVoteSummary | null): string | null {
  if (!summary) return null
  const total = Number(summary.total ?? 0)
  if (!Number.isFinite(total) || total <= 0) return null
  const bullish = Number(summary.bullish ?? 0)
  const bearish = Number(summary.bearish ?? 0)
  const flat = Number(summary.flat ?? Math.max(0, total - bullish - bearish))
  const reported = Number(summary.reported ?? bullish + bearish + flat)
  const missing = Number(summary.missing ?? Math.max(0, total - reported))
  const forecastPct = displayForecastPct(summary)
  const forecast = typeof forecastPct === 'number' && Number.isFinite(forecastPct)
    ? `，校準預期${forecastPct >= 0 ? '+' : ''}${forecastPct.toFixed(1)}%`
    : ''
  const flatText = flat > 0 ? `、${flat}/${total}中性` : ''
  const missingText = missing > 0 ? `、${missing}/${total}缺資料` : ''
  const activeWeight = Number(summary.activeWeightCount ?? total - (summary.zeroWeightModels?.length ?? 0))
  const weightText = Number.isFinite(activeWeight)
    ? `；採信權重${Math.max(0, activeWeight)}/${total}`
    : ''
  const zeroWeightText = Array.isArray(summary.zeroWeightModels) && summary.zeroWeightModels.length > 0
    ? `（${summary.zeroWeightModels.length}模型0權重）`
    : ''
  return `${bullish}/${total}原始看漲、${bearish}/${total}原始看跌${flatText}${missingText}${forecast}${weightText}${zeroWeightText}`
}

function MlDiagnosticsStrip({ diagnostics }: { diagnostics: MlDiagnosticsSummary | null }) {
  if (!diagnostics) return null
  const total = Number(diagnostics.totalAlphaModels ?? ALPHA_PREDICTION_MODEL_NAMES.length)
  const active = Number(diagnostics.activeWeightCount ?? 0)
  const zeroWeightModels = diagnostics.zeroWeightModels ?? []
  const blockedModels = diagnostics.validationBlockedModels ?? []
  const calibration = diagnostics.forecastCalibration
  const dispersion = diagnostics.dispersion
  const thresholds = diagnostics.rankSignalThresholds ?? {}
  const buyThreshold = finiteMetric((thresholds as any).buyThreshold ?? (thresholds as any).bullish)
  const sellThreshold = finiteMetric((thresholds as any).sellThreshold ?? (thresholds as any).bearish)
  const chips: string[] = []

  chips.push(`權重 ${Number.isFinite(active) ? active : 0}/${Number.isFinite(total) ? total : ALPHA_PREDICTION_MODEL_NAMES.length}`)
  if (diagnostics.icWeightScope) chips.push(`IC scope ${diagnostics.icWeightScope}`)
  if (buyThreshold != null && sellThreshold != null) chips.push(`動態門檻 BUY ${fmtNumber(buyThreshold, 3)} / SELL ${fmtNumber(sellThreshold, 3)}`)
  if (dispersion?.rawRankStd != null) chips.push(`模型分歧 σ ${fmtNumber(dispersion.rawRankStd, 3)}`)
  if (dispersion?.mergeCompression != null) chips.push(`合併壓縮 ${fmtNumber(dispersion.mergeCompression, 2)}`)
  if (calibration?.method || calibration?.source) {
    const samples = calibration.sampleCount != null ? ` / 樣本 ${fmtNumber(calibration.sampleCount, 0)}` : ''
    chips.push(`預期值校準 ${calibration.method ?? calibration.source}${samples}`)
  }

  const warnings = [
    zeroWeightModels.length > 0 ? `0 權重：${zeroWeightModels.join('、')}` : null,
    blockedModels.length > 0 ? `驗證擋下：${blockedModels.join('、')}` : null,
  ].filter(Boolean)

  return (
    <div className="mt-2 rounded-md border border-emerald-500/15 bg-background/45 p-2">
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <Badge key={chip} variant="outline" className="border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0 text-[10px] text-emerald-700 dark:text-emerald-300">
            {chip}
          </Badge>
        ))}
      </div>
      {warnings.length > 0 && (
        <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
          {warnings.join('；')}。這代表該模型有回報 raw rank，但目前不被 ensemble 採信或只給探索底權重，原因通常是 segment IC、lifecycle 或 validation gate 不足。
        </p>
      )}
    </div>
  )
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
    .replace(/(^|[^校準])預期 ([+-]\d+(?:\.\d+)?%)/g, '$1校準預期 $2')
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
    optimisticValueLow: structure.optimistic_value_low,
    optimisticValueHigh: structure.optimistic_value_high,
    optimisticValueStatus: structure.optimistic_value_status,
    upsideToOptimisticHighPct: structure.upside_to_optimistic_high_pct,
    location: structure.price_location,
    window: structure.window_start_date && structure.window_end_date
      ? `${structure.window_start_date}~${structure.window_end_date}`
      : undefined,
    latestClose: structure.latest_close,
  }
}

function ScoreBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const safeValue = Number.isFinite(value) ? value : 0
  const safeMax = Number.isFinite(max) ? max : 0
  const pct = safeMax > 0 ? Math.max(0, Math.min(100, Math.round((safeValue / safeMax) * 100))) : 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="min-w-16 shrink-0 text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-14 text-right font-mono text-muted-foreground">
        {fmtNumber(safeValue, 1)}/{fmtNumber(safeMax, 0)}
      </span>
    </div>
  )
}

function signedText(value: number | null | undefined, decimals = 1): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}`
}

function ScoreFormulaSummary({ viewModel }: { viewModel: ReturnType<typeof buildScoreBreakdownViewModel> }) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/50 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">基礎分數與 Alpha 調整</p>
        <span className="font-mono text-xs text-muted-foreground">
          {fmtNumber(viewModel.finalScore, 1)} = {fmtNumber(viewModel.baseScore, 1)} {viewModel.alphaAdjustment >= 0 ? '+' : '-'} {fmtNumber(Math.abs(viewModel.alphaAdjustment), 1)}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-md border border-border/40 bg-muted/20 p-2">
          <p className="text-[10px] text-muted-foreground">基礎分數</p>
          <p className="mt-0.5 font-mono text-lg font-semibold">{fmtNumber(viewModel.baseScore, 1)}</p>
        </div>
        <div className="rounded-md border border-sky-500/25 bg-sky-500/[0.06] p-2">
          <p className="text-[10px] text-sky-700 dark:text-sky-300">Alpha 調整</p>
          <p className="mt-0.5 font-mono text-lg font-semibold text-sky-700 dark:text-sky-300">{signedText(viewModel.alphaAdjustment)}</p>
        </div>
        <div className="rounded-md border border-primary/25 bg-primary/[0.06] p-2">
          <p className="text-[10px] text-muted-foreground">最終分數</p>
          <p className="mt-0.5 font-mono text-lg font-semibold text-primary">{fmtNumber(viewModel.finalScore, 1)}</p>
        </div>
      </div>
      {Math.abs(viewModel.residual) >= 0.1 && (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          資料校準差 {signedText(viewModel.residual)}，代表後端總分與目前可拆解欄位仍有不同步。
        </p>
      )}
    </div>
  )
}

function alphaDetailsFromRec(rec: any): any[] {
  const payload = scoreV2PayloadFromRec(rec)
  const alphaReason = parseObject(payload?.alphaReason)
  const details = Array.isArray(alphaReason?.details) ? alphaReason.details : []
  return details.filter((item: any) => item && item.value != null)
}

function ScoreBreakdownV2({ rec }: { rec: any }) {
  const viewModel = buildScoreBreakdownViewModel(rec)
  const riskText = viewModel.riskFlags.length > 0 ? viewModel.riskFlags.join(', ') : '無'
  const alphaDetails = alphaDetailsFromRec(rec)

  return (
    <div className="rounded-lg border border-border/50 bg-background/50 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-muted-foreground">Score V2 分解</span>
        <span className="font-mono text-[11px] text-muted-foreground">技術結構 + Alpha 明細</span>
      </div>
      {viewModel.technicalRows.length > 0 && (
        <div className="mt-2 space-y-2 rounded-md border border-violet-500/20 bg-violet-500/[0.05] p-2">
          <p className="font-medium text-foreground/80">技術結構細項</p>
          {viewModel.technicalRows.map((item) => (
            <div key={item.key} className="space-y-1">
              <ScoreBar label={item.label} value={item.value} max={item.max} color={item.color} />
              {item.explanation && (
                <p className="pl-[72px] text-[11px] leading-relaxed text-muted-foreground/85 sm:pl-[74px]">
                  {item.explanation}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {viewModel.hasBackendPayload && alphaDetails.length > 0 && (
        <div className="mt-2 space-y-1 rounded-md border border-border/40 bg-muted/20 p-2 text-[11px] leading-relaxed text-muted-foreground/90">
          <p className="font-medium text-foreground/80">Alpha 調整明細</p>
          {alphaDetails.map((item, index) => (
            <p key={`${item.key ?? item.label}-${index}`}>
              {item.label ?? item.key}: {Number(item.value) >= 0 ? '+' : ''}{fmtNumber(item.value, 1)}
              {item.explain ? `, ${item.explain}` : ''}
            </p>
          ))}
        </div>
      )}
      {viewModel.hasBackendPayload && alphaDetails.length === 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
          Alpha 調整目前沒有細項，風險旗標: {riskText}
        </p>
      )}
    </div>
  )
}

function reasonTextFromValue(raw: unknown): string | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    const text = raw.trim()
    return text ? translateRecommendationReason(text) : null
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, any>
  return reasonTextFromValue(obj.reason ?? obj.text ?? obj.summary ?? obj.recommendation_reason)
}

function breeze2WatchPointSummary(point: string): string | null {
  const body = point.replace(/^breeze2:/i, '').trim()
  if (!body) return null
  const context = body.match(/^([a-z_]+)\s+/i)?.[1]
  const fact = body.match(/\bfact=([0-9.]+)/i)?.[1]
  const hype = body.match(/\bhype=([0-9.]+)/i)?.[1]
  const quality = body.match(/\bquality=([0-9.]+)/i)?.[1]
  const flags = body.match(/\bflags=([^ ]+)/i)?.[1]
  const contextLabel: Record<string, string> = {
    candidate_context: '候選脈絡',
    watchlist_context: '觀察名單脈絡',
    human_review: '需人工複核',
    insufficient_evidence: '佐證不足',
  }
  const parts = [
    context ? contextLabel[context] ?? context.replace(/_/g, ' ') : null,
    fact ? `事實支撐 ${Number(fact).toFixed(2)}` : null,
    hype ? `題材熱度 ${Number(hype).toFixed(2)}` : null,
    quality ? `來源品質 ${Number(quality).toFixed(2)}` : null,
    flags && flags !== 'none' ? `旗標 ${flags.replace(/_/g, ' ')}` : null,
  ].filter(Boolean)
  return parts.length ? `Breeze2 影子線：${parts.join('；')}。` : null
}

function breeze2ReasonFromRec(rec: any): string | null {
  const scoreV2 = scoreV2PayloadFromRec(rec)
  const reasonVariants = parseObject(scoreV2?.reasonVariants) ?? parseObject(scoreV2?.reason_variants)
  const variants = parseObject(rec.reason_variants) ?? parseObject(rec.llm_reason_variants)
  const breezeWatchPoint = normalizeWatchPoints(rec.watch_points).find((point) => point.startsWith('breeze2:'))
  const breezeWatchSummary = breezeWatchPoint ? breeze2WatchPointSummary(breezeWatchPoint) : null
  return reasonTextFromValue(rec.breeze2_reason_shadow)
    ?? reasonTextFromValue(rec.breeze2_reason)
    ?? reasonTextFromValue(rec.breeze2_shadow_reason)
    ?? reasonTextFromValue(reasonVariants?.breeze2 ?? reasonVariants?.Breeze2)
    ?? reasonTextFromValue(variants?.breeze2 ?? variants?.Breeze2)
    ?? breezeWatchSummary
}

function geminiVariantReasonFromRec(rec: any): string | null {
  const scoreV2 = scoreV2PayloadFromRec(rec)
  const reasonVariants = parseObject(scoreV2?.reasonVariants) ?? parseObject(scoreV2?.reason_variants)
  const variants = parseObject(rec.reason_variants) ?? parseObject(rec.llm_reason_variants)
  return reasonTextFromValue(rec.gemini_reason)
    ?? reasonTextFromValue(rec.gemini_reason_shadow)
    ?? reasonTextFromValue(reasonVariants?.gemini ?? reasonVariants?.Gemini)
    ?? reasonTextFromValue(variants?.gemini ?? variants?.Gemini)
}

function planPrice(value: unknown): string | null {
  return fmtOptionalNumber(value as any, 2)
}

function compactLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function PlanBlock({ title, accent, lines }: { title: string; accent: string; lines: string[] }) {
  return (
    <div className="flex overflow-hidden rounded-md border border-border/50 bg-background/55">
      <div className={cn('w-1 shrink-0', accent)} />
      <div className="min-w-0 flex-1 p-3">
        <p className="text-xs font-medium text-foreground">{title}</p>
        <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-muted-foreground">
          {lines.filter(Boolean).map((line, index) => (
            <p key={`${title}-${index}`}>{line}</p>
          ))}
        </div>
      </div>
    </div>
  )
}

type TradePlanReadRow = {
  label: string
  value: string
  note: string
  tone?: 'good' | 'warn' | 'neutral'
}

function tradePlanToneClass(tone: TradePlanReadRow['tone']) {
  if (tone === 'good') return 'text-emerald-600 dark:text-emerald-300'
  if (tone === 'warn') return 'text-amber-600 dark:text-amber-300'
  return 'text-sky-700 dark:text-sky-300'
}

function TradePlanRow({ row }: { row: TradePlanReadRow }) {
  return (
    <div className="grid gap-1 border-b border-border/30 py-2 last:border-b-0 sm:grid-cols-[6.5rem_8.5rem_1fr] sm:items-start">
      <span className="text-[11px] font-semibold text-foreground/85">{row.label}</span>
      <span className={cn('w-fit rounded-sm border border-current/20 bg-background/70 px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums', tradePlanToneClass(row.tone))}>
        {row.value}
      </span>
      <span className="text-xs leading-relaxed text-muted-foreground">{row.note}</span>
    </div>
  )
}

function ProviderReasonCompare({ geminiReason, breeze2Reason }: { geminiReason: string; breeze2Reason: string | null }) {
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <div className="rounded-md border border-blue-500/20 bg-blue-500/[0.05] p-3">
        <p className="text-[11px] font-medium text-blue-700 dark:text-blue-300">Gemini 3.1 Flash</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{geminiReason}</p>
      </div>
      <div className="rounded-md border border-emerald-500/20 bg-emerald-500/[0.05] p-3">
        <p className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">Breeze2</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {breeze2Reason ?? 'Breeze2 尚未回寫逐檔中文總結；目前正式資料只有模型流程指標，還不能和 Gemini 做逐字理由比較。'}
        </p>
      </div>
    </div>
  )
}

function numericPrice(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function klineChartOptions(width: number): DeepPartial<ChartOptions> {
  return {
    width,
    height: 260,
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: '#94a3b8',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    },
    grid: {
      vertLines: { color: 'rgba(148, 163, 184, 0.08)' },
      horzLines: { color: 'rgba(148, 163, 184, 0.10)' },
    },
    rightPriceScale: {
      borderColor: 'rgba(148, 163, 184, 0.18)',
      scaleMargins: { top: 0.16, bottom: 0.22 },
    },
    timeScale: {
      borderColor: 'rgba(148, 163, 184, 0.18)',
      timeVisible: false,
      secondsVisible: false,
      rightOffset: 8,
      barSpacing: 8,
      minBarSpacing: 5,
    },
    crosshair: {
      mode: CrosshairMode.MagnetOHLC,
      horzLine: { color: 'rgba(56, 189, 248, 0.28)' },
      vertLine: { color: 'rgba(56, 189, 248, 0.28)' },
    },
  }
}

type KlineCandle = {
  time: Time
  open: number
  high: number
  low: number
  close: number
}

function priceRowTime(row: any): Time {
  return String(row?.date ?? '').slice(0, 10) as Time
}

function positivePrice(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function addCalendarDays(time: Time | undefined, days: number): Time | null {
  if (!time || typeof time !== 'string') return null
  const date = new Date(`${time}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return null
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10) as Time
}

function priceRowsToCandles(rows: any[], limit = 42): KlineCandle[] {
  const candles: KlineCandle[] = []
  let prevClose: number | null = null
  for (const item of rows.slice(-limit)) {
    const time = priceRowTime(item)
    const close = positivePrice(item.close ?? item.avg_price)
    if (!time || close == null) continue
    const avg = positivePrice(item.avg_price)
    const rawHigh = positivePrice(item.high)
    const rawLow = positivePrice(item.low)
    const rawOpen = positivePrice(item.open)
    const open = rawOpen ?? prevClose ?? avg ?? close
    const high = Math.max(rawHigh ?? close, open, close)
    const low = Math.min(rawLow ?? close, open, close)
    candles.push({ time, open, high, low, close })
    prevClose = close
  }
  return candles
}

function priceRowsToVolume(rows: any[], candles: KlineCandle[], limit = 42) {
  const candleByTime = new Map(candles.map((candle) => [String(candle.time), candle]))
  return rows
    .slice(-limit)
    .map((item) => {
      const time = priceRowTime(item)
      const candle = candleByTime.get(String(time))
      const value = Number(item.volume ?? item.Trading_Volume ?? item.trading_volume)
      return {
        time,
        value: Number.isFinite(value) ? value : 0,
        color: candle && candle.close >= candle.open ? 'rgba(239, 68, 68, 0.28)' : 'rgba(16, 185, 129, 0.28)',
      }
    })
    .filter((item) => Boolean(item.time))
}

function KLinePlanSketch({ rec, context }: { rec: any; context: AlphaContext | null }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const stockId = Number(rec.stock_id ?? rec.stockId ?? rec.id)
  const inlineRows = Array.isArray(rec.price_candles)
    ? rec.price_candles
    : Array.isArray(rec.prices)
      ? rec.prices
      : []
  const { data: fetchedRows = [], isLoading } = useQuery({
    queryKey: ['recommendation-card-kline', stockId],
    queryFn: () => stocksApi.prices(stockId, 120),
    enabled: Number.isFinite(stockId) && stockId > 0 && inlineRows.length === 0,
    staleTime: 5 * 60_000,
  })
  const priceRows = inlineRows.length > 0 ? inlineRows : (fetchedRows as any[])
  const latest = numericPrice(context?.latestClose ?? rec.current_price ?? rec.close ?? rec.latest_close)
  const entry = numericPrice(rec.ml_entry_price ?? rec.entry_price ?? rec.reference_entry)
  const stopLoss = numericPrice(rec.stop_loss ?? rec.stopLoss)
  const fairLow = numericPrice(context?.fairValueLow) ?? stopLoss ?? (latest ? latest * 0.97 : null)
  const fairHigh = numericPrice(context?.fairValueHigh) ?? entry ?? (latest ? latest * 1.02 : null)
  const poc = numericPrice(context?.poc)
  const target = numericPrice(context?.optimisticValueHigh ?? rec.target_price ?? rec.targetPrice) ?? (latest ? latest * 1.06 : fairHigh)
  const support = fairLow ?? poc ?? latest
  const prices = [latest, fairLow, fairHigh, poc, target].filter((value): value is number => value != null)
  const candles = priceRowsToCandles(priceRows)
  const volume = priceRowsToVolume(priceRows, candles)
  const lastTime = candles[candles.length - 1]?.time
  const nextTime = addCalendarDays(lastTime, 1)
  const targetTime = addCalendarDays(lastTime, 3)
  const projection = latest && target && lastTime && nextTime && targetTime
    ? [
      { time: lastTime, value: latest },
      { time: nextTime, value: fairHigh ?? latest },
      { time: targetTime, value: target },
    ]
    : []
  const chartKey = JSON.stringify({
    stockId,
    latest,
    support,
    fairHigh,
    target,
    rows: candles.map((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close]),
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container || candles.length === 0) return

    const chart = createChart(container, klineChartOptions(container.clientWidth || 420))
    chartRef.current = chart

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#ef4444',
      downColor: '#22c55e',
      borderUpColor: '#ef4444',
      borderDownColor: '#22c55e',
      wickUpColor: '#fca5a5',
      wickDownColor: '#86efac',
      priceLineVisible: false,
    })
    candleSeries.setData(candles)

    if (volume.length) {
      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        priceLineVisible: false,
        lastValueVisible: false,
      }, 1)
      volumeSeries.setData(volume)
    }

    if (projection.length) {
      const projectionSeries = chart.addSeries(LineSeries, {
        color: '#38bdf8',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      projectionSeries.setData(projection)
    }

    if (target) {
      candleSeries.createPriceLine({
        price: target,
        color: '#f87171',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '前高/樂觀上緣',
      })
    }
    if (fairHigh) {
      candleSeries.createPriceLine({
        price: fairHigh,
        color: '#38bdf8',
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: '突破確認',
      })
    }
    if (support) {
      candleSeries.createPriceLine({
        price: support,
        color: '#22c55e',
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: '關鍵支撐',
      })
    }

    if (poc) {
      candleSeries.createPriceLine({
        price: poc,
        color: '#f59e0b',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: 'POC',
      })
    }

    chart.panes()[1]?.setHeight(64)
    chart.timeScale().fitContent()
    if (candles.length > 32) {
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, candles.length - 32),
        to: candles.length + 5,
      })
    }

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0]
        if (!entry) return
        chart.applyOptions({ width: Math.max(280, Math.floor(entry.contentRect.width)) })
      })
      resizeObserver.observe(container)
    }

    return () => {
      resizeObserver?.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [chartKey])

  if (isLoading && candles.length === 0) {
    return <div className="h-[300px] animate-pulse rounded-md border border-border/50 bg-background/60" />
  }

  if (prices.length === 0 || candles.length === 0) {
    return (
      <div className="rounded-md border border-border/50 bg-background/60 p-3 text-xs text-muted-foreground">
        K線策略圖：價格資料不足，暫時只能保留文字交易計劃。
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-md border border-border/50 bg-background/60">
      <div className="flex items-center justify-between border-b border-border/30 px-3 py-2">
        <span className="text-xs font-medium text-foreground">K線交易計劃圖</span>
        <span className="font-mono text-[11px] text-muted-foreground">Lightweight Charts</span>
      </div>
      <div ref={containerRef} className="h-[260px] w-full" role="img" aria-label="Lightweight Charts K線交易計劃圖" />
      <div className="grid gap-1 border-t border-border/30 px-3 py-2 text-[11px] sm:grid-cols-3">
        <span className="font-mono text-emerald-500">支撐 {support ? fmtNumber(support, 2) : '-'}</span>
        <span className="font-mono text-sky-500">突破 {fairHigh ? fmtNumber(fairHigh, 2) : '-'}</span>
        <span className="font-mono text-rose-500">樂觀 {target ? fmtNumber(target, 2) : '-'}</span>
      </div>
    </div>
  )
}

function scoreTone(value: number, high: number, low: number): TradePlanReadRow['tone'] {
  if (value >= high) return 'good'
  if (value <= low) return 'warn'
  return 'neutral'
}

function technicalPlanNote(rec: any): string {
  const vm = buildScoreBreakdownViewModel(rec)
  const rows = vm.technicalRows
  const trend = rows.find((row) => row.key === 'trendStructure')?.explanation
  const volume = rows.find((row) => row.key === 'volumeConfirmation')?.explanation
  const execution = rows.find((row) => row.key === 'executionRisk')?.explanation
  return [trend, volume, execution].filter(Boolean).slice(0, 2).join(' ')
    || '技術資料不足，先以盤中量價確認。'
}

function chipPlanNote(rec: any): string {
  const scoreV2 = scoreV2PayloadFromRec(rec)
  const evidence = parseObject(scoreV2?.chipEvidence) ?? parseObject(rec.chip_evidence)
  if (evidence?.broker_net_amount_5d_billion != null) {
    const amount = Number(evidence.broker_net_amount_5d_billion)
    const direction = amount >= 0 ? '買超' : '賣超'
    const brokerCount = evidence.broker_count_latest ?? evidence.broker_count ?? null
    return `興櫃券商分點近5日${direction}${fmtChipAmount(amount)}${brokerCount ? `，參與券商 ${brokerCount} 家` : ''}，只作籌碼輔助判讀。`
  }
  const net = Number(rec.chip_cash_total_5d ?? rec.foreign_net_5d)
  if (Number.isFinite(net)) {
    const direction = net >= 0 ? '買超' : '賣超'
    return `法人5日估算${direction}${fmtChipAmount(net)}，這是股數乘收盤價的 proxy，不等於官方成交金額。`
  }
  return '籌碼來源不足，不能把法人流向當主要理由。'
}

function geminiReasonForCompare(rec: any, reason: string): string {
  const variant = geminiVariantReasonFromRec(rec)
  if (variant) return variant
  const clean = compactLine(reason)
  if (!clean || clean.startsWith('Score V2 ')) {
    const signal = rec.signal ? `訊號 ${rec.signal}` : '訊號待確認'
    return `Gemini 逐檔理由尚未回寫；目前只保留 ${signal} 與 Score V2 結構化資料，避免把分數摘要偽裝成投資建議。`
  }
  return clean
}

function buildTradePlanRows(rec: any, context: AlphaContext | null): TradePlanReadRow[] {
  const vm = buildScoreBreakdownViewModel(rec)
  const ml = vm.rows.find((row) => row.key === 'mlEdge')?.value ?? 0
  const chip = vm.rows.find((row) => row.key === 'chipFlow')?.value ?? 0
  const technical = vm.rows.find((row) => row.key === 'technicalStructure')?.value ?? 0
  const latest = planPrice(context?.latestClose ?? rec.current_price)
  const fairLow = planPrice(context?.fairValueLow)
  const fairHigh = planPrice(context?.fairValueHigh)
  const optimisticLow = planPrice(context?.optimisticValueLow)
  const optimisticHigh = planPrice(context?.optimisticValueHigh)
  const regime = shortLabelFor(context?.regime, REGIME_TEXT)
  const bucket = shortLabelFor(context?.bucket)
  const location = shortLabelFor(context?.location, LOCATION_TEXT)
  const mlSummary = formatMlVoteSummaryForBadge(mlVoteSummaryFromRec(rec)) ?? '模型共識尚未明確'
  const optimisticStatus = shortLabelFor(context?.optimisticValueStatus, {
    upside_available: '仍有空間',
    inside_optimistic_range: '已在區間內',
    exceeded: '已高於上緣',
  })
  return [
    {
      label: '模型共識',
      value: `${fmtNumber(ml, 1)}/25`,
      note: mlSummary,
      tone: scoreTone(ml, 18, 10),
    },
    {
      label: '籌碼流',
      value: `${fmtNumber(chip, 1)}/25`,
      note: chipPlanNote(rec),
      tone: scoreTone(chip, 18, 10),
    },
    {
      label: '技術結構',
      value: `${fmtNumber(technical, 1)}/25`,
      note: technicalPlanNote(rec),
      tone: scoreTone(technical, 18, 10),
    },
    {
      label: 'Alpha 結構',
      value: `${bucket} / ${regime}`,
      note: `現價 ${latest ?? '-'}，fair value ${fairLow ?? '-'}~${fairHigh ?? '-'}，價格位置 ${location}。`,
      tone: context?.skip ? 'warn' : 'neutral',
    },
    {
      label: '樂觀區間',
      value: `${optimisticLow ?? '-'}~${optimisticHigh ?? '-'}`,
      note: optimisticLow || optimisticHigh
        ? `順風上緣假設，狀態：${optimisticStatus}；不是保證目標價，若已高於上緣要視為追價風險。`
        : 'Alpha structure 沒有提供 optimistic range，目標價只能用近端壓力替代。',
      tone: context?.optimisticValueStatus === 'exceeded' ? 'warn' : 'neutral',
    },
  ]
}

function chipPlanValue(rec: any): string {
  const evidence = parseObject(scoreV2PayloadFromRec(rec)?.chipEvidence) ?? parseObject(rec.chip_evidence)
  const brokerAmount = Number(evidence?.broker_net_amount_5d_billion)
  if (Number.isFinite(brokerAmount)) {
    return `${brokerAmount >= 0 ? '買超' : '賣超'} ${Math.abs(brokerAmount).toFixed(2)} 億`
  }
  const net = Number(rec.chip_cash_total_5d ?? rec.foreign_net_5d)
  return Number.isFinite(net)
    ? `${net >= 0 ? '買超' : '賣超'} ${Math.abs(net).toFixed(2)} 億`
    : '資料不足'
}

function alphaStructureValue(context: AlphaContext | null): string {
  const parts = [
    context?.bucket ? `策略 ${shortLabelFor(context.bucket)}` : null,
    context?.regime ? `大盤 ${shortLabelFor(context.regime, REGIME_TEXT)}` : null,
    context?.location ? `位置 ${shortLabelFor(context.location, LOCATION_TEXT)}` : null,
    context?.scoreAdjustment != null ? `Alpha ${signedText(Number(context.scoreAdjustment))}` : null,
    context?.sizing != null ? `部位 x${fmtNumber(context.sizing, 2)}` : null,
    context?.skip ? '風控暫停' : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' / ') : 'Alpha 結構資料不足'
}

function buildFocusedTradePlanRows(rec: any, context: AlphaContext | null): TradePlanReadRow[] {
  const latest = planPrice(context?.latestClose ?? rec.current_price)
  const fairLow = planPrice(context?.fairValueLow)
  const fairHigh = planPrice(context?.fairValueHigh)
  const poc = planPrice(context?.poc)
  const optimisticLow = planPrice(context?.optimisticValueLow)
  const optimisticHigh = planPrice(context?.optimisticValueHigh)
  return [
    { label: '現價', value: latest ?? '-', note: '', tone: 'neutral' },
    { label: 'Fair value', value: `${fairLow ?? '-'} ~ ${fairHigh ?? '-'}`, note: '', tone: 'neutral' },
    { label: 'POC', value: poc ?? '-', note: '', tone: 'neutral' },
    { label: '籌碼', value: chipPlanValue(rec), note: '', tone: String(chipPlanValue(rec)).includes('買超') ? 'good' : 'warn' },
    { label: 'Alpha 結構', value: alphaStructureValue(context), note: '', tone: context?.skip ? 'warn' : 'neutral' },
    { label: '樂觀價格區間', value: `${optimisticLow ?? '-'} ~ ${optimisticHigh ?? '-'}`, note: '', tone: context?.optimisticValueStatus === 'exceeded' ? 'warn' : 'neutral' },
  ]
}

function FocusedTradePlanRow({ row }: { row: TradePlanReadRow }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-start gap-3 border-b border-border/30 py-2 last:border-b-0">
      <span className="text-[11px] font-semibold text-foreground/80">{row.label}</span>
      <span className={cn('min-w-0 break-words font-mono text-xs font-semibold tabular-nums', tradePlanToneClass(row.tone))}>
        {row.value}
      </span>
    </div>
  )
}

function TradingPlanNarrative({ rec, context, reason }: { rec: any; context: AlphaContext | null; reason: string }) {
  const breeze2Reason = breeze2ReasonFromRec(rec)
  const latestClose = planPrice(context?.latestClose ?? rec.current_price)
  const poc = planPrice(context?.poc)
  const fairLow = planPrice(context?.fairValueLow)
  const fairHigh = planPrice(context?.fairValueHigh)
  const optimisticHigh = planPrice(context?.optimisticValueHigh)
  const stop = fairLow ?? poc ?? '近端支撐'
  const breakoutTrigger = fairHigh ?? optimisticHigh ?? '近端壓力'
  const pullbackZone = fairLow && fairHigh ? `${fairLow}~${fairHigh}` : poc ?? '量價支撐區'
  const alphaAdj = context?.scoreAdjustment == null ? 'Alpha 調整資料不足' : `Alpha 調整 ${signedText(Number(context.scoreAdjustment))}`
  const sizing = context?.sizing == null ? '部位倍率待定' : `部位倍率 x${fmtNumber(context.sizing, 2)}`
  const marketLine = [
    latestClose ? `現價 ${latestClose}` : null,
    fairLow || fairHigh ? `fair value ${fairLow ?? '-'}~${fairHigh ?? '-'}` : null,
    poc ? `POC ${poc}` : null,
  ].filter(Boolean).join('，')
  const tradePlanRows = buildFocusedTradePlanRows(rec, context)
  const geminiReason = geminiReasonForCompare(rec, reason)

  return (
    <div className="rounded-lg border border-sky-500/20 bg-sky-500/[0.05] p-3">
      <p className="mb-2 flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-300">
        <ShieldCheck className="h-3 w-3" />
        推薦理由 / Alpha 交易計劃
      </p>
      <div className="grid gap-2">
        <KLinePlanSketch rec={rec} context={context} />
        <div className="flex overflow-hidden rounded-md border border-border/50 bg-background/55">
          <div className="w-1 shrink-0 bg-sky-400" />
          <div className="min-w-0 flex-1 p-3">
            <p className="text-xs font-medium text-foreground">盤勢判讀</p>
            <p className="hidden">
              {marketLine || '市場結構資料不足，先以盤中價量與風控為主。'}
            </p>
            <div className="mt-2">
              {tradePlanRows.map((row) => (
                <FocusedTradePlanRow key={row.label} row={row} />
              ))}
            </div>
          </div>
        </div>
        <div className="grid gap-2 lg:grid-cols-2">
          <PlanBlock
            title="方案 A | 突破追價"
            accent="bg-cyan-400"
            lines={[
              `觸發：收盤站回 ${breakoutTrigger}，且量能不是萎縮。`,
              `進場：突破後回測不破再加碼，避免一根急拉直接追滿。`,
              `目標：先看 ${optimisticHigh ?? '近端高點'}，站穩後再看下一段趨勢延伸。`,
            ]}
          />
          <PlanBlock
            title="方案 B | 拉回低吸"
            accent="bg-emerald-400"
            lines={[
              `觸發：回測 ${pullbackZone} 不破，賣壓縮小後再分批。`,
              `進場：先小部位，等重新轉強再補，不一次滿倉。`,
              `目標：先回到 ${fairHigh ?? 'fair value 上緣'}，再觀察能否轉突破。`,
            ]}
          />
        </div>
        <PlanBlock
          title="風控規則"
          accent="bg-amber-400"
          lines={[
            `${alphaAdj}；${sizing}；${context?.skip ? '風控層標記 skip，暫不自動進場。' : '未被風控層標記 skip。'}`,
            `跌破 ${stop} 或量縮後失守支撐，先降倉，不用硬凹。`,
            '這是系統交易計劃，不是個別投資建議。',
          ]}
        />
      </div>
      <ProviderReasonCompare geminiReason={geminiReason} breeze2Reason={breeze2Reason} />
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
  const optimisticValue = context.optimisticValueLow || context.optimisticValueHigh
    ? `${fmtNumber(context.optimisticValueLow, 2)} ~ ${fmtNumber(context.optimisticValueHigh, 2)}`
    : '-'
  const optimisticExceeded = context.optimisticValueStatus === 'exceeded'
    || (Number(context.latestClose) > 0
      && Number(context.optimisticValueHigh) > 0
      && Number(context.latestClose) > Number(context.optimisticValueHigh))
  const optimisticLabel = optimisticExceeded ? '順風上緣已低於現價' : '樂觀情境區間'
  const optimisticHelp = optimisticExceeded
    ? '目前價格已高於近端量價估出的順風上緣，這不是樂觀目標價，而是偏追高提醒。'
    : '樂觀情境是順風時的上緣假設，不是保證目標價。'
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
        {optimisticValue !== '-' && <span>{optimisticLabel}：{optimisticValue}</span>}
        {context.window && <span>計算區間：{context.window}</span>}
        {context.latestClose != null && <span>區間最後收盤價：{fmtNumber(context.latestClose, 2)}</span>}
        <span className="sm:col-span-2">價格位置：{shortLabelFor(location, LOCATION_TEXT)}</span>
      </div>
      <div className="mt-3 space-y-1.5 text-xs leading-relaxed text-muted-foreground/85">
        <p>{ALPHA_BUCKET_TEXT[bucket]?.help ?? 'Alpha bucket 是系統判斷這檔股票目前主要 edge 來源的分類。'}</p>
        <p>{REGIME_TEXT[regime] ?? 'Regime 是目前大盤狀態，用來調整不同策略類型的權重。'}</p>
        <p>{VOL_TEXT[volatility] ?? VOL_TEXT.unknown} {LIQUIDITY_TEXT[liquidity] ?? LIQUIDITY_TEXT.unknown}</p>
        <p>
          Market structure：{LOCATION_TEXT[location] ?? LOCATION_TEXT.unknown} {optimisticHelp}
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
    const optimisticValue = ctx?.optimisticValueLow || ctx?.optimisticValueHigh
      ? `${fmtNumber(ctx?.optimisticValueLow, 2)} ~ ${fmtNumber(ctx?.optimisticValueHigh, 2)}`
      : null
    const optimisticExceeded = ctx?.optimisticValueStatus === 'exceeded'
      || (Number(ctx?.latestClose) > 0 && Number(ctx?.optimisticValueHigh) > 0 && Number(ctx?.latestClose) > Number(ctx?.optimisticValueHigh))
    const optimisticLabel = optimisticExceeded ? '順風上緣已低於現價' : '樂觀情境'
    const optimisticHelp = optimisticExceeded
      ? '目前價格已高於順風上緣，這是偏追高提醒，不是樂觀目標價。'
      : '樂觀情境是順風時的上緣假設，不是保證目標價。'
    return `Market structure：POC=${fmtNumber(ctx?.poc, 2)}；fair value=${fairValue}${optimisticValue ? `；${optimisticLabel}=${optimisticValue}` : ''}；價格位置=${shortLabelFor(ctx?.location, LOCATION_TEXT)}。白話：這是量價結構位置與追高/低估提醒；${optimisticHelp}`
  }
  if (point.startsWith('ML ensemble:')) {
    const bullish = point.match(/bullish=([^,]+)/)?.[1] ?? '-'
    const bearish = point.match(/bearish=([^,]+)/)?.[1] ?? '-'
    const flat = point.match(/flat=([^,]+)/)?.[1] ?? '0'
    const missing = point.match(/missing=([^,]+)/)?.[1] ?? '0'
    const forecast = point.match(/forecast=([^,%]+)%/)?.[1] ?? 'n/a'
    return `ML ensemble：${bullish} 看漲、${bearish} 看跌、${flat} 觀望、${missing} 未回傳，校準預期報酬 ${forecast}%。白話：投票是門檻判斷，校準預期是由 rank/verified outcomes 映射出的連續報酬估計，兩者不一定同方向。`
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

function isRawDebugWatchPoint(point: string): boolean {
  const normalized = point.trim()
  return normalized.startsWith('breeze2:')
    || /^market_segment:/i.test(normalized)
    || /^chip_source=/i.test(normalized)
    || /(?:^|,)source_date=/i.test(normalized)
    || /broker_net_(?:amount|shares)_5d=/i.test(normalized)
    || /broker_count=|concentration=/i.test(normalized)
    || /^quality=/i.test(normalized)
}

function executionWatchPointKey(point: string): string {
  const event = parseExecutionEvent(point)
  if (!event) return point.trim()
  if (event.kind === 'execution' && event.status === 'stale_quote') return 'execution:stale_quote'
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
    if (isContextWatchPoint(point) || isRawDebugWatchPoint(point)) continue
    const key = executionWatchPointKey(point)
    if (latestByKey.has(key)) latestByKey.delete(key)
    latestByKey.set(key, point)
  }
  return [...latestByKey.values()]
}

function normalizeEvidenceLinks(raw: unknown): EvidenceLink[] {
  if (!Array.isArray(raw)) return []
  const links: EvidenceLink[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as EvidenceLink
    if (typeof row.url !== 'string' || !/^https?:\/\//i.test(row.url)) continue
    links.push({
      source: String(row.source ?? 'news'),
      title: String(row.title ?? row.url).slice(0, 90),
      url: row.url,
      published_at: row.published_at ? String(row.published_at) : '',
    })
    if (links.length >= 3) break
  }
  return links
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
  const mlDiagnostics = mlDiagnosticsFromRec(rec)
  const mlSummary = formatMlVoteSummaryForBadge(mlVoteSummary) ?? formatMlVoteSummaryReadable(mlVoteSummary) ?? formatMlVoteSummary(mlVoteSummary) ?? extractMlSummary(displayReason)
  const mlMetadataGap = mlMetadataGapText(rec, mlVoteSummary)
  const chip5dRaw = rec.chip_cash_total_5d ?? (
    (rec.chip_cash_foreign_5d ?? rec.foreign_net_5d ?? 0)
    + (rec.chip_cash_trust_5d ?? rec.trust_net_5d ?? 0)
    + (rec.dealer_net_5d ?? 0)
  )
  const chipPositive = chip5dRaw > 0
  const evidenceLinks = normalizeEvidenceLinks(rec.evidence_links)
  const isEmerging = String(rec.market_segment ?? '').toUpperCase() === 'EMERGING'
    || String(rec.recommendation_lane ?? '').toLowerCase() === 'emerging_watchlist'
  const chipBadgeLabel = isEmerging ? '券商' : '籌碼'
  const scoreViewModel = buildScoreBreakdownViewModel(rec)

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
              {chipBadgeLabel} {fmtChipAmount(chip5dRaw)}
            </span>
            {rec.rsi14 != null && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <BarChart3 className="h-3 w-3" />
                RSI {fmtNumber(rec.rsi14, 1)}
              </span>
            )}
            {(mlSummary || mlMetadataGap) && (
              <Badge variant="outline" className="h-auto max-w-full shrink whitespace-normal break-words overflow-visible border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-left text-[10px] leading-relaxed text-emerald-700 dark:text-emerald-300">
                ML {mlSummary ?? `分數 ${fmtNumber(scoreComponentValue(rec, 'mlEdge'), 1)}，投票明細待同步`}
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
          <div className="text-lg font-bold text-primary">{Math.round(scoreViewModel.finalScore)}</div>
          <div className="text-[10px] text-muted-foreground">最終分</div>
        </div>

        {expanded ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </div>

      {evidenceLinks.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-border/30 px-4 py-2">
          {evidenceLinks.map((link) => (
            <a
              key={`${link.source}:${link.url}`}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-sky-500/25 bg-sky-500/[0.07] px-2 py-1 text-[11px] leading-tight text-sky-700 hover:border-sky-500/45 dark:text-sky-300"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span className="shrink-0 font-mono uppercase">{link.source}</span>
              <span className="truncate">{link.title}</span>
            </a>
          ))}
        </div>
      )}

      {expanded && (
        <div className="space-y-4 border-t border-border/40 px-4 pb-4 pt-3">
          <ScoreFormulaSummary viewModel={scoreViewModel} />

          <div className="space-y-1.5">
            <p className="mb-2 text-xs font-medium text-muted-foreground">五構面基礎分數</p>
            {scoreViewModel.rows.map((item) => (
              <ScoreBar key={item.key} label={item.label} value={item.value} max={item.max} color={item.color} />
            ))}
          </div>

          <ScoreBreakdownV2 rec={rec} />

          <TradingPlanNarrative rec={rec} context={alphaContext} reason={displayReason} />

          {(mlSummary || mlMetadataGap || mlDiagnostics) && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-3 text-xs leading-relaxed text-muted-foreground">
              <p className="mb-1 font-medium text-emerald-700 dark:text-emerald-300">ML 解讀</p>
              <p>{mlSummary ?? mlMetadataGap}</p>
              <MlDiagnosticsStrip diagnostics={mlDiagnostics} />
            </div>
          )}

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
                <span className="ml-3">{'\u53c3\u8003\u6536\u76e4\u50f9'} ${fmtNumber(rec.current_price, 2)}{'\uff08\u975e\u6700\u7d42\u639b\u50f9\uff09'}</span>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
