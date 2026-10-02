import assert from 'node:assert/strict'
import test from 'node:test'
import { pairedNativeExecution } from './pairedNativeExecution'
import type { Bindings } from '../types'
const env = (p: object) => ({ KV: { get: async () => ({l4Distribution:p}) } } as unknown as Bindings)
test('single B skips Controller; incorrect policy scope or role is rejected', async () => {
const old = globalThis.fetch
globalThis.fetch = async () => { throw Error('Controller must not be called') }
try {
  assert.match(await pairedNativeExecution(env({operating_mode:'single_b_tabpack_v1',strategy_role:'B',scope:'paper'})), /^skipped: disabled_by_single_b_policy/)
  await assert.rejects(pairedNativeExecution(env({operating_mode:'single_b_tabpack_v1',strategy_role:'A',scope:'paper'})), /policy_invalid/)
  await assert.rejects(pairedNativeExecution(env({operating_mode:'single_b_tabpack_v1',strategy_role:'B',scope:'live'})), /policy_invalid/)
} finally { globalThis.fetch = old }
})
