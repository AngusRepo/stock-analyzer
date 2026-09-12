import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { advancePaperExecutionClock, withPaperExecutionScope } from './paperExecutionScope'
import { readCorporateOpeningBasis, readCorporateCashDiscoveryDates } from './paperCorporateOpeningBasis'
import { processPaperCorporateActions, outstandingCorporateEntitlements, corporateReceivableValue,
  corporateStockQuantity, corporateReceivableBounds,
  type CorporateActionSnapshot } from './paperCorporateActions'

function fixture(onRead?: (query: string) => void, onPrepare?: (query: string) => void) {
  const sql = new DatabaseSync(':memory:')
  sql.exec(fs.readFileSync('domain-migrations/paper/0001_paper_baseline.sql', 'utf8'))
  sql.exec(fs.readFileSync('domain-migrations/paper/0004_corporate_action_accounting.sql', 'utf8'))
  sql.exec(`INSERT INTO paper_accounts(id,cash,initial_cash) VALUES(1,777,777),(2,90000,100000);
    INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,entry_price,entry_date,initial_stop,trailing_stop,highest_since_entry,tp1_price,tp2_price)
    VALUES(2,'2330','fixture',100,100,100,'2026-09-01',95,97,110,120,130);`)
  const prepare = (query: string, args: any[] = []): any => {
    onPrepare?.(query)
    return {
    query, args, bind: (...values: any[]) => prepare(query, values),
    first: async () => sql.prepare(query).get(...args) ?? null,
    all: async () => {
      const results = sql.prepare(query).all(...args)
      onRead?.(query)
      return { success: true, results }
    },
    run: async () => { sql.prepare(query).run(...args); return { success: true } },
    }
  }
  const db = { prepare, batch: async (statements: any[]) => {
    sql.exec('BEGIN')
    try {
      for (const statement of statements) sql.prepare(statement.query).run(...statement.args)
      sql.exec('COMMIT')
      return statements.map(() => ({ success: true }))
    } catch (error) { sql.exec('ROLLBACK'); throw error }
  } } as unknown as D1Database
  const env = { DB: db } as any
  const source = (date = '2026-09-07'): CorporateActionSnapshot => ({
    schema_version: 'paper-corporate-source-v1', session_date: date, observed_at: date + 'T00:00:00Z',
    source_checksum: 'a'.repeat(64), covered_symbols: ['2330'], blockers: {}, tax_basis: 'gross_before_personal_tax',
    actions: [
      { action_id: 'cash', symbol: '2330', kind: 'cash', ex_date: '2026-09-07', payable_date: '2026-09-10', cash_per_share: 2, stock_per_share: 0 },
      { action_id: 'stock', symbol: '2330', kind: 'stock', ex_date: '2026-09-07', payable_date: '2026-09-09', cash_per_share: 0, stock_per_share: .1 },
    ],
  })
  const process = (snapshot = source(), closes = new Map([['2330', 100]])) => withPaperExecutionScope({ environment: env, accountId: 2,
    databases: { paper: db }, nowMs: Date.parse(snapshot.session_date + 'T00:00:00Z'),
    fetchFrozen: async () => { throw new Error('network forbidden') } },
    () => processPaperCorporateActions(env, snapshot.session_date, snapshot, closes))
  return { sql, db, source, process }
}

test('original committed opening history finds sold symbols without using current holdings or another account', async t => {
  const f = fixture()
  t.after(() => f.sql.close())
  await f.process({ ...f.source(), actions: [] })
  f.sql.exec('DELETE FROM paper_positions WHERE account_id=2')
  await f.process({ ...f.source('2026-09-08'), actions: [] })
  assert.deepEqual(await readCorporateCashDiscoveryDates(f.db, 2, '2026-09-09', Date.parse('2026-09-09T00:00:00Z')),
    { '2330': ['2026-09-07'] })
  assert.deepEqual(await readCorporateCashDiscoveryDates(f.db, 1, '2026-09-09', Date.parse('2026-09-09T00:00:00Z')), {})
  f.sql.exec("UPDATE paper_corporate_sessions_v1 SET source_checksum='wrong' WHERE account_id=2 AND session_date='2026-09-07'")
  await assert.rejects(readCorporateCashDiscoveryDates(f.db, 2, '2026-09-09'), /uncommitted/)
})

