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
    return validateTradingConfig(cfg).filter(error => /v2|policy_schema|positionScales/.test(error))
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

  // EMERGING/ESB/ROTC targets under v2 surface as an explicit setup error, never a silent SQL drop.
  const orchestrator = readFileSync(new URL('./pendingBuyOrchestrator.ts', import.meta.url), 'utf8')
  assert.ok(orchestrator.includes("AND (?=1 OR COALESCE(UPPER(s.market), '') NOT IN ('EMERGING', 'ESB'))"))
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
