import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { buildStockData, scoreMultiFactor } from './marketScreener'
import type { CanonicalScreenerChip, CanonicalScreenerPrice } from './screenerMarketData'

// NEW-1030-02: four screener reason texts were Big5-misdecoded literals. They now match the Python
// backtest engine (ml-controller/services/backtest_engine.py), and the dead Big5 chip-name branch is gone.

const bars = (close: (i: number) => number): CanonicalScreenerPrice[] => Array.from({ length: 40 }, (_, i) => {
  const c = close(i)
  return { date: `2026-09-${String(i + 1).padStart(2, '0')}`, stock_id: '2330', Trading_Volume: 1000, Trading_money: 0,
    open: c, max: c * 1.005, min: c * 0.995, close: c, spread: 0, Trading_turnover: 0 }
})
const reasonsFor = (prices: CanonicalScreenerPrice[]) =>
  scoreMultiFactor(prices, undefined, 0, prices[prices.length - 1].close).reasons
const PRIVATE_USE = /[\uE000-\uF8FF]/
// Big5-misdecoded UTF-8 leaves a CJK character followed by '?' where a byte had no mapping.
const MISDECODED = /[\u3400-\u9FFF]\?/

test('B5-1: an accelerating uptrend gives the four reasons in the Python wording', () => {
  const reasons = reasonsFor(bars((i) => 100 * Math.pow(1.0004, i * i)))
  assert.ok(reasons.includes('MACD 多頭'), reasons.join(','))
  assert.ok(reasons.includes('站上MA20'), reasons.join(','))
  assert.ok(reasons.some((r) => /^超額\+\d+\.\d%$/.test(r)), reasons.join(','))
  assert.ok(reasons.some((r) => /^意圖\d+%$/.test(r)), reasons.join(','))
  assert.ok(reasons.every((r) => !PRIVATE_USE.test(r) && !r.includes('?')), reasons.join(','))
})

test('B5-2: a downtrend triggers none of the four reasons', () => {
  const reasons = reasonsFor(bars((i) => 100 * Math.pow(0.9996, i * i)))
  assert.ok(!reasons.some((r) => r === 'MACD 多頭' || r === '站上MA20' || r.startsWith('超額') || r.startsWith('意圖')), reasons.join(','))
})

test('B5-3: the Worker reason literals are the Python engine strings, with no misdecoded text', () => {
  const ts = readFileSync(new URL('./marketScreener.ts', import.meta.url), 'utf8')
  const py = readFileSync(new URL('../../../ml-controller/services/backtest_engine.py', import.meta.url), 'utf8')
  for (const [tsLiteral, pyLiteral] of [
    ["reasons.push('MACD 多頭')", 'reasons.append("MACD 多頭")'],
    ["reasons.push('站上MA20')", 'reasons.append("站上MA20")'],
    ['reasons.push(`超額+${(excess * 100).toFixed(1)}%`)', 'reasons.append(f"超額+{excess * 100:.1f}%")'],
    ['reasons.push(`意圖${(priceIntent * 100).toFixed(0)}%`)', 'reasons.append(f"意圖{price_intent * 100:.0f}%")'],
  ]) {
    assert.ok(ts.includes(tsLiteral), tsLiteral)
    assert.ok(py.includes(pyLiteral), pyLiteral)
  }
  const pushes = ts.split('\n').filter((line) => line.includes('reasons.push('))
  assert.ok(pushes.length > 20)
  for (const line of pushes) {
    const code = line.replace(/\/\/.*$/, '')
    assert.ok(!PRIVATE_USE.test(code) && !MISDECODED.test(code) && !/['`]\?|\?\?\$\{/.test(code), line.trim())
  }
})

test('B5-4: institutional nets come from the canonical English names only (legacy Chinese names are not added)', () => {
  const chip = (name: string, buy: number): CanonicalScreenerChip => ({ date: '2026-10-29', stock_id: '2330', name, buy, sell: 0 })
  // Same stock and date from both sources: the canonical net is kept and not double counted.
  const both = buildStockData([], [chip('foreign', 1000), chip('外資', 500), chip('trust', 300), chip('投信', 200)])
  assert.deepEqual([both.chips.get('2330')!.get('2026-10-29')!.foreign, both.chips.get('2330')!.get('2026-10-29')!.trust], [1000, 300])
  // Legacy-only names stay at 0 (whether to count them is a pending owner decision, not this change).
  const legacy = buildStockData([], [chip('外資', 500), chip('投信', 200)])
  assert.deepEqual([legacy.chips.get('2330')!.get('2026-10-29')!.foreign, legacy.chips.get('2330')!.get('2026-10-29')!.trust], [0, 0])
})
