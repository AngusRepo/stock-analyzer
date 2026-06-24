import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const viewModel = readFileSync('src/lib/scoreV2ViewModel.ts', 'utf8')
const recommendationCard = readFileSync('src/components/RecommendationCardClean.tsx', 'utf8')
const pipelinePage = readFileSync('src/pages/PipelinePage.tsx', 'utf8')
const pipelineTemplate = readFileSync('../ml-controller/templates/pipeline.md.j2', 'utf8')

const scoreFormulaStart = recommendationCard.indexOf('function ScoreFormulaSummary')
const scoreBreakdownStart = recommendationCard.indexOf('function ScoreBreakdownV2')
const scoreBreakdownEnd = recommendationCard.indexOf('function AlphaContextBlock')
assert(scoreFormulaStart >= 0 && scoreBreakdownStart > scoreFormulaStart, 'ScoreFormulaSummary block should be locatable')
assert(scoreBreakdownStart >= 0 && scoreBreakdownEnd > scoreBreakdownStart, 'ScoreBreakdownV2 block should be locatable')

const scoreFormula = recommendationCard.slice(scoreFormulaStart, scoreBreakdownStart)
const scoreBreakdown = recommendationCard.slice(scoreBreakdownStart, scoreBreakdownEnd)
const recommendationComponentStart = recommendationCard.indexOf('export function RecommendationCardClean')
const recommendationComponent = recommendationComponentStart >= 0
  ? recommendationCard.slice(recommendationComponentStart)
  : ''

assert(!viewModel.includes('目前缺少'), 'Score V2 technical detail should not hard-code missing-info copy for zero-score rows')
assert(
  viewModel.includes('item.value > 0 ? { ...item, explanation } : item'),
  'Score V2 technical detail should only attach explanatory copy to positive evidence rows',
)

for (const label of ['ML Edge', '籌碼流', '技術結構', '基本面', '新聞題材']) {
  assert(viewModel.includes(label), `Score V2 view model should expose readable label: ${label}`)
}

for (const label of ['趨勢結構', '波動結構', '轉折極端', '量能確認', '執行風險']) {
  assert(viewModel.includes(label), `Score V2 technical detail should expose readable label: ${label}`)
}

for (const text of ['基礎分數與 Alpha 調整', '基礎分數', 'Alpha 調整', '最終分數']) {
  assert(scoreFormula.includes(text), `Recommendation card formula summary should render: ${text}`)
}

for (const text of ['Score V2 分解', '技術結構 + Alpha 明細', '技術結構細項', 'Alpha 調整明細', 'item.explanation']) {
  assert(scoreBreakdown.includes(text), `Recommendation card Score V2 block should render: ${text}`)
}

assert(!scoreBreakdown.includes('chip_score'), 'Recommendation card Score V2 block should not render legacy chip_score')
assert(!scoreBreakdown.includes('tech_score'), 'Recommendation card Score V2 block should not render legacy tech_score')
assert(!scoreBreakdown.includes('ml_score'), 'Recommendation card Score V2 block should not render legacy ml_score')
assert(!scoreBreakdown.includes('嚗'), 'Recommendation card Score V2 block should not contain mojibake punctuation')

assert(
  recommendationCard.includes('function scoreV2PayloadFromRec')
    && recommendationCard.includes('rec?.score_components')
    && recommendationCard.includes('parseObject(rec?.score_components) ?? parseObject(rec?.score_v2)'),
  'Recommendation card should consume production score_components before falling back to score_v2',
)

assert(
  recommendationCard.includes('fmtNumber(safeValue, 1)}/{fmtNumber(safeMax, 0)')
    && !recommendationCard.includes('formatUnitScore')
    && !recommendationCard.includes('formatTotalUnitScore'),
  'Recommendation card should display Score V2 points instead of normalized 0.xx ratios',
)

for (const model of ['LightGBM', 'XGBoost', 'ExtraTrees', 'TabM', 'GNN', 'DLinear', 'PatchTST', 'iTransformer']) {
  assert(recommendationCard.includes(`'${model}'`), `Recommendation card active model pool should include ${model}`)
}

for (const retiredModel of ['CatBoost', 'FT-Transformer', 'Chronos']) {
  assert(!recommendationCard.includes(`'${retiredModel}'`), `Recommendation card should not expose retired model ${retiredModel}`)
}

assert(
  recommendationCard.includes('screener_funnel_evidence'),
  'Recommendation card may receive screener funnel evidence, but flow-tracking layers must stay out of the card body',
)
assert(
  !recommendationComponent.includes('rank_topk_equal_weight'),
  'Recommendation card body must not present legacy top-k equal weight as valid allocation evidence',
)

assert(
  recommendationCard.includes('coreFamilyVoteBadgeText')
    && recommendationCard.includes('coreFamilyVote'),
  'Recommendation card should surface Layer3 core family vote evidence in the ML badge',
)

