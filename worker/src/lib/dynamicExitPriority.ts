/**
 * Runtime helper for regime-aware paper-exit priority.
 *
 * This module is wired through paperExitPolicy and paperMarketData, but remains
 * disabled by default until KV trading config enables dynamicExitPriorityEnabled.
 * It must not submit orders or bypass paper-exit guards.
 *
 * Each exit layer gets a priority score based on market regime:
 * - Volatile/bear markets tighten hard-stop and ATR trail handling.
 * - Sideways markets prioritize TP1 earlier.
 * - Bull markets give winners more room before trailing/profit-taking.
 */

export type MarketRegime = 'bull' | 'bear' | 'sideways' | 'volatile'

export interface ExitPriority {
  hardStop: number
  atrTrail: number
  mlSell: number
  tp1: number
  tp2: number
  timeStop: number
}

const REGIME_PRIORITIES: Record<MarketRegime, ExitPriority> = {
  bull: {
    hardStop: 1,
    atrTrail: 5,
    mlSell: 4,
    tp1: 6,
    tp2: 3,
    timeStop: 2,
  },
  bear: {
    hardStop: 1,
    atrTrail: 2,
    mlSell: 3,
    tp1: 4,
    tp2: 5,
    timeStop: 6,
  },
  sideways: {
    hardStop: 1,
    atrTrail: 4,
    mlSell: 5,
    tp1: 2,
    tp2: 3,
    timeStop: 6,
  },
  volatile: {
    hardStop: 1,
    atrTrail: 2,
    mlSell: 3,
    tp1: 4,
    tp2: 5,
    timeStop: 6,
  },
}

export function getExitOrder(regime: MarketRegime): string[] {
  const priorities = REGIME_PRIORITIES[regime] ?? REGIME_PRIORITIES.volatile
  return Object.entries(priorities)
    .sort(([, a], [, b]) => a - b)
    .map(([name]) => name)
}

export function getExitMultiplier(regime: MarketRegime, layer: keyof ExitPriority): number {
  const priorities = REGIME_PRIORITIES[regime] ?? REGIME_PRIORITIES.volatile
  const priority = priorities[layer]
  if (priority <= 2) return 1.2
  if (priority <= 4) return 1.0
  return 0.8
}
