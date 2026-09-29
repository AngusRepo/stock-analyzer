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
assert.equal(migrationWindow.median_daily_growth_bytes, null)
assert.equal(migrationWindow.net_daily_growth_bytes, null)
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
assert.equal(stableWindow.median_daily_growth_bytes, 10_000_000)
assert.equal(stableWindow.net_daily_growth_bytes, 10_000_000)
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
assert.equal(robustMedian.median_daily_growth_bytes, 10_000_000)
assert.equal(robustMedian.net_daily_growth_bytes, 10_000_000)

// Six quiet intervals must not hide a once-weekly 70 MB batch.
const weeklyBatch = buildStorageCapacityGrowthEstimate({
  currentUsedBytes: 1_070_000_000,
  history: Array.from({ length: 8 }, (_, index) => ({
    observed_date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    used_bytes: index === 7 ? 1_070_000_000 : 1_000_000_000,
  })),
})
assert.equal(weeklyBatch.status, 'ready')
assert.equal(weeklyBatch.median_daily_growth_bytes, 0)
assert.equal(weeklyBatch.net_daily_growth_bytes, 10_000_000)
assert.equal(weeklyBatch.daily_growth_bytes, 10_000_000)
assert.equal(weeklyBatch.projected_days_to_max, 893)

// Use elapsed calendar days, not sample count, when observations have gaps.
const missingDays = buildStorageCapacityGrowthEstimate({
  currentUsedBytes: 1_140_000_000,
  history: [1, 2, 3, 4, 5, 6, 15].map((day) => ({
    observed_date: `2026-09-${String(day).padStart(2, '0')}`,
    used_bytes: day === 15 ? 1_140_000_000 : 1_000_000_000,
  })),
})
assert.equal(missingDays.observation_count, 7)
assert.equal(missingDays.median_daily_growth_bytes, 0)
assert.equal(missingDays.net_daily_growth_bytes, 10_000_000)
assert.equal(missingDays.daily_growth_bytes, 10_000_000)

const shrinking = buildStorageCapacityGrowthEstimate({
  currentUsedBytes: 940_000_000,
  history: Array.from({ length: 7 }, (_, index) => ({
    observed_date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    used_bytes: 1_000_000_000 - index * 10_000_000,
  })),
})
assert.equal(shrinking.daily_growth_bytes, -10_000_000)
assert.equal(shrinking.net_daily_growth_bytes, -10_000_000)
assert.equal(shrinking.projected_days_to_max, null)
assert.equal(shrinking.projected_days_to_warning_65pct, null)

// Migration exclusion and same-date replacement still apply before both rates.
const postCutover = buildStorageCapacityGrowthEstimate({
  currentUsedBytes: 1_060_000_000,
  baselineAfter: '2026-08-31',
  history: [
    { observed_date: '2026-08-31', used_bytes: 100 },
    { observed_date: '2026-09-01', used_bytes: 5_000_000_000 },
    ...Array.from({ length: 7 }, (_, index) => ({
      observed_date: `2026-09-${String(index + 1).padStart(2, '0')}`,
      used_bytes: 1_000_000_000 + index * 10_000_000,
    })),
  ],
})
assert.equal(postCutover.observation_count, 7)
assert.equal(postCutover.daily_growth_bytes, 10_000_000)
assert.equal(postCutover.net_daily_growth_bytes, 10_000_000)

// A threshold already reached has no runway, including during flat/shrinking periods.
for (const changePerDay of [0, -10_000_000]) {
  const warning = buildStorageCapacityGrowthEstimate({
    currentUsedBytes: 7_000_000_000,
    history: Array.from({ length: 7 }, (_, index) => ({
      observed_date: `2026-09-${String(index + 1).padStart(2, '0')}`,
      used_bytes: 7_000_000_000 + (index - 6) * changePerDay,
    })),
  })
  assert.equal(warning.projected_days_to_warning_65pct, 0)
  assert.equal(warning.projected_days_to_max, null)
}

const full = buildStorageCapacityGrowthEstimate({
  currentUsedBytes: 10_000_000_000,
  history: Array.from({ length: 7 }, (_, index) => ({
    observed_date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    used_bytes: 10_000_000_000,
  })),
})
assert.equal(full.projected_days_to_warning_65pct, 0)
assert.equal(full.projected_days_to_max, 0)

console.log('storage capacity growth estimate tests passed')