for (const text of ['推薦理由 / Alpha 交易計劃', '盤勢判讀', '風控規則', 'Alpha 規則引擎']) {
  assert(scoreBreakdown.includes(text), `Recommendation card trading-plan narrative should render: ${text}`)
}

for (const text of ['Gemini 3.5 Flash', 'Breeze2', 'ProviderReasonCompare', 'geminiTradePlan', 'breeze2TradePlan']) {
  assert(!scoreBreakdown.includes(text), `Recommendation card trading-plan narrative should not render provider shadow copy: ${text}`)
}

assert(!scoreBreakdown.includes('方案 A | 突破追價'), 'Recommendation card should not render plan A copy')
assert(!scoreBreakdown.includes('方案 B | 拉回低吸'), 'Recommendation card should not render plan B copy')

for (const text of ['偏好買入價', '建議買入區間', '可追價上限', '樂觀目標價', '前高壓力', '轉強確認', '關鍵支撐', 'ATR 防守', 'POC / 量能節點來源']) {
  assert(scoreBreakdown.includes(text), `Recommendation card should use user-facing trading-plan label: ${text}`)
}

for (const text of ['Entry Model V2 /', 'daily_proxy_fallback', 'ohlcv_trade_plan_proxy']) {
  assert(scoreBreakdown.includes(text), `Recommendation card should prefer Entry Model V2 evidence or explicitly label fallback: ${text}`)
}
for (const text of ['missing_intraday_tick_anchor', 'missing_entry_model_v2_anchor']) {
  assert(!scoreBreakdown.includes(text), `Recommendation card should not expose stale missing-anchor fallback token: ${text}`)
}
assert(
  recommendationCard.includes("'missing_' + 'intraday_tick_anchor'") &&
    recommendationCard.includes("'missing_' + 'entry_model_v2_anchor'") &&
    recommendationCard.includes("anchorSource = cleanEntryModelToken(extractTokenValue(point, 'source')) ?? 'daily_proxy_fallback'"),
  'Recommendation card should sanitize stale missing-anchor tokens into the daily proxy fallback',
)

for (const tag of [
  '<UniverseFeatureEvidenceBlock',
  '<HardGateEvidenceBlock',
  '<StrategyLabelerEvidenceBlock',
  '<StrategyPortfolioIntelligenceBlock',
  '<StrategyRouterEvidenceBlock',
  '<MlStackEvidenceBlock',
  '<EvidenceFusionBlock',
  '<SparseAllocationBlock',
]) {
  assert(!recommendationComponent.includes(tag), `Recommendation card body should not render flow-tracking block: ${tag}`)
}

for (const text of ['OHLCV volume proxy', 'Alpha proxy']) {
  assert(!scoreBreakdown.includes(text), `Recommendation card must not present proxy volume nodes as true POC evidence: ${text}`)
}

for (const text of ['entryModelV2FromWatchPoints', 'entry_price_model_v2:']) {
  assert(recommendationCard.includes(text), `Recommendation card should parse Entry Model V2 evidence: ${text}`)
}

for (const text of ['KLinePlanSketch', 'K線交易計劃圖', 'Lightweight Charts', 'createChart', 'CandlestickSeries', 'TradePlanRow', 'ATR 防守']) {
  assert(scoreBreakdown.includes(text), `Recommendation card trading plan should render structured rows and chart: ${text}`)
}

for (const text of ['isRawDebugWatchPoint', 'market_segment:', 'chip_source=', 'broker_net_(?:amount|shares)_5d']) {
  assert(recommendationCard.includes(text), `Recommendation card should filter raw debug watch point: ${text}`)
}

assert(!scoreBreakdown.includes('compactLine(reason),'), '盤勢判讀 should not repeat the raw score/reason paragraph as a row')
assert(!scoreBreakdown.includes('項目：'), 'Trade plan rows should not render label/value as prose prefixes')
assert(!scoreBreakdown.includes('判讀：'), 'Trade plan rows should keep item note as a structured column, not duplicated prose')
assert(!recommendationCard.includes('<AlphaContextBlock'), 'AlphaContextBlock should not render separately from recommendation reason')

assert(
  pipelinePage.includes('buildScoreBreakdownViewModel'),
  'pipeline page should consume Score V2 through the shared view model',
)
for (const text of [
  'function LayerTracePanel',
  'function layerTraceRowsFromRec',
  'L0-L4 / screener_funnel_evidence',
  'layer0_universe_features',
  'layer2_timesfm_enrichment',
  'layer3_8ml_formal',
  'layer4_sparse_allocation',
]) {
  assert(pipelinePage.includes(text), `pipeline page should render flow-tracking layer evidence: ${text}`)
}
assert(
  pipelineTemplate.includes('Score V2 canonical view')
    && pipelineTemplate.includes('score_v2_final_score')
    && pipelineTemplate.includes("selectattr('signal', 'defined')"),
  'pipeline template should render Score V2 canonical scores and count ML stage by signal availability',
)
