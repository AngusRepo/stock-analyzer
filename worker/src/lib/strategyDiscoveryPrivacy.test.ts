import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AuditIssue, FeatureCard, StaticValidationResult, StrategyCandidate, StrategyCard } from '../strategy-discovery/domain'
import {
  assertPrivacySafePayload,
  buildPrivacyCrossExaminationBatches,
  buildPrivacyRedTeamPayload,
  buildPrivacyShortlistPayload,
  materializePrivacyCrossExamination,
  materializePrivacyIssues,
  materializePrivacyShortlist,
  privacyFixtureCrossExamination,
  privacyFixtureIssueBatch,
  privacyFixtureShortlist,
  type PrivacyRole,
} from '../strategy-discovery/privacyProjection'
import { validatePrivacyCrossExamination, validatePrivacyIssueBatch, validatePrivacyShortlist } from '../strategy-discovery/modelContracts'
import { roleMessages } from '../strategy-discovery/rolePrompts'

const INTERNAL = {
  runId: 'RUN-20991231235959-privacy-secret',
  candidateId: 'CAND-SECRET-001',
  candidateHash: 'candidate-hash-secret',
  strategyId: 'STRATEGY-SECRET-001',
  featureId: 'FEATURE-SECRET-001',
  hypothesis: 'SECRET_HYPOTHESIS_VALUE',
  mechanism: 'SECRET_ECONOMIC_MECHANISM_VALUE',
  dslThreshold: 'SECRET_DSL_THRESHOLD_42',
  dataSource: 'SECRET_DATA_SOURCE_URI',
  governance: 'SECRET_GOVERNANCE_STATE',
  modelId: 'authoritative-model-id',
}

const candidate: StrategyCandidate = {
  candidate_id: INTERNAL.candidateId,
  run_id: INTERNAL.runId,
  search_mode: 'MODE_C_PORTFOLIO_GAP',
  parent_strategy_id: INTERNAL.strategyId,
  mutation_type: null,
  hypothesis: INTERNAL.hypothesis,
  economic_mechanism: INTERNAL.mechanism,
  portfolio_gap: 'sideways',
  preferred_regimes: ['sideways'],
  minimum_regime_samples: 500,
  dsl: {
    feature_ids: [INTERNAL.featureId],
    parameters: { threshold: INTERNAL.dslThreshold },
    regime_gate: { internal: 'SECRET_REGIME_GATE' },
    entry_rules: [{ confidential: 'SECRET_ENTRY_RULE' }],
    exit_rules: [{ confidential: 'SECRET_EXIT_RULE' }],
    signal_time: 'CLOSE',
    execution_time: 'NEXT_OPEN',
    falsification_condition: 'SECRET_FALSIFICATION_CONDITION',
    lags: [1],
  },
  candidate_hash: INTERNAL.candidateHash,
  source_model: 'SECRET_SOURCE_MODEL',
  source_type: 'REAL',
}

const validation: StaticValidationResult = {
  candidate_id: INTERNAL.candidateId,
  candidate_hash: INTERNAL.candidateHash,
  valid: true,
  errors: [],
  warnings: ['TIMING_WARNING:SECRET_WARNING_DETAILS'],
}

const feature: FeatureCard = {
  feature_id: INTERNAL.featureId,
  name: 'SECRET_FEATURE_NAME',
  family: 'SECRET_FEATURE_FAMILY',
  definition: 'SECRET_FEATURE_FORMULA',
  data_source: [INTERNAL.dataSource],
  availability_lag: 'T+1 delayed',
  earliest_execution: 'NEXT_OPEN',
  lookback_days: 20,
  missing_rate: 0,
  outlier_rate: 0,
  turnover_proxy: 0,
  correlation_cluster: 'SECRET_CLUSTER',
  ic_summary: { secret: 0.2 },
  regime_summary: { secret: true },
  factor_exposure: { secret: true },
  used_by_strategies: [INTERNAL.strategyId],
  known_risks: ['point-in-time leakage risk'],
  governance: {
    selector_role: INTERNAL.governance,
    promotion_state: INTERNAL.governance,
    materializer_status: INTERNAL.governance,
    eligible_for_strategy: true,
  },
}

