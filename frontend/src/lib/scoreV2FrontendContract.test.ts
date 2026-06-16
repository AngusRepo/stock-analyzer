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

for (const model of ['LightGBM', 'XGBoost', 'ExtraTrees', 'TabM', 'GNN', 'DLinear', 'PatchTST', 'iTransformer', 'TimesFM']) {
  assert(recommendationCard.includes(`'${model}'`), `Recommendation card active model pool should include ${model}`)
}

for (const retiredModel of ['CatBoost', 'FT-Transformer', 'Chronos']) {
  assert(!recommendationCard.includes(`'${retiredModel}'`), `Recommendation card should not expose retired model ${retiredModel}`)
}

assert(
  recommendationCard.includes('function SparseAllocationBlock')
    && recommendationCard.includes('sparseAllocationFromRec')
    && recommendationCard.includes('rec?.l4_sparse_allocation')
    && recommendationCard.includes('layer4_sparse_allocation')
    && recommendationCard.includes('rec?.alpha_allocation'),
  'Recommendation card should surface L4 sparse allocation evidence from the API summary, funnel evidence, or persisted alpha_allocation',
)
for (const text of [
  'L4 Sparse Allocation',
  'final owner, no top-k fallback',
  'sparse_tangent_inverse_risk_final_allocation',
  'post_l3_5_evidence_fusion_candidates',
  'positive_expected_edge_sparse_weights_no_forced_fill',
  'maximum capacity, no forced fill',
  'max capacity not target',
  'no hard minimum fill',
  'empty portfolio allowed',
  'zero selection allowed',
  'legacy top-k fallback off',
  'l3_5_flags_conflict_l4_decides_weight_not_drop',
]) {
  assert(scoreBreakdown.includes(text), `Recommendation card L4 block should render: ${text}`)
}
assert(
  recommendationCard.includes("allocation.engine ?? '').trim() !== 'sparse_tangent_inverse_risk'"),
  'Recommendation card should reject non-sparse allocation engines',
)
assert(
  !scoreBreakdown.includes('rank_topk_equal_weight'),
  'Recommendation card L4 block must not present legacy top-k equal weight as valid allocation evidence',
)

