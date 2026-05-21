export const SCORE_V2_VERSION = 'score_v2'

export const SCORE_V2_WEIGHTS = {
  mlEdge: 25,
  chipFlow: 25,
  technicalStructure: 25,
  fundamentalQuality: 20,
  newsTheme: 5,
} as const

export interface ScoreV2TechnicalBreakdown {
  trendStructure?: number
  volatilityStructure?: number
  reversalExtreme?: number
  volumeConfirmation?: number
  executionRisk?: number
}

export interface ScoreV2Input {
  mlEdge?: unknown
  chipFlow?: unknown
  technicalStructure?: unknown
  fundamentalQuality?: unknown
  newsTheme?: unknown
  technicalBreakdown?: ScoreV2TechnicalBreakdown | null
  riskFlags?: string[]
  reasons?: string[]
}

export interface PartialScreenerScoreV2Input {
  chipScore40?: unknown
  techScore30?: unknown
  momentumScore20?: unknown
  reasons?: string[]
}

export interface ScoreV2Components {
  mlEdge: number
  chipFlow: number
  technicalStructure: number
  fundamentalQuality: number
  newsTheme: number
}

export interface ScoreV2Payload {
  version: typeof SCORE_V2_VERSION
  weights: typeof SCORE_V2_WEIGHTS
  components: ScoreV2Components
  total: number
  finalScore?: number
  alphaAdjustment?: number
  technicalBreakdown?: Required<ScoreV2TechnicalBreakdown>
  riskFlags: string[]
  reasons: string[]
}

export interface LegacyScoreProjection {
  score: number
  ml_score: number
  chip_score: number
  tech_score: number
  momentum_score: number
  score_components: string
}

export interface ScoreV2StorageRow {
  score_components?: unknown
  chip_score?: unknown
  tech_score?: unknown
  momentum_score?: unknown
  ml_score?: unknown
  score?: unknown
}

export type ScoreV2SnapshotSource = 'score_v2' | 'storage_projection'

export interface ScoreV2Snapshot {
  source: ScoreV2SnapshotSource
  payload: ScoreV2Payload
  components: ScoreV2Components
  total: number
  finalScore: number
  alphaAdjustment: number
  technicalBreakdown?: Required<ScoreV2TechnicalBreakdown>
  riskFlags: string[]
  reasons: string[]
}

