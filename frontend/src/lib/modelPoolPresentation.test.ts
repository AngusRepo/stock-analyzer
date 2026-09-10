import assert from 'node:assert/strict'
import { ensembleQualificationPresentation, modelPoolHealth, modelMembership, presentationTime } from './modelPoolPresentation.ts'
import type { ModelChampionPointersResponse } from './api'

const names = ['TabM', 'GNN', 'DLinear', 'PatchTST', 'iTransformer']
const base = Object.fromEntries(names.map(name => [name, { artifact_id: name + ':v1', version: 'v1', checksum: 'sha256:x' }]))
const pointers = {
  ready_count: 5, model_count: 8,
  active8_bundle: { status: 'production', production_effect: true, selected_models: names, base_artifacts: base, blockers: [] },
  models: Object.fromEntries([
    ...names.map(name => [name, { readiness: 'v5_serving', serving_artifact_id: name + ':v1', serving_version: 'v1', serving_checksum: 'sha256:x' }]),
    ...['LightGBM', 'XGBoost', 'ExtraTrees'].map(name => [name, { readiness: 'evidence_only_no_action' }]),
  ]),
} as unknown as ModelChampionPointersResponse
assert.equal(modelPoolHealth(pointers).tone, 'ok')
assert.equal(modelPoolHealth(pointers).selected.length, 5)
assert.equal(modelPoolHealth(pointers).ready, 5)
assert.equal(modelMembership('ExtraTrees', pointers), 'not_selected')
assert.deepEqual(modelPoolHealth(pointers).blockers, [])
assert.equal(modelPoolHealth(undefined).tone, 'neutral')
assert.equal(modelMembership('TabM', undefined), 'unknown')
const wrong = structuredClone(pointers)
wrong.models.TabM.serving_checksum = 'sha256:wrong'
assert.equal(modelPoolHealth(wrong).tone, 'error')
assert.equal(modelPoolHealth(wrong).ready, 4)
assert.ok(!modelPoolHealth(wrong).readyModels.includes('TabM'))
assert.ok(modelPoolHealth(wrong).readyModels.includes('GNN'))
assert.ok(modelPoolHealth(wrong).blockers.some(x => x.startsWith('TabM:')))
const missing = structuredClone(pointers)
delete missing.models.TabM
assert.equal(modelPoolHealth(missing).tone, 'error')
const noBundle = structuredClone(pointers)
noBundle.active8_bundle.production_effect = false
assert.notEqual(modelPoolHealth(noBundle).tone, 'ok')
assert.equal(modelMembership('ExtraTrees', noBundle), 'unknown')
const failed = structuredClone(pointers)
failed.active8_bundle.blockers = ['failed_quality_gate']
assert.equal(modelPoolHealth(failed).tone, 'error')
const duplicate = structuredClone(pointers)
duplicate.active8_bundle.selected_models.push('TabM')
assert.equal(modelPoolHealth(duplicate).tone, 'error')
assert.equal(presentationTime(null), '尚未取得')
assert.equal(presentationTime('bad date'), '日期未知')
console.log('modelPoolPresentation: OK')

const qualifiedRanking = structuredClone(pointers)
qualifiedRanking.active8_bundle.qualifications = {
  schema_version: 'active8-ensemble-qualifications-v1', promotion_scope: 'ranking',
  ranking: { decision: 'PASS', blockers: [] },
  calibration: { decision: 'PASS', scope: 'prediction_interval_coverage', probability_status: 'diagnostic_only', blockers: [] },
  directional: { decision: 'BLOCKED', allowed_signals: [], signals: Object.fromEntries(
    ['BUY', 'STRONG_BUY', 'SELL', 'STRONG_SELL'].map(signal => [signal, {
      decision: 'BLOCKED', blockers: ['signal_unreachable'], reachable: false, rows: 0, dates: 0,
    }])) },
}
assert.equal(modelPoolHealth(qualifiedRanking).tone, 'ok', 'directional block must not downgrade serving fleet health')
assert.equal(modelPoolHealth(qualifiedRanking).ready, 5)
const separate = ensembleQualificationPresentation(qualifiedRanking)
assert.equal(separate.ranking, '排名資格通過')
assert.equal(separate.direction, '方向訊號資格受阻')
assert.ok(separate.detail.includes('預測與排名仍可服務'))
assert.equal(ensembleQualificationPresentation(pointers).direction, '訊號資格待確認')
