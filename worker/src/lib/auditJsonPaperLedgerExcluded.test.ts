import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  AUDIT_JSON_DEFAULT_TARGET_IDS,
  PAPER_EXECUTION_EVENT_ARCHIVE_TYPES,
  buildAuditJsonCandidateQuery,
} from './auditJsonArchive'

// 2026-11-13: the scheduled run replaced two corporate_opening_basis ledger rows
// with R2 pointers; premarket setup verifies sha256(detail_json) over the whole
// history and failed. Only same-day Paper events may be archived.
test('paper retention archives only allowlisted same-day event types', () => {
  assert.ok(AUDIT_JSON_DEFAULT_TARGET_IDS.includes('paper_execution_events'))
  for (const ledger of ['corporate_opening_basis', 'corporate_share_conversion', 'corporate_cash_correction', 'snapshot_audit', 'paper_order']) {
    assert.ok(!(PAPER_EXECUTION_EVENT_ARCHIVE_TYPES as readonly string[]).includes(ledger), ledger)
  }
  const db = new DatabaseSync(':memory:')
  const schema = readFileSync(new URL('../../domain-schemas/paper.sql', import.meta.url), 'utf8')
  db.exec(schema.match(/CREATE TABLE IF NOT EXISTS paper_execution_events \([\s\S]*?\n\);/)![0])
  const blob = JSON.stringify({ detail: 'x'.repeat(2048) })
  const insert = db.prepare(`INSERT INTO paper_execution_events(id, trade_date, event_type, status, detail_json) VALUES (?, '2026-10-06', ?, 'ok', ?)`)
  insert.run(1, 'corporate_opening_basis', blob)
  insert.run(2, 'pending_buy', blob)
  insert.run(3, 'some_new_ledger_event', blob)
  const q = buildAuditJsonCandidateQuery('paper_execution_events', '2026-11-01', 50, 1024, null)
  const ids = (db.prepare(q.sql).all(...(q.binds as never[])) as Array<Record<string, unknown>>).map((row) => Number(row.id))
  assert.deepEqual(ids, [2])
  db.close()
})

test('canonical screener retention keeps the pit flow-map stage verbatim', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('../../domain-schemas/ops.sql', import.meta.url), 'utf8'))
  db.prepare(`INSERT INTO screener_funnel_runs(run_id, date, status) VALUES ('run-1', '2026-10-06', 'success')`).run()
  const blob = JSON.stringify({ detail: 'x'.repeat(2048) })
  const insert = db.prepare(`INSERT INTO screener_funnel_items(id, run_id, date, stage, symbol, decision, reason_code, evidence) VALUES (?, 'run-1', '2026-10-06', ?, '2330', 'keep', 'r', ?)`)
  insert.run(1, 'pit_residual_momentum_shadow', blob)
  insert.run(2, 'scoring', blob)
  const q = buildAuditJsonCandidateQuery('canonical_screener_funnel_items', '2026-11-01', 50, 1024, null)
  const ids = (db.prepare(q.sql).all(...(q.binds as never[])) as Array<Record<string, unknown>>).map((row) => Number(row.id))
  assert.deepEqual(ids, [2])
  db.close()
})
