import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { circuitPositionScales } from './circuitPositionScales'
import { checkP3MarketRisk } from './riskChecks/p3MarketRisk'
import { checkP4Breadth } from './riskChecks/p4Breadth'
import { P5_LOSS_POSITION_SCALE, p5LossStreakScale } from './riskChecks/p5Losses'
import { DEFAULT_TRADING_CONFIG, validateTradingConfig } from './tradingConfig'
import { WEIGHT_SUPPORT } from './l4NumericContract'

const SCALES = { highVol: 0.5, severeHighVol: 0.5, momentumZone: { RED: 0.3, YELLOW: 0.7 }, lossStreak: 0.5 }

function config(maxPositionPct = 0.08, scales?: typeof SCALES): any {
  const cfg = structuredClone(DEFAULT_TRADING_CONFIG) as any
  cfg.circuit = { ...cfg.circuit, maxPositionPct, highVolReducedPosPct: 0.04 }
  if (scales) cfg.circuit.positionScales = structuredClone(scales)
  return cfg
}
const deps = (maxPositionPct: number) => ({ defaults: { halt: false, maxPositionPct, buyConfThreshold: 0.6,
  sellConfThreshold: 0.65 } as any, effectiveBuy: 0.6, effectiveSell: 0.65 })
const risk = (level: string, breadthLevel: string | null = null) => ({ status: 'ready', level, score: 1,
  date: '2026-10-21', reasons: [], blockers: [], targetExposureCap: 0.45, deRiskExistingPositions: false,
  breadthLevel, advanceRatio: 0.2, bullAlignmentRatio: 0.5 }) as any