test('opening discovery exhausts multiple actual SQL pages without a historical lookback cutoff', async t => {
  let pages = 0
  const f = fixture(sql => { if (sql.includes('e.id>?')) pages++ })
  t.after(() => f.sql.close())
  const days = Array.from({ length: 205 }, (_, index) =>
    new Date(Date.parse('2026-01-01') + index * 86400_000).toISOString().slice(0, 10))
  for (const day of days) await f.process({ ...f.source(day), actions: [] })
  assert.deepEqual(await readCorporateCashDiscoveryDates(f.db, 2, '2026-09-08', Date.parse('2026-09-08T00:00:00Z')),
    { '2330': days })
  assert.equal(pages, 4)
})

for (const currentShares of [0, 100, 500]) test(`late original cash uses original 100 shares, not current ${currentShares}`, async t => {
  const f = fixture()
  t.after(() => f.sql.close())
  await f.process({ ...f.source(), actions: [] })
  const original = f.sql.prepare("SELECT detail_json FROM paper_execution_events WHERE account_id=2 AND trade_date='2026-09-07'").get()
  if (!currentShares) f.sql.exec('DELETE FROM paper_positions WHERE account_id=2')
  else f.sql.prepare('UPDATE paper_positions SET shares=?,initial_stop=71 WHERE account_id=2').run(currentShares)
  const late = { ...f.source('2026-09-08'), actions: [f.source().actions[0]] }
  await f.process(late)
  const read = () => f.sql.prepare('SELECT eligible_shares,cash_due,settled,recognized_at FROM paper_corporate_entitlements_v1 WHERE account_id=2').all()
  assert.deepEqual(JSON.parse(JSON.stringify(read())), [{ eligible_shares: 100, cash_due: 200, settled: 0,
    recognized_at: '2026-09-08T00:00:00.000Z' }])
  const audit = f.sql.prepare("SELECT detail_json,trade_date,created_at FROM paper_execution_events WHERE account_id=2 AND event_type='corporate_cash_correction'").all()
  assert.equal(audit.length, 1)
  assert.equal(audit[0].trade_date, '2026-09-08')
  assert.equal(audit[0].created_at, '2026-09-08T00:00:00.000Z')
  const detail = JSON.parse(String(audit[0].detail_json))
  assert.equal(detail.eligible_shares, 100)
  assert.equal(detail.cash_due, 200)
  assert.equal(detail.ex_date, '2026-09-07')
  assert.equal(detail.opening_observed_at, '2026-09-07T00:00:00.000Z')
  assert.equal(detail.prospective_backfill_credit, 0)
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90000)
  assert.deepEqual(f.sql.prepare("SELECT detail_json FROM paper_execution_events WHERE account_id=2 AND trade_date='2026-09-07'").get(), original)
  if (currentShares) assert.equal(f.sql.prepare('SELECT initial_stop FROM paper_positions WHERE account_id=2').get()!.initial_stop, 71)
  await f.process(late)
  for (const day of ['2026-09-10', '2026-09-11']) {
    const source = { ...f.source(day), actions: late.actions }
    await f.process(source)
    await f.process(source)
    assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90200)
    assert.equal(read().length, 1)
    assert.equal(read()[0].settled, 1)
  }
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=1').get()!.cash, 777)
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM paper_execution_events WHERE event_type='corporate_cash_correction'").get()!.n, 1)
})

test('late original dividend never awards a later buyer from a proven empty original opening', async t => {
  const f = fixture()
  t.after(() => f.sql.close())
  f.sql.exec('DELETE FROM paper_positions WHERE account_id=2')
  await f.process({ ...f.source(), actions: [] })
  f.sql.exec("INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost) VALUES(2,'2330','later-buyer',500,90)")
  await f.process({ ...f.source('2026-09-10'), actions: [f.source().actions[0]] })
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM paper_corporate_entitlements_v1 WHERE account_id=2').get()!.n, 0)
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90000)
})

test('missing legacy opening basis cannot be replaced with current holdings for late cash', async t => {
  const f = fixture()
  t.after(() => f.sql.close())
  await f.process({ ...f.source(), actions: [] })
  f.sql.exec("DELETE FROM paper_execution_events WHERE event_type='corporate_opening_basis'")
  await assert.rejects(f.process({ ...f.source('2026-09-10'), actions: [f.source().actions[0]] }),
    /historical_opening_basis_missing/)
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90000)
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM paper_corporate_sessions_v1 WHERE session_date='2026-09-10'").get()!.n, 0)
})

