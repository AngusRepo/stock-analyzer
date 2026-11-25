import fs from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { observedClosePriceRows } from '../routes/other'

test('on-demand predict drops sessions without an observed close and keeps the rest unchanged', () => {
  const kept = [
    { date: '2026-03-30', close: 101.5, high: 102, low: 100, open: 101, volume: 1200 },
    { date: '2026-04-01', close: '99.5', high: 100, low: 99, open: 100, volume: 900 },
  ]
  const rows = [
    kept[0],
    { date: '2026-03-31', close: null, high: null, low: null, open: null, volume: null },
    { date: '2026-03-31', close: 0, high: 0, low: 0, open: 0, volume: 0 },
    { date: '2026-03-31', close: Number.NaN, high: 1, low: 1, open: 1, volume: 1 },
    { date: '2026-03-31', close: undefined, high: 1, low: 1, open: 1, volume: 1 },
    kept[1],
  ]
  const observed = observedClosePriceRows(rows)
  assert.deepEqual(observed, kept)
  assert.equal(observed[0], kept[0])
})

test('both on-demand predict price reads pass through the observed-close filter', () => {
  const source = fs.readFileSync('src/routes/other.ts', 'utf8')
  const routeStart = source.indexOf("ml.post('/predict/:stockId'")
  const routeBody = source.slice(routeStart, source.indexOf("ml.get('/predict/:stockId'", routeStart))
  assert.match(routeBody, /let priceRows = observedClosePriceRows\(prices\.results \?\? \[\]\)/)
  assert.match(routeBody, /priceRows = observedClosePriceRows\(p2\.results \?\? \[\]\)/)
  assert.doesNotMatch(routeBody, /priceRows\s*=\s*(prices|p2)\.results/)
})
