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
  technicalSignals?: Record<string, unknown>
  riskFlags: string[]
  reasons: string[]
  alphaReason?: Record<string, unknown>
  chipEvidence?: Record<string, unknown>
  reasonVariants?: Record<string, any>
}

export interface ScoreV2StorageRow {
  score_components?: unknown
}

export type ScoreV2SnapshotSource = 'score_v2'

export interface ScoreV2Snapshot {
  source: ScoreV2SnapshotSource
  payload: ScoreV2Payload
  components: ScoreV2Components
  total: number
  finalScore: number
  alphaAdjustment: number
  technicalBreakdown?: Required<ScoreV2TechnicalBreakdown>
  technicalSignals?: Record<string, unknown>
  riskFlags: string[]
  reasons: string[]
  alphaReason?: Record<string, unknown>
  chipEvidence?: Record<string, unknown>
  reasonVariants?: Record<string, any>
}

export interface ScoreV2SnapshotSummary {
  version: typeof SCORE_V2_VERSION
  source: ScoreV2SnapshotSource
  weights: typeof SCORE_V2_WEIGHTS
  components: ScoreV2Components
  total: number
  finalScore: number
  alphaAdjustment: number
  technicalBreakdown?: Required<ScoreV2TechnicalBreakdown>
  technicalSignals?: Record<string, unknown>
  riskFlags: string[]
  reasons: string[]
  alphaReason?: Record<string, unknown>
  chipEvidence?: Record<string, unknown>
  reasonVariants?: Record<string, any>
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
    ...(parseComponentsRecord(record.technicalSignals) ? { technicalSignals: parseComponentsRecord(record.technicalSignals)! } : {}),
    ...(parseComponentsRecord(record.alphaReason) ? { alphaReason: parseComponentsRecord(record.alphaReason)! } : {}),
    ...(parseComponentsRecord(record.chipEvidence) ? { chipEvidence: parseComponentsRecord(record.chipEvidence)! } : {}),
    ...(parseComponentsRecord(record.reasonVariants) ? { reasonVariants: parseComponentsRecord(record.reasonVariants)! as Record<string, any> } : {}),
  }
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

export function readScoreV2Snapshot(row: ScoreV2StorageRow): ScoreV2Snapshot | null {
  const canonical = parseScoreV2Payload(row.score_components)
  if (!canonical) return null
  const payload = canonical
  const finalScore = payload.finalScore ?? payload.total
  const alphaAdjustment = payload.alphaAdjustment ?? round1(finalScore - payload.total)
  return {
    source: 'score_v2',
    payload,
    components: payload.components,
    total: payload.total,
    finalScore: clampScore(finalScore, 100),
    alphaAdjustment,
    ...(payload.technicalBreakdown ? { technicalBreakdown: payload.technicalBreakdown } : {}),
    ...(payload.technicalSignals ? { technicalSignals: payload.technicalSignals } : {}),
    riskFlags: payload.riskFlags,
    reasons: payload.reasons,
    ...(payload.alphaReason ? { alphaReason: payload.alphaReason } : {}),
    ...(payload.chipEvidence ? { chipEvidence: payload.chipEvidence } : {}),
    ...(payload.reasonVariants ? { reasonVariants: payload.reasonVariants } : {}),
  }
}

export function serializeScoreV2Snapshot(snapshot: ScoreV2Snapshot): ScoreV2SnapshotSummary {
  return {
    version: SCORE_V2_VERSION,
    source: snapshot.source,
    weights: snapshot.payload.weights,
    components: snapshot.components,
    total: snapshot.total,
    finalScore: snapshot.finalScore,
    alphaAdjustment: snapshot.alphaAdjustment,
    ...(snapshot.technicalBreakdown ? { technicalBreakdown: snapshot.technicalBreakdown } : {}),
    ...(snapshot.technicalSignals ? { technicalSignals: snapshot.technicalSignals } : {}),
    riskFlags: snapshot.riskFlags,
    reasons: snapshot.reasons,
    ...(snapshot.alphaReason ? { alphaReason: snapshot.alphaReason } : {}),
    ...(snapshot.chipEvidence ? { chipEvidence: snapshot.chipEvidence } : {}),
    ...(snapshot.reasonVariants ? { reasonVariants: snapshot.reasonVariants } : {}),
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
