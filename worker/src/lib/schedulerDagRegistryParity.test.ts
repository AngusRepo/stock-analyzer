import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SCHEDULER_STATUS_JOB_DEFS } from './schedulerStatus'

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')) as {
  jobs: Array<{ id: string; task: string }>
}
const registryIds = new Set(SCHEDULER_STATUS_JOB_DEFS.map((job) => job.id))
const missingPhysicalRoots = manifest.jobs
  .filter((job) => !registryIds.has(job.id) && !registryIds.has(job.task))
  .map((job) => job.id)
  .sort()
assert.deepEqual(missingPhysicalRoots, [], 'every manifest physical root must have an exact or task-level Scheduler API owner')

const source = fs.readFileSync('../frontend/src/components/observability/ExecutionChainPanel.tsx', 'utf8')
assert.doesNotMatch(source, /\['weekly-drift-retrain'\]/)
assert.doesNotMatch(source, /\['storage-capacity-report'\]/)
assert.match(source, /duplicateScopeJobIds/)
assert.match(source, /Active-8 daily evidence/)
assert.match(source, /Active-8 weekly cohort/)
assert.match(source, /Active-8 monthly release/)

console.log(`scheduler DAG registry parity passed physical_roots=${manifest.jobs.length} registry_jobs=${registryIds.size}`)
