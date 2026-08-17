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
assert(route.includes("run.status !== 'queued'"), 'resume must reject non-queued runs')
assert(route.includes('Number(run.processed_candidates) > 0'), 'resume must reject new zero-progress runs')
assert(route.includes("stage='post_verify_chain'"), 'resume must require post-verify authority')
assert(route.includes("authority?.status !== 'success'"), 'resume must require terminal successful post-verify')
assert(route.includes('authority.canonical_run_id !== run.canonical_run_id'), 'resume must preserve the canonical run owner')
assert(route.includes("type: 'strategy_learning_materialize'"), 'resume must enqueue only the durable strategy-learning continuation')
assert(route.includes('policyMutationAllowed: false'), 'resume must not mutate production policy')