async function run(): Promise<void> {
  // Every circuit layer keeps today's absolute cap once the relative scales are written.
  for (const level of ['orange', 'red']) {
    const legacy = await checkP3MarketRisk(risk(level), config(), deps(0.08))
    const scaled = await checkP3MarketRisk(risk(level), config(0.08, SCALES), deps(0.08))
    assert.equal(scaled!.maxPositionPct, legacy!.maxPositionPct, `P3 ${level}`)
    const breadthLegacy = await checkP4Breadth(risk('green', level), config(), deps(0.08))
    const breadthScaled = await checkP4Breadth(risk('green', level), config(0.08, SCALES), deps(0.08))
    assert.equal(breadthScaled!.maxPositionPct, breadthLegacy!.maxPositionPct, `P4 ${level}`)
  }
  // A new baseline moves the scaled caps with it; the legacy absolute cap does not.
  const wider = await checkP3MarketRisk(risk('orange'), config(0.12, SCALES), deps(0.12))
  assert.equal(wider!.maxPositionPct, 0.06)
  assert.equal((await checkP3MarketRisk(risk('orange'), config(0.12), deps(0.12)))!.maxPositionPct, 0.04)
  assert.equal(p5LossStreakScale(undefined), P5_LOSS_POSITION_SCALE)
  assert.equal(p5LossStreakScale({ positionScales: { ...SCALES, lossStreak: 0.4 } }), 0.4)
  assert.equal(circuitPositionScales({}), null)
  for (const bad of [{ ...SCALES, lossStreak: 0 }, { ...SCALES, highVol: 1.2 }, { ...SCALES, extra: 1 },
    { ...SCALES, momentumZone: { RED: 0.3 } }]) {
    assert.throws(() => circuitPositionScales({ positionScales: bad }), /circuit_position_scales_invalid/)
  }

  // The v2 validator holds the owner split; release-evidence errors are covered elsewhere.
  const v2Errors = (mutate: (cfg: any) => void) => {
    const cfg = config(0.08, SCALES)
    cfg.l4Distribution = { policy_schema: 'l4-distribution-policy-v2', scope: 'paper', artifact: {},
      constraints: { risk_aversion: 2, return_history_lookback_sessions: 252, cost_objective: 'entry_round_trip_v1' },
      opb: { schema_version: 'l4-opb-relative-arms-v2', enabled: true, reward_window_observations: 60,
        reward_half_life_observations: 20, arms: [{ id: 'base' }, { id: 'tight', exposure_fraction: 0.8, name_fraction: 0.8 }] } }
    mutate(cfg)
    return validateTradingConfig(cfg).filter(error => /v2|v3|policy_schema|positionScales/.test(error))
  }
  assert.deepEqual(v2Errors(() => {}), [])
  assert.match(v2Errors(cfg => { cfg.l4Distribution.constraints.name_cap = 0.25 }).join(), /allocator-owned/)
  // Both reviewed cost objectives validate; anything else (or none) does not.
  assert.deepEqual(v2Errors(cfg => { cfg.l4Distribution.constraints.cost_objective = 'single_side_v1' }), [])
  assert.match(v2Errors(cfg => { cfg.l4Distribution.constraints.cost_objective = 'one_way' }).join(), /allocator-owned/)
  assert.match(v2Errors(cfg => { delete cfg.l4Distribution.constraints.cost_objective }).join(), /allocator-owned/)
  assert.match(v2Errors(cfg => { cfg.l4Distribution.opb.exploration = 0.05 }).join(), /fractions of the risk envelope/)
  assert.match(v2Errors(cfg => { cfg.l4Distribution.opb.arms[1].exposure_fraction = 1.2 }).join(), /fractions/)
  assert.match(v2Errors(cfg => { delete cfg.circuit.positionScales }).join(), /requires circuit.positionScales/)
  assert.match(v2Errors(cfg => { cfg.position.maxPctOfPortfolio = 0.25 }).join(), /forbids position.maxPctOfPortfolio/)
  assert.match(v2Errors(cfg => { cfg.l4Distribution.policy_schema = 'l4-distribution-policy-v9' }).join(), /policy_schema is unknown/)
  assert.equal('maxPctOfPortfolio' in DEFAULT_TRADING_CONFIG.position, false, 'risk_config owns the single-name cap')
  // OPB v3: selection arms only, every statistical knob explicit (mirrors validate_v3_config).
  const v3 = (cfg: any) => { cfg.l4Distribution.opb = { schema_version: 'l4-opb-selection-arms-v3', enabled: true,
    reward_window_observations: 60, reward_half_life_observations: 20,
    reward: 'exposure_normalized_market_neutral_daily_v1', family_error_rate: 0.1, hac_lag_sessions: 2,
    critical_value_simulations: 20000, min_exposure_ratio: 0.5,
    inert_counterfactual: { enabled: true, reference_exposure_cap: 0.2, reference_name_cap: 0.0625 },
    cutover_warm_start: { enabled: true, max_observations: 20 },
    arms: [{ id: 'base' }, { id: 'alpha_tilt', risk_aversion: 0.5 }, { id: 'risk_tilt', risk_aversion: 8 },
      { id: 'ridge', l2_penalty: 0.02 }] } }
  assert.deepEqual(v2Errors(v3), [])
  for (const [mutate, field] of [
    [(o: any) => { o.arms[1].exposure_fraction = 0.8 }, 'arms'],
    [(o: any) => { o.arms[1].name_fraction = 0.8 }, 'arms'],
    [(o: any) => { o.arms[2].max_cluster_weight = 1.5 }, 'arms'],
    [(o: any) => { o.arms[2].id = 'alpha_tilt' }, 'arms'],
    [(o: any) => { o.arms[3].risk_aversion = 0.5; delete o.arms[3].l2_penalty }, 'arms'],
    [(o: any) => { o.arms.push({ id: 'same_as_base' }) }, 'arms'],
    [(o: any) => { o.min_exposure_ratio = 0 }, 'min_exposure_ratio'],
    [(o: any) => { o.critical_value_simulations = 200000; o.reward_window_observations = 120 }, 'critical_value_simulations'],
    [(o: any) => { o.exploration = 0.05 }, 'unknown_field'],
    [(o: any) => { delete o.family_error_rate }, 'family_error_rate'],
    [(o: any) => { o.family_error_rate = 0.6 }, 'family_error_rate'],
    [(o: any) => { o.hac_lag_sessions = 2.5 }, 'hac_lag_sessions'],
    [(o: any) => { o.critical_value_simulations = 10 }, 'critical_value_simulations'],
    [(o: any) => { o.reward = 'raw_v2' }, 'reward'],
    [(o: any) => { delete o.inert_counterfactual.reference_name_cap }, 'inert_counterfactual'],
    [(o: any) => { o.inert_counterfactual.reference_name_cap = 0.3 }, 'inert_counterfactual'],
    [(o: any) => { o.inert_counterfactual.enabled = false }, 'inert_counterfactual'],
    [(o: any) => { o.cutover_warm_start.max_observations = 61 }, 'cutover_warm_start'],
    // opb.market_proxy (Wei 11/28): optional, a TW ETF code (label calendar stays on 0050), fail closed otherwise.
    [(o: any) => { o.market_proxy = '00631L' }, 'market_proxy'],
    [(o: any) => { o.market_proxy = '2330' }, 'market_proxy'],
    [(o: any) => { o.market_proxy = '0050123' }, 'market_proxy'],
    [(o: any) => { o.market_proxy = '005' }, 'market_proxy'],
    [(o: any) => { o.market_proxy = '123' }, 'market_proxy'],
    [(o: any) => { o.market_proxy = '1234567' }, 'market_proxy'],
    [(o: any) => { o.market_proxy = 50 }, 'market_proxy'],
    [(o: any) => { o.market_proxy = null }, 'market_proxy'],
    [(o: any) => { o.market_proxy = ' 0050' }, 'market_proxy'],
  ] as const) {
    assert.match(v2Errors(cfg => { v3(cfg); mutate(cfg.l4Distribution.opb) }).join(), new RegExp(`v3 OPB selection arms are invalid: ${field}`), field)
  }
  for (const proxy of ['0050', '006208', '0056', '00878']) assert.deepEqual(v2Errors(cfg => { v3(cfg); cfg.l4Distribution.opb.market_proxy = proxy }), [], proxy)
  // A v3-only field: on a v2 OPB block it is rejected (Python validate_arms rejects it too).
  assert.match(v2Errors(cfg => { cfg.l4Distribution.opb.market_proxy = '0050' }).join(), /opb.market_proxy is a v3 OPB field/)
  assert.deepEqual(v2Errors(cfg => { v3(cfg); cfg.l4Distribution.opb.inert_counterfactual =
    { enabled: false, reference_exposure_cap: null, reference_name_cap: null } }), [])

  // EMERGING/ESB/ROTC targets under v2 surface as an explicit setup error, never a silent SQL drop.
  const orchestrator = readFileSync(new URL('./pendingBuyOrchestrator.ts', import.meta.url), 'utf8')
  assert.ok(orchestrator.includes("AND (?=1 OR COALESCE(UPPER(COALESCE(s.listing_market, s.market)), '') NOT IN ('EMERGING', 'ESB', 'ROTC'))"))
  assert.ok(orchestrator.includes("normalizeBoardType(row.market) === 'EMERGING' && targetBuyGap(row)"))
  assert.ok(orchestrator.includes('l4_plan_selected_non_executable:'))
  const board = readFileSync(new URL('./boardTradability.ts', import.meta.url), 'utf8')
  assert.ok(board.includes("value === 'EMERGING' || value === 'ESB' || value === 'ROTC'"))
  assert.equal(WEIGHT_SUPPORT, 1e-7)
  console.log('l4PolicyV2Contract ok')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
