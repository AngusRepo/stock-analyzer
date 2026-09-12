import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { processPaperCorporateActions, type CorporateActionSnapshot } from './paperCorporateActions'
import { readCorporateOpeningBasis } from './paperCorporateOpeningBasis'
import { withPaperExecutionScope } from './paperExecutionScope'

test('native D1 keeps opening evidence and the old maximum economic batch atomic', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("isolated") } }', d1Databases: ['PAPER'] })
  try {
    const db = await mf.getD1Database('PAPER')
    for (const file of ['domain-migrations/paper/0001_paper_baseline.sql', 'domain-migrations/paper/0004_corporate_action_accounting.sql']) {
      for (const sql of fs.readFileSync(file, 'utf8').replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) {
        await db.prepare(sql).run()
      }
    }
    await db.prepare('INSERT INTO paper_accounts(id,cash,initial_cash) VALUES(1,777,777),(2,90000,100000)').run()
    const symbols = Array.from({ length: 33 }, (_, i) => String(1000 + i))
    await db.batch(symbols.map(symbol => db.prepare('INSERT INTO paper_positions(account_id,symbol,shares,avg_cost) VALUES(2,?,100,100)').bind(symbol)))
    const day = '2026-09-07'
    const snapshot: CorporateActionSnapshot = { schema_version: 'paper-corporate-source-v1', session_date: day,
      observed_at: day + 'T00:00:00Z', source_checksum: 'a'.repeat(64), covered_symbols: symbols, blockers: {},
      tax_basis: 'gross_before_personal_tax', actions: symbols.flatMap(symbol => [
        { action_id: 'cash-' + symbol, symbol, kind: 'cash' as const, ex_date: day, payable_date: '2026-09-10', cash_per_share: 2, stock_per_share: 0 },
        { action_id: 'stock-' + symbol, symbol, kind: 'stock' as const, ex_date: day, payable_date: '2026-09-09', cash_per_share: 0, stock_per_share: .1 },
      ]) }
    const env = { DB: db } as any
    const process = () => withPaperExecutionScope({ environment: env, accountId: 2,
      databases: { paper: db as unknown as D1Database }, nowMs: Date.parse(day + 'T00:00:00Z'),
      fetchFrozen: async () => { throw new Error('external network forbidden') } },
      () => processPaperCorporateActions(env, day, snapshot, new Map(symbols.map(s => [s, 100]))))
    await db.prepare("CREATE TRIGGER fail_final BEFORE INSERT ON paper_corporate_sessions_v1 BEGIN SELECT RAISE(ABORT,'fixture_final_failure'); END").run()
    await assert.rejects(process(), /fixture_final_failure/)
    assert.equal(await readCorporateOpeningBasis(db as unknown as D1Database, 2, day), null)
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM paper_corporate_entitlements_v1').first())!.n, 0)
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM paper_positions WHERE account_id=2 AND avg_cost=100').first())!.n, 33)
    await db.prepare('DROP TRIGGER fail_final').run()
    await process()
    const first = await readCorporateOpeningBasis(db as unknown as D1Database, 2, day)
    assert.equal(first!.positions.length, 33)
    await process()
    assert.deepEqual(await readCorporateOpeningBasis(db as unknown as D1Database, 2, day), first)
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM paper_corporate_entitlements_v1').first())!.n, 66)
    assert.equal((await db.prepare('SELECT cash FROM paper_accounts WHERE id=1').first())!.cash, 777)
  } finally {
    await mf.dispose()
  }
})

test('native D1 late original cash correction, payment and audit roll back together and retry once', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("isolated") } }', d1Databases: ['PAPER'] })
  try {
    const db = await mf.getD1Database('PAPER')
    for (const file of ['domain-migrations/paper/0001_paper_baseline.sql', 'domain-migrations/paper/0004_corporate_action_accounting.sql']) {
      for (const sql of fs.readFileSync(file, 'utf8').replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) {
        await db.prepare(sql).run()
      }
    }
    await db.prepare('INSERT INTO paper_accounts(id,cash,initial_cash) VALUES(1,777,777),(2,90000,100000)').run()
    await db.prepare("INSERT INTO paper_positions(account_id,symbol,shares,avg_cost) VALUES(2,'2330',100,100)").run()
    const env = { DB: db } as any
    const process = (day: string, actions: CorporateActionSnapshot['actions']) => {
      const source: CorporateActionSnapshot = { schema_version: 'paper-corporate-source-v1', session_date: day,
        observed_at: day + 'T00:00:00Z', source_checksum: 'a'.repeat(64), covered_symbols: ['2330'],
        blockers: {}, tax_basis: 'gross_before_personal_tax', actions }
      return withPaperExecutionScope({ environment: env, accountId: 2,
        databases: { paper: db as unknown as D1Database }, nowMs: Date.parse(day + 'T00:00:00Z'),
        fetchFrozen: async () => { throw new Error('external network forbidden') } },
        () => processPaperCorporateActions(env, day, source, new Map([['2330', 100]])))
    }
    await process('2026-09-07', [])
    await db.prepare('DELETE FROM paper_positions WHERE account_id=2').run()
    const actions: CorporateActionSnapshot['actions'] = [{ action_id: 'cash', symbol: '2330', kind: 'cash',
      ex_date: '2026-09-07', payable_date: '2026-09-09', cash_per_share: 2, stock_per_share: 0 }]
    await db.prepare("CREATE TRIGGER fail_late_final BEFORE INSERT ON paper_corporate_sessions_v1 WHEN NEW.session_date='2026-09-10' BEGIN SELECT RAISE(ABORT,'late_final_failed'); END").run()
    await assert.rejects(process('2026-09-10', actions), /late_final_failed/)
    assert.equal((await db.prepare('SELECT cash FROM paper_accounts WHERE id=2').first())!.cash, 90000)
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM paper_corporate_entitlements_v1').first())!.n, 0)
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM paper_execution_events WHERE trade_date='2026-09-10'").first())!.n, 0)
    await db.prepare('DROP TRIGGER fail_late_final').run()
    await process('2026-09-10', actions)
    await process('2026-09-10', actions)
    await process('2026-09-11', actions)
    assert.equal((await db.prepare('SELECT cash FROM paper_accounts WHERE id=2').first())!.cash, 90200)
    const right = await db.prepare('SELECT eligible_shares,cash_due,settled,recognized_at FROM paper_corporate_entitlements_v1 WHERE account_id=2').first()
    assert.deepEqual(right, { eligible_shares: 100, cash_due: 200, settled: 1, recognized_at: '2026-09-10T00:00:00.000Z' })
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM paper_execution_events WHERE event_type='corporate_cash_correction'").first())!.n, 1)
    assert.equal((await db.prepare('SELECT cash FROM paper_accounts WHERE id=1').first())!.cash, 777)
  } finally { await mf.dispose() }
})
