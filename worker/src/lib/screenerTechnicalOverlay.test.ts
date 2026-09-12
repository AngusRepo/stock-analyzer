import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyScreenerTechnicalOverlay, type ScreenerOverlayBar } from './screenerTechnicalOverlay'

function history(symbol: string, slope: number, noise = 0, count = 20, volume = 1_000_000): ScreenerOverlayBar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + slope * i + (i % 2 ? noise : 0)
    return { symbol, date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`,
      close, high: close + 1, low: close - 1, volume }
  })
}

test('a union fetch cannot change formal technical percentiles or per-stock scores', () => {
  const formalSymbols = ['common', 'up1', 'up2', 'up3', 'up4', 'up5', 'up6', 'up7', 'up8', 'up9']
  const candidateSymbols = ['common', 'down1', 'down2', 'down3', 'down4', 'up5', 'up6', 'up7', 'up8', 'up9']
  const union = [...history('common', -.1, 1), ...formalSymbols.slice(1).flatMap(s => history(s, .3)),
    ...candidateSymbols.filter(s => s.startsWith('down')).flatMap(s => history(s, -2))]
  const rawBefore = structuredClone(union)
  const makeRows = (symbols: string[]) => symbols.map(symbol => ({ symbol, score: 60, reason: 'base', chip_score: 25 }))
  const formal = makeRows(formalSymbols), formalFromUnion = makeRows(formalSymbols)
  const reference = applyScreenerTechnicalOverlay(formal, union.filter(r => formalSymbols.includes(r.symbol)), formalSymbols)
  const observed = applyScreenerTechnicalOverlay(formalFromUnion, union, formalSymbols)
  assert.deepEqual(formalFromUnion, formal)
  assert.deepEqual(observed, reference)
  const alternative = makeRows(candidateSymbols)
  const alternativeMeta = applyScreenerTechnicalOverlay(alternative, union, candidateSymbols)
  assert.notEqual(alternativeMeta.p20, reference.p20)
  assert.notEqual(alternative[0].score, formal[0].score, 'shared stock can have different per-slate intent penalty')
  assert.equal(formal[0].score, 52)
  assert.equal(alternative[0].score, 60)
  assert.deepEqual(union, rawBefore, 'raw frozen history must not mutate or be sorted in place')
  assert.deepEqual(formalFromUnion, formal, 'candidate computation cannot mutate formal scores')
  const unsafe = makeRows(formalSymbols)
  applyScreenerTechnicalOverlay(unsafe, union, [...new Set(union.map(r => r.symbol))])
  assert.notEqual(unsafe[0].score, formal[0].score, 'counterexample: union percentile would contaminate formal score')
})

test('empty/short histories keep the original no-adjustment behavior; no fabricated prices', () => {
  const rows = [{ symbol: 'short', score: 60, reason: 'base' }, { symbol: 'absent', score: 40, reason: 'base' }]
  const before = structuredClone(rows)
  assert.deepEqual(applyScreenerTechnicalOverlay(rows, history('short', .1, 0, 19), ['short', 'absent']),
    { trendPenalty: 0, intentPenalty: 0, adxPenalty: 0, liqPenalty: 0, p10: -.3, p20: -.1 })
  assert.deepEqual(rows, before)
})

test('original long-history ADX, trend and liquidity computations are deterministic per slate', () => {
  const symbols = ['trend', 'fall', 'flat', 'choppy']
  const bars = [...history('trend', 1, 0, 65, 2_000_000), ...history('fall', -1, 0, 65, 20_000),
    ...history('flat', 0, 0, 65, 200_000), ...history('choppy', -.1, 3, 65, 1_000_000)]
  const initial = symbols.map(symbol => ({ symbol, score: 60, reason: 'base', chip_score: 25 }))
  const first = structuredClone(initial), second = structuredClone(initial)
  const metrics = applyScreenerTechnicalOverlay(first, bars, symbols)
  assert.deepEqual(applyScreenerTechnicalOverlay(second, [...bars].reverse(), symbols), metrics)
  assert.deepEqual(second, first)
  assert.equal(metrics.trendPenalty, 1)
  assert.equal(metrics.liqPenalty, 2)
  assert.equal(first[0].score, 67)
  assert.equal(first[1].score, 47)
  assert.equal(first[2].score, 53) // flat ADX penalty -5 plus liquidity -2
})
