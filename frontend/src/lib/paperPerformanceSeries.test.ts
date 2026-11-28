import assert from 'node:assert/strict'
import test from 'node:test'
import { benchmarkBases, benchmarkLineData, benchmarkReturnSince, botLineData, buildPaperTradePerformancePoints, gapBandData, periodMaxDrawdown } from './paperPerformanceSeries'

const snapshots = [
  { date: '2026-03-24', total_value: 1_000_000, benchmark_value: null, twii_value: 20000, etf_benchmarks: { '00631L': 100 } },
  { date: '2026-03-27', total_value: 1_010_000, benchmark_value: 50, twii_value: null, etf_benchmarks: { '00631L': 110 } },
  { date: '2026-05-12', total_value: 1_020_000, benchmark_value: 55, twii_value: 21000, etf_benchmarks: { '00631L': 120, '00403A': 10 } },
  { date: '2026-05-13', total_value: 1_030_000, benchmark_value: 60, twii_value: 22000, etf_benchmarks: { '00631L': 121, '00403A': 11 } },
]

test('benchmarks present on the bot start share that start as base', () => {
  const bases = benchmarkBases(snapshots)
  assert.deepEqual(bases.TWII, { base: 20000, startDate: '2026-03-24', aligned: true })
  assert.deepEqual(bases['00631L'], { base: 100, startDate: '2026-03-24', aligned: true })
})

test('a series that starts after the bot uses its own first value and reports its start date', () => {
  const bases = benchmarkBases(snapshots)
  assert.deepEqual(bases['0050'], { base: 50, startDate: '2026-03-27', aligned: false })
  assert.deepEqual(bases['00403A'], { base: 10, startDate: '2026-05-12', aligned: false })
  assert.equal(bases['00981A'], undefined)
})

test('returns are measured against the shared base; gaps stay gaps', () => {
  const points = buildPaperTradePerformancePoints({ snapshots }, 'ALL')
  assert.equal(points.length, 4)
  assert.equal(points[0].benchmarks['00631L'], 0)
  assert.ok(Math.abs(points[3].benchmarks['00631L']! - 21) < 1e-9)
  assert.ok(Math.abs(points[3].benchmarks.TWII! - 10) < 1e-9)
  assert.equal(points[1].benchmarks.TWII, undefined)
  assert.equal(points[0].benchmarks['0050'], undefined)
  assert.ok(Math.abs(points[3].benchmarks['0050']! - 20) < 1e-9)
  assert.ok(Math.abs(points[3].bot - 3) < 1e-9)
})

test('0050 prefers adj_close from etf_benchmarks and never mixes it with the raw close', () => {
  const adjRows = [
    { date: '2026-06-01', total_value: 1_000_000, benchmark_value: 200, etf_benchmarks: { '0050': 100 } },
    { date: '2026-06-02', total_value: 1_000_000, benchmark_value: 210, etf_benchmarks: {} },
    { date: '2026-06-03', total_value: 1_000_000, benchmark_value: 220, etf_benchmarks: { '0050': 110 } },
  ]
  const points = buildPaperTradePerformancePoints({ snapshots: adjRows }, 'ALL', Date.parse('2026-06-04T00:00:00Z'))
  assert.equal(points[0].benchmarks['0050'], 0)
  assert.equal(points[1].benchmarks['0050'], undefined, 'a missing adj mark stays a gap instead of the raw close')
  assert.ok(Math.abs(points[2].benchmarks['0050']! - 10) < 1e-9)
  // Old Worker: no etf_benchmarks['0050'] anywhere, so benchmark_value is the 0050 series.
  const legacy = buildPaperTradePerformancePoints({ snapshots: adjRows.map(({ etf_benchmarks, ...rest }) => rest) }, 'ALL', Date.parse('2026-06-04T00:00:00Z'))
  assert.ok(Math.abs(legacy[2].benchmarks['0050']! - 10) < 1e-9)
})

test('missing or zero bot total value is a gap, not 0% or -100%', () => {
  const rows = [
    { date: '2026-07-01', total_value: 1_000_000 },
    { date: '2026-07-02', total_value: 0 },
    { date: '2026-07-03' },
    { date: '2026-07-04', total_value: 1_100_000 },
  ]
  const points = buildPaperTradePerformancePoints({ snapshots: rows }, 'ALL', Date.parse('2026-07-05T00:00:00Z'))
  assert.equal(points[1].bot, null)
  assert.equal(points[2].bot, null)
  assert.ok(Math.abs(points[3].bot! - 10) < 1e-9)
})

