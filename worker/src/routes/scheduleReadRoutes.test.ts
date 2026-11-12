import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import * as governance from '../lib/schedulerManifestGovernance'
import * as routes from './scheduleReadRoutes'

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')) as {
  jobs: Array<{ id: string; schedule: string; timeZone?: string }>
}

type Row = { task: string; tw_time: string; owner: string }

async function scheduleRows(): Promise<Row[]> {
  const response = await routes.scheduleReadRoutes.request('/api/cron/schedule')
  return ((await response.json()) as { schedule: Row[] }).schedule
}

function derived(jobId: string): string | null {
  try { return governance.manifestTwWindow(jobId) } catch { return null }
}

test('manifestTwWindow reads one daily minute or a repeating window in Taiwan time and rejects other crons', () => {
  const source = { timeZone: 'UTC', jobs: [
    { id: 'single', schedule: '45 13 * * 1-5' },
    { id: 'wrap', schedule: '*/5 13-22 * * 1-5' },
    { id: 'taipei', schedule: '*/10 7-8 * * 1-5', timeZone: 'Asia/Taipei' },
    { id: 'sunday-evening-utc', schedule: '30 22 * * 0-4' },
    { id: 'weekly', schedule: '30 10 * * 5' },
    { id: 'list', schedule: '25,55 18-23 * * *' },
    { id: 'monthly', schedule: 'first sunday of month 02:00', timeZone: 'Asia/Taipei' },
  ] }
  assert.equal(governance.manifestTwWindow('single', source), '21:45')
  assert.equal(governance.manifestTwWindow('wrap', source), '21:00-06:55 / 5m')
  assert.equal(governance.manifestTwWindow('taipei', source), '07:00-08:50 / 10m')
  assert.equal(governance.manifestTwWindow('sunday-evening-utc', source), '06:30')
  for (const id of ['weekly', 'list', 'monthly', 'missing']) {
    assert.throws(() => governance.manifestTwWindow(id, source), /manifest_tw_window_unsupported/)
  }
})

test('every gcp_scheduler schedule row is a manifest job and shows the manifest time', async () => {
  const rows = await scheduleRows()
  const jobs = new Map(manifest.jobs.map((job) => [job.id, job]))
  const gcpRows = rows.filter((row) => row.owner === 'gcp_scheduler')
  assert.ok(gcpRows.length > 20)
  for (const row of gcpRows) {
    const jobId = routes.SCHEDULE_ROW_MANIFEST_JOB?.[row.task] ?? row.task
    assert.ok(jobs.has(jobId), `${row.task}: no manifest job ${jobId}`)
    const expected = derived(jobId)
    if (expected != null) assert.equal(row.tw_time, expected, `${row.task} must show the manifest time`)
  }
  const byTask = new Map(rows.map((row) => [row.task, row]))
  // Rows that had drifted from the manifest.
  assert.equal(byTask.get('indicator-queue-watchdog')?.tw_time, '21:00-06:55 / 5m')
  assert.equal(byTask.get('screener-v2-watchdog')?.tw_time, '21:00-06:50 / 10m')
  assert.notEqual(byTask.get('pre-market-warmup')?.owner, 'gcp_scheduler', 'the pre-market-warmup Scheduler job was deleted')
})
