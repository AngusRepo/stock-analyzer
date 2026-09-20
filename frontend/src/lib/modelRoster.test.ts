import assert from 'node:assert/strict'
import test from 'node:test'
import { formalModelSlots, MODEL_POOL_ACTIVE_ALPHA_MODEL_IDS } from './modelUpgradeTrack'
test('published roster alone replaces DLinear; no nine-model display', () => {
  const legacy = [...MODEL_POOL_ACTIVE_ALPHA_MODEL_IDS]
  assert.deepEqual(formalModelSlots(), legacy)
  const next = legacy.map(name => name === 'DLinear' ? 'TimeXer' : name)
  assert.deepEqual(formalModelSlots(next), next)
  assert.deepEqual(formalModelSlots([...legacy, 'TimeXer']), [])
  assert.deepEqual(formalModelSlots(['TimeXer']), [])
})
