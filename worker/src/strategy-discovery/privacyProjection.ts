import type { AuditIssue, FeatureCard, StaticValidationResult, StrategyCandidate, StrategyCard } from './domain'
import type { PrivacyCrossExaminationOutput, PrivacyIssue, PrivacyIssueBatchOutput, PrivacyShortlistOutput } from './modelContracts'

export type PrivacyRole = 'DATA_PROSECUTOR' | 'EXECUTION_PROSECUTOR' | 'ECONOMIC_PROSECUTOR'
export const PRIVACY_CROSS_EXAMINATION_BATCH_SIZE = 3

export interface OpaqueIdentityMap {
  internal_to_opaque: Record<string, string>
  opaque_to_internal: Record<string, string>
}

const FORBIDDEN_KEYS = new Set([
  'run_id', 'candidate_id', 'candidate_hash', 'strategy_id', 'parent_strategy_id', 'feature_id', 'feature_ids',
  'dsl', 'parameters', 'regime_gate', 'entry_rules', 'exit_rules', 'hypothesis', 'economic_mechanism',
  'falsification_condition', 'source_model', 'source_type', 'data_source', 'governance', 'system_profile',
  'snapshot_hash', 'feature_snapshot_hash', 'strategy_snapshot_hash', 'input_hash', 'threshold', 'threshold_ref',
])
const REGIMES = new Set(['bull', 'bear', 'volatile', 'sideways'])

function opaque(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}

export function createOpaqueIdentityMap(ids: string[], prefix: string): OpaqueIdentityMap {
  const internal_to_opaque: Record<string, string> = {}
  const opaque_to_internal: Record<string, string> = {}
  for (const id of [...new Set(ids)]) {
    const token = opaque(prefix)
    internal_to_opaque[id] = token
    opaque_to_internal[token] = id
  }
  return { internal_to_opaque, opaque_to_internal }
}

function code(value: unknown): string {
  return String(value ?? 'UNKNOWN').split(':', 1)[0].replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'UNKNOWN'
}

function regimes(values: unknown): string[] {
  return Array.isArray(values) ? [...new Set(values.map((value) => String(value).toLowerCase()).filter((value) => REGIMES.has(value)))] : []
}

function timingClass(candidate: StrategyCandidate): string {
  const signal = candidate.dsl.signal_time.toUpperCase()
  const execution = candidate.dsl.execution_time.toUpperCase()
  if (signal.includes('CLOSE') && (execution.includes('PLUS_1') || execution.includes('NEXT') || execution.includes('OPEN'))) return 'CLOSE_TO_NEXT_OPEN'
  if (signal.includes('INTRADAY') || execution.includes('INTRADAY')) return 'INTRADAY'
  return 'OTHER_BOUNDED_TIMING'
}

function lagClass(lags: number[]): string {
  if (!lags.length) return 'UNKNOWN'
  if (lags.every((lag) => lag >= 1)) return 'POSITIVE_LAG'
  if (lags.some((lag) => lag === 0)) return 'CONTAINS_ZERO_LAG'
  return 'UNKNOWN'
}

function discoveryClass(candidate: StrategyCandidate): string {
  if (candidate.search_mode === 'MODE_B_PARENT_MUTATION') return 'PARENT_MUTATION'
  if (candidate.search_mode === 'MODE_D_REGIME_SPECIALIST') return 'REGIME_SPECIALIST'
  return 'PORTFOLIO_GAP'
}

function candidateSummary(candidate: StrategyCandidate, candidateRef: string, validation?: StaticValidationResult) {
  return {
    candidate_ref: candidateRef,
    discovery_class: discoveryClass(candidate),
    mutation_class: candidate.mutation_type ?? 'NONE',
    regime_tags: regimes(candidate.preferred_regimes),
    feature_slot_count: candidate.dsl.feature_ids.length,
    has_regime_filter: candidate.dsl.regime_gate != null,
    timing_class: timingClass(candidate),
    lag_class: lagClass(candidate.dsl.lags),
    validation: {
      valid: validation?.valid === true,
      error_codes: (validation?.errors ?? []).map(code),
      warning_codes: (validation?.warnings ?? []).map(code),
    },
  }
}

