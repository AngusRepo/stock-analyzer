import assert from 'node:assert/strict'
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

function fakeEnv(kv: FakeKv) {
  const sent: any[] = []
  const batches: any[][] = []
  return {
    env: {
      KV: kv,
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

console.log('indicatorQueueRecovery tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

