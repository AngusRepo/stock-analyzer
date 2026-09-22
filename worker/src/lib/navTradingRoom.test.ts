import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readNavComparison } from './navTradingRoom'

const fixture = JSON.parse(readFileSync(new URL('../../test-fixtures/strategy-ab-native-journal.json', import.meta.url), 'utf8'))
function database(data: any): D1Database {
  return { prepare: (sql: string) => ({ bind: (...params: any[]) => ({ first: async () => null, all: async () => {
    let results: any[]
    if (sql.includes('paired_nav_daily_journal_v1')) results = data.paired_nav_daily_journal_v1.filter((r: any) => r.pair_id === params[0] && r.session_date <= params[1]).sort((a: any,b: any) => b.session_date.localeCompare(a.session_date))
    else if (sql.includes('paired_nav_frozen_manifests_v1')) results = data.paired_nav_frozen_manifests_v1.filter((r: any) => r.snapshot_kind === 'execution_receipt' && r.parent_snapshot_id === params[0] && r.signal_date === params[1])
    else results = data.paired_nav_frozen_parts_v1.filter((r: any) => r.snapshot_id === params[0]).sort((a: any,b: any) => a.part_no-b.part_no)
    return {success:true,results}
  } }) }) } as unknown as D1Database
}
function rewriteLast(data: any, mutate: (b: any) => void) {
  const row = data.paired_nav_daily_journal_v1[1], body = JSON.parse(row.payload_json)
  mutate(body)
  row.payload_json = JSON.stringify(body)
  row.payload_checksum = createHash('sha256').update(row.payload_json).digest('hex')
}
async function main() {
  const result = await readNavComparison(database(fixture), 'candidate-pair', '2026-09-09')
  if (process.env.AB_UI_FIXTURE_OUT) writeFileSync(process.env.AB_UI_FIXTURE_OUT, JSON.stringify(result))
  assert.equal(result.status, 'available')
  assert.equal(result.strategy_ab?.role, 'A')
  assert.equal(result.latest?.receipt_status, 'verified')
  assert.equal(result.initial_nav, 100000)
  assert.equal(result.history.length, 2)
  assert.equal(result.latest?.candidate.cash, 59943)
  assert.equal(result.latest?.candidate.nav, 101943)
  assert.equal(result.latest?.candidate.estimated_nav_including_rebate, 101980)
  assert.equal(result.latest?.candidate.rebate_receivable, 37)
  for (const mutate of [
    (b: any) => { b.initial_account_nav = 99999 },
    (b: any) => { b.arms.candidate.commission_rebate.cash_credit = 37 },
    (b: any) => { b.arms.candidate.estimated_nav_including_rebate += 1 },
    (b: any) => { b.comparison.strategy_ab.role = 'B' },
  ]) {
    const invalid = structuredClone(fixture)
    rewriteLast(invalid, mutate)
    assert.equal((await readNavComparison(database(invalid), 'candidate-pair', '2026-09-09')).status, 'unavailable')
  }
  const noReceipt = structuredClone(fixture)
  noReceipt.paired_nav_frozen_manifests_v1 = []
  assert.equal((await readNavComparison(database(noReceipt), 'candidate-pair', '2026-09-09')).latest?.receipt_status, 'missing')
  console.log('navTradingRoom: native Python journal, rebate, identity and receipt integrity passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
