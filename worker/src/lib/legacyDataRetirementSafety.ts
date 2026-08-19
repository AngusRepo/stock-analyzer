export type LegacyRetirementCandidateKind =
  | 'mechanically_invalid_row'
  | 'superseded_version_row'
  | 'unknown'

export type LegacyRetirementImpactEvidence = {
  table: string
  kind: LegacyRetirementCandidateKind
  candidate_rows: number
  table_specific_invalidity_contract: boolean
  canonical_rejection_receipt: boolean
  target_parity_passed: boolean
  archive_checksum_verified: boolean
  runtime_reader_references: number
  foreign_key_references: number
  hard_lineage_references: number
  explicit_wei_approval: boolean
}

export function evaluateLegacyRetirementImpact(input: LegacyRetirementImpactEvidence) {
  const blockers: string[] = []
  if (input.candidate_rows <= 0) blockers.push('no_candidate_rows')
  if (!input.table_specific_invalidity_contract) blockers.push('table_specific_invalidity_contract_missing')
  if (!input.canonical_rejection_receipt) blockers.push('canonical_rejection_receipt_missing')
  if (!input.target_parity_passed) blockers.push('target_parity_not_passed')
  if (!input.archive_checksum_verified) blockers.push('archive_checksum_not_verified')
  if (input.runtime_reader_references !== 0) blockers.push('runtime_reader_references_present')
  if (input.foreign_key_references !== 0) blockers.push('foreign_key_references_present')
  if (input.hard_lineage_references !== 0) blockers.push('hard_lineage_references_present')
  if (!input.explicit_wei_approval) blockers.push('explicit_wei_approval_missing')

  if (input.kind === 'superseded_version_row') {
    return {
      table: input.table,
      kind: input.kind,
      action: 'archive_payload_keep_scalar_lineage' as const,
      row_delete_allowed: false,
      production_mutation_allowed: false,
      blockers: [...new Set(['version_lineage_must_be_preserved', ...blockers])],
    }
  }
  if (input.kind !== 'mechanically_invalid_row') blockers.push('candidate_kind_not_delete_eligible')
  return {
    table: input.table,
    kind: input.kind,
    action: blockers.length === 0
      ? 'eligible_for_separately_approved_bounded_delete' as const
      : 'preserve_and_quarantine' as const,
    row_delete_allowed: blockers.length === 0,
    production_mutation_allowed: false,
    blockers: [...new Set(blockers)],
  }
}

export const LEGACY_DATA_RETIREMENT_POLICY = {
  schema_version: 'legacy-data-retirement-safety-v1',
  mode: 'read_only_fail_closed',
  invalid_date_policy: 'table_specific_contract_and_zero_dependency_proof_required',
  superseded_version_policy: 'archive_payload_keep_scalar_lineage',
  broad_date_or_version_delete_allowed: false,
  automatic_delete: false,
} as const
