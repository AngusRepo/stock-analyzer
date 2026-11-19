import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { ensureSameSessionSectorFlow } from './sectorFlowPreScreener'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string, type?: string) {
      const value = store.get(key)
      if (value == null) return null
      return type === 'json' ? JSON.parse(value) : value
    },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
    async list() { return { keys: [], list_complete: true } },
  }
}

const date = '2026-11-18'

function logged(kv: ReturnType<typeof memoryKv>) {
  return JSON.parse(kv.store.get(`scheduler:run:sector-flow-pre-screener:${date}`) ?? 'null')
}

test('closes sector_flow(D) through the controller before the screener', async () => {
  const kv = memoryKv()
  const calls: Array<{ path: string; body: unknown }> = []
  const summary = await ensureSameSessionSectorFlow({ KV: kv } as any, date, 'run-1', (async (_env: unknown, path: string, options: any) => {
    calls.push({ path, body: options.jsonBody })
    return Response.json({ as_of_date: date, status: 'computed', rebuild_run_id: 'sector-flow:x', closure: { status: 'complete' } })
  }) as any)
  assert.deepEqual(calls, [{ path: '/sector-flow/daily-closure', body: { date } }])
  assert.match(summary, /status=computed rebuild_run_id=sector-flow:x/)
  assert.equal(logged(kv).status, 'success')
  assert.equal(logged(kv).run_id, 'run-1')
})

test('a failed or unconfirmed closure leaves the evidence missing without stopping the chain', async () => {
  for (const response of [
    new Response('sector_flow_daily_closure_failed:boom', { status: 500 }),
    Response.json({ as_of_date: '2026-11-17', status: 'already_complete', closure: { status: 'complete' } }),
    Response.json({ as_of_date: date, status: 'computed', closure: { status: 'failed' } }),
  ]) {
    const kv = memoryKv()
    const summary = await ensureSameSessionSectorFlow({ KV: kv } as any, date, 'run-1', (async () => response) as any)
    assert.match(summary, /^sector_flow unavailable before screener:/)
    assert.equal(logged(kv).status, 'error')
  }
  const kv = memoryKv()
  const summary = await ensureSameSessionSectorFlow({ KV: kv } as any, date, 'run-1', (async () => {
    throw new Error('The operation was aborted due to timeout')
  }) as any)
  assert.match(summary, /timeout/)
  assert.equal(logged(kv).status, 'error')
})

test('finalizer closes sector_flow after same-date regime and before the screener trigger', () => {
  const source = fs.readFileSync(new URL('./updateOrchestrator.ts', import.meta.url), 'utf8')
  const finalizer = source.slice(source.indexOf('async function runFinalizeContinuation('))
  const regime = finalizer.indexOf('await ensureSameDateRegimeReady(')
  const sector = finalizer.indexOf('await ensureSameSessionSectorFlow(env, triggerTime, runId)')
  const screener = finalizer.indexOf('const runAsyncScreener')
  assert.ok(regime > 0 && sector > regime && screener > sector)
  assert.ok(finalizer.indexOf('deps.runMarketScreener(env, triggerTime)') > sector, 'the synchronous screener path is covered too')
})