test('mid-series null benchmark marks break the line: no 0, no bridge, base unchanged', () => {
  // batch2 /pnl: same-day adj_close only, null when missing, never carried forward.
  const rows = [
    { date: '2026-03-24', total_value: 1_000_000, etf_benchmarks: { '0050': 100, '00631L': 50 } },
    { date: '2026-03-25', total_value: 1_000_000, etf_benchmarks: { '0050': 101, '00631L': null } },
    { date: '2026-03-26', total_value: 1_000_000, etf_benchmarks: { '0050': null, '00631L': null } },
    { date: '2026-03-31', total_value: 1_000_000, etf_benchmarks: { '0050': 110, '00631L': 55 } },
  ]
  const bases = benchmarkBases(rows)
  assert.deepEqual(bases['00631L'], { base: 50, startDate: '2026-03-24', aligned: true })
  assert.deepEqual(bases['0050'], { base: 100, startDate: '2026-03-24', aligned: true })
  const points = buildPaperTradePerformancePoints({ snapshots: rows }, 'ALL', Date.parse('2026-04-01T00:00:00Z'))
  const line = benchmarkLineData(points, '00631L')
  assert.equal(line.length, rows.length, 'every date emits a point so the chart cannot bridge the gap')
  assert.deepEqual(line[1], { time: '2026-03-25' }, 'a null mark is a whitespace point, not 0')
  assert.deepEqual(line[2], { time: '2026-03-26' })
  assert.ok(Math.abs(line[3].value! - 10) < 1e-9, 'the return after the gap is still measured from the original base')
  const l0050 = benchmarkLineData(points, '0050')
  assert.deepEqual(l0050[2], { time: '2026-03-26' })
  assert.ok(Math.abs(l0050[3].value! - 10) < 1e-9)
  assert.ok(line.every((d) => d.value !== 0 || d.time === '2026-03-24'), 'only the base day may read 0%')
})

test('a benchmark null on the bot start day never becomes the base', () => {
  const rows = [
    { date: '2026-05-08', total_value: 1_000_000, etf_benchmarks: { '00403A': null } },
    { date: '2026-05-12', total_value: 1_000_000, etf_benchmarks: { '00403A': 10 } },
    { date: '2026-05-13', total_value: 1_000_000, etf_benchmarks: { '00403A': 11 } },
  ]
  assert.deepEqual(benchmarkBases(rows)['00403A'], { base: 10, startDate: '2026-05-12', aligned: false })
  const line = benchmarkLineData(buildPaperTradePerformancePoints({ snapshots: rows }, 'ALL', Date.parse('2026-05-14T00:00:00Z')), '00403A')
  assert.deepEqual(line[0], { time: '2026-05-08' })
  assert.ok(Math.abs(line[2].value! - 10) < 1e-9)
  assert.deepEqual(botLineData([{ time: '2026-05-08', bot: null, benchmarks: {}, drawdown: 0, totalValue: null }]), [{ time: '2026-05-08' }])
})

test('F9: when the first bot total is missing, the shared start moves to the first valid bot day', () => {
  const rows = [
    { date: '2026-11-01', total_value: null, etf_benchmarks: { '0050': 100 } },
    { date: '2026-11-02', total_value: 1_000_000, etf_benchmarks: { '0050': 110 } },
    { date: '2026-11-03', total_value: 1_010_000, etf_benchmarks: { '0050': 121 } },
  ]
  assert.deepEqual(benchmarkBases(rows)['0050'], { base: 110, startDate: '2026-11-02', aligned: true })
  const points = buildPaperTradePerformancePoints({ snapshots: rows }, 'ALL', Date.parse('2026-11-04T00:00:00Z'))
  assert.equal(points[0].time, '2026-11-02')
  assert.equal(points[0].bot, 0)
  assert.equal(points[0].benchmarks['0050'], 0, 'bot and 0050 both start at 0% on the same day')
  assert.ok(Math.abs(points[1].benchmarks['0050']! - 10) < 1e-9)
})

