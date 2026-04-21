/**
 * riskTypes.ts — RiskFramework R1 (2026-04-21)
 *
 * 4-level risk framework types per RISK_FRAMEWORK_ARCHITECTURE.md.
 *   Level 1 System:   S1-S4 (kill switch, staleness, proxy health, clock)
 *   Level 2 Portfolio: P1-P7 (existing circuit breakers) + P8-P9 (R3)
 *   Level 3 Position: N1-N3 (sector / single-name / correlation, R3)
 *   Level 4 Order:    G5-G14 (fat finger / price band / lot size / ..., R3)
 *
 * R1 scope: only Level 2 P1-P7 extraction (existing behavior preserved,
 * legacy early-return semantics in paper.ts `checkCircuitBreakers()`).
 * R2 will migrate early-return → full-chain merge (halt=OR, posPct=MIN).
 */

export type RiskLevel = 'system' | 'portfolio' | 'position' | 'order'
export type MomentumZone = 'RED' | 'YELLOW' | 'GREEN'

/**
 * Legacy portfolio-level circuit breaker state (pre-R1). Migration C will
 * fold this into AggregatedRiskState (R2+).
 *
 * Fields semantics:
 *   halt              — true means abort all new buys (Layer 1 MDD or Layer 5)
 *   maxPositionPct    — 0 when halt; scaled down when layer triggers
 *   buyConfThreshold  — effective = clip(baseline + adaptive delta, clipLo-clipHi)
 *                       raised when Layer 1 (deep DD) or Layer 2 (low acc) fires
 *   sellConfThreshold — analogous
 *   momentumZone      — Layer 6 last-applied zone (diagnostic)
 *   reason            — textual reason (only first-matching layer fills this)
 */
export interface CircuitBreakerState {
  halt: boolean
  reason?: string
  maxPositionPct: number
  buyConfThreshold: number
  sellConfThreshold: number
  momentumZone?: MomentumZone
}

/** R1 layer-check result: null = no trigger (continue), state = early-return. */
export type LegacyLayerResult = CircuitBreakerState | null

/**
 * Per-layer check context. Derived once by `checkCircuitBreakers()` and
 * reused across P1-P7 so each checker can stay pure.
 */
export interface LegacyLayerDeps {
  defaults: CircuitBreakerState
  effectiveBuy: number
  effectiveSell: number
}

// ─── Full-chain types (R2+) — stub, unused in R1 ────────────────────────────

export interface RiskCheckResult {
  layerId: string
  level: RiskLevel
  triggered: boolean
  halt: boolean
  maxPositionPct: number | null
  buyConfThreshold: number | null
  sellConfThreshold: number | null
  reason: string
  meta: Record<string, unknown>
  evaluatedAt: string
}

export interface AggregatedRiskState {
  halt: boolean
  haltReasons: string[]
  maxPositionPct: number
  buyConfThreshold: number
  sellConfThreshold: number
  momentumZone: MomentumZone
  layers: RiskCheckResult[]
  triggeredCount: number
  severity: 'normal' | 'elevated' | 'high' | 'critical' | 'halted'
  evaluatedAt: string
}
