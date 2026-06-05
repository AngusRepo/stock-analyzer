import { summarizeScreenerFunnelRows } from './screenerFunnelEvidence'

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const summaries = summarizeScreenerFunnelRows([
    {
      symbol: '2330',
      stage: 'scoring',
      decision: 'pass',
      reason_code: 'base_score_computed',
      score_after: 72,
      evidence: JSON.stringify({ chip_score: 34, tech_score: 21, momentum_score: 17 }),
    },
    {
      symbol: '2330',
      stage: 'layer1_strategy_breadth_gate',
      decision: 'pass',
      reason_code: 'selected_by_strategy_pool',
      rank: 18,
      score_after: 72,
      evidence: JSON.stringify({ strategy_ids: ['trend_breakout'], selection_order: 'full_feature_enriched_universe_strategy_only_with_raw_signal_observe' }),
    },
    {
      symbol: '2330',
      stage: 'layer2_coarse_ml_gate',
      decision: 'pass',
      reason_code: 'coarse_ml_queue_seed_from_layer1_breadth',
      rank: 6,
      score_after: 72,
      evidence: JSON.stringify({ coarse_ml_queue_size: 80, core_ml_shortlist_size: 35 }),
    },
    {
      symbol: '2330',
      stage: 'rrg_overlay',
      decision: 'observe',
      reason_code: 'rrg_overlay_leading_confirmed',
      score_before: 72,
      score_after: 75,
      evidence: JSON.stringify({ tag: 'AI', quadrant: 'Leading', adjustment: 3 }),
    },
    {
      symbol: '2330',
      stage: 'buzz_evidence',
      decision: 'observe',
      reason_code: 'weighted_keyword_evidence',
      score_before: 75,
      score_after: 77,
      evidence: JSON.stringify({ concept: 'AI', sourceStrength: 1.8, buzzBonus: 2 }),
    },
    {
      symbol: '2330',
      stage: 'diversity_cooldown',
      decision: 'observe',
      reason_code: 'high_frequency_cooldown',
      score_before: 77,
      score_after: 71,
      evidence: JSON.stringify({ freq20d: 14, highFreqPenalty: 6 }),
    },
    {
      symbol: '2330',
      stage: 'final_selection',
      decision: 'selected',
      reason_code: 'selected_for_ml_shortlist',
      rank: 4,
      score_after: 71,
      evidence: JSON.stringify({ industry: '半導體', strategy_tags: ['breakout'] }),
    },
  ])

  const summary = summaries.get('2330')
  assert(summary?.rank === 4, 'final selection rank must be preserved')
  assert(summary?.reason_code === 'selected_for_ml_shortlist', 'final reason must be preserved')
  assert(summary?.timeline.length === 7, 'timeline must retain all screener stages')
  assert((summary?.evidence.layer1_breadth as any)?.rank === 18, 'Layer1 breadth evidence must be summarized')
  assert((summary?.evidence.layer2_coarse_ml as any)?.coarse_ml_queue_size === 80, 'Layer2 coarse ML evidence must be summarized')
  assert((summary?.evidence.rrg_overlay as any)?.quadrant === 'Leading', 'RRG overlay evidence must be summarized')
  assert((summary?.evidence.buzz_evidence as any)?.concept === 'AI', 'buzz evidence must be summarized')
  assert(Array.isArray(summary?.evidence.diversity_cooldown), 'diversity/cooldown evidence must be summarized')
  assert(Array.isArray(summary?.evidence.decision_path), 'decision path must be UI-readable')
}

{
  const summaries = summarizeScreenerFunnelRows([
    {
      symbol: '1215',
      stage: 'layer1_strategy_breadth_gate',
      decision: 'pass',
      reason_code: 'selected_by_raw_factor_strategy',
      rank: 44,
      score_after: 62,
      evidence: JSON.stringify({ strategy_ids: ['raw_chip_accumulation'] }),
    },
    {
      symbol: '1215',
      stage: 'l1_candidate_seed_after_overlay',
      decision: 'selected',
      reason_code: 'selected_for_l1_breadth_seed',
      rank: 37,
      score_after: 61,
      evidence: JSON.stringify({
        semantic_stage: 'l1_candidate_seed_after_overlay',
        legacy_alias_stage: 'final_selection',
        strategy_pool_ids: ['raw_chip_accumulation'],
      }),
    },
  ])

  const summary = summaries.get('1215')
  assert(summary?.rank === 37, 'L1 candidate seed alias rank must be preserved without legacy final_selection rows')
  assert(summary?.reason_code === 'selected_for_l1_breadth_seed', 'L1 candidate seed alias reason must be preserved')
  assert(summary?.evidence.semantic_stage === 'l1_candidate_seed_after_overlay', 'summary evidence must expose semantic L1 seed stage')
  assert(Array.isArray(summary?.evidence.strategy_ids), 'semantic L1 seed strategy ids must be exposed')
}