for (const failure of ['cash', 'marker']) test(`late original already-payable cash rolls back ${failure}, then retries exactly once`, async t => {
  const f = fixture()
  t.after(() => f.sql.close())
  await f.process({ ...f.source(), actions: [] })
  f.sql.exec('DELETE FROM paper_positions WHERE account_id=2')
  const source = { ...f.source('2026-09-10'), actions: [f.source().actions[0]] }
  f.sql.exec(failure === 'cash'
    ? "CREATE TRIGGER late_failure BEFORE UPDATE OF cash ON paper_accounts WHEN NEW.id=2 BEGIN SELECT RAISE(ABORT,'late_cash_failed'); END"
    : "CREATE TRIGGER late_failure BEFORE INSERT ON paper_corporate_sessions_v1 WHEN NEW.session_date='2026-09-10' BEGIN SELECT RAISE(ABORT,'late_marker_failed'); END")
  await assert.rejects(f.process(source), /late_(cash|marker)_failed/)
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90000)
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM paper_corporate_entitlements_v1').get()!.n, 0)
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM paper_execution_events WHERE trade_date='2026-09-10'").get()!.n, 0)
  f.sql.exec('DROP TRIGGER late_failure')
  await f.process(source)
  await f.process(source)
  await f.process({ ...source, ...f.source('2026-09-11'), actions: source.actions })
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90200)
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM paper_corporate_entitlements_v1 WHERE settled=1').get()!.n, 1)
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM paper_execution_events WHERE event_type='corporate_cash_correction'").get()!.n, 1)
})

test('a corrected original dividend cannot be repaid from a revised amount after settlement', async t => {
  const f = fixture()
  t.after(() => f.sql.close())
  await f.process({ ...f.source(), actions: [] })
  await f.process({ ...f.source('2026-09-10'), actions: [f.source().actions[0]] })
  await assert.rejects(f.process({ ...f.source('2026-09-11'),
    actions: [{ ...f.source().actions[0], cash_per_share: 3 }] }), /recorded_terms_changed/)
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90200)
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM paper_corporate_sessions_v1 WHERE session_date='2026-09-11'").get()!.n, 0)
})

test('corporate opening basis preserves pre-action holdings and is not replaced on retry', async t => {
  const f = fixture()
  t.after(() => f.sql.close())
  const opening = f.sql.prepare('SELECT * FROM paper_positions WHERE account_id=2').get()
  await f.process()
  const events = () => f.sql.prepare("SELECT * FROM paper_execution_events WHERE account_id=2 AND event_type='corporate_opening_basis' ORDER BY id").all()
  assert.equal(events().length, 1)
  const event: any = events()[0]
  const basis = JSON.parse(event.detail_json)
  assert.equal(basis.session_date, '2026-09-07')
  assert.equal(basis.account_id, 2)
  assert.equal(basis.source_checksum, f.source().source_checksum)
  assert.deepEqual(basis.positions, [{ ...opening }])
  assert.equal(basis.positions[0].avg_cost, 100)
  assert.notEqual(f.sql.prepare('SELECT avg_cost FROM paper_positions WHERE account_id=2').get()!.avg_cost, 100)
  // Simulates a later position change; the original pre-trade evidence is fixed.
  f.sql.exec('UPDATE paper_positions SET shares=250 WHERE account_id=2')
  await f.process()
  assert.deepEqual(events(), [event])
  assert.equal((await readCorporateOpeningBasis(f.db, 2, '2026-09-07'))!.positions[0].shares, 100)
  assert.equal(await readCorporateOpeningBasis(f.db, 1, '2026-09-07'), null)
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM paper_execution_events WHERE account_id=1 AND event_type='corporate_opening_basis'").get()!.n, 0)
})

test('corporate opening basis exists even on a no-action day and distinguishes an empty account', async t => {
  const f = fixture()
  t.after(() => f.sql.close())
  const first = { ...f.source(), actions: [] }
  await f.process(first)
  const read = (day: string) => JSON.parse(String(f.sql.prepare("SELECT detail_json FROM paper_execution_events WHERE account_id=2 AND trade_date=? AND event_type='corporate_opening_basis'").get(day)?.detail_json))
  assert.equal(read('2026-09-07').positions[0].shares, 100)
  f.sql.exec('DELETE FROM paper_positions WHERE account_id=2')
  await f.process({ ...f.source('2026-09-08'), actions: [] })
  assert.deepEqual(read('2026-09-08').positions, [])
  assert.equal(read('2026-09-07').positions[0].shares, 100)
})

