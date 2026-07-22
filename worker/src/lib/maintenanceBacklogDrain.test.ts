import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import { enqueueMaintenanceBacklogDrain } from './maintenanceBacklogDrain'

void (async () => {
  const values = new Map<string, string>()
  const messages: unknown[] = []
  const env = {
    KV: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value) },
      delete: async (key: string) => { values.delete(key) },
    },
    UPDATE_QUEUE: {
      send: async (message: unknown) => { messages.push(message) },
    },
  } as any

  const first = await enqueueMaintenanceBacklogDrain(env, {
    task: 'legacy-strategy-evidence-migration',
    runDate: '2026-07-22',
    runId: 'drain-1',
  })
  const duplicate = await enqueueMaintenanceBacklogDrain(env, {
    task: 'legacy-strategy-evidence-migration',
    runDate: '2026-07-22',
    runId: 'drain-2',
  })

  assert.equal(first.queued, true)
  assert.equal(duplicate.queued, false)
  assert.equal(duplicate.runId, 'drain-1')
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0], {
    type: 'maintenance_backlog_drain',
    maintenanceTask: 'legacy-strategy-evidence-migration',
    cursor: 0,
    triggerTime: '2026-07-22',
    runId: 'drain-1',
    attempt: 0,
    maxAttempts: 240,
  })

  const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
  assert.match(orchestrator, /msg\.type === 'maintenance_backlog_drain'/)
  assert.match(orchestrator, /processMaintenanceBacklogDrain/)
  const scheduler = fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')
  assert.match(scheduler, /legacy-strategy-evidence-migration[^\n]+durable=1/)
})().catch((error) => {
  throw error
})
