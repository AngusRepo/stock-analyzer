import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const lease = readFileSync(new URL('./s12ResearchLease.ts', import.meta.url), 'utf8')
const researchStructure = readFileSync(new URL('./s12ResearchStructureSnapshots.ts', import.meta.url), 'utf8')
const replay = readFileSync(new URL('./s12ReplayTradeOutcome.ts', import.meta.url), 'utf8')
const durableCalibration = readFileSync(new URL('./durableSchedulerTask.ts', import.meta.url), 'utf8')
const manualTasks = readFileSync(new URL('./adminTriggerWorkerDomainTasks.ts', import.meta.url), 'utf8')
const adminRoutes = readFileSync(new URL('../routes/adminTriggerRoutes.ts', import.meta.url), 'utf8')
const wrangler = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8')

assert(lease.includes("'s12:research-market-data'"), 'structure reconstruction and replay Kbar traffic must share one D1 lease')
assert(lease.includes('scheduler_locks.expires_at <= excluded.created_at'), 'abandoned research leases must expire')
assert(lease.includes('AND run_id = ?'), 'only the owning run may renew or release the research lease')
assert(lease.includes('assertS12ResearchLeaseRenewed'), 'long S12 writers need an exact-CAS lease heartbeat')
assert(lease.includes('expires_at > ?'), 'an expired or replaced owner must fail closed instead of resurrecting its lease')
assert(lease.includes('S12_RESEARCH_LEASE_DEFAULT_SECONDS = 1800'), 'research lease must cover the legal 20x60s workload plus margin')
assert(durableCalibration.includes('acquireS12ResearchLeaseDetailed'), 'calibration must share the replay writer lease before page one')
assert(durableCalibration.includes('finally') && durableCalibration.includes('releaseS12ResearchLease(opsDb, researchLeaseRunId)'), 'calibration must exact-release the shared lease after atomic commit or failure')
assert(!manualTasks.includes('runS12TwCalibration('), 'manual domain task must not bypass the durable shared-lock wrapper')
assert(adminRoutes.includes("task === 's12-smcvwap-calibration' && syncMode"), 'manual sync calibration bypass must return 409')
assert(researchStructure.includes("acquireS12ResearchLease(opsDb"), 'research structure lease must use Ops D1')
assert(researchStructure.includes('await assertLeaseOwned()'), 'research structure must heartbeat before external work and persistence')
assert(researchStructure.includes('isS12ResearchLeaseLost(error)'), 'research structure must not swallow lost-lease errors')
assert(researchStructure.includes("listApprovedS12TwCalibrationArtifacts(learningDb"), 'research structure calibration must use Learning D1')
assert(replay.includes("acquireS12ResearchLease(opsDb"), 'historical replay lease must use Ops D1')
assert(replay.includes('await assertLeaseOwned()'), 'historical replay must heartbeat each row and immediately before persistence')
assert(replay.includes("persistS12ReplayOutcome(learningDb"), 'historical replay outcomes must use Learning D1')
assert(replay.includes("databaseForDataDomain(env, 'market')"), 'next executable session must use Market D1')
assert(wrangler.includes('cpu_ms = 300_000'), 'serialized S12 replay must not inherit the 30 second queue CPU default')
