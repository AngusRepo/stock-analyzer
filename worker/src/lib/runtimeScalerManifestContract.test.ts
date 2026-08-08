import assert from 'node:assert/strict'
import fs from 'node:fs'

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-runtime-scaling.json', 'utf8'))
const identities = JSON.parse(fs.readFileSync('../infra/gcp-runtime-identities.json', 'utf8'))
const syncScript = fs.readFileSync('../scripts/sync_gcp_runtime_scalers.ps1', 'utf8')

assert(!manifest.schedules.some((row: any) => row.name === 'ml-controller-min-1-evening'))
assert(manifest.delete_schedule_ids.includes('ml-controller-min-1-evening'))
assert.equal(manifest.evening_window_policy.enabled, false)
assert(!Object.hasOwn(identities.scheduler_oauth_callers, 'ml-controller-min-1-evening'))

const monthlyMin1 = manifest.schedules.find((row: any) => row.name === 'ml-controller-min-1-monthly-sat')
const monthlyMin0 = manifest.schedules.find((row: any) => row.name === 'ml-controller-min-0-monthly-sat')
assert.equal(monthlyMin1?.cron, 'first saturday of month 09:50')
assert.equal(monthlyMin0?.cron, 'first saturday of month 16:30')

assert(syncScript.includes('"run", "jobs", "add-iam-policy-binding"'))
assert(syncScript.includes('"--role=roles/run.invoker"'))
assert(syncScript.includes('get-iam-policy $jobName'))
assert(syncScript.includes('$deleteScheduleIds.Contains($scheduleName)'))
assert(syncScript.includes('preserve unmanaged runtime scaler schedule'))

console.log('runtime scaler manifest contract tests passed')
