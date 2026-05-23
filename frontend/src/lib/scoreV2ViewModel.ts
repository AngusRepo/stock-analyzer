export type ScoreBreakdownSource = 'score_v2' | 'missing_score_v2'

export type ScoreBreakdownRow = {
  key: string
  label: string
  value: number
  max: number
  color: string
  explanation?: string
}

export type ScoreBreakdownViewModel = {
  source: ScoreBreakdownSource
  hasBackendPayload: boolean
  rows: ScoreBreakdownRow[]
  technicalRows: ScoreBreakdownRow[]
  baseScore: number
  finalScore: number
  alphaAdjustment: number
  residual: number
  riskFlags: string[]
}

const SCORE_V2_COMPONENTS = [
  ['mlEdge', 'ML Edge', 25, 'bg-emerald-500'],
  ['chipFlow', '籌碼流', 25, 'bg-blue-500'],
  ['technicalStructure', '技術結構', 25, 'bg-violet-500'],
  ['fundamentalQuality', '基本面', 20, 'bg-amber-500'],
  ['newsTheme', '新聞題材', 5, 'bg-cyan-500'],
] as const

const SCORE_V2_TECHNICAL = [
  ['trendStructure', '趨勢結構', 7, 'bg-violet-500', '趨勢結構目前缺少方向指標，不能只靠單日價格變動下結論。'],
  ['volatilityStructure', '波動結構', 5, 'bg-sky-500', '波動結構目前缺少穩定度指標，突破或回測要保守確認。'],
  ['reversalExtreme', '轉折極端', 5, 'bg-fuchsia-500', '轉折極端目前缺少過熱/過冷指標，進場要等位置確認。'],
  ['volumeConfirmation', '量能確認', 6, 'bg-cyan-500', '量能確認目前缺少成交量佐證，突破前要等量能放大。'],
  ['executionRisk', '執行風險', 2, 'bg-rose-500', '執行風險目前缺少流動性佐證，實際下單要保守處理。'],
] as const

function parseObject(raw: unknown): Record<string, any> | null {
  if (!raw) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, any>
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null
  } catch {
    return null
  }
}

function canonicalScoreV2Payload(rec: Record<string, any>): Record<string, any> | null {
  const scoreV2Payload = parseObject(rec.score_v2)
  return scoreV2Payload?.version === 'score_v2' ? scoreV2Payload : null
}

