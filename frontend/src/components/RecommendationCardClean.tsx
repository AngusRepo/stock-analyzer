import { useState, type ElementType } from 'react'
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
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { explainExecutionEvent, parseExecutionEvent } from '@/lib/executionEvent'
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
  'LightGBM',
  'XGBoost',
  'ExtraTrees',
  'TabM',
  'GNN',
  'DLinear',
  'PatchTST',
  'iTransformer',
  'TimesFM',
] as const

const ALPHA_PREDICTION_MODEL_SET = new Set<string>(ALPHA_PREDICTION_MODEL_NAMES)

function normalizeModelName(raw: unknown): string {
  const value = String(raw ?? '').trim()
  const compact = value.toLowerCase().replace(/[\s_-]+/g, '')
  const aliases: Record<string, string> = {
    lightgbm: 'LightGBM',
    lgbm: 'LightGBM',
    xgboost: 'XGBoost',
    xgb: 'XGBoost',
    extratrees: 'ExtraTrees',
    extratreesregressor: 'ExtraTrees',
    tabm: 'TabM',
    gnn: 'GNN',
    graphnn: 'GNN',
    dlinear: 'DLinear',
    patchtst: 'PatchTST',
    itransformer: 'iTransformer',
    timesfm: 'TimesFM',
  }
  return aliases[compact] ?? value
}

function isAlphaPredictionModelName(raw: unknown): boolean {
  return ALPHA_PREDICTION_MODEL_SET.has(normalizeModelName(raw))
}

export const AI_TOP_PICK_EXPLANATION =
  '名詞解釋：基礎分 = 籌碼 + 技術 + ML；Alpha 調整是風控與市場狀態對分數的加減；Slate 是清單分散與配置順序，不會再直接加到預測分數。ML 摘要是模型投票/共識與校準後預期報酬，用來輔助判斷，但仍要搭配 alpha bucket、market structure 和盤中再評估。投票門檻會依 trading:config、adaptive params 與 regime 動態調整，不再用固定值解讀。POC 是計算區間內成交量重心，fair value 是同一區間估出的合理價格帶。'

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
        {formatUnitScore(safeValue, safeMax)}
      </span>
    </div>
  )
}

