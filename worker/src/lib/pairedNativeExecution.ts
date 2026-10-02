import type { Bindings } from '../types'
import { controllerPostJson } from './controllerClient'
import { twToday } from './dateUtils'

/** Retired paired accounts must not wake Controller for the active single-B policy. */
export async function pairedNativeExecution(env: Bindings): Promise<string> {
  const config = await env.KV.get('trading:config', 'json') as {
    l4Distribution?: { operating_mode?: string; strategy_role?: string; scope?: string }
  } | null
  const policy = config?.l4Distribution
  if (policy?.operating_mode === 'single_b_tabpack_v1') {
    if (policy.strategy_role !== 'B' || policy.scope !== 'paper') throw Error('paired_native_single_b_policy_invalid')
    return 'skipped: disabled_by_single_b_policy; paired_accounts_executed=0; history retained'
  }
  const result = await controllerPostJson<{ status: string; pairs?: unknown[] }>(env,
    '/paper/native-execution-tick', { session_date: twToday() }, 240_000)
  // A policy transition during the HTTP request must be distinguished from an execution failure.
  if (result.status === 'disabled_by_single_b_policy') {
    const latest = await env.KV.get('trading:config', 'json') as typeof config
    if (latest?.l4Distribution?.operating_mode === 'single_b_tabpack_v1'
      && latest.l4Distribution.strategy_role === 'B' && latest.l4Distribution.scope === 'paper') {
      return 'skipped: disabled_by_single_b_policy; no paired execution authority'
    }
    throw Error('paired_native_disabled_receipt_policy_mismatch')
  }
  if (result.status !== 'ok' || !Array.isArray(result.pairs)) throw Error('paired_native_execution_tick_failed')
  return `paired_native_execution ${JSON.stringify(result)}`
}
