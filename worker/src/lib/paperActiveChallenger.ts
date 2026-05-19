import type { Bindings } from '../types'

export const PAPER_ACTIVE_RUNTIME_SCHEMA_VERSION = 'paper-active-runtime-v1' as const

export type PaperChallengerState =
  | 'candidate'
  | 'clean_asset'
  | 'paper_active_challenger'
  | 'paper_primary'
  | 'real_review_ready'

export interface PaperActiveRuntimePacket {
  canInfluencePaperDecision?: boolean
  canWritePaperAttribution?: boolean
  canWriteOrder?: boolean
  canSubmitRealOrder?: boolean
  canWriteRegime?: boolean
  canWriteMlVote?: boolean
  canWrite106Feature?: boolean
}

export interface PaperChallengerCandidateInput {
  candidateId: string
  candidateType: string
  currentState: PaperChallengerState | string
  source: string
  featureSetVersion?: string | null
  promotionPacket?: Record<string, unknown> | null
  notes?: string | null
}

export interface NormalizedPaperChallengerCandidate {
  candidateId: string
  candidateType: string
  currentState: PaperChallengerState | string
  source: string
  featureSetVersion: string | null
  promotionPacketJson: string | null
  notes: string | null
}

export interface PaperDecisionAttributionInput {
  tradeDate: string
  symbol: string
  decision: string
  paperLane?: string
  candidateSource: string
  baselineScore?: number | null
  challengerScore?: number | null
  featureSetVersion?: string | null
  regimeVersion?: string | null
  evidenceSources?: string[]
}

export interface NormalizedPaperDecisionAttribution {
  tradeDate: string
  symbol: string
  decision: string
  paperLane: string
  candidateSource: string
  baselineScore: number | null
  challengerScore: number | null
  decisionDelta: number | null
  featureSetVersion: string | null
  regimeVersion: string | null
  evidenceSources: string[]
  evidenceSourcesJson: string
  canWriteOrder: false
}

export interface PaperChallengerDailyMetricsInput {
  tradeDate: string
  candidateId: string
  paperDecisionCount?: number
  precisionAtK?: number | null
  hitRate?: number | null
  avgReturnPct?: number | null
  maxDrawdownPct?: number | null
  turnoverRatio?: number | null
  topkOverlap?: number | null
  regimeSplitPassed?: boolean | number
  runtimeSpeedupPct?: number | null
  metrics?: Record<string, unknown> | null
}

export interface NormalizedPaperChallengerDailyMetrics {
  tradeDate: string
  candidateId: string
  paperDecisionCount: number
  precisionAtK: number | null
  hitRate: number | null
  avgReturnPct: number | null
  maxDrawdownPct: number | null
  turnoverRatio: number | null
  topkOverlap: number | null
  regimeSplitPassed: 0 | 1
  runtimeSpeedupPct: number | null
  metricsJson: string | null
}

export interface PromotionAuditEventInput {
  candidateId: string
  fromState?: string | null
  toState?: string | null
  decision: string
  failedGates?: string[]
  packet: Record<string, unknown>
  realTradingEffect?: string | null
}

export interface NormalizedPromotionAuditEvent {
  candidateId: string
  fromState: string | null
  toState: string | null
  decision: string
  failedGatesJson: string
  packetJson: string
  realTradingEffect: string
}

export interface PaperActivePostmarketReportPersistenceSummary {
  candidates: number
  dailyMetrics: number
  auditEvents: number
}

function roundNumber(value: number, digits = 6): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function nullableNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function isMissingTableError(error: unknown): boolean {
  return /no such table/i.test(String(error))
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item) => Object.keys(item).length > 0)
    : []
}

function dateFromGeneratedAt(value: unknown): string {
  if (typeof value === 'string' && value.length >= 10) return value.slice(0, 10)
  return new Date().toISOString().slice(0, 10)
}

