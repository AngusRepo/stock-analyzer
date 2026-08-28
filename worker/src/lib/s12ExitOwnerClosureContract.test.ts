import assert from 'node:assert/strict'
import fs from 'node:fs'

const policy = fs.readFileSync('src/lib/paperExitPolicy.ts', 'utf8')
const tasks = fs.readFileSync('src/lib/paperExitTasks.ts', 'utf8')
const continuation = fs.readFileSync('src/lib/s12ProfitContinuationPolicy.ts', 'utf8')
const migration = fs.readFileSync('domain-migrations/learning/0031_s12_profit_continuation_serving_owner.sql', 'utf8')

assert(!policy.includes('getExitMultiplier('), 'retired hand-written regime multipliers must not affect paper exits')
assert(policy.includes('void ex.dynamicExitPriorityEnabled'), 'legacy flag must remain explicitly inert')
assert(!tasks.includes('logRegimeShadow'), 'retired regime multiplier telemetry must have no paper-exit consumer')
assert(!tasks.includes("databaseForTable(env, 'exit_shadow_log')"), 'retired exit shadow table must not receive runtime writes')
assert(tasks.includes('resolveS12PrimaryExitDecision'))
assert(tasks.includes("fallback_exit_owner: 'paper_sltp_atr_trailing_v1'"))
assert(tasks.includes("execution_owner: 's12_position_decision_v1'"))
assert(tasks.includes("trailing_rule: 'never_loosen_max_existing'"))
assert(tasks.includes('loadPromotedS12ProfitContinuationPolicy'))
assert(tasks.includes('resolveS12ProfitContinuationPolicy'))
assert(continuation.includes("scope: 'paper_only'"))
assert(continuation.includes('real_order_effect: false'))
assert(continuation.includes("'active_structure_stop'"))
assert(continuation.includes("'bearish_defense_or_reverse_bos'"))
assert(continuation.includes("'profit_continuation_deadline'"))
assert(!continuation.includes('liveExecution'))
assert.match(migration, /CREATE TABLE IF NOT EXISTS s12_exit_policy_head_v1/)
assert.match(migration, /real_order_effect INTEGER NOT NULL DEFAULT 0 CHECK\(real_order_effect = 0\)/)

console.log('S12 exit owner closure contract tests passed')
