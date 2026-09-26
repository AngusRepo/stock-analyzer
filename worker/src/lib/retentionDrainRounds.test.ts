import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runRetentionDrainRounds, type DrainPass } from './retentionDrainRounds'
const pass = (id: string, patch: Partial<DrainPass> = {}): DrainPass => ({
  policy_id: id, status: 'success', backlog_remaining: false, deleted_rows: 5, ...patch,
})

test('fair rounds finish each policy before continuing progressing backlog', async () => {
  const calls: string[] = []
  const result = await runRetentionDrainRounds({ policyIds: ['market', 'ops'], dryRun: false, maxRounds: 3,
    run: async id => { calls.push(id); return pass(id, { backlog_remaining: calls.length < 3 }) },
  })
  assert.deepEqual(calls, ['market', 'ops', 'market', 'ops'])
  assert.equal(result.stopReason, 'complete')
  assert.deepEqual(result.pendingPolicyIds, [])
  assert.equal(result.attempts.reduce((n, r) => n + r.deleted_rows, 0), 20)
})
test('time budget retains unstarted and unfinished evidence', async () => {
  let clock = 0
  const result = await runRetentionDrainRounds({ policyIds: ['market', 'ops'], dryRun: false,
    maxRounds: 10, budgetMs: 10, now: () => clock,
    run: async id => { clock += 12; return pass(id, { backlog_remaining: true }) },
  })
  assert.equal(result.attempts.length, 1)
  assert.equal(result.stopReason, 'time_budget')
  assert.deepEqual(result.unstartedPolicyIds, ['ops'])
  assert.deepEqual(result.pendingPolicyIds, ['market', 'ops'])
})
test('dry-run scans once and cannot enter repeated delete rounds', async () => {
  const result = await runRetentionDrainRounds({ policyIds: ['market'], dryRun: true, maxRounds: 10,
    run: async id => pass(id, { status: 'dry_run', deleted_rows: 0, backlog_remaining: true }),
  })
  assert.equal(result.attempts.length, 1)
  assert.equal(result.stopReason, 'preflight')
})
test('errors and no progress stop retries while healthy policies continue', async () => {
  const counts: Record<string, number> = {}
  const result = await runRetentionDrainRounds({ policyIds: ['blocked', 'stuck', 'market'],
    dryRun: false, maxRounds: 3, run: async id => {
      counts[id] = (counts[id] ?? 0) + 1
      return pass(id, { status: id === 'blocked' ? 'error' : 'success',
        deleted_rows: id === 'market' ? 5 : 0, backlog_remaining: id !== 'market' || counts[id] < 2 })
    },
  })
  assert.deepEqual(counts, { blocked: 1, stuck: 1, market: 2 })
  assert.equal(result.stopReason, 'blocked_or_no_progress')
  assert.deepEqual(result.pendingPolicyIds, ['blocked', 'stuck'])
})
test('round upper bound and default prevent unbounded paid work', async () => {
  for (const [maxRounds, expected] of [[undefined, 1], [100, 10], [NaN, 1], [Infinity, 1]] as const) {
    const result = await runRetentionDrainRounds({ policyIds: ['market'], dryRun: false, maxRounds,
      run: async id => pass(id, { backlog_remaining: true }),
    })
    assert.equal(result.attempts.length, expected)
    assert.equal(result.stopReason, 'round_limit')
  }
})
