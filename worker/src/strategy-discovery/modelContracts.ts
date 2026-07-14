import type { AuditIssue, StrategyCandidate, StrategyHypothesis } from './domain'
import type { JsonSchemaDefinition } from './workersAiClient'

export interface FeatureMapOutput {
  summary: string
  cluster_observations: Array<{ cluster_id: string; summary: string; duplicate_feature_ids: string[]; coverage_gaps: string[] }>
  limitations: string[]
}
export interface RegimeHypothesisSuggestion {
  hypothesis: string
  economic_mechanism: string
  portfolio_gap: string
  preferred_regime: string
  feature_ids: string[]
  falsification_condition: string
}

export interface ShortlistOutput { shortlist_ids: string[]; issues: AuditIssue[]; rationale: string }
export interface IssueBatchOutput { issues: AuditIssue[] }
export interface CrossExaminationOutput {
  assessments: Array<{ issue_id: string; status: AuditIssue['cross_exam_status']; severity_if_true: AuditIssue['severity_if_true']; missing_evidence: string[]; duplicate_of: string | null }>
}
export interface PrivacyIssue {
  target_scope: 'CANDIDATE' | 'SYSTEM'
  target_refs: string[]
  category: string
  claim: string
  attack_mechanism: string
  missing_evidence: string[]
  severity_if_true: AuditIssue['severity_if_true']
  critic_confidence: number
  falsification_tests: string[]
  blocks_if_confirmed: boolean
}
export interface PrivacyShortlistOutput { shortlist_refs: string[]; issues: PrivacyIssue[]; rationale: string }
export interface PrivacyIssueBatchOutput { issues: PrivacyIssue[] }
export interface PrivacyCrossExaminationOutput {
  assessments: Array<{ issue_ref: string; status: AuditIssue['cross_exam_status']; severity_if_true: AuditIssue['severity_if_true']; missing_evidence: string[]; duplicate_of_ref: string | null }>
}

const stringArray = { type: 'array', items: { type: 'string' } }
const issueSchema = {
  type: 'object', additionalProperties: false,
  required: ['issue_id', 'run_id', 'target_type', 'target_ids', 'category', 'claim', 'attack_mechanism', 'observed_evidence', 'missing_evidence', 'severity_if_true', 'evidence_level', 'critic_model', 'critic_confidence', 'falsification_test', 'blocks_if_confirmed', 'cross_exam_status', 'duplicate_of'],
  properties: {
    issue_id: { type: 'string' }, run_id: { type: 'string' }, target_type: { enum: ['STRATEGY', 'CANDIDATE', 'SYSTEM'] },
    target_ids: stringArray, category: { type: 'string' }, claim: { type: 'string' }, attack_mechanism: { type: 'string' },
    observed_evidence: { type: 'array' }, missing_evidence: stringArray,
    severity_if_true: { enum: ['FATAL', 'MAJOR', 'MINOR', 'INFO'] }, evidence_level: { enum: ['E0', 'E1'] },
    critic_model: { type: 'string' }, critic_confidence: { type: 'number', minimum: 0, maximum: 1 }, falsification_test: { type: 'object' },
    blocks_if_confirmed: { type: 'boolean' }, cross_exam_status: { enum: ['VALID_CLAIM', 'POSSIBLE_BUT_UNVERIFIED', 'OVERSTATED', 'DUPLICATE', 'NOT_APPLICABLE', 'UNSUBSTANTIATED'] },
    duplicate_of: { type: ['string', 'null'] },
  },
}

const privacyIssueSchema = {
  type: 'object', additionalProperties: false,
  required: ['target_scope', 'target_refs', 'category', 'claim', 'attack_mechanism', 'missing_evidence', 'severity_if_true', 'critic_confidence', 'falsification_tests', 'blocks_if_confirmed'],
  properties: {
    target_scope: { enum: ['CANDIDATE', 'SYSTEM'] }, target_refs: { ...stringArray, maxItems: 5 },
    category: { type: 'string', maxLength: 80 }, claim: { type: 'string', maxLength: 500 }, attack_mechanism: { type: 'string', maxLength: 300 },
    missing_evidence: { ...stringArray, maxItems: 8 }, severity_if_true: { enum: ['FATAL', 'MAJOR', 'MINOR', 'INFO'] },
    critic_confidence: { type: 'number', minimum: 0, maximum: 1 }, falsification_tests: { ...stringArray, maxItems: 8 }, blocks_if_confirmed: { type: 'boolean' },
  },
}

