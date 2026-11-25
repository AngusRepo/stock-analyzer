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

/**
 * Archive-only page predicate. Together with the exclusive date bound from
 * `recentMarketRowsArchiveDateBound` it selects exactly the rows of
 * `recentMarketRows`. These tables are UNIQUE(key, date), so a key's `count`
 * newest rows span `count` distinct dates and no key's anchor is newer than
 * the global `count`-th newest date G; nothing at or after G is archivable.
 * The page query folds G into its cutoff as one bound, date < min(cutoff, G),
 * so its date index range ends at G (two separate upper bounds let the planner
 * keep only the cutoff and walk every protected row up to it). Below G, a row
 * is protected only if its key has fewer than `count` rows or the row is
 * at/after the key's anchor; those rows are collected once per statement
 * (per-key skip-scan and anchor seek, then an index range from the anchor to
 * G) into an uncorrelated rowid NOT IN, which SQLite always probes through an
 * index (rowids are never NULL, so no per-row NULL rescan of the list, unlike
 * a (key, date) row value). A NULL key has no anchor and stays protected. A
 * correlated anchor lookup was indexed or not depending on the planner's row
 * estimate (prod scanned the anchors per page row for three of the four tables).
 */
function retentionMarketDates(table: string, count: number): string {
  return `retention_market_dates(n, date) AS (
      SELECT 1, MAX(latest.date) FROM ${table} latest
      UNION ALL
      SELECT retention_market_dates.n + 1,
             (SELECT MAX(older.date) FROM ${table} older WHERE older.date < retention_market_dates.date)
        FROM retention_market_dates
       WHERE retention_market_dates.n < ${count} AND retention_market_dates.date IS NOT NULL
    )`
}

/** G: the global `count`-th newest date (NULL when there are fewer dates, so nothing is archivable). */
export function recentMarketRowsArchiveDateBound(table: string, key: string, count = 500): string {
  recentMarketRows(table, key, count) // Share the identifier and count validation.
  return `(
    WITH RECURSIVE ${retentionMarketDates(table, count)}
    SELECT date FROM retention_market_dates WHERE n = ${count}
  )`
}

export function recentMarketRowsArchiveScan(table: string, key: string, count = 500): string {
  recentMarketRows(table, key, count) // Share the identifier and count validation.
  return `${table}.${key} IS NOT NULL AND ${table}.rowid NOT IN (
    WITH RECURSIVE ${retentionMarketDates(table, count)}, retention_market_keys(${key}) AS (
      SELECT MIN(first.${key}) FROM ${table} first
      UNION ALL
      SELECT (SELECT MIN(following.${key}) FROM ${table} following
               WHERE following.${key} > retention_market_keys.${key})
        FROM retention_market_keys WHERE retention_market_keys.${key} IS NOT NULL
    ), retention_market_anchors AS MATERIALIZED (
      SELECT symbols.${key}, (
        SELECT newer.date FROM ${table} newer
         WHERE newer.${key}=symbols.${key}
         ORDER BY newer.date DESC LIMIT 1 OFFSET ${count - 1}
      ) AS oldest_protected_date
      FROM retention_market_keys symbols
     WHERE symbols.${key} IS NOT NULL
    )
    SELECT protected.rowid
      FROM retention_market_anchors CROSS JOIN ${table} protected
        ON protected.${key}=retention_market_anchors.${key}
     WHERE retention_market_anchors.oldest_protected_date IS NOT NULL
       AND protected.date >= retention_market_anchors.oldest_protected_date
       AND protected.date < (SELECT date FROM retention_market_dates WHERE n = ${count})
    UNION ALL
    SELECT protected.rowid
      FROM retention_market_anchors CROSS JOIN ${table} protected
        ON protected.${key}=retention_market_anchors.${key}
     WHERE retention_market_anchors.oldest_protected_date IS NULL
       AND protected.date < (SELECT date FROM retention_market_dates WHERE n = ${count})
  )`
}
