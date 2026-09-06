import assert from 'node:assert/strict'
import { readIpoShadow } from './ipoShadowReadModel'

async function main() {
  const seen: string[] = []
  const db = (mode: string) => ({ prepare(sql: string) {
    seen.push(sql)
    const stmt = { bind: (..._args: unknown[]) => stmt,
      first: async () => {
        if (mode === 'error') throw new Error('no such table: ipo_shadow_candidates_v1')
        if (sql.includes('FROM ipo_shadow_candidates')) return mode === 'empty' ? null : { candidate_id: 'fixed', registered_at: '2026-09-07T14:00:00Z' }
        return { dates: 140, rows: 70000, latest: '2027-04-01' }
      }, all: async () => ({ results: [{ metrics_json: JSON.stringify({ signal_date: '2026-09-07', sample_count: 500,
        paired: true, ipo: { rank_ic: .1, rmse: .08, proxy_net_return: .01, invested_fraction: 1, max_weight: .2 },
        l4: { rank_ic: .01, rmse: .07, proxy_net_return: .001, invested_fraction: 1, max_weight: .3 },
        proxy_return_delta: .009, blockers: [] }), mature_dates: 130, paired_dates: 128 }] }) }
    return stmt
  } }) as unknown as D1Database
  assert.equal((await readIpoShadow(db('empty'), '2026-09-07')).status, 'not_registered')
  const missing = await readIpoShadow(db('error'), '2026-09-07')
  assert.equal(missing.status, 'unavailable')
  assert(missing.blockers.includes('ipo_shadow_migration_missing'))
  const result = await readIpoShadow(db('ok'), '2027-04-01')
  assert.equal(result.mature_dates, 130) // Counts are not capped by the recent-row display limit.
  assert.equal(result.paired_dates, 128)
  assert.equal(result.promotion_allowed, false)
  assert(seen.some(sql => sql.includes("date(registered_at, '+8 hours')<=?")))
  assert(seen.every(sql => !/\b(INSERT|UPDATE|DELETE)\b/.test(sql)))
  console.log('IPO read model tests passed')
}
void main()
