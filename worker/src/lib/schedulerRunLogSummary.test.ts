import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  classifySchedulerSummary,
  logSchedulerRunResult,
  redactSchedulerRunText,
  SCHEDULER_RUN_SUMMARY_MAX_CHARS,
  schedulerRunLogSummary,
} from './schedulerRunLogger'

test('NEW-94: object results keep the full JSON beyond the legacy 200-char prefix', () => {
  const result = { positions: {}, marks: { done: 0, total: 0 }, nav: 948203.63, pad: 'x'.repeat(260), rerun: { attempt: 2 } }
  const stored = schedulerRunLogSummary(result)
  assert.equal(stored, JSON.stringify(result))
  assert.match(stored, /"rerun":\{"attempt":2\}/)
})

test('NEW-94: oversized object JSON is cut at the cap and says how much was dropped; strings are untouched', () => {
  const big = { rows: 'y'.repeat(SCHEDULER_RUN_SUMMARY_MAX_CHARS + 500) }
  const full = JSON.stringify(big)
  const stored = schedulerRunLogSummary(big)
  assert.equal(stored, `${full.slice(0, SCHEDULER_RUN_SUMMARY_MAX_CHARS)}…[truncated; ${full.length} chars total]`)
  const longString = `learning_retention_readiness ${'z'.repeat(SCHEDULER_RUN_SUMMARY_MAX_CHARS * 2)}`
  assert.equal(schedulerRunLogSummary(longString), longString)
  assert.equal(schedulerRunLogSummary(undefined), '')
  assert.equal(schedulerRunLogSummary(null), 'null')
})

test('NEW-94: credentials and secret-named Worker var values are masked; ordinary keys stay readable', () => {
  const env = {
    API_SERVICE_TOKEN: 'svc-tok-1234567890',
    DISCORD_WEBHOOK_URL: 'https://discord.example/api/webhooks/1/abcdef',
    SHORT_TOKEN: 'abc', // under 8 chars: too short to mask safely
    FINLAB_BACKFILL_YEARS: '3',
    KV: { get() {} },
  }
  const text = [
    'failed call with svc-tok-1234567890 to https://discord.example/api/webhooks/1/abcdef',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    'api_key=AKIA1234 client_secret=hunter22 password:"p@ss word" x-api-key: k1',
    '{"access_token":"tok-9","refresh_token":"r-1"}',
    'https://user:pw@example.com/path',
    'run_key=rk-1 grant_key=ml:active8 token_count=5 max_tokens=10 run_id=daily-snapshot-1-abc status=success abc',
  ].join(' | ')
  const out = redactSchedulerRunText(text, env)
  for (const secret of ['svc-tok-1234567890', 'webhooks/1/abcdef', 'eyJhbGci', 'AKIA1234', 'hunter22', 'p@ss word',
    'tok-9', 'r-1"', 'user:pw@', ' k1']) {
    assert(!out.includes(secret), `${secret} leaked: ${out}`)
  }
  for (const kept of ['run_key=rk-1', 'grant_key=ml:active8', 'token_count=5', 'max_tokens=10',
    'run_id=daily-snapshot-1-abc', 'status=success abc', 'https://***@example.com/path']) {
    assert(out.includes(kept), `${kept} lost: ${out}`)
  }
  // Masking is idempotent, so the logger can redact text the route already redacted.
  assert.equal(redactSchedulerRunText(out, env), out)
  assert.equal(redactSchedulerRunText(out), out)
})

test('NEW-94: the run log stores redacted summary/error without changing status', async () => {
  const puts = new Map<string, string>()
  const kv = {
    async get(key: string) { return puts.has(key) ? JSON.parse(puts.get(key)!) : null },
    async put(key: string, value: string) { puts.set(key, value) },
  } as unknown as KVNamespace
  await logSchedulerRunResult(kv, 'daily-snapshot', {
    status: 'error', summary: 'failed: token=abc123 run_id=r1', error: 'Error: api_key=zzz9', duration_ms: 1,
    run_date: '2026-10-31',
  }, { MY_SECRET: 'super-secret-value' } as never)
  const entry = JSON.parse(puts.get('scheduler:run:daily-snapshot:2026-10-31')!)
  assert.equal(entry.status, 'error')
  assert.equal(entry.summary, 'failed: token=*** run_id=r1')
  assert.equal(entry.error, 'Error: api_key=***')
  assert.equal(puts.get('cron:log:daily-snapshot:2026-10-31'), puts.get('scheduler:run:daily-snapshot:2026-10-31'))
})