const hypothesisSchema = {
  type: 'object', additionalProperties: false,
  required: ['search_mode', 'parent_strategy_id', 'mutation_type', 'hypothesis', 'economic_mechanism', 'portfolio_gap', 'preferred_regimes', 'feature_ids', 'falsification_condition'],
  properties: {
    search_mode: { enum: ['MODE_B_PARENT_MUTATION', 'MODE_C_PORTFOLIO_GAP', 'MODE_D_REGIME_SPECIALIST'] },
    parent_strategy_id: { type: ['string', 'null'] }, mutation_type: { enum: ['ADD_GATE', 'REPLACE_FEATURE', 'SIMPLIFY_RULE', 'MODIFY_EXIT', 'REDUCE_TURNOVER', 'NEUTRALIZE_EXPOSURE', null] },
    hypothesis: { type: 'string', maxLength: 280 }, economic_mechanism: { type: 'string', maxLength: 240 }, portfolio_gap: { type: 'string', maxLength: 160 },
    preferred_regimes: { ...stringArray, maxItems: 2 }, feature_ids: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
    falsification_condition: { type: 'string', maxLength: 240 },
  },
}

const compactSuggestionProperties = {
  hypothesis: { type: 'string', maxLength: 280 }, economic_mechanism: { type: 'string', maxLength: 240 },
  portfolio_gap: { type: 'string', maxLength: 160 }, preferred_regimes: { ...stringArray, maxItems: 2 },
  feature_ids: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
  falsification_condition: { type: 'string', maxLength: 240 },
}
const compactSuggestionRequired = ['hypothesis', 'economic_mechanism', 'portfolio_gap', 'preferred_regimes', 'feature_ids', 'falsification_condition']

const candidateSchema = {
  type: 'object', additionalProperties: false,
  required: ['candidate_id', 'run_id', 'search_mode', 'parent_strategy_id', 'mutation_type', 'hypothesis', 'economic_mechanism', 'portfolio_gap', 'preferred_regimes', 'minimum_regime_samples', 'dsl', 'candidate_hash', 'source_model', 'source_type'],
  properties: {
    candidate_id: { type: 'string' }, run_id: { type: 'string' }, search_mode: hypothesisSchema.properties.search_mode,
    parent_strategy_id: { type: ['string', 'null'] }, mutation_type: hypothesisSchema.properties.mutation_type,
    hypothesis: { type: 'string' }, economic_mechanism: { type: 'string' }, portfolio_gap: { type: 'string' }, preferred_regimes: stringArray,
    minimum_regime_samples: { anyOf: [{ type: 'integer', minimum: 1 }, { const: 'UNKNOWN' }] },
    dsl: { type: 'object', additionalProperties: false, required: ['feature_ids', 'parameters', 'regime_gate', 'entry_rules', 'exit_rules', 'signal_time', 'execution_time', 'falsification_condition', 'lags'], properties: {
      feature_ids: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } }, parameters: { type: 'object', maxProperties: 3 }, regime_gate: { type: ['object', 'null'] },
      entry_rules: { type: 'array', minItems: 1 }, exit_rules: { type: 'array', minItems: 1 }, signal_time: { type: 'string' }, execution_time: { type: 'string' }, falsification_condition: { type: 'string' }, lags: { type: 'array', items: { type: 'integer', minimum: 0 } },
    } },
    candidate_hash: { type: 'string' }, source_model: { type: 'string' }, source_type: { enum: ['REAL', 'FIXTURE'] },
  },
}