function safeMissingRegimes(gapMap: unknown): string[] {
  const value = (gapMap as { missing_regimes?: unknown } | null)?.missing_regimes
  return regimes(value)
}

export function buildPrivacyShortlistPayload(input: {
  candidates: StrategyCandidate[]
  validation: StaticValidationResult[]
  existingStrategies: StrategyCard[]
  gapMap: unknown
}) {
  const identities = createOpaqueIdentityMap(input.candidates.map((row) => row.candidate_id), 'PC')
  const validation = new Map(input.validation.map((row) => [row.candidate_id, row]))
  const regimeCoverage: Record<string, number> = { bull: 0, bear: 0, volatile: 0, sideways: 0 }
  for (const strategy of input.existingStrategies) for (const regime of regimes(strategy.preferred_regimes)) regimeCoverage[regime] += 1
  return {
    identities,
    payload: {
      contract_version: 'strategy-discovery-privacy-v1',
      candidates: input.candidates.map((row) => candidateSummary(row, identities.internal_to_opaque[row.candidate_id], validation.get(row.candidate_id))),
      portfolio_context: {
        existing_strategy_count: input.existingStrategies.length,
        regime_coverage_counts: regimeCoverage,
        missing_regimes: safeMissingRegimes(input.gapMap),
      },
      instruction: 'Shortlist at most five opaque candidate references. Judge only the disclosed risk and coverage fields.',
    },
  }
}

function availabilityClass(value: unknown): string {
  const text = String(value ?? '').toUpperCase()
  if (!text || text.includes('UNKNOWN')) return 'UNKNOWN'
  if (text.includes('T+') || text.includes('DELAY') || text.includes('LAG')) return 'DELAYED'
  return 'KNOWN_BOUNDED'
}

function executionAvailabilityClass(value: unknown): string {
  const text = String(value ?? '').toUpperCase()
  if (!text || text.includes('UNKNOWN')) return 'UNKNOWN'
  if (text.includes('OPEN')) return 'OPEN_OR_LATER'
  if (text.includes('CLOSE')) return 'CLOSE_OR_LATER'
  return 'BOUNDED_OTHER'
}

function riskClasses(values: unknown): string[] {
  const text = Array.isArray(values) ? values.map(String).join(' ').toLowerCase() : String(values ?? '').toLowerCase()
  return [
    ['LEAKAGE', /leak|look.?ahead|point.?in.?time/], ['SURVIVORSHIP', /surviv/], ['REVISION', /revis/],
    ['STALE', /stale|delay|lag/], ['LIQUIDITY', /liquid|volume/], ['MISSINGNESS', /missing|null/],
  ].filter(([, pattern]) => (pattern as RegExp).test(text)).map(([name]) => name as string)
}

export function buildPrivacyRedTeamPayload(input: {
  role: PrivacyRole
  targets: StrategyCandidate[]
  validation: StaticValidationResult[]
  features: FeatureCard[]
}) {
  const candidateIdentities = createOpaqueIdentityMap(input.targets.map((row) => row.candidate_id), 'PC')
  const featureIds = [...new Set(input.targets.flatMap((row) => row.dsl.feature_ids))]
  const featureIdentities = createOpaqueIdentityMap(featureIds, 'PF')
  const validation = new Map(input.validation.map((row) => [row.candidate_id, row]))
  const features = new Map(input.features.map((row) => [row.feature_id, row]))
  const base = input.targets.map((row) => candidateSummary(row, candidateIdentities.internal_to_opaque[row.candidate_id], validation.get(row.candidate_id)))
  let targets: unknown[]
  if (input.role === 'DATA_PROSECUTOR') {
    targets = input.targets.map((row, index) => ({
      candidate_ref: base[index].candidate_ref,
      feature_slots: row.dsl.feature_ids.map((featureId) => {
        const feature = features.get(featureId)
        return {
          feature_ref: featureIdentities.internal_to_opaque[featureId],
          availability_class: availabilityClass(feature?.availability_lag),
          earliest_execution_class: executionAvailabilityClass(feature?.earliest_execution),
          risk_classes: riskClasses(feature?.known_risks),
        }
      }),
      lag_class: base[index].lag_class,
      validation_codes: [...base[index].validation.error_codes, ...base[index].validation.warning_codes],
    }))
  } else if (input.role === 'EXECUTION_PROSECUTOR') {
    targets = base.map((row) => ({ candidate_ref: row.candidate_ref, timing_class: row.timing_class, lag_class: row.lag_class,
      feature_slot_count: row.feature_slot_count, has_regime_filter: row.has_regime_filter, validation_codes: [...row.validation.error_codes, ...row.validation.warning_codes] }))
  } else {
    targets = base.map((row) => ({ candidate_ref: row.candidate_ref, discovery_class: row.discovery_class, mutation_class: row.mutation_class,
      regime_tags: row.regime_tags, feature_slot_count: row.feature_slot_count, has_regime_filter: row.has_regime_filter }))
  }
  return {
    identities: { candidates: candidateIdentities, features: featureIdentities },
    payload: {
      contract_version: 'strategy-discovery-privacy-v1',
      market_class: 'TW_EQUITY',
      evidence_ceiling: 'E1',
      targets,
      instruction: 'Return issues only against opaque references and only from the disclosed fields.',
    },
  }
}