function ScoreBreakdownV2({ rec }: { rec: any }) {
  const viewModel = buildScoreBreakdownViewModel(rec)
  const components = parseObject(rec.score_components)
  const riskText = viewModel.riskFlags.length > 0 ? viewModel.riskFlags.join(', ') : '無'
  const alphaDetails = components?.alphaReason?.details?.filter((item: any) => item && item.value != null) ?? []

  return (
    <div className="rounded-lg border border-border/50 bg-background/50 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-muted-foreground">Score V2 分解</span>
        <span className="font-mono text-foreground">
          {fmtNumber(viewModel.finalScore, 1)} = {fmtNumber(viewModel.baseScore, 1)}
          {viewModel.alphaAdjustment >= 0 ? ' + ' : ' - '}{fmtNumber(Math.abs(viewModel.alphaAdjustment), 1)}
          {Math.abs(viewModel.residual) >= 0.1 && `${viewModel.residual >= 0 ? ' + ' : ' - '}${fmtNumber(Math.abs(viewModel.residual), 1)}`}
        </span>
      </div>
      <div className="grid gap-1.5 text-muted-foreground sm:grid-cols-2">
        {viewModel.rows.map((item) => (
          <span key={item.key}>{item.label}: {fmtNumber(item.value, 1)} / {fmtNumber(item.max, 0)}</span>
        ))}
        <span>基礎分數: {fmtNumber(viewModel.baseScore, 1)}</span>
        <span>Alpha 調整: {viewModel.alphaAdjustment >= 0 ? '+' : ''}{fmtNumber(viewModel.alphaAdjustment, 1)}</span>
        {Math.abs(viewModel.residual) >= 0.1 && (
          <span>資料校準差: {viewModel.residual >= 0 ? '+' : ''}{fmtNumber(viewModel.residual, 1)}</span>
        )}
        <span>最終分數: {fmtNumber(viewModel.finalScore, 1)}</span>
      </div>
      {viewModel.technicalRows.length > 0 && (
        <div className="mt-2 space-y-1 rounded-md border border-violet-500/20 bg-violet-500/[0.05] p-2">
          <p className="font-medium text-foreground/80">技術結構細項</p>
          {viewModel.technicalRows.map((item) => (
            <ScoreBar key={item.key} label={item.label} value={item.value} max={item.max} color={item.color} />
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
      {Math.abs(viewModel.residual) >= 0.1 && (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
          分數存在校準差，通常代表後端總分與目前可拆解欄位仍有不同步；Score V2 會優先採用後端 score_components。
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
    if (isContextWatchPoint(point)) continue
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

function finiteRecNumber(rec: any, keys: string[]): number | null {
  for (const key of keys) {
    const value = Number(rec?.[key])
    if (Number.isFinite(value)) return value
  }
  return null
}

function fmtSignedPct(value: number | string | null | undefined, decimals = 2): string {
  if (value == null || value === '') return '-'
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '-'
  const normalized = Math.abs(numeric) <= 1 ? numeric * 100 : numeric
  return `${normalized >= 0 ? '+' : ''}${normalized.toFixed(decimals)}%`
}

function fmtVolume(raw: number | string | null | undefined): string {
  if (raw == null || raw === '') return '-'
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return '-'
  if (value >= 1_000_000) return `${Math.round(value / 1000).toLocaleString()} 張`
  if (value >= 1000) return `${Math.round(value).toLocaleString()} 張`
  return `${Math.round(value).toLocaleString()}`
}

function compactText(raw: unknown, maxLength = 150): string {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (!text) return '後端尚未提供完整推薦理由，請展開查看分數、ML 與市場結構。'
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function scoreRailColor(key: string): string {
  const colors: Record<string, string> = {
    mlEdge: 'bg-emerald-400',
    chipFlow: 'bg-cyan-400',
    technicalStructure: 'bg-violet-400',
    fundamentalQuality: 'bg-amber-400',
    newsTheme: 'bg-sky-400',
  }
  return colors[key] ?? 'bg-slate-400'
}

function unitScore(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0
  return Math.max(0, Math.min(1, value / max))
}

function formatUnitScore(value: number, max: number): string {
  return unitScore(value, max).toFixed(2)
}

function formatTotalUnitScore(score: number): string {
  if (!Number.isFinite(score)) return '0.00'
  const ratio = score <= 1 ? score : score / 100
  return Math.max(0, Math.min(1, ratio)).toFixed(2)
}

function ScoreRing({ score }: { score: number }) {
  const safeScore = Number.isFinite(score) ? Math.max(0, Math.min(100, score <= 1 ? score * 100 : score)) : 0
  const color = safeScore >= 70 ? '#34d399' : safeScore >= 50 ? '#22d3ee' : safeScore >= 35 ? '#fbbf24' : '#fb7185'
  return (
    <div className="relative grid h-16 w-16 shrink-0 place-items-center">
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: `conic-gradient(${color} ${safeScore}%, rgba(148,163,184,0.18) ${safeScore}%)`,
        }}
      />
      <div className="absolute inset-1 rounded-full border border-white/5 bg-[#07101b]" />
      <div className="relative text-center">
        <div className="font-mono text-base font-bold leading-none text-cyan-200">{formatTotalUnitScore(safeScore)}</div>
        <div className="mt-0.5 text-[9px] text-slate-400">score</div>
      </div>
    </div>
  )
}

function CompactScoreRail({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)_3.6rem] items-center gap-2 text-[11px]">
      <span className="truncate font-medium text-slate-300">{label}</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-right font-mono text-slate-400">
        {formatUnitScore(value, max)}
      </span>
    </div>
  )
}

function MetricTile({ label, value, tone = 'neutral' }: {
  label: string
  value: string
  tone?: 'positive' | 'negative' | 'neutral' | 'warning'
}) {
  const toneClass = {
    positive: 'text-emerald-300',
    negative: 'text-rose-300',
    neutral: 'text-slate-100',
    warning: 'text-amber-300',
  }[tone]
  return (
    <div className="rounded-lg border border-slate-800 bg-[#08111d]/85 px-2.5 py-2">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className={cn('mt-0.5 truncate font-mono text-xs font-semibold', toneClass)}>{value}</div>
    </div>
  )
}

function factorLine(label: string, value: string, tone: 'positive' | 'negative' | 'neutral' | 'warning' = 'neutral') {
  return { label, value, tone }
}

type LayerTraceItem = {
  layer: 'L1' | 'L2' | 'L3' | 'L4'
  label: string
  value: string
  tone: 'positive' | 'negative' | 'neutral' | 'warning'
}

function parseArrayText(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((item) => String(item ?? '').trim()).filter(Boolean)
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.map((item) => String(item ?? '').trim()).filter(Boolean)
    } catch {
      return raw.split(/[,\s|]+/).map((item) => item.trim()).filter(Boolean)
    }
  }
  return []
}

function screenerEvidenceFromRec(rec: any): Record<string, any> {
  return parseObject(rec.screener_funnel_evidence) ?? {}
}

function screenerTimelineFromRec(rec: any): Array<Record<string, any>> {
  const raw = rec.screener_funnel_timeline
  if (Array.isArray(raw)) return raw.filter((item): item is Record<string, any> => item && typeof item === 'object')
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, any> => item && typeof item === 'object') : []
    } catch {
      return []
    }
  }
  return []
}

function latestTimelineStage(timeline: Array<Record<string, any>>, patterns: RegExp[]): Record<string, any> | null {
  for (let index = timeline.length - 1; index >= 0; index--) {
    const stage = String(timeline[index].stage ?? '')
    if (patterns.some((pattern) => pattern.test(stage))) return timeline[index]
  }
  return null
}

const STRATEGY_FAMILY_LABELS: Array<[RegExp, string]> = [
  [/(volatility|breakout|squeeze|vcp|bb)/i, '波動收斂突破'],
  [/(trend|reclaim|continuation|macd|adx|ma)/i, '趨勢回收延續'],
  [/(smart|money|chip|broker|accumulation|foreign|trust)/i, '主力籌碼累積'],
  [/(smc|liquidity|sweep|bos|choch|displacement)/i, 'SMC 結構回收'],
  [/(revenue|quality|fundamental|eps|roe|margin)/i, '營收品質動能'],
  [/(sector|rotation|theme|industry|group)/i, '族群輪動核心'],
]

function strategyFamilyLabel(id: string): string {
  const hit = STRATEGY_FAMILY_LABELS.find(([pattern]) => pattern.test(id))
  return hit?.[1] ?? '策略命中'
}

function strategyIdsFromRec(rec: any, evidence: Record<string, any>): string[] {
  const direct = [
    ...parseArrayText(evidence.strategy_ids),
    ...parseArrayText(evidence.strategy_pool_ids),
    ...parseArrayText(rec.strategy_pool_ids),
  ]
  const pools = Array.isArray(evidence.strategy_pool) ? evidence.strategy_pool : []
  for (const pool of pools) {
    if (pool && typeof pool === 'object') direct.push(...parseArrayText((pool as any).strategy_ids))
  }
  return [...new Set(direct.map((item) => item.trim()).filter(Boolean))]
}

function allocationFromRec(rec: any): Record<string, any> | null {
  return parseObject(rec.alpha_allocation)
}

function formatAllocationWeight(raw: unknown): string {
  const value = Number(raw)
  if (!Number.isFinite(value)) return '-'
  const pct = Math.abs(value) <= 1 ? value * 100 : value
  return `${pct.toFixed(1)}%`
}

function buildLayerTrace(rec: any, evidence: Record<string, any>, timeline: Array<Record<string, any>>, mlDiagnostics: MlDiagnosticsSummary | null): LayerTraceItem[] {
  const strategyIds = strategyIdsFromRec(rec, evidence)
  const l2 = latestTimelineStage(timeline, [/l2/i, /coarse/i, /ml_queue/i])
  const l3Active = Number(mlDiagnostics?.activeWeightCount ?? 0)
  const l3Total = Number(mlDiagnostics?.totalAlphaModels ?? ALPHA_PREDICTION_MODEL_NAMES.length)
  const allocation = allocationFromRec(rec)
  const selected = allocation?.selected === true || rec.alpha_selected === true
  const weight = allocation?.target_weight ?? allocation?.weight ?? allocation?.final_weight ?? rec.target_weight
  return [
    {
      layer: 'L1',
      label: 'Strategy',
      value: strategyIds.length ? `${strategyIds.length} 策略` : '未標策略',
      tone: strategyIds.length ? 'positive' : 'warning',
    },
    {
      layer: 'L2',
      label: 'Coarse',
      value: l2 ? String(l2.reason_code ?? l2.decision ?? 'pass') : String(rec.screener_funnel_reason ?? 'funnel'),
      tone: String(l2?.decision ?? '').includes('drop') ? 'negative' : 'neutral',
    },
    {
      layer: 'L3',
      label: 'Family ML',
      value: `${Number.isFinite(l3Active) ? l3Active : 0}/${Number.isFinite(l3Total) ? l3Total : ALPHA_PREDICTION_MODEL_NAMES.length} active`,
      tone: l3Active > 0 ? 'positive' : 'warning',
    },
    {
      layer: 'L4',
      label: 'Allocation',
      value: selected ? `selected ${formatAllocationWeight(weight)}` : 'not selected',
      tone: selected ? 'positive' : 'warning',
    },
  ]
}

function LayerTraceStrip({ items }: { items: LayerTraceItem[] }) {
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.layer} className="rounded-lg border border-slate-800 bg-[#08111d]/85 px-2 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className={cn(
              'font-mono text-[10px] font-bold',
              item.tone === 'positive' && 'text-emerald-300',
              item.tone === 'negative' && 'text-rose-300',
              item.tone === 'warning' && 'text-amber-300',
              item.tone === 'neutral' && 'text-slate-300',
            )}>{item.layer}</span>
            <span className="truncate text-[9px] text-slate-500">{item.label}</span>
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-slate-300">{item.value}</div>
        </div>
      ))}
    </div>
  )
}

