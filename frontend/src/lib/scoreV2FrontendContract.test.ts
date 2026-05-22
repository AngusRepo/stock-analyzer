import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const viewModel = readFileSync('src/lib/scoreV2ViewModel.ts', 'utf8')
const recommendationCard = readFileSync('src/components/RecommendationCardClean.tsx', 'utf8')
const pipelinePage = readFileSync('src/pages/PipelinePage.tsx', 'utf8')
const botDashboard = readFileSync('src/pages/BotDashboard.tsx', 'utf8')
const pipelineTemplate = readFileSync('../ml-controller/templates/pipeline.md.j2', 'utf8')

const scoreBreakdownStart = recommendationCard.indexOf('function ScoreBreakdownV2')
const scoreBreakdownEnd = recommendationCard.indexOf('function AlphaContextBlock')
assert(scoreBreakdownStart >= 0 && scoreBreakdownEnd > scoreBreakdownStart, 'ScoreBreakdownV2 block should be locatable')
const scoreBreakdown = recommendationCard.slice(scoreBreakdownStart, scoreBreakdownEnd)
const scoreFormulaStart = recommendationCard.indexOf('function ScoreFormulaSummary')
assert(scoreFormulaStart >= 0 && scoreFormulaStart < scoreBreakdownStart, 'Score formula summary should be rendered before ScoreBreakdownV2')
const scoreFormula = recommendationCard.slice(scoreFormulaStart, scoreBreakdownStart)

for (const label of ['ML Edge', '籌碼流', '技術結構', '基本面', '新聞題材']) {
  assert(viewModel.includes(label), `Score V2 view model should expose readable label: ${label}`)
}

for (const label of ['趨勢結構', '波動結構', '轉折極端', '量能確認', '執行風險']) {
  assert(viewModel.includes(label), `Score V2 technical detail should expose readable label: ${label}`)
}

for (const removedProjectionRef of [
  'storage_projection',
  'buildScoreV2PayloadFromProjectedScores',
  'legacyComponents',
  'seedComponents',
  'screenerMomentum',
  'screenerMomentumSeed20',
  'rec.chip_score',
  'rec.tech_score',
  'rec.ml_score',
  'rec.momentum_score',
  'rec.score_components',
]) {
  assert(!viewModel.includes(removedProjectionRef), `Score V2 view model should not keep frontend storage projection reference: ${removedProjectionRef}`)
}
assert(
  viewModel.includes('missing_score_v2'),
  'Score V2 view model should label missing backend payloads explicitly instead of projecting legacy scores',
)

for (const text of ['基礎分數與 Alpha 調整', '基礎分數', 'Alpha 調整', '最終分數']) {
  assert(scoreFormula.includes(text), `Recommendation card formula summary should render: ${text}`)
}

for (const text of ['Score V2 分解', '技術結構 + Alpha 明細', '技術結構細項', 'Alpha 調整明細', 'item.explanation']) {
  assert(scoreBreakdown.includes(text), `Recommendation card Score V2 block should render: ${text}`)
}
assert(!scoreBreakdown.includes('基礎分數:'), 'Score V2 breakdown should not duplicate base score rows')
assert(!scoreBreakdown.includes('最終分數:'), 'Score V2 breakdown should not duplicate final score rows')

assert(!scoreBreakdown.includes('chip_score'), 'Recommendation card Score V2 block should not render legacy chip_score')
assert(!scoreBreakdown.includes('tech_score'), 'Recommendation card Score V2 block should not render legacy tech_score')
assert(!scoreBreakdown.includes('ml_score'), 'Recommendation card Score V2 block should not render legacy ml_score')
assert(!scoreBreakdown.includes('嚗'), 'Recommendation card Score V2 block should not contain mojibake punctuation')
assert(
  recommendationCard.includes('const payload = parseObject(rec.score_v2)'),
  'Recommendation card Score V2 block should accept canonical score_v2 summaries',
)
assert(
  !recommendationCard.includes('parseObject(rec.score_components)'),
  'Recommendation card must not read Score V2 details from legacy score_components',
)
for (const text of ['推薦理由 / Alpha 交易計劃', '盤勢判讀', '方案 A | 突破追價', '方案 B | 拉回低吸', '風控規則', 'Gemini 3.1 Flash', 'Breeze2']) {
  assert(scoreBreakdown.includes(text), `Recommendation card trading-plan narrative should render: ${text}`)
}
assert(
  scoreBreakdown.includes('reasonVariants?.breeze2'),
  'Breeze2 comparison should read persisted Score V2 reason variants per symbol',
)
for (const text of ['KLinePlanSketch', '策略示意', 'TradePlanRow', '項目', '判讀']) {
  assert(scoreBreakdown.includes(text), `Recommendation card trading plan should render structured rows and chart: ${text}`)
}
assert(!scoreBreakdown.includes('compactLine(reason),'), '盤勢判讀 should not repeat the raw score/reason paragraph as a row')
assert(!recommendationCard.includes('<AlphaContextBlock'), 'AlphaContextBlock should not render separately from recommendation reason')

assert(
  pipelinePage.includes('buildScoreBreakdownViewModel'),
  'pipeline page should consume Score V2 through the shared view model',
)
assert(
  pipelinePage.includes('Score V2 五構面評分'),
  'pipeline page screener copy should describe Score V2 five-dimension scoring',
)
assert(
  pipelinePage.includes("r.signal && r.signal !== 'NO_SIGNAL'"),
  'pipeline page should count ML stage by signal availability instead of legacy ml_score',
)
for (const legacyRef of [
  'rec.chip_score',
  'rec.tech_score',
  'rec.ml_score',
  'buy.chip_score',
  'buy.tech_score',
  'buy.ml_score',
  'r.ml_score',
  '籌碼 0-40',
  '技術 0-30',
  '動能 0-20',
]) {
  assert(!pipelinePage.includes(legacyRef), `pipeline page should not render legacy score reference: ${legacyRef}`)
}

assert(
  !botDashboard.includes('buildScoreV2PayloadFromProjectedScores'),
  'Bot dashboard should not project pending-buy legacy score fields on the frontend',
)
for (const legacyRef of [
  'chip_score: b.chip_score',
  'tech_score: b.tech_score',
  'ml_score: b.ml_score',
]) {
  assert(!botDashboard.includes(legacyRef), `Bot dashboard should not pass legacy pending-buy score field: ${legacyRef}`)
}
assert(
  botDashboard.includes('score_v2: b.score_v2 ?? null'),
  'Bot dashboard pending-buy cards should consume backend score_v2 payload',
)

assert(
  !pipelineTemplate.includes("selectattr('ml_score', 'defined')"),
  'pipeline template should not count ML stage by legacy ml_score column',
)
assert(
  pipelineTemplate.includes("selectattr('signal', 'defined')"),
  'pipeline template should count ML stage by signal availability',
)
