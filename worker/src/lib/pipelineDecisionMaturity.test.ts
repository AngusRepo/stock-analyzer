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
  const shadowMigration = fs.readFileSync(path.join(process.cwd(), 'migrations/0100_expected_return_shadow_evaluation_packets.sql'), 'utf8')
  const frontendContract = fs.readFileSync(path.join(process.cwd(), '../frontend/src/lib/pipelineMaturityContract.ts'), 'utf8')
  const frontendView = fs.readFileSync(path.join(process.cwd(), '../frontend/src/components/PipelineMaturityContribution.tsx'), 'utf8')
  assert.match(source, /databaseForDataDomain\(env, 'learning'\)/)
  assert.match(source, /canonical_run_heads/)
  assert.match(source, /strategy_challenger_affinity_version/)
  assert.match(source, /strategy_redundancy_artifacts_v1/)
  assert.match(source, /m\.challenger_affinity_version=\?/)
  assert.match(source, /champion_comparison\.spread_delta_lcb90/)
  assert.match(source, /'r_multiple'/)
  assert.match(source, /historyByStage/)
  assert.match(source, /oof_applicable/)
  assert.doesNotMatch(source, /id: 's12'/)
  assert.doesNotMatch(source, /s12_tw_calibration_artifacts/)
  assert.match(source, /model_artifact_registry/)
  assert.match(source, /expected_return_shadow_evaluation_packets/)
  assert.match(source, /candidate_type IN \('l4_alpha_ev_refresh', 'allocator_ev_fusion_refresh'\)/)
  assert.match(source, /policy_decision = 'shadow_only'/)
  assert.match(source, /evidence_scopes/)
  assert.match(source, /serving_control/)
  assert.match(source, /offline_candidate/)
  assert.match(source, /frozen_forward_shadow/)
  assert.match(source, /residual_adjustment_model\.oos_metrics\.prediction_target_corr_lcb90/)
  assert.match(source, /shadow_diagnostics\.conditional_execution_return_model/)
  assert.match(source, /multiple_testing\.adjusted_p_value/)
  assert.match(source, /Fusion residual overlay/)
  assert.match(source, /same-contract L4/)
  assert.match(source, /S12 conditional-return expert \(shadow diagnostic\)/)
  assert.match(source, /canonical_l4_required/)
  assert.doesNotMatch(source, /selection_diagnostic_oos_metrics_not_served/)
  assert.doesNotMatch(source, /gateMetric\('structure_samples'/)
  assert.doesNotMatch(source, /gateMetric\('execution_samples'/)
  assert.match(source, /metric\('sector_samples', 'PIT sector-alpha samples \(diagnostic\)'/)
  assert.match(frontendContract, /PipelineMaturityEvidenceScope/)
  assert.match(frontendView, /evidenceScopes\.map/)
  assert.match(shadowMigration, /model candidates, serving artifacts, training inputs, or promotion evidence/)
  assert.doesNotMatch(shadowMigration, /model_artifact_registry/)
  assert.doesNotMatch(source, /SELECT\s+\*/i)
  assert.match(migration, /ADD COLUMN challenger_affinity_version TEXT/)
  assert.match(migration, /reference\.signal_date = matrix\.signal_date/)
  assert.match(migration, /reference\.symbol = matrix\.symbol/)
  assert.match(migration, /reference\.producer_run_id = matrix\.producer_run_id/)
  assert.match(migration, /BETWEEN '2026-07-29' AND '2026-07-31'/)
  assert.match(migration, /stock_tech_s12_multitimeframe_smc_reclaim_v1/)
  for (const stage of ['threshold_margin_affinity_v2', 'oof_redundancy', 'route_score_v2', 'l4', 'fusion']) {
    assert(source.includes(`'${stage}'`), `missing maturity stage ${stage}`)
  }
  assert.match(source, /serving control and frozen-forward shadow are separate evidence scopes/)
  const routeStart = routes.indexOf("/api/dashboard/v4/pipeline/maturity")
  assert(routeStart >= 0)
  assert(routes.slice(routeStart, routeStart + 360).includes('requireValidToken'))
  assert(routes.slice(routeStart, routeStart + 420).includes("Cache-Control', 'no-store, max-age=0"))
})
