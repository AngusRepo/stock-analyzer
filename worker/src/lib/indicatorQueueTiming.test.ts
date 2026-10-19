import assert from 'node:assert/strict'
import { indicatorQueueDurationMs } from './indicatorQueueTiming'
const date = '2026-10-14', runId = 'indicator-run'
const meta = { trigger_time: date, run_id: runId, started_at: '2026-10-14T15:55:58Z' }
assert.equal(indicatorQueueDurationMs(meta, date, runId, Date.parse('2026-10-14T15:58:49Z')), 171000)
for (const value of [null, {}, {...meta, run_id: 'previous'}, {...meta, trigger_time: '2026-10-13'},
  {...meta, started_at: 'invalid'}, {...meta, started_at: '2026-10-14T16:00:00Z'}]) {
  assert.equal(indicatorQueueDurationMs(value, date, runId, Date.parse('2026-10-14T15:58:49Z')), null)
}
console.log('indicatorQueueTiming: passed')
