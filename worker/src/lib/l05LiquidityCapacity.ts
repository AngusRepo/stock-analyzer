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

/**
 * Compact L0.5 receipt carried on the always-persisted `scoring` funnel item.
 * The `universe` stage is non-critical and the D1 persistence cap truncates it,
 * so the capacity result must also travel on a row that is never dropped.
 * Policy constants are recovered from the checksum on read.
 */
export interface L05LiquidityCapacityCompactReceipt {
  policy_checksum: string
  observed_sessions: number
  median_daily_traded_value_twd: number | null
  mean_daily_traded_value_twd: number | null
  min_median_daily_traded_value_twd: number
  passed: boolean
}

function roundedTwdOrNull(value: number | null): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.round(value)
}

export function compactL05LiquidityCapacityReceipt(
  receipt: L05LiquidityCapacityReceipt,
): L05LiquidityCapacityCompactReceipt {
  return {
    policy_checksum: receipt.policy_checksum,
    observed_sessions: receipt.observed_sessions,
    median_daily_traded_value_twd: roundedTwdOrNull(receipt.median_daily_traded_value_twd),
    mean_daily_traded_value_twd: roundedTwdOrNull(receipt.mean_daily_traded_value_twd),
    min_median_daily_traded_value_twd: receipt.min_median_daily_traded_value_twd,
    passed: receipt.passed,
  }
}

export interface L05LiquidityCapacityEvidenceView {
  policy_version: string | null
  policy_checksum: string | null
  metric: string | null
  window_sessions: number | null
  observed_sessions: number | null
  median_daily_traded_value_twd: number | null
  mean_daily_traded_value_twd: number | null
  min_median_daily_traded_value_twd: number | null
  maturity_impact: string | null
  passed: boolean
}

function finiteOrNullValue(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Malformed or absent receipts return null (unknown), never a failed gate. */
export function expandL05LiquidityCapacityCompactReceipt(raw: unknown): L05LiquidityCapacityEvidenceView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (typeof record.passed !== 'boolean') return null
  const checksum = typeof record.policy_checksum === 'string' && record.policy_checksum.trim()
    ? record.policy_checksum.trim()
    : null
  const knownPolicy = checksum === L05_LIQUIDITY_CAPACITY_POLICY_CHECKSUM
  return {
    policy_version: knownPolicy ? L05_LIQUIDITY_CAPACITY_POLICY.schema_version : null,
    policy_checksum: checksum,
    metric: knownPolicy ? L05_LIQUIDITY_CAPACITY_POLICY.metric : null,
    window_sessions: knownPolicy ? L05_LIQUIDITY_CAPACITY_POLICY.window_sessions : null,
    observed_sessions: finiteOrNullValue(record.observed_sessions),
    median_daily_traded_value_twd: finiteOrNullValue(record.median_daily_traded_value_twd),
    mean_daily_traded_value_twd: finiteOrNullValue(record.mean_daily_traded_value_twd),
    min_median_daily_traded_value_twd: finiteOrNullValue(record.min_median_daily_traded_value_twd),
    maturity_impact: knownPolicy ? L05_LIQUIDITY_CAPACITY_POLICY.maturity_impact : null,
    passed: record.passed,
  }
}
