import assert from 'node:assert/strict'
import test from 'node:test'
import { s12ReplayLifecycleMutationAllowed } from './updateOrchestrator'

test('only persisted formal fusion-missing replay may mutate canonical lifecycle', () => {
  assert.equal(s12ReplayLifecycleMutationAllowed('l0', true), false)
  assert.equal(s12ReplayLifecycleMutationAllowed('l0', false), false)
  assert.equal(s12ReplayLifecycleMutationAllowed('signed_eligible_repair', true), false)
  assert.equal(s12ReplayLifecycleMutationAllowed('fusion_snapshot_structure', true), false)
  assert.equal(s12ReplayLifecycleMutationAllowed('fusion_snapshot_missing', false), false)
  assert.equal(s12ReplayLifecycleMutationAllowed('fusion_snapshot_missing', true), true)
})