export function buildPrivacyCrossExaminationPayload(issues: AuditIssue[]) {
  const issueIdentities = createOpaqueIdentityMap(issues.map((row) => row.issue_id), 'PI')
  const targetIds = [...new Set(issues.flatMap((row) => row.target_ids))]
  const targetIdentities = createOpaqueIdentityMap(targetIds, 'PC')
  return {
    identities: { issues: issueIdentities, targets: targetIdentities },
    payload: {
      contract_version: 'strategy-discovery-privacy-v1',
      issues: issues.map((issue) => ({
        issue_ref: issueIdentities.internal_to_opaque[issue.issue_id],
        target_scope: issue.target_type === 'SYSTEM' ? 'SYSTEM' : 'CANDIDATE',
        target_refs: issue.target_ids.map((id) => targetIdentities.internal_to_opaque[id]).filter(Boolean),
        category: code(issue.category),
        claim: issue.claim.slice(0, 500),
        attack_mechanism: issue.attack_mechanism.slice(0, 300),
        severity_if_true: issue.severity_if_true,
        missing_evidence: issue.missing_evidence.map((value) => String(value).slice(0, 200)).slice(0, 8),
      })),
      instruction: 'Return exactly one assessment per supplied issue_ref using the assessments schema. Use only supplied opaque references. Do not infer identities or undisclosed strategy logic.',
    },
  }
}

export function buildPrivacyCrossExaminationBatches(
  issues: AuditIssue[],
  batchSize = PRIVACY_CROSS_EXAMINATION_BATCH_SIZE,
) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > PRIVACY_CROSS_EXAMINATION_BATCH_SIZE) {
    throw new Error('privacy_cross_examination_invalid_batch_size')
  }
  const batches = []
  for (let offset = 0; offset < issues.length; offset += batchSize) {
    const batchIssues = issues.slice(offset, offset + batchSize)
    batches.push({
      batch_index: batches.length + 1,
      issues: batchIssues,
      ...buildPrivacyCrossExaminationPayload(batchIssues),
    })
  }
  return batches
}

function walk(value: unknown, strings: string[], keys: string[]): void {
  if (typeof value === 'string') { strings.push(value); return }
  if (Array.isArray(value)) { for (const item of value) walk(item, strings, keys); return }
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { keys.push(key.toLowerCase()); walk(item, strings, keys) }
}

export function assertPrivacySafePayload(payload: unknown, forbiddenValues: string[] = []): void {
  const strings: string[] = []; const keys: string[] = []
  walk(payload, strings, keys)
  const forbiddenKey = keys.find((key) => FORBIDDEN_KEYS.has(key) || key.includes('threshold'))
  if (forbiddenKey) throw new Error(`privacy_forbidden_key:${forbiddenKey}`)
  const internalPattern = strings.find((value) => /\bRUN-\d{8,}|\bCAND-\d+/i.test(value))
  if (internalPattern) throw new Error('privacy_internal_identifier_detected')
  const forbidden = new Set(forbiddenValues.filter(Boolean))
  const leaked = strings.find((value) => forbidden.has(value))
  if (leaked) throw new Error('privacy_forbidden_value_detected')
}

