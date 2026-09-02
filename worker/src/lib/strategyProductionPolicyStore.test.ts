import assert from 'node:assert/strict'

import { buildStrategyProductionContributionFirewall } from './strategyProductionContributionFirewall'
import {
  STRATEGY_PRODUCTION_POLICY_POINT_IN_TIME_SQL,
  deserializeHistoricalStrategyProductionPolicyRow,
  deserializeLegacyStrategyProductionWeightsRow,
  deserializePreviousStrategyProductionPolicyRow,
  deserializeStrategyProductionPolicyRow,
  hasPositiveStrategyAllocation,
  loadStrategyProductionPolicyForHistoricalReconstructionBefore,
  resolveLegacyImplicitUnitWeightsBeforeFirewall,
  sha256StrategyProductionPolicyPayload,
  resolveRuntimeStrategyWeights,
  type StrategyProductionPolicyHistoryRow,
} from './strategyProductionPolicyStore'

class FakePolicyStatement {
  private args: unknown[] = []

  constructor(
    private readonly sql: string,
    private readonly rows: Readonly<Record<string, StrategyProductionPolicyHistoryRow>>,
  ) {}

  bind(...args: unknown[]): FakePolicyStatement {
    this.args = args
    return this
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: 0 } }
  }

  async first<T>(): Promise<T | null> {
    if (!this.sql.includes('FROM strategy_production_policy_history_v1')) return null
    return (this.rows[String(this.args[0] ?? '')] ?? null) as T | null
  }
}

class FakePolicyD1 {
  constructor(private readonly rows: Readonly<Record<string, StrategyProductionPolicyHistoryRow>>) {}

