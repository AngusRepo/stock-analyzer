import assert from 'node:assert/strict'
import { planActive8OofContinuationCollisionRetry } from './updateOrchestrator'

const collision = planActive8OofContinuationCollisionRetry(
  'active8_oof_lifecycle status=pending cadence=monthly cohort=none promoted=false reason=materialization_job_active',
  2,
)
assert.deepEqual(collision, { attempt: 3, delaySeconds: 300 })

assert.equal(
  planActive8OofContinuationCollisionRetry(
    'active8_oof_lifecycle status=spawned cadence=monthly reason=durable_prep_first_oof_job_dispatched',
    2,
  ),
  null,
)
assert.equal(
  planActive8OofContinuationCollisionRetry(
    'active8_oof_lifecycle status=pending cadence=monthly reason=cohort_orchestrator_active',
    2,
  ),
  null,
)

assert.throws(
  () => planActive8OofContinuationCollisionRetry(
    'active8_oof_lifecycle status=pending cadence=monthly reason=materialization_job_active',
    12,
  ),
  /active8_oof_continuation_collision_exhausted:12/,
)

console.log('active8 OOF continuation collision tests passed')
