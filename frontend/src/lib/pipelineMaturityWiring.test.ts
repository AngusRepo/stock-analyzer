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
  assert(page.indexOf('<PipelineMaturityContribution') > page.indexOf('<RecommendationSummaryColumn'))
  assert(api.includes('/dashboard/v4/pipeline/maturity'))
})

test('maturity panel exposes all six decision owners and separates volume from quality', () => {
  for (const stage of [
    'threshold_margin_affinity_v2', 'oof_redundancy', 'route_score_v2',
    's12', 'l4', 'fusion',
  ]) {
    assert(contract.includes(`'${stage}'`), `missing maturity owner contract: ${stage}`)
  }
  for (const text of ['data.stages', 'stage.title', 'Production serving', 'Shadow learning', 'Blockers', 'Lineage']) {
    assert(panel.includes(text), `missing maturity UI contract: ${text}`)
  }
  assert(panel.includes('progress?.complete'))
  assert(panel.includes("stage.status === 'failed_quality'"))
})
