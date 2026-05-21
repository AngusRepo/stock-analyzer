import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const viewModel = readFileSync('src/lib/scoreV2ViewModel.ts', 'utf8')
const recommendationCard = readFileSync('src/components/RecommendationCardClean.tsx', 'utf8')
const pipelineTemplate = readFileSync('../ml-controller/templates/pipeline.md.j2', 'utf8')

const scoreBreakdownStart = recommendationCard.indexOf('function ScoreBreakdownV2')
const scoreBreakdownEnd = recommendationCard.indexOf('function AlphaContextBlock')
assert(scoreBreakdownStart >= 0 && scoreBreakdownEnd > scoreBreakdownStart, 'ScoreBreakdownV2 block should be locatable')
const scoreBreakdown = recommendationCard.slice(scoreBreakdownStart, scoreBreakdownEnd)

for (const label of ['ML Edge', '籌碼流', '技術結構', '基本面', '新聞題材']) {
  assert(viewModel.includes(label), `Score V2 view model should expose readable label: ${label}`)
}

for (const label of ['趨勢結構', '波動結構', '轉折極端', '量能確認', '執行風險']) {
  assert(viewModel.includes(label), `Score V2 technical detail should expose readable label: ${label}`)
}

for (const text of ['Score V2 分解', '基礎分數', 'Alpha 調整', '技術結構細項', 'Alpha 調整明細', 'score_components']) {
  assert(scoreBreakdown.includes(text), `Recommendation card Score V2 block should render: ${text}`)
}

assert(!scoreBreakdown.includes('chip_score'), 'Recommendation card Score V2 block should not render legacy chip_score')
assert(!scoreBreakdown.includes('tech_score'), 'Recommendation card Score V2 block should not render legacy tech_score')
assert(!scoreBreakdown.includes('ml_score'), 'Recommendation card Score V2 block should not render legacy ml_score')
assert(!scoreBreakdown.includes('嚗'), 'Recommendation card Score V2 block should not contain mojibake punctuation')

assert(
  !pipelineTemplate.includes("selectattr('ml_score', 'defined')"),
  'pipeline template should not count ML stage by legacy ml_score column',
)
assert(
  pipelineTemplate.includes("selectattr('signal', 'defined')"),
  'pipeline template should count ML stage by signal availability',
)
