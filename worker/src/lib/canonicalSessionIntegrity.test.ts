import assert from 'node:assert/strict'
import { assertCanonicalSessionCoverage } from './canonicalSessionIntegrity'

const rows = ['2026-08-19', '2026-08-20', '2026-08-21'].map(session_date => ({
  session_date, source_count: 2323, price_count: 2323, canonical_count: 2323,
}))
assert.doesNotThrow(() => assertCanonicalSessionCoverage(rows, '2026-08-19', '2026-08-21'))
assert.throws(() => assertCanonicalSessionCoverage([], '2026-08-19', '2026-08-21'), /calendar_missing/)
assert.throws(() => assertCanonicalSessionCoverage(rows.map(r => r.session_date === '2026-08-20'
  ? { ...r, price_count: 0, canonical_count: 0 } : r), '2026-08-19', '2026-08-21'), /canonical_session_gap:2026-08-20/)
assert.throws(() => assertCanonicalSessionCoverage([{ ...rows[0], price_count: NaN }], '2026-08-19', '2026-08-21'), /canonical_session_gap/)
console.log('canonical session integrity tests passed')
