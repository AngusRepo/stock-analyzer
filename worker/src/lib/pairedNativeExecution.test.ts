import assert from 'node:assert/strict'
import test from 'node:test'
import { pairedNativeExecution } from './pairedNativeExecution'
import type { Bindings } from '../types'

test('retired paired schedule cannot read config or dispatch even without a policy', async () => {
  const old = globalThis.fetch
  globalThis.fetch = async () => { throw Error('Controller must not be called') }
  try {
    const env = new Proxy({}, {get(){throw Error('retired entry must not read bindings')}}) as Bindings
    assert.match(await pairedNativeExecution(env), /^skipped: disabled_by_single_b_policy/)
  } finally { globalThis.fetch = old }
})
