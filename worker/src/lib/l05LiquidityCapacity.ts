export const L05_LIQUIDITY_CAPACITY_POLICY_CANONICAL_JSON = '{"schema_version":"l05-liquidity-capacity-policy-v2","owner":"l05_liquidity_capacity","window_sessions":20,"minimum_observations":3,"metric":"median_daily_traded_value_twd","aggregator":"median","threshold_source":"trading_config.screener.minDailyTurnover","selection_policy":"capacity_floor_no_topk","legacy_min_avg_volume_decision_effect":false,"maturity_impact":"none_no_reset"}' as const

export const L05_LIQUIDITY_CAPACITY_POLICY = Object.freeze(JSON.parse(
  L05_LIQUIDITY_CAPACITY_POLICY_CANONICAL_JSON,
) as {
  schema_version: 'l05-liquidity-capacity-policy-v2'
  owner: 'l05_liquidity_capacity'
  window_sessions: 20
  minimum_observations: 3
  metric: 'median_daily_traded_value_twd'
  aggregator: 'median'
  threshold_source: 'trading_config.screener.minDailyTurnover'
  selection_policy: 'capacity_floor_no_topk'
  legacy_min_avg_volume_decision_effect: false
  maturity_impact: 'none_no_reset'
})

export const L05_LIQUIDITY_CAPACITY_POLICY_CHECKSUM =
  'sha256:42f9a387d0ebf3cfb6c6d89740a7c3700feb66ade7cb4416e6d8a2fc1160dcb4' as const

export interface L05LiquidityPriceRow {
  close: number
  Trading_Volume: number
}

export interface L05LiquidityCapacityReceipt {
  policy_version: typeof L05_LIQUIDITY_CAPACITY_POLICY.schema_version
  policy_checksum: typeof L05_LIQUIDITY_CAPACITY_POLICY_CHECKSUM
  metric: typeof L05_LIQUIDITY_CAPACITY_POLICY.metric
  selection_policy: typeof L05_LIQUIDITY_CAPACITY_POLICY.selection_policy
  window_sessions: number
  observed_sessions: number
  median_daily_traded_value_twd: number | null
  mean_daily_traded_value_twd: number | null
  min_median_daily_traded_value_twd: number
  legacy_min_avg_volume_decision_effect: false
  maturity_impact: typeof L05_LIQUIDITY_CAPACITY_POLICY.maturity_impact
  passed: boolean
  reason_code: 'l05_liquidity_capacity_passed' | 'l05_liquidity_observations_insufficient' | 'median_daily_traded_value_below_min'
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const midpoint = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[midpoint]
    : (sorted[midpoint - 1] + sorted[midpoint]) / 2
}

export function evaluateL05LiquidityCapacity(
  prices: readonly L05LiquidityPriceRow[],
  minMedianDailyTradedValueTwd: number,
): L05LiquidityCapacityReceipt {
  const threshold = Number.isFinite(minMedianDailyTradedValueTwd)
    ? Math.max(0, minMedianDailyTradedValueTwd)
    : Number.POSITIVE_INFINITY
  const window = prices.slice(-L05_LIQUIDITY_CAPACITY_POLICY.window_sessions)
  const dailyTradedValues = window
    .map((row) => Number(row.close) * Number(row.Trading_Volume))
    .filter((value) => Number.isFinite(value) && value >= 0)
  const medianDailyTradedValue = median(dailyTradedValues)
  const meanDailyTradedValue = dailyTradedValues.length > 0
    ? dailyTradedValues.reduce((sum, value) => sum + value, 0) / dailyTradedValues.length
    : null
  const observationsSufficient = dailyTradedValues.length >= L05_LIQUIDITY_CAPACITY_POLICY.minimum_observations
  const passed = observationsSufficient
    && medianDailyTradedValue != null
    && medianDailyTradedValue >= threshold

  return {
    policy_version: L05_LIQUIDITY_CAPACITY_POLICY.schema_version,
    policy_checksum: L05_LIQUIDITY_CAPACITY_POLICY_CHECKSUM,
    metric: L05_LIQUIDITY_CAPACITY_POLICY.metric,
    selection_policy: L05_LIQUIDITY_CAPACITY_POLICY.selection_policy,
    window_sessions: L05_LIQUIDITY_CAPACITY_POLICY.window_sessions,
    observed_sessions: dailyTradedValues.length,
    median_daily_traded_value_twd: medianDailyTradedValue,
    mean_daily_traded_value_twd: meanDailyTradedValue,
    min_median_daily_traded_value_twd: threshold,
    legacy_min_avg_volume_decision_effect: false,
    maturity_impact: L05_LIQUIDITY_CAPACITY_POLICY.maturity_impact,
    passed,
    reason_code: !observationsSufficient
      ? 'l05_liquidity_observations_insufficient'
      : passed
        ? 'l05_liquidity_capacity_passed'
        : 'median_daily_traded_value_below_min',
  }
}
