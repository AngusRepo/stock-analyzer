import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { classifyStorageAdmission } from './storageAdmissionControl'

const source = (name: string) => fs.readFileSync(path.join(process.cwd(), 'src/lib', name), 'utf8')

test('selection evidence UPSERT preserves and refreshes route fields', () => {
  const selection = source('selectionReferenceEvidence.ts')
  for (const field of [
    'strategy_router_version', 'strategy_router_score',
    'strategy_challenger_route_version', 'strategy_challenger_route_score',
  ]) {
    assert(selection.includes(`${field}=COALESCE(`), `missing conflict refresh for ${field}`)
    assert(selection.includes(`selection_reference_snapshots_v1.${field}`), `historical null must preserve ${field}`)
  }
})

test('Threshold V2 and Route V2 promotion is one evidence bundle', () => {
  const calibration = source('strategyRouteCalibration.ts')
  const maturity = source('pipelineDecisionMaturity.ts')
  assert(calibration.includes('current_day_threshold_affinity_complete'))
  assert(calibration.includes('current_day_challenger_route_complete'))
  assert(calibration.includes("result.status === 'pass' && currentCoverageReady && options.allowPromotion === true"))
  assert(maturity.includes('strategy_route_bundle: StrategyRouteBundleMaturity'))
  assert(maturity.includes('passed === false'), 'metadata must not be parsed as failed boolean gates')
})

test('storage admission blocks high-write producers but never trading serving', () => {
  assert.equal(classifyStorageAdmission('weekly-optuna', 79).allowed, false)
  assert.equal(classifyStorageAdmission('l4-alpha-ev-refresh', 79).allowed, true)
  assert.equal(classifyStorageAdmission('l4-alpha-ev-refresh', 86).allowed, false)
  assert.equal(classifyStorageAdmission('monthly-retrain', null).allowed, false)
  assert.equal(classifyStorageAdmission('evening-chain', 99).allowed, true)
  assert.equal(classifyStorageAdmission('intraday-check', 99).allowed, true)
})

test('split D1 audit uses domain baselines and reports true orphan reachability', () => {
  const readiness = source('storageReadiness.ts')
  const lifecycle = source('artifactLifecycle.ts')
  assert(readiness.includes('0001_execution_baseline.sql'))
  assert(readiness.includes('0001_paper_baseline.sql'))
  assert(readiness.includes("migration_catalog: 'domain_baseline'"))
  assert(lifecycle.includes('LEFT JOIN run_artifacts a ON a.artifact_id=r.artifact_id'))
  assert(lifecycle.includes('artifact_true_orphan_references'))
  assert(lifecycle.includes('canonical_execution_lineage_ready'))
})

test('Multi-D1 and daily lineage watchdogs remain automatic and non-serving', () => {
  const drain = source('dataDomainShadowBackfillDrain.ts')
  const lineage = source('dailyExecutionPaperLineage.ts')
  const scheduler = JSON.parse(fs.readFileSync(path.join(process.cwd(), '../infra/gcp-scheduler-jobs.json'), 'utf8'))
  assert(drain.includes('nextDataDomainIncrementalCatchupTable'))
  assert(drain.includes("['execution', 'paper', 'ops', 'learning', 'research', 'core', 'market']"))
  assert(lineage.includes('daily_paper_snapshot_not_ready'))
  assert(lineage.includes("status: 'reused'"))
  assert(scheduler.jobs.some((job: any) => job.id === 'daily-execution-paper-lineage' && job.schedule === '35,50 6 * * 1-5'))
  assert(scheduler.jobs.some((job: any) => job.id === 'data-domain-shadow-backfill-next' && job.schedule === '30 16 * * *'))
})

test('frontend explains joint readiness instead of showing isolated threshold green', () => {
  const panel = fs.readFileSync(path.join(process.cwd(), '../frontend/src/components/PipelineMaturityContribution.tsx'), 'utf8')
  assert(panel.includes('門檻證據 V2 + 路由分數 V2 必須一起升級'))
  assert(panel.includes('current_route_rows'))
  assert(panel.includes('同一份 promotion commit'))
})
