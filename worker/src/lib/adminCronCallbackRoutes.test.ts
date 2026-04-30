import { adminControlRoutes } from '../routes/adminControlRoutes'
import type { Bindings } from '../types'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const writes: Array<{ key: string; value: string }> = []
const env = {
  STOCKVISION_AUTH_TOKEN: 'service-token',
  KV: {
    get: async () => null,
    put: async (key: string, value: string) => {
      writes.push({ key, value })
    },
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true }),
  },
} as unknown as Bindings

void (async () => {
  {
    const res = await adminControlRoutes.request('/api/admin/cron-callback', {
      method: 'POST',
      body: JSON.stringify({ task: 'verify-v2', status: 'success' }),
    }, env)
    assert(res.status === 401, 'cron callback should require service token')
  }

  {
    const res = await adminControlRoutes.request('/api/admin/cron-callback', {
      method: 'POST',
      headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'verify-v2', status: 'done' }),
    }, env)
    assert(res.status === 400, 'cron callback should reject invalid status')
  }

  {
    const res = await adminControlRoutes.request('/api/admin/cron-callback', {
      method: 'POST',
      headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'verify-v2',
        status: 'success',
        summary: 'verified 12/12',
        duration_ms: 1234,
        run_id: 'run-123',
      }),
    }, env)
    assert(res.status === 200, 'cron callback should accept service token')
    const body = await res.json() as any
    assert(body.ok === true && body.task === 'verify-v2', 'cron callback should return accepted task')
    assert(writes.some((write) => write.key.includes('cron:log:verify-v2:')), 'cron callback should persist cron log')
    const entry = JSON.parse(writes.find((write) => write.key.includes('cron:log:verify-v2:'))!.value)
    assert(entry.status === 'success', 'persisted cron log should keep callback status')
    assert(entry.summary === 'verified 12/12', 'persisted cron log should keep callback summary')
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
