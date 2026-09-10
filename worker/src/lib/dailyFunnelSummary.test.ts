import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDailyFunnelLayers, buildFinalSignalLayer } from './dailyFunnelSummary'
const fixture = () => ({
  run: { status: 'success', universe_count: 806, metadata: {
    l0DropReasonConservation: { schema_version: 'l0-drop-reason-conservation-v1', source_stage: 'universe', source_universe: 1939, pass: 806, drop: 1133,
      primary_reason_counts: { restricted: 14, liquidity: 856, price: 263 }, conservation: {
        source_universe_equals_pass_plus_drop: true, primary_reason_counts_equal_drop: true, every_drop_has_exactly_one_primary_reason: true } },
    strategyCandidatePool: { layer1_telemetry: { source_universe_count: 806, l15_router_ml_slate_count: 627, l15_router_observe_only_count: 179 } },
  } },
  stages: [
    { stage: 'universe', total_count: 1035, pass_count: 393, drop_count: 642 },
    { stage: 'l1_candidate_seed_after_overlay', total_count: 627, selected_count: 627, drop_count: 0 },
    { stage: 'l15_ml_slate_queue', total_count: 627, observe_count: 627, drop_count: 0 },
    { stage: 'layer3_formal_ml_gate', total_count: 627, pass_count: 627, drop_count: 0 },
  ],
  signals: { recommendation_count: 627, buy_signal_count: 0, hold_count: 627, sell_count: 0, other_count: 0 },
})
const build = (f: ReturnType<typeof fixture>) => buildDailyFunnelLayers(f.run, f.stages, f.signals)
test('capped-detail regression conserves full L0 and candidate populations', () => {
  const layers = build(fixture())
  assert.equal(layers[0].passed, 806); assert.equal(layers[0].eliminated, 1133)
  assert.equal(layers[1].metrics[1].value, 179); assert.equal(layers[1].eliminated, null)
  assert.equal(layers[4].metrics[1].value, 627); assert.equal(layers[4].eliminated, null)
  assert(layers.every(l => l.availability === 'available'))
})
test('missing, invalid and unfinished receipts never fall back to partial logs', () => {
  const cases = [fixture(), fixture(), fixture(), fixture()]
  cases[0].run.metadata.l0DropReasonConservation.pass = 807
  cases[1].run.metadata.l0DropReasonConservation.primary_reason_counts.price = 262
  cases[2].run.metadata.l0DropReasonConservation.schema_version = 'missing'
  cases[3].run.status = 'running'
  for (const f of cases) { assert.equal(build(f)[0].passed, null); assert.equal(build(f)[0].availability, 'unavailable') }
})
test('candidate and queue coverage mismatch cannot become zero loss', () => {
  const f = fixture(); f.run.metadata.strategyCandidatePool.layer1_telemetry.l15_router_observe_only_count = 0
  assert.equal(build(f)[1].availability, 'unavailable')
  const missing = fixture(); missing.stages = missing.stages.filter(s => s.stage !== 'l15_ml_slate_queue')
  assert.equal(build(missing)[2].passed, null)
})
test('failed ML contracts are not counted as evidence qualified', () => {
  const f = fixture(); f.stages[3].pass_count = 620; f.stages[3].drop_count = 7
  assert.deepEqual(build(f)[3].metrics.map(m => m.value), [627, 620, 7])
  assert.equal(build(f)[3].eliminated, null)
})
test('partial ML evidence remains unknown', () => {
  const f = fixture(); f.stages[3].total_count = 100
  assert.equal(build(f)[3].availability, 'unavailable')
})
test('BUY HOLD SELL other are separate conservative categories', () => {
  const f = fixture(); Object.assign(f.signals, { buy_signal_count: 2, hold_count: 600, sell_count: 20, other_count: 5 })
  assert.deepEqual(build(f)[4].metrics.map(m => m.value), [2, 600, 20, 5])
  f.signals.hold_count = 627; assert.equal(build(f)[4].availability, 'unavailable')
})
test('missing or wrong-population final signals do not publish exact totals', () => {
  assert.equal(buildFinalSignalLayer(null).passed, null)
  assert.equal(buildFinalSignalLayer(fixture().signals, 628).passed, null)
  assert.equal(buildFinalSignalLayer(fixture().signals, null).passed, null)
})
test('complete zero population is available', () => {
  const f = fixture(); f.run.universe_count = 0
  Object.assign(f.run.metadata.l0DropReasonConservation, { source_universe: 1133, pass: 0 })
  Object.assign(f.run.metadata.strategyCandidatePool.layer1_telemetry, { source_universe_count: 0, l15_router_ml_slate_count: 0, l15_router_observe_only_count: 0 })
  for (const s of f.stages.slice(1)) Object.assign(s, { total_count: 0, pass_count: 0, selected_count: 0, drop_count: 0 })
  Object.assign(f.signals, { recommendation_count: 0, hold_count: 0 })
  assert(build(f).every(l => l.availability === 'available'))
})
