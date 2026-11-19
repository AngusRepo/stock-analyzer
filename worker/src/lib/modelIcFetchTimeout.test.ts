import { modelIcFetchTimeoutMs } from './controllerDailyWorkflows'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const now = 1_000_000
assert(modelIcFetchTimeoutMs(undefined, now) === 120_000, 'callers without a task budget keep the 120s default')
assert(modelIcFetchTimeoutMs(now + 180_000, now) === 160_000, 'a fresh 180s post-verify budget leaves 20s for evidence capture')
assert(modelIcFetchTimeoutMs(now + 60_000, now) === 40_000, 'the timeout shrinks with the remaining budget')
assert(modelIcFetchTimeoutMs(now + 5_000, now) === 1_000, 'an exhausted budget still yields a positive timeout')
assert(modelIcFetchTimeoutMs(Number.NaN, now) === 120_000, 'a non-finite deadline falls back to the default')
console.log('modelIcFetchTimeout tests passed')
