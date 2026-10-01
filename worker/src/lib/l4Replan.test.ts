import assert from 'node:assert/strict'
import { flushL4Replans } from './l4Replan'
import type { Bindings } from '../types'

type Row = { request_id: string; request_json: string; status: string; attempts: number; result_plan_id?: string }
const source = 'a'.repeat(64)
const resultPlan = 'b'.repeat(64)
function row(id: string, symbol: string, cap: number, reason = 'debate_risk_cap'): Row {
  return { request_id: id, request_json: JSON.stringify({ plan_id: source, veto_symbols: [], weight_caps: { [symbol]: cap }, reason }), status: 'pending', attempts: 0 }
}
function fixture(rows: Row[]) {
  let leaseOwner: string | null = null
  const db = {
    prepare(sql: string) {
      let args: unknown[] = []
      return {
        bind(...values: unknown[]) { args = values; return this },
        async all() {
          const pending = rows.filter(r => r.status === 'pending')
          return { results: (sql.includes('LIMIT 1') ? pending.slice(0, 1) : pending).map(r => ({ ...r })) }
        },
        async first() {
          if (sql.includes('INSERT INTO maintenance_task_leases')) {
            if (leaseOwner) return null
            leaseOwner = String(args[2]); return { owner_id: leaseOwner }
          }
          if (sql.includes('FROM maintenance_task_leases')) return { task_name:'l4', owner_id:leaseOwner,lease_expires_at:'later' }
          return { n: rows.filter(r => r.status === 'pending').length }
        },
        async run() {
          if (sql.includes('DELETE FROM maintenance_task_leases')) { leaseOwner = null; return {success:true} }
          if (sql.includes("status='expired'")) return { success: true }
          const target = rows.find(r => r.request_id === args.at(-1))!
          if (target.status !== 'pending') return { success: true }
          target.attempts++
          if (sql.includes("status='completed'")) { target.status = 'completed'; target.result_plan_id = String(args[0]) }
          return { success: true }
        },
      }
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) { return Promise.all(statements.map(s => s.run())) },
  }
  return { env: { DB: db, ML_CONTROLLER_URL: 'https://controller.invalid' } as unknown as Bindings, rows }
}
async function main() {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  let fail = false
  let invalidReceipt = false
  let onSend: (() => void) | undefined
  globalThis.fetch = async (_input, init) => {
    calls.push(String(init?.body)); onSend?.()
    if (fail) throw new Error('synthetic delivery failure')
    return Response.json(invalidReceipt ? { status: 'queued' } : { status: 'replanned', plan_id: resultPlan })
  }
  try {
    const f = fixture([row('1', '1101', .0625), row('2', '3576', .0625), row('3', '3290', .0625), row('4', '8105', .0375)])
    assert.equal(await flushL4Replans(f.env, '2026-09-30', { debatePending: true }), false)
    assert.equal(calls.length, 0, 'partial debate must not trigger incremental optimizations')
    assert.equal(await flushL4Replans(f.env, '2026-09-30'), true)
    assert.equal(calls.length, 1, 'four completed debate constraints require only one optimizer request')
    assert.equal(Object.keys(JSON.parse(calls[0]).weight_caps).length, 4)
    assert.ok(f.rows.every(r => r.status === 'completed' && r.result_plan_id === resultPlan))
    assert.equal(await flushL4Replans(f.env, '2026-09-30'), true)
    assert.equal(calls.length, 1, 'acknowledged batch must not rerun')

    const retry = fixture([row('5', '1101', .08), row('6', '1101', .04)])
    fail = true
    assert.equal(await flushL4Replans(retry.env, '2026-09-30'), false)
    assert.ok(retry.rows.every(r => r.status === 'pending'))
    const failedPayload = calls.at(-1)
    fail = false
    assert.equal(await flushL4Replans(retry.env, '2026-09-30'), true)
    assert.equal(calls.at(-1), failedPayload, 'retry must preserve the controller idempotency payload')
    assert.equal(JSON.parse(calls.at(-1)!).weight_caps['1101'], .04, 'strictest cap wins')

    const arriving = fixture([row('7', '1101', .04)])
    onSend = () => { arriving.rows.push(row('8', '3311', .03)); onSend = undefined }
    assert.equal(await flushL4Replans(arriving.env, '2026-09-30'), false)
    assert.equal(arriving.rows[1].status, 'pending', 'new information must not be acknowledged by an older receipt')
    assert.equal(await flushL4Replans(arriving.env, '2026-09-30'), true)

    const urgent = fixture([row('9', '1101', .04), row('10', '3576', 0, 'execution_hard_risk_veto')])
    urgent.rows[1].request_json = JSON.stringify({ plan_id: source, veto_symbols: ['3576'], weight_caps: {}, reason: 'execution_hard_risk_veto' })
    assert.equal(await flushL4Replans(urgent.env, '2026-09-30', { debatePending: true }), true)
    assert.deepEqual(JSON.parse(calls.at(-1)!).veto_symbols, ['3576'], 'urgent risk cannot wait for debate completion')

    const concurrent = fixture([row('concurrent', '1101', .04)])
    const before = calls.length
    let second: Promise<boolean> | undefined
    onSend = () => { onSend = undefined; second = flushL4Replans(concurrent.env, '2026-09-30') }
    assert.equal(await flushL4Replans(concurrent.env, '2026-09-30'), true)
    assert.equal(await second, false, 'concurrent delivery must be busy, not another optimizer call')
    assert.equal(calls.length, before + 1, 'simultaneous flushes make one HTTP request')

    invalidReceipt = true
    const missingReceipt = fixture([row('11', '1101', .04), row('12', '3290', .04)])
    assert.equal(await flushL4Replans(missingReceipt.env, '2026-09-30'), false)
    assert.ok(missingReceipt.rows.every(r => r.status === 'pending'), 'no complete acknowledgement without a valid plan receipt')
  } finally { globalThis.fetch = originalFetch }
  console.log('L4 debate batching: PASS')
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
