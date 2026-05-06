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
  assert(summary?.timeline.length === 5, 'timeline must retain all screener stages')
  assert((summary?.evidence.rrg_overlay as any)?.quadrant === 'Leading', 'RRG overlay evidence must be summarized')
  assert((summary?.evidence.buzz_evidence as any)?.concept === 'AI', 'buzz evidence must be summarized')
  assert(Array.isArray(summary?.evidence.diversity_cooldown), 'diversity/cooldown evidence must be summarized')
  assert(Array.isArray(summary?.evidence.decision_path), 'decision path must be UI-readable')
}
