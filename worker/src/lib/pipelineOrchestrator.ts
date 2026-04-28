import type { Bindings } from '../types'

export async function runDailyRecommendation(env: Bindings) {
  const { runMLAndRiskV2 } = await import('./mlPipelineTrigger')
  return runMLAndRiskV2(env)
}

export async function runMarketScreener(env: Bindings) {
  const { runBottomUpScreener } = await import('./marketScreener')
  return runBottomUpScreener(env)
}