assert(
  recommendationCard.includes('function StrategyRouterEvidenceBlock')
    && recommendationCard.includes('strategyRouterEvidenceFromRec')
    && recommendationCard.includes('layer15_multi_strategy_router')
    && recommendationCard.includes('function EvidenceFusionBlock')
    && recommendationCard.includes('layer35EvidenceFromRec')
    && recommendationCard.includes('layer35_evidence_fusion'),
  'Recommendation card should surface separate L1.5 strategy router and L3.5 evidence fusion blocks from screener funnel evidence',
)
assert(
  recommendationCard.includes('function HardGateEvidenceBlock')
    && recommendationCard.includes('hardGateFromRec')
    && recommendationCard.includes('l05_hard_gate')
    && recommendationCard.includes('layer05_hard_gate'),
  'Recommendation card should surface L0.5 hard gate evidence from API or screener funnel evidence',
)
assert(
  recommendationCard.includes('function UniverseFeatureEvidenceBlock')
    && recommendationCard.includes('universeFeaturesFromRec')
    && recommendationCard.includes('layer0_universe_features'),
  'Recommendation card should surface L0 universe/features evidence from screener funnel evidence',
)
assert(
  recommendationCard.includes('function StrategyLabelerEvidenceBlock')
    && recommendationCard.includes('strategyLabelerEvidenceFromRec')
    && recommendationCard.includes('layer1_strategy_labeler'),
  'Recommendation card should surface L1 strategy labeler evidence from screener funnel evidence',
)
assert(
  recommendationCard.includes('function StrategyPortfolioIntelligenceBlock')
    && recommendationCard.includes('strategyPortfolioIntelligenceFromRec')
    && recommendationCard.includes('layer125_finlab_portfolio_intelligence'),
  'Recommendation card should surface L1.25 FinLab portfolio intelligence evidence from screener funnel evidence',
)
for (const text of [
  'L0 Universe / Features',
  'feature coverage, not top-k',
  'feature_materialization_only_not_selector',
  'no_topk_no_shrink',
  'source count',
  'feature groups',
]) {
  assert(scoreBreakdown.includes(text), `Recommendation card universe/features block should render: ${text}`)
}
for (const text of [
  'L1 Strategy Labeler',
  'labels strategy views, not stock selector',
  'label_all_candidates_not_selector',
  'no_topk_no_shrink_no_minimum_fill',
  'strategy_affinity_family_affinity_weak_labels',
  'layer15_multi_strategy_ple_router',
  'max affinity',
  'max overlap',
]) {
  assert(scoreBreakdown.includes(text), `Recommendation card strategy labeler block should render: ${text}`)
}
for (const text of [
  'L1.25 FinLab Portfolio Intelligence',
  'strategy-as-asset weights, not stock selector',
  'strategy_asset_weighting_not_stock_selector',
  'no_stock_shrink_no_topk_no_minimum_fill',
  'strategy_prior_family_prior_reliability_crowding_diversification',
  'finlab_style_strategy_as_asset_portfolio_metrics',
  'strategy prior',
  'holding overlap',
]) {
  assert(scoreBreakdown.includes(text), `Recommendation card portfolio intelligence block should render: ${text}`)
}
for (const text of [
  'L0.5 Hard Gate',
  'tradeability / data trust, not alpha ranker',
  'exclude_untradable_or_untrusted_only_not_alpha_ranker',
  'tradeability_data_trust_pending_buy',
  'pending buy',
]) {
  assert(scoreBreakdown.includes(text), `Recommendation card hard gate block should render: ${text}`)
}
assert(
  recommendationCard.includes('function MlStackEvidenceBlock')
    && recommendationCard.includes('mlStackEvidenceFromRec')
    && recommendationCard.includes('layer2_3ml_coarse')
    && recommendationCard.includes('layer3_6ml_formal'),
  'Recommendation card should surface L2 3ML coarse and L3 6ML formal evidence from screener funnel evidence',
)
for (const text of [
  'L2/L3 9ML Stack',
  'L2 3ML coarse + L3 6ML formal, not top-k',
  'three_ml_coarse_screen_not_final_ranker',
  'six_ml_formal_family_vote_not_topk',
  'LightGBM / XGBoost / ExtraTrees',
  'TabM / GNN / DLinear / PatchTST / iTransformer / TimesFM',
]) {
  assert(scoreBreakdown.includes(text), `Recommendation card ML stack block should render: ${text}`)
}
for (const text of [
  'L1.5 PLE/Listwise Router',
  'diversified ML slate, no forced fill',
  'multi_strategy_ple_listwise_distillation_router',
  'full_candidate_slate_to_diversified_ml_slate',
  'quality_floor_max_capacity_no_forced_fill',
  'candidate_route_score_ml_slate_eligibility_family_exposure_diversity_risk_uncertainty',
  'strategy_priors_future_reward_risk_diversity_9ml_teacher_labels',
  'max_only_no_minimum_no_topup',
  'formal L2',
  'teacher labels',
  'teacher align',
  'formal_ml_slate_no_minimum_fill',
  'research_observe_only_never_formal_l2',
  'L3.5 Evidence Fusion',
  'strategy_router_vs_9ml_formal_family_evidence_calibration',
  'layer15_route_score_layer3_formal_family_score_uncertainty_active_family_count',
  'observe_only_no_hard_shrink',
  'no_candidate_drop_no_topk_no_minimum_fill',
  'layer4_sparse_allocation',
  'hard shrink',
  'final allocator',
]) {
  assert(scoreBreakdown.includes(text), `Recommendation card L1.5/L3.5 block should render: ${text}`)
}
assert(
  recommendationCard.includes("['conflict_level_strategy', 'ml', 'score_gap_supportive_or_conflicted_evidence'].join('_')"),
  'Recommendation card L3.5 block should render conflict-level strategy/ML score-gap output scope without reintroducing legacy ml_score literals',
)

assert(
  recommendationCard.includes('coreFamilyVoteBadgeText')
    && recommendationCard.includes('coreFamilyVote'),
  'Recommendation card should surface Layer3 core family vote evidence in the ML badge',
)

for (const text of ['推薦理由 / Alpha 交易計劃', '盤勢判讀', '風控規則', 'Gemini 3.5 Flash', 'Breeze2', 'Alpha 規則引擎']) {
  assert(scoreBreakdown.includes(text), `Recommendation card trading-plan narrative should render: ${text}`)
}

for (const text of ['reasonVariantTradePlan', 'tradePlanLinesFromValue', 'geminiTradePlan', 'breeze2TradePlan', 'tradePlan']) {
  assert(recommendationCard.includes(text), `Recommendation card should render independent provider trade plans: ${text}`)
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
assert(
  pipelineTemplate.includes('Score V2 canonical view')
    && pipelineTemplate.includes('score_v2_final_score')
    && pipelineTemplate.includes("selectattr('signal', 'defined')"),
  'pipeline template should render Score V2 canonical scores and count ML stage by signal availability',
)
