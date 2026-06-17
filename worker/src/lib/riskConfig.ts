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

export const DEFAULT_RISK_CONFIG: RiskConfig = {
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
  },
  position: {
    maxPerSector: 2,
    maxSingleNamePct: 0.25,
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

/** Deep-merge user-supplied partial over defaults (one level deep per section). */
function deepMerge(defaults: RiskConfig, partial: any): RiskConfig {
  if (!partial || typeof partial !== 'object') return defaults
  return {
    system:    { ...defaults.system,    ...(partial.system    ?? {}) },
    portfolio: { ...defaults.portfolio, ...(partial.portfolio ?? {}) },
    position:  { ...defaults.position,  ...(partial.position  ?? {}) },
    order:     { ...defaults.order,     ...(partial.order     ?? {}) },
  }
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
  return cloneRiskConfig(deepMerge(DEFAULT_RISK_CONFIG, isRecord(partial) ? partial : {}))
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
      seedConfig: cloneRiskConfig(DEFAULT_RISK_CONFIG),
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
    const seedConfig = normalizeRiskConfig(raw)
    return {
      key: RISK_CONFIG_KV_KEY,
      exists,
      source: exists ? 'kv' : 'missing',
      effective: exists ? seedConfig : cloneRiskConfig(FAIL_CLOSED_RISK_CONFIG),
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
      seedConfig: cloneRiskConfig(DEFAULT_RISK_CONFIG),
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
    return deepMerge(DEFAULT_RISK_CONFIG, raw)
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
