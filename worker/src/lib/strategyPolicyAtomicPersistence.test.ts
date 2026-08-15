import assert from 'node:assert/strict'
import test from 'node:test'
import {
  persistStrategyPolicyState,
  type StrategyAdaptivePolicyState,
} from './strategyLearning'

class AtomicPolicyStatement {
  constructor(
    readonly sql: string,
    readonly values: readonly unknown[] = [],
    private readonly owner: AtomicPolicyDb,
  ) {}

  bind(...values: unknown[]): AtomicPolicyStatement {
    return new AtomicPolicyStatement(this.sql, values, this.owner)
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (/INSERT INTO strategy_(?:policy_state|adaptive_policy_history_v2)/i.test(this.sql)) {
      this.owner.directPolicyWrites += 1
    }
    return { meta: { changes: 0 } }
  }
}

class AtomicPolicyDb {
  directPolicyWrites = 0
  batches: AtomicPolicyStatement[][] = []
  failBatch = false

  prepare(sql: string): AtomicPolicyStatement {
    return new AtomicPolicyStatement(sql, [], this)
  }

  async batch(statements: AtomicPolicyStatement[]): Promise<unknown[]> {
    this.batches.push(statements)
    if (this.failBatch) throw new Error('injected_policy_batch_failure')
    return statements.map(() => ({ success: true, meta: { changes: 1 } }))
  }
}

function policyState(): StrategyAdaptivePolicyState {
  return {
    policy_id: 'adaptive-strategy-policy-v1',
    version: 'strategy-adaptive-policy-v1',
    status: 'active',
    strategy_weights: { eligible: 1, immature: 0 },
    threshold_deltas: {},
    lifecycle_recommendations: {},
    evidence: {
      version: 'strategy-learning-v4',
      date: '2026-08-15',
      source: 'strategy_reward_ledger',
      production_effect: true,
      requires_approval_to_activate: false,
      threshold_owner: 'adaptive_strategy_policy',
      pit_rule: 'knowledge_cutoff_lt_signal_date',
      eligible_strategy_count: 1,
      missing_evidence: { immature: ['samples_lt_30'] },
    },
    updated_at: '2026-08-15T10:00:00.000Z',
  }
}

test('persists current policy and immutable history in one D1 batch', async () => {
  const db = new AtomicPolicyDb()
  const persisted = await persistStrategyPolicyState(db as unknown as D1Database, policyState())
  assert.equal(persisted, 2)
  assert.equal(db.directPolicyWrites, 0)
  assert.equal(db.batches.length, 1)
  assert.equal(db.batches[0].length, 2)
  assert.match(db.batches[0][0].sql, /INSERT INTO strategy_policy_state/i)
  assert.match(db.batches[0][1].sql, /INSERT INTO strategy_adaptive_policy_history_v2/i)
})

test('propagates a batch failure without falling back to torn direct writes', async () => {
  const db = new AtomicPolicyDb()
  db.failBatch = true
  await assert.rejects(
    persistStrategyPolicyState(db as unknown as D1Database, policyState()),
    /injected_policy_batch_failure/,
  )
  assert.equal(db.directPolicyWrites, 0)
  assert.equal(db.batches.length, 1)
})
