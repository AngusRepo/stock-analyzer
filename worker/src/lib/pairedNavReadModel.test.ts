import assert from 'node:assert/strict'
import { readPairedNav } from './pairedNavReadModel'

function database(contexts: any, pairs: any[], error?: string): D1Database {
  return { prepare: (sql: string) => ({ bind: () => ({
    first: async () => { if (error) throw new Error(error); return contexts },
    all: async () => { if (error) throw new Error(error); return { results: sql.includes('paired_nav_lifecycle_closures_v1') ? [] : pairs } },
  }) }) } as unknown as D1Database
}

async function main() {
  const empty = await readPairedNav(database({ dates: 0, latest: null }, []), '2026-09-07')
  assert.equal(empty.status, 'awaiting_allocation_context')
  const contextOnly = await readPairedNav(database({ dates: 4, latest: '2026-09-07' }, []), '2026-09-07')
  assert.equal(contextOnly.status, 'awaiting_execution_pairs')
  assert.equal(contextOnly.allocation_context_dates, 4)
  assert.deepEqual(contextOnly.pairs, [])
  assert.equal(contextOnly.ev_prediction_dates_added, 0)
  assert.equal(contextOnly.promotion_allowed, false)
  const pair = { pair_id: 'one', sessions: 3, latest_session: '2026-09-07', candidate_checksum: 'c',
    accounted_sessions: 3, unverified_sessions: 0, latest_accounting_session: '2026-09-07',
    undefined_return_sessions: 0, zero_nav_sessions: 0,
    comparison_sessions: 0, comparison_versions: 0, invalid_comparisons: 0,
    baseline_checksum: 'b', candidate_versions: 1, baseline_versions: 1,
    configuration_versions: 1, execution_versions: 1, invalid_rows: 0 }
  const observed = await readPairedNav(database({ dates: 4, latest: '2026-09-07' }, [pair]), '2026-09-07')
  assert.equal(observed.status, 'observing')
  assert.equal(observed.pairs[0].sessions, 3)
  assert.equal(observed.promotion_allowed, false)
  assert.deepEqual(observed.blockers, [])
  const provisional = await readPairedNav(database({ dates: 4, latest: '2026-09-07' },
    [{ ...pair, sessions: 0, latest_session: null, unverified_sessions: 3 }]), '2026-09-07')
  assert.equal(provisional.status, 'valuation_incomplete')
  assert.equal(provisional.pairs[0].sessions, 0)
  assert.equal(provisional.pairs[0].accounted_sessions, 3)
  assert.ok(provisional.blockers.includes('paired_nav_valuation_interval_unverified'))
  const zeroCapital = await readPairedNav(database({ dates: 4, latest: '2026-09-07' },
    [{ ...pair, sessions: 1, unverified_sessions: 2, undefined_return_sessions: 2, zero_nav_sessions: 3 }]), '2026-09-07')
  assert.equal(zeroCapital.status, 'terminal_zero_nav')
  assert.deepEqual(zeroCapital.blockers, [])
  assert.equal(zeroCapital.pairs[0].undefined_return_sessions, 2)
  const mixed = await readPairedNav(database({ dates: 4, latest: '2026-09-07' }, [{ ...pair, candidate_versions: 2 }]), '2026-09-07')
  assert.equal(mixed.status, 'unavailable')
  assert.equal(mixed.allocation_context_dates, null)
  for (const mutation of [{ invalid_rows: 1 }, { configuration_versions: 2 }, { execution_versions: 2 }]) {
    const invalid = await readPairedNav(database({ dates: 4, latest: '2026-09-07' }, [{ ...pair, ...mutation }]), '2026-09-07')
    assert.equal(invalid.status, 'unavailable')
    assert.deepEqual(invalid.pairs, [])
  }
  const missing = await readPairedNav(database(null, [], 'no such table: paired_nav_daily_journal_v1'), '2026-09-07')
  assert.equal(missing.status, 'unavailable')
  assert.ok(missing.blockers.includes('paired_nav_migration_0040_missing'))
  assert.equal(missing.allocation_context_dates, null)
  console.log('pairedNavReadModel: 5 scenarios passed')
}
void main()
