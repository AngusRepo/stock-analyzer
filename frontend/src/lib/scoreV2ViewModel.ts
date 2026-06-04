export type ScoreBreakdownSource = 'score_v2' | 'storage_projection'

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

const SCORE_V2_WEIGHTS = {
  mlEdge: 25,
  chipFlow: 25,
  technicalStructure: 25,
  fundamentalQuality: 20,
  newsTheme: 5,
} as const

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

function finiteNumberOrNull(raw: unknown): number | null {
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function normalizeScoreToMax(value: unknown, max: number): number {
  const n = finiteNumberOrNull(value)
  if (n == null) return 0
  if (max > 1 && n >= 0 && n <= 1) return clampScore(n * max, max)
  return clampScore(n, max)
}

function normalizeTotalScore(value: unknown, fallback: number): number {
  const n = finiteNumberOrNull(value)
  if (n == null) return clampScore(fallback, 100)
  if (n >= 0 && n <= 1) return clampScore(n * 100, 100)
  return clampScore(n, 100)
}

function scorePayloadLooksNormalized(payload: Record<string, any> | null): boolean {
  if (!payload) return false
  const explicitScale = String(payload.scoreScale ?? payload.scale ?? payload.valueScale ?? '').toLowerCase()
  if (explicitScale.includes('normal') || explicitScale.includes('0_1') || explicitScale.includes('0-1')) return true
  const totals = [payload.total, payload.finalScore, payload.rawScore]
    .map(finiteNumberOrNull)
    .filter((value): value is number => value != null)
  if (totals.some((value) => value > 0 && value <= 1)) return true
  const components = parseObject(payload.components) ?? {}
  const componentValues = Object.values(components)
    .map(finiteNumberOrNull)
    .filter((value): value is number => value != null)
  return componentValues.length > 0
    && componentValues.every((value) => value >= 0 && value <= 1)
    && componentValues.some((value) => value > 0)
}

function normalizeAlphaAdjustment(value: unknown, normalizedPayload: boolean): number {
  const n = finiteNumberOrNull(value)
  if (n == null) return 0
  if (normalizedPayload && Math.abs(n) <= 1) return round1(n * 100)
  return round1(n)
}

function rescale(value: unknown, oldMax: number, newMax: number): number {
  if (oldMax <= 0) return 0
  const n = finiteNumber(value)
  if (newMax > 1 && n >= 0 && n <= 1) return clampScore(n * newMax, newMax)
  return clampScore((Math.max(0, Math.min(oldMax, n)) / oldMax) * newMax, newMax)
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
    value: normalizeScoreToMax(value, maxValue),
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
  return SCORE_V2_TECHNICAL
    .filter(([key]) => breakdown[key] != null)
    .map(([key, label, max, color, explanation]) => row(key, label, breakdown[key], max, color, explanation))
}

function storageSource(rec: Record<string, any>, payload: Record<string, any> | null): Record<string, any> {
  const legacyComponents = parseObject(payload?.legacyComponents)
  return legacyComponents ?? payload ?? rec
}

function storageRows(rec: Record<string, any>, payload: Record<string, any> | null): ScoreBreakdownRow[] {
  const source = storageSource(rec, payload)
  const tech = finiteNumber(source.tech ?? rec.tech_score)
  const momentum = finiteNumber(source.screenerMomentum ?? rec.momentum_score)
  const values = {
    mlEdge: rescale(source.ml ?? rec.ml_score, 30, 25),
    chipFlow: rescale(source.chip ?? rec.chip_score, 40, 25),
    technicalStructure: rescale(tech + momentum, 50, 25),
    fundamentalQuality: 0,
    newsTheme: 0,
  }
  return SCORE_V2_COMPONENTS.map(([key, label, max, color]) => row(key, label, values[key], max, color))
}

function storageTechnicalRows(rec: Record<string, any>, payload: Record<string, any> | null): ScoreBreakdownRow[] {
  const source = storageSource(rec, payload)
  const tech = source.tech ?? rec.tech_score
  const momentum = source.screenerMomentum ?? rec.momentum_score
  const rows: ScoreBreakdownRow[] = []
  if (tech != null) rows.push(row('trendStructure', '趨勢結構', rescale(tech, 30, 7), 7, 'bg-violet-500', 'storage projection 僅作 fallback；正式判讀以 score_components 技術細項為準。'))
  if (momentum != null) rows.push(row('volumeConfirmation', '量能確認', rescale(momentum, 20, 6), 6, 'bg-cyan-500', 'storage projection 僅作 fallback；正式判讀以 score_components 技術細項為準。'))
  return rows
}

function sumRows(rows: ScoreBreakdownRow[]): number {
  return round1(rows.reduce((sum, item) => sum + item.value, 0))
}

function riskFlagsFromPayload(payload: Record<string, any> | null): string[] {
  if (Array.isArray(payload?.riskFlags)) return payload.riskFlags.filter(Boolean).map(String)
  if (Array.isArray(payload?.alphaReason?.riskFlags)) return payload.alphaReason.riskFlags.filter(Boolean).map(String)
  return []
}

export function buildScoreV2PayloadFromProjectedScores(rec: Record<string, any>): Record<string, any> {
  const components = {
    mlEdge: normalizeScoreToMax(rec.ml_score, SCORE_V2_WEIGHTS.mlEdge),
    chipFlow: normalizeScoreToMax(rec.chip_score, SCORE_V2_WEIGHTS.chipFlow),
    technicalStructure: normalizeScoreToMax(rec.tech_score, SCORE_V2_WEIGHTS.technicalStructure),
    fundamentalQuality: 0,
    newsTheme: 0,
  }
  const componentTotal = round1(Object.values(components).reduce((sum, value) => sum + value, 0))
  return {
    version: 'score_v2',
    weights: SCORE_V2_WEIGHTS,
    components,
    total: normalizeTotalScore(rec.score, componentTotal),
    riskFlags: [],
    reasons: ['score_v2_projected_storage'],
  }
}

export function buildScoreBreakdownViewModel(rec: Record<string, any>): ScoreBreakdownViewModel {
  const payload = parseObject(rec.score_components)
  const isScoreV2 = payload?.version === 'score_v2' && parseObject(payload.components) != null
  const normalizedPayload = scorePayloadLooksNormalized(payload)
  const alphaAdjustment = normalizeAlphaAdjustment(payload?.alphaAdjustment ?? rec.alpha_context?.score_adjustment, normalizedPayload)

  if (isScoreV2) {
    const rows = scoreV2Rows(payload)
    const baseScore = normalizeTotalScore(payload.total, sumRows(rows))
    const finalScore = normalizeTotalScore(payload.finalScore, baseScore + alphaAdjustment)
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

  const rows = storageRows(rec, payload)
  const baseScore = sumRows(rows)
  const finalScore = round1(baseScore + alphaAdjustment)

  return {
    source: 'storage_projection',
    hasBackendPayload: Boolean(payload),
    rows,
    technicalRows: storageTechnicalRows(rec, payload),
    baseScore,
    finalScore,
    alphaAdjustment,
    residual: round1(finalScore - baseScore - alphaAdjustment),
    riskFlags: riskFlagsFromPayload(payload),
  }
}
