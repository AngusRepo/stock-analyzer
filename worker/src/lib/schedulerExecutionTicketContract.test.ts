import assert from 'node:assert/strict'
import fs from 'node:fs'

const route = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const consumer = fs.readFileSync('src/lib/durableSchedulerTask.ts', 'utf8')
const status = fs.readFileSync('src/lib/schedulerStatus.ts', 'utf8')
const types = fs.readFileSync('src/types.ts', 'utf8')
const registry = fs.readFileSync('src/lib/dataDomainRegistry.ts', 'utf8')
const schema = fs.readFileSync('domain-schemas/ops.sql', 'utf8')
const migration = fs.readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql', 'utf8')
const cleanup = fs.readFileSync('src/lib/localMaintenance.ts', 'utf8')
const deploy = fs.readFileSync('../tools/deploy_worker_with_provenance.mjs', 'utf8')
const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')) as {
  jobs: Array<{ id: string; task: string; attemptDeadline?: string; retryConfig?: { retryCount?: number; maxRetryDuration?: string } }>
}

assert.equal(manifest.jobs.length, 59)
const retryEnabled = manifest.jobs.filter((job) => Number(job.retryConfig?.retryCount ?? 0) > 0)
assert.deepEqual(
  retryEnabled.map((job) => job.id).sort(),
  ['external-evidence', 'weekly-cleanup', 'weekly-s12-smcvwap-calibration'],
)
for (const job of retryEnabled) {
  assert.equal(job.attemptDeadline, '60s')
  assert.equal(job.retryConfig?.retryCount, 2)
  assert.equal(job.retryConfig?.maxRetryDuration, '900s')
}
assert.match(migration, /CREATE TABLE IF NOT EXISTS scheduler_execution_tickets_v1/)
assert.match(migration, /dedupe_key TEXT NOT NULL UNIQUE/)
assert.match(migration, /ticket_kind IN \('physical_root','logical_child','manual'\)/)
assert.match(migration, /attempt_count >= 1 AND attempt_count <= 3/)
assert.match(migration, /expires_at TEXT NOT NULL DEFAULT \(datetime\('now', '\+400 days'\)\)/)
assert.match(schema, /CREATE TABLE IF NOT EXISTS scheduler_execution_tickets_v1/)
assert.match(registry, /'scheduler_execution_tickets_v1'/)

const admissionIndex = route.indexOf('admitSchedulerExecutionTicket(ticketDb')
const policyIndex = route.indexOf('shouldRunScheduledTask({ task')
const executionIndex = route.indexOf('const result = await fn()')
assert(admissionIndex > 0 && admissionIndex < policyIndex && policyIndex < executionIndex)
assert.match(route, /schedulerDeliveryIdentity\(c\.req\.raw\.headers\)/)
assert.match(route, /databaseForDataDomain\(c\.env, 'ops'\)/)
assert.match(route, /schedulerTicketId,/)
assert.match(route, /ticket_id: schedulerTicketId/)
assert.match(types, /schedulerTicketId\?: string/)

assert.match(consumer, /await updateTicket\('running', 'durable queue consumer started'\)/)
assert.match(consumer, /schedulerTicketStatusForRunLog\(status\)/)
assert.match(consumer, /await updateTicket\('error', result\.summary, result\.error\)/)

assert.match(status, /loadSchedulerExecutionTickets\(opsDb, dates\)/)
assert.match(status, /executionTicketsByTaskDate/)
assert.match(status, /statusAuthority: 'scheduler_execution_ticket'/)
assert.match(status, /ticketContractRoots: SCHEDULER_TICKET_CONTRACT_ROOTS/)
assert.match(status, /observedTicketRoots:/)
assert.match(status, /terminalTicketRoots:/)
assert.match(cleanup, /scheduler_execution_ticket_terminal_400d/)
assert.match(cleanup, /status IN \('success','error','skipped','blocked'\)/)
assert(
  deploy.indexOf('SELECT ticket_id FROM scheduler_execution_tickets_v1 LIMIT 0;')
    < deploy.indexOf("wranglerCli, 'deploy', '--strict'"),
  'Worker deploy must fail closed on remote Ops 0011 readback before uploading code',
)

console.log('scheduler execution ticket contract passed')
