/**
 * riskConfig.ts — #20/#26 R3 (2026-04-21)
 *
 * Independent KV key `trading:risk_config` (separate from `trading:config`)
 * per design doc: kill switch must be updatable in < 1 sec, can't share KV
 * with 200+ strategy params.
 *
 * Defaults chosen conservatively — user will tune via KV / dashboard.
 */

export type FactorPacketBandOp = '<' | '<=' | '>' | '>='
export interface FactorPacketBand { op: FactorPacketBandOp; cut: number; score: number }
/** First matching band wins; no match scores `otherwise`. `warn` only sets the tile status. */
export interface FactorPacketRule { bands: FactorPacketBand[]; otherwise: number; warn?: { op: FactorPacketBandOp; cut: number } }
export interface FactorPacketPolicy {
  missingScore: number
  weights: { price_trend: number; business_cycle: number; chips: number; leverage: number; volatility: number; macro: number; global: number; event_monitors: number }
  priceTrend: FactorPacketRule
  businessCycle: FactorPacketRule
  chips: FactorPacketRule
  leverage: FactorPacketRule
  volatilityVix: FactorPacketRule
  volatilityVol20: FactorPacketRule
  evidenceStanceScores: { bearish: number; bullish: number; neutral: number }
  eventMonitorWarn: number
}

export interface RiskConfig {
  system: {
    killSwitch: boolean                     // emergency stop (manual)
    quoteStalenessTolerance: number         // seconds, S2 intraday quote
    dailyDataStalenessTolerance: number     // seconds, S2 daily OHLCV
    haltOnProxyFailure: boolean             // S3 block when Shioaji proxy down
    clockSkewTolerance: number              // seconds, S4 TW time drift
  }
  portfolio: {
    dailyPnlLossLimit: number               // NT$ absolute, P8
    dailyPnlLossLimitPct: number            // fraction of account equity, P8
    intradayDrawdownHalt: number            // fraction, P9 (peak-to-trough intraday)
    marketShockOrangePct: number            // fraction, one-day TWII shock overlay
    marketShockRedPct: number               // fraction, one-day TWII severe shock overlay
    marketShockBlackPct: number             // fraction, one-day TWII emergency halt
    breadthOrangeAdvanceRatio: number       // fraction, advancing names / compared names
    breadthRedAdvanceRatio: number
    breadthBlackAdvanceRatio: number
    greenTargetExposure: number             // portfolio exposure caps consumed by allocator + exits
    yellowTargetExposure: number
    orangeTargetExposure: number
    redTargetExposure: number
    blackTargetExposure: number              // also the five-slot black exposure owner
    // Five-slot per-candidate slot floor cap by canonical market level (fraction of one slot).
    slotFloorCapByLevel: { green: number; yellow: number; orange: number; red: number; black: number }
    blackHaltsNewBuys: boolean                // canonical black blocks new buys (a blocked runtime always does)
    // Single owner of every factor-packet tile score band, weight and warn cut (market-regime-factor-packet-v1).
    factorPacketPolicy: FactorPacketPolicy
    // Set only on FAIL_CLOSED_RISK_CONFIG (KV missing / unreadable); never read from KV. Market-risk consumers
    // treat it as unavailable: no stored v2 / packet write and a blocked runtime, never program defaults.
    configUnavailable?: true
    // Single owner of every score→level cut (upper bound, inclusive) for green/yellow/orange/red.
    // storedV1 = frozen market_risk.risk_score; storedV2 = deduplicated stress; factorPacket = packet score.
    riskLevelThresholds: { storedV1: number[]; storedV2: number[]; factorPacket: number[] }
    storedRiskV2: StoredRiskV2Policy
    regimeConfirmSessions: number            // HMM family must repeat this many sessions before it maps to a level
    storedBlackRequiresFastConfirmation: boolean // stored black without shock/breadth >= red is capped at red
  }
  position: {
    maxPerSector: number                    // N1: max holdings per sector
    maxSingleNamePct: number                // N2: fraction of portfolio
    correlationThreshold: number            // N3: pairwise 60d return corr
    correlationWindow: number               // trading days
    minCorrelationOverlap: number           // N3: shared daily returns needed before a pair is judged
  }
  order: {
    maxSingleOrderValue: number             // G5 fat finger, NT$
    maxPriceDeviationPct: number            // G6 deviation from ref close
    maxDailyBuyOrders: number
    maxDailySellOrders: number
    enforceRegularLots: boolean             // G7 台股整股 1000 shares
    maxVolumeParticipation: number          // G14 fraction of 20d avg volume
  }
}