for (const fault of ['payload', 'marker', 'timestamp', 'duplicate']) {
  test(`corporate opening basis rejects ${fault} corruption rather than using current holdings`, async t => {
    const f = fixture()
    t.after(() => f.sql.close())
    await f.process()
    if (fault === 'payload') f.sql.exec("UPDATE paper_execution_events SET detail_json='{}' WHERE event_type='corporate_opening_basis'")
    if (fault === 'marker') f.sql.exec("UPDATE paper_corporate_sessions_v1 SET source_checksum='wrong'")
    if (fault === 'timestamp') f.sql.exec("UPDATE paper_execution_events SET created_at='2026-09-07T02:00:00.000Z' WHERE event_type='corporate_opening_basis'")
    if (fault === 'duplicate') f.sql.exec(`INSERT INTO paper_execution_events(account_id,trade_date,event_type,status,reason,detail_json,source,created_at)
      SELECT account_id,trade_date,event_type,status,reason,detail_json,source,created_at FROM paper_execution_events WHERE event_type='corporate_opening_basis'`)
    await assert.rejects(readCorporateOpeningBasis(f.db, 2, '2026-09-07'), /paper_corporate_opening_basis_/)
  })
}

test('corporate opening basis and cash/position mutations roll back together', async t => {
  const f = fixture()
  t.after(() => f.sql.close())
  f.sql.exec("CREATE TRIGGER fail_opening BEFORE INSERT ON paper_execution_events WHEN NEW.event_type='corporate_opening_basis' BEGIN SELECT RAISE(ABORT,'fixture_opening_failure'); END")
  await assert.rejects(f.process(), /fixture_opening_failure/)
  assert.equal(await readCorporateOpeningBasis(f.db, 2, '2026-09-07'), null)
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM paper_corporate_sessions_v1').get()!.n, 0)
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM paper_corporate_entitlements_v1').get()!.n, 0)
  assert.equal(f.sql.prepare('SELECT avg_cost FROM paper_positions WHERE account_id=2').get()!.avg_cost, 100)
  f.sql.exec('DROP TRIGGER fail_opening')
  await f.process()
  assert.equal((await readCorporateOpeningBasis(f.db, 2, '2026-09-07'))!.positions[0].shares, 100)
})

test('corporate opening basis concurrent first executions cannot leave a second basis or double rights', async t => {
  const f = fixture()
  t.after(() => f.sql.close())
  const attempts = await Promise.allSettled([f.process(), f.process()])
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1)
  assert.equal(attempts.filter(a => a.status === 'rejected').length, 1)
  await f.process()
  assert.equal((await readCorporateOpeningBasis(f.db, 2, '2026-09-07'))!.positions[0].shares, 100)
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM paper_corporate_entitlements_v1').get()!.n, 2)
})

test('corporate opening basis cannot be consumed before its recorded time', async t => {
  const f = fixture()
  t.after(() => f.sql.close())
  await f.process()
  await assert.rejects(readCorporateOpeningBasis(f.db, 2, '2026-09-07', Date.parse('2026-09-06T23:59:59Z')), /not_observable/)
  assert.equal((await readCorporateOpeningBasis(f.db, 2, '2026-09-07', Date.parse('2026-09-07T00:00:00Z')))!.positions[0].shares, 100)
})

test('corporate opening basis records the completed ownership read, not the request start time', async t => {
  const f = fixture(query => {
    if (query.includes('FROM paper_positions') && query.includes('shares>0')) advancePaperExecutionClock(Date.parse('2026-09-07T00:00:15Z'))
  })
  t.after(() => f.sql.close())
  await f.process()
  const basis = await readCorporateOpeningBasis(f.db, 2, '2026-09-07')
  assert.equal(basis!.observed_at, '2026-09-07T00:00:15.000Z')
})

for (const phase of ['ownership_read', 'before_batch']) {
  test(`corporate opening basis cannot backdate a ${phase} that crosses market open`, async t => {
    const advance = () => advancePaperExecutionClock(Date.parse('2026-09-07T01:00:00Z'))
    const f = fixture(query => {
      if (phase === 'ownership_read' && query.includes('FROM paper_positions') && query.includes('shares>0')) advance()
    }, query => {
      if (phase === 'before_batch' && query.startsWith('INSERT INTO paper_corporate_sessions_v1')) advance()
    })
    t.after(() => f.sql.close())
    await assert.rejects(f.process(), /paper_corporate_exdate_opening_state_required/)
    assert.equal(await readCorporateOpeningBasis(f.db, 2, '2026-09-07'), null)
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM paper_corporate_sessions_v1').get()!.n, 0)
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM paper_corporate_entitlements_v1').get()!.n, 0)
    assert.equal(f.sql.prepare('SELECT avg_cost FROM paper_positions WHERE account_id=2').get()!.avg_cost, 100)
  })
}

