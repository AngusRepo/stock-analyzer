/**
 * s1KillSwitch.ts — Level 1 S1: emergency halt (2026-04-21 R3)
 *
 * Read-only fast-path check against trading:risk_config.system.killSwitch.
 * Must be evaluated BEFORE every buy order in the live trading path.
 */
import { isKillSwitchActive } from '../riskConfig'
import type { CircuitBreakerState, LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'

export async function checkS1KillSwitch(
  kv: KVNamespace | undefined,
  deps: LegacyLayerDeps,
): Promise<LegacyLayerResult> {
  const active = await isKillSwitchActive(kv)
  if (!active) return null

  console.warn('[S1] Kill switch ACTIVE → halt all trading')
  const { defaults } = deps
  const state: CircuitBreakerState = {
    halt: true,
    reason: '【S1】Kill switch active (manual emergency stop)',
    maxPositionPct: 0,
    buyConfThreshold: Math.max(defaults.buyConfThreshold, 1.0),
    sellConfThreshold: defaults.sellConfThreshold,
  }
  return state
}
