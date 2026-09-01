const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = fs.readFileSync('src/routes/adminWriteRoutes.ts', 'utf8')
const start = source.indexOf("adminWriteRoutes.post('/api/admin/strategy-learning/resume'")
const end = source.indexOf("adminWriteRoutes.post('/api/admin/strategy/decision-log/materialize'", start)
const route = source.slice(start, end)

assert(start >= 0 && end > start, 'canonical strategy-learning resume route must exist')
assert(route.includes('X-Confirm-Strategy-Learning-Recovery'), 'resume must require an explicit recovery confirmation')
assert(route.includes("run.status === 'queued'"), 'resume must allow a clean queued run')
assert(route.includes("run.status === 'running'"), 'resume must limit active-run recovery to running runs')
assert(route.includes("Number(run.lease_expired) === 1"), 'resume must require an expired running lease')
assert(route.includes('lease_expires_at < CURRENT_TIMESTAMP'), 'lease expiry must be decided by D1 time')
assert(route.includes('Number(run.processed_candidates) > 0'), 'resume must reject new zero-progress runs')
assert(route.includes('Number(run.processed_candidates) <= Number(run.expected_candidates)'), 'resume must allow a fully materialized queued run to enter its durable finalizer')
assert(route.includes("stage='post_verify_chain'"), 'resume must require post-verify authority')
assert(route.includes("['running', 'waiting', 'success'].includes"), 'resume must accept only canonical active-or-closed post-verify authority')
assert(route.includes('authority.canonical_run_id !== run.canonical_run_id'), 'resume must preserve the canonical run owner')
assert(route.includes("type: 'strategy_learning_materialize'"), 'resume must enqueue only the durable strategy-learning continuation')
assert(route.includes('productionAuthorityIntent: Number(run.production_authority_intent ?? 0) === 1'), 'resume must preserve durable live intent for finalizer revalidation')