test('corporate opening basis missing from a legacy completed session is not backfilled from current holdings', async t => {
  const f = fixture()
  t.after(() => f.sql.close())
  f.sql.prepare('INSERT INTO paper_corporate_sessions_v1(account_id,session_date,source_checksum,processed_at) VALUES(?,?,?,?)')
    .run(2, '2026-09-07', f.source().source_checksum, '2026-09-07T00:00:00.000Z')
  f.sql.exec('UPDATE paper_positions SET shares=400 WHERE account_id=2')
  await f.process()
  assert.equal(await readCorporateOpeningBasis(f.db, 2, '2026-09-07'), null)
  assert.equal(f.sql.prepare('SELECT shares FROM paper_positions WHERE account_id=2').get()!.shares, 400)
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM paper_execution_events').get()!.n, 0)
})

test('corporate opening basis does not reduce the existing 100-operation economic batch capacity', async t => {
  const f = fixture()
  t.after(() => f.sql.close())
  const source = f.source()
  source.covered_symbols = Array.from({ length: 33 }, (_, i) => String(1000 + i))
  f.sql.exec('DELETE FROM paper_positions WHERE account_id=2')
  for (const symbol of source.covered_symbols) f.sql.prepare('INSERT INTO paper_positions(account_id,symbol,shares,avg_cost) VALUES(?,?,?,?)').run(2, symbol, 100, 100)
  source.actions = source.covered_symbols.flatMap(symbol => f.source().actions.map(a => ({ ...a, symbol, action_id: a.action_id + '-' + symbol })))
  // 33 x (position update + cash entitlement + stock entitlement) + marker = 100.
  await f.process(source, new Map(source.covered_symbols.map(s => [s, 100])))
  assert.equal((await readCorporateOpeningBasis(f.db, 2, '2026-09-07'))!.positions.length, 33)
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM paper_corporate_entitlements_v1').get()!.n, 66)
})

for (const fault of ['foreign_account', 'after_open', 'duplicate_symbol']) {
  test(`corporate opening basis validates ${fault} even with a matching payload hash`, async t => {
    const f = fixture()
    t.after(() => f.sql.close())
    await f.process()
    const event: any = f.sql.prepare("SELECT detail_json FROM paper_execution_events WHERE event_type='corporate_opening_basis'").get()
    const basis = JSON.parse(event.detail_json)
    if (fault === 'foreign_account') basis.positions[0].account_id = 1
    if (fault === 'after_open') basis.observed_at = '2026-09-07T01:00:00.000Z'
    if (fault === 'duplicate_symbol') basis.positions.push({ ...basis.positions[0] })
    const raw = JSON.stringify(basis)
    f.sql.prepare("UPDATE paper_execution_events SET detail_json=?,reason=? WHERE event_type='corporate_opening_basis'")
      .run(raw, createHash('sha256').update(raw).digest('hex'))
    await assert.rejects(readCorporateOpeningBasis(f.db, 2, '2026-09-07'), /paper_corporate_opening_/)
  })
}

