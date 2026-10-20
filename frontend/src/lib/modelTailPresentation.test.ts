import assert from 'node:assert/strict'
import { modelTailPresentation } from './modelPoolPresentation.ts'

const original = { decision: 'PASS', serving_disposition: 'DEGRADED', folds: 7, oos_ic_mean: 0.1,
  fold_metrics: [{ oos_ic: 0.2 }, { oos_ic: -0.1 }], warning_gates: ['cpcv_tail_oos_ic_uncertain'],
  tail_fold_stats: { tail_oos_ic_mean: -0.01, upper_confidence_bound: 0.02 } }
const copy = JSON.stringify(original)
const degraded = modelTailPresentation(original)
assert.equal(degraded.tone, 'warn')
assert.equal(degraded.label, '通過・有警告')
assert.ok(degraded.detail.includes('末折 -0.100'))
assert.ok(degraded.detail.includes('日期群聚上界 0.020'))
assert.ok(degraded.detail.includes('cpcv_tail_oos_ic_uncertain'))
assert.equal(JSON.stringify(original), copy)

const review = { ...original, status: 'reviewed', decision: 'FAIL', serving_disposition: 'FAIL', failed_gates: ['cpcv_tail_oos_ic'] }
const failed = modelTailPresentation(original, review)
assert.equal(failed.tone, 'error')
assert.ok(failed.detail.includes('原始收據：DEGRADED'))
assert.ok(failed.detail.includes('現行尾折規則覆核：FAIL'))
assert.equal(modelTailPresentation(original, { status: 'evidence_missing' }).label, '待補尾折證據')
assert.ok(modelTailPresentation({ decision: 'PASS', folds: 7 }).detail.includes('上界 缺資料'))
console.log('modelTailPresentation tests passed')
