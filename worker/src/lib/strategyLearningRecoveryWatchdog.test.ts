import assert from 'node:assert/strict'
import fs from 'node:fs'
import { strategyLearningRecoveryDecision, type StrategyLearningRecoveryRow } from './strategyLearningRecoveryWatchdog'

const base: StrategyLearningRecoveryRow = {
  business_date: '2026-08-31',
  canonical_run_id: 'pipeline-dispatch:2026-08-31:canonical',
  status: 'running',
  cursor_symbol: '9958',
  expected_candidates: 830,
  processed_candidates: 830,
  expected_decision_rows: 21580,
  persisted_decision_rows: 21580,
  lease_owner: 'expired-owner',
  lease_expires_at: '2026-08-31 16:39:11',
  attempt_count: 38,
  last_error: null,
  updated_at: '2026-08-31 16:38:28',
  production_authority_intent: 1,
  policy_closure_status: 'pending',
}

assert.deepEqual(
  strategyLearningRecoveryDecision(base, Date.parse('2026-08-31T16:40:00Z')),
  { resume: true, reason: 'lease_expired' },
)
assert.deepEqual(
  strategyLearningRecoveryDecision(base, Date.parse('2026-08-31T16:38:00Z')),
  { resume: false, reason: 'active_lease' },
)
assert.deepEqual(
  strategyLearningRecoveryDecision({ ...base, status: 'queued', lease_owner: null, lease_expires_at: null }),
  { resume: true, reason: 'queued_without_lease' },
)
assert.deepEqual(
  strategyLearningRecoveryDecision({
    ...base,
    status: 'queued',
    cursor_symbol: null,
    processed_candidates: 0,
    persisted_decision_rows: 0,
    lease_owner: null,
    lease_expires_at: null,
  }),
  { resume: true, reason: 'queued_without_lease' },
)
assert.equal(
  strategyLearningRecoveryDecision({ ...base, status: 'error', last_error: 'real_data_blocker' }).resume,
  false,
)
assert.equal(
  strategyLearningRecoveryDecision({ ...base, persisted_decision_rows: -1 }).reason,
  'recoverable_progress_invalid',
)

const source = fs.readFileSync('src/lib/strategyLearningRecoveryWatchdog.ts', 'utf8')
const tasks = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const scheduler = fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')
const schedulerPolicy = fs.readFileSync('src/lib/schedulerPolicy.ts', 'utf8')
assert(source.includes("status IN ('queued','running')"), 'watchdog must not auto-retry terminal error runs')
assert(source.includes('business_date BETWEEN date(?, ?) AND ?'), 'watchdog must resolve the latest cross-midnight incomplete run')
assert(source.includes("status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=CURRENT_TIMESTAMP)"), 'an active newer run must not starve an older expired recovery')
assert(source.includes("stage='post_verify_chain'"), 'watchdog must require post-verify authority')
assert(source.includes('authority?.canonical_run_id !== row.canonical_run_id'), 'watchdog must fence canonical lineage')
assert(source.includes('productionAuthorityIntent: Number(row.production_authority_intent ?? 0) === 1'), 'watchdog must preserve durable live authority intent')
assert(source.includes('authority=revalidate_at_finalizer'), 'watchdog must defer current authority validation to the canonical finalizer')
assert(source.includes('strategy-learning:watchdog-dispatch:'), 'watchdog must fence duplicate queue dispatches')
assert(source.includes('DISPATCH_FENCE_TTL_SECONDS'), 'dispatch fence must expire for bounded retry')
assert(tasks.includes("'strategy-learning-watchdog'"), 'admin task map must expose the dedicated watchdog')
assert(tasks.includes('runStrategyLearningRecoveryWatchdog'), 'scheduled screener watchdog must drain post-verify strategy recovery')
assert(tasks.includes('status=${compositeStatus}'), 'composite watchdog must preserve triggered/running state instead of false-green success')
assert(schedulerPolicy.includes("'screener-v2-watchdog': { kind: 'maintenance', holidayGated: false"), 'cross-midnight parent watchdog must not be Saturday-gated')
assert(schedulerPolicy.includes("'strategy-learning-watchdog': { kind: 'maintenance', holidayGated: false"), 'cross-midnight learning watchdog must rely on canonical authority instead of calendar-day gating')
assert(scheduler.includes('strategy-learning expired-lease recovery'), 'scheduler source must document composite recovery ownership')

console.log('strategy learning recovery watchdog tests passed')
