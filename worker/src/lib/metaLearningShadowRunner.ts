import type { Bindings } from '../types'
import {
  buildNeuralMetaBanditTrainingPayload,
  listLinUcbRewardSourceRows,
} from './metaLearningRewardLedger'
import {
  normalizeMetaShadowDecisionInput,
  persistMetaShadowDecisionRows,
  summarizeMetaShadowDecisionRows,
} from './metaLearningShadowDecisions'

export interface NeuralShadowRunOptions {
  policyId: 'NeuralUCB' | 'NeuralTS' | 'NeuCB'
  startDate?: string
  endDate?: string
  limit?: number
  dryRun?: boolean
  timeoutMs?: number
}

export async function runNeuralMetaShadow(env: Bindings, options: NeuralShadowRunOptions) {
  const mlUrl = env.ML_SERVICE_URL?.trim()?.replace(/\/+$/, '')
  if (!mlUrl) throw new Error('ML_SERVICE_URL not set; cannot run neural meta shadow')
  const rows = await listLinUcbRewardSourceRows(env.DB, {
    startDate: options.startDate,
    endDate: options.endDate,
    limit: options.limit ?? 5000,
  })
  const payload = buildNeuralMetaBanditTrainingPayload(options.policyId, rows, {
    businessDate: options.endDate,
    maxRows: options.limit,
  })
  if (payload.contexts.length < payload.arm_names.length * 2) {
    return {
      success: false,
      mode: options.dryRun === false ? 'persisted' : 'dry_run',
      policy_id: options.policyId,
      reason: 'insufficient_training_samples',
      source_rows: rows.length,
      training_samples: payload.contexts.length,
      min_required: payload.arm_names.length * 2,
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_SERVICE_SECRET) headers['X-Service-Token'] = env.ML_SERVICE_SECRET
  const response = await fetch(`${mlUrl}/meta-learning/neural-shadow/train`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(options.timeoutMs ?? 300_000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`ML service neural shadow HTTP ${response.status}: ${text.slice(0, 300)}`)
  }
  const result = await response.json() as Record<string, any>
  const normalized = normalizeMetaShadowDecisionInput({
    policy_id: options.policyId,
    decisions: result.shadow_decisions ?? [],
  })
  if (!normalized.ok) {
    return {
      success: false,
      mode: options.dryRun === false ? 'persisted' : 'dry_run',
      policy_id: options.policyId,
      error: 'invalid_shadow_decisions_from_ml_service',
      errors: normalized.errors,
      training_report: result.training_report,
    }
  }

  const dryRun = options.dryRun !== false
  const persisted = dryRun ? 0 : await persistMetaShadowDecisionRows(env.DB, normalized.rows)
  return {
    success: true,
    mode: dryRun ? 'dry_run' : 'persisted',
    policy_id: options.policyId,
    source_rows: rows.length,
    training_samples: payload.contexts.length,
    training_report: result.training_report,
    shadow_summary: summarizeMetaShadowDecisionRows(normalized.rows),
    persisted_rows: persisted,
  }
}
