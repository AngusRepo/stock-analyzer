import type { ExpectedReturnOwner } from './expectedReturnServingState'

const EFFICACY: Record<ExpectedReturnOwner, Set<string>> = {
  l4_alpha_ev: new Set([
    'oos_date_cluster_corr_lcb90_not_positive',
    'oos_date_cluster_spread_lcb90_not_above_cost',
    'oos_top_quintile_return_not_positive',
    'oos_date_cluster_top_quintile_return_lcb90_not_positive',
    'walk_forward_not_stable',
    'walk_forward_no_valid_folds',
  ]),
  allocator_ev_fusion: new Set([
    'data_validity:date_count_below_validation_floor',
    'residual_adjustment:insufficient_dates',
    'residual_adjustment:oos_prediction_target_corr_lcb90_not_positive',
    'residual_adjustment:oos_top_bottom_spread_lcb90_not_economic',
    'residual_adjustment:walk_forward_not_stable',
    'residual_champion:residual_adjustment_model_not_validated',
  ]),
}

/** Shared by planning AND the authoritative pointer commit. No offline result is rewritten. */
export function expectedReturnOfflineAdmissionBlockers(
  owner: ExpectedReturnOwner,
  source: Record<string, any>,
  admission: Record<string, any>,
): string[] {
  const blockers: string[] = []
  const gates = source.failed_gates
  const admittedGates = admission.source_failed_gates
  if (!Array.isArray(gates) || gates.some((gate: unknown) => typeof gate !== 'string' || !gate.trim())
      || !Array.isArray(admittedGates) || admittedGates.some((gate: unknown) => typeof gate !== 'string')) {
    return ['offline_gate_evidence_invalid_shape']
  }
  if (admission.schema_version !== 'expected-return-offline-admission-v1') blockers.push('offline_admission_contract_incompatible')
  if (admission.decision !== 'PASS') blockers.push('offline_admission_not_pass')
  if (!Array.isArray(admission.hard_blockers) || admission.hard_blockers.length) blockers.push('offline_admission_has_hard_blockers')
  if (!['PASS', 'FAIL'].includes(source.decision)) blockers.push('offline_source_validation_not_terminal')
  if (source.decision !== admission.source_validation_decision) blockers.push('offline_admission_source_decision_mismatch')
  if (source.decision === 'PASS' && gates.length) blockers.push('offline_source_pass_with_failed_gates')
  if (source.decision === 'FAIL' && !gates.length) blockers.push('offline_source_failure_without_failed_gates')
  if (JSON.stringify([...gates].sort()) !== JSON.stringify([...admittedGates].sort())) blockers.push('offline_admission_source_mismatch')
  if (gates.some((gate: string) => !EFFICACY[owner].has(gate))) blockers.push('offline_admission_contains_non_efficacy_failure')
  return blockers
}

export function finiteExpectedReturnMetric(value: unknown): number | null {
  if (value == null || typeof value === 'boolean' || String(value).trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
