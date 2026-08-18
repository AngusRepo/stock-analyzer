import assert from 'node:assert/strict'

import { buildStrategyProductionContributionFirewall } from './strategyProductionContributionFirewall'
import {
  STRATEGY_PRODUCTION_POLICY_POINT_IN_TIME_SQL,
  deserializeLegacyStrategyProductionWeightsRow,
  deserializeStrategyProductionPolicyRow,
  hasPositiveStrategyAllocation,
  resolveLegacyImplicitUnitWeightsBeforeFirewall,
  sha256StrategyProductionPolicyPayload,
  resolveRuntimeStrategyWeights,
} from './strategyProductionPolicyStore'

async function main(): Promise<void> {
  const state = buildStrategyProductionContributionFirewall({
    knowledgeCutoffDate: '2026-08-02',
    strategies: [
      { id: 'active-a', status: 'active' },
      { id: 'active-b', status: 'active' },
    ],
    gates: [
      { strategy_id: 'active-a', decision: 'active_monitor', allocation_eligible: true },
      { strategy_id: 'active-b', decision: 'active_cooldown', allocation_eligible: false },
    ],
    base: {
      source: 'promoted_marginal_edge_v6',
      run_id: 'edge-v6-2026-08-02',
      weights: { 'active-a': 0.6, 'active-b': 0.4 },
    },
  })

  const checksum = await sha256StrategyProductionPolicyPayload(state.canonical_payload)
  const loaded = deserializeStrategyProductionPolicyRow({
    policy_id: state.policy_id,
    knowledge_cutoff_date: state.knowledge_cutoff_date,
    version: state.version,
    status: state.status,
    strategy_weights_json: JSON.stringify(state.strategy_weights),
    quarantined_strategy_ids_json: JSON.stringify(state.quarantined_strategy_ids),
    candidate_ready_strategy_ids_json: JSON.stringify(state.candidate_ready_strategy_ids),
    base_weight_source: state.base_weight_source,
    base_weight_run_id: state.base_weight_run_id,
    evidence_json: JSON.stringify(state.evidence),
    canonical_payload: state.canonical_payload,
    checksum,
    created_at: '2026-08-02T18:00:00.000Z',
  }, ['active-a', 'active-b'])

  assert.deepEqual(loaded.state.strategy_weights, { 'active-a': 1, 'active-b': 0 })
  assert.equal(loaded.checksum, checksum)
  assert.match(STRATEGY_PRODUCTION_POLICY_POINT_IN_TIME_SQL, /knowledge_cutoff_date\s*<\s*\?/)
  assert.throws(
    () => deserializeStrategyProductionPolicyRow({
      policy_id: 'strategy-production-contribution-firewall-v1',
      knowledge_cutoff_date: state.knowledge_cutoff_date,
      version: 1,
      status: state.status,
      strategy_weights_json: JSON.stringify({ 'active-a': 0.6, 'active-b': 0.4 }),
      quarantined_strategy_ids_json: '[]',
      candidate_ready_strategy_ids_json: '[]',
      base_weight_source: state.base_weight_source,
      base_weight_run_id: state.base_weight_run_id,
      evidence_json: JSON.stringify({
        ...state.evidence,
        allocation_eligibility_contract_version: undefined,
      }),
      canonical_payload: state.canonical_payload,
      checksum,
      created_at: '2026-08-02T18:00:00.000Z',
    }, ['active-a', 'active-b']),
    /invalid_strategy_production_policy_identity/,
  )
  const legacyWeights = deserializeLegacyStrategyProductionWeightsRow({
    policy_id: 'strategy-production-contribution-firewall-v1',
    knowledge_cutoff_date: '2026-08-01',
    version: 1,
    status: 'active',
    strategy_weights_json: JSON.stringify({ 'active-a': 0.6, 'active-b': 0.4 }),
    quarantined_strategy_ids_json: '[]',
    candidate_ready_strategy_ids_json: '[]',
    base_weight_source: 'adaptive_strategy_policy_v2',
    base_weight_run_id: 'legacy-policy-run',
    evidence_json: JSON.stringify({
      production_effect: true,
      safety_reducing_only: true,
      raw_labels_preserved: true,
      experimental_threshold_deltas_applied: false,
      complete_non_retired_weight_map: true,
    }),
    canonical_payload: '{}',
    checksum: 'legacy-checksum',
    created_at: '2026-08-01T18:00:00.000Z',
  }, ['active-a', 'active-b'])
  assert.deepEqual(legacyWeights.strategy_weights, { 'active-a': 0.6, 'active-b': 0.4 })
  const implicitWeights = resolveLegacyImplicitUnitWeightsBeforeFirewall(
    '2026-08-04', ['active-b', 'active-a', 'active-a'],
  )
  assert.deepEqual(implicitWeights?.strategy_weights, { 'active-a': 1, 'active-b': 1 })
  assert.equal(implicitWeights?.evidence.source_commit, '9132ce95')
  assert.equal(implicitWeights?.evidence.no_lookahead, true)
  assert.equal(resolveLegacyImplicitUnitWeightsBeforeFirewall(
    '2026-08-05', ['active-a'],
  ), null)
  assert.equal(resolveLegacyImplicitUnitWeightsBeforeFirewall('invalid', ['active-a']), null)


  const missingPolicy = resolveRuntimeStrategyWeights(['active-b', 'active-a'], null)
  assert.deepEqual(missingPolicy.allocationWeights, { 'active-a': 0, 'active-b': 0 })
  assert.deepEqual(missingPolicy.evaluationWeights, { 'active-a': 1, 'active-b': 1 })
  assert.equal(missingPolicy.source, 'production_policy_unavailable_abstain')
  assert.equal(missingPolicy.abstained, true)
  assert.equal(hasPositiveStrategyAllocation(['active-a'], missingPolicy.allocationWeights), false)

  const authoritativePolicy = resolveRuntimeStrategyWeights(['active-a', 'active-b'], loaded)
  assert.deepEqual(authoritativePolicy.allocationWeights, { 'active-a': 1, 'active-b': 0 })
  assert.deepEqual(authoritativePolicy.evaluationWeights, { 'active-a': 1, 'active-b': 1 })
  assert.equal(authoritativePolicy.source, 'authoritative_production_policy')
  assert.equal(authoritativePolicy.abstained, false)
  assert.equal(hasPositiveStrategyAllocation(['active-b'], authoritativePolicy.allocationWeights), false)
  assert.equal(hasPositiveStrategyAllocation(['active-b', 'active-a'], authoritativePolicy.allocationWeights), true)
  assert.equal(hasPositiveStrategyAllocation([], authoritativePolicy.allocationWeights), false)

  assert.doesNotMatch(STRATEGY_PRODUCTION_POLICY_POINT_IN_TIME_SQL, /knowledge_cutoff_date\s*<=\s*\?/)

  assert.throws(
    () => deserializeStrategyProductionPolicyRow({
      policy_id: state.policy_id,
      knowledge_cutoff_date: state.knowledge_cutoff_date,
      version: state.version,
      status: state.status,
      strategy_weights_json: JSON.stringify({ 'active-a': 1 }),
      quarantined_strategy_ids_json: JSON.stringify(state.quarantined_strategy_ids),
      candidate_ready_strategy_ids_json: JSON.stringify(state.candidate_ready_strategy_ids),
      base_weight_source: state.base_weight_source,
      base_weight_run_id: state.base_weight_run_id,
      evidence_json: JSON.stringify(state.evidence),
      canonical_payload: state.canonical_payload,
      checksum,
      created_at: '2026-08-02T18:00:00.000Z',
    }, ['active-a', 'active-b']),
    /incomplete_strategy_production_policy_weight:active-b/,
  )

  assert.throws(
    () => deserializeStrategyProductionPolicyRow({
      policy_id: state.policy_id,
      knowledge_cutoff_date: state.knowledge_cutoff_date,
      version: state.version,
      status: state.status,
      strategy_weights_json: JSON.stringify(state.strategy_weights),
      quarantined_strategy_ids_json: JSON.stringify(state.quarantined_strategy_ids),
      candidate_ready_strategy_ids_json: JSON.stringify(state.candidate_ready_strategy_ids),
      base_weight_source: state.base_weight_source,
      base_weight_run_id: state.base_weight_run_id,
      evidence_json: JSON.stringify({ ...state.evidence, raw_labels_preserved: false }),
      canonical_payload: state.canonical_payload,
      checksum,
      created_at: '2026-08-02T18:00:00.000Z',
    }, ['active-a', 'active-b']),
    /invalid_strategy_production_policy_evidence/,
  )

  console.log('strategy production policy store tests passed')
}

void main()
