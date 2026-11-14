import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { loadStockMonthlyRevenueRows } from './fundamentalData'
import { loadStrategyRawFundamentalSignals } from './marketScreener'
import { resolveLegacyMonthlyRevenueEvidence } from './strategySpec'
import { syncLegacyRevenueFromFinLabCanonical } from './updateOrchestrator'

// canonical_revenue_monthly.revenue_month is FinLab's publication-deadline index:
// 2026-09-10 = August revenue, 2026-10-12 = September revenue (10/10 holiday shift).
function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE stocks(id INTEGER PRIMARY KEY, symbol TEXT, name TEXT, market TEXT, sector TEXT);
    CREATE TABLE canonical_revenue_monthly(stock_id TEXT, revenue_month TEXT, market_segment TEXT,
      revenue REAL, mom REAL, yoy REAL, source TEXT, as_of_date TEXT);
    CREATE TABLE monthly_revenue(stock_id INTEGER, date TEXT, revenue REAL, revenue_yoy REAL, revenue_mom REAL,
      PRIMARY KEY(stock_id, date));
    INSERT INTO stocks VALUES(1, '2330', 'TSMC', 'TWSE', 'semis');
    INSERT INTO canonical_revenue_monthly VALUES
      ('2330', '2025-04-10', 'listed', 50, 0.5, 5, 'finlab.monthly_revenue', '2026-10-07'),
      ('2330', '2026-09-10', 'listed', 100, 1, 10, 'finlab.monthly_revenue', '2026-10-07'),
      ('2330', '2026-10-12', 'listed', 200, 2, 20, 'finlab.monthly_revenue', '2026-10-12');
  `)
  const binds: Array<{ sql: string; params: unknown[] }> = []
  function prepare(sql: string) {
    let params: unknown[] = []
    const statement = {
      bind(...values: unknown[]) {
        params = values
        binds.push({ sql, params: values })
        return statement
      },
      async first() { return db.prepare(sql).get(...(params as any[])) ?? null },
      async all() { return { results: db.prepare(sql).all(...(params as any[])) } },
      async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...(params as any[])).changes) } } },
    }
    return statement
  }
  const adapter = {
    prepare,
    async batch(statements: Array<{ run(): Promise<any> }>) {
      const out = []
      for (const statement of statements) out.push(await statement.run())
      return out
    },
  }
  return { db, binds, env: { DB: adapter } as any }
}

function revenueBinds(binds: Array<{ sql: string; params: unknown[] }>) {
  return binds.filter((call) => call.sql.includes('FROM canonical_revenue_monthly'))
}

void (async () => {
  {
    const { binds, env } = fixture()
    const live = (date: string) => resolveLegacyMonthlyRevenueEvidence({
      signalDate: date, observedTaipeiDate: date, evidenceMode: 'live_current',
    })
    const late = await loadStrategyRawFundamentalSignals(env, ['2330'], '2026-10-28', live('2026-10-28'))
    assert.equal(late.fundamentals.get('2330')?.monthlyRevenueYoY, 20, '10/28 must read the September index 2026-10-12')
    assert.deepEqual(revenueBinds(binds).at(-1)?.params, ['2330', '2026-10-28', '2026-10-28'],
      'screener revenue bounds must be full signal dates for both the row and MAX subquery')
    const early = await loadStrategyRawFundamentalSignals(env, ['2330'], '2026-10-11', live('2026-10-11'))
    assert.equal(early.fundamentals.get('2330')?.monthlyRevenueYoY, 10, 'before the deadline index the August row stays latest')

    // A cross-midnight rerun of 10/28 observed on 10/29 keeps the 10/28 revenue bound.
    const rerun = resolveLegacyMonthlyRevenueEvidence({
      signalDate: '2026-10-28', observedTaipeiDate: '2026-10-29', evidenceMode: 'live_current',
    })
    assert.equal(rerun.queryAllowed, true)
    const rerunLoad = await loadStrategyRawFundamentalSignals(env, ['2330'], '2026-10-28', rerun)
    assert.equal(rerunLoad.fundamentals.get('2330')?.monthlyRevenueYoY, 20)
    assert.deepEqual(revenueBinds(binds).at(-1)?.params, ['2330', '2026-10-28', '2026-10-28'])
  }

  {
    const { binds, env } = fixture()
    const rows = await loadStockMonthlyRevenueRows(env, 1, { months: 3, asOf: '2026-10-28' })
    assert.equal(rows[0]?.date, '2026-10-12', 'stock page as-of read must include the 2026-10-12 index on 10/28')
    assert.deepEqual(revenueBinds(binds).at(-1)?.params, ['2330', '2026-10-28', 3])
    const before = await loadStockMonthlyRevenueRows(env, 1, { months: 3, asOf: '2026-10-11' })
    assert.equal(before[0]?.date, '2026-09-10')
  }

  {
    const { db, binds, env } = fixture()
    const written = await syncLegacyRevenueFromFinLabCanonical(env, '2026-10-28')
    assert.equal(written, 3)
    assert.deepEqual(revenueBinds(binds).at(-1)?.params, ['2330', '2026-10-28', '2026-10-28'])
    const dates = db.prepare('SELECT date FROM monthly_revenue ORDER BY date').all().map((row: any) => row.date)
    assert.deepEqual(dates, ['2025-04-10', '2026-09-10', '2026-10-12'],
      'legacy mirror keeps the 18-month lower bound at month start and includes the 2026-10-12 index')
    db.exec('DELETE FROM monthly_revenue')
    await syncLegacyRevenueFromFinLabCanonical(env, '2026-10-11')
    const early = db.prepare('SELECT date FROM monthly_revenue ORDER BY date').all().map((row: any) => row.date)
    assert.deepEqual(early, ['2025-04-10', '2026-09-10'])
  }

  console.log('revenuePitBounds.test.ts passed')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
