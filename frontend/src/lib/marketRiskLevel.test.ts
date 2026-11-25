import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { MARKET_RISK_LEVEL_STYLE, marketRiskLevelStyle, marketRiskShield, normalizeMarketRiskLevel, tradingMarketRisk } from './marketRiskLevel'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

test('trading level comes from runtimeRisk, not the factor packet level or score cuts', () => {
  // 11/20: packet red (score 78), trading black.
  const view = tradingMarketRisk({
    riskLevel: 'red', riskScore: 78,
    runtimeRisk: { status: 'ready', level: 'black', score: 88.6, date: '2026-11-20', haltNewBuys: true, blockers: [] },
  })
  assert.equal(view.level, 'black')
  assert.equal(view.label, MARKET_RISK_LEVEL_STYLE.black.label)
  assert.equal(view.style, MARKET_RISK_LEVEL_STYLE.black)
  assert.equal(view.score, 88.6)
  assert.equal(view.haltNewBuys, true)
})

test('missing runtime is unknown, never a fabricated score or level', () => {
  for (const payload of [undefined, {}, { riskScore: 50, riskLevel: 'local_fallback' }, { runtimeRisk: { status: 'ready', level: 'purple', score: 40 } }]) {
    const view = tradingMarketRisk(payload)
    assert.equal(view.status, 'missing')
    assert.equal(view.level, null)
    assert.equal(view.score, null)
    assert.equal(view.label, '待接資料')
  }
})

test('blocked trades as black; awaiting next session has no level', () => {
  const blocked = tradingMarketRisk({ runtimeRisk: { status: 'blocked', level: 'black', score: null, haltNewBuys: true, blockers: ['market_risk_missing'] } })
  assert.equal(blocked.level, 'black')
  assert.equal(blocked.style, MARKET_RISK_LEVEL_STYLE.black)
  assert.equal(blocked.label, '資料阻擋 · 停止新買')
  assert.deepEqual(blocked.blockers, ['market_risk_missing'])
  const awaiting = tradingMarketRisk({ runtimeRisk: { status: 'awaiting_next_session', level: null, date: '2026-11-24' } })
  assert.equal(awaiting.level, null)
  assert.equal(awaiting.score, null)
  assert.equal(awaiting.label, '待下一交易日計算')
})

test('every level including black has a style; stored legacy vocabulary maps like the Worker runtime', () => {
  for (const level of ['green', 'yellow', 'orange', 'red', 'black'] as const) assert.equal(marketRiskLevelStyle(level), MARKET_RISK_LEVEL_STYLE[level])
  assert.equal(normalizeMarketRiskLevel('extreme'), 'black')
  assert.equal(normalizeMarketRiskLevel('medium'), 'yellow')
  assert.equal(normalizeMarketRiskLevel('unknown'), null)
})

test('pages show the API level without frontend score cuts or fabricated fallbacks', () => {
  const bot = read('../pages/BotDashboard.tsx')
  const home = read('../pages/MarketHomePage.tsx')
  const panel = read('../components/MarketRiskPanel.tsx')
  const trades = read('../components/TradePerformancePanel.tsx')
  assert.ok(bot.includes('tradingMarketRisk(risk)'))
  assert.ok(!/riskScore\s*>\s*(70|40)/.test(bot), 'BotDashboard must not cut scores into levels')
  assert.ok(!bot.includes("?? 'medium'") && !bot.includes('riskScore ?? 50') && !bot.includes('market_risk_score ?? 50'))
  assert.ok(!home.includes("raw.includes('red')"), 'MarketHomePage must not map market risk levels itself')
  assert.ok(panel.includes('tradingMarketRisk(risk)') && !panel.includes('const LEVEL_CONFIG'))
  assert.ok(!panel.includes('LEVEL_CONFIG.yellow'), 'unknown level must not fall back to yellow')
  assert.ok(trades.includes('marketRiskLevelStyle(h.market_risk_level)'))
})

test('shield icon: unknown or awaiting is neutral, never the safe check', () => {
  assert.equal(marketRiskShield(tradingMarketRisk(undefined)), 'neutral')
  assert.equal(marketRiskShield(tradingMarketRisk({ riskScore: null, riskLevel: null, runtimeRisk: null })), 'neutral')
  assert.equal(marketRiskShield(tradingMarketRisk({ runtimeRisk: { status: 'awaiting_next_session', level: null } })), 'neutral')
  assert.equal(marketRiskShield(tradingMarketRisk({ runtimeRisk: { status: 'blocked', level: 'black', haltNewBuys: true } })), 'alert')
  assert.equal(marketRiskShield(tradingMarketRisk({ runtimeRisk: { status: 'ready', level: 'red', haltNewBuys: false } })), 'alert')
  assert.equal(marketRiskShield(tradingMarketRisk({ runtimeRisk: { status: 'ready', level: 'yellow', haltNewBuys: false } })), 'check')
  const bot = read('../pages/BotDashboard.tsx')
  assert.ok(bot.includes('[marketRiskShield(trading)]') && bot.includes('neutral: Shield'))
})
