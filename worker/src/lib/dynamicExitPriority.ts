/**
 * dynamicExitPriority.ts — P2#26 7-Layer Exit Dynamic Priority
 *
 * Each exit layer gets a priority score based on market regime:
 *   High vol → hard stop highest priority
 *   Trending → trailing highest
 *   Sideways → TP1 partial highest
 *
 * Priority scores can be searched by Optuna per-regime.
 */

export type MarketRegime = 'bull' | 'bear' | 'sideways' | 'volatile'

export interface ExitPriority {
  hardStop: number      // layer 1
  atrTrail: number      // layer 2+4
  mlSell: number        // layer 3
  tp1: number           // layer 5
  tp2: number           // layer 6
  timeStop: number      // layer 7
}

/**
 * Default priority matrices per regime.
 * Higher priority = checked first (lower number = earlier in cascade).
 * Values are evaluation order (1 = first, 6 = last).
 */
const REGIME_PRIORITIES: Record<MarketRegime, ExitPriority> = {
  bull: {
    hardStop: 1,    // always check first
    atrTrail: 5,    // let winners run
    mlSell: 4,
    tp1: 6,         // delay profit taking in bull
    tp2: 3,
    timeStop: 2,
  },
  bear: {
    hardStop: 1,
    atrTrail: 2,    // tight stops in bear
    mlSell: 3,
    tp1: 4,         // take profits early
    tp2: 5,
    timeStop: 6,
  },
  sideways: {
    hardStop: 1,
    atrTrail: 4,
    mlSell: 5,
    tp1: 2,         // take TP1 aggressively in sideways
    tp2: 3,
    timeStop: 6,
  },
  volatile: {
    hardStop: 1,    // always first in volatile
    atrTrail: 2,    // tight trailing
    mlSell: 3,
    tp1: 4,
    tp2: 5,
    timeStop: 6,
  },
}

/**
 * Get exit layer evaluation order based on current market regime.
 * Returns array of layer names sorted by priority (highest first).
 */
export function getExitOrder(regime: MarketRegime): string[] {
  const priorities = REGIME_PRIORITIES[regime] ?? REGIME_PRIORITIES.volatile
  return Object.entries(priorities)
    .sort(([, a], [, b]) => a - b)
    .map(([name]) => name)
}

/**
 * Get priority multiplier for a specific exit layer in current regime.
 * Used to adjust exit aggressiveness:
 *   priority 1-2 → multiplier 1.2 (more aggressive)
 *   priority 3-4 → multiplier 1.0 (normal)
 *   priority 5-6 → multiplier 0.8 (less aggressive)
 */
export function getExitMultiplier(regime: MarketRegime, layer: keyof ExitPriority): number {
  const priorities = REGIME_PRIORITIES[regime] ?? REGIME_PRIORITIES.volatile
  const p = priorities[layer]
  if (p <= 2) return 1.2
  if (p <= 4) return 1.0
  return 0.8
}
