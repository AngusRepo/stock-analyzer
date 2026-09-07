import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Miniflare } from 'miniflare'
import { Hono } from 'hono'
import { handleStrategyMiningCallback, handleStrategyMiningD1Gateway, strategyMiningDispatchKey } from './strategyMiningGateway'
import { admitSchedulerExecutionTicket, schedulerDeliveryIdentity, schedulerTicketClosureDefect } from './schedulerExecutionTickets'
import { reconcileSchedulerExecutionTicketStatus } from './schedulerStatus'
import { active8CadenceReceiptProblem, cadenceJobClosureProblem } from './cadenceReadiness'
import { freshnessFromReusedCadenceReceipt } from './active8OofFreshness'

class KV {
  values = new Map<string, string>()
  fail = false
  async get(key: string, format?: string): Promise<any> {
    const raw = this.values.get(key)
    return raw ? format === 'json' ? JSON.parse(raw) : raw : null
  }
  async put(key: string, value: string) {
    if (this.fail && key.startsWith('scheduler:run:')) throw new Error('test KV outage')
    this.values.set(key, value)
  }
}

async function main() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['OPS', 'RESEARCH'] })
  try {
    const ops = await mf.getD1Database('OPS')
    const research = await mf.getD1Database('RESEARCH')
    for (const sql of fs.readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql', 'utf8').replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await ops.prepare(sql).run()
    await research.prepare('CREATE TABLE strategy_mining_runs(run_id TEXT PRIMARY KEY, status TEXT)').run()
    const kv = new KV()
    const env: any = {
      DB: { prepare() { throw new Error('legacy DB forbidden') } }, OPS_DB: ops, RESEARCH_DB: research,
      MULTI_D1_ACTIVE_DOMAINS: 'ops,research', KV: kv, STRATEGY_MINING_CALLBACK_TOKEN: 'test-token',
    }
    const app = new Hono().post('/d1', handleStrategyMiningD1Gateway).post('/callback', handleStrategyMiningCallback)
    const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env)
    assert.equal((await post('/d1', { statements: [{ sql: 'INSERT INTO strategy_mining_runs(run_id,status) VALUES (?,?)', params: ['leaf', 'started'] }] })).status, 200)
    assert.equal((await research.prepare('SELECT COUNT(*) AS n FROM strategy_mining_runs').first<any>())?.n, 1)

    const root = (await admitSchedulerExecutionTicket(ops, {
      identity: schedulerDeliveryIdentity(new Headers()), task: 'monthly-strategy-mining',
      requestedRunDate: '2026-09-05', proposedRunId: 'mining-root',
    })).ticket
    const leaf = 'strategy-mining-2026-09-05-test-root'
    await kv.put(strategyMiningDispatchKey(leaf), JSON.stringify({ run_id: leaf, run_date: '2026-09-05', scheduler_ticket_id: root.ticket_id, scheduler_run_id: root.run_id }))
    const callback = { task: 'monthly-strategy-mining', run_id: leaf, run_date: '2026-09-05', status: 'error', summary: 'research failure', error: 'root cause', duration_ms: 245 }
    kv.fail = true
    assert.equal((await post('/callback', callback)).status, 500)
    assert.equal((await ops.prepare('SELECT status FROM scheduler_execution_tickets_v1 WHERE ticket_id=?').bind(root.ticket_id).first<any>())?.status, 'error')
    kv.fail = false
    assert.equal((await post('/callback', callback)).status, 200)
    assert.equal((await kv.get('scheduler:run:monthly-strategy-mining:2026-09-05', 'json')).run_id, 'mining-root')
    assert.equal((await post('/callback', callback)).status, 200)
    assert.equal((await post('/callback', { ...callback, status: 'success' })).status, 409)
    assert.equal((await post('/callback', { ...callback, scheduler_ticket_id: 'spoofed' })).status, 400)

    // Legacy leaf/root recovery must survive the same partial KV outage.
    const legacyRoot = (await admitSchedulerExecutionTicket(ops, {
      identity: schedulerDeliveryIdentity(new Headers()), task: 'monthly-strategy-mining',
      requestedRunDate: '2026-09-05', proposedRunId: 'legacy-root',
    })).ticket
    const legacyLeaf = 'strategy-mining-2026-09-05-legacy'
    await ops.prepare("UPDATE scheduler_execution_tickets_v1 SET last_summary=? WHERE ticket_id=?").bind(`triggered run_id=${legacyLeaf} callback expected`, legacyRoot.ticket_id).run()
    await kv.put(strategyMiningDispatchKey(legacyLeaf), JSON.stringify({ run_id: legacyLeaf, run_date: '2026-09-05' }))
    kv.fail = true
    assert.equal((await post('/callback', { ...callback, run_id: legacyLeaf })).status, 500)
    kv.fail = false
    assert.equal((await post('/callback', { ...callback, run_id: legacyLeaf })).status, 200)
    assert.equal((await kv.get(strategyMiningDispatchKey(legacyLeaf), 'json')).scheduler_run_id, 'legacy-root')

    const future = schedulerDeliveryIdentity(new Headers({ 'X-CloudScheduler-JobName': 'active8-oof-monthly', 'X-CloudScheduler-ScheduleTime': new Date(Date.now() + 86400_000).toISOString() }))
    await assert.rejects(admitSchedulerExecutionTicket(ops, { identity: future, task: 'active8-oof-monthly', proposedRunId: 'future' }), /future delivery rejected/)
    const identity = schedulerDeliveryIdentity(new Headers({ 'X-CloudScheduler-JobName': 'active8-oof-monthly', 'X-CloudScheduler-ScheduleTime': '2026-09-05T18:00:00Z' }))
    const old = (await admitSchedulerExecutionTicket(ops, { identity, task: 'active8-oof-monthly', proposedRunId: 'old-monthly' })).ticket
    await ops.prepare("UPDATE scheduler_execution_tickets_v1 SET status='success', accepted_at='2026-08-26 17:44:28', updated_at='2026-08-26 17:44:32', last_summary='active8_oof_lifecycle status=spawned cadence=monthly cohort=none promoted=false' WHERE ticket_id=?").bind(old.ticket_id).run()
    const bad = await ops.prepare('SELECT * FROM scheduler_execution_tickets_v1 WHERE ticket_id=?').bind(old.ticket_id).first<any>()
    assert.equal(schedulerTicketClosureDefect(bad), 'scheduler_ticket_accepted_before_schedule')
    await assert.rejects(admitSchedulerExecutionTicket(ops, { identity, task: 'active8-oof-monthly', proposedRunId: 'real-september' }), /audited ticket repair required/)
    assert.equal(reconcileSchedulerExecutionTicketStatus({ ticket: bad, baseStatus: 'success', baseTimestamp: '2026-09-06T00:00:00Z' })?.lastStatus, 'failed')
    assert.equal(schedulerTicketClosureDefect({ ...bad, accepted_at: '2026-09-05T18:00:00Z' }), 'scheduler_ticket_dispatch_is_not_closure')
    const ready = { id: 'monthly-optuna', lastStatus: 'success', statusRunDate: '2026-09-05', lastRunAt: '2026-09-05T10:41:45Z', summary: '8 OK screener:SKIPPED_NOT_READY' }
    assert.equal(cadenceJobClosureProblem(ready, 'monthly', '2026-09-06'), 'research_sources_incomplete')
    assert.equal(cadenceJobClosureProblem({ ...ready, summary: 'complete', statusRunDate: '2026-08-27' }, 'monthly', '2026-09-06'), 'current_cycle_completion_missing')
    assert.equal(cadenceJobClosureProblem({ ...ready, id: 'active8-oof-monthly', summary: 'status=materialized validation=rejected promoted=false' }, 'monthly', '2026-09-06'), null)
    await research.prepare('CREATE TABLE active8_oof_freshness_sla(decision_key TEXT, task TEXT, run_date TEXT, run_id TEXT, status TEXT, cohort_id TEXT, callback_status TEXT, expected_max_date TEXT, effective_max_date TEXT, observed_at TEXT)').run()
    const artifactJob = { id: 'active8-oof-monthly', statusRunDate: '2026-09-06', summary: 'run_id=compute-1 status=materialized cohort=cohort-1 full_fit=blocked promoted=false' }
    assert.equal(await active8CadenceReceiptProblem(research, artifactJob), 'active8_terminal_receipt_missing')
    await research.prepare("INSERT INTO active8_oof_freshness_sla VALUES('k','active8-oof-monthly','2026-09-06','compute-1','fresh','cohort-1','success','2026-08-28','2026-08-28','2026-09-06 00:00:00')").run()
    assert.equal(await active8CadenceReceiptProblem(research, artifactJob), null)
    assert.equal(await active8CadenceReceiptProblem(research, { ...artifactJob, summary: artifactJob.summary.replace('cohort-1', 'another-cohort') }), 'active8_terminal_receipt_not_closed')
    assert.equal(await active8CadenceReceiptProblem(research, { ...artifactJob, summary: artifactJob.summary.replace('full_fit=blocked', 'full_fit=triggered') }), 'active8_full_fit_terminal_receipt_missing')
    const reused = { status: 'idempotent_complete', cohort_id: 'c', receipt: {
      status: 'materialized', cadence: 'monthly', cohort_id: 'c', knowledge_cutoff_date: '2026-09-06',
      calendar: { cutoff: '2026-09-06', mature_max_date: '2026-08-28' },
      physical_prediction_coverage: { max_date: '2026-08-28' },
      evidence_closure: { materialized: true, candidate_artifacts: true },
      full_fit_dispatch: { status: 'completed', retry_required: false },
    } }
    assert.equal(freshnessFromReusedCadenceReceipt(reused, 'monthly', '2026-09-06').cohort_id, 'c')
    assert.throws(() => freshnessFromReusedCadenceReceipt(reused, 'weekly', '2026-09-06'), /receipt_invalid/)
    assert.throws(() => freshnessFromReusedCadenceReceipt(reused, 'monthly', '2026-08-27'), /receipt_invalid/)
    console.log('monthly automation SQLite / callback / readiness regressions passed')
  } finally { await mf.dispose() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
