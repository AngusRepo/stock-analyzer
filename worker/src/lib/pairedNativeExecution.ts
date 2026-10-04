import type { Bindings } from '../types'

/** Permanent compatibility response for paused schedules; configuration cannot revive them. */
export async function pairedNativeExecution(_env: Bindings): Promise<string> {
  return 'skipped: disabled_by_single_b_policy; paired_accounts_executed=0; history retained'
}