export interface StoredRiskV2Policy {
  groupCaps: { volatility: number; trend: number; flow: number; leverage: number; breadth: number }
  // 外資 5 日淨額觸發方式。唯一值 'net_sell'：5 日淨額 < 0（淨賣）即觸發，不是金額門檻。
  // v1 的 -50 原本是「億股」門檻，303b4f45（5/6）把單位改成億元後就等於淨賣即觸發；
  // fnet 變體研究（固定 p20/p10、成交值正規化、z20/z60）沒有一個穩定勝出，所以保留這個語意。
  foreignNet5dTrigger: 'net_sell'
  marginRatioPct: { elevated: number; extreme: number } // 融資餘額 / 融資限額（%）
}

// K16a / C28-01: KV is the only owner of these fields. They have no program default:
// a missing or invalid value fails closed (to 0) at runtime and is never seeded.
const KV_OWNED_POSITION_FIELDS = ['maxSingleNamePct', 'minCorrelationOverlap'] as const
type KvOwnedPositionField = typeof KV_OWNED_POSITION_FIELDS[number]

export type RiskConfigDefaults = Omit<RiskConfig, 'position'> & {
  position: Omit<RiskConfig['position'], KvOwnedPositionField>
}

export const DEFAULT_RISK_CONFIG: RiskConfigDefaults = {
  system: {
    killSwitch: false,
    quoteStalenessTolerance: 120,
    dailyDataStalenessTolerance: 86400,
    haltOnProxyFailure: true,
    clockSkewTolerance: 30,
  },
  portfolio: {
    dailyPnlLossLimit: -30000,
    dailyPnlLossLimitPct: -0.03,
    intradayDrawdownHalt: 0.05,
    marketShockOrangePct: -0.03,
    marketShockRedPct: -0.05,
    marketShockBlackPct: -0.08,
    breadthOrangeAdvanceRatio: 0.25,
    breadthRedAdvanceRatio: 0.15,
    breadthBlackAdvanceRatio: 0.08,
    greenTargetExposure: 0.95,
    yellowTargetExposure: 0.68,
    orangeTargetExposure: 0.45,
    redTargetExposure: 0.20,
    blackTargetExposure: 0,
    slotFloorCapByLevel: { green: 0.75, yellow: 0.65, orange: 0.55, red: 0.45, black: 0 },
    blackHaltsNewBuys: true,
    factorPacketPolicy: {
      missingScore: 45,
      weights: { price_trend: 0.20, business_cycle: 0.15, chips: 0.15, leverage: 0.15, volatility: 0.10, macro: 0.10, global: 0.10, event_monitors: 0.05 },
      // twii_bias % vs MA20.
      priceTrend: { bands: [{ op: '<=', cut: -6, score: 85 }, { op: '<=', cut: -3, score: 65 }, { op: '>=', cut: 3, score: 20 }], otherwise: 40, warn: { op: '<=', cut: -3 } },
      // 景氣對策信號 score (light boundaries 16/22/31/37).
      businessCycle: { bands: [{ op: '<=', cut: 16, score: 85 }, { op: '<=', cut: 22, score: 62 }, { op: '<=', cut: 31, score: 38 }, { op: '<=', cut: 37, score: 55 }], otherwise: 72 },
      // Three-institution 5-day net (億元). Sign only: the old -250/-80/+120 cuts sat inside a distribution with
      // p25 -2820 / p75 +798 億, so they already acted as a sign trigger; quantile, turnover and z20 cuts were worse.
      chips: { bands: [{ op: '<', cut: 0, score: 85 }, { op: '>', cut: 0, score: 20 }], otherwise: 40, warn: { op: '<', cut: 0 } },
      // Margin balance day-over-day change %.
      leverage: { bands: [{ op: '>', cut: 8, score: 75 }, { op: '>', cut: 3, score: 55 }, { op: '<', cut: -5, score: 25 }], otherwise: 40, warn: { op: '>', cut: 3 } },
      volatilityVix: { bands: [{ op: '>=', cut: 35, score: 85 }, { op: '>=', cut: 25, score: 65 }, { op: '<=', cut: 16, score: 25 }], otherwise: 40, warn: { op: '>=', cut: 25 } },
      // Used only when VIX is missing.
      volatilityVol20: { bands: [{ op: '>=', cut: 35, score: 80 }, { op: '>=', cut: 24, score: 60 }], otherwise: 35, warn: { op: '>=', cut: 25 } },
      evidenceStanceScores: { bearish: 75, bullish: 15, neutral: 40 },
      eventMonitorWarn: 0.7,
    },
    riskLevelThresholds: {
      storedV1: [25, 45, 65, 85],
      // Percentile matching (rc3 rule, deterministic): sort the replay v2 scores ascending; with c_k the cumulative
      // count of stored v1 days at level <= k, cut_k = sorted[c_k - 1]. Ties at the cut fall to the lower (milder)
      // level, so the realised counts can exceed c_k (green 63 vs 48, <=yellow 133 vs 127). The nearest-count
      // alternative [35.9, 55.1, 73.1, 91] replays +7.31% vs +10.80% at the same MDD -10.02%, so rc3 stays.
      storedV2: [37.2, 56.4, 73.1, 91],
      factorPacket: [25, 45, 65, 85],
    },
    storedRiskV2: {
      groupCaps: { volatility: 35, trend: 15, flow: 20, leverage: 0, breadth: 8 },
      foreignNet5dTrigger: 'net_sell',
      marginRatioPct: { elevated: 3.7, extreme: 3.8 },
    },
    regimeConfirmSessions: 2,
    storedBlackRequiresFastConfirmation: true,
  },
  position: {
    maxPerSector: 2,
    correlationThreshold: 0.7,
    correlationWindow: 60,
  },
  order: {
    maxSingleOrderValue: 300000,
    maxPriceDeviationPct: 0.07,
    maxDailyBuyOrders: 5,
    maxDailySellOrders: 10,
    enforceRegularLots: true,
    maxVolumeParticipation: 0.05,
  },
}