function StrategyFamilyPanel({ strategyIds }: { strategyIds: string[] }) {
  if (!strategyIds.length) {
    return (
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-2.5 text-[11px] leading-5 text-amber-200">
        L1 尚未提供 strategy id，這檔目前只能靠 funnel reason 與 Score V2 判讀。
      </div>
    )
  }
  const grouped = new Map<string, string[]>()
  for (const id of strategyIds) {
    const family = strategyFamilyLabel(id)
    grouped.set(family, [...(grouped.get(family) ?? []), id])
  }
  return (
    <div className="rounded-lg border border-cyan-400/15 bg-cyan-400/[0.045] p-2.5">
      <div className="mb-2 text-[11px] font-semibold text-cyan-200">L1 Strategy Family / Variant</div>
      <div className="space-y-1.5">
        {[...grouped.entries()].map(([family, ids]) => (
          <div key={family} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 text-[11px] leading-5">
            <span className="text-slate-400">{family}</span>
            <span className="truncate font-mono text-cyan-100">{ids.slice(0, 4).join(' / ')}{ids.length > 4 ? ` +${ids.length - 4}` : ''}</span>
          </div>
        ))}
      </div>
    </div>
  )
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
  const screenerEvidence = screenerEvidenceFromRec(rec)
  const screenerTimeline = screenerTimelineFromRec(rec)
  const strategyIds = strategyIdsFromRec(rec, screenerEvidence)
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
  const finalScore = Number.isFinite(scoreViewModel.finalScore) ? scoreViewModel.finalScore : Number(rec.score ?? 0)
  const currentPrice = finiteRecNumber(rec, ['current_price', 'latest_price', 'close', 'close_price', 'last_price'])
    ?? (Number.isFinite(Number(alphaContext?.latestClose)) ? Number(alphaContext?.latestClose) : null)
  const changePct = finiteRecNumber(rec, ['change_pct', 'price_change_pct', 'return_1d', 'daily_return_pct'])
  const volume = finiteRecNumber(rec, ['volume', 'trading_volume', '成交量', 'volume_shares'])
  const mlScore = scoreComponentValue(rec, 'mlEdge')
  const chipScore = scoreComponentValue(rec, 'chipFlow')
  const technicalScore = scoreComponentValue(rec, 'technicalStructure')
  const fundamentalScore = scoreComponentValue(rec, 'fundamentalQuality')
  const fairValue = alphaContext?.fairValueLow || alphaContext?.fairValueHigh
    ? `${fmtNumber(alphaContext?.fairValueLow, 2)}~${fmtNumber(alphaContext?.fairValueHigh, 2)}`
    : '-'
  const chaseCeiling = alphaContext?.optimisticValueHigh != null
    ? fmtNumber(alphaContext.optimisticValueHigh, 2)
    : '-'
  const positionLabel = alphaContext?.location
    ? shortLabelFor(alphaContext.location, LOCATION_TEXT)
    : '價格位置待同步'
  const layerTrace = buildLayerTrace(rec, screenerEvidence, screenerTimeline, mlDiagnostics)
  const factorLines = [
    factorLine('ML', `${formatUnitScore(mlScore, 25)}${mlSummary ? ` · ${compactText(mlSummary, 68)}` : ''}`, unitScore(mlScore, 25) >= 0.5 ? 'positive' : 'warning'),
    factorLine(chipBadgeLabel, `${formatUnitScore(chipScore, 25)} · 5日 ${fmtChipAmount(chip5dRaw)}`, chipPositive ? 'positive' : 'neutral'),
    factorLine('技術', `${formatUnitScore(technicalScore, 25)}${rec.rsi14 != null ? ` · RSI ${fmtNumber(rec.rsi14, 1)}` : ''}`, unitScore(technicalScore, 25) >= 0.5 ? 'positive' : 'warning'),
    factorLine('基本', `${formatUnitScore(fundamentalScore, 20)}`, unitScore(fundamentalScore, 20) >= 0.5 ? 'positive' : 'neutral'),
    factorLine('位置', `value ${fairValue} · chase ${chaseCeiling}`, alphaContext?.location === 'above_fair_value' ? 'warning' : 'neutral'),
  ]

  return (
    <div className={cn(
      'overflow-hidden rounded-xl border bg-[#07101b] text-slate-100 shadow-[0_18px_55px_rgba(0,0,0,0.22)] transition-all',
      rank === 1
        ? 'border-amber-400/55'
        : 'border-slate-800 hover:border-slate-700',
    )}>
      <div
        className="cursor-pointer select-none p-3 sm:p-4"
        onClick={() => setExpanded((value) => !value)}
      >
        <div className="flex items-start gap-3">
          <div className={cn(
            'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold',
            rank === 1 ? 'bg-amber-400 text-[#08111d]' :
            rank === 2 ? 'bg-slate-400 text-[#08111d]' :
            rank === 3 ? 'bg-orange-400 text-[#08111d]' :
            'bg-slate-800 text-slate-300',
          )}>
            {rank}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-base font-bold text-cyan-200">{rec.symbol}</span>
              <span className="truncate text-sm font-medium text-slate-200">{rec.name}</span>
              {isEmerging && (
                <Badge variant="outline" className="border-amber-400/35 bg-amber-400/10 px-1.5 py-0 text-[10px] text-amber-200">
                  興櫃研究
                </Badge>
              )}
              {rec.sector && (
                <Badge variant="outline" className="shrink-0 border-slate-700 bg-slate-900/70 px-1.5 py-0 text-[10px] text-slate-300">{rec.sector}</Badge>
              )}
              <Badge className={cn('px-1.5 py-0 text-[10px]', sig.color)}>
                <SigIcon className="mr-1 h-2.5 w-2.5" />
                {sig.label}
              </Badge>
            </div>

            <div className="mt-2 grid gap-1.5">
              {scoreViewModel.rows.map((item) => (
                <CompactScoreRail
                  key={item.key}
                  label={item.label}
                  value={item.value}
                  max={item.max}
                  color={scoreRailColor(item.key)}
                />
              ))}
            </div>
          </div>

          <ScoreRing score={finalScore} />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricTile label="收盤 / 現價" value={currentPrice == null ? '-' : fmtNumber(currentPrice, 2)} />
          <MetricTile
            label="漲跌"
            value={changePct == null ? '-' : fmtSignedPct(changePct)}
            tone={changePct == null ? 'neutral' : changePct >= 0 ? 'negative' : 'positive'}
          />
          <MetricTile label="成交量" value={fmtVolume(volume)} />
          <MetricTile label={chipBadgeLabel} value={fmtChipAmount(chip5dRaw)} tone={chipPositive ? 'negative' : 'positive'} />
        </div>

        <div className="mt-3">
          <LayerTraceStrip items={layerTrace} />
        </div>

        <div className="mt-3 rounded-lg border border-slate-800 bg-[#0a1422]/90 p-2.5">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-cyan-400/25 bg-cyan-400/10 px-1.5 py-0 text-[10px] text-cyan-200">
              {positionLabel}
            </Badge>
            {alphaContext?.bucket && (
              <Badge variant="outline" className="gap-1 border-sky-400/25 bg-sky-400/10 px-1.5 py-0 text-[10px] text-sky-200">
                <ShieldCheck className="h-2.5 w-2.5" />
                {labelFor(alphaContext.bucket)}
              </Badge>
            )}
          </div>
          <div className="grid gap-1.5">
            {factorLines.map((item) => (
              <div key={item.label} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2 text-[11px] leading-5">
                <span className="font-semibold text-slate-400">{item.label}</span>
                <span className={cn(
                  'truncate font-mono',
                  item.tone === 'positive' && 'text-emerald-300',
                  item.tone === 'negative' && 'text-rose-300',
                  item.tone === 'warning' && 'text-amber-300',
                  item.tone === 'neutral' && 'text-slate-300',
                )}>
                  {item.value}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-slate-800 bg-[#090f1a]/80 p-2.5">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
            <BarChart3 className="h-3 w-3 text-cyan-300" />
            推薦摘要
          </div>
          <p className="text-xs leading-5 text-slate-400">
            {compactText(displayReason)}
          </p>
        </div>

        <div className="mt-3 flex items-center justify-between text-[11px] text-slate-500">
          <span>{expanded ? '收合診斷' : '展開完整 Score V2 / ML / 市場結構'}</span>
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </div>
      </div>

      {evidenceLinks.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-slate-800 px-4 py-2">
          {evidenceLinks.map((link) => (
            <a
              key={`${link.source}:${link.url}`}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-sky-500/25 bg-sky-500/[0.07] px-2 py-1 text-[11px] leading-tight text-sky-300 hover:border-sky-500/45"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span className="shrink-0 font-mono uppercase">{link.source}</span>
              <span className="truncate">{link.title}</span>
            </a>
          ))}
        </div>
      )}

      {expanded && (
        <div className="space-y-4 border-t border-slate-800 px-4 pb-4 pt-3">
          <div className="space-y-1.5">
            <p className="mb-2 text-xs font-medium text-slate-400">基礎分數</p>
            {scoreViewModel.rows.map((item) => (
              <ScoreBar key={item.key} label={item.label} value={item.value} max={item.max} color={item.color} />
            ))}
          </div>

          <ScoreBreakdownV2 rec={rec} />

          <StrategyFamilyPanel strategyIds={strategyIds} />

          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-400">推薦理由</p>
            <p className="whitespace-pre-line text-sm leading-relaxed text-slate-200">{displayReason}</p>
          </div>

          {(mlSummary || mlMetadataGap || mlDiagnostics) && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-3 text-xs leading-relaxed text-muted-foreground">
              <p className="mb-1 font-medium text-emerald-700 dark:text-emerald-300">ML 解讀</p>
              <p>{mlSummary ?? mlMetadataGap}</p>
              <MlDiagnosticsStrip diagnostics={mlDiagnostics} />
            </div>
          )}

          <AlphaContextBlock context={alphaContext} />

          {noticePoints.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-slate-400">
                <AlertCircle className="h-3 w-3" />
                注意事項
              </p>
              <ul className="space-y-1">
                {noticePoints.map((point, index) => (
                  <li key={`${point}-${index}`} className="flex items-start gap-1.5 text-xs leading-relaxed text-slate-400">
                    <span className="mt-0.5 shrink-0 text-amber-500">!</span>
                    {normalizeWatchPoint(point)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {rec.confidence != null && (
            <p className="text-[11px] text-slate-500">
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
