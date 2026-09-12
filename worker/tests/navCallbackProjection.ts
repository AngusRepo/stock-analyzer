// Called by the Python original-job test with its actual callback payloads.
// Local Miniflare D1/KV and a recording queue; no external calls or serving.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Miniflare } from 'miniflare'
import { adminControlRoutes } from '../src/routes/adminControlRoutes'

async function main() {
  const callbacks = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  const owners = ['candidate_decisions', 'opb_candidate_decisions', 'l3_candidate_decisions',
    'atomic_candidate_decisions', 'route_candidate_decisions']
  assert.equal(callbacks.length, owners.length * 2)
  const mf = new Miniflare({ modules: true,
    script: 'export default { fetch() { return new Response("isolated") } }',
    d1Databases: ['OPS', 'LEARNING'], kvNamespaces: ['NAV_KV'] })
  const oldFetch = globalThis.fetch
  try {
    const ops = await mf.getD1Database('OPS')
    const learning = await mf.getD1Database('LEARNING')
    const kv = await mf.getKVNamespace('NAV_KV')
    for (const [db, file] of [
      [ops, 'domain-migrations/ops/0011_scheduler_execution_tickets.sql'],
      [learning, 'migrations/0102_active8_oof_freshness_sla.sql'],
    ] as const) {
      for (const sql of fs.readFileSync(file, 'utf8').replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) {
        await db.prepare(sql).run()
      }
    }
    globalThis.fetch = async () => { throw new Error('external network forbidden') }
    const sent: Array<{ message: any; options: any }> = []
    let queueUnavailable = false
    const env = { DB: ops, OPS_DB: ops, LEARNING_DB: learning,
      MULTI_D1_ACTIVE_DOMAINS: 'ops,learning', MULTI_D1_STRICT: 'true',
      KV: kv, STOCKVISION_AUTH_TOKEN: 'isolated-nav-test-token', UPDATE_QUEUE: {
        send: async (message: any, options: any) => {
          if (queueUnavailable) throw new Error('fixture_queue_unavailable')
          sent.push({ message, options })
        },
      } } as any
    const post = (payload: any) => adminControlRoutes.request('https://local.test/api/admin/cron-callback', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer isolated-nav-test-token' },
      body: JSON.stringify(payload),
    }, env)
    for (const callback of callbacks) {
      for (const owner of owners) assert(callback.metadata.paired_nav_maturity[owner], `missing ${owner}`)
      assert.equal(callback.metadata.paired_nav_maturity.status, 'failed')
      assert.equal(callback.metadata.paired_nav_maturity.adoption.status, 'blocked_by_nav_failure')
      const before = sent.length
      if (callback.status === 'triggered') {
        queueUnavailable = true
        const failed = await post(callback)
        assert(failed.status >= 500, 'queue delivery failure must not be acknowledged')
        assert.equal(sent.length, before)
        queueUnavailable = false
      } else {
        assert.equal(callback.status, 'error')
        assert.equal(callback.metadata.continuation_attempt, 12)
      }
      const response = await post(callback)
      assert.equal(response.status, 200, await response.text())
      if (callback.status === 'triggered') {
        assert.equal(sent.length, before + 1)
        assert.deepEqual(sent.at(-1), { message: {
          type: 'active8_oof_continuation', cursor: 0, triggerTime: callback.run_date,
          runId: callback.run_id, schedulerTicketId: undefined, schedulerRunId: undefined,
          oofCadence: 'daily', oofExpectedCohortId: callback.metadata.cohort_id,
          oofContinuationAttempt: 1,
        }, options: { delaySeconds: 300 } })
      } else assert.equal(sent.length, before, 'exhausted callback cannot enqueue again')
      const logged = await kv.get(`scheduler:run:${callback.task}:${callback.run_date}`, 'json') as any
      assert.equal(logged.status, callback.status)
      assert.equal(logged.run_id, callback.run_id)
      const audit = await learning.prepare('SELECT callback_status FROM active8_oof_freshness_sla WHERE run_id=? AND attempt_id=?')
        .bind(callback.run_id, callback.attempt_id).all()
      assert.equal(audit.results.length, 1, 'queue retry must reuse the exact freshness identity')
      assert.equal(audit.results[0].callback_status, callback.status)
    }
    assert.equal(sent.length, owners.length)
    assert.equal((await ops.prepare('SELECT * FROM scheduler_execution_tickets_v1').all()).results.length, 0)
    console.log(`original Python NAV callbacks: ${owners.length} queued, ${owners.length} exhausted, ${owners.length} queue failures recovered; no success receipt`)
  } finally {
    globalThis.fetch = oldFetch
    await mf.dispose()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