const strategy: StrategyCard = {
  strategy_id: INTERNAL.strategyId,
  version: 'SECRET_VERSION',
  name: 'SECRET_STRATEGY_NAME',
  hypothesis: 'SECRET_EXISTING_STRATEGY_HYPOTHESIS',
  feature_ids: [INTERNAL.featureId],
  entry_rules: [{ secret: true }],
  exit_rules: [{ secret: true }],
  holding_period: 'SECRET_HOLDING_PERIOD',
  execution_timing: 'SECRET_EXECUTION_TIMING',
  transaction_cost: { secret: true },
  preferred_regimes: ['bull'],
  failure_regimes: ['sideways'],
  annual_performance: { secret: true },
  regime_performance: { secret: true },
  factor_exposure: { secret: true },
  signal_correlation: { secret: true },
  selection_overlap: { secret: true },
  known_failures: ['SECRET_KNOWN_FAILURE'],
  source_references: ['SECRET_SOURCE_REFERENCE'],
  governance: {
    status: INTERNAL.governance,
    owner_type: INTERNAL.governance,
    promotion_status: INTERNAL.governance,
    alpha_bucket: INTERNAL.governance,
    family_id: INTERNAL.governance,
    variant_id: INTERNAL.governance,
  },
}

const forbiddenValues = Object.values(INTERNAL)
const forbiddenKeys = [
  'run_id', 'candidate_id', 'candidate_hash', 'strategy_id', 'parent_strategy_id', 'feature_id', 'feature_ids',
  'dsl', 'parameters', 'regime_gate', 'entry_rules', 'exit_rules', 'hypothesis', 'economic_mechanism',
  'falsification_condition', 'source_model', 'source_type', 'data_source', 'governance', 'system_profile',
]

function assertOutboundSafe(role: Parameters<typeof roleMessages>[0], payload: unknown): string {
  assertPrivacySafePayload(payload, forbiddenValues)
  const transcript = JSON.stringify(roleMessages(role, payload))
  for (const value of forbiddenValues) assert.equal(transcript.includes(value), false, `leaked internal value: ${value}`)
  for (const key of forbiddenKeys) assert.equal(new RegExp(`"${key}"\\s*:`).test(transcript), false, `leaked forbidden key: ${key}`)
  return transcript
}

function assertThrowsUnknownRef(): void {
  const shortlist = buildPrivacyShortlistPayload({ candidates: [candidate], validation: [validation], existingStrategies: [strategy], gapMap: {} })
  assert.throws(() => materializePrivacyShortlist({
    runId: INTERNAL.runId,
    modelId: INTERNAL.modelId,
    candidateIdentities: shortlist.identities,
    output: { shortlist_refs: ['PC-unknown'], rationale: 'unknown', issues: [] },
  }), /privacy_unknown_shortlist_ref/)

  assert.throws(() => materializePrivacyIssues({
    runId: INTERNAL.runId,
    modelId: INTERNAL.modelId,
    candidateIdentities: shortlist.identities,
    prefix: 'RAW',
    issues: [{
      target_scope: 'CANDIDATE', target_refs: ['PC-unknown'], category: 'TEST', claim: 'test', attack_mechanism: 'test',
      missing_evidence: [], severity_if_true: 'MINOR', critic_confidence: 0.5, falsification_tests: [], blocks_if_confirmed: false,
    }],
  }), /privacy_unknown_candidate_ref/)
}

