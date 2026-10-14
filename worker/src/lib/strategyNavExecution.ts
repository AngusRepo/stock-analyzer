import type { Bindings } from '../types'
import { controllerPostJson } from './controllerClient'
import { twToday } from './dateUtils'
import { getTradingConfig } from './tradingConfig'
import { isSingleBMode } from './paperStrategyMode'

export async function strategyNavExecution(env: Bindings): Promise<string> {
  const config = await getTradingConfig(env.KV)
  if (!isSingleBMode(config.l4Distribution?.operating_mode)) {
    throw new Error('strategy_nav_requires_single_b')
  }
  const result = await controllerPostJson<{
    status: string; pairs: Array<{ status: string; journal?: unknown }>
    production_effect: boolean; promotion_allowed: boolean
  }>(env, '/paper/strategy-nav-execution-tick', { session_date: twToday() }, 280_000)
  if (result.production_effect !== false || result.promotion_allowed !== false || !Array.isArray(result.pairs)) {
    throw new Error('strategy_nav_execution_receipt_invalid')
  }
  if (result.status !== 'ok' || result.pairs.some(pair => pair.status === 'failed')) {
    throw new Error(`strategy_nav_execution_incomplete pairs=${result.pairs.length}`)
  }
  return `strategy_nav_execution_ok pairs=${result.pairs.length}; production_effect=false; promotion_allowed=false`
}
