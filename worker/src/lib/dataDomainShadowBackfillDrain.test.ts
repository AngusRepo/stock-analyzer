import assert from 'node:assert/strict'
import fs from 'node:fs'

const drain = fs.readFileSync('src/lib/dataDomainShadowBackfillDrain.ts', 'utf8')
const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const admin = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const types = fs.readFileSync('src/types.ts', 'utf8')

assert(drain.includes("leaseGroup: 'd1_heavy_maintenance'"))
assert(drain.includes('tablesForDataDomainShadowBackfill'))
assert(drain.includes('requestedTable && backfillTables.includes(requestedTable)'))
assert(drain.includes('nextIncompleteTable'))
assert(drain.includes("status: result.domain_shadow_ready ? 'success' : 'error'"))
assert(drain.includes("status: checksumReady ? 'success' : 'error'"))
assert(drain.includes('checksum_ready='))
assert(orchestrator.includes("msg.type === 'data_domain_shadow_backfill'"))
assert(admin.includes("c.req.query('durable') === '1'"))
assert(admin.includes('enqueueDataDomainShadowBackfill'))
assert(types.includes("| 'data_domain_shadow_backfill'"))
assert(types.includes('dataDomainTable?: string'))

console.log('data domain shadow backfill drain contract tests passed')