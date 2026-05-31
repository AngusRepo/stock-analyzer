import type { MarketRegime } from './dynamicExitPriority'
import {
  buildHoldingExitFeatureQuality,
  type HoldingExitFeatureQualitySource,
  type HoldingExitFeatures,
} from './holdingExitReview'

export interface HoldingExitFeaturePosition {
  symbol: string
  avg_cost: number
  entry_price: number | null
  entry_date: string | null
}

async function firstOrNull<T>(promise: Promise<T | null>): Promise<T | null> {
  try {
    return await promise
  } catch {
    return null
  }
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function rowCount(value: unknown, fallback = 0): number {
  const n = numberOrNull(value)
  return n == null ? fallback : Math.max(0, Math.round(n))
}

function positiveNumberOrNull(value: unknown): number | null {
  const n = numberOrNull(value)
  return n != null && n > 0 ? n : null
}

function sourceQuality(
  source: string,
  rows: number,
  latestDate: string | null | undefined,
  available: boolean,
): HoldingExitFeatureQualitySource {
  return {
    available,
    source,
    rows,
    latestDate: latestDate ?? null,
  }
}

async function loadOneHoldingExitFeatures(
  db: D1Database,
  pos: HoldingExitFeaturePosition,
  currentPrice: number | null,
  tradeDate: string,
  regime?: MarketRegime | null,
): Promise<HoldingExitFeatures> {
  const symbol = String(pos.symbol)
  const entryPrice = Number(pos.entry_price ?? pos.avg_cost ?? 0)
  const entryDate = pos.entry_date ?? tradeDate

  const technical = await firstOrNull(db.prepare(`
    WITH technical_rows AS (
      SELECT ti.date,
             ti.obv_temperature_60
        FROM technical_indicators ti
        JOIN stocks s ON s.id = ti.stock_id
       WHERE s.symbol = ?
         AND ti.obv_temperature_60 IS NOT NULL
       ORDER BY ti.date DESC
       LIMIT 60
    ),
    latest AS (
      SELECT date, obv_temperature_60
        FROM technical_rows
       ORDER BY date DESC
       LIMIT 1
    )
    SELECT latest.obv_temperature_60 AS obv_temperature_60,
           latest.date AS latest_date,
           (SELECT COUNT(*) FROM technical_rows) AS row_count,
           (
             SELECT AVG(obv_temperature_60)
               FROM technical_rows
              WHERE obv_temperature_60 < 50
           ) AS obv_weak_threshold
      FROM latest
  `).bind(symbol).first<{
    obv_temperature_60: number | null
    obv_weak_threshold: number | null
    latest_date: string | null
    row_count: number | null
  }>())

  const chip = await firstOrNull(db.prepare(`
    WITH chip_rows AS (
        SELECT ccd.date,
               COALESCE(ccd.foreign_net, 0) + COALESCE(ccd.trust_net, 0) + COALESCE(ccd.dealer_net, 0) AS institutional_net
          FROM canonical_chip_daily ccd
          JOIN stocks s ON s.id = ccd.stock_id
         WHERE s.symbol = ?
         ORDER BY ccd.date DESC
         LIMIT 60
    ),
    recent AS (
        SELECT * FROM chip_rows ORDER BY date DESC LIMIT 5
    )
    SELECT SUM(institutional_net) AS institutional_net_5d,
           COUNT(*) AS row_count,
           MAX(date) AS latest_date,
           (
             SELECT AVG(CASE WHEN institutional_net < 0 THEN ABS(institutional_net) END)
               FROM chip_rows
           ) AS institutional_sell_scale
      FROM recent
  `).bind(symbol).first<{
    institutional_net_5d: number | null
    institutional_sell_scale: number | null
    latest_date: string | null
    row_count: number | null
  }>())

  const broker = await firstOrNull(db.prepare(`
    WITH broker_rows AS (
        SELECT cbf.date,
               cbf.net_amount,
               cbf.concentration
          FROM canonical_broker_flow_daily cbf
          JOIN stocks s ON s.id = cbf.stock_id
         WHERE s.symbol = ?
         ORDER BY cbf.date DESC
         LIMIT 60
    ),
    recent AS (
        SELECT * FROM broker_rows ORDER BY date DESC LIMIT 5
    )
    SELECT SUM(COALESCE(net_amount, 0)) AS broker_net_amount_5d,
           MAX(COALESCE(concentration, 0)) - MIN(COALESCE(concentration, 0)) AS broker_concentration_delta_5d,
           COUNT(*) AS row_count,
           MAX(date) AS latest_date,
           (
             SELECT AVG(CASE WHEN net_amount < 0 THEN ABS(net_amount) END)
               FROM broker_rows
           ) AS broker_sell_scale
      FROM recent
  `).bind(symbol).first<{
    broker_net_amount_5d: number | null
    broker_concentration_delta_5d: number | null
    broker_sell_scale: number | null
    latest_date: string | null
    row_count: number | null
  }>())

  const priceWindow = await firstOrNull(db.prepare(`
    SELECT MAX(sp.high) AS max_high,
           MIN(sp.low) AS support_low,
           COUNT(*) AS row_count,
           MAX(sp.date) AS latest_date,
           AVG(CASE
             WHEN sp.low > 0 AND sp.high IS NOT NULL AND sp.high >= sp.low
             THEN (sp.high - sp.low) / sp.low
           END) AS support_break_scale,
           AVG(CASE
             WHEN sp.high IS NOT NULL AND sp.low IS NOT NULL AND sp.close IS NOT NULL AND sp.high > sp.low
             THEN (sp.high - sp.close) / (sp.high - sp.low)
           END) AS giveback_ratio_scale
      FROM stock_prices sp
      JOIN stocks s ON s.id = sp.stock_id
     WHERE s.symbol = ?
       AND sp.date >= ?
       AND sp.date <= ?
  `).bind(symbol, entryDate, tradeDate).first<{
    max_high: number | null
    support_low: number | null
    support_break_scale: number | null
    giveback_ratio_scale: number | null
    latest_date: string | null
    row_count: number | null
  }>())

  const maxHigh = numberOrNull(priceWindow?.max_high)
  const supportLow = numberOrNull(priceWindow?.support_low)
  const technicalRows = rowCount(technical?.row_count, technical ? 1 : 0)
  const chipRows = rowCount(chip?.row_count)
  const brokerRows = rowCount(broker?.row_count)
  const priceRows = rowCount(priceWindow?.row_count)
  const px = currentPrice && currentPrice > 0 ? currentPrice : null
  const mfePct = maxHigh != null && entryPrice > 0 ? Math.max(0, (maxHigh - entryPrice) / entryPrice) : null
  const givebackPct = maxHigh != null && px != null && entryPrice > 0
    ? Math.max(0, (maxHigh - px) / entryPrice)
    : null
  const supportBreakPct = priceRows > 0 && supportLow != null && px != null && supportLow > 0
    ? px < supportLow ? (supportLow - px) / supportLow : 0
    : null

  const features: HoldingExitFeatures = {
    brokerNetAmount5d: numberOrNull(broker?.broker_net_amount_5d),
    brokerConcentrationDelta5d: numberOrNull(broker?.broker_concentration_delta_5d),
    institutionalNetAmount5d: numberOrNull(chip?.institutional_net_5d),
    obvTemperature60: numberOrNull(technical?.obv_temperature_60),
    supportBreakPct,
    mfePct,
    givebackPct,
    regime: regime ?? null,
    factorScale: {
      brokerNetAmount5d: positiveNumberOrNull(broker?.broker_sell_scale),
      institutionalNetAmount5d: positiveNumberOrNull(chip?.institutional_sell_scale),
      moneyFlowWeakThreshold: positiveNumberOrNull(technical?.obv_weak_threshold),
      supportBreakPct: positiveNumberOrNull(priceWindow?.support_break_scale),
      givebackRatio: positiveNumberOrNull(priceWindow?.giveback_ratio_scale),
      provenance: {
        source: 'holding_exit_feature_loader',
        method: 'rolling_adaptive_factor_scale',
        lookbackRows: 60,
      },
    },
  }
  features.featureQuality = buildHoldingExitFeatureQuality({
    ...features,
    featureQuality: {
      coverage: 0,
      missing: [],
      sources: {
        brokerFlow: sourceQuality(
          'canonical_broker_flow_daily',
          brokerRows,
          broker?.latest_date,
          features.brokerNetAmount5d != null || features.brokerConcentrationDelta5d != null,
        ),
        institutionalChip: sourceQuality(
          'canonical_chip_daily',
          chipRows,
          chip?.latest_date,
          features.institutionalNetAmount5d != null,
        ),
        moneyFlow: sourceQuality(
          'technical_indicators.obv_temperature_60',
          technicalRows,
          technical?.latest_date,
          features.obvTemperature60 != null,
        ),
        structure: sourceQuality(
          'stock_prices.entry_window',
          priceRows,
          priceWindow?.latest_date,
          features.supportBreakPct != null,
        ),
        giveback: sourceQuality(
          'stock_prices.entry_window',
          priceRows,
          priceWindow?.latest_date,
          features.mfePct != null && features.givebackPct != null,
        ),
        regime: sourceQuality(
          'market_regime_state',
          regime != null ? 1 : 0,
          tradeDate,
          regime != null,
        ),
        priceWindow: sourceQuality(
          'stock_prices.entry_window',
          priceRows,
          priceWindow?.latest_date,
          priceRows > 0,
        ),
      },
    },
  })
  return features
}

export async function loadHoldingExitFeatureMap(
  db: D1Database,
  positions: HoldingExitFeaturePosition[],
  currentPrices: Map<string, number>,
  tradeDate: string,
  regime?: MarketRegime | null,
): Promise<Map<string, HoldingExitFeatures>> {
  const entries = await Promise.all(positions.map(async (pos) => {
    const features = await loadOneHoldingExitFeatures(
      db,
      pos,
      currentPrices.get(String(pos.symbol)) ?? null,
      tradeDate,
      regime,
    )
    return [String(pos.symbol), features] as const
  }))
  return new Map(entries)
}