export const MODEL_OUTPUT_SCHEMAS: Record<string, JsonSchemaDefinition> = {
  availability: { name: 'availability', schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { const: 'OK' } } } },
  feature_map: { name: 'feature_map', schema: { type: 'object', additionalProperties: false, required: ['summary', 'cluster_observations', 'limitations'], properties: { summary: { type: 'string', maxLength: 400 }, cluster_observations: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['cluster_id', 'summary', 'duplicate_feature_ids', 'coverage_gaps'], properties: { cluster_id: { type: 'string' }, summary: { type: 'string', maxLength: 240 }, duplicate_feature_ids: { ...stringArray, maxItems: 5 }, coverage_gaps: { ...stringArray, maxItems: 5 } } } }, limitations: { ...stringArray, maxItems: 6 } } } },
  hypotheses: { name: 'hypotheses', schema: { type: 'object', additionalProperties: false, required: ['hypotheses'], properties: { hypotheses: { type: 'array', minItems: 2, maxItems: 10, items: hypothesisSchema } } } },
  mode_c_hypotheses: { name: 'mode_c_hypotheses', schema: { type: 'object', additionalProperties: false, required: ['hypotheses'], properties: { hypotheses: { type: 'array', minItems: 6, maxItems: 6,
    items: { type: 'object', additionalProperties: false, required: compactSuggestionRequired, properties: compactSuggestionProperties } } } } },
  mode_b_hypotheses: { name: 'mode_b_hypotheses', schema: { type: 'object', additionalProperties: false, required: ['hypotheses'], properties: { hypotheses: { type: 'array', minItems: 4, maxItems: 4,
    items: { type: 'object', additionalProperties: false, required: [...compactSuggestionRequired, 'parent_strategy_id', 'mutation_type'], properties: {
      ...compactSuggestionProperties, parent_strategy_id: { type: 'string' },
      mutation_type: { enum: ['ADD_GATE', 'REPLACE_FEATURE', 'SIMPLIFY_RULE', 'MODIFY_EXIT', 'REDUCE_TURNOVER', 'NEUTRALIZE_EXPOSURE'] },
    } } } } } },
  single_hypothesis: { name: 'single_hypothesis', schema: { type: 'object', additionalProperties: false,
    required: ['hypothesis', 'economic_mechanism', 'portfolio_gap', 'preferred_regimes', 'falsification_condition'], properties: {
      hypothesis: { type: 'string', maxLength: 280 }, economic_mechanism: { type: 'string', maxLength: 240 },
      portfolio_gap: { type: 'string', maxLength: 160 }, preferred_regimes: { ...stringArray, maxItems: 2 },
      falsification_condition: { type: 'string', maxLength: 240 },
    } } },
  single_dsl: { name: 'single_dsl', schema: { type: 'object', additionalProperties: false,
    required: ['feature_ids', 'parameters', 'regime_gate', 'entry_rules', 'exit_rules', 'signal_time', 'execution_time', 'falsification_condition', 'lags'], properties: {
      feature_ids: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } }, parameters: { type: 'object', maxProperties: 3 },
      regime_gate: { type: ['object', 'null'] }, entry_rules: { type: 'array', minItems: 1, maxItems: 4 }, exit_rules: { type: 'array', minItems: 1, maxItems: 4 },
      signal_time: { type: 'string' }, execution_time: { type: 'string' }, falsification_condition: { type: 'string', maxLength: 240 },
      lags: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'integer', minimum: 0 } },
    } } },
  regime_hypotheses: { name: 'regime_hypotheses', schema: { type: 'object', additionalProperties: false, required: ['hypotheses'], properties: { hypotheses: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'object', additionalProperties: false,
    required: ['hypothesis', 'economic_mechanism', 'portfolio_gap', 'preferred_regime', 'feature_ids', 'falsification_condition'], properties: {
      hypothesis: { type: 'string', maxLength: 280 }, economic_mechanism: { type: 'string', maxLength: 240 }, portfolio_gap: { type: 'string', maxLength: 160 },
      preferred_regime: { enum: ['bull', 'bear', 'volatile', 'sideways'] }, feature_ids: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
      falsification_condition: { type: 'string', maxLength: 240 },
    } } } } } },
  candidates: { name: 'candidates', schema: { type: 'object', additionalProperties: false, required: ['candidates'], properties: { candidates: { type: 'array', items: candidateSchema } } } },
  shortlist: { name: 'shortlist', schema: { type: 'object', additionalProperties: false, required: ['shortlist_ids', 'issues', 'rationale'], properties: { shortlist_ids: { type: 'array', maxItems: 5, items: { type: 'string' } }, issues: { type: 'array', items: issueSchema }, rationale: { type: 'string' } } } },
  issues: { name: 'issues', schema: { type: 'object', additionalProperties: false, required: ['issues'], properties: { issues: { type: 'array', items: issueSchema } } } },
  cross_examination: { name: 'cross_examination', schema: { type: 'object', additionalProperties: false, required: ['assessments'], properties: { assessments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['issue_id', 'status', 'severity_if_true', 'missing_evidence', 'duplicate_of'], properties: { issue_id: { type: 'string' }, status: { enum: ['VALID_CLAIM', 'POSSIBLE_BUT_UNVERIFIED', 'OVERSTATED', 'DUPLICATE', 'NOT_APPLICABLE', 'UNSUBSTANTIATED'] }, severity_if_true: { enum: ['FATAL', 'MAJOR', 'MINOR', 'INFO'] }, missing_evidence: stringArray, duplicate_of: { type: ['string', 'null'] } } } } } } },
  privacy_shortlist: { name: 'privacy_shortlist', schema: { type: 'object', additionalProperties: false, required: ['shortlist_refs', 'issues', 'rationale'], properties: {
    shortlist_refs: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } }, issues: { type: 'array', maxItems: 10, items: privacyIssueSchema }, rationale: { type: 'string', maxLength: 500 },
  } } },
  privacy_issues: { name: 'privacy_issues', schema: { type: 'object', additionalProperties: false, required: ['issues'], properties: { issues: { type: 'array', maxItems: 12, items: privacyIssueSchema } } } },
  privacy_cross_examination: { name: 'privacy_cross_examination', schema: { type: 'object', additionalProperties: false, required: ['assessments'], properties: { assessments: { type: 'array', minItems: 1, maxItems: 3, items: {
    type: 'object', additionalProperties: false, required: ['issue_ref', 'status', 'severity_if_true', 'missing_evidence', 'duplicate_of_ref'], properties: {
      issue_ref: { type: 'string' }, status: { enum: ['VALID_CLAIM', 'POSSIBLE_BUT_UNVERIFIED', 'OVERSTATED', 'DUPLICATE', 'NOT_APPLICABLE', 'UNSUBSTANTIATED'] },
      severity_if_true: { enum: ['FATAL', 'MAJOR', 'MINOR', 'INFO'] }, missing_evidence: { ...stringArray, maxItems: 8 }, duplicate_of_ref: { type: ['string', 'null'] },
    },
  } } } } },
}

