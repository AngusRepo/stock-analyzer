import assert from 'node:assert/strict'
import test from 'node:test'
import { recoverPaperMorningSetup } from './paperMorningRecovery'

function fixture(status: string | null) {
  const events: string[] = []
  let current = status
  const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => {
    events.push('read_run'); return current === null ? null : { status: current }
  } }) }) } } as any
  const dependencies = { source: async () => { events.push('source') }, setup: async () => {
    events.push('setup'); current = 'empty'
  } }
  const settle = async () => { events.push('settle') }
  return { env, events, dependencies, settle }
}

for (const status of [null, 'error']) test(`preopen repairs ${status} with original owners and readback`, async () => {
  const f = fixture(status)
  assert.equal(await recoverPaperMorningSetup(f.env, '2026-09-08', f.settle, f.dependencies),
    'recovered_missing_morning_decision')
  assert.deepEqual(f.events, ['source', 'settle', 'read_run', 'setup', 'read_run'])
  f.events.length = 0
  await recoverPaperMorningSetup(f.env, '2026-09-08', f.settle, f.dependencies)
  assert.deepEqual(f.events, ['source', 'settle', 'read_run'])
})

for (const status of ['ready', 'empty', 'halted']) test(`preopen preserves ${status}, including a no-buy decision`, async () => {
  const f = fixture(status)
  await recoverPaperMorningSetup(f.env, '2026-09-08', f.settle, f.dependencies)
  assert.deepEqual(f.events, ['source', 'settle', 'read_run'])
})

test('source failure, unknown state and missing setup readback never claim recovery', async () => {
  const f = fixture(null)
  await assert.rejects(recoverPaperMorningSetup(f.env, '2026-09-08', f.settle,
    { ...f.dependencies, source: async () => { throw new Error('source_down') } }), /source_down/)
  assert.deepEqual(f.events, [])
  const invalid = fixture('unexpected')
  await assert.rejects(recoverPaperMorningSetup(invalid.env, '2026-09-08', invalid.settle, invalid.dependencies), /unknown_run_status/)
  await assert.rejects(recoverPaperMorningSetup(f.env, '2026-09-08', f.settle,
    { ...f.dependencies, setup: async () => {} }), /setup_not_materialized/)
})
