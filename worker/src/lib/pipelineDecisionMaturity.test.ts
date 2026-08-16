import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
  const evidenceAdapter = fs.readFileSync(path.join(process.cwd(), 'src/lib/expectedReturnMaturityEvidence.ts'), 'utf8')
  const migration = fs.readFileSync(path.join(process.cwd(), 'migrations/0098_strategy_challenger_reward_and_s12_owner_closure.sql'), 'utf8')
  const shadowMigration = fs.readFileSync(path.join(process.cwd(), 'migrations/0100_expected_return_shadow_evaluation_packets.sql'), 'utf8')
  assert.match(source, /databaseForDataDomain\(env, 'learning'\)/)
  assert.match(source, /canonical_run_heads/)
  assert.match(source, /strategy_challenger_affinity_version/)
  assert.match(source, /formal_labeler_upgrade_pending:/)
  assert.match(source, /incumbent exact-run strategy matrix \(display-only fallback\)/)
  assert.match(source, /strategy_redundancy_artifacts_v1/)
  assert.match(source, /m\.challenger_affinity_version=\?/)
  assert.match(source, /adaptExpectedReturnCandidate/)
  assert.match(source, /adaptExpectedReturnShadow/)
  assert.match(source, /ORDER BY source_run_date DESC, updated_at DESC, artifact_id DESC/)
  assert.doesNotMatch(source, /json_extract\(offline_evidence_json/)
  assert.doesNotMatch(source, /json_extract\(validation_packet_json/)
  assert.doesNotMatch(source, /selection_champion_comparison/)
  assert.match(source, /'r_multiple'/)
  assert.match(source, /historyByStage/)
  assert.match(source, /oof_applicable/)
  assert.doesNotMatch(source, /id: 's12'/)
  assert.doesNotMatch(source, /s12_tw_calibration_artifacts/)
  assert.match(source, /model_artifact_registry/)
  assert.match(source, /expected_return_shadow_evaluation_packets/)
  assert.match(source, /model_name='l4_alpha_ev' AND candidate_type='l4_alpha_ev_refresh'/)
  assert.match(source, /model_name='allocator_ev_fusion' AND candidate_type='allocator_ev_fusion_refresh'/)
  assert.match(source, /source_run_date GLOB '\?\?\?\?-\?\?-\?\?'/)
  assert.match(source, /policy_decision\s*=\s*'shadow_only'/)
  assert.match(source, /frozen_forward_quality/)
  assert.match(source, /blocker_groups: blockerGroups/)
  assert.match(source, /evidence_scopes:/)
  assert.match(source, /schema_version: 'pipeline-decision-maturity-v2'/)
  assert.match(source, /cadence: l4\?\.cadence \?\? 'unknown'/)
  assert.match(source, /role: 'candidate'/)
  assert.match(source, /date_semantic: 'candidate_cutoff'/)
  assert.match(source, /cadence: 'event-driven'/)
  assert.match(source, /role: 'serving'/)
  assert.match(source, /cadence: 'daily'/)
  assert.match(source, /role: 'monitoring'/)
  assert.match(source, /oof_unavailable_reason/)
  assert.match(source, /artifact_contract_version: evidence\.artifact_contract_version/)
  assert.match(source, /identity_valid: evidence\.identity_valid/)
  assert.doesNotMatch(source, /'NOT_EVALUATED'/)
  assert.match(source, /fusion\?\.fusion_final_comparison_reason \? null/)
  assert.match(source, /availability: fusion\?\.fusion_final_comparison_reason \? 'blocked'/)
  assert.match(source, /reason_code: fusion\?\.fusion_final_comparison_reason \?\?/)
  assert.match(evidenceAdapter, /residual_adjustment_model_not_validated/)
  assert.match(evidenceAdapter, /allocator-ev-fusion-validation-packet-v14/)
  assert.match(evidenceAdapter, /l4-alpha-ev-ridge-v5-sector-/)
  assert.match(source, /offline candidate; production pointer and frozen-forward shadow are separate evidence scopes/)
  assert.match(shadowMigration, /model candidates, serving artifacts, training inputs, or promotion evidence/)
  assert.doesNotMatch(source, /fusion_oof_max_date \?\? l4Shadow/)
  assert.doesNotMatch(source, /fusionShadow\?\.business_date \?\? fusion\?\.source_run_date/)
  assert.doesNotMatch(source, /artifact_id: fusion\?\.artifact_id \?\? candidateState/)
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
  assert.match(source, /Fusion v14 residual-adjustment candidate uses purged OOF evidence/)
  const routeStart = routes.indexOf("/api/dashboard/v4/pipeline/maturity")
  assert(routeStart >= 0)
  assert(routes.slice(routeStart, routeStart + 360).includes('requireValidToken'))
  assert(routes.slice(routeStart, routeStart + 420).includes("Cache-Control', 'no-store, max-age=0"))
})
test('shadow maturity SQL selects one deterministic successor and projects v2 identity', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/pipelineDecisionMaturity.ts'), 'utf8')
  const endMarker = '`).bind(requestedDate).all<ExpectedReturnShadowDbRow>()'
  const sqlEnd = source.indexOf(endMarker)
  const startMarker = 'safeQuery(() => learningDb.prepare(`'
  const markerStart = source.lastIndexOf(startMarker, sqlEnd)
  assert(markerStart >= 0 && sqlEnd > markerStart, 'shadow maturity SQL not found')
  const sql = source.slice(markerStart + startMarker.length, sqlEnd)
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(fs.readFileSync(path.join(process.cwd(), 'migrations/0100_expected_return_shadow_evaluation_packets.sql'), 'utf8'))
    db.exec(fs.readFileSync(path.join(process.cwd(), 'migrations/0111_expected_return_shadow_evaluation_identity_v2.sql'), 'utf8'))
    const insert = db.prepare(`INSERT INTO expected_return_shadow_evaluation_packets(
      evaluation_id, identity_schema_version, subject_artifact_checksum,
      evaluator_contract_checksum, business_date, cohort_id,
      base_manifest_checksum, extension_manifest_checksum, model_name,
      model_version, oof_min_date, oof_max_date, oof_date_count, oof_row_count,
      quality_decision, policy_decision, validation_packet_json, artifact_path,
      artifact_checksum, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const seed = (evaluationId: string, decision: string, checksum: string) => insert.run(
      evaluationId, 'expected-return-shadow-evaluation-identity-v2',
      'c'.repeat(64), 'd'.repeat(64), '2026-08-15', 'cohort-x',
      'b'.repeat(64), 'e'.repeat(64), 'l4_alpha_ev',
      'l4-alpha-ev-ridge-v5-sector-test', '2026-07-01', '2026-07-31',
      20, 200, decision, 'shadow_only', '{}', `shadow/${checksum}.json`,
      checksum, '2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z',
    )
    seed('f'.repeat(64), 'PASS', 'a'.repeat(64))
    seed('a'.repeat(64), 'FAIL', '9'.repeat(64))
    const rows = db.prepare(sql).all('2026-08-15') as Array<Record<string, unknown>>
    assert.equal(rows.length, 1)
    assert.equal(rows[0].evaluation_id, 'f'.repeat(64))
    assert.equal(rows[0].quality_decision, 'PASS')
    assert.equal(rows[0].identity_schema_version, 'expected-return-shadow-evaluation-identity-v2')
    assert.equal(rows[0].subject_artifact_checksum, 'c'.repeat(64))
    assert.equal(rows[0].evaluator_contract_checksum, 'd'.repeat(64))
  } finally {
    db.close()
  }
})