export function validateAvailability(value: unknown) {
  return object(value)?.ok === 'OK' ? { ok: true, value: { ok: 'OK' as const }, errors: [] } : { ok: false, errors: ['availability_probe_invalid'] }
}

function object(value: unknown): Record<string, any> | null { return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null }
function array(value: unknown): any[] | null { return Array.isArray(value) ? value : null }
function nonempty(value: unknown): boolean { return typeof value === 'string' && value.trim().length > 0 }

export function validateFeatureMap(value: unknown) {
  const row = object(value); const observations = array(row?.cluster_observations); const limitations = array(row?.limitations)
  const ok = Boolean(row && nonempty(row.summary) && observations && limitations && limitations.every(nonempty) && observations.every((item) => nonempty(object(item)?.cluster_id) && nonempty(object(item)?.summary)))
  return ok ? { ok: true, value: value as FeatureMapOutput, errors: [] } : { ok: false, errors: ['feature_map_invalid'] }
}

export function validateHypothesisOutput(value: unknown) {
  const rows = array(object(value)?.hypotheses)
  const ok = Boolean(rows && rows.length >= 2 && rows.length <= 10 && rows.every((item) => {
    const row = object(item)
    return row && ['MODE_B_PARENT_MUTATION', 'MODE_C_PORTFOLIO_GAP', 'MODE_D_REGIME_SPECIALIST'].includes(row.search_mode)
      && nonempty(row.hypothesis) && typeof row.economic_mechanism === 'string' && typeof row.portfolio_gap === 'string'
      && typeof row.falsification_condition === 'string' && Array.isArray(row.feature_ids) && row.feature_ids.length >= 1 && row.feature_ids.length <= 3
      && Array.isArray(row.preferred_regimes)
  }))
  return ok ? { ok: true, value: { hypotheses: rows!.map((item) => ({ ...item,
    economic_mechanism: item.economic_mechanism.trim() || 'UNKNOWN', portfolio_gap: item.portfolio_gap.trim() || 'UNKNOWN',
    falsification_condition: item.falsification_condition.trim() || 'UNKNOWN',
  })) as StrategyHypothesis[] }, errors: [] } : { ok: false, errors: ['hypotheses_invalid'] }
}

