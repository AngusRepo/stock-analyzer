import assert from 'node:assert/strict'

import { buildStrategyProductionContributionFirewall } from './strategyProductionContributionFirewall'
import {
  STRATEGY_PRODUCTION_POLICY_POINT_IN_TIME_SQL,
  deserializeStrategyProductionPolicyRow,
  sha256StrategyProductionPolicyPayload,
} from './strategyProductionPolicyStore'

async function main(): Promise<void> {
  const state = buildStrategyProductionContributionFirewall({
    knowledgeCutoffDate: '2026-08-02',
    strategies: [
      { id: 'active-a', status: 'active' },
      { id: 'active-b', status: 'active' },
    ],
    gates: [{ strategy_id: 'active-b', decision: 'active_cooldown' }],
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