test('subscription ledger keeps rights after parent sale, never subscribes, and expires only after holder deadline', async () => {
  const f = fixture(), s = f.source()
  s.actions = [{ action_id: 'subscription', symbol: '2330', kind: 'subscription', ex_date: '2026-09-07',
    payable_date: null, cash_per_share: 0, stock_per_share: 0,
    rights: { ratio: .06075416207, issued_ratio: 20000000 / 246896665, subscription_price: 83,
      policy: 'do_not_subscribe', payment_start: '2026-09-07', payment_deadline: '2026-09-09',
      expiry_policy: 'unexercised_original_holder_rights_expire', fractional_policy: 'retain_no_automatic_pooling',
      fair_value_per_right: null, valuation_status: 'unobservable', promotion_eligible: false,
      evidence_checksums: ['b'.repeat(64)] } }]
  await f.process(s)
  await f.process(s)
  const position: any = f.sql.prepare('SELECT * FROM paper_positions WHERE account_id=2').get()
  assert.equal(position.shares, 100)
  assert.equal(position.avg_cost, 100)
  assert(position.initial_stop < 95 && position.initial_stop > 90)
  f.sql.exec('DELETE FROM paper_positions WHERE account_id=2') // synthetic parent sale
  for (const day of ['2026-09-08', '2026-09-09', '2026-09-10']) {
    await f.process({ ...s, session_date: day, observed_at: day + 'T00:00:00Z' })
    const pending = await outstandingCorporateEntitlements(f.db, 2)
    if (day <= '2026-09-09') {
      assert.equal(pending.length, 1)
      assert.equal(JSON.parse(pending[0].rights_json!).quantity, 6.075416207)
      assert.throws(() => corporateReceivableValue(pending, new Map([['2330', 100]])), /unobservable/)
      const bounds = corporateReceivableBounds(pending, new Map([['2330', 100]]))
      assert.equal(bounds.lower, 0)
      assert.equal(bounds.upper, 607.5416207)
      assert.equal(bounds.complete, false)
      assert.deepEqual(bounds.unpricedRights, ['subscription'])
      assert.throws(() => corporateReceivableBounds(pending, new Map()), /underlying_mark_missing/)
    } else assert.equal(pending.length, 0)
    assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90000)
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM paper_positions WHERE account_id=2').get()!.n, 0)
  }
  const archived: any = f.sql.prepare("SELECT * FROM paper_corporate_entitlements_v1 WHERE action_id='subscription'").get()
  assert.equal(archived.settled, 1)
  assert.equal(JSON.parse(archived.rights_json).payment_deadline, '2026-09-09')
  f.sql.close()
})

test('exact share conversion adjusts quantity, cost and stops without spending a future capital refund', async () => {
  const f = fixture()
  const source = f.source()
  source.actions = [
    { action_id: 'exchange', symbol: '2330', kind: 'exchange', ex_date: '2026-09-07',
      payable_date: '2026-09-07', stock_per_share: .75, cash_per_share: 0, capital_return_per_share: 2.5 },
    { action_id: 'capital-refund', symbol: '2330', kind: 'cash', ex_date: '2026-09-07',
      payable_date: '2026-09-10', stock_per_share: 0, cash_per_share: 2.5 },
  ]
  await f.process(source)
  await f.process(source)
  const pos: any = f.sql.prepare('SELECT * FROM paper_positions WHERE account_id=2').get()
  assert.equal(pos.shares, 75)
  assert.equal(pos.avg_cost, 130)
  assert.equal(pos.entry_price, 130)
  assert.equal(pos.initial_stop, 123.5)
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90000)
  const rights = await outstandingCorporateEntitlements(f.db, 2)
  assert.equal(rights.length, 1)
  assert.equal(rights[0].cash_due, 250)
  assert.equal(90000 + pos.shares * 130 + corporateReceivableValue(rights, new Map()), 100000)
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=1').get()!.cash, 777)
  f.sql.close()
})

test('split preserves NAV; fractional conversion or missing refund leg cannot partially mutate holdings', async () => {
  for (const ratio of [22, .33333333]) {
    const f = fixture()
    const source = f.source()
    source.actions = [{ action_id: 'exchange', symbol: '2330', kind: 'exchange', ex_date: '2026-09-07',
      payable_date: '2026-09-07', stock_per_share: ratio, cash_per_share: 0 }]
    if (ratio === 22) {
      await f.process(source)
      const pos: any = f.sql.prepare('SELECT * FROM paper_positions WHERE account_id=2').get()
      assert.equal(pos.shares, 2200)
      assert.ok(Math.abs(pos.avg_cost * pos.shares - 10000) < 1e-8)
    } else {
      await assert.rejects(f.process(source), /exchange_fractional_terms_required/)
      assert.equal(f.sql.prepare('SELECT shares FROM paper_positions WHERE account_id=2').get()!.shares, 100)
      assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM paper_corporate_sessions_v1').get()!.n, 0)
    }
    f.sql.close()
  }
})

test('fractional exchange cash is only the announced remainder and remains receivable until its own payment', async () => {
  const f = fixture()
  f.sql.exec('UPDATE paper_positions SET shares=101 WHERE account_id=2')
  const source = f.source()
  source.actions = [
    { action_id: 'exchange', symbol: '2330', kind: 'exchange', ex_date: '2026-09-07',
      payable_date: '2026-09-07', stock_per_share: .75, cash_per_share: 0 },
    { action_id: 'fraction', symbol: '2330', kind: 'cash', ex_date: '2026-09-07', payable_date: '2026-09-10',
      stock_per_share: 0, cash_per_share: 81.3, cash_quantity_basis: 'exchange_fraction', share_conversion_ratio: .75,
      related_exchange_action_id: 'exchange', cash_rounding: 'floor_twd' },
  ]
  await f.process(source)
  assert.equal(f.sql.prepare('SELECT shares FROM paper_positions WHERE account_id=2').get()!.shares, 75)
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90000)
  assert.equal((await outstandingCorporateEntitlements(f.db, 2))[0].cash_due, 60)
  const pay = { ...source, session_date: '2026-09-10', observed_at: '2026-09-10T00:00:00Z' }
  await f.process(pay)
  await f.process(pay)
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90060)
  assert.equal((await outstandingCorporateEntitlements(f.db, 2)).length, 0)
  f.sql.close()
})

