import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLOUDFLARE_API_RATE_LIMIT_POLICY,
  CLOUDFLARE_API_RATE_LIMIT_PROCESS_WINDOW_MS,
  RestD1Database,
  RestKVNamespace,
  createRateLimitProcessDeadline,
  fetchWithRetry,
  parseRetryAfterMs,
  type RateLimitRetryPolicy,
} from './cloudflareRestBindings'

const D1_OK = JSON.stringify({ success: true, result: [{ success: true, results: [{ ok: 1 }], meta: {} }] })
const ZERO_WAIT_POLICY: RateLimitRetryPolicy = {
  budgetMs: 1_000, maxDelayMs: 0, baseDelayMs: 0, jitterMs: 0, maxAttempts: 30,
}
const POLICY = CLOUDFLARE_API_RATE_LIMIT_POLICY
const freshDeadline = () => createRateLimitProcessDeadline(CLOUDFLARE_API_RATE_LIMIT_PROCESS_WINDOW_MS)

function withFetch<T>(responses: Array<() => Response>, run: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<T>) {
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]
    return next()
  }
  console.warn = () => {}
  return run(calls).finally(() => {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
  })
}

const tooMany = (retryAfter?: string) => () => new Response('rate limited', {
  status: 429,
  headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
})
const ok = (body = D1_OK) => () => new Response(body, { status: 200 })

test('parseRetryAfterMs accepts delta-seconds and IMF-fixdate, and treats the rest as absent', () => {
  const now = Date.parse('2026-11-12T12:00:00Z')
  assert.equal(parseRetryAfterMs('30', now), 30_000)
  assert.equal(parseRetryAfterMs(' 1.5 ', now), 1_500)
  assert.equal(parseRetryAfterMs('Thu, 12 Nov 2026 12:00:45 GMT', now), 45_000)
  for (const value of [
    'Thu, 12 Nov 2026 11:59:00 GMT', 'Thu, 12 Nov 2026 12:00:00 GMT', '0', '0.0', '-5', '+5', '5, 6', '5 6',
    'soon', '', '   ', null, undefined, '2026-11-12T12:00:45Z',
  ]) {
    assert.equal(parseRetryAfterMs(value, now), null, String(value))
  }
})

test('429 sleeps max(backoff, Retry-After) plus jitter, clamped, without consuming the 5xx retries', async () => {
  const sleeps: number[] = []
  const now = Date.parse('2026-11-12T12:00:00Z')
  await withFetch([
    tooMany('7'), // backoff 2 s < 7 s
    tooMany('Thu, 12 Nov 2026 12:00:20 GMT'), // backoff 4 s < 20 s
    tooMany('900'), // capped at maxDelayMs - jitterMs, then jitter
    tooMany('1'), // backoff 16 s > 1 s
    tooMany('-5'), // absent: backoff 32 s
    tooMany(), // absent: backoff 64 s
    ok('done'),
  ], async (calls) => {
    const res = await fetchWithRetry('https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db/query', { method: 'POST', body: '{}' }, 0, {
      rateLimit: POLICY,
      processDeadline: freshDeadline(),
      sleep: async (ms) => { sleeps.push(ms) },
      now: () => now,
      random: () => 0.5,
    })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'done')
    assert.equal(calls.length, 7)
    assert.ok(calls.every((call) => call.init?.body === '{}'))
  })
  assert.deepEqual(sleeps, [7_500, 20_500, 119_500, 16_500, 32_500, 64_500])
})

test('jitter spreads sleeps even when Retry-After is present', async () => {
  const draws = [0, 0.999]
  const sleeps: number[] = []
  await withFetch([tooMany('10'), tooMany('10'), ok('done')], async () => {
    await fetchWithRetry('https://api.cloudflare.com/x', { method: 'GET' }, 0, {
      rateLimit: POLICY,
      processDeadline: freshDeadline(),
      sleep: async (ms) => { sleeps.push(ms) },
      random: () => draws.shift() ?? 0,
    })
  })
  assert.deepEqual(sleeps, [10_000, 10_999])
})

