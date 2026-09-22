/** Protect live-reader anchors and unresolved execution state during cold moves. */
export function recentMarketRows(table: string, key: string, count = 500): string {
  if (!['stock_prices','technical_indicators','chip_data','margin_data'].includes(table)
      || !['stock_id','symbol'].includes(key) || !Number.isSafeInteger(count) || count < 1)
    throw new Error('retention_market_anchor_invalid')
  // Current chart/backfill readers request 500 observations, not 500 calendar days.
  // A symbol with fewer observations retains all of them, including delisted symbols.
  return `${table}.date < (SELECT newer.date FROM ${table} newer
    WHERE newer.${key}=${table}.${key} ORDER BY newer.date DESC LIMIT 1 OFFSET ${count - 1})`
}

export function fundamentalAnchorEligibility(cutoffDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDate)) throw new Error('retention_cutoff_invalid')
  // The current as-of reader consumes 180 rows. Keep that pre-window history
  // separately per source, so the first hot day retains the same source inputs.
  return `canonical_fundamental_features.as_of_date < '${cutoffDate}'
    AND canonical_fundamental_features.available_date < (
      SELECT newer.available_date FROM canonical_fundamental_features newer
      WHERE newer.stock_id=canonical_fundamental_features.stock_id
        AND newer.source=canonical_fundamental_features.source
        AND newer.available_date < '${cutoffDate}' AND newer.as_of_date < '${cutoffDate}'
      ORDER BY newer.available_date DESC LIMIT 1 OFFSET 179)`
}

const TERMINAL = "('FILLED','CANCELLED','REJECTED')"
const resolvedIntent = (intent: string) => `EXISTS (SELECT 1 FROM broker_execution_intents parent
  WHERE parent.intent_id=${intent} AND parent.status IN ${TERMINAL}
    AND NOT EXISTS (SELECT 1 FROM broker_execution_legs unresolved
      WHERE unresolved.intent_id=parent.intent_id AND unresolved.status NOT IN ${TERMINAL}))`

export const EXECUTION_EVENT_ELIGIBILITY = `
  (broker_execution_events.intent_id IS NULL OR ${resolvedIntent('broker_execution_events.intent_id')})
  AND (broker_execution_events.leg_id IS NULL OR EXISTS (
    SELECT 1 FROM broker_execution_legs leg WHERE leg.leg_id=broker_execution_events.leg_id
      AND leg.status IN ${TERMINAL} AND ${resolvedIntent('leg.intent_id')}))`
export const EXECUTION_LEG_ELIGIBILITY = `broker_execution_legs.status IN ${TERMINAL}
  AND ${resolvedIntent('broker_execution_legs.intent_id')}
  AND NOT EXISTS (SELECT 1 FROM broker_execution_events e WHERE e.leg_id=broker_execution_legs.leg_id)`
export const EXECUTION_INTENT_ELIGIBILITY = `broker_execution_intents.status IN ${TERMINAL}
  AND NOT EXISTS (SELECT 1 FROM broker_execution_legs l WHERE l.intent_id=broker_execution_intents.intent_id)
  AND NOT EXISTS (SELECT 1 FROM broker_execution_events e WHERE e.intent_id=broker_execution_intents.intent_id)`
