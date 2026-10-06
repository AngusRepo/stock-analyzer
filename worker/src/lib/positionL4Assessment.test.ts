import assert from 'node:assert/strict'
import test from 'node:test'
import { positionL4Assessment, loadPositionL4Context } from './positionL4Assessment'

const plan: any = { signal_date: '2026-10-05', plan_id: 'p',
  account_anchor: { positions: [{ symbol: '6994', shares: 1000 }] },
  targets: { '6994': { current_weight: .03307791968314604, weight: .03307791968314604, locked: false },
    '3441': { current_weight: 0, weight: .125, locked: false } } }
const view = (p = plan, symbol = '6994') => positionL4Assessment({ status: 'ready', plan: p, tradeDate: '2026-10-06' }, symbol)

test('6994 decision anchor is hold; a newly filled target is not another buy instruction', () => {
  const before = JSON.stringify(plan)
  const held = view()
  assert.equal(held.status, 'ready')
  if (held.status !== 'ready') throw Error('expected ready')
  assert.equal(held.action, 'hold')
  assert.equal(held.decision_shares, 1000)
  assert.equal(held.target_weight, held.decision_weight)
  const filled = view(plan, '3441')
  assert.equal(filled.status === 'ready' && filled.action, 'hold')
  assert.equal(filled.status === 'ready' && filled.held_at_decision, false)
  assert.equal(JSON.stringify(plan), before)
})

test('sealed review can reduce or exit even if optimizer originally held', () => {
  for (const [weight, action] of [[.02, 'reduce'], [0, 'exit']] as const) {
    const p = { ...plan, execution_review: { weights: { '6994': weight }, checksum: 'review', reasons: { '6994': ['hard risk'] } } }
    const result = view(p)
    assert.equal(result.status === 'ready' && result.action, action)
    assert.equal(result.status === 'ready' && result.optimizer_weight, plan.targets['6994'].weight)
    assert.deepEqual(result.status === 'ready' && result.reasons, ['hard risk'])
  }
})

test('locked, absent and unavailable are never mislabeled as a hold decision', () => {
  const p = { ...plan, targets: { '6994': { ...plan.targets['6994'], locked: true } } }
  assert.equal(view(p).status === 'ready' && (view(p) as any).action, 'locked')
  assert.deepEqual(view(plan, 'missing'), { status: 'unavailable', reason: 'target_missing' })
  assert.deepEqual(positionL4Assessment({ status: 'unavailable', reason: 'plan_stale' }, '6994'),
    { status: 'unavailable', reason: 'plan_stale' })
})

test('an unsealed plan is unavailable and loader performs no write', async () => {
  const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) }
  const env: any = { KV: { get: async () => ({ l4Distribution: { artifact: {} } }) },
    PAPER_DAILY_PLAN_OWNER: 'premarket_once_v1', PAPER_DB: db, DB: db,
    MULTI_D1_ACTIVE_DOMAINS: 'paper', MULTI_D1_STRICT: 'true' }
  assert.deepEqual(await loadPositionL4Context(env, '2026-10-06'), { status: 'unavailable', reason: 'plan_not_finalized' })
})


test('a stale sealed base plan cannot be reported as todays hold', async () => {
  const stale = { ...plan, signal_date: '2026-10-02', schema_version: 'l4-portfolio-plan-v1', owner: 'l4_distribution',
    account_id: 1, parent_plan_id: null, plan_id: 'a'.repeat(64), policy_identity: 'b'.repeat(64), model_checksum: 'c'.repeat(64),
    nav_at_decision: 965901.13, weights: { '6994': plan.targets['6994'].weight, '3441': .125 },
    constraints: { exposure_cap: .45, name_cap: .125, min_weight: .03, max_positions: 5 },
    proof: { within_tolerance: true, absolute_objective_gap: 0, tolerance: 1e-8, evaluated_candidate_count: 2, preselection: false } }
  const db = { prepare: () => ({ first: async () => ({ payload_json: JSON.stringify(stale) }) }) }
  const env: any = { KV: { get: async () => null }, PAPER_DB: db, DB: db,
    MULTI_D1_ACTIVE_DOMAINS: 'paper', MULTI_D1_STRICT: 'true' }
  assert.deepEqual(await loadPositionL4Context(env, '2026-10-06'), { status: 'unavailable', reason: 'plan_stale' })
})