function mapTargetRefs(issue: PrivacyIssue, identities: OpaqueIdentityMap): string[] {
  if (issue.target_scope === 'SYSTEM') return []
  const targets = issue.target_refs.map((ref) => identities.opaque_to_internal[ref])
  if (!targets.length || targets.some((value) => !value)) throw new Error('privacy_unknown_candidate_ref')
  return [...new Set(targets)]
}

export function materializePrivacyIssues(input: {
  runId: string
  modelId: string
  issues: PrivacyIssue[]
  candidateIdentities: OpaqueIdentityMap
  prefix: string
}): AuditIssue[] {
  return input.issues.map((issue, index) => ({
    issue_id: `${input.prefix}-${String(index + 1).padStart(3, '0')}`,
    run_id: input.runId,
    target_type: issue.target_scope,
    target_ids: mapTargetRefs(issue, input.candidateIdentities),
    category: code(issue.category),
    claim: issue.claim,
    attack_mechanism: issue.attack_mechanism,
    observed_evidence: [],
    missing_evidence: issue.missing_evidence,
    severity_if_true: issue.severity_if_true,
    evidence_level: 'E1',
    critic_model: input.modelId,
    critic_confidence: issue.critic_confidence,
    falsification_test: { tests: issue.falsification_tests },
    blocks_if_confirmed: issue.blocks_if_confirmed,
    cross_exam_status: 'POSSIBLE_BUT_UNVERIFIED',
    duplicate_of: null,
  }))
}

export function materializePrivacyShortlist(input: {
  runId: string
  modelId: string
  output: PrivacyShortlistOutput
  candidateIdentities: OpaqueIdentityMap
}) {
  const shortlist_ids = input.output.shortlist_refs.map((ref) => input.candidateIdentities.opaque_to_internal[ref])
  if (!shortlist_ids.length || shortlist_ids.some((value) => !value)) throw new Error('privacy_unknown_shortlist_ref')
  return {
    shortlist_ids: [...new Set(shortlist_ids)],
    rationale: input.output.rationale,
    issues: materializePrivacyIssues({ runId: input.runId, modelId: input.modelId, issues: input.output.issues,
      candidateIdentities: input.candidateIdentities, prefix: 'RAW-SHORTLIST' }),
  }
}

export function materializePrivacyCrossExamination(output: PrivacyCrossExaminationOutput, issueIdentities: OpaqueIdentityMap) {
  return { assessments: output.assessments.map((row) => {
    const issue_id = issueIdentities.opaque_to_internal[row.issue_ref]
    if (!issue_id) throw new Error('privacy_unknown_issue_ref')
    const duplicate_of = row.duplicate_of_ref == null ? null : issueIdentities.opaque_to_internal[row.duplicate_of_ref]
    if (row.duplicate_of_ref != null && !duplicate_of) throw new Error('privacy_unknown_duplicate_ref')
    return { issue_id, status: row.status, severity_if_true: row.severity_if_true, missing_evidence: row.missing_evidence, duplicate_of }
  }) }
}

export function privacyFixtureShortlist(candidateRefs: string[]): PrivacyShortlistOutput {
  const refs = candidateRefs.slice(0, 5)
  return { shortlist_refs: refs, rationale: 'Fixture privacy shortlist.', issues: [privacyFixtureIssue(refs[0], 'MULTIPLE_TESTING')] }
}

function privacyFixtureIssue(targetRef: string, category: string): PrivacyIssue {
  return { target_scope: 'CANDIDATE', target_refs: [targetRef], category, claim: `Fixture ${category} claim.`, attack_mechanism: category,
    missing_evidence: ['repository evidence'], severity_if_true: 'MAJOR', critic_confidence: 0.6,
    falsification_tests: ['repository verification'], blocks_if_confirmed: true }
}

export function privacyFixtureIssueBatch(candidateRefs: string[], role: PrivacyRole): PrivacyIssueBatchOutput {
  return { issues: [privacyFixtureIssue(candidateRefs[0], role)] }
}

export function privacyFixtureCrossExamination(issueRefs: string[], issues: AuditIssue[]): PrivacyCrossExaminationOutput {
  return { assessments: issueRefs.map((issue_ref, index) => ({ issue_ref, status: 'POSSIBLE_BUT_UNVERIFIED',
    severity_if_true: issues[index].severity_if_true, missing_evidence: issues[index].missing_evidence, duplicate_of_ref: null })) }
}
