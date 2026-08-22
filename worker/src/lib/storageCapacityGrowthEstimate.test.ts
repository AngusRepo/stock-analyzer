import assert from 'node:assert/strict'
import { buildStorageCapacityGrowthEstimate } from './storageCapacityTelemetry'

const migrationWindow = buildStorageCapacityGrowthEstimate({
  currentUsedBytes: 4_092_506_112,
  baselineAfter: '2026-08-19',
  history: [
    { observed_date: '2026-08-17', used_bytes: 436_871_168 },
    { observed_date: '2026-08-19', used_bytes: 3_863_678_976 },
    { observed_date: '2026-08-20', used_bytes: 3_964_948_480 },
    { observed_date: '2026-08-21', used_bytes: 4_092_506_112 },
    { observed_date: '2026-08-22', used_bytes: 4_092_506_112 },
  ],
})
assert.equal(migrationWindow.status, 'awaiting_post_cutover_observations')
assert.equal(migrationWindow.observation_count, 3)
assert.equal(migrationWindow.daily_growth_bytes, null)
assert.equal(migrationWindow.projected_days_to_warning_65pct, null)

const stableWindow = buildStorageCapacityGrowthEstimate({
  currentUsedBytes: 1_060_000_000,
  baselineAfter: '2026-08-01',
  history: [
    { observed_date: '2026-08-02', used_bytes: 1_000_000_000 },
    { observed_date: '2026-08-03', used_bytes: 1_010_000_000 },
    { observed_date: '2026-08-04', used_bytes: 1_020_000_000 },
    { observed_date: '2026-08-05', used_bytes: 1_030_000_000 },
    { observed_date: '2026-08-06', used_bytes: 1_040_000_000 },
    { observed_date: '2026-08-07', used_bytes: 1_050_000_000 },
    { observed_date: '2026-08-08', used_bytes: 1_060_000_000 },
  ],
})
assert.equal(stableWindow.status, 'ready')
assert.equal(stableWindow.daily_growth_bytes, 10_000_000)
assert.equal(stableWindow.projected_days_to_warning_65pct, 544)
assert.equal(stableWindow.projected_days_to_max, 894)

const robustMedian = buildStorageCapacityGrowthEstimate({
  currentUsedBytes: 1_100_000_000,
  history: [
    { observed_date: '2026-08-01', used_bytes: 1_000_000_000 },
    { observed_date: '2026-08-02', used_bytes: 1_010_000_000 },
    { observed_date: '2026-08-03', used_bytes: 1_020_000_000 },
    { observed_date: '2026-08-04', used_bytes: 3_000_000_000 },
    { observed_date: '2026-08-05', used_bytes: 1_040_000_000 },
    { observed_date: '2026-08-06', used_bytes: 1_050_000_000 },
    { observed_date: '2026-08-07', used_bytes: 1_060_000_000 },
  ],
})
assert.equal(robustMedian.status, 'ready')
assert.equal(robustMedian.daily_growth_bytes, 10_000_000)

console.log('storage capacity growth estimate tests passed')