export function validateRegimeHypothesisOutput(value: unknown) {
  const rows = array(object(value)?.hypotheses)
  const ok = Boolean(rows && rows.length === 2 && rows.every((item) => {
    const row = object(item)
    return row && nonempty(row.hypothesis) && typeof row.economic_mechanism === 'string' && typeof row.portfolio_gap === 'string'
      && ['bull', 'bear', 'volatile', 'sideways'].includes(row.preferred_regime)
      && Array.isArray(row.feature_ids) && row.feature_ids.length >= 1 && row.feature_ids.length <= 3
      && typeof row.falsification_condition === 'string'
  }))
  return ok ? { ok: true, value: { hypotheses: rows!.map((item) => ({ ...item,
    economic_mechanism: item.economic_mechanism.trim() || 'UNKNOWN', portfolio_gap: item.portfolio_gap.trim() || 'UNKNOWN',
    falsification_condition: item.falsification_condition.trim() || 'UNKNOWN',
  })) as RegimeHypothesisSuggestion[] }, errors: [] } : { ok: false, errors: ['regime_hypotheses_invalid'] }
}

function validateCompactSuggestions(value: unknown, count: number, requireParent: boolean) {
  const rows = array(object(value)?.hypotheses)
  if (!rows || rows.length !== count) return { ok: false, errors: ['compact_hypotheses_count_invalid'] }
  const normalized = rows.map((item) => {
    const row = object(item)
    const hypothesis = row?.hypothesis ?? row?.description
    if (!row || !nonempty(hypothesis) || typeof row.economic_mechanism !== 'string' || typeof row.portfolio_gap !== 'string'
      || typeof row.falsification_condition !== 'string' || !Array.isArray(row.preferred_regimes)
      || !Array.isArray(row.feature_ids) || row.feature_ids.length < 1 || row.feature_ids.length > 3
      || (requireParent && (!nonempty(row.parent_strategy_id) || !nonempty(row.mutation_type)))) return null
    return {
      hypothesis: String(hypothesis), economic_mechanism: row.economic_mechanism.trim() || 'UNKNOWN',
      portfolio_gap: row.portfolio_gap.trim() || 'UNKNOWN', preferred_regimes: row.preferred_regimes,
      feature_ids: row.feature_ids, falsification_condition: row.falsification_condition.trim() || 'UNKNOWN',
      ...(requireParent ? { parent_strategy_id: row.parent_strategy_id, mutation_type: row.mutation_type } : {}),
    }
  })
  return normalized.every(Boolean) ? { ok: true, value: { hypotheses: normalized }, errors: [] } : { ok: false, errors: ['compact_hypotheses_invalid'] }
}

export function validateModeCHypotheses(value: unknown) { return validateCompactSuggestions(value, 6, false) }
export function validateModeBHypotheses(value: unknown) { return validateCompactSuggestions(value, 4, true) }

export function validateSingleHypothesis(value: unknown) {
  const row = object(value)
  const hypothesis = row?.hypothesis ?? row?.description
  const ok = Boolean(row && nonempty(hypothesis) && typeof row.economic_mechanism === 'string' && typeof row.portfolio_gap === 'string'
    && Array.isArray(row.preferred_regimes) && typeof row.falsification_condition === 'string')
  return ok ? { ok: true, value: { hypothesis: String(hypothesis), economic_mechanism: row!.economic_mechanism.trim() || 'UNKNOWN',
    portfolio_gap: row!.portfolio_gap.trim() || 'UNKNOWN', preferred_regimes: row!.preferred_regimes,
    falsification_condition: row!.falsification_condition.trim() || 'UNKNOWN' }, errors: [] } : { ok: false, errors: ['single_hypothesis_invalid'] }
}

export function validateSingleDsl(value: unknown) {
  const row = object(value)
  const ok = Boolean(row && Array.isArray(row.feature_ids) && row.feature_ids.length >= 1 && row.feature_ids.length <= 3
    && object(row.parameters) && Object.keys(row.parameters).length <= 3 && Array.isArray(row.entry_rules) && row.entry_rules.length >= 1
    && Array.isArray(row.exit_rules) && row.exit_rules.length >= 1 && nonempty(row.signal_time) && nonempty(row.execution_time)
    && nonempty(row.falsification_condition) && Array.isArray(row.lags) && row.lags.every((lag: unknown) => Number.isInteger(lag) && Number(lag) >= 0))
  return ok ? { ok: true, value: row, errors: [] } : { ok: false, errors: ['single_dsl_invalid'] }
}

export function validateCandidateOutput(value: unknown) {
  const rows = array(object(value)?.candidates)
  const ok = Boolean(rows && rows.every((item) => { const row = object(item); const dsl = object(row?.dsl); return row && dsl && nonempty(row.candidate_id) && Array.isArray(dsl.feature_ids) && Array.isArray(dsl.exit_rules) && nonempty(dsl.signal_time) && nonempty(dsl.execution_time) }))
  return ok ? { ok: true, value: { candidates: rows as StrategyCandidate[] }, errors: [] } : { ok: false, errors: ['candidates_invalid'] }
}

