import assert from 'node:assert/strict'
import test from 'node:test'
import {
  L05_LIQUIDITY_CAPACITY_POLICY_CHECKSUM,
  compactL05LiquidityCapacityReceipt,
  evaluateL05LiquidityCapacity,
} from '../worker/src/lib/l05LiquidityCapacity'
import {
  buildReceiptIndex,
  classifyScoringRow,
  forwardUpdateSql,
  predictedPostImage,
  readUniverseBlock,
  receiptJson,
  rollbackJsonRemoveSql,
  rollbackRestoreSql,
  sha256Hex,
  type D1ScoringRow,
} from './screener_l05_receipt_backfill'

const prices = Array.from({ length: 25 }, (_, i) => ({ close: 100 + i, Trading_Volume: 200_000 + i * 1000 }))
const passReceipt = evaluateL05LiquidityCapacity(prices, 10_000_000)
const failReceipt = evaluateL05LiquidityCapacity(prices.slice(0, 2), 10_000_000)

const universePass = { symbol: '2330', stage: 'universe', decision: 'pass', evidence: { close: 124, tradingRestrictionRisk: false, ...passReceipt } }
const universeDropL05 = { symbol: '9999', stage: 'universe', decision: 'drop', evidence: { ...failReceipt } }
const universeEtf = { symbol: '0050', stage: 'universe', decision: 'drop', evidence: { market: 'TWSE' } }

function d1Row(overrides: Partial<D1ScoringRow> = {}): D1ScoringRow {
  return {
    id: 7, symbol: '2330', decision: 'pass', evidence: '{"chip_score":40,"name":"台積電"}',
    valid: 1, schema_version: null, l05_type: null, roundtrip_ok: 1, append_ok: 1, ...overrides,
  }
}

test('receipt index uses the production compact function and skips rows without an L0.5 verdict', () => {
  const index = buildReceiptIndex([universePass, universeDropL05, universeEtf,
    { symbol: '2330', stage: 'scoring', decision: 'pass', evidence: { chip_score: 1 } }])
  assert.equal(index.universeItems, 3)
  assert.equal(index.universeWithBoolPassed, 2)
  assert.deepEqual(index.receipts.get('2330'), compactL05LiquidityCapacityReceipt(passReceipt))
  assert.equal(index.receipts.get('2330')?.policy_checksum, L05_LIQUIDITY_CAPACITY_POLICY_CHECKSUM)
  assert.equal(index.receipts.get('9999')?.passed, false)
  assert.equal(index.receipts.has('0050'), false)
  assert.equal(index.artifactScoringAlreadyCarriesReceipt, 0)
})

test('duplicate universe verdicts for one symbol are ambiguous and never planned', () => {
  const index = buildReceiptIndex([universePass, { ...universePass, evidence: { ...universePass.evidence, passed: false } }])
  assert.deepEqual(index.ambiguousSymbols, ['2330'])
  assert.equal(index.receipts.has('2330'), false)
})

test('scoring rows are classified; pointer rows are counted, never planned', () => {
  const receipts = buildReceiptIndex([universePass]).receipts
  assert.equal(classifyScoringRow(d1Row(), receipts), 'plan_update')
  assert.equal(classifyScoringRow(d1Row({ schema_version: 'd1-audit-json-pointer-v1' }), receipts), 'pointer')
  assert.equal(classifyScoringRow(d1Row({ schema_version: 'legacy-screener-evidence-pointer-v1' }), receipts), 'pointer')
  assert.equal(classifyScoringRow(d1Row({ l05_type: 'object' }), receipts), 'already_has_receipt')
  assert.equal(classifyScoringRow(d1Row({ valid: 0 }), receipts), 'invalid_json')
  assert.equal(classifyScoringRow(d1Row({ symbol: '1101' }), receipts), 'no_artifact_receipt')
  assert.equal(classifyScoringRow(d1Row({ append_ok: 0 }), receipts), 'append_shape_unverified')
  assert.equal(classifyScoringRow(d1Row({ evidence: '[]' }), receipts), 'not_json_object')
})

test('post-image appends the receipt; SQL guards use UTF-8 byte length and escape quotes', () => {
  const receipt = compactL05LiquidityCapacityReceipt(passReceipt)
  const pre = `{"name":"台積電","note":"it's"}`
  const post = predictedPostImage(pre, receipt)
  assert.equal(post, `{"name":"台積電","note":"it's","l05_liquidity_capacity":${receiptJson(receipt)}}`)
  assert.deepEqual(JSON.parse(post).l05_liquidity_capacity, receipt)
  const forward = forwardUpdateSql({ id: 7, run_id: "run-'x", evidence: pre }, receipt)
  assert.match(forward, new RegExp(`length\\(CAST\\(evidence AS BLOB\\)\\) = ${Buffer.byteLength(pre, 'utf8')}`))
  assert.notEqual(Buffer.byteLength(pre, 'utf8'), pre.length)
  assert.match(forward, /run_id = 'run-''x'/)
  assert.match(forward, /IS NULL;$/)
  const restore = rollbackRestoreSql({ id: 7, run_id: 'r', evidence: pre }, receipt)
  assert.match(restore, /SET evidence = '\{"name":"台積電","note":"it''s"\}'/)
  assert.match(restore, new RegExp(`length\\(CAST\\(evidence AS BLOB\\)\\) = ${Buffer.byteLength(post, 'utf8')}`))
  assert.match(rollbackJsonRemoveSql({ id: 7, run_id: 'r' }), /json_remove\(evidence, '\$\.l05_liquidity_capacity'\)/)
})

test('chunked artifact: reads only the leading universe block and verifies chunk coverage', () => {
  const chunkItems = [[universeEtf, universePass], [universeDropL05, { symbol: '2330', stage: 'scoring', decision: 'pass', evidence: {} }], [{ symbol: 'x', stage: 'final_selection' }]]
  let rowStart = 0
  const chunks = chunkItems.map((items, index) => {
    const ref = { chunk_index: index, row_start: rowStart, row_end_exclusive: rowStart + items.length, row_count: items.length,
      r2_key: `k${index}`, checksum: `sha256:${'0'.repeat(63)}${index}`, schema_version: 'screener-funnel-evidence-chunk-v1' }
    rowStart += items.length
    return ref
  })
  const envelope = { schema_version: 'screener-funnel-evidence-index-v1', domain: 'screener_funnel', business_date: '2026-11-23',
    payload: { storage_mode: 'chunked_r2_manifest_v1', logical_schema_version: 'screener-funnel-evidence-v3', item_count: rowStart, chunks } }
  const fetched: string[] = []
  const block = readUniverseBlock(envelope, '2026-11-23', (key) => {
    fetched.push(key)
    const index = Number(key.slice(1))
    return { bytes: 10, json: { domain: 'screener_funnel_chunk', business_date: '2026-11-23', schema_version: 'screener-funnel-evidence-chunk-v1',
      payload: { storage_mode: 'chunked_r2_child_v1', logical_schema_version: 'screener-funnel-evidence-v3', chunk_index: index, items: chunkItems[index] } } }
  })
  assert.deepEqual(fetched, ['k0', 'k1'])
  assert.equal(block.universe_block_complete, true)
  assert.equal(buildReceiptIndex(block.items).receipts.size, 2)
  assert.throws(() => readUniverseBlock({ ...envelope, business_date: '2026-11-20' }, '2026-11-23', () => { throw new Error('unused') }),
    /artifact_envelope_identity_mismatch/)
})

test('sha256Hex is plain hex (artifact checksum is "sha256:" + this)', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
