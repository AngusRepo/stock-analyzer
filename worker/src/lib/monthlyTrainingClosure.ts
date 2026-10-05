import type { Bindings } from '../types'
import { controllerJson } from './controllerClient'

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, ordered(record[key])]))
  }
  return value
}

/** Monthly receipts carry no daily freshness or model-promotion credit. */
export async function verifyMonthlyTrainingClosure(env: Bindings, receipt: Record<string, unknown>,
  task: string, cadence: unknown, day: string, cohort: unknown) {
  if (task !== 'active8-oof-monthly' || cadence !== 'monthly'
    || !/^[a-f0-9]{64}$/.test(String(receipt.receipt_checksum ?? '')))
    throw new Error('monthly_training_closure_scope_invalid')
  const verified = await controllerJson<Record<string, unknown>>(env,
    `/l4_distribution/monthly-closure/${receipt.receipt_checksum}`, { timeoutMs: 120_000 })
  if (verified.schema_version !== 'l4-monthly-training-closure-v1' || verified.status !== 'complete'
    || verified.completion_scope !== 'monthly_training_candidate' || verified.as_of !== day
    || verified.cohort_id !== cohort || verified.daily_freshness_credit !== false
    || verified.promoted !== false || verified.promotion_allowed !== false
    || JSON.stringify(ordered(verified)) !== JSON.stringify(ordered(receipt)))
    throw new Error('monthly_training_closure_identity_mismatch')
  return verified
}
