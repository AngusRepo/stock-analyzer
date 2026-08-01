import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { maturityProgress } from './pipelineDecisionMaturity'
import {
  STRATEGY_ROUTE_MIN_TOTAL_DATES,
  STRATEGY_ROUTE_MIN_TRAIN_DATES,
  STRATEGY_ROUTE_MIN_OOS_DATES,
  STRATEGY_ROUTE_PURGE_DATES,
} from './strategyRouteCalibration'

test('maturity progress separates completed evidence volume from artifact quality', () => {
  assert.deepEqual(maturityProgress(2, 5, 'dates'), {
    current: 2,
    required: 5,
    remaining: 3,
    ratio: 0.4,
    unit: 'dates',
    complete: false,
  })
  assert.deepEqual(maturityProgress(38, 20, 'dates'), {
    current: 38,
    required: 20,
    remaining: 0,
    ratio: 1,
    unit: 'dates',
    complete: true,
  })
  assert.equal(maturityProgress(0, 0, 'rows'), null)
})

test('route maturity threshold has one exported source of truth', () => {
  assert.equal(STRATEGY_ROUTE_MIN_TRAIN_DATES, 3)
  assert.equal(STRATEGY_ROUTE_PURGE_DATES, 5)
  assert.equal(STRATEGY_ROUTE_MIN_OOS_DATES, 3)
  assert.equal(STRATEGY_ROUTE_MIN_TOTAL_DATES, 11)
})

test('pipeline maturity API preserves canonical lineage and explicit evidence fields', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/pipelineDecisionMaturity.ts'), 'utf8')
  const routes = fs.readFileSync(path.join(process.cwd(), 'src/routes/dashboardReadRoutes.ts'), 'utf8')
  const migration = fs.readFileSync(path.join(process.cwd(), 'migrations/0098_strategy_challenger_reward_and_s12_owner_closure.sql'), 'utf8')
  assert.match(source, /databaseForDataDomain\(env, 'learning'\)/)
  assert.match(source, /canonical_run_heads/)
  assert.match(source, /strategy_challenger_affinity_version/)
  assert.match(source, /strategy_redundancy_artifacts_v1/)
  assert.match(source, /m\.challenger_affinity_version=\?/)
  assert.match(source, /selection_champion_comparison\.spread_delta_lcb90/)
  assert.match(source, /'r_multiple'/)
  assert.match(source, /historyByStage/)
  assert.match(source, /oof_applicable/)
  assert.match(source, /s12_tw_calibration_artifacts/)
  assert.match(source, /model_artifact_registry/)
  assert.doesNotMatch(source, /SELECT\s+\*/i)
  assert.match(migration, /ADD COLUMN challenger_affinity_version TEXT/)
  assert.match(migration, /reference\.signal_date = matrix\.signal_date/)
  assert.match(migration, /reference\.symbol = matrix\.symbol/)
  assert.match(migration, /reference\.producer_run_id = matrix\.producer_run_id/)
  assert.match(migration, /BETWEEN '2026-07-29' AND '2026-07-31'/)
  assert.match(migration, /stock_tech_s12_multitimeframe_smc_reclaim_v1/)
  for (const stage of ['threshold_margin_affinity_v2', 'oof_redundancy', 'route_score_v2', 's12', 'l4', 'fusion']) {
    assert(source.includes(`'${stage}'`), `missing maturity stage ${stage}`)
  }
  const routeStart = routes.indexOf("/api/dashboard/v4/pipeline/maturity")
  assert(routeStart >= 0)
  assert(routes.slice(routeStart, routeStart + 360).includes('requireValidToken'))
})
