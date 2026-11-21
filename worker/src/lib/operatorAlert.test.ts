import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sendOperatorAlert } from './operatorAlert'
import { logSchedulerRunResult } from './schedulerRunLogger'

type Call = { url: string; init?: RequestInit }

async function withFetch<T>(handler: (url: string, init?: RequestInit) => Promise<Response>, run: (calls: Call[]) => Promise<T>) {
  const calls: Call[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as typeof fetch
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = realFetch
  }
}

function memoryKv() {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string) { return store.get(key) ?? null },
    async put(key: string, value: string) { store.set(key, value) },
  } as unknown as KVNamespace
  return { kv, store }
}

const ok = async () => new Response('ok')

test('ALERT-CH: without LINE secrets the alert posts the same Discord {content} body as before', async () => {
  await withFetch(ok, async (calls) => {
    const result = await sendOperatorAlert({ DISCORD_WEBHOOK_URL: 'https://discord.test/hook', ADMIN_EMAIL: 'wei@example.com' }, 'hello')
    assert.equal(result, 'discord')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://discord.test/hook')
    assert.equal(calls[0].init?.method, 'POST')
    assert.deepEqual(calls[0].init?.headers, { 'Content-Type': 'application/json' })
    assert.equal(calls[0].init?.body, JSON.stringify({ content: 'hello' }))
  })
})

test('ALERT-CH: LINE secrets take priority over Discord', async () => {
  await withFetch(ok, async (calls) => {
    const result = await sendOperatorAlert({
      LINE_CHANNEL_ACCESS_TOKEN: 'line-token', LINE_USER_ID: 'U1', DISCORD_WEBHOOK_URL: 'https://discord.test/hook',
    }, 'hello')
    assert.equal(result, 'line')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/push')
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer line-token')
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { to: 'U1', messages: [{ type: 'text', text: 'hello' }] })
  })
})

test('ALERT-CH: no configured channel sends nothing', async () => {
  await withFetch(ok, async (calls) => {
    assert.equal(await sendOperatorAlert({ ADMIN_EMAIL: 'wei@example.com' }, 'hello'), 'not_sent:no_channel_configured')
    assert.equal(calls.length, 0)
  })
})

test('ALERT-CH: a hung channel is bounded and never blocks the caller', async () => {
  await withFetch(() => new Promise<Response>(() => {}), async () => {
    assert.equal(await sendOperatorAlert({ DISCORD_WEBHOOK_URL: 'https://discord.test/hook' }, 'hello', 20), 'timeout')
  })
})

test('ALERT-CH: scheduler failures reach LINE when only LINE is configured, and stay silent with no channel', async () => {
  const failure = { status: 'error' as const, summary: 'boom', error: 'Error: boom', duration_ms: 1, run_date: '2026-11-21' }
  await withFetch(ok, async (calls) => {
    const { kv, store } = memoryKv()
    await logSchedulerRunResult(kv, 'storage-health-check', failure, { LINE_CHANNEL_ACCESS_TOKEN: 'line-token', LINE_USER_ID: 'U1' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/push')
    assert.match(String(calls[0].init?.body), /Scheduler Fail: .*storage-health-check/)
    assert.equal(store.get('cron:alert:storage-health-check:2026-11-21'), '1')
  })
  await withFetch(ok, async (calls) => {
    const { kv, store } = memoryKv()
    await logSchedulerRunResult(kv, 'storage-health-check', failure, { ADMIN_EMAIL: 'wei@example.com' })
    assert.equal(calls.length, 0)
    assert(!store.has('cron:alert:storage-health-check:2026-11-21'))
  })
})
