import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const runbook = readFileSync('../EXECUTION_PRE_PILOT_RUNBOOK_2026_05_28.md', 'utf8')

for (const flag of [
  'FINLAB_L5_MARKET_DATA_ENABLED',
  'FINLAB_EXECUTION_LOOP_ENABLED',
  'FINLAB_L5_ENVELOPE_GUARD_ENABLED',
  'EXECUTION_WATCH_POOL_SIZE',
  'EXECUTION_WATCH_MIN_ML_EDGE',
  'EXECUTION_WATCH_MIN_FINAL_SCORE',
  'EXECUTION_WATCH_RISK_MULTIPLIER',
  'EXECUTION_CLOSE_WINDOW_MIN_VOLUME_RATIO',
  'INTRADAY_DYNAMIC_TECHNICAL_GUARD_ENABLED',
  'INTRADAY_TECHNICAL_DISTRIBUTION_SKIP_MIN_BARS',
]) {
  assert(runbook.includes(flag), `${flag} must be documented in the pre-pilot runbook`)
}

for (const eventType of [
  'finlab_l5_market_data',
  'intraday_technical_decision',
  'paper_broker_reconciliation',
]) {
  assert(runbook.includes(eventType), `${eventType} must be part of the daily evidence query`)
}

assert(runbook.includes('live_submit_enabled = false'), 'runbook must explicitly block live submit')
assert(runbook.includes('dry_run=false -> run bounded production-simulated loop'), 'runbook must document production-simulated loop mode')
assert(runbook.includes('paper_order_mode = worker_intraday_check'), 'runbook must route real loop to Worker paper order simulation')
assert(runbook.includes('mode = real_loop_simulated_order'), 'runbook must name the real-loop simulated-order mode')
assert(runbook.includes('/api/internal/execution/intraday-check'), 'runbook must document the internal Worker loop endpoint')
assert(runbook.includes('/finlab/execution/production-simulated-loop'), 'runbook must document the production-simulated loop route')
assert(runbook.includes('100/hr rate limit'), 'runbook must explain why admin trigger is not used for 10-second loop')
assert(runbook.includes('Scheduler KV log'), 'runbook must preserve scheduler dashboard observability for internal loop endpoint')
assert(runbook.includes('body.duration_seconds = 50'), 'runbook must document bounded 50s scheduler loop duration')
assert(runbook.includes('body.poll_seconds = 10'), 'runbook must document 10-second scheduler loop polling')
assert(runbook.includes('Wei explicitly approves real-order pilot'), 'runbook must keep real-order pilot approval gated')
