import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { classifyUniversalRetrainDispatchResult } from './controllerResearchWorkflows'

assert.equal(
  classifyUniversalRetrainDispatchResult({
    status: 'rejected',
    error: 'monthly_compute_snapshot_behind_market_session:expected=2026-08-25:actual=2026-08-21',
  }, 'monthly-retrain'),
  'monthly-retrain failed: monthly_compute_snapshot_behind_market_session:expected=2026-08-25:actual=2026-08-21',
)

assert.equal(
  classifyUniversalRetrainDispatchResult({ status: 'skipped', reason: 'locked' }, 'monthly-retrain'),
  'monthly-retrain skipped: locked',
)

assert.equal(
  classifyUniversalRetrainDispatchResult({
    status: 'orchestrator_dispatched',
    run_id: 'universal-20260825T120000-a1b2c3d4',
    function_call_id: 'fc-test',
  }, 'monthly-retrain'),
  'monthly-retrain triggered via Modal prep run_id=universal-20260825T120000-a1b2c3d4 function_call_id=fc-test callback expected',
)

const workflows = readFileSync(new URL('./controllerResearchWorkflows.ts', import.meta.url), 'utf8')
const adminTasks = readFileSync(new URL('./adminTriggerGcpTasks.ts', import.meta.url), 'utf8')
assert.match(workflows, /run_date: runDate/)
assert.match(
  adminTasks,
  /triggerRetrain\(c\.env, true, 'monthly-retrain', requestedRunDate\(\)\)/,
)
assert.match(
  adminTasks,
  /triggerRetrain\(c\.env, force, force \? 'monthly-retrain' : 'retrain', requestedRunDate\(\)\)/,
)

console.log('retrain rejected dispatch contract passed')
