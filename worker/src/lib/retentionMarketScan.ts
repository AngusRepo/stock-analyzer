import { recentMarketRows } from './retentionSourceProtection'

/** Discovery can inspect the full history; exact-delete checks inspect at most 250 rows. */
export function recentMarketRowsScan(table: string, key: string, count = 500): string {
  recentMarketRows(table, key, count) // Share the identifier and count validation.
  // Materialize one boundary per symbol, once per statement. The former
  // correlated OFFSET repeated up to 500 index reads for EVERY historical row,
  // including empty archive/preflight pages. Bounded delete rechecks keep the
  // original per-row predicate, avoiding a full symbol inventory per small batch.
  return `${table}.date < (
    WITH retention_market_anchors AS MATERIALIZED (
      SELECT symbols.${key}, (
        SELECT newer.date FROM ${table} newer
         WHERE newer.${key}=symbols.${key}
         ORDER BY newer.date DESC LIMIT 1 OFFSET ${count - 1}
      ) AS oldest_protected_date
      FROM (SELECT DISTINCT ${key} FROM ${table}) symbols
    )
    SELECT oldest_protected_date FROM retention_market_anchors
     WHERE retention_market_anchors.${key}=${table}.${key}
  )`
}
