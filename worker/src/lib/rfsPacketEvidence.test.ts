import assert from 'node:assert/strict'
import test from 'node:test'
import { rfsClock } from './shadowEvidenceClocks'
import type { Bindings } from '../types'

async function clock(packet: Record<string, unknown>) {
  const db = { prepare: () => ({ all: async () => ({ results: [
    { date: '2026-09-09', evidence: JSON.stringify(packet), market_segment: null },
    { date: '2026-09-09', evidence: JSON.stringify(packet), market_segment: null },
  ] }) }) }
  return rfsClock({ DB: db } as unknown as Bindings)
}
test('missing packet metadata is unknown, never a true zero', async () => {
  const result = await clock({ status: 'insufficient_evidence', packet_checksum: 'a' })
  assert.equal(result.sample_count, null)
  assert.equal(result.status, 'blocked_missing_packet_metadata')
  assert.ok(result.blockers.includes('rfs_packet_metadata_missing'))
  assert.equal(result.details.zero_candidate_run_materialized, false)
})
test('duplicate symbol projections count one packet, including unselected candidates', async () => {
  const result = await clock({ status: 'insufficient_evidence', packet_checksum: 'a',
    source_expected_return_candidate_count: 2, validation_blockers: ['history_missing'] })
  assert.equal(result.sample_count, 2)
  assert.deepEqual(result.blockers, ['history_missing'])
})
test('verified zero preserves the reason and empty-run meaning', async () => {
  const result = await clock({ status: 'insufficient_evidence', packet_checksum: 'a',
    source_expected_return_candidate_count: 0, validation_blockers: ['formal_expected_return_candidates_missing'] })
  assert.equal(result.sample_count, 0)
  assert.equal(result.details.zero_candidate_run_materialized, true)
  assert.equal(result.status, 'observed_zero_candidates')
})
