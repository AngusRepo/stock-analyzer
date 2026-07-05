import assert from 'node:assert'
import {
  ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE_ENV,
  ALLOCATOR_CONTRACT_GUARD_ENV,
  allocatorContractGuardEnabled,
  assertAllocatorContractRunDate,
} from './allocatorContractGuard'

function clearGuardEnv(): void {
  delete process.env[ALLOCATOR_CONTRACT_GUARD_ENV]
  delete process.env[ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE_ENV]
  delete process.env['STOCKVISION_' + 'SIZING' + '_CANARY']
  delete process.env['STOCKVISION_' + 'CANARY' + '_ALLOWED_RUN_DATE']
}

clearGuardEnv()
assert.equal(allocatorContractGuardEnabled(), false)
assert.doesNotThrow(() => assertAllocatorContractRunDate('', 'screener node runner'))

clearGuardEnv()
process.env['STOCKVISION_' + 'SIZING' + '_CANARY'] = '1'
assert.equal(allocatorContractGuardEnabled(), false, 'legacy sizing env must not enable allocator guard')
assert.doesNotThrow(() => assertAllocatorContractRunDate('2026-07-04', 'screener node runner'))

clearGuardEnv()
process.env[ALLOCATOR_CONTRACT_GUARD_ENV] = '1'
assert.throws(
  () => assertAllocatorContractRunDate('2026-07-04', 'screener node runner'),
  new RegExp(ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE_ENV),
)

clearGuardEnv()
process.env[ALLOCATOR_CONTRACT_GUARD_ENV] = '1'
process.env[ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE_ENV] = '2026-07-04'
assert.throws(
  () => assertAllocatorContractRunDate('2026-07-03', 'screener node runner'),
  /blocked; allowed=2026-07-04/,
)
assert.doesNotThrow(() => assertAllocatorContractRunDate('2026-07-04', 'screener node runner'))

clearGuardEnv()
