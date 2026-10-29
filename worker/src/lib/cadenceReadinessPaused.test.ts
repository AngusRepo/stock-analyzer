import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import schedulerManifest from '../../../infra/gcp-scheduler-jobs.json'
import { cadenceRequiredTasks, runCadenceReadiness } from './cadenceReadiness'

// D7c: readiness follows the scheduler manifest's desiredState, not a hardcoded job list.
const pausedInManifest = new Set((schedulerManifest.jobs as Array<{ id: string; desiredState?: string }>)
  .filter((job) => job.desiredState === 'PAUSED').map((job) => job.id))

for (const cadence of ['weekly', 'monthly'] as const) {
  const { required, pausedExpected } = cadenceRequiredTasks(cadence)
  for (const task of required) assert.ok(!pausedInManifest.has(task), `${cadence}: PAUSED ${task} must not be required`)
  for (const task of pausedExpected) assert.ok(pausedInManifest.has(task), `${cadence}: ${task} is reported only when PAUSED`)
  assert.ok(required.length > 0)

  const nothingPaused = cadenceRequiredTasks(cadence, () => false)
  assert.deepEqual(nothingPaused.pausedExpected, [])
  assert.deepEqual([...nothingPaused.required].sort(), [...required, ...pausedExpected].sort(),
    'an ENABLED job stays required')
}

// End to end: every required job succeeded, the PAUSED active8 job last failed weeks ago -> readiness closes.
async function pausedActive8DoesNotBlockWeeklyReadiness() {
  const date = '2026-11-01'
  const { required, pausedExpected } = cadenceRequiredTasks('weekly')
  assert.ok(pausedExpected.includes('active8-oof-weekly'), 'manifest pauses active8-oof-weekly; update this test when it is re-enabled')
  const sql = new DatabaseSync(':memory:')
  sql.exec(`CREATE TABLE pipeline_stage_runs (business_date TEXT,stage TEXT,canonical_run_id TEXT,status TEXT,cursor_key TEXT,
    processed_count INTEGER DEFAULT 0,persisted_count INTEGER DEFAULT 0,expected_count INTEGER,attempt_count INTEGER DEFAULT 0,
    queued_at TEXT,started_at TEXT,completed_at TEXT,lease_owner TEXT,lease_expires_at TEXT,last_error TEXT,updated_at TEXT,
    PRIMARY KEY(business_date,stage))`)
  sql.exec(fs.readFileSync(new URL('../../domain-migrations/ops/0011_scheduler_execution_tickets.sql', import.meta.url), 'utf8'))
  const statement = (query: string, args: any[] = []): any => ({
    bind: (...values: any[]) => statement(query, values),
    all: async () => ({ success: true, results: sql.prepare(query).all(...args) }),
    first: async () => sql.prepare(query).get(...args) ?? null,
    run: async () => ({ success: true, meta: { changes: Number(sql.prepare(query).run(...args).changes) } }),
  })
  const db = { prepare: statement }
  const values = new Map<string, any>()
  const kv = {
    get: async (key: string, type?: string) => values.has(key) ? (type === 'json' ? values.get(key) : JSON.stringify(values.get(key))) : null,
    put: async (key: string, value: string) => { values.set(key, JSON.parse(value)) },
    list: async () => ({ keys: [], list_complete: true }),
  }
  for (const task of required) {
    values.set(`scheduler:run:${task}:${date}`, { task, status: 'success', run_date: date, summary: 'ok', duration_ms: 10, timestamp: '2026-10-31T20:00:00Z' })
  }
  values.set('scheduler:run:active8-oof-weekly:2026-10-19', {
    task: 'active8-oof-weekly', status: 'error', run_date: '2026-10-19', summary: 'paused job', duration_ms: 10, timestamp: '2026-10-18T23:05:00Z',
  })
  try {
    const out = await runCadenceReadiness({ DB: db, OPS_DB: db, KV: kv } as any, 'weekly', date)
    assert.match(out, /^weekly_readiness_closed /)
    assert.match(out, /paused_expected=\["active8-oof-weekly"\]/)
  } finally {
    sql.close()
  }
}

pausedActive8DoesNotBlockWeeklyReadiness().then(() => {
  console.log('cadence readiness paused-job tests passed')
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
