import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  buildPitFactorGroupSeries,
  buildPitFactorIndustryThemeSeries,
  selectPitFactorStockSymbols,
  type PitFactorFunnelPoint,
} from './pitFactorFlowMap'

function point(overrides: Partial<PitFactorFunnelPoint>): PitFactorFunnelPoint {
  return {
    date: '2026-08-28',
    symbol: 'A',
    name: 'A',
    industry: '電子',
    rankDelta: 0,
    candidateCount: 5,
    residualRank: 0.5,
    breadthRank: 0.6,
    flowRank: 0.8,
    confirmationRank: 0.7,
    ...overrides,
  }
}

const groups = buildPitFactorGroupSeries([
  point({ symbol: 'A', rankDelta: 2, residualRank: 0.1 }),
  point({ symbol: 'B', rankDelta: 0, residualRank: 0.9 }),
  point({ date: '2026-08-29', symbol: 'A', rankDelta: 1, residualRank: 0.2 }),
  point({ date: '2026-08-29', symbol: 'B', rankDelta: 1, residualRank: 0.8 }),
])
assert.equal(groups.length, 1)
assert.equal(groups[0].points.length, 2)
assert.equal(groups[0].points[0].x, 50)
assert.equal(groups[0].points[1].x, 50)
assert.equal(groups[0].points[0].y, 70)

const allIndustries = buildPitFactorGroupSeries(Array.from({ length: 13 }, (_value, index) => point({
  symbol: `S${index}`,
  industry: `產業${index}`,
  rankDelta: index - 6,
})))
assert.equal(allIndustries.length, 13, 'industry trajectories must not be truncated to 12')
const allIndustryXs = allIndustries.map((series) => Number(series.points[0].x)).sort((left, right) => left - right)
assert(allIndustryXs[0] < 5 && allIndustryXs.at(-1)! > 95, 'same-day group percentile must use the chart width instead of collapsing near x=50')
assert.equal(new Set(allIndustryXs).size, 13, 'distinct group tilts must remain distinguishable')

const themeSeries = buildPitFactorIndustryThemeSeries([
  point({ symbol: 'A', industry: '電子', rankDelta: 3 }),
  point({ symbol: 'B', industry: '電子', rankDelta: -2 }),
  point({ symbol: 'C', industry: '金融', rankDelta: 4 }),
], [
  { date: '2026-08-28', symbol: 'A', tag: 'AI' },
  { date: '2026-08-28', symbol: 'A', tag: 'CoWoS' },
  { date: '2026-08-28', symbol: 'B', tag: 'AI' },
  { date: '2026-08-28', symbol: 'C', tag: '金融科技' },
], '電子')
assert.deepEqual(themeSeries.map((series) => series.key).sort(), ['AI', 'CoWoS'])
assert.equal(
  themeSeries.find((series) => series.key === 'AI')?.points[0].member_count,
  2,
  'industry-theme drill-down must count distinct members within the selected parent industry',
)
assert(
  !themeSeries.some((series) => series.key === '金融科技'),
  'industry-theme drill-down must not leak a same-name or cross-industry membership from another parent',
)
assert(
  new Set(themeSeries.map((series) => series.points[0].x)).size === 2,
  'child themes must be percentile-ranked against siblings inside the selected industry',
)

const marketThemeSeries = buildPitFactorIndustryThemeSeries([
  point({ symbol: 'A', industry: '電子', rankDelta: 3 }),
  point({ symbol: 'B', industry: '電子', rankDelta: -2 }),
  point({ symbol: 'C', industry: '金融', rankDelta: 4 }),
], [
  { date: '2026-08-28', symbol: 'A', tag: 'AI' },
  { date: '2026-08-28', symbol: 'A', tag: 'CoWoS' },
  { date: '2026-08-28', symbol: 'B', tag: 'AI' },
  { date: '2026-08-28', symbol: 'C', tag: '金融科技' },
])
assert.deepEqual(
  marketThemeSeries.map((series) => series.key).sort(),
  ['AI', 'CoWoS', '金融科技'],
  'homepage industry-theme view must be an independent cross-industry universe, not a fake child of formal industry',
)
assert.equal(
  marketThemeSeries.find((series) => series.key === 'AI')?.points[0].member_count,
  2,
  'cross-industry theme view must preserve distinct theme members',
)

const selected = selectPitFactorStockSymbols([
  point({ symbol: 'A', rankDelta: 1 }),
  point({ symbol: 'B', rankDelta: -4 }),
  point({ symbol: 'C', rankDelta: 3 }),
], ['PENDING'], 2)
assert.deepEqual(selected, ['PENDING', 'B', 'C'])

const source = fs.readFileSync('src/lib/pitFactorFlowMap.ts', 'utf8')
assert.match(source, /snapshot_runs\.status='ready'/, 'drill-down must consume only completed taxonomy snapshots')
assert.match(
  source,
  /snapshot_runs\.snapshot_date<=requested_dates\.signal_date/,
  'drill-down must resolve taxonomy point-in-time and never borrow a future classification',
)
assert.match(
  source,
  /const attributionWeight = 1 \/ tags\.length/,
  'multi-theme symbols must split attribution instead of being counted at full weight in every child theme',
)