function main(): void {
  const shortlistProjection = buildPrivacyShortlistPayload({
    candidates: [candidate], validation: [validation], existingStrategies: [strategy],
    gapMap: { missing_regimes: ['sideways'], secret: 'SECRET_GAP_MAP' },
  })
  const shortlistTranscript = assertOutboundSafe('PORTFOLIO_JUDGE', shortlistProjection.payload)
  assert.match(shortlistTranscript, /PC-[a-f0-9]{16}/)
  assert.match(shortlistTranscript, /regime_coverage_counts/)

  const shortlistValidation = validatePrivacyShortlist(privacyFixtureShortlist(Object.values(shortlistProjection.identities.internal_to_opaque)))
  assert.equal(shortlistValidation.ok, true)
  if (!shortlistValidation.ok || shortlistValidation.value === undefined) throw new Error('privacy_shortlist_fixture_invalid')
  const shortlistOutput = shortlistValidation.value
  const shortlist = materializePrivacyShortlist({
    runId: INTERNAL.runId,
    modelId: INTERNAL.modelId,
    output: shortlistOutput,
    candidateIdentities: shortlistProjection.identities,
  })
  assert.deepEqual(shortlist.shortlist_ids, [INTERNAL.candidateId])
  assert.equal(shortlist.issues[0].run_id, INTERNAL.runId)
  assert.equal(shortlist.issues[0].critic_model, INTERNAL.modelId)

  const roles: PrivacyRole[] = ['DATA_PROSECUTOR', 'EXECUTION_PROSECUTOR', 'ECONOMIC_PROSECUTOR']
  const transcripts = new Map<PrivacyRole, string>()
  for (const role of roles) {
    const projection = buildPrivacyRedTeamPayload({ role, targets: [candidate], validation: [validation], features: [feature] })
    const transcript = assertOutboundSafe(role, projection.payload)
    transcripts.set(role, transcript)
    const validationResult = validatePrivacyIssueBatch(privacyFixtureIssueBatch(Object.values(projection.identities.candidates.internal_to_opaque), role))
    assert.equal(validationResult.ok, true)
    if (!validationResult.ok || validationResult.value === undefined) throw new Error('privacy_issue_fixture_invalid')
    const parsed = validationResult.value
    const issues = materializePrivacyIssues({
      runId: INTERNAL.runId,
      modelId: INTERNAL.modelId,
      issues: parsed.issues,
      candidateIdentities: projection.identities.candidates,
      prefix: `RAW-${role}`,
    })
    assert.deepEqual(issues[0].target_ids, [INTERNAL.candidateId])
    assert.equal(issues[0].critic_model, INTERNAL.modelId)
  }
  assert.match(transcripts.get('DATA_PROSECUTOR')!, /feature_slots/)
  assert.doesNotMatch(transcripts.get('DATA_PROSECUTOR')!, /timing_class/)
  assert.match(transcripts.get('EXECUTION_PROSECUTOR')!, /timing_class/)
  assert.doesNotMatch(transcripts.get('EXECUTION_PROSECUTOR')!, /feature_slots/)
  assert.match(transcripts.get('ECONOMIC_PROSECUTOR')!, /discovery_class/)
  assert.doesNotMatch(transcripts.get('ECONOMIC_PROSECUTOR')!, /validation_codes/)

  const crossInput: AuditIssue[] = shortlist.issues
  const batchedCrossInput = Array.from({ length: 7 }, (_, index) => ({ ...crossInput[0], issue_id: `ISSUE-${index + 1}` }))
  const crossBatches = buildPrivacyCrossExaminationBatches(batchedCrossInput)
  assert.deepEqual(crossBatches.map((batch) => batch.issues.length), [3, 3, 1])
  const materializedIssueIds: string[] = []
  for (const batch of crossBatches) {
    assertOutboundSafe('CROSS_EXAMINER', batch.payload)
    const crossValidation = validatePrivacyCrossExamination(privacyFixtureCrossExamination(
      Object.values(batch.identities.issues.internal_to_opaque), batch.issues,
    ))
    assert.equal(crossValidation.ok, true)
    if (!crossValidation.ok || crossValidation.value === undefined) throw new Error('privacy_cross_fixture_invalid')
    const cross = materializePrivacyCrossExamination(crossValidation.value, batch.identities.issues)
    materializedIssueIds.push(...cross.assessments.map((row) => row.issue_id))
  }
  assert.deepEqual(materializedIssueIds, batchedCrossInput.map((row) => row.issue_id))
  const crossProjection = crossBatches[0]
  assert.throws(() => materializePrivacyCrossExamination({ assessments: [{
    issue_ref: 'PI-unknown', status: 'UNSUBSTANTIATED', severity_if_true: 'MINOR', missing_evidence: [], duplicate_of_ref: null,
  }] }, crossProjection.identities.issues), /privacy_unknown_issue_ref/)
  assert.equal(validatePrivacyCrossExamination({ assessments: [{
    issue_ref: Object.values(crossProjection.identities.issues.internal_to_opaque)[0], status: 'INVALID_STATUS', severity_if_true: 'MINOR', missing_evidence: [], duplicate_of_ref: null,
  }] }).ok, false)

  assertThrowsUnknownRef()

  const workflowSource = readFileSync(resolve(process.cwd(), 'src/strategy-discovery/workflow.ts'), 'utf8')
  for (const unsafePattern of [
    "system_profile: frozen.systemProfile",
    "roleMessages('PORTFOLIO_JUDGE', { run_id",
    "roleMessages('PORTFOLIO_JUDGE', validCandidates",
  ]) assert.equal(workflowSource.includes(unsafePattern), false, `unsafe workflow projection restored: ${unsafePattern}`)
}

main()
