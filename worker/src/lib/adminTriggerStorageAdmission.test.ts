import assert from 'node:assert/strict'
import test from 'node:test'
import { createAdminTriggerRoutes } from '../routes/adminTriggerRoutes'

function memoryKv(): KVNamespace & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get: async (key: string, type?: string) => {
      const value = values.get(key) ?? null
      if (value == null || type !== 'json') return value
      return JSON.parse(value)
    },
    put: async (key: string, value: string) => {
      values.set(key, value)
    },
  } as unknown as KVNamespace & { values: Map<string, string> }
}

function capacityDb(sizeAfter?: number, error?: Error): D1Database {
  return {
    prepare: () => ({
      all: async () => {
        if (error) throw error
        return { results: [{ storage_admission_probe: 1 }], meta: { size_after: sizeAfter } }
      },
    }),
  } as unknown as D1Database
}

async function triggerManagedTask(input: { sizeAfter?: number; error?: Error }) {
  let taskCalls = 0
  const routes = createAdminTriggerRoutes({
    buildTaskMap: () => ({
      'weekly-backtest': async () => {
        taskCalls += 1
        return 'unexpected execution'
      },
    }),
  })
  const kv = memoryKv()
  const env = {
    LOCAL_AUTH_BYPASS: '1',
    ENVIRONMENT: 'test',
    DB: capacityDb(input.sizeAfter, input.error),
    KV: kv,
  } as any
  const response = await routes.request(
    'https://stockvision.invalid/api/admin/trigger/weekly-backtest?force=1&sync=1',
    { method: 'POST' },
    env,
  )
  return { response, body: await response.json() as any, taskCalls, kv }
}

test('admin trigger returns 507 and never calls task function at critical capacity', async () => {
  const result = await triggerManagedTask({ sizeAfter: 9_000_000_000 })
  assert.equal(result.response.status, 507)
  assert.equal(result.body.success, false)
  assert.equal(result.body.storage_admission.status, 'critical')
  assert.equal(result.body.storage_admission.utilizationPct, 90)
  assert.equal(result.taskCalls, 0, 'force=1 must not bypass storage admission')
  assert(
    [...result.kv.values.values()].some((value) => value.includes('blocked by storage admission')),
    'blocked decision must remain visible in scheduler logs',
  )
})

test('admin trigger fails closed and never calls task function when capacity probe fails', async () => {
  const result = await triggerManagedTask({ error: new Error('capacity probe unavailable') })
  assert.equal(result.response.status, 507)
  assert.equal(result.body.success, false)
  assert.equal(result.body.storage_admission.status, 'unknown')
  assert.equal(result.body.storage_admission.reason, 'legacy_d1_capacity_unknown')
  assert.equal(result.taskCalls, 0)
})