function finiteNumber(raw: unknown, fallback = 0): number {
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function clampScore(value: unknown, max: number): number {
  const n = finiteNumber(value)
  return round1(Math.max(0, Math.min(max, n)))
}

function fmtSignal(value: unknown, decimals = 1): string | null {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(decimals) : null
}

function riskFlagIncludes(flags: string[], pattern: RegExp): boolean {
  return flags.some((flag) => pattern.test(flag))
}

function scoreLevel(value: number, max: number): string {
  const ratio = max > 0 ? value / max : 0
  if (ratio >= 0.72) return '偏強'
  if (ratio >= 0.48) return '中性'
  return '偏弱'
}

function technicalFallbackConclusion(key: string, value: number, max: number): string {
  const scoreText = `${value.toFixed(1)}/${max.toFixed(0)}`
  const level = scoreLevel(value, max)
  if (key === 'trendStructure') {
    return `拿 ${scoreText}，趨勢結構${level}；目前沒有足夠方向指標佐證，不能只因短線上漲就當成強趨勢。`
  }
  if (key === 'volatilityStructure') {
    return `拿 ${scoreText}，波動結構${level}；若分數偏低，代表突破後被震盪洗掉的機率較高。`
  }
  if (key === 'reversalExtreme') {
    return `拿 ${scoreText}，轉折風險${level}；分數不足時代表位置可能太熱或太冷，進場要等價格穩住。`
  }
  if (key === 'volumeConfirmation') {
    return `拿 ${scoreText}，量能確認${level}；分數不足時代表成交量沒有明確跟上，突破前要等量能放大。`
  }
  if (key === 'executionRisk') {
    return `拿 ${scoreText}，執行風險${level}；分數不足時代表滑價、流動性或盤中成交品質需要保守處理。`
  }
  return `拿 ${scoreText}，目前資料不足，只能把這項當成${level}訊號。`
}

function technicalExplanation(
  key: string,
  value: number,
  max: number,
  signals: Record<string, any>,
  riskFlags: string[],
  fallback: string,
): string {
  const scoreText = `${value.toFixed(1)}/${max.toFixed(0)}`
  const plusDi = fmtSignal(signals.plusDi14)
  const minusDi = fmtSignal(signals.minusDi14)
  const adx = fmtSignal(signals.adx14)
  const cci = fmtSignal(signals.cci20)
  const vwRsi = fmtSignal(signals.volumeWeightedRsi14)
  const volumeMomentum = fmtSignal(signals.volumeMomentumDivergence132710, 0)
  const volumeMomentumNumber = Number(signals.volumeMomentumDivergence132710)
  const lowLiquidity = riskFlagIncludes(riskFlags, /low[_-]?liquidity/i)

  if (key === 'trendStructure') {
    if (plusDi && minusDi && adx) {
      const direction = Number(signals.plusDi14) >= Number(signals.minusDi14)
        ? `+DI ${plusDi} 高於 -DI ${minusDi}`
        : `-DI ${minusDi} 高於 +DI ${plusDi}`
      const strength = Number(signals.adx14) >= 25 ? `ADX ${adx} 顯示趨勢有強度` : `ADX ${adx} 顯示趨勢還不夠強`
      return `拿 ${scoreText}，因為 ${direction}，${strength}，所以方向性有被趨勢資料支持。`
    }
    return technicalFallbackConclusion(key, value, max)
  }

  if (key === 'volatilityStructure') {
    const parts = [
      adx ? (Number(signals.adx14) >= 35 ? `ADX ${adx} 偏高，代表波動與趨勢正在擴張` : `ADX ${adx} 未失控`) : null,
      cci ? (Math.abs(Number(signals.cci20)) >= 120 ? `CCI ${cci} 接近極端，容易急拉急殺` : `CCI ${cci} 還在可控區間`) : null,
      lowLiquidity ? '低流動性會放大滑價與跳動' : null,
    ].filter(Boolean)
    return parts.length
      ? `拿 ${scoreText}，${parts.join('；')}。`
      : technicalFallbackConclusion(key, value, max)
  }

  if (key === 'reversalExtreme') {
    const parts = [
      vwRsi ? (Number(signals.volumeWeightedRsi14) >= 80 ? `量加權 RSI ${vwRsi} 偏熱` : Number(signals.volumeWeightedRsi14) <= 30 ? `量加權 RSI ${vwRsi} 偏冷` : `量加權 RSI ${vwRsi} 沒有落在極端區`) : null,
      cci ? (Math.abs(Number(signals.cci20)) >= 120 ? `CCI ${cci} 顯示轉折風險較高` : `CCI ${cci} 未到過熱或過冷`) : null,
    ].filter(Boolean)
    return parts.length
      ? `拿 ${scoreText}，${parts.join('；')}。`
      : technicalFallbackConclusion(key, value, max)
  }

  if (key === 'volumeConfirmation') {
    const parts = [
      Number.isFinite(volumeMomentumNumber)
        ? (volumeMomentumNumber > 0 ? `量能動能為正 ${volumeMomentum}，代表成交量有跟著方向放大` : `量能動能為負 ${volumeMomentum}，代表價格與資金熱度不同步`)
        : null,
      vwRsi ? (Number(signals.volumeWeightedRsi14) >= 55 ? `量加權 RSI ${vwRsi} 偏強` : `量加權 RSI ${vwRsi} 尚未確認多方`) : null,
    ].filter(Boolean)
    return parts.length
      ? `拿 ${scoreText}，${parts.join('；')}。`
      : technicalFallbackConclusion(key, value, max)
  }

  if (key === 'executionRisk') {
    const parts = [
      lowLiquidity ? '低流動性旗標會壓低分數，盤中更容易有滑價或買不到/賣不掉' : '沒有明顯低流動性旗標',
      vwRsi ? `量加權 RSI ${vwRsi} 用來檢查是否太擁擠` : null,
    ].filter(Boolean)
    return `拿 ${scoreText}，${parts.join('；')}。`
  }

  return technicalFallbackConclusion(key, value, max)
}

function row(
  key: string,
  label: string,
  value: unknown,
  max: unknown,
  color: string,
  explanation?: string,
): ScoreBreakdownRow {
  const maxValue = round1(Math.max(0, finiteNumber(max)))
  return {
    key,
    label,
    value: clampScore(value, maxValue),
    max: maxValue,
    color,
    explanation,
  }
}

function scoreV2Rows(payload: Record<string, any>): ScoreBreakdownRow[] {
  const components = parseObject(payload.components) ?? {}
  const weights = parseObject(payload.weights) ?? {}
  return SCORE_V2_COMPONENTS.map(([key, label, fallbackMax, color]) =>
    row(key, label, components[key], weights[key] ?? fallbackMax, color),
  )
}

function scoreV2TechnicalRows(payload: Record<string, any>): ScoreBreakdownRow[] {
  const breakdown = parseObject(payload.technicalBreakdown) ?? {}
  const signals = parseObject(payload.technicalSignals) ?? {}
  const riskFlags = riskFlagsFromPayload(payload)
  return SCORE_V2_TECHNICAL
    .filter(([key]) => breakdown[key] != null)
    .map(([key, label, max, color, explanation]) => {
      const value = clampScore(breakdown[key], max)
      return row(
        key,
        label,
        value,
        max,
        color,
        technicalExplanation(key, value, max, signals, riskFlags, explanation),
      )
    })
}

function sumRows(rows: ScoreBreakdownRow[]): number {
  return round1(rows.reduce((sum, item) => sum + item.value, 0))
}

function riskFlagsFromPayload(payload: Record<string, any> | null): string[] {
  if (Array.isArray(payload?.riskFlags)) return payload.riskFlags.filter(Boolean).map(String)
  if (Array.isArray(payload?.alphaReason?.riskFlags)) return payload.alphaReason.riskFlags.filter(Boolean).map(String)
  return []
}

export function buildScoreBreakdownViewModel(rec: Record<string, any>): ScoreBreakdownViewModel {
  const payload = canonicalScoreV2Payload(rec)
  const isScoreV2 = payload?.version === 'score_v2' && parseObject(payload.components) != null
  const alphaAdjustment = round1(finiteNumber(payload?.alphaAdjustment ?? rec.alpha_context?.score_adjustment))

  if (isScoreV2) {
    const rows = scoreV2Rows(payload)
    const baseScore = round1(finiteNumber(payload.total, sumRows(rows)))
    const finalScore = round1(finiteNumber(payload.finalScore, baseScore + alphaAdjustment))
    return {
      source: 'score_v2',
      hasBackendPayload: true,
      rows,
      technicalRows: scoreV2TechnicalRows(payload),
      baseScore,
      finalScore,
      alphaAdjustment,
      residual: round1(finalScore - baseScore - alphaAdjustment),
      riskFlags: riskFlagsFromPayload(payload),
    }
  }

  const rows = SCORE_V2_COMPONENTS.map(([key, label, max, color]) => row(key, label, 0, max, color))

  return {
    source: 'missing_score_v2',
    hasBackendPayload: false,
    rows,
    technicalRows: [],
    baseScore: 0,
    finalScore: 0,
    alphaAdjustment: 0,
    residual: 0,
    riskFlags: [],
  }
}