export interface ScoreV2ComponentPct {
  mlPct: number
  chipPct: number
  technicalPct: number
  fundamentalPct: number
  newsPct: number
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function clampScore(value: unknown, maxScore: number): number {
  const n = finiteNumber(value)
  if (n == null) return 0
  return round1(Math.max(0, Math.min(maxScore, n)))
}

function buildTechnicalBreakdown(input?: ScoreV2TechnicalBreakdown | null): Required<ScoreV2TechnicalBreakdown> | undefined {
  if (!input) return undefined
  return {
    trendStructure: clampScore(input.trendStructure, 7),
    volatilityStructure: clampScore(input.volatilityStructure, 5),
    reversalExtreme: clampScore(input.reversalExtreme, 5),
    volumeConfirmation: clampScore(input.volumeConfirmation, 6),
    executionRisk: clampScore(input.executionRisk, 2),
  }
}

function rescale(value: unknown, oldMax: number, newMax: number): number {
  const n = finiteNumber(value)
  if (n == null || oldMax <= 0) return 0
  return clampScore((Math.max(0, Math.min(oldMax, n)) / oldMax) * newMax, newMax)
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function parseComponentsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseScoreV2Payload(value: unknown): ScoreV2Payload | null {
  const record = parseJsonRecord(value)
  if (!record || record.version !== SCORE_V2_VERSION) return null
  const components = parseComponentsRecord(record.components)
  if (!components) return null
  const payload = buildScoreV2Components({
    mlEdge: components.mlEdge,
    chipFlow: components.chipFlow,
    technicalStructure: components.technicalStructure,
    fundamentalQuality: components.fundamentalQuality,
    newsTheme: components.newsTheme,
    technicalBreakdown: parseComponentsRecord(record.technicalBreakdown) as ScoreV2TechnicalBreakdown | null,
    riskFlags: Array.isArray(record.riskFlags) ? record.riskFlags.map(String) : [],
    reasons: Array.isArray(record.reasons) ? record.reasons.map(String) : [],
  })
  const finalScore = finiteNumber(record.finalScore)
  const alphaAdjustment = finiteNumber(record.alphaAdjustment)
  return {
    ...payload,
    ...(finalScore != null ? { finalScore: clampScore(finalScore, 100) } : {}),
    ...(alphaAdjustment != null ? { alphaAdjustment: round1(alphaAdjustment) } : {}),
  }
}

function buildStorageProjection(row: ScoreV2StorageRow): ScoreV2Payload {
  const legacyTech = finiteNumber(row.tech_score) ?? 0
  const legacyMomentum = finiteNumber(row.momentum_score) ?? 0
  return buildScoreV2Components({
    mlEdge: rescale(row.ml_score, 30, SCORE_V2_WEIGHTS.mlEdge),
    chipFlow: rescale(row.chip_score, 40, SCORE_V2_WEIGHTS.chipFlow),
    technicalStructure: rescale(legacyTech + legacyMomentum, 50, SCORE_V2_WEIGHTS.technicalStructure),
    technicalBreakdown: {
      trendStructure: rescale(legacyTech, 30, 7),
      volumeConfirmation: rescale(legacyMomentum, 20, 6),
    },
    reasons: ['score_v2_storage_projection'],
  })
}

function pct(value: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.round((value / total) * 100) / 100
}

export function buildScoreV2Components(input: ScoreV2Input): ScoreV2Payload {
  const components: ScoreV2Components = {
    mlEdge: clampScore(input.mlEdge, SCORE_V2_WEIGHTS.mlEdge),
    chipFlow: clampScore(input.chipFlow, SCORE_V2_WEIGHTS.chipFlow),
    technicalStructure: clampScore(input.technicalStructure, SCORE_V2_WEIGHTS.technicalStructure),
    fundamentalQuality: clampScore(input.fundamentalQuality, SCORE_V2_WEIGHTS.fundamentalQuality),
    newsTheme: clampScore(input.newsTheme, SCORE_V2_WEIGHTS.newsTheme),
  }
  const total = round1(Object.values(components).reduce((sum, value) => sum + value, 0))
  const technicalBreakdown = buildTechnicalBreakdown(input.technicalBreakdown)
  return {
    version: SCORE_V2_VERSION,
    weights: SCORE_V2_WEIGHTS,
    components,
    total,
    ...(technicalBreakdown ? { technicalBreakdown } : {}),
    riskFlags: [...new Set((input.riskFlags ?? []).map(String).filter(Boolean))],
    reasons: [...new Set((input.reasons ?? []).map(String).filter(Boolean))],
  }
}

export function readScoreV2Snapshot(row: ScoreV2StorageRow): ScoreV2Snapshot {
  const canonical = parseScoreV2Payload(row.score_components)
  const payload = canonical ?? buildStorageProjection(row)
  const storageScore = finiteNumber(row.score)
  const finalScore = canonical
    ? payload.finalScore ?? payload.total
    : storageScore ?? payload.total
  const alphaAdjustment = canonical
    ? payload.alphaAdjustment ?? round1(finalScore - payload.total)
    : round1(finalScore - payload.total)
  return {
    source: canonical ? 'score_v2' : 'storage_projection',
    payload,
    components: payload.components,
    total: payload.total,
    finalScore: clampScore(finalScore, 100),
    alphaAdjustment,
    ...(payload.technicalBreakdown ? { technicalBreakdown: payload.technicalBreakdown } : {}),
    riskFlags: payload.riskFlags,
    reasons: payload.reasons,
  }
}

export function scoreV2ComponentPercentages(snapshot: ScoreV2Snapshot): ScoreV2ComponentPct {
  return {
    mlPct: pct(snapshot.components.mlEdge, snapshot.total),
    chipPct: pct(snapshot.components.chipFlow, snapshot.total),
    technicalPct: pct(snapshot.components.technicalStructure, snapshot.total),
    fundamentalPct: pct(snapshot.components.fundamentalQuality, snapshot.total),
    newsPct: pct(snapshot.components.newsTheme, snapshot.total),
  }
}

export function projectScoreV2ToLegacy(payload: ScoreV2Payload): LegacyScoreProjection {
  const volumeConfirmation = payload.technicalBreakdown?.volumeConfirmation ?? 0
  return {
    score: payload.finalScore ?? payload.total,
    ml_score: payload.components.mlEdge,
    chip_score: payload.components.chipFlow,
    tech_score: payload.components.technicalStructure,
    momentum_score: clampScore(volumeConfirmation, 20),
    score_components: JSON.stringify(payload),
  }
}

export function buildPartialScreenerScoreV2(input: PartialScreenerScoreV2Input): ScoreV2Payload {
  const legacyTech = finiteNumber(input.techScore30) ?? 0
  const legacyMomentum = finiteNumber(input.momentumScore20) ?? 0
  const technicalStructure = rescale(legacyTech + legacyMomentum, 50, SCORE_V2_WEIGHTS.technicalStructure)
  const volumeConfirmation = rescale(legacyMomentum, 20, 6)
  return buildScoreV2Components({
    chipFlow: rescale(input.chipScore40, 40, SCORE_V2_WEIGHTS.chipFlow),
    technicalStructure,
    technicalBreakdown: {
      volumeConfirmation,
    },
    reasons: input.reasons,
  })
}