test('issuer precision requires exact delivered-quantity agreement, never a floating tolerance', async () => {
  for (const official of [.72964415, .74]) {
    const f = fixture()
    const source = f.source()
    source.actions = [{ action_id: 'exchange', symbol: '2330', kind: 'exchange', ex_date: '2026-09-07',
      payable_date: '2026-09-07', stock_per_share: .7296441479, official_share_ratio: official,
      cash_per_share: 0, fractional_treatment: 'book_entry_fee' }]
    if (official === .72964415) {
      await f.process(source)
      assert.equal(f.sql.prepare('SELECT shares FROM paper_positions WHERE account_id=2').get()!.shares, 72)
      assert.equal((await outstandingCorporateEntitlements(f.db, 2)).length, 0)
      assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90000)
    } else {
      await assert.rejects(f.process(source), /disclosed_quantity_conflict/)
      assert.equal(f.sql.prepare('SELECT shares FROM paper_positions WHERE account_id=2').get()!.shares, 100)
    }
    f.sql.close()
  }
})

test('native ledger accrues ex-date rights without early cash/stock and adjusts stop references', async () => {
  const f = fixture()
  await f.process()
  await f.process()
  const cash = f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash
  const pos: any = f.sql.prepare('SELECT * FROM paper_positions WHERE account_id=2').get()
  assert.equal(cash, 90000)
  assert.equal(pos.shares, 100)
  assert.ok(Math.abs(pos.trailing_stop - 97 * .98 / 1.1) < 1e-8)
  const rows = await outstandingCorporateEntitlements(f.db, 2)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].cash_due, 200)
  assert.equal(rows[1].shares_due, 10)
  const mark = 98 / 1.1
  assert.ok(Math.abs(Number(cash) + pos.shares * mark + corporateReceivableValue(rows, new Map([['2330', mark]])) - 100000) < 1e-8)
  assert.throws(() => corporateReceivableValue(rows, new Map()), /mark_missing/)
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=1').get()!.cash, 777)
  f.sql.close()
})

test('sale on ex-date retains entitlement; stock then cash delivery are each atomic and idempotent', async () => {
  const f = fixture()
  await f.process()
  // This unit test removes the old holding, not the accrued-rights owner.
  // Original fill/matcher integration is covered by the cross-runtime session tests.
  f.sql.exec('DELETE FROM paper_positions WHERE account_id=2')
  await f.process(f.source('2026-09-08'))
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM paper_positions WHERE account_id=2').get()!.n, 0)
  await f.process(f.source('2026-09-09'))
  await f.process(f.source('2026-09-09'))
  assert.equal(f.sql.prepare('SELECT shares FROM paper_positions WHERE account_id=2').get()!.shares, 10)
  const delivered: any = f.sql.prepare('SELECT * FROM paper_positions WHERE account_id=2').get()
  assert.equal(delivered.entry_date, '2026-09-01')
  assert.ok(Math.abs(delivered.trailing_stop - 97 * .98 / 1.1) < 1e-8)
  assert.equal(delivered.original_shares, 10)
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90000)
  await f.process(f.source('2026-09-10'))
  await f.process(f.source('2026-09-10'))
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90200)
  assert.deepEqual(await outstandingCorporateEntitlements(f.db, 2), [])
  f.sql.close()
})

test('missing coverage and changed source cannot become successful zero-action days', async () => {
  const f = fixture()
  await assert.rejects(f.process({ ...f.source(), covered_symbols: [], actions: [] }), /coverage_missing/)
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM paper_corporate_sessions_v1').get()!.n, 0)
  await f.process()
  await assert.rejects(f.process({ ...f.source(), source_checksum: 'b'.repeat(64) }), /source_changed/)
  f.sql.close()
})