test('NEW-94: the admin trigger route still classifies and matches on the legacy prefix and logs the full summary', () => {
  const source = readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
  const control = "const summary = typeof result === 'string' ? result : JSON.stringify(result)?.slice(0, 200) ?? ''"
  assert.equal(source.split(control).length - 1, 2)
  assert.equal(source.split('const logSummary = schedulerRunLogSummary(result, c.env)').length - 1, 2)
  assert.equal(source.split('const status = classifySchedulerSummary(summary)').length - 1, 2)
  assert.equal(source.split('summary: logSummary,').length - 1, 3)
  // FU17 settles the ticket through settleTicket; it still receives the prefix summary, not logSummary.
  assert.equal(source.split('settleTicket(schedulerTicketStatusForRunLog(status), summary)').length - 1, 2)
  // A status word past the old prefix is stored, but the status is still decided on the prefix.
  const result = { pad: 'p'.repeat(220), outcome: 'failed_validation' }
  const prefix = JSON.stringify(result).slice(0, 200)
  assert.equal(classifySchedulerSummary(prefix), 'success')
  assert.match(schedulerRunLogSummary(result), /failed_validation/)
})

test('NEW-94: secrets inside JSON nested in a string, escaped quotes and the cap boundary never leak', () => {
  const nested = JSON.stringify({ error: `401 ${JSON.stringify({ access_token: 'SECRETVAL1', detail: 'ok' })}`,
    upstream: JSON.stringify({ password: 'SECRETVAL2' }) })
  const out = redactSchedulerRunText(nested)
  for (const secret of ['SECRETVAL1', 'SECRETVAL2']) assert(!out.includes(secret), `${secret} leaked: ${out}`)
  assert.match(out, /\\"detail\\":\\"ok\\"/)
  assert.equal(redactSchedulerRunText('{"password":"ab\\"TAIL","next":"keep"}'), '{"password":"***","next":"keep"}')
  assert.equal(redactSchedulerRunText('token=abc\\" rest'), 'token=***\\" rest')
  assert.equal(redactSchedulerRunText('{"api_key":"unterminated'), '{"api_key":"***')

  const env = { ML_API_KEY: 'ENVSECRET-0123456789' }
  for (const shift of [-12, -4, 0, 3]) {
    const pad = 'x'.repeat(SCHEDULER_RUN_SUMMARY_MAX_CHARS - 20 + shift)
    const stored = schedulerRunLogSummary({ pad, note: 'ENVSECRET-0123456789', api_key: 'KKKKKKKKKKKKKKKKKKKK' }, env)
    assert(!/ENVSECRET|KKKK/.test(stored), `shift ${shift} leaked: ${stored.slice(-120)}`)
  }
})

test('NEW-94: more credential shapes are masked; config vars named *_KEY_SCOPE_JSON are not', () => {
  const out = redactSchedulerRunText([
    'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'private_key=PK1x secret_key=SK1x access_key=AK1x',
    'signing-key: SG1x hmac_key="HM1x" digest_key=DG1x', 'basic validation ok', 'Basic checks passed',
  ].join(' | '), { FINLAB_DAILY_PRICE_KEY_SCOPE_JSON: '{"scope":"price-daily"}' })
  for (const secret of ['dXNlcjpwYXNzd29yZA', 'PK1x', 'SK1x', 'AK1x', 'SG1x', 'HM1x', 'DG1x']) {
    assert(!out.includes(secret), `${secret} leaked: ${out}`)
  }
  assert(out.includes('basic validation ok') && out.includes('Basic checks passed'), out)
  assert.equal(redactSchedulerRunText('{"scope":"price-daily"}', { FINLAB_DAILY_PRICE_KEY_SCOPE_JSON: '{"scope":"price-daily"}' }),
    '{"scope":"price-daily"}')
})

