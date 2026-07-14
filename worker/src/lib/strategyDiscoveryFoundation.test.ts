import assert from 'node:assert/strict'
import { AI_BUDGET, MODEL_REGISTRY, SEARCH_POLICY, canReserveAnalysis, estimateNeurons, isLocalFixtureModeAuthorized } from '../strategy-discovery/config'
import { hashJson, stableStringify } from '../strategy-discovery/hashing'
import { createStoredZip, jsonZipEntry, parseStoredZip } from '../strategy-discovery/zip'
import { validateCandidate, validateIssue, validateIssueVerdict } from '../strategy-discovery/validators'
import type { AuditIssue, IssueVerdictRecord, StrategyCandidate } from '../strategy-discovery/domain'

async function main() {
  assert.equal(stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}')
  assert.equal(await hashJson({ b: 2, a: 1 }), await hashJson({ a: 1, b: 2 }))

  assert.deepEqual(SEARCH_POLICY.allocation, {
    MODE_C_PORTFOLIO_GAP: 6,
    MODE_B_PARENT_MUTATION: 4,
    MODE_D_REGIME_SPECIALIST: 2,
    MODE_A_FREE_DISCOVERY: 0,
  })
  assert.equal(Object.values(SEARCH_POLICY.allocation).reduce((a, b) => a + b, 0), 12)
  assert.equal(canReserveAnalysis(5_000, 500), true)
  assert.equal(canReserveAnalysis(5_500, 500), false)
  assert(estimateNeurons('PORTFOLIO_JUDGE', 10_000, 2_500) > 0)
  assert.equal(AI_BUDGET.dailyHardLimit, 10_000)
  assert.equal(MODEL_REGISTRY.CROSS_EXAMINER.structuredMode, 'guided_json')
  assert.equal(isLocalFixtureModeAuthorized({ ENVIRONMENT: 'local', LOCAL_AUTH_BYPASS: '1' }), true)
  assert.equal(isLocalFixtureModeAuthorized({ ENVIRONMENT: 'production', LOCAL_AUTH_BYPASS: '1' }), false)
  assert.equal(isLocalFixtureModeAuthorized({ ENVIRONMENT: 'local', LOCAL_AUTH_BYPASS: '0' }), false)

  const zip = createStoredZip([
    jsonZipEntry('manifest.json', { run_id: 'RUN-1' }),
    jsonZipEntry('nested/result.json', { ok: true }),
  ])
  const parsed = parseStoredZip(zip)
  assert.equal(parsed.size, 2)
  assert.equal(JSON.parse(new TextDecoder().decode(parsed.get('manifest.json'))).run_id, 'RUN-1')
  assert.throws(() => createStoredZip([{ name: '../evil.json', data: new Uint8Array() }]), /path_traversal/)
  const corrupted = zip.slice()
  corrupted[30 + new TextEncoder().encode('manifest.json').length] ^= 1
  assert.throws(() => parseStoredZip(corrupted), /crc_mismatch/)

  const base: StrategyCandidate = {
    candidate_id: 'CAND-001', run_id: 'RUN-1', search_mode: 'MODE_C_PORTFOLIO_GAP', parent_strategy_id: null,
    mutation_type: null, hypothesis: 'h', economic_mechanism: 'm', portfolio_gap: 'g', preferred_regimes: ['bull'],
    minimum_regime_samples: 100, candidate_hash: 'a'.repeat(64), source_model: 'fixture', source_type: 'FIXTURE',
    dsl: { feature_ids: ['known'], parameters: {}, regime_gate: null, entry_rules: [{}], exit_rules: [{}], signal_time: 'T_CLOSE', execution_time: 'T_PLUS_1_OPEN', falsification_condition: 'x', lags: [0] },
  }
  assert.deepEqual(validateCandidate(base, new Set(['known'])), [])
  assert(validateCandidate({ ...base, dsl: { ...base.dsl, feature_ids: ['missing'] } }, new Set(['known'])).includes('candidate_unknown_feature:missing'))
  assert(validateCandidate({ ...base, dsl: { ...base.dsl, lags: [-1] } }, new Set(['known'])).includes('candidate_negative_or_invalid_lag'))
  assert(validateCandidate({ ...base, search_mode: 'MODE_A_FREE_DISCOVERY' }, new Set(['known'])).includes('mode_a_disabled'))
  assert(validateCandidate({ ...base, dsl: { ...base.dsl, feature_ids: ['known', 'f2', 'f3', 'f4'] } }, new Set(['known', 'f2', 'f3', 'f4'])).includes('candidate_feature_limit'))
  assert(validateCandidate({ ...base, dsl: { ...base.dsl, parameters: { a: 1, b: 2, c: 3, d: 4 } } }, new Set(['known'])).includes('candidate_parameter_limit'))

  const e0: AuditIssue = { issue_id: 'I-E0', run_id: 'RUN-1', target_type: 'CANDIDATE', target_ids: ['CAND-001'], category: 'GENERIC', claim: 'generic', attack_mechanism: 'none', observed_evidence: [], missing_evidence: [], severity_if_true: 'MAJOR', evidence_level: 'E0', critic_model: 'm', critic_confidence: 0.5, falsification_test: {}, blocks_if_confirmed: true, cross_exam_status: 'POSSIBLE_BUT_UNVERIFIED', duplicate_of: null }
  assert(validateIssue(e0).includes('e0_cannot_be_formal_blocker'))

  const fatal: IssueVerdictRecord = {
    issue_id: 'I-1', verdict: 'CONFIRMED', severity: 'FATAL', evidence_level: 'E1', evidence: [], commands_executed: [],
    test_results: [], remaining_uncertainty: [], required_fix: '', blocks_target: true,
  }
  assert(validateIssueVerdict(fatal, new Set(['I-1'])).includes('confirmed_fatal_evidence_level'))
  assert(validateIssueVerdict(fatal, new Set(['I-1'])).includes('confirmed_fatal_requires_file_or_test_evidence'))
}

void main()
