import { databaseForDataDomain } from './dataDomainRegistry'
export type Active8OofFreshnessStatus = 'fresh' | 'failed' | 'missing'

export interface Active8OofFreshnessAudit {
  status: Active8OofFreshnessStatus
  reason: string
  expectedMaxDate: string | null
  effectiveMaxDate: string | null
  cohortId: string | null
  prepManifestChecksum: string | null
}

function dateOrNull(value: unknown): string | null {
  const date = String(value ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
}

function textOrNull(value: unknown): string | null {
  const text = String(value ?? '').trim()
  return text || null
}

export function evaluateActive8OofFreshness(value: unknown): Active8OofFreshnessAudit {
  const evidence = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const expectedMaxDate = dateOrNull(evidence.expected_max_date)
  const effectiveMaxDate = dateOrNull(evidence.effective_max_date)
  const base = {
    expectedMaxDate,
    effectiveMaxDate,
    cohortId: textOrNull(evidence.cohort_id),
    prepManifestChecksum: textOrNull(evidence.prep_manifest_checksum),
  }
  if (!expectedMaxDate) {
    return { ...base, status: 'missing', reason: 'expected_mature_max_missing' }
  }
  if (!effectiveMaxDate) {
    return { ...base, status: 'missing', reason: 'effective_oof_max_missing' }
  }
  if (effectiveMaxDate < expectedMaxDate) {
    return { ...base, status: 'failed', reason: 'effective_oof_max_behind_immutable_prep' }
  }
  return { ...base, status: 'fresh', reason: 'effective_oof_max_reached_immutable_prep' }
}

export async function persistActive8OofFreshnessAudit(env: any, input: {
  task: string
  runId?: string
  attemptId?: string
  runDate?: string
  cadence?: string
  callbackStatus: string
  evidence: unknown
}): Promise<Active8OofFreshnessAudit> {
  const audit = evaluateActive8OofFreshness(input.evidence)
  const decisionKey = [
    input.task,
    input.runId || input.runDate || 'unknown-run',
    input.attemptId || 'unknown-attempt',
  ].join(':')
  await databaseForDataDomain(env, 'learning').prepare(`
    INSERT INTO active8_oof_freshness_sla (
      decision_key, task, run_id, attempt_id, run_date, cadence,
      status, reason, expected_max_date, effective_max_date,
      cohort_id, prep_manifest_checksum, callback_status, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(decision_key) DO UPDATE SET
      status=excluded.status,
      reason=excluded.reason,
      expected_max_date=excluded.expected_max_date,
      effective_max_date=excluded.effective_max_date,
      cohort_id=excluded.cohort_id,
      prep_manifest_checksum=excluded.prep_manifest_checksum,
      callback_status=excluded.callback_status,
      observed_at=CURRENT_TIMESTAMP
  `).bind(
    decisionKey,
    input.task,
    input.runId ?? null,
    input.attemptId ?? null,
    input.runDate ?? null,
    input.cadence ?? null,
    audit.status,
    audit.reason,
    audit.expectedMaxDate,
    audit.effectiveMaxDate,
    audit.cohortId,
    audit.prepManifestChecksum,
    input.callbackStatus,
  ).run()
  return audit
}