  prepare(sql: string): FakePolicyStatement {
    return new FakePolicyStatement(sql, this.rows)
  }
}

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
  assert.throws(() => deserializeStrategyProductionPolicyRow({
    policy_id: state.policy_id,
    knowledge_cutoff_date: state.knowledge_cutoff_date,
    version: state.version,
    status: state.status,
    strategy_weights_json: JSON.stringify(state.strategy_weights),
    quarantined_strategy_ids_json: JSON.stringify(state.quarantined_strategy_ids),
    candidate_ready_strategy_ids_json: JSON.stringify(state.candidate_ready_strategy_ids),
    base_weight_source: 'adaptive_strategy_policy_v2',
    base_weight_run_id: 'adaptive|strategy-evidence-owner-fusion-v2:stale',
    evidence_json: JSON.stringify({
      ...state.evidence,
      evidence_owner: { version: 'strategy-evidence-owner-fusion-v2', checksum: 'stale', weight_effect: 'mature_ready_only_bounded_bidirectional', ready_profile_count: 1 },
    }),
    canonical_payload: state.canonical_payload,
    checksum,
    created_at: '2026-08-02T18:00:00.000Z',
  }, ['active-a', 'active-b']), /invalid_strategy_production_policy_evidence_owner/)
  const historicalOwnerV2Row = {
    policy_id: state.policy_id,
    knowledge_cutoff_date: '2026-08-18',
    version: state.version,
    status: state.status,
    strategy_weights_json: JSON.stringify(state.strategy_weights),
    quarantined_strategy_ids_json: JSON.stringify(state.quarantined_strategy_ids),
    candidate_ready_strategy_ids_json: JSON.stringify(state.candidate_ready_strategy_ids),
    base_weight_source: 'adaptive_strategy_policy_v2',
    base_weight_run_id: 'adaptive|strategy-evidence-owner-fusion-v2:historical',
    evidence_json: JSON.stringify({
      ...state.evidence,
      evidence_owner: {
        version: 'strategy-evidence-owner-fusion-v2',
        checksum: 'a'.repeat(64),
        weight_effect: 'mature_ready_only_bounded_bidirectional',
        ready_profile_count: 2,
      },
    }),
    canonical_payload: state.canonical_payload,
    checksum,
    created_at: '2026-08-18T18:00:00.000Z',
  }
  const historicalOwnerV2 = deserializeHistoricalStrategyProductionPolicyRow(
    historicalOwnerV2Row,
    ['active-a', 'active-b'],
  )
  assert.equal(historicalOwnerV2.reconstruction_receipt.source_contract, 'strategy-evidence-owner-fusion-v2')
  assert.deepEqual(historicalOwnerV2.state.strategy_weights, { 'active-a': 1, 'active-b': 0 })
  assert.throws(
    () => deserializeHistoricalStrategyProductionPolicyRow({
      ...historicalOwnerV2Row,
      evidence_json: JSON.stringify({
        ...state.evidence,
        evidence_owner: {
          version: 'strategy-evidence-owner-fusion-v2',
          checksum: 'not-a-checksum',
          weight_effect: 'mature_ready_only_bounded_bidirectional',
          ready_profile_count: 2,
        },
      }),
    }, ['active-a', 'active-b']),
    /invalid_historical_strategy_production_policy_evidence_owner/,
  )
  const previous = deserializePreviousStrategyProductionPolicyRow({
    policy_id: 'strategy-production-contribution-firewall-v2',
    knowledge_cutoff_date: '2026-08-18',
    version: 2,
    status: 'active',
    strategy_weights_json: JSON.stringify({ 'active-a': 1, 'active-b': 0 }),
    quarantined_strategy_ids_json: JSON.stringify(['active-b']),
    candidate_ready_strategy_ids_json: '[]',
    base_weight_source: 'adaptive_strategy_policy_v2',
    base_weight_run_id: 'adaptive|strategy-evidence-owner-fusion-v1:checksum',
    evidence_json: JSON.stringify({
      production_effect: true,
      safety_reducing_only: true,
      raw_labels_preserved: true,
      experimental_threshold_deltas_applied: false,
      complete_non_retired_weight_map: true,
      allocation_eligibility_contract_version: 'strategy-allocation-eligibility-v2',
      normalized_promoted_weights: true,
      positive_weight_count: 1,
    }),
    canonical_payload: '{}',
    checksum: 'previous-checksum',
    created_at: '2026-08-18T06:00:00.000Z',
  }, ['active-a', 'active-b'])
  assert.equal(previous.state.policy_id, 'strategy-production-contribution-firewall-v2')
  assert.deepEqual(previous.state.strategy_weights, { 'active-a': 1, 'active-b': 0 })
  const previousCanonicalPayload = JSON.stringify({
    policy_id: 'strategy-production-contribution-firewall-v2',
    version: 2,
    allocation_eligibility_contract_version: 'strategy-allocation-eligibility-v2',
    knowledge_cutoff_date: '2026-08-14',
    strategy_weights: { 'active-a': 1, 'active-b': 0 },
    quarantined_strategy_ids: ['active-b'],
    candidate_ready_strategy_ids: [],
    base_weight_source: 'adaptive_strategy_policy_v2',
    base_weight_run_id: 'previous-policy-run',
  })
  const previousPolicyRow: StrategyProductionPolicyHistoryRow = {
    policy_id: 'strategy-production-contribution-firewall-v2',
    knowledge_cutoff_date: '2026-08-14',
    version: 2,
    status: 'active',
    strategy_weights_json: JSON.stringify({ 'active-a': 1, 'active-b': 0 }),
    quarantined_strategy_ids_json: JSON.stringify(['active-b']),
    candidate_ready_strategy_ids_json: '[]',
    base_weight_source: 'adaptive_strategy_policy_v2',
    base_weight_run_id: 'previous-policy-run',
    evidence_json: JSON.stringify({
      production_effect: true,
      safety_reducing_only: true,
      raw_labels_preserved: true,
      experimental_threshold_deltas_applied: false,
      complete_non_retired_weight_map: true,
      allocation_eligibility_contract_version: 'strategy-allocation-eligibility-v2',
      normalized_promoted_weights: true,
      positive_weight_count: 1,
    }),
    canonical_payload: previousCanonicalPayload,
    checksum: await sha256StrategyProductionPolicyPayload(previousCanonicalPayload),
    created_at: '2026-08-14T18:00:00.000Z',
  }
  const historicalPrevious = await loadStrategyProductionPolicyForHistoricalReconstructionBefore(
    new FakePolicyD1({ [previousPolicyRow.policy_id]: previousPolicyRow }) as any,
    '2026-08-18',
    ['active-a', 'active-b'],
  )
  assert.equal(historicalPrevious?.reconstruction_receipt.source_contract, 'previous-firewall-v2')
  assert.deepEqual(historicalPrevious?.state.strategy_weights, { 'active-a': 1, 'active-b': 0 })
  const reorderedCanonicalPayload = JSON.stringify({
    policy_id: 'strategy-production-contribution-firewall-v2',
    version: 2,
    allocation_eligibility_contract_version: 'strategy-allocation-eligibility-v2',
    knowledge_cutoff_date: '2026-08-14',
    strategy_weights: { 'active-a': 1, 'active-b': 0, 'active-c': 0 },
    quarantined_strategy_ids: ['active-b', 'active-c'],
    candidate_ready_strategy_ids: [],
    base_weight_source: 'adaptive_strategy_policy_v2',
    base_weight_run_id: 'previous-policy-run',
  })
  const reorderedPolicyRow: StrategyProductionPolicyHistoryRow = {
    ...previousPolicyRow,
    strategy_weights_json: JSON.stringify({ 'active-a': 1, 'active-b': 0, 'active-c': 0 }),
    quarantined_strategy_ids_json: JSON.stringify(['active-c', 'active-b']),
    canonical_payload: reorderedCanonicalPayload,
    checksum: await sha256StrategyProductionPolicyPayload(reorderedCanonicalPayload),
  }
  const historicalReordered = await loadStrategyProductionPolicyForHistoricalReconstructionBefore(
    new FakePolicyD1({ [reorderedPolicyRow.policy_id]: reorderedPolicyRow }) as any,
    '2026-08-18',
    ['active-a', 'active-b', 'active-c'],
  )
  assert.deepEqual(
    [...(historicalReordered?.state.quarantined_strategy_ids ?? [])].sort(),
    ['active-b', 'active-c'],
    'canonical parity must treat strategy-id collections as order-insensitive while preserving all members',
  )
  await assert.rejects(
    () => loadStrategyProductionPolicyForHistoricalReconstructionBefore(
      new FakePolicyD1({
        [reorderedPolicyRow.policy_id]: {
          ...reorderedPolicyRow,
          quarantined_strategy_ids_json: JSON.stringify(['active-b']),
        },
      }) as any,
      '2026-08-18',
      ['active-a', 'active-b', 'active-c'],
    ),
    /historical_strategy_production_policy_canonical_parity_failed/,
    'canonical parity must still fail when collection membership differs',
  )
  await assert.rejects(
    () => loadStrategyProductionPolicyForHistoricalReconstructionBefore(
      new FakePolicyD1({
        [previousPolicyRow.policy_id]: {
          ...previousPolicyRow,
          strategy_weights_json: JSON.stringify({ 'active-a': 0, 'active-b': 1 }),
        },
      }) as any,
      '2026-08-18',
      ['active-a', 'active-b'],
    ),
    /historical_strategy_production_policy_canonical_parity_failed/,
  )
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
  assert.deepEqual(missingPolicy.routingWeights, { 'active-a': 0, 'active-b': 0 })
  assert.equal(missingPolicy.performanceWeightOwner, 'ple_portfolio_metrics')
  assert.equal(missingPolicy.source, 'production_policy_unavailable_abstain')
  assert.equal(missingPolicy.abstained, true)
  assert.equal(hasPositiveStrategyAllocation(['active-a'], missingPolicy.allocationWeights), false)

  const authoritativePolicy = resolveRuntimeStrategyWeights(['active-a', 'active-b'], loaded)
  assert.deepEqual(authoritativePolicy.allocationWeights, { 'active-a': 1, 'active-b': 0 })
  assert.deepEqual(authoritativePolicy.evaluationWeights, { 'active-a': 1, 'active-b': 1 })
  assert.deepEqual(authoritativePolicy.routingWeights, { 'active-a': 1, 'active-b': 0 })
  assert.equal(authoritativePolicy.performanceWeightOwner, 'ple_portfolio_metrics')
  assert.equal(authoritativePolicy.source, 'authoritative_production_policy')
  assert.equal(authoritativePolicy.abstained, false)
  assert.equal(hasPositiveStrategyAllocation(['active-b'], authoritativePolicy.allocationWeights), false)
  assert.equal(hasPositiveStrategyAllocation(['active-b', 'active-a'], authoritativePolicy.allocationWeights), true)
  assert.equal(hasPositiveStrategyAllocation([], authoritativePolicy.allocationWeights), false)

  const calibratedPolicy = resolveRuntimeStrategyWeights(['active-a', 'active-b'], {
    ...loaded,
    state: {
      ...loaded.state,
      strategy_weights: { 'active-a': 0.8, 'active-b': 0.2 },
      evidence: {
        ...loaded.state.evidence,
        evidence_owner: {
          version: 'strategy-evidence-owner-fusion-v3',
          checksum: 'a'.repeat(64),
          weight_effect: 'immutable_oos_calibrated_bounded_bidirectional',
          ready_profile_count: 2,
          calibration_run_id: 'calibration-run',
          calibration_artifact_checksum: 'b'.repeat(64),
        },
      },
    },
  } as any)
  assert.deepEqual(calibratedPolicy.allocationWeights, { 'active-a': 0.8, 'active-b': 0.2 })
  assert.deepEqual(calibratedPolicy.routingWeights, { 'active-a': 1.6, 'active-b': 0.4 })
  assert.equal(calibratedPolicy.performanceWeightOwner, 'formal_evidence_owner')

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
