import type { Bindings } from '../types'
import { controllerPostJson } from './controllerClient'

export const IPO_COLLECTION_STATUS_KEY = 'ipo-shadow:collection-status:v1'
export async function collectIpoShadow(env: Bindings, signalDate: string, sourceRunId: string): Promise<string> {
  try {
    const result = await controllerPostJson<Record<string, any>>(env, '/l4_alpha_ev/ipo-shadow/freeze',
      { signal_date: signalDate, source_run_id: sourceRunId, dry_run: false, input_mode: 'frozen_stacker_prospective' }, 180_000)
    if (result.production_effect !== false || result.promotion_allowed !== false || result.training_dispatched !== false) {
      throw new Error('ipo_shadow_authority_contract_invalid')
    }
    if (result.status === 'historical_not_prospective') return `skipped: historical IPO replay date=${signalDate}; no prospective credit`
    await env.KV.put(IPO_COLLECTION_STATUS_KEY, JSON.stringify(result))
    if (!['frozen', 'already_frozen'].includes(result.status)) {
      throw new Error(`ipo_shadow_${result.status}:candidates=${result.candidate_rows ?? 0}:eligible=${result.eligible_rows ?? 0}:blockers=${(result.blockers ?? []).join(',')}`)
    }
    return `IPO frozen date=${signalDate} rows=${result.rows} production_effect=0`
  } catch (error) {
    // Preserve a structured input blocker above; transport errors must also be visible.
    if (!(error instanceof Error && /^ipo_shadow_awaiting_(native|shadow)_inputs/.test(error.message))) {
      await env.KV.put(IPO_COLLECTION_STATUS_KEY, JSON.stringify({signal_date:signalDate,
        observed_at:new Date().toISOString(),status:'collection_failed',blockers:[String(error).slice(0,500)],
        promotion_allowed:false,production_effect:false}))
    }
    throw error
  }
}