export const FAIL_CLOSED_RISK_CONFIG: RiskConfig = {
  ...DEFAULT_RISK_CONFIG,
  portfolio: { ...DEFAULT_RISK_CONFIG.portfolio, configUnavailable: true },
  system: {
    ...DEFAULT_RISK_CONFIG.system,
    killSwitch: true,
    haltOnProxyFailure: true,
  },
  position: {
    ...DEFAULT_RISK_CONFIG.position,
    maxSingleNamePct: 0,
    minCorrelationOverlap: 0,
  },
  order: {
    ...DEFAULT_RISK_CONFIG.order,
    maxSingleOrderValue: 0,
    maxDailyBuyOrders: 0,
    maxDailySellOrders: 0,
    maxVolumeParticipation: 0,
  },
}

export interface RiskConfigRepairPlan {
  key: string
  exists: boolean
  source: 'kv' | 'missing' | 'error'
  effective: RiskConfig
  seedConfig: RiskConfig
  runtimeKillSwitchActive: boolean
  complete: boolean
  needsRepair: boolean
  repairReasons: string[]
  error?: string
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function plainRecord(value: unknown): Record<string, any> {
  return isPlainRecord(value) ? value : {}
}

// Nested risk-level policy objects merge per field, so a partial KV object keeps the program default for the rest.
function mergePortfolioDefaults(partial: unknown): RiskConfig['portfolio'] {
  const raw = plainRecord(partial), defaults = DEFAULT_RISK_CONFIG.portfolio
  // A nested field present with the wrong container type is kept as is, so validation blocks instead of
  // silently replacing it with the default.
  const nested = <T extends object>(value: unknown, fallback: T, merge: (record: Record<string, any>) => T): T =>
    value === undefined ? structuredClone(fallback) : isPlainRecord(value) ? merge(value) : value as T
  const v2 = raw.storedRiskV2
  const { configUnavailable: _ignored, ...kvFields } = raw   // only FAIL_CLOSED_RISK_CONFIG may carry it
  return {
    ...defaults,
    ...kvFields,
    slotFloorCapByLevel: nested(raw.slotFloorCapByLevel, defaults.slotFloorCapByLevel, caps => ({ ...defaults.slotFloorCapByLevel, ...caps })),
    // Per-field merge; each tile rule (bands + otherwise + warn) is replaced whole when present.
    factorPacketPolicy: nested(raw.factorPacketPolicy, defaults.factorPacketPolicy, record => ({
      ...structuredClone(defaults.factorPacketPolicy),
      ...record,
      weights: nested(record.weights, defaults.factorPacketPolicy.weights, weights => ({ ...defaults.factorPacketPolicy.weights, ...weights })),
      evidenceStanceScores: nested(record.evidenceStanceScores, defaults.factorPacketPolicy.evidenceStanceScores,
        scores => ({ ...defaults.factorPacketPolicy.evidenceStanceScores, ...scores })),
    })),
    riskLevelThresholds: nested(raw.riskLevelThresholds, defaults.riskLevelThresholds, thresholds => ({ ...structuredClone(defaults.riskLevelThresholds), ...thresholds })),
    storedRiskV2: nested(v2, defaults.storedRiskV2, record => ({
      ...defaults.storedRiskV2,
      ...record,
      groupCaps: nested(record.groupCaps, defaults.storedRiskV2.groupCaps, caps => ({ ...defaults.storedRiskV2.groupCaps, ...caps })),
      marginRatioPct: nested(record.marginRatioPct, defaults.storedRiskV2.marginRatioPct, cuts => ({ ...defaults.storedRiskV2.marginRatioPct, ...cuts })),
    })),
  }
}

/**
 * Deep-merge user-supplied partial over program defaults (one level deep per section).
 * KV-owned fields are carried only when the partial has them; nothing fills them in.
 */
function mergeProgramDefaults(partial: any): RiskConfig {
  const raw = partial && typeof partial === 'object' ? partial : {}
  return {
    system:    { ...DEFAULT_RISK_CONFIG.system,    ...(raw.system    ?? {}) },
    portfolio: mergePortfolioDefaults(raw.portfolio),
    position:  { ...DEFAULT_RISK_CONFIG.position,  ...(raw.position  ?? {}) } as RiskConfig['position'],
    order:     { ...DEFAULT_RISK_CONFIG.order,     ...(raw.order     ?? {}) },
  }
}

function validSingleNameCap(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** Same bounds as the backtest contract (FormalPositionRiskParams.validate). */
function validMinCorrelationOverlap(value: unknown, position: Record<string, unknown>): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 3 && value <= Number(position.correlationWindow)
}

const VALID_OWNED_POSITION_FIELD: Record<KvOwnedPositionField, (value: unknown, position: Record<string, unknown>) => boolean> = {
  maxSingleNamePct: validSingleNameCap,
  minCorrelationOverlap: validMinCorrelationOverlap,
}

/** Runtime view: a missing or invalid owned field is 0, which admits no new position (no cap / no correlation verdict). */
function failClosedOwnedFields(cfg: RiskConfig): RiskConfig {
  const position = { ...cfg.position }
  for (const key of KV_OWNED_POSITION_FIELDS) {
    if (VALID_OWNED_POSITION_FIELD[key](position[key], position)) continue
    console.warn(`[RiskConfig] trading:risk_config.position.${key} missing or invalid, fails closed to 0`)
    position[key] = 0
  }
  return { ...cfg, position }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function collectMissingFields(raw: unknown): string[] {
  if (!isRecord(raw)) return ['missing_or_invalid_risk_config']
  const reasons: string[] = []
  for (const [section, defaults] of Object.entries(DEFAULT_RISK_CONFIG) as Array<[keyof RiskConfig, Record<string, unknown>]>) {
    const sectionValue = raw[section]
    if (!isRecord(sectionValue)) {
      reasons.push(`missing_${section}_section`)
      continue
    }
    for (const key of Object.keys(defaults)) {
      if (!(key in sectionValue)) reasons.push(`missing_${section}.${key}`)
    }
  }
  if (isRecord(raw.position)) {
    const merged = mergeProgramDefaults(raw).position as unknown as Record<string, unknown>
    for (const key of KV_OWNED_POSITION_FIELDS) {
      if (!(key in raw.position)) reasons.push(`missing_position.${key}`)
      else if (!VALID_OWNED_POSITION_FIELD[key](raw.position[key], merged)) reasons.push(`invalid_position.${key}`)
    }
  }
  if (isRecord(raw.system) && typeof raw.system.killSwitch !== 'boolean') {
    reasons.push('missing_system.killSwitch_boolean')
  }
  return [...new Set(reasons)]
}

function cloneRiskConfig(cfg: RiskConfig): RiskConfig {
  return {
    system: { ...cfg.system },
    portfolio: structuredClone(cfg.portfolio),
    position: { ...cfg.position },
    order: { ...cfg.order },
  }
}

const RISK_CONFIG_KV_KEY = 'trading:risk_config'

export function normalizeRiskConfig(partial: unknown): RiskConfig {
  const cfg = cloneRiskConfig(failClosedOwnedFields(mergeProgramDefaults(isRecord(partial) ? partial : {})))
  // Same rule as getRiskConfig: without a portfolio object market risk is unavailable (admin view matches runtime).
  if (!isRecord(partial) || !isRecord(partial.portfolio)) cfg.portfolio = { ...cfg.portfolio, configUnavailable: true }
  return cfg
}

function runtimeKillSwitchFromRaw(raw: unknown): boolean {
  if (!isRecord(raw)) return true
  if (!isRecord(raw.system)) return true
  return typeof raw.system.killSwitch === 'boolean' ? raw.system.killSwitch : true
}

export async function buildRiskConfigRepairPlan(kv: KVNamespace | undefined): Promise<RiskConfigRepairPlan> {
  if (!kv) {
    return {
      key: RISK_CONFIG_KV_KEY,
      exists: false,
      source: 'error',
      effective: cloneRiskConfig(FAIL_CLOSED_RISK_CONFIG),
      seedConfig: mergeProgramDefaults({}),
      runtimeKillSwitchActive: true,
      complete: false,
      needsRepair: true,
      repairReasons: ['missing_kv_binding'],
      error: 'KV binding missing',
    }
  }
  try {
    const raw = await kv.get(RISK_CONFIG_KV_KEY, 'json')
    const exists = isRecord(raw)
    const repairReasons = collectMissingFields(raw)
    const complete = exists && repairReasons.length === 0
    // The seed never invents a KV-owned field; the effective view fails it closed.
    const seedConfig = cloneRiskConfig(mergeProgramDefaults(isRecord(raw) ? raw : {}))
    return {
      key: RISK_CONFIG_KV_KEY,
      exists,
      source: exists ? 'kv' : 'missing',
      effective: exists ? normalizeRiskConfig(raw) : cloneRiskConfig(FAIL_CLOSED_RISK_CONFIG),
      seedConfig,
      runtimeKillSwitchActive: runtimeKillSwitchFromRaw(raw),
      complete,
      needsRepair: !complete,
      repairReasons,
    }
  } catch (error: any) {
    return {
      key: RISK_CONFIG_KV_KEY,
      exists: false,
      source: 'error',
      effective: cloneRiskConfig(FAIL_CLOSED_RISK_CONFIG),
      seedConfig: mergeProgramDefaults({}),
      runtimeKillSwitchActive: true,
      complete: false,
      needsRepair: true,
      repairReasons: ['risk_config_read_error'],
      error: error?.message ?? String(error),
    }
  }
}

export async function seedRiskConfigDefaults(kv: KVNamespace | undefined): Promise<RiskConfigRepairPlan & { written: boolean }> {
  if (!kv) throw new Error('KV binding missing')
  const plan = await buildRiskConfigRepairPlan(kv)
  if (plan.source === 'error') throw new Error(plan.error ?? 'risk_config_read_error')
  if (!plan.needsRepair) return { ...plan, written: false }
  await kv.put(RISK_CONFIG_KV_KEY, JSON.stringify(plan.seedConfig))
  return { ...plan, written: true }
}

/** Audit only: risk fields the merged config takes from program defaults, not KV. */
export async function riskConfigFieldsFromDefault(kv: KVNamespace | undefined): Promise<string[]> {
  const raw = kv ? await kv.get(RISK_CONFIG_KV_KEY, 'json') : null
  return collectMissingFields(raw).filter(reason => /^missing_[a-z]+\.[A-Za-z0-9]+$/.test(reason))
    .map(reason => reason.slice('missing_'.length))
    .filter(field => !KV_OWNED_POSITION_FIELDS.some(key => field === `position.${key}`))
}

export async function getRiskConfig(kv: KVNamespace | undefined): Promise<RiskConfig> {
  if (!kv) {
    console.warn('[RiskConfig] KV binding missing, using fail-closed config')
    return cloneRiskConfig(FAIL_CLOSED_RISK_CONFIG)
  }
  try {
    const raw = await kv.get(RISK_CONFIG_KV_KEY, 'json')
    if (!isRecord(raw)) {
      console.warn('[RiskConfig] trading:risk_config missing, using fail-closed config')
      return cloneRiskConfig(FAIL_CLOSED_RISK_CONFIG)
    }
    const cfg = failClosedOwnedFields(mergeProgramDefaults(raw))
    // No portfolio object in KV: market-risk consumers must not score with program defaults.
    if (!isRecord(raw.portfolio)) {
      console.warn('[RiskConfig] trading:risk_config.portfolio missing or invalid, market risk fails closed')
      cfg.portfolio = { ...cfg.portfolio, configUnavailable: true }
    }
    return cfg
  } catch (e) {
    console.warn('[RiskConfig] getRiskConfig failed, using fail-closed config:', e)
    return cloneRiskConfig(FAIL_CLOSED_RISK_CONFIG)
  }
}

/** Kill switch fast-path: read ONLY the kill switch boolean without full merge. */
export async function isKillSwitchActive(kv: KVNamespace | undefined): Promise<boolean> {
  if (!kv) return true
  try {
    const raw = (await kv.get(RISK_CONFIG_KV_KEY, 'json')) as any
    if (!raw || typeof raw !== 'object') return true
    return typeof raw.system?.killSwitch === 'boolean' ? raw.system.killSwitch : true
  } catch {
    return true
  }
}

export { RISK_CONFIG_KV_KEY }

/** True for the fail-closed config returned when trading:risk_config is missing or unreadable. */
export function riskConfigUnavailable(cfg: Pick<RiskConfig, 'portfolio'> | null | undefined): boolean {
  return !cfg || cfg.portfolio?.configUnavailable === true
}

/**
 * Built-in policy used only while trading:risk_config is unavailable: the defaults, except chips scores the
 * pointwise maximum of the decided sign rule and main's old bands (< -250 / < -80 -> 85 / 65, > 120 -> 20), so a
 * de-risk decision is never looser than main's: < 0 -> 85, 0..120 -> 40, > 120 -> 20.
 */
const OUTAGE_SCORING_PORTFOLIO: RiskConfig['portfolio'] = {
  ...DEFAULT_RISK_CONFIG.portfolio,
  factorPacketPolicy: {
    ...DEFAULT_RISK_CONFIG.portfolio.factorPacketPolicy,
    chips: { bands: [{ op: '<', cut: 0, score: 85 }, { op: '<=', cut: 120, score: 40 }], otherwise: 20, warn: { op: '<', cut: 0 } },
  },
}

/**
 * The portfolio policy that scores market risk. When trading:risk_config is unavailable this is the built-in
 * defaults (what main hardcoded, chips at its most conservative), used only to keep de-risking existing
 * positions; anything that adds risk is blocked by the runtime's risk_config_unavailable blocker.
 */
export function riskScoringPolicy(policy: RiskConfig['portfolio']): RiskConfig['portfolio'] {
  return policy.configUnavailable === true ? OUTAGE_SCORING_PORTFOLIO : policy
}
