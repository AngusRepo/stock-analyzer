export const ALLOCATOR_CONTRACT_GUARD_ENV = 'STOCKVISION_ALLOCATOR_CONTRACT_GUARD'
export const ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE_ENV = 'STOCKVISION_ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE'

export function envTruthy(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').trim().toLowerCase())
}

export function allocatorContractGuardEnabled(): boolean {
  return envTruthy(ALLOCATOR_CONTRACT_GUARD_ENV)
}

export function assertAllocatorContractRunDate(runDate: string, label: string): void {
  if (!allocatorContractGuardEnabled()) return
  const allowed = (process.env[ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE_ENV] ?? '').trim()
  if (!allowed) {
    throw new Error(`${ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE_ENV} is required when ${ALLOCATOR_CONTRACT_GUARD_ENV}=1`)
  }
  if (!runDate) throw new Error(`${label}: explicit run_date is required for allocator contract guard`)
  if (runDate !== allowed) throw new Error(`${label}: allocator contract run_date=${runDate} blocked; allowed=${allowed}`)
  console.warn(`[AllocatorContractGuard] ${label} enabled for run_date=${runDate}; D1/KV writes are no-op`)
}
