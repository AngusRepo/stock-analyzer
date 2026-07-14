import { EXPECTED_FEATURE_COUNT, EXPECTED_STRATEGY_COUNT, SEARCH_POLICY } from './config'
import { UNKNOWN, type AuditIssue, type FeatureCard, type IssueVerdictRecord, type StrategyCandidate, type StrategyCard } from './domain'

export interface ValidationResult<T> { ok: boolean; value?: T; errors: string[] }

function objectValue(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => !stringValue(item))) return null
  return value.map((item) => String(item).trim())
}

function knownMetric(value: unknown): boolean {
  return value === UNKNOWN || (typeof value === 'number' && Number.isFinite(value))
}

export function validateFeatureCard(value: unknown): ValidationResult<FeatureCard> {
  const row = objectValue(value)
  const errors: string[] = []
  if (!row) return { ok: false, errors: ['feature_not_object'] }
  for (const key of ['feature_id', 'name', 'family']) if (!stringValue(row[key])) errors.push(`feature_${key}_required`)
  if (!(stringValue(row.definition) || row.definition === UNKNOWN)) errors.push('feature_definition_required_or_unknown')
  if (!stringArray(row.data_source)) errors.push('feature_data_source_invalid')
  for (const key of ['missing_rate', 'outlier_rate', 'turnover_proxy']) if (!knownMetric(row[key])) errors.push(`feature_${key}_invalid`)
  if (!objectValue(row.ic_summary)) errors.push('feature_ic_summary_invalid')
  return errors.length ? { ok: false, errors } : { ok: true, value: value as FeatureCard, errors }
}

export function validateStrategyCard(value: unknown): ValidationResult<StrategyCard> {
  const row = objectValue(value)
  const errors: string[] = []
  if (!row) return { ok: false, errors: ['strategy_not_object'] }
  for (const key of ['strategy_id', 'version', 'name', 'hypothesis']) if (!stringValue(row[key])) errors.push(`strategy_${key}_required`)
  for (const key of ['feature_ids', 'preferred_regimes', 'failure_regimes', 'known_failures', 'source_references']) {
    if (!stringArray(row[key])) errors.push(`strategy_${key}_invalid`)
  }
  if (!Array.isArray(row.entry_rules) || !Array.isArray(row.exit_rules)) errors.push('strategy_rules_invalid')
  return errors.length ? { ok: false, errors } : { ok: true, value: value as StrategyCard, errors }
}

export function validateFrozenInputCounts(features: FeatureCard[], strategies: StrategyCard[]): string[] {
  const errors: string[] = []
  if (features.length !== EXPECTED_FEATURE_COUNT) errors.push(`feature_count_mismatch:${features.length}:${EXPECTED_FEATURE_COUNT}`)
  if (strategies.length !== EXPECTED_STRATEGY_COUNT) errors.push(`strategy_count_mismatch:${strategies.length}:${EXPECTED_STRATEGY_COUNT}`)
  for (const [index, feature] of features.entries()) errors.push(...validateFeatureCard(feature).errors.map((e) => `feature[${index}]:${e}`))
  for (const [index, strategy] of strategies.entries()) errors.push(...validateStrategyCard(strategy).errors.map((e) => `strategy[${index}]:${e}`))
  return errors
}

export function validateCandidate(candidate: StrategyCandidate, knownFeatures: ReadonlySet<string>): string[] {
  const errors: string[] = []
  if (SEARCH_POLICY.allocation[candidate.search_mode] === 0) errors.push('mode_a_disabled')
  if (candidate.dsl.feature_ids.length < 1 || candidate.dsl.feature_ids.length > 3) errors.push('candidate_feature_limit')
  if (Object.keys(candidate.dsl.parameters).length > 3) errors.push('candidate_parameter_limit')
  if (candidate.dsl.lags.some((lag) => !Number.isInteger(lag) || lag < 0)) errors.push('candidate_negative_or_invalid_lag')
  for (const feature of candidate.dsl.feature_ids) if (!knownFeatures.has(feature)) errors.push(`candidate_unknown_feature:${feature}`)
  if (!candidate.dsl.signal_time || !candidate.dsl.execution_time) errors.push('candidate_timing_required')
  if (!candidate.dsl.exit_rules.length) errors.push('candidate_exit_required')
  if (!candidate.dsl.falsification_condition) errors.push('candidate_falsification_required')
  if (candidate.search_mode === 'MODE_B_PARENT_MUTATION' && (!candidate.parent_strategy_id || !candidate.mutation_type)) errors.push('parent_mutation_lineage_required')
  if (candidate.search_mode !== 'MODE_B_PARENT_MUTATION' && candidate.mutation_type != null) errors.push('mutation_type_only_allowed_for_mode_b')
  if (candidate.search_mode === 'MODE_D_REGIME_SPECIALIST' && (candidate.minimum_regime_samples === UNKNOWN || Number(candidate.minimum_regime_samples) <= 0)) errors.push('regime_sample_gate_failed')
  return errors
}

export function validateIssue(issue: AuditIssue): string[] {
  const errors: string[] = []
  if (!issue.issue_id || !issue.run_id || !issue.target_ids.length || !issue.claim) errors.push('issue_required_fields_missing')
  if (issue.critic_confidence < 0 || issue.critic_confidence > 1 || !Number.isFinite(issue.critic_confidence)) errors.push('issue_confidence_invalid')
  if (issue.evidence_level === 'E0' && issue.blocks_if_confirmed) errors.push('e0_cannot_be_formal_blocker')
  if (issue.evidence_level === 'E1' && issue.cross_exam_status === 'VALID_CLAIM') errors.push('e1_must_remain_unverified')
  return errors
}

export function validateIssueVerdict(verdict: IssueVerdictRecord, knownIssueIds: ReadonlySet<string>): string[] {
  const errors: string[] = []
  if (!knownIssueIds.has(verdict.issue_id)) errors.push(`unknown_issue:${verdict.issue_id}`)
  if (verdict.verdict === 'CONFIRMED' && verdict.severity === 'FATAL') {
    if (!['E2', 'E3', 'E4'].includes(verdict.evidence_level)) errors.push('confirmed_fatal_evidence_level')
    if (!verdict.evidence.length && !verdict.test_results.length) errors.push('confirmed_fatal_requires_file_or_test_evidence')
  }
  if (!verdict.evidence.length && !verdict.test_results.length && !['UNVERIFIED', 'REFUTED', 'NOT_APPLICABLE'].includes(verdict.verdict)) {
    errors.push('evidence_missing_requires_unverified')
  }
  return errors
}

export function parseJsonObject(bytes: Uint8Array, name: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new Error(`invalid_json:${name}`) }
  const object = objectValue(parsed)
  if (!object) throw new Error(`json_object_required:${name}`)
  return object
}
