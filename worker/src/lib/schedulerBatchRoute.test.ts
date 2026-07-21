import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createAdminTriggerRoutes } from '../routes/adminTriggerRoutes'

const token = 'scheduler-test-token'
const env = { STOCKVISION_AUTH_TOKEN: token } as any
const routes = createAdminTriggerRoutes({ buildTaskMap: () => ({}) })
const app = new Hono<any>()
app.route('/', routes)

async function main(): Promise<void> {
{
  const response = await app.request(
    'https://worker.invalid/api/admin/scheduler-batch/daily-1900-maintenance?dry_run=1&scheduled_time=2026-07-19T19%3A00%3A00Z',
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    env,
  )
  assert.equal(response.status, 200)
  const body = await response.json() as any
  assert.equal(body.success, true)
  assert.equal(body.dry_run, true)
  assert.deepEqual(body.due.map((job: any) => job.id), ['debate-memory-retention', 'orphan-reachability-gc'])
}

{
  const response = await app.request(
    'https://worker.invalid/api/admin/scheduler-batch/daily-1900-maintenance?dry_run=1&scheduled_time=2026-07-19T19%3A00%3A00Z',
    { method: 'POST' },
    env,
  )
  assert.equal(response.status, 401, 'batch route must keep service-token authentication')
}

{
  const response = await app.request(
    'https://worker.invalid/api/admin/scheduler-batch/daily-1900-maintenance',
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    env,
  )
  assert.equal(response.status, 400, 'live dispatch must require Cloud Scheduler original schedule time')
}

{
  const response = await app.request(
    'https://worker.invalid/api/admin/scheduler-batch/unknown?dry_run=1&scheduled_time=2026-07-19T19%3A00%3A00Z',
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    env,
  )
  assert.equal(response.status, 404)
}

console.log('schedulerBatchRoute: PASS')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
