import assert from 'node:assert/strict'
import { test } from 'node:test'
import { retentionReplayClockMetadata } from './retentionReplayClocks'

test('signal, trade and outcome clocks are separate and bounds cover every known date', () => {
  const rows = [
    {trade_date:'2026-05-20',signal_date:'2026-04-30',detail_json:JSON.stringify({replay_diagnostics:{outcome_known_date:'2026-06-02'}})},
    {trade_date:'2026-05-21',signal_date:'2026-05-01',detail_json:JSON.stringify({replay_diagnostics:{outcome_known_date:'2026-06-01'}})},
  ]
  assert.deepEqual(retentionReplayClockMetadata(rows),{signal_coverage_start:'2026-04-30',signal_coverage_end:'2026-05-01',known_coverage_start:'2026-06-01',known_coverage_end:'2026-06-02'})
})
test('missing, malformed or timezone-bearing clocks must not create a false prune bound', () => {
  for(const bad of ['2026-02-30','2026-05-01T23:00:00-08:00','unknown']) {
    const result=retentionReplayClockMetadata([{signal_date:bad,detail_json:JSON.stringify({replay_diagnostics:{outcome_known_date:bad}})}])
    assert.deepEqual(result,{})
  }
  assert.deepEqual(retentionReplayClockMetadata([{detail_json:'broken'}]),{})
  assert.deepEqual(retentionReplayClockMetadata([{detail_json:'null'}]),{})
})
