import type { Bindings } from '../types'

export async function runDailyRecommendation(env: Bindings, runDate?: string | null) {
  const { runMLAndRiskV2 } = await import('./mlPipelineTrigger')
  return runMLAndRiskV2(env, runDate ?? undefined)
}

export async function runMarketScreener(env: Bindings, runDate?: string | null) {
  const { runBottomUpScreener } = await import('./marketScreener')
  return runBottomUpScreener(env, runDate)
}
