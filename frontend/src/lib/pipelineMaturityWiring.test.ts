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
  assert(page.includes('dashboardV4Api.pipelineMaturity(recDate)'))
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
  for (const text of ['data.stages', 'stage.title', 'Production serving', 'Shadow learning', 'Blockers', 'Lineage']) {
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