test('F5: the chart drawdown is the period drawdown, not the since-inception max_drawdown_to_date', () => {
  const rows = [
    { date: '2026-10-01', total_value: 1_000_000, max_drawdown_to_date: 0 },
    { date: '2026-10-10', total_value: 880_000, max_drawdown_to_date: 0.12 },
    { date: '2026-11-20', total_value: 950_000, max_drawdown_to_date: 0.12 },
    { date: '2026-11-24', total_value: 960_000, max_drawdown_to_date: 0.12 },
    { date: '2026-11-25', total_value: 940_000, max_drawdown_to_date: 0.12 },
  ]
  const week = buildPaperTradePerformancePoints({ snapshots: rows }, '1W', Date.parse('2026-11-26T00:00:00Z'))
  assert.equal(week[0].time, '2026-11-20')
  const mdd = periodMaxDrawdown(week)!
  assert.ok(Math.abs(mdd - (940 / 960 - 1) * 100) < 1e-9, `1W MDD is measured inside the week, got ${mdd}`)
  assert.ok(mdd > -12, 'the October -12% drawdown is outside the 1W period')
  assert.equal(periodMaxDrawdown([]), null)
})

test('F8: the summary 0050 return uses the same adj_close basis as the chart', () => {
  const now = Date.parse('2026-11-26T00:00:00Z')
  const rows = [
    // Ex-dividend between the two rows: raw close drops, adj_close does not.
    { date: '2026-11-19', total_value: 1_000_000, benchmark_value: 200, etf_benchmarks: { '0050': 190 } },
    { date: '2026-11-25', total_value: 1_000_000, benchmark_value: 196, etf_benchmarks: { '0050': 193.8 } },
  ]
  assert.ok(Math.abs(benchmarkReturnSince(rows, '0050', 7, now)! - (193.8 / 190 - 1)) < 1e-12)
  // Old Worker without etf_benchmarks['0050'] keeps the raw close.
  const legacy = rows.map(({ etf_benchmarks, ...rest }) => rest)
  assert.ok(Math.abs(benchmarkReturnSince(legacy, '0050', 7, now)! - (196 / 200 - 1)) < 1e-12)
  // One end missing on the adj basis → no comparison, never a mixed basis.
  const gap = [rows[0], { ...rows[1], etf_benchmarks: {} }]
  assert.equal(benchmarkReturnSince(gap, '0050', 7, now), null)
})

test('F8 wiring: the /bot summary reads 0050 through benchmarkReturnSince, not benchmark_value', async () => {
  const fs = await import('node:fs')
  const page = fs.readFileSync('src/pages/BotDashboard.tsx', 'utf8')
  const summary = page.slice(page.indexOf('function PortfolioSummary'), page.indexOf('function executionToneClass'))
  assert.ok(summary.includes("benchmarkReturnSince(snapshots, '0050'"))
  assert.ok(!summary.includes('benchmark_value'))
})

test('gap band spans bot↔0050, colored by lead/lag, and breaks where either side is missing', () => {
  const points = [
    { time: '2026-01-02', bot: 0, benchmarks: { '0050': 0 }, drawdown: 0, totalValue: 100 },
    { time: '2026-01-03', bot: -2, benchmarks: { '0050': 3 }, drawdown: -2, totalValue: 98 },
    { time: '2026-01-04', bot: 5, benchmarks: { '0050': 1 }, drawdown: 0, totalValue: 105 },
    { time: '2026-01-05', bot: 4, benchmarks: {}, drawdown: -1, totalValue: 104 },
  ]
  const { upper, lower } = gapBandData(points, '0050', { lead: 'R', lag: 'G', background: 'BG' })
  assert.deepEqual(upper[1], { time: '2026-01-03', value: 3, topColor: 'G', bottomColor: 'G' })
  assert.deepEqual(lower[1], { time: '2026-01-03', value: -2, topColor: 'BG', bottomColor: 'BG' })
  assert.equal(upper[2].value, 5); assert.equal(upper[2].topColor, 'R'); assert.equal(lower[2].value, 1)
  assert.deepEqual(upper[3], { time: '2026-01-05' })
  assert.deepEqual(lower[3], { time: '2026-01-05' })
})
