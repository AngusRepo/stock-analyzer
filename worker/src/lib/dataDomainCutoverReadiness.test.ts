import assert from 'node:assert/strict'
import { inspectDataDomainCutoverReadiness } from './dataDomainCutoverReadiness'

void (async () => {
  const db = {
    prepare: (sql: string) => ({
      bind: (..._binds: unknown[]) => ({
        first: async () => sql.includes('data_domain_cutovers') ? { status: 'shadow' } : { count: 0 },
      }),
    }),
  } as any
  const report = await inspectDataDomainCutoverReadiness(db, 'market')
  assert.equal(report.strict_enable_allowed, false)
  assert.equal(report.domains[0].cutover_ready, false)
  assert(report.domains[0].blockers.includes('domain_access_router_not_closed'))
  assert(report.domains[0].blockers.includes('initial_copy_incomplete'))
})().catch((error) => {
  throw error
})