function validIssue(item: unknown): item is AuditIssue {
  const row = object(item)
  return Boolean(row && nonempty(row.issue_id) && nonempty(row.run_id) && Array.isArray(row.target_ids) && row.target_ids.length && nonempty(row.claim) && ['E0', 'E1'].includes(row.evidence_level) && Number.isFinite(row.critic_confidence))
}

export function validateShortlistOutput(value: unknown) {
  const row = object(value); const ids = array(row?.shortlist_ids); const issues = array(row?.issues)
  const ok = Boolean(row && ids && ids.length <= 5 && ids.every(nonempty) && issues && issues.every(validIssue) && nonempty(row.rationale))
  return ok ? { ok: true, value: value as ShortlistOutput, errors: [] } : { ok: false, errors: ['shortlist_invalid'] }
}

export function validateIssueBatch(value: unknown) {
  const issues = array(object(value)?.issues)
  return issues && issues.every(validIssue) ? { ok: true, value: { issues } as IssueBatchOutput, errors: [] } : { ok: false, errors: ['issue_batch_invalid'] }
}

export function validateCrossExamination(value: unknown) {
  const assessments = array(object(value)?.assessments)
  const ok = Boolean(assessments && assessments.every((item) => { const row = object(item); return row && nonempty(row.issue_id) && nonempty(row.status) && Array.isArray(row.missing_evidence) }))
  return ok ? { ok: true, value: { assessments } as CrossExaminationOutput, errors: [] } : { ok: false, errors: ['cross_examination_invalid'] }
}

function validPrivacyIssue(item: unknown): item is PrivacyIssue {
  const row = object(item)
  return Boolean(row && ['CANDIDATE', 'SYSTEM'].includes(row.target_scope) && Array.isArray(row.target_refs)
    && (row.target_scope === 'SYSTEM' || row.target_refs.length > 0) && nonempty(row.category) && nonempty(row.claim)
    && nonempty(row.attack_mechanism) && Array.isArray(row.missing_evidence) && Array.isArray(row.falsification_tests)
    && ['FATAL', 'MAJOR', 'MINOR', 'INFO'].includes(row.severity_if_true) && Number.isFinite(row.critic_confidence)
    && row.critic_confidence >= 0 && row.critic_confidence <= 1 && typeof row.blocks_if_confirmed === 'boolean')
}

export function validatePrivacyShortlist(value: unknown) {
  const row = object(value); const refs = array(row?.shortlist_refs); const issues = array(row?.issues)
  const ok = Boolean(row && refs && refs.length >= 1 && refs.length <= 5 && refs.every(nonempty)
    && issues && issues.every(validPrivacyIssue) && nonempty(row.rationale))
  return ok ? { ok: true, value: value as PrivacyShortlistOutput, errors: [] } : { ok: false, errors: ['privacy_shortlist_invalid'] }
}

export function validatePrivacyIssueBatch(value: unknown) {
  const issues = array(object(value)?.issues)
  return issues && issues.every(validPrivacyIssue) ? { ok: true, value: { issues } as PrivacyIssueBatchOutput, errors: [] } : { ok: false, errors: ['privacy_issue_batch_invalid'] }
}

export function validatePrivacyCrossExamination(value: unknown) {
  const assessments = array(object(value)?.assessments)
  const statuses = ['VALID_CLAIM', 'POSSIBLE_BUT_UNVERIFIED', 'OVERSTATED', 'DUPLICATE', 'NOT_APPLICABLE', 'UNSUBSTANTIATED']
  const ok = Boolean(assessments && assessments.length >= 1 && assessments.length <= 3 && assessments.every((item) => {
    const row = object(item)
    return row && nonempty(row.issue_ref) && statuses.includes(row.status) && Array.isArray(row.missing_evidence)
      && ['FATAL', 'MAJOR', 'MINOR', 'INFO'].includes(row.severity_if_true) && (row.duplicate_of_ref == null || nonempty(row.duplicate_of_ref))
  }))
  return ok ? { ok: true, value: { assessments } as PrivacyCrossExaminationOutput, errors: [] } : { ok: false, errors: ['privacy_cross_examination_invalid'] }
}
