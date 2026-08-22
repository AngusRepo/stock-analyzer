import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const lease = readFileSync(new URL('./s12ResearchLease.ts', import.meta.url), 'utf8')
const researchStructure = readFileSync(new URL('./s12ResearchStructureSnapshots.ts', import.meta.url), 'utf8')
const replay = readFileSync(new URL('./s12ReplayTradeOutcome.ts', import.meta.url), 'utf8')
const wrangler = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8')

assert(lease.includes("'s12:research-market-data'"), 'structure reconstruction and replay Kbar traffic must share one D1 lease')
assert(lease.includes('scheduler_locks.expires_at <= excluded.created_at'), 'abandoned research leases must expire')
assert(lease.includes('AND run_id = ?'), 'only the owning run may release the research lease')
assert(researchStructure.includes("acquireS12ResearchLease(opsDb"), 'research structure lease must use Ops D1')
assert(researchStructure.includes("listApprovedS12TwCalibrationArtifacts(learningDb"), 'research structure calibration must use Learning D1')
assert(replay.includes("acquireS12ResearchLease(opsDb"), 'historical replay lease must use Ops D1')
assert(replay.includes("persistS12ReplayOutcome(learningDb"), 'historical replay outcomes must use Learning D1')
assert(replay.includes("databaseForDataDomain(env, 'market')"), 'next executable session must use Market D1')
assert(wrangler.includes('cpu_ms = 300_000'), 'serialized S12 replay must not inherit the 30 second queue CPU default')
