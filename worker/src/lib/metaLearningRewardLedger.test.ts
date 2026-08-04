import {
  buildNeuralMetaBanditTrainingPayload,
  buildLinUcbRewardLedgerRows,
  metaPolicyRewardForSourceRow,
  modelFamilyArm,
  normalizeMetaReward,
} from './metaLearningRewardLedger'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  assert(normalizeMetaReward(6.5) === 0.065, 'percent reward should be converted to decimal')
  assert(normalizeMetaReward(55) === 0.2, 'reward should be capped at upper bound')
  assert(normalizeMetaReward(-80) === -0.2, 'reward should be capped at lower bound')
  assert(normalizeMetaReward(null) == null, 'missing reward should stay missing')
}

{
  const rows = buildLinUcbRewardLedgerRows([
    {
      date: '2026-05-06',
      stock_id: '2330',
      model_name: 'XGBoost',
      market_segment: 'TWSE',
      recommendation_lane: 'tradable',
      has_buy_signal: 1,
      trade_pnl_pct: 3,
      actual_return_pct: -9,
      score_components: JSON.stringify({ alpha_bucket: 'breakout' }),
      ml_vote_summary: JSON.stringify({ ic_4w_avg: 0.08, coverage: 0.72, dispersion: { rawRankStd: 0.12 } }),
      alpha_context: JSON.stringify({ regime: 'bull', market_risk_score: 0.2, volatility: 0.18, liquidity_score: 0.8 }),
    },
    {
      date: '2026-05-06',
      stock_id: '4938',
      model_name: 'DLinear',
      market_segment: 'TWSE',
      recommendation_lane: 'tradable',
      has_buy_signal: 0,
      actual_return_pct: -1,
      score_components: JSON.stringify({ alpha_bucket: 'breakout' }),
      ml_vote_summary: JSON.stringify({ ic_4w_avg: 0.08, coverage: 0.72, dispersion: { rawRankStd: 0.12 } }),
      alpha_context: JSON.stringify({ regime: 'bull', market_risk_score: 0.2, volatility: 0.18, liquidity_score: 0.8 }),
    },
    {
      date: '2026-05-06',
      stock_id: '7584',
      model_name: 'PatchTST',
      market_segment: 'EMERGING',
      recommendation_lane: 'research',
      has_buy_signal: 1,
      actual_return_pct: 2,
      score_components: JSON.stringify({ alpha_bucket: 'defensive_accumulation' }),
    },
    {
      date: '2026-05-06',
      stock_id: '0000',
      market_segment: 'TWSE',
      recommendation_lane: 'tradable',
      has_buy_signal: 1,
      actual_return_pct: null,
    },
  ], { nowIso: '2026-05-08T00:00:00.000Z' })

  const ids = rows.map((row) => row.arm_id).sort()
  assert(ids.includes('alpha_bucket:breakout'), 'should aggregate alpha bucket arm')
  assert(ids.includes('lane:tradable'), 'should aggregate recommendation lane arm')
  assert(ids.includes('market_segment:TWSE'), 'should aggregate market segment arm')
  assert(ids.includes('signal:buy'), 'should aggregate signal arm')

  const signalBuy = rows.find((row) => row.arm_id === 'signal:buy')
  const laneTradable = rows.find((row) => row.arm_id === 'lane:tradable')
  assert(signalBuy?.samples === 2, 'signal buy should skip missing reward and keep two samples')
  assert(Math.abs((signalBuy?.reward_mean ?? 0) - 0.025) < 0.000001, 'signal buy should average normalized rewards')
  assert(laneTradable?.samples === 2, 'tradable lane should include only rows with rewards')
  assert(laneTradable?.evidence_json.includes('"reward_source":"trade_pnl_pct_or_actual_return_pct"'), 'evidence should explain reward source')
  assert(String(laneTradable?.context_hash ?? '').startsWith('meta-context-v2:'), 'ledger should use expanded context hash')
  assert(laneTradable?.evidence_json.includes('"missing_context_features"'), 'evidence should record missing expanded context features')
}

