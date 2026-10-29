/**
 * riskConfig.ts — #20/#26 R3 (2026-04-21)
 *
 * Independent KV key `trading:risk_config` (separate from `trading:config`)
 * per design doc: kill switch must be updatable in < 1 sec, can't share KV
 * with 200+ strategy params.
 *
 * Defaults chosen conservatively — user will tune via KV / dashboard.
 */

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
    blackTargetExposure: number
  }
  position: {
    maxPerSector: number                    // N1: max holdings per sector
    maxSingleNamePct: number                // N2: fraction of portfolio
    correlationThreshold: number            // N3: pairwise 60d return corr
    correlationWindow: number               // trading days
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

// K16a: KV is the only owner of these fields. They have no program default:
// a missing or invalid value fails closed at runtime and is never seeded.
const KV_OWNED_POSITION_FIELDS = ['maxSingleNamePct'] as const
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
  system: {
    ...DEFAULT_RISK_CONFIG.system,
    killSwitch: true,
    haltOnProxyFailure: true,
  },
  position: {
    ...DEFAULT_RISK_CONFIG.position,
    maxSingleNamePct: 0,
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

/**
 * Deep-merge user-supplied partial over program defaults (one level deep per section).
 * KV-owned fields are carried only when the partial has them; nothing fills them in.
 */
function mergeProgramDefaults(partial: any): RiskConfig {
  const raw = partial && typeof partial === 'object' ? partial : {}
  return {
    system:    { ...DEFAULT_RISK_CONFIG.system,    ...(raw.system    ?? {}) },
    portfolio: { ...DEFAULT_RISK_CONFIG.portfolio, ...(raw.portfolio ?? {}) },
    position:  { ...DEFAULT_RISK_CONFIG.position,  ...(raw.position  ?? {}) } as RiskConfig['position'],
    order:     { ...DEFAULT_RISK_CONFIG.order,     ...(raw.order     ?? {}) },
  }
}

function validSingleNameCap(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** Runtime view: a missing or invalid single-name cap means no new single-name exposure. */
function failClosedOwnedFields(cfg: RiskConfig): RiskConfig {
  if (validSingleNameCap(cfg.position.maxSingleNamePct)) return cfg
  console.warn('[RiskConfig] trading:risk_config.position.maxSingleNamePct missing or invalid, single-name cap fails closed to 0')
  return { ...cfg, position: { ...cfg.position, maxSingleNamePct: 0 } }
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
    for (const key of KV_OWNED_POSITION_FIELDS) {
      if (!(key in raw.position)) reasons.push(`missing_position.${key}`)
      else if (!validSingleNameCap(raw.position[key])) reasons.push(`invalid_position.${key}`)
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
    portfolio: { ...cfg.portfolio },
    position: { ...cfg.position },
    order: { ...cfg.order },
  }
}

const RISK_CONFIG_KV_KEY = 'trading:risk_config'

export function normalizeRiskConfig(partial: unknown): RiskConfig {
  return cloneRiskConfig(failClosedOwnedFields(mergeProgramDefaults(isRecord(partial) ? partial : {})))
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
    if (!raw || typeof raw !== 'object') {
      console.warn('[RiskConfig] trading:risk_config missing, using fail-closed config')
      return cloneRiskConfig(FAIL_CLOSED_RISK_CONFIG)
    }
    return failClosedOwnedFields(mergeProgramDefaults(raw))
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
