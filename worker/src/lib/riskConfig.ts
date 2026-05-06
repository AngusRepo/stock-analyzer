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

const RISK_CONFIG_KV_KEY = 'trading:risk_config'

export async function getRiskConfig(kv: KVNamespace | undefined): Promise<RiskConfig> {
  if (!kv) return DEFAULT_RISK_CONFIG
  try {
    const raw = await kv.get(RISK_CONFIG_KV_KEY, 'json')
    return deepMerge(DEFAULT_RISK_CONFIG, raw)
  } catch (e) {
    console.warn('[RiskConfig] getRiskConfig failed, using defaults:', e)
    return DEFAULT_RISK_CONFIG
  }
}

/** Kill switch fast-path: read ONLY the kill switch boolean without full merge. */
export async function isKillSwitchActive(kv: KVNamespace | undefined): Promise<boolean> {
  if (!kv) return false
  try {
    const raw = (await kv.get(RISK_CONFIG_KV_KEY, 'json')) as any
    return Boolean(raw?.system?.killSwitch)
  } catch {
    return false
  }
}

export { RISK_CONFIG_KV_KEY }
