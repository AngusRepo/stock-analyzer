import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUDIT_JSON_ARCHIVE_TARGET_IDS, AUDIT_JSON_DEFAULT_TARGET_IDS } from './auditJsonArchive'

// 2026-11-13: the scheduled run replaced two corporate_opening_basis ledger rows
// with R2 pointers; premarket setup verifies sha256(detail_json) over the whole
// history and failed. Paper ledgers stay out of the unnamed (scheduled) run.
test('scheduled audit-json retention never implies paper_execution_events', () => {
  assert.ok(!AUDIT_JSON_DEFAULT_TARGET_IDS.includes('paper_execution_events'))
  assert.ok(AUDIT_JSON_DEFAULT_TARGET_IDS.includes('strategy_decision_log'))
  assert.ok(AUDIT_JSON_ARCHIVE_TARGET_IDS.includes('paper_execution_events'))
})