{
  const payload = buildNeuralMetaBanditTrainingPayload('NeuralUCB', [
    {
      date: '2026-05-06',
      stock_id: '2330',
      model_name: 'XGBoost',
      actual_return_pct: 1,
      direction_correct: 1,
      alpha_bucket: 'breakout',
      ml_vote_summary: JSON.stringify({ ic_4w_avg: 0.1, coverage: 0.8 }),
    },
    {
      date: '2026-05-06',
      stock_id: '4938',
      model_name: 'PatchTST',
      actual_return_pct: -2,
      direction_correct: 0,
      ml_vote_summary: JSON.stringify({ ic_4w_avg: -0.02, coverage: 0.7 }),
    },
  ], {
    businessDate: '2026-08-04',
    decisionRows: [
      { date: '2026-08-04', stock_id: '2330', model_name: 'DLinear', rank_score: 0.4 },
      { date: '2026-08-04', stock_id: '2330', model_name: 'XGBoost', rank_score: 0.9 },
      { date: '2026-08-04', stock_id: '2454', model_name: 'GNN', rank_score: 0.8 },
    ],
  })

  assert(payload.policy_id === 'NeuralUCB', 'payload should target requested policy')
  assert(payload.contexts.length === 2, 'payload should include reward-bearing rows')
  assert(payload.contexts[0].length === 12, 'payload should use expanded 12d meta context')
  assert(
    payload.arm_names.join(',') === 'tree_family,tabular_neural_family,graph_family,time_series_family,do_nothing',
    'payload should expose independently selectable model-family arms',
  )
  assert(payload.arms[0] === 0 && payload.arms[1] === 3, 'payload should map model names to independent family arms')
  assert(payload.business_date === '2026-08-04', 'decision evidence should use the current business date')
  assert(payload.decision_symbols.join(',') === '2330,2454', 'decision rows should be deduplicated by symbol')
  assert(
    payload.decision_baseline_actions.join(',') === 'tree_family,graph_family',
    'highest ranked current row should define each symbol baseline action',
  )
  assert(payload.symbols.join(',') === payload.decision_symbols.join(','), 'legacy symbols should mirror decision symbols')
}

{
  assert(modelFamilyArm('XGBoost') === 'tree_family', 'XGBoost should map to tree family')
  assert(modelFamilyArm('TabM') === 'tabular_neural_family', 'TabM should map to tabular neural family')
  assert(modelFamilyArm('GNN') === 'graph_family', 'GNN should map to graph family')
  assert(modelFamilyArm('PatchTST') === 'time_series_family', 'PatchTST should map to time-series family')
  assert(modelFamilyArm('UnknownModel') === 'do_nothing', 'unknown model should fail closed to do-nothing')

  const correct = metaPolicyRewardForSourceRow({ direction_correct: 1, actual_return_pct: -1 })
  const wrong = metaPolicyRewardForSourceRow({ direction_correct: 0, actual_return_pct: 1 })
  assert((correct ?? 0) > 0, 'direction hit should stay positive despite a small negative return')
  assert((wrong ?? 0) < 0, 'direction miss should stay negative despite a small positive return')
  assert(metaPolicyRewardForSourceRow({}) == null, 'unmatured rows must not fabricate rewards')
}

{
  const rows = buildLinUcbRewardLedgerRows([{
    date: '2026-05-06',
    stock_id: '2330',
    market_segment: 'TWSE',
    recommendation_lane: 'tradable',
    has_buy_signal: 1,
    actual_return_pct: 1,
    alpha_bucket: 'projected_bucket',
    score_components: JSON.stringify({ alpha_bucket: 'legacy_json_bucket' }),
  }])
  assert(
    rows.some((row) => row.arm_id === 'alpha_bucket:projected_bucket'),
    'scalar-projected alpha bucket must take precedence over legacy raw JSON',
  )
}
