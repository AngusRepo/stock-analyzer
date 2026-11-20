import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { finLabRetryScopeForReadiness } from './updateOrchestrator'
import { finLabLatePublicationFieldsForLane, finLabRequiredFieldsForLane } from './finlabSourceContract'
import type { Bindings } from '../types'

// C28-25 (ii): the tool upserts every canonical_chip_daily column and refuses (finlab_source_not_ready) a chip
// apply without margin/short. A chip retry scope must therefore always carry the late-published fields.
const date = '2026-10-29'
const LATE = ['margin_balance', 'short_balance']
const CHIP_MISSING = `canonical_chip_daily:${date}`
const PRICE_MISSING = `canonical_market_daily:${date}`
const VALUATION_MISSING = 'canonical_fundamental_features:valuation_daily'

type Row = [lane: string, field: string, status: string, targetRows: number]

async function scopeFor(t: any, missingKeys: string[], rows: Row[], flags: Record<string, string> = {}) {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['OPS'] })
  t.after(() => mf.dispose())
  const ops = await mf.getD1Database('OPS')
  await ops.batch([
    ops.prepare(`CREATE TABLE source_key_report(target_date TEXT,lane TEXT,field TEXT,api_key TEXT,required INTEGER,status TEXT,
      rows INTEGER,target_rows INTEGER,latest_date TEXT,updated_at TEXT)`),
    ops.prepare('CREATE TABLE source_diff_report(run_id TEXT,source TEXT,dataset_lane TEXT,finlab_rows INTEGER)'),
    ...rows.map(([lane, field, status, targetRows]) => ops.prepare(
      'INSERT INTO source_key_report VALUES (?,?,?,?,1,?,?,?,?,?)').bind(
      date, lane, field, field, status, targetRows, targetRows, date, `${date}T13:00:00Z`)),
  ])
  const env = {
    MULTI_D1_ACTIVE_DOMAINS: 'core,market,learning,ops,execution,paper,research',
    DB: ops, CORE_DB: ops, MARKET_DB: ops, LEARNING_DB: ops, EXECUTION_DB: ops, PAPER_DB: ops, RESEARCH_DB: ops, OPS_DB: ops,
    ...flags,
  } as unknown as Bindings
  const scope = await finLabRetryScopeForReadiness(env, date,
    { ok: false, checks: [], summary: 'missing', missingKeys })
  const entries: Array<{ lane: string; fields: string[] }> = scope.keyScopeJson ? JSON.parse(scope.keyScopeJson) : []
  const fieldsOf = (lane: string) => entries.find((entry) => entry.lane === lane)?.fields
  return { scope, entries, fieldsOf }
}

test('contract: only chip_diversity has late-published fields', () => {
  assert.deepEqual(finLabLatePublicationFieldsForLane('chip_diversity'), LATE)
  assert.deepEqual(finLabRequiredFieldsForLane('chip_diversity'), ['foreign_net'])
  for (const lane of ['daily_price', 'fundamental_factor_diversity', 'regime_context', 'broker_flow_diversity'])
    assert.deepEqual(finLabLatePublicationFieldsForLane(lane), [], lane)
})

test('key-level: chip ready by foreign_net but margin empty retries with the late fields (reuse branch)', async (t) => {
  const { scope, fieldsOf } = await scopeFor(t, [CHIP_MISSING], [
    ['chip_diversity', 'foreign_net', 'ok', 1800],
    ['chip_diversity', 'margin_balance', 'empty', 0],
    ['chip_diversity', 'short_balance', 'empty', 0],
  ])
  assert.deepEqual(fieldsOf('chip_diversity'), ['foreign_net', ...LATE])
  assert.deepEqual(scope.fullyReadyLanes, ['chip_diversity'])
  assert.equal(scope.retryKeyCount, 0, 'late fields are carried, not counted as retry keys')
  assert.match(String(scope.canonicalDatasets), /canonical_chip_daily/)
})

test('key-level: chip foreign_net not published (sentinel) and no chip rows both carry the late fields', async (t) => {
  const sentinel = await scopeFor(t, [CHIP_MISSING], [
    ['chip_diversity', 'foreign_net', 'missing_target_date', 0],
    ['chip_diversity', 'margin_balance', 'missing_target_date', 0],
  ])
  assert.deepEqual(sentinel.fieldsOf('chip_diversity'), ['foreign_net', ...LATE])
  assert.deepEqual(sentinel.scope.sourceNotReadyLanes, ['chip_diversity'])
  assert.equal(sentinel.scope.sentinelKeyCount, 1)

  const noRows = await scopeFor(t, [CHIP_MISSING, PRICE_MISSING], [['daily_price', 'close', 'ok', 1800]])
  assert.deepEqual(noRows.fieldsOf('chip_diversity'), ['foreign_net', ...LATE])
  assert.equal(noRows.scope.retryKeyCount, 1)
})

test('key-level: a retryable foreign_net failure keeps margin/short next to it', async (t) => {
  const { fieldsOf } = await scopeFor(t, [CHIP_MISSING], [
    ['chip_diversity', 'foreign_net', 'failed', 0],
    ['chip_diversity', 'margin_balance', 'ok', 1800],
    ['chip_diversity', 'short_balance', 'ok', 1800],
  ])
  assert.deepEqual(fieldsOf('chip_diversity'), ['foreign_net', ...LATE])
})

test('key-level: lanes other than chip are unchanged and chip is not added when not requested', async (t) => {
  const { entries, fieldsOf } = await scopeFor(t, [PRICE_MISSING, VALUATION_MISSING], [
    ['daily_price', 'close', 'missing_target_date', 0],
    ['fundamental_factor_diversity', 'pe', 'empty', 0],
    ['fundamental_factor_diversity', 'pb', 'ok', 1800],
  ])
  assert.equal(entries.some((entry) => entry.lane === 'chip_diversity'), false)
  for (const entry of entries)
    for (const field of LATE) assert.ok(!entry.fields.includes(field), `${entry.lane} got ${field}`)
  assert.deepEqual(fieldsOf('daily_price'), ['close'])
})

test('lane-level: an unscoped chip lane stays [] (every key) and other lanes keep their own fields', async (t) => {
  const { entries, fieldsOf } = await scopeFor(t, [CHIP_MISSING, VALUATION_MISSING], [],
    { FINLAB_KEY_LEVEL_RETRY_ENABLED: 'false' })
  assert.deepEqual(fieldsOf('chip_diversity'), [])
  assert.deepEqual(fieldsOf('fundamental_factor_diversity'), ['pe', 'pb'])
  assert.equal(entries.length, 2)
})