async function runSafely(action: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (!isMissingTableError(error)) {
      console.warn(`[PaperActiveChallenger] ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function buildPaperActiveRuntimePolicy() {
  return {
    schemaVersion: PAPER_ACTIVE_RUNTIME_SCHEMA_VERSION,
    canInfluencePaperDecision: true,
    canWritePaperAttribution: true,
    canWriteOrder: false,
    canSubmitRealOrder: false,
    canWriteRegime: false,
    canWriteMlVote: false,
    canWrite106Feature: false,
  } as const
}

export function validatePaperActiveRuntimePacket(packet: PaperActiveRuntimePacket): string[] {
  const violations: string[] = []
  if (packet.canWriteOrder === true) violations.push('paper_active_must_not_write_order')
  if (packet.canSubmitRealOrder === true) violations.push('paper_active_must_not_submit_real_order')
  if (packet.canWriteRegime === true) violations.push('paper_active_must_not_write_regime')
  if (packet.canWriteMlVote === true) violations.push('paper_active_must_not_write_ml_vote')
  if (packet.canWrite106Feature === true) violations.push('paper_active_must_not_write_106_feature')
  return violations
}

export function normalizePaperChallengerCandidate(input: PaperChallengerCandidateInput): NormalizedPaperChallengerCandidate {
  return {
    candidateId: String(input.candidateId),
    candidateType: String(input.candidateType),
    currentState: String(input.currentState),
    source: String(input.source),
    featureSetVersion: input.featureSetVersion ?? null,
    promotionPacketJson: input.promotionPacket ? encodeJson(input.promotionPacket) : null,
    notes: input.notes ?? null,
  }
}

export function normalizePaperDecisionAttribution(input: PaperDecisionAttributionInput): NormalizedPaperDecisionAttribution {
  const baselineScore = nullableNumber(input.baselineScore)
  const challengerScore = nullableNumber(input.challengerScore)
  const decisionDelta = baselineScore == null || challengerScore == null
    ? null
    : roundNumber(challengerScore - baselineScore)
  const evidenceSources = [...(input.evidenceSources ?? [])]
  return {
    tradeDate: String(input.tradeDate),
    symbol: String(input.symbol),
    decision: String(input.decision),
    paperLane: input.paperLane ?? 'paper_active_challenger',
    candidateSource: String(input.candidateSource),
    baselineScore,
    challengerScore,
    decisionDelta,
    featureSetVersion: input.featureSetVersion ?? null,
    regimeVersion: input.regimeVersion ?? null,
    evidenceSources,
    evidenceSourcesJson: encodeJson(evidenceSources),
    canWriteOrder: false,
  }
}

export function normalizePaperChallengerDailyMetrics(
  input: PaperChallengerDailyMetricsInput,
): NormalizedPaperChallengerDailyMetrics {
  return {
    tradeDate: String(input.tradeDate),
    candidateId: String(input.candidateId),
    paperDecisionCount: Math.max(0, Math.trunc(input.paperDecisionCount ?? 0)),
    precisionAtK: nullableNumber(input.precisionAtK),
    hitRate: nullableNumber(input.hitRate),
    avgReturnPct: nullableNumber(input.avgReturnPct),
    maxDrawdownPct: nullableNumber(input.maxDrawdownPct),
    turnoverRatio: nullableNumber(input.turnoverRatio),
    topkOverlap: nullableNumber(input.topkOverlap),
    regimeSplitPassed: input.regimeSplitPassed === true || input.regimeSplitPassed === 1 ? 1 : 0,
    runtimeSpeedupPct: nullableNumber(input.runtimeSpeedupPct),
    metricsJson: input.metrics ? encodeJson(input.metrics) : null,
  }
}

export function normalizePromotionAuditEvent(input: PromotionAuditEventInput): NormalizedPromotionAuditEvent {
  return {
    candidateId: String(input.candidateId),
    fromState: input.fromState ?? null,
    toState: input.toState ?? null,
    decision: String(input.decision),
    failedGatesJson: encodeJson(input.failedGates ?? []),
    packetJson: encodeJson(input.packet),
    realTradingEffect: input.realTradingEffect ?? String(input.packet?.real_trading_effect ?? 'none'),
  }
}

export async function recordPaperChallengerCandidate(
  env: Pick<Bindings, 'DB'>,
  input: PaperChallengerCandidateInput,
): Promise<void> {
  const candidate = normalizePaperChallengerCandidate(input)
  await runSafely(() => env.DB.prepare(`
    INSERT INTO paper_challenger_candidates
      (candidate_id, candidate_type, current_state, source, feature_set_version,
       promotion_packet_json, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(candidate_id) DO UPDATE SET
      candidate_type=excluded.candidate_type,
      current_state=excluded.current_state,
      source=excluded.source,
      feature_set_version=excluded.feature_set_version,
      promotion_packet_json=excluded.promotion_packet_json,
      notes=excluded.notes,
      updated_at=datetime('now')
  `).bind(
    candidate.candidateId,
    candidate.candidateType,
    candidate.currentState,
    candidate.source,
    candidate.featureSetVersion,
    candidate.promotionPacketJson,
    candidate.notes,
  ).run(), 'candidate upsert')
}

export async function recordPaperDecisionAttribution(
  env: Pick<Bindings, 'DB'>,
  input: PaperDecisionAttributionInput,
): Promise<void> {
  const attribution = normalizePaperDecisionAttribution(input)
  await runSafely(() => env.DB.prepare(`
    INSERT INTO paper_decision_attribution
      (trade_date, symbol, decision, paper_lane, candidate_source, baseline_score,
       challenger_score, decision_delta, feature_set_version, regime_version,
       evidence_sources_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    attribution.tradeDate,
    attribution.symbol,
    attribution.decision,
    attribution.paperLane,
    attribution.candidateSource,
    attribution.baselineScore,
    attribution.challengerScore,
    attribution.decisionDelta,
    attribution.featureSetVersion,
    attribution.regimeVersion,
    attribution.evidenceSourcesJson,
  ).run(), 'decision attribution insert')
}

export async function recordPaperChallengerDailyMetrics(
  env: Pick<Bindings, 'DB'>,
  input: PaperChallengerDailyMetricsInput,
): Promise<void> {
  const metrics = normalizePaperChallengerDailyMetrics(input)
  await runSafely(() => env.DB.prepare(`
    INSERT INTO paper_challenger_daily_metrics
      (trade_date, candidate_id, paper_decision_count, precision_at_k, hit_rate,
       avg_return_pct, max_drawdown_pct, turnover_ratio, topk_overlap,
       regime_split_passed, runtime_speedup_pct, metrics_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(trade_date, candidate_id) DO UPDATE SET
      paper_decision_count=excluded.paper_decision_count,
      precision_at_k=excluded.precision_at_k,
      hit_rate=excluded.hit_rate,
      avg_return_pct=excluded.avg_return_pct,
      max_drawdown_pct=excluded.max_drawdown_pct,
      turnover_ratio=excluded.turnover_ratio,
      topk_overlap=excluded.topk_overlap,
      regime_split_passed=excluded.regime_split_passed,
      runtime_speedup_pct=excluded.runtime_speedup_pct,
      metrics_json=excluded.metrics_json
  `).bind(
    metrics.tradeDate,
    metrics.candidateId,
    metrics.paperDecisionCount,
    metrics.precisionAtK,
    metrics.hitRate,
    metrics.avgReturnPct,
    metrics.maxDrawdownPct,
    metrics.turnoverRatio,
    metrics.topkOverlap,
    metrics.regimeSplitPassed,
    metrics.runtimeSpeedupPct,
    metrics.metricsJson,
  ).run(), 'daily metrics upsert')
}

export async function recordPaperActivePromotionAudit(
  env: Pick<Bindings, 'DB'>,
  input: PromotionAuditEventInput,
): Promise<void> {
  const audit = normalizePromotionAuditEvent(input)
  await runSafely(() => env.DB.prepare(`
    INSERT INTO promotion_audit_events
      (candidate_id, from_state, to_state, decision, failed_gates_json,
       packet_json, real_trading_effect, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    audit.candidateId,
    audit.fromState,
    audit.toState,
    audit.decision,
    audit.failedGatesJson,
    audit.packetJson,
    audit.realTradingEffect,
  ).run(), 'promotion audit insert')
}

export async function recordPaperActivePostmarketReport(
  env: Pick<Bindings, 'DB'>,
  report: Record<string, unknown>,
): Promise<PaperActivePostmarketReportPersistenceSummary> {
  if (report.real_trading_effect != null && report.real_trading_effect !== 'none') {
    throw new Error('paper_active_postmarket_report_must_not_have_real_trading_effect')
  }

  const generatedAt = report.generated_at
  const tradeDate = dateFromGeneratedAt(generatedAt)
  const promotionPackets = arrayOfRecords(report.promotion_packets)
  const auditEvents = arrayOfRecords(report.audit_events)
  let candidates = 0
  let dailyMetrics = 0
  let persistedAuditEvents = 0

  for (const packet of promotionPackets) {
    const candidateId = String(packet.candidate_id ?? 'unknown')
    const candidateType = String(packet.candidate_type ?? 'unknown')
    const nextState = String(packet.next_state ?? packet.current_state ?? 'paper_active_challenger')
    await recordPaperChallengerCandidate(env, {
      candidateId,
      candidateType,
      currentState: nextState,
      source: 'paper_challenger_postmarket_report',
      promotionPacket: packet,
      notes: `postmarket_decision:${String(packet.decision ?? 'unknown')}`,
    })
    candidates += 1

    const metrics = asRecord(packet.challenger_metrics)
    if (Object.keys(metrics).length > 0) {
      await recordPaperChallengerDailyMetrics(env, {
        tradeDate,
        candidateId,
        paperDecisionCount: nullableNumber(metrics.paper_decision_count as number | null) ?? 0,
        precisionAtK: nullableNumber(metrics.precision_at_k as number | null),
        hitRate: nullableNumber(metrics.hit_rate as number | null),
        avgReturnPct: nullableNumber(metrics.avg_return_pct as number | null),
        maxDrawdownPct: nullableNumber(metrics.max_drawdown_pct as number | null),
        turnoverRatio: nullableNumber(metrics.turnover_ratio as number | null),
        topkOverlap: nullableNumber(metrics.topk_overlap as number | null),
        regimeSplitPassed: metrics.regime_split_passed === true ? 1 : 0,
        runtimeSpeedupPct: nullableNumber(metrics.runtime_speedup_pct as number | null),
        metrics,
      })
      dailyMetrics += 1
    }
  }

  for (const auditEvent of auditEvents) {
    const packet = asRecord(auditEvent.packet)
    await recordPaperActivePromotionAudit(env, {
      candidateId: String(auditEvent.candidate_id ?? 'unknown'),
      fromState: auditEvent.from_state == null ? null : String(auditEvent.from_state),
      toState: auditEvent.to_state == null ? null : String(auditEvent.to_state),
      decision: String(auditEvent.decision ?? 'unknown'),
      failedGates: Array.isArray(auditEvent.failed_gates)
        ? auditEvent.failed_gates.map((item) => String(item))
        : [],
      packet: Object.keys(packet).length > 0 ? packet : auditEvent,
      realTradingEffect: String(auditEvent.real_trading_effect ?? 'none'),
    })
    persistedAuditEvents += 1
  }

  return {
    candidates,
    dailyMetrics,
    auditEvents: persistedAuditEvents,
  }
}
