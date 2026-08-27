import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(process.cwd(), 'src')
const page = fs.readFileSync(path.join(root, 'pages/PipelinePage.tsx'), 'utf8')
const panel = fs.readFileSync(path.join(root, 'components/PipelineMaturityContribution.tsx'), 'utf8')
const api = fs.readFileSync(path.join(root, 'lib/api.ts'), 'utf8')
const contract = fs.readFileSync(path.join(root, 'lib/pipelineMaturityContract.ts'), 'utf8')

test('Pipeline page renders maturity evidence after the daily flow', () => {
  assert(page.includes('dashboardV4Api.pipelineMaturity(today)'))
  assert(!page.includes('dashboardV4Api.pipelineMaturity(recDate)'))
  assert(page.includes('<PipelineMaturityContribution'))
  assert(page.indexOf('<PipelineMaturityContribution') > page.indexOf('<ExecutionFlowColumn'))
  assert(!page.includes('RecommendationSummaryColumn'))
  assert(!page.includes('title="今日推薦股票"'))
  assert(panel.includes('grid items-start gap-3 p-4 lg:grid-cols-2'))
  assert(api.includes('/dashboard/v4/pipeline/maturity'))
})

test('maturity panel exposes independent maturity owners without pretending to be the full runtime chain', () => {
  for (const stage of [
    'threshold_margin_affinity_v2', 'oof_redundancy', 'route_score_v2',
    'l4', 'fusion',
  ]) {
    assert(contract.includes(`'${stage}'`), `missing maturity owner contract: ${stage}`)
  }
  for (const text of ['data.stages', 'stage.title', '正式服務中', '影子學習', '尚未通過的必要條件', '資料來源與版本 lineage']) {
    assert(panel.includes(text), `missing maturity UI contract: ${text}`)
  }
  assert(panel.includes('progress?.complete'))
  assert(panel.includes("stage.status === 'failed_quality'"))
  assert(!contract.includes("'s12'"), 'retired S12 serving must not return as a maturity owner')
  assert(panel.includes('本區只列需要獨立成熟度門檻的 owner'))
  assert(panel.includes('L1.5 → L2 → L3 → L4'))
  assert(panel.includes('L3.5 只保留 observe-only conflict telemetry，不是 serving gate'))
  assert(page.includes("title: 'L1.5 ↔ L3 Conflict Audit'"))
  assert(page.includes('telemetry only, never a serving gate'))
})

test('maturity lineage labels cadence, role, availability, and comparable contract explicitly', () => {
  assert(contract.includes("schema_version: 'pipeline-decision-maturity-v2'"))
  for (const field of ['cadence', 'role', 'date_semantic', 'availability', 'reason_code']) {
    assert(contract.includes(field), `missing maturity evidence scope field: ${field}`)
  }
  for (const label of [
    '資料截止日',
    '成熟結果已知截至',
    'OOF 訊號截止日',
    '固定樣本監控業務日',
    '目前正式服務中的產物（Production pointer）',
    '${evidenceScopes.offline_candidate.cadence} 升級候選（尚未正式服務）',
    '每日固定樣本 forward 監控證據（不影響正式結果）',
    'First comparable',
  ]) {
    assert(panel.includes(label), `missing explicit maturity label: ${label}`)
  }
  assert(!panel.includes("return metric.note ? 'Pending' : 'Unavailable'"))
  assert(panel.includes("metric.availability === 'pending'"))
  assert(panel.includes('point.artifact_contract_version === latestHistory?.artifact_contract_version'))
  assert(panel.includes('Current evidence unavailable or identity-blocked'))
  assert(panel.includes('正式升級門檻（只約束 promotion candidate）'))
  assert(panel.includes('資料生命週期與下一批候選 readiness'))
  assert(panel.includes('Frozen-forward 監控（comparison-only）'))
  assert(panel.includes('診斷與不適用欄位（非必要門檻）'))
  assert(panel.includes('此範圍證據被 lineage 擋住'))
  assert(panel.includes("item.scope === 'promotion_gate'"))
  assert(contract.includes("'promotion_gate' | 'lifecycle' | 'monitoring' | 'diagnostic' | 'production'"))
  for (const field of [
    "data_cutoff_date", "mature_outcome_max_date", "oof_max_date", "frozen_forward_business_date",
  ]) {
    assert(contract.includes(field), "missing four-date lineage field: " + field)
  }
  assert(contract.includes("maturity_projection"))
  assert(panel.includes("最佳情境達 11 日"))
  assert(panel.includes("每一日仍須完整 V5 carrier、T+5 outcome、canonical identity 與 re-audit 全部通過"))
})
