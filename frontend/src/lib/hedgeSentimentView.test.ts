import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { hedgeSentimentView } from './hedgeSentimentView'

test('missing server hedge score shows 待接資料 for value and label, never the market risk score', () => {
  for (const risk of [
    { riskScore: 78, hedgeSentiment: { score: null, label: '待匯入' } },
    { riskScore: 78, vix: 30, twiiVol20: 40, hedgeSentiment: { score: null, label: '待匯入' } },
    { riskScore: 78, vix: 30 },
    undefined,
  ]) assert.deepEqual(hedgeSentimentView(risk), { score: null, label: '待接資料' })
})

test('server hedge score and label are shown as built', () => {
  assert.deepEqual(hedgeSentimentView({ riskScore: 78, hedgeSentiment: { score: 41.6, label: '中性避險' } }), { score: 42, label: '中性避險' })
  assert.deepEqual(hedgeSentimentView({ hedgeSentiment: { score: 0, label: '低避險' } }), { score: 0, label: '低避險' })
  assert.deepEqual(hedgeSentimentView({ hedgeSentiment: { score: 55, label: '' } }), { score: 55, label: '待接資料' })
})

test('MarketHomePage hedge card has no market-risk or score-cut fallback', () => {
  const home = readFileSync(new URL('../pages/MarketHomePage.tsx', import.meta.url), 'utf8')
  assert.ok(home.includes('hedgeSentimentView(risk)'))
  for (const gone of ['deriveHedgeSentimentScore', '市場風險 fallback', 'hedgeScoreLabel', 'riskLevelLabel', 'risk?.riskScore']) {
    assert.ok(!home.includes(gone), gone)
  }
})