test('NEW-94: the error alert carries the redacted summary/error, and the route redacts ticket error text', async () => {
  const kv = { async get() { return null }, async put() {} } as unknown as KVNamespace
  const bodies: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(String(init?.body ?? ''))
    return new Response('ok')
  }) as typeof fetch
  try {
    await logSchedulerRunResult(kv, 'daily-snapshot', {
      status: 'error', summary: 'failed token=abc123', error: 'Error: password=hunter22', duration_ms: 1,
      run_date: '2026-10-31',
    }, { DISCORD_WEBHOOK_URL: 'https://hooks.example/abc' })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(bodies.length, 1)
  assert(!/abc123|hunter22/.test(bodies[0]), bodies[0])
  assert.match(bodies[0], /token=\*\*\*/)
  const source = readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
  assert.equal(source.split("redactSchedulerRunText(e?.message ?? 'Unknown error', c.env), redactSchedulerRunText(String(e), c.env))").length - 1, 2)
  assert.doesNotMatch(source, /updateTicket\('error', 'scheduler_http', e\?\.message/)
})

test('NEW-94: a cut secret value does not swallow later control tokens; escaped backslashes close values', () => {
  assert.equal(redactSchedulerRunText("detail secret: 'unterminated value then status=success function_call_id=fc-1"),
    "detail secret: '*** status=success function_call_id=fc-1")
  for (const leak of ['{"password":"p@ss word, x', '{"api_key":"ab,cd&ef;gh']) {
    assert.equal(redactSchedulerRunText(leak), leak.slice(0, leak.indexOf(':"') + 2) + '***')
  }
  assert.equal(redactSchedulerRunText('{"err":"{\\"token\\":\\"abc","status":"ok"}'), '{"err":"{\\"token\\":\\"***","status":"ok"}')
  for (const name of ['a_b_c_d_e_f_g_api_key', 'my_very_long_service_account_client_extra_secret', `${'x'.repeat(70)}_secret`]) {
    assert.equal(redactSchedulerRunText(`${name}=LEAK1`), `${name}=***`)
  }
  assert.equal(redactSchedulerRunText('run_key=rk max_tokens=5 grant_key=g'), 'run_key=rk max_tokens=5 grant_key=g')
  assert.equal(redactSchedulerRunText('body={"token":"abc123 run_id=r1 shards=4'), 'body={"token":"*** run_id=r1 shards=4')
  assert.equal(redactSchedulerRunText('{"password":"ab\\\\","status":"ok"}'), '{"password":"***","status":"ok"}')
  const nestedBackslash = JSON.stringify({ e: JSON.stringify({ token: 'T\\X', next: 'keep' }) })
  const out = redactSchedulerRunText(nestedBackslash)
  assert(!out.includes('T\\') && out.includes('keep'), out)
})

test('NEW-94: masking stays linear on long hyphenated lists and huge object results', () => {
  const list = Array.from({ length: 100_000 }, (_, i) => String(2000 + (i % 7000))).join('-')
  let started = performance.now()
  redactSchedulerRunText(list)
  assert(performance.now() - started < 2_000, 'hyphenated list masking is not linear')
  started = performance.now()
  redactSchedulerRunText(`see ${list} postgres+ssl://u:p@db.example`)
  assert(performance.now() - started < 2_000, 'URL masking is not linear')
  started = performance.now()
  assert.equal(redactSchedulerRunText(`{"token":"cut${' '.repeat(400_000)}run_id=r1`), '{"token":"*** run_id=r1')
  assert(performance.now() - started < 2_000, 'unterminated-value stop search is not linear')
  started = performance.now()
  const stored = schedulerRunLogSummary({ codes: list, rows: 'r'.repeat(2_000_000) })
  assert(performance.now() - started < 2_000, 'object summary masking is not bounded')
  assert(stored.length < SCHEDULER_RUN_SUMMARY_MAX_CHARS + 64)
})

test('NEW-94: a Worker secret cut at the masked head boundary never reaches the stored summary', () => {
  const env = { ML_API_KEY: 'ENVSECRET-0123456789-abcdefghijklmnop' }
  for (let shift = -40; shift <= 0; shift += 5) {
    const result = { api_key: 'k'.repeat(12_500), pad: 'x'.repeat(16_000 - 12_500 - 40 + shift), note: env.ML_API_KEY, rest: 'y'.repeat(100) }
    const stored = schedulerRunLogSummary(result, env)
    assert(!/ENVSECRET|kkkk/.test(stored), `shift ${shift}: ${stored.slice(-160)}`)
  }
})