test('tiny Retry-After values follow the backoff, so maxAttempts is not spent in seconds', async () => {
  const sleeps: number[] = []
  await withFetch([tooMany('0'), tooMany('1'), tooMany('0.01'), tooMany('1'), ok('done')], async () => {
    await fetchWithRetry('https://api.cloudflare.com/x', { method: 'GET' }, 0, {
      rateLimit: POLICY,
      processDeadline: freshDeadline(),
      sleep: async (ms) => { sleeps.push(ms) },
      random: () => 0,
    })
  })
  assert.deepEqual(sleeps, [2_000, 4_000, 8_000, 16_000])
})

test('429 retries stop at the per-request budget and return the 429 response', async () => {
  const sleeps: number[] = []
  await withFetch([tooMany('120')], async (calls) => {
    const res = await fetchWithRetry('https://api.cloudflare.com/x', { method: 'POST', body: '{}' }, 3, {
      rateLimit: POLICY,
      processDeadline: freshDeadline(),
      sleep: async (ms) => { sleeps.push(ms) },
      random: () => 0,
    })
    assert.equal(res.status, 429)
    assert.equal(calls.length, sleeps.length + 1)
  })
  // 119 + 119 (cap 120 s minus the 1 s jitter range) + the remaining 92 s of the 330 s budget, then one last attempt.
  assert.deepEqual(sleeps, [119_000, 119_000, 92_000])
  assert.equal(sleeps.reduce((sum, ms) => sum + ms, 0), POLICY.budgetMs)
})

test('429 retries stop at maxAttempts', async () => {
  const sleeps: number[] = []
  const policy = { ...POLICY, budgetMs: Number.MAX_SAFE_INTEGER }
  await withFetch([tooMany()], async (calls) => {
    const res = await fetchWithRetry('https://api.cloudflare.com/x', { method: 'GET' }, 0, {
      rateLimit: policy,
      processDeadline: createRateLimitProcessDeadline(Number.MAX_SAFE_INTEGER),
      sleep: async (ms) => { sleeps.push(ms) },
      random: () => 0,
    })
    assert.equal(res.status, 429)
    assert.equal(calls.length, POLICY.maxAttempts + 1)
  })
  assert.equal(sleeps.length, POLICY.maxAttempts)
})

// Virtual timers: sleeps resolve in deadline order and advance a shared clock, so concurrent
// requests overlap their waits as they would in real time.
function virtualClock() {
  let nowMs = 0
  const timers: Array<{ at: number; resolve: () => void }> = []
  const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)) }
  return {
    now: () => nowMs,
    sleep: (ms: number) => new Promise<void>((resolve) => { timers.push({ at: nowMs + ms, resolve }) }),
    async run<T>(work: Promise<T>): Promise<T> {
      let settled = false
      const guarded = work.finally(() => { settled = true })
      for (;;) {
        await flush()
        if (settled) return guarded
        assert.ok(timers.length > 0, 'requests stalled without a pending sleep')
        timers.sort((left, right) => left.at - right.at)
        const next = timers.shift()!
        nowMs = Math.max(nowMs, next.at)
        next.resolve()
      }
    },
  }
}

function captureWarnings(): { messages: string[]; restore: () => void } {
  const original = console.warn
  const messages: string[] = []
  console.warn = (...args: unknown[]) => { messages.push(args.map(String).join(' ')) }
  return { messages, restore: () => { console.warn = original } }
}

test('the process deadline is wall-clock, then a 429 falls back to the short maxRetries handling', async () => {
  const clock = virtualClock()
  const deadline = createRateLimitProcessDeadline(150_000)
  const options = { rateLimit: POLICY, processDeadline: deadline, sleep: clock.sleep, now: clock.now, random: () => 0 }
  const originalFetch = globalThis.fetch
  const warnings = captureWarnings()
  let calls = 0
  const script: Array<() => Response> = [tooMany('120'), ok('first')]
  globalThis.fetch = async () => { calls += 1; return (script.shift() ?? tooMany('120'))() }
  try {
    // Request 1 opens the window at t=0, waits 119 s and succeeds.
    assert.equal((await clock.run(fetchWithRetry('https://api.cloudflare.com/x', { method: 'GET' }, 3, options))).status, 200)
    assert.equal(deadline.deadlineMs, 150_000)
    assert.equal(clock.now(), 119_000)
    // Request 2 may only wait until the deadline (31 s), then gets the former short retries.
    calls = 0
    const res = await clock.run(fetchWithRetry('https://api.cloudflare.com/x', { method: 'GET' }, 3, options))
    assert.equal(res.status, 429)
    assert.equal(calls, 1 + 4)
    assert.ok(clock.now() >= 150_000 && clock.now() < 150_000 + 3 * 2_250, String(clock.now()))
    assert.equal(warnings.messages.filter((message) => message.includes('process wait window closed')).length, 1)
  } finally {
    globalThis.fetch = originalFetch
    warnings.restore()
  }
})

