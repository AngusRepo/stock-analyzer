import assert from 'node:assert/strict'
import fs from 'node:fs'

const sync = fs.readFileSync('../scripts/sync_gcp_scheduler.ps1', 'utf8')
const candidate = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.consolidated-candidate.json', 'utf8')) as {
  mutationAllowed: boolean
  deleteJobIds: string[]
  jobs: Array<{ id: string; uriPath?: string; maxRetryAttempts?: number; minBackoff?: string; maxBackoff?: string; maxRetryDuration?: string }>
}

assert(sync.includes('Manifest blocks production mutation'), 'candidate manifest must fail closed outside DryRun')
assert(sync.includes('$job.uriPath'), 'sync must support dedicated scheduler batch routes')
assert(sync.includes("$uriPath.StartsWith('/api/admin/')"), 'custom scheduler URI paths must stay under admin routes')
assert(sync.includes('$deleteIds.Contains($jobId)'), 'stale deletion must require an explicit manifest allowlist')
assert(sync.includes('[scheduler-sync] preserve unmanaged'), 'remote jobs owned by runtime scalers must remain visible and preserved')
assert(sync.includes('--max-retry-attempts'), 'batch jobs must be able to retry failed constituent tasks')
assert(sync.includes('--max-retry-duration'), 'batch retry duration must be bounded explicitly')
assert(!sync.includes('if (-not $managedIds.Contains($jobId)) {\n      Write-Host "[scheduler-sync] delete stale'), 'unscoped stale deletion must never return')

assert.equal(candidate.mutationAllowed, false)
assert(candidate.deleteJobIds.length > 0)
assert(candidate.jobs.some((job) => job.uriPath?.startsWith('/api/admin/scheduler-batch/')))
const batchJobs = candidate.jobs.filter((job) => job.uriPath?.startsWith('/api/admin/scheduler-batch/'))
assert(batchJobs.every((job) => job.maxRetryAttempts === 3 && job.minBackoff === '30s' && job.maxBackoff === '300s' && job.maxRetryDuration === '1800s'))

console.log(`schedulerConsolidationSyncContract: PASS delete_allowlist=${candidate.deleteJobIds.length}`)
