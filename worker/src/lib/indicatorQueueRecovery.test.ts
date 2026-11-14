import assert from 'node:assert/strict'
import test from 'node:test'
import {
  indicatorQueueRetryDelaySeconds,
  recordIndicatorQueueBatchProgress,
  recordIndicatorQueueMessageFailure,
  runIndicatorQueueRecoveryWatchdog,
} from './indicatorQueueRecovery'

class FakeKv {
  values = new Map<string, string>()

  async get(key: string, type?: string): Promise<any> {
    const value = this.values.get(key)
    if (value == null) return null
    return type === 'json' ? JSON.parse(value) : value
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }

  async list(options: { prefix?: string } = {}): Promise<any> {
    const prefix = options.prefix ?? ''
    return {
      keys: [...this.values.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
    }
  }
}

function fakeEnv(kv: FakeKv, activeLease = false) {
  const sent: any[] = []
  const batches: any[][] = []
  return {
    env: {
      KV: kv,
      DB: { prepare() { return { bind() { return { async first() { return activeLease ? { expires_at: new Date(Date.now() + 60_000).toISOString() } : null } } } } } },
      UPDATE_QUEUE: {
        async send(body: any) {
          sent.push(body)
        },
        async sendBatch(messages: any[]) {
          batches.push(messages)
        },
      },
    } as any,
    sent,
    batches,
  }
}

async function main() {
  assert.equal(indicatorQueueRetryDelaySeconds(1, 0), 15)
assert.equal(indicatorQueueRetryDelaySeconds(2, 1), 37)
assert.equal(indicatorQueueRetryDelaySeconds(9, 3), 321)

const date = '2026-08-18'
const runId = '2026-08-18-test'
const prefix = `cron:indicator-queue:${date}:${runId}`
const staleReceipt = {
  task: 'indicator-queue',
  status: 'running',
  summary: `indicator queue started for ${date}; run_id=${runId}; shards=4`,
  duration_ms: 0,
  run_date: date,
  timestamp: '2020-01-01T00:00:00.000Z',
}

{
  const kv = new FakeKv()
  kv.values.set(`scheduler:run:indicator-queue:${date}`, JSON.stringify(staleReceipt))
  kv.values.set(`${prefix}:cursor:0`, '44')
  const { env, batches } = fakeEnv(kv)
  const summary = await runIndicatorQueueRecoveryWatchdog(env, date)
  assert.match(summary, /stale shards re-enqueued/)
  assert.equal(batches.length, 1)
  assert.deepEqual(
    batches[0].map((message) => [message.body.shardIndex, message.body.cursor]),
    [[0, 44], [1, 0], [2, 0], [3, 0]],
  )
  assert.equal(await kv.get(`${prefix}:watchdog-recoveries`), '1')
  assert.match(
    String(await kv.get(`scheduler:run:indicator-queue:${date}`)),
    /stale shards re-enqueued/,
  )
}

{
  const kv = new FakeKv()
  kv.values.set(`scheduler:run:indicator-queue:${date}`, JSON.stringify(staleReceipt))
  for (let shard = 0; shard < 4; shard += 1) {
    kv.values.set(`${prefix}:done:${shard}`, '1')
  }
  const { env, sent } = fakeEnv(kv)
  const summary = await runIndicatorQueueRecoveryWatchdog(env, date)
  assert.match(summary, /finalizer re-enqueued/)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'finalize_update')
  assert.equal(await kv.get(`${prefix}:watchdog-recoveries`), '1')
}

{
  const kv = new FakeKv()
  kv.values.set(
    `scheduler:run:indicator-queue:${date}`,
    JSON.stringify({ ...staleReceipt, status: 'success' }),
  )
  for (let shard = 0; shard < 4; shard += 1) {
    kv.values.set(`${prefix}:done:${shard}`, '1')
  }
  const { env, sent } = fakeEnv(kv)
  const summary = await runIndicatorQueueRecoveryWatchdog(env, date)
  assert.match(summary, /finalizer re-enqueued/)
  assert.equal(sent[0].type, 'finalize_update')
}

{
  const kv = new FakeKv()
  kv.values.set(`scheduler:run:indicator-queue:${date}`, JSON.stringify(staleReceipt))
  kv.values.set(`${prefix}:watchdog-recoveries`, '6')
  const { env } = fakeEnv(kv)
  await assert.rejects(
    () => runIndicatorQueueRecoveryWatchdog(env, date),
    /watchdog exhausted/,
  )
  const indicatorReceipt = JSON.parse(String(await kv.get(`scheduler:run:indicator-queue:${date}`)))
  assert.equal(indicatorReceipt.status, 'error')
  const eveningReceipt = JSON.parse(String(await kv.get(`scheduler:run:evening-chain:${date}`)))
  assert.equal(eveningReceipt.status, 'error')
}

{
  const kv = new FakeKv()
  const { env } = fakeEnv(kv)
  const message = {
    type: 'update_batch',
    cursor: 44,
    triggerTime: date,
    runId,
    shardIndex: 0,
    shardCount: 4,
  } as any
  await recordIndicatorQueueMessageFailure(env, message, new Error('D1 transient'), 2)
  const failure = JSON.parse(String(await kv.get(`${prefix}:failure:0`)))
  assert.equal(failure.cursor, 44)
  assert.equal(failure.attempts, 2)
  assert.equal(failure.error, 'D1 transient')

  await recordIndicatorQueueBatchProgress(env, message, 84, true)
  assert.equal(await kv.get(`${prefix}:cursor:0`), '84')
  assert.equal(await kv.get(`${prefix}:failure:0`), null)
}

{
  const kv = new FakeKv()
  kv.values.set(`scheduler:run:indicator-queue:${date}`, JSON.stringify(staleReceipt))
  kv.values.set(`${prefix}:watchdog-recoveries`, '6')
  for (let shard = 0; shard < 4; shard++) kv.values.set(`${prefix}:done:${shard}`, '1')
  const { env, sent, batches } = fakeEnv(kv, true)
  const summary = await runIndicatorQueueRecoveryWatchdog(env, date)
  assert.match(summary, /lease.*active|active.*lease/i)
  assert.equal(sent.length + batches.length, 0)
  assert.equal(await kv.get(`${prefix}:watchdog-recoveries`), '6')
}

console.log('indicatorQueueRecovery tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

const watchdogDate = '2026-11-04'
const watchdogRunId = '2026-11-04-test'
const watchdogPrefix = `cron:indicator-queue:${watchdogDate}:${watchdogRunId}`
const watchdogStaleReceipt = {
  task: 'indicator-queue', status: 'running', duration_ms: 0, run_date: watchdogDate,
  summary: `indicator queue started for ${watchdogDate}; run_id=${watchdogRunId}; shards=4`,
  timestamp: '2020-01-01T00:00:00.000Z',
}

test('watchdog: a finalized marker is convergence even while the KV receipt still says running', async () => {
  const kv = new FakeKv()
  kv.values.set(`scheduler:run:indicator-queue:${watchdogDate}`, JSON.stringify(watchdogStaleReceipt))
  kv.values.set(`${watchdogPrefix}:finalized`, '1')
  for (let shard = 0; shard < 4; shard++) kv.values.set(`${watchdogPrefix}:done:${shard}`, '1')
  const { env, sent, batches } = fakeEnv(kv)
  const summary = await runIndicatorQueueRecoveryWatchdog(env, watchdogDate)
  assert.match(summary, /^skipped: .*finali[sz]e/)
  assert.equal(sent.length + batches.length, 0)
  assert.equal(await kv.get(`${watchdogPrefix}:watchdog-recoveries`), null)
})

function withScreenerHandoff(env: any, canonicalRunId: string) {
  env.DB = { prepare(sql: string) { return { bind() { return { async first() {
    return sql.includes("stage='screener_v2'") ? { canonical_run_id: canonicalRunId } : null
  } } } } } }
}

test('watchdog: the durable screener producer owns recovery after this run handed off', async () => {
  const kv = new FakeKv()
  kv.values.set(`scheduler:run:indicator-queue:${watchdogDate}`, JSON.stringify(watchdogStaleReceipt))
  for (let shard = 0; shard < 4; shard++) kv.values.set(`${watchdogPrefix}:done:${shard}`, '1')
  const { env, sent, batches } = fakeEnv(kv)
  withScreenerHandoff(env, watchdogRunId)
  const summary = await runIndicatorQueueRecoveryWatchdog(env, watchdogDate)
  assert.match(summary, /^skipped: .*screener_v2/)
  assert.equal(sent.length + batches.length, 0)
  assert.equal(await kv.get(`${watchdogPrefix}:watchdog-recoveries`), null)
  assert.ok(await kv.get(`${watchdogPrefix}:finalized`))
})

test('watchdog: a stuck shard, or a screener cursor from another run, is still recovered', async () => {
  for (const [label, doneShards, screenerRun] of [
    ['stuck shard', 3, watchdogRunId], ['other run', 4, 'earlier-run'],
  ] as const) {
    const kv = new FakeKv()
    kv.values.set(`scheduler:run:indicator-queue:${watchdogDate}`, JSON.stringify(watchdogStaleReceipt))
    for (let shard = 0; shard < doneShards; shard++) kv.values.set(`${watchdogPrefix}:done:${shard}`, '1')
    const { env, sent, batches } = fakeEnv(kv)
    withScreenerHandoff(env, screenerRun)
    const summary = await runIndicatorQueueRecoveryWatchdog(env, watchdogDate)
    assert.doesNotMatch(summary, /screener_v2/, label)
    assert.equal(await kv.get(`${watchdogPrefix}:finalized`), null, `${label}: not marked finalized`)
    assert.equal(sent.length + batches.length, 1, `${label}: recovery enqueued`)
    assert.equal(await kv.get(`${watchdogPrefix}:watchdog-recoveries`), '1')
  }
})

test('watchdog: a finalizer between deferred retries spends no recovery budget and enqueues nothing', async () => {
  const kv = new FakeKv()
  kv.values.set(`scheduler:run:indicator-queue:${watchdogDate}`, JSON.stringify(watchdogStaleReceipt))
  kv.values.set(`${watchdogPrefix}:watchdog-recoveries`, '2')
  kv.values.set(`${watchdogPrefix}:finalize-deferred`, JSON.stringify({ continuation_attempt: 3 }))
  for (let shard = 0; shard < 4; shard++) kv.values.set(`${watchdogPrefix}:done:${shard}`, '1')
  const { env, sent, batches } = fakeEnv(kv)
  const summary = await runIndicatorQueueRecoveryWatchdog(env, watchdogDate)
  assert.match(summary, /^skipped: .*deferred/)
  assert.equal(sent.length + batches.length, 0)
  assert.equal(await kv.get(`${watchdogPrefix}:watchdog-recoveries`), '2')
})

test('watchdog: exhaustion alerts once; later ticks neither rewrite evening-chain nor throw', async () => {
  const kv = new FakeKv()
  kv.values.set(`scheduler:run:indicator-queue:${watchdogDate}`, JSON.stringify(watchdogStaleReceipt))
  kv.values.set(`${watchdogPrefix}:watchdog-recoveries`, '6')
  const { env } = fakeEnv(kv)
  await assert.rejects(() => runIndicatorQueueRecoveryWatchdog(env, watchdogDate), /watchdog exhausted/)
  assert.ok(await kv.get(`${watchdogPrefix}:watchdog-exhausted`))
  kv.values.delete(`${watchdogPrefix}:watchdog-lease`)
  kv.values.delete(`scheduler:run:evening-chain:${watchdogDate}`)
  const indicatorBefore = kv.values.get(`scheduler:run:indicator-queue:${watchdogDate}`)
  const summary = await runIndicatorQueueRecoveryWatchdog(env, watchdogDate)
  assert.match(summary, /^skipped: .*exhausted already reported/)
  assert.equal(await kv.get(`scheduler:run:evening-chain:${watchdogDate}`), null)
  assert.equal(kv.values.get(`scheduler:run:indicator-queue:${watchdogDate}`), indicatorBefore)
})