test('concurrent requests share one 900 s wall-clock window and keep honouring Retry-After until it closes', async () => {
  const clock = virtualClock()
  const deadline = createRateLimitProcessDeadline(CLOUDFLARE_API_RATE_LIMIT_PROCESS_WINDOW_MS)
  const options = { rateLimit: POLICY, processDeadline: deadline, sleep: clock.sleep, now: clock.now, random: () => 0.5 }
  const originalFetch = globalThis.fetch
  const warnings = captureWarnings()
  globalThis.fetch = async () => tooMany('120')()
  const sleepsOf: number[][] = []
  const tracked = (index: number) => ({
    ...options,
    sleep: (ms: number) => { sleepsOf[index].push(ms); return clock.sleep(ms) },
  })
  const wave = async (offset: number) => {
    for (let index = 0; index < 10; index += 1) sleepsOf[offset + index] = []
    const results = await clock.run(Promise.all(Array.from({ length: 10 }, (_, index) => (
      fetchWithRetry('https://api.cloudflare.com/x', { method: 'GET' }, 3, tracked(offset + index))
    ))))
    assert.ok(results.every((res) => res.status === 429))
  }
  try {
    await wave(0)
    // A sum-of-sleeps budget would be gone after one round of 10 x 119.5 s; the window is not.
    assert.equal(clock.now(), 330_000)
    assert.ok(sleepsOf.slice(0, 10).every((sleeps) => JSON.stringify(sleeps) === '[119500,119500,91000]'), JSON.stringify(sleepsOf))
    await wave(10)
    assert.equal(clock.now(), 660_000)
    assert.ok(sleepsOf.slice(10, 20).every((sleeps) => JSON.stringify(sleeps) === '[119500,119500,91000]'), JSON.stringify(sleepsOf))
    assert.equal(warnings.messages.filter((message) => message.includes('process wait window closed')).length, 0)
    await wave(20)
    for (const sleeps of sleepsOf.slice(20, 30)) {
      // Retry-After until the deadline (t=900 s), then three short retries.
      assert.deepEqual(sleeps.slice(0, 3), [119_500, 119_500, 1_000])
      assert.equal(sleeps.length, 6)
      assert.ok(sleeps.slice(3).every((ms) => ms < 2_250), JSON.stringify(sleeps))
    }
    assert.equal(deadline.deadlineMs, 900_000)
    // Wall clock stays within the window plus one capped sleep (here: plus the short retries only).
    assert.ok(clock.now() >= 900_000 && clock.now() <= 900_000 + POLICY.maxDelayMs, String(clock.now()))
    assert.ok(clock.now() < 900_000 + 3 * 2_250, String(clock.now()))
    assert.equal(warnings.messages.filter((message) => message.includes('process wait window closed')).length, 10)
  } finally {
    globalThis.fetch = originalFetch
    warnings.restore()
  }
})

test('the body of every discarded 429 is cancelled', async () => {
  let cancelled = 0
  const streaming429 = () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode('rate limited')) },
    cancel() { cancelled += 1 },
  }), { status: 429, headers: { 'Retry-After': '1' } })
  await withFetch([streaming429, streaming429, ok('done')], async () => {
    const res = await fetchWithRetry('https://api.cloudflare.com/x', { method: 'GET' }, 0, {
      rateLimit: POLICY, processDeadline: freshDeadline(), sleep: async () => {}, random: () => 0,
    })
    assert.equal(await res.text(), 'done')
  })
  assert.equal(cancelled, 2)
})

test('the default process window leaves the slowest observed screener run far below the 5400 s kill', () => {
  assert.equal(CLOUDFLARE_API_RATE_LIMIT_PROCESS_WINDOW_MS, 900_000)
  assert.ok(839_000 + CLOUDFLARE_API_RATE_LIMIT_PROCESS_WINDOW_MS + POLICY.maxDelayMs < 5_400_000 / 2)
  assert.ok(POLICY.budgetMs < CLOUDFLARE_API_RATE_LIMIT_PROCESS_WINDOW_MS)
})