test('transaction failure leaves neither partial accrual nor adjusted position', async () => {
  const f = fixture()
  f.sql.exec(`CREATE TRIGGER fail_corporate_marker BEFORE INSERT ON paper_corporate_sessions_v1 BEGIN SELECT RAISE(ABORT,'fixture_lost_write'); END;`)
  await assert.rejects(f.process(), /fixture_lost_write/)
  assert.equal(await readCorporateOpeningBasis(f.db, 2, '2026-09-07'), null)
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM paper_corporate_entitlements_v1').get()!.n, 0)
  assert.equal(f.sql.prepare('SELECT avg_cost FROM paper_positions WHERE account_id=2').get()!.avg_cost, 100)
  f.sql.close()
})

for (const failurePoint of ['cash', 'completion-marker']) {
  test(`late announced delivery rolls back ${failurePoint} failure and retries exactly once`, async t => {
    const f = fixture()
    t.after(() => f.sql.close())
    const opening = f.source()
    opening.actions.forEach(a => { a.payable_date = null })
    await f.process(opening)
    // Component-level sale boundary; the cross-runtime late-entitlement test
    // separately uses actual native fills instead of this state removal.
    f.sql.exec('DELETE FROM paper_positions WHERE account_id=2')
    const announced = f.source('2026-09-09')
    announced.actions.forEach(a => { a.payable_date = '2026-09-09' })
    const state = () => Object.fromEntries(['paper_accounts', 'paper_positions',
      'paper_corporate_entitlements_v1', 'paper_corporate_sessions_v1', 'paper_execution_events'].map(table =>
      [table, f.sql.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]))
    const before = state()
    const target = failurePoint === 'cash' ? 'BEFORE UPDATE ON paper_accounts'
      : 'BEFORE INSERT ON paper_corporate_sessions_v1'
    f.sql.exec(`CREATE TRIGGER fail_delivery ${target} BEGIN SELECT RAISE(ABORT,'fixture_delivery_failure'); END`)
    await assert.rejects(f.process(announced), /fixture_delivery_failure/)
    assert.deepEqual(state(), before, 'failed delivery must retain the complete pre-delivery state')
    f.sql.exec('DROP TRIGGER fail_delivery')
    await f.process(announced)
    const committed = state()
    await f.process(announced)
    assert.deepEqual(state(), committed)
    assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90200)
    assert.equal(f.sql.prepare('SELECT shares FROM paper_positions WHERE account_id=2').get()!.shares, 10)
    assert.deepEqual(await outstandingCorporateEntitlements(f.db, 2), [])
    assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=1').get()!.cash, 777)
  })
}

test('decimal stock ratio does not turn exactly 29 shares into a fractional entitlement', () => {
  assert.deepEqual(corporateStockQuantity(100, .29), { total: 29, whole: 29 })
  assert.deepEqual(corporateStockQuantity(100, .105), { total: 10.5, whole: 10 })
  assert.deepEqual(corporateStockQuantity(100, 1e-7), { total: .00001, whole: 0 })
})

test('cash dividend uses issuer rounding, never binary product or guessed fraction payout', async () => {
  const f = fixture()
  const source = (day: string, rounding: boolean) => {
    const s = f.source(day)
    s.actions = [{ ...s.actions[0], cash_per_share: .7207,
      ...(rounding ? { cash_rounding: 'floor_twd' as const } : {}) }]
    return s
  }
  await f.process(source('2026-09-07', false))
  assert.equal((await outstandingCorporateEntitlements(f.db, 2))[0].cash_due, 72.07)
  await assert.rejects(f.process(source('2026-09-10', false)), /cash_rounding_terms_missing/)
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90000)
  await f.process(source('2026-09-10', true))
  await f.process(source('2026-09-10', true))
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90072)
  f.sql.close()
})

test('announced book-entry fractional fee is not imaginary stock or cash', async () => {
  const f = fixture()
  const source = (day: string) => {
    const snapshot = f.source(day)
    snapshot.actions[1].stock_per_share = .105
    snapshot.actions[1].fractional_treatment = 'book_entry_fee'
    return snapshot
  }
  await f.process(source('2026-09-07'))
  const rights = await outstandingCorporateEntitlements(f.db, 2)
  assert.equal(rights[1].shares_due, 10.5)
  assert.equal(rights[1].whole_shares_due, 10)
  assert.equal(corporateReceivableValue(rights, new Map([['2330', 90]])), 1100)
  await f.process(source('2026-09-09'))
  await f.process(source('2026-09-09'))
  assert.equal(f.sql.prepare('SELECT shares FROM paper_positions WHERE account_id=2').get()!.shares, 110)
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()!.cash, 90000)
  f.sql.close()
})
