import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { mediumRiskScaleFor } from './paperEntryTasks'
import { DEFAULT_TRADING_CONFIG, validateTradingConfig } from './tradingConfig'

// L2 medium_risk_scale applies only on the canonical levels listed in L2_formula.medium_risk_levels.
// Absent (no default) keeps the live behaviour (never applied) and leaves the Worker merged config, and so
// existing release grants' trading_config digest, unchanged; backtest_engine reads the same field.
const l2 = DEFAULT_TRADING_CONFIG.L2_formula
assert.ok(!('medium_risk_levels' in l2), 'no default: adding one changes the merged config every grant pins')
assert.deepEqual(validateTradingConfig({ ...DEFAULT_TRADING_CONFIG, L2_formula: { ...l2, medium_risk_levels: [] } })
  .filter(e => e.includes('medium_risk')), [])
for (const level of ['green', 'yellow', 'medium', 'orange', 'red', 'black', 'unknown', null]) assert.equal(mediumRiskScaleFor(level, l2), 1)
const yellowOn = { ...l2, medium_risk_levels: ['yellow'] as any }
assert.equal(mediumRiskScaleFor('yellow', yellowOn), 0.5)
assert.equal(mediumRiskScaleFor('medium', yellowOn), 0.5, 'retired vocabulary normalises to yellow')
assert.equal(mediumRiskScaleFor('orange', yellowOn), 1)
assert.equal(mediumRiskScaleFor('yellow', { ...yellowOn, medium_risk_scale: Number.NaN }), 1)
assert.equal(mediumRiskScaleFor('yellow', { ...yellowOn, medium_risk_scale: 3 }), 1)
assert.equal(mediumRiskScaleFor('yellow', { ...yellowOn, medium_risk_levels: 'yellow' }), 1)

// A non-empty level list is rejected until backtest has canonical-level parity with Paper.
for (const levels of [['yellow'], ['orange', 'red']]) {
  const errors = validateTradingConfig({ ...DEFAULT_TRADING_CONFIG, L2_formula: { ...l2, medium_risk_levels: levels as any } })
  assert.ok(errors.some(e => e.startsWith('L2_formula.medium_risk_levels must stay []')), levels.join(','))
}
assert.ok(validateTradingConfig({ ...DEFAULT_TRADING_CONFIG, L2_formula: { ...l2, medium_risk_levels: ['purple'] as any } })
  .includes('L2_formula.medium_risk_levels must be an array of green|yellow|orange|red|black'))
// The KV scale itself must be a number in [0, 1].
assert.deepEqual(validateTradingConfig(DEFAULT_TRADING_CONFIG).filter(e => e.includes('medium_risk')), [])
for (const bad of [-0.1, 1.5, Number.NaN, '0.5', null]) {
  const errors = validateTradingConfig({ ...DEFAULT_TRADING_CONFIG, L2_formula: { ...l2, medium_risk_scale: bad as any } })
  assert.ok(errors.includes('L2_formula.medium_risk_scale must be a number in [0, 1]'), String(bad))
}

const source = fs.readFileSync(path.join(__dirname, 'paperEntryTasks.ts'), 'utf8')
assert.ok(source.includes('const mediumRiskDampen = mediumRiskScaleFor(marketRisk.risk_level, cfg.L2_formula)'))
assert.ok(!/risk_level\s*===\s*'medium'/.test(source), 'no raw medium compare remains')
const backtest = fs.readFileSync(path.join(__dirname, '../../../ml-controller/services/backtest_engine.py'), 'utf8')
assert.ok(backtest.includes('l2_formula_cfg.get("medium_risk_levels")'), 'backtest reads the same level list')
assert.ok(!backtest.includes('if risk_level == "yellow":'), 'backtest no longer hardcodes yellow')
console.log('paper entry medium-risk scale contract passed')