test('5xx keeps the maxRetries bound, and 429 without a policy keeps the legacy bound', async () => {
  const sleeps: number[] = []
  await withFetch([() => new Response('boom', { status: 503 })], async (calls) => {
    const res = await fetchWithRetry('https://api.cloudflare.com/x', { method: 'GET' }, 2, {
      rateLimit: POLICY,
      processDeadline: freshDeadline(),
      sleep: async (ms) => { sleeps.push(ms) },
    })
    assert.equal(res.status, 503)
    assert.equal(calls.length, 3)
  })
  assert.equal(sleeps.length, 2)
  assert.ok(sleeps[0] >= 500 && sleeps[0] < 750)
  assert.ok(sleeps[1] >= 1_000 && sleeps[1] < 1_250)

  await withFetch([tooMany('60')], async (calls) => {
    const res = await fetchWithRetry('https://worker.example.test/x', { method: 'POST', body: '{}' }, 1, {
      sleep: async () => {},
    })
    assert.equal(res.status, 429)
    assert.equal(calls.length, 2)
  })

  // A 429 followed by 5xx still gets the full 5xx retries.
  await withFetch([tooMany('0'), () => new Response('boom', { status: 500 }), ok('done')], async (calls) => {
    const res = await fetchWithRetry('https://api.cloudflare.com/x', { method: 'GET' }, 1, {
      rateLimit: POLICY,
      processDeadline: freshDeadline(),
      sleep: async () => {},
    })
    assert.equal(res.status, 200)
    assert.equal(calls.length, 3)
  })
})

test('network errors keep the maxRetries bound', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('socket hang up') }
  try {
    await assert.rejects(
      fetchWithRetry('https://api.cloudflare.com/x', { method: 'GET' }, 2, {
        rateLimit: POLICY,
        processDeadline: freshDeadline(),
        sleep: async () => {},
      }),
      /socket hang up/,
    )
    assert.equal(calls, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('RestD1Database replays a rate-limited write past D1_CLIENT_MAX_RETRIES', async () => {
  const db = new RestD1Database({
    accountId: 'acc', databaseId: 'db', apiToken: 'token', maxRetries: 0,
    rateLimitPolicy: ZERO_WAIT_POLICY, rateLimitProcessDeadline: createRateLimitProcessDeadline(60_000),
  })
  await withFetch([tooMany('0'), tooMany('0'), tooMany('0'), tooMany('0'), tooMany('0'), ok()], async (calls) => {
    const result = await db.prepare('INSERT INTO t(a) VALUES (?)').bind(1).run()
    assert.equal(result.success, true)
    assert.equal(calls.length, 6)
    const bodies = calls.map((call) => JSON.parse(String(call.init?.body)))
    assert.ok(bodies.every((body) => body.sql === 'INSERT INTO t(a) VALUES (?)' && body.params[0] === 1))
  })
})

test('RestD1Database surfaces the 429 once the budget is exhausted', async () => {
  const db = new RestD1Database({
    accountId: 'acc', databaseId: 'db', apiToken: 'token', maxRetries: 3,
    rateLimitPolicy: { ...ZERO_WAIT_POLICY, maxAttempts: 2 }, rateLimitProcessDeadline: createRateLimitProcessDeadline(60_000),
  })
  await withFetch([tooMany('0')], async (calls) => {
    await assert.rejects(db.prepare('SELECT 1').all(), /D1 REST HTTP 429/)
    assert.equal(calls.length, 3)
  })
})

test('RestKVNamespace uses the same 429 policy', async () => {
  const kv = new RestKVNamespace({
    accountId: 'acc', namespaceId: 'ns', apiToken: 'token', maxRetries: 0,
    rateLimitPolicy: ZERO_WAIT_POLICY, rateLimitProcessDeadline: createRateLimitProcessDeadline(60_000),
  })
  await withFetch([tooMany('0'), tooMany('0'), ok('value')], async (calls) => {
    assert.equal(await kv.get('k'), 'value')
    assert.equal(calls.length, 3)
  })
})
