import { twToday } from './dateUtils'
import type { Bindings } from '../types'

export async function runMorningWarmup(env: Bindings) {
  console.log('[Cron] Morning warmup starting...')

  if (env.ML_SERVICE_URL) {
    try {
      const res = await fetch(`${env.ML_SERVICE_URL}/health`, {
        signal: AbortSignal.timeout(10_000),
      })
      console.log(`[Cron] ML warmup: ${res.ok ? 'ok' : 'failed'}`)
    } catch (e) {
      console.warn('[Cron] ML warmup failed (non-critical):', e)
    }
  }

  const keysToDelete = ['market:risk:latest', 'market:overview']
  await Promise.allSettled(keysToDelete.map((key) => env.KV.delete(key)))

  try {
    const { fetchDayTradeEligible } = await import('./twseApi')
    const eligible = await fetchDayTradeEligible()
    if (eligible.length > 0) {
      await env.KV.put('market:daytrade_eligible', JSON.stringify(eligible), { expirationTtl: 86400 })
      console.log(`[Warmup] 當沖標的: ${eligible.length} 股`)
    } else {
      console.log('[Warmup] 當沖標的: 0（非交易日或盤前未更新）')
    }
  } catch (e) {
    console.warn('[Warmup] 當沖標的 fetch failed (non-blocking):', e)
  }

  console.log('[Cron] Morning warmup done.')
}

export async function runWeeklyICAudit(env: Bindings) {
  const mlUrl = env.ML_SERVICE_URL
  if (!mlUrl) return

  const topStock = await env.DB.prepare(`
    SELECT s.id, s.symbol FROM stocks s
    JOIN stock_prices sp ON sp.stock_id=s.id
    WHERE s.in_current_watchlist=1
    GROUP BY s.id ORDER BY COUNT(*) DESC LIMIT 1
  `).first<any>()
  if (!topStock) return

  const [prices, indicators, chips] = await Promise.all([
    env.DB.prepare('SELECT date, close, high, low, open, volume FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(topStock.id).all<any>(),
    env.DB.prepare('SELECT date, ma5, ma10, ma20, ma60, rsi14, macd_hist as macdHist, bb_upper, bb_lower, atr14, plus_di14 as plusDi14, minus_di14 as minusDi14, adx14, parabolic_sar as parabolicSar, cci20, volume_weighted_rsi14 as volumeWeightedRsi14, volume_momentum_divergence_13_27_10 as volumeMomentumDivergence132710 FROM technical_indicators WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(topStock.id).all<any>(),
    env.DB.prepare('SELECT date, foreign_net, trust_net, dealer_net FROM chip_data WHERE symbol=? ORDER BY date DESC LIMIT 200').bind(topStock.symbol).all<any>(),
  ])

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_SERVICE_SECRET) headers['X-Service-Token'] = env.ML_SERVICE_SECRET

  const res = await fetch(`${mlUrl}/factor-ic-audit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prices: (prices.results ?? []).reverse(),
      indicators: (indicators.results ?? []).reverse(),
      chips: (chips.results ?? []).reverse(),
    }),
    signal: AbortSignal.timeout(120_000),
  })

  if (!res.ok) {
    throw new Error(`ic_audit_http_${res.status}`)
  }

  const data = await res.json() as any
  console.log(`[IC Audit] ${data.effective_count} effective / ${data.weak_count} weak features`)

  if (data.weak_features?.length) {
    await env.KV.put('ml:weak_features', JSON.stringify(data.weak_features), { expirationTtl: 7 * 86400 })
  }

  for (const row of (data.details ?? [])) {
    const feature = String(row.feature ?? '').trim()
    if (!feature) continue
    await env.DB.prepare(`
      INSERT OR REPLACE INTO factor_scores (feature, ic_mean, ic_std, icir, ic_trend, effective, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(feature, row.ic_mean ?? row.ic ?? null, row.ic_std ?? null, row.icir ?? null, row.ic_trend ?? null, row.effective ? 1 : 0)
      .run().catch(() => {})
  }
}

export async function runWeeklyDriftCheck(env: Bindings) {
  const mlUrl = env.ML_SERVICE_URL
  if (!mlUrl) return

  const topStock = await env.DB.prepare(`
    SELECT s.id, s.symbol FROM stocks s
    JOIN stock_prices sp ON sp.stock_id=s.id
    WHERE s.in_current_watchlist=1
    GROUP BY s.id ORDER BY COUNT(*) DESC LIMIT 1
  `).first<any>()
  if (!topStock) return

  const [prices, indicators, chips] = await Promise.all([
    env.DB.prepare('SELECT * FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 252').bind(topStock.id).all<any>(),
    env.DB.prepare('SELECT * FROM technical_indicators WHERE stock_id=? ORDER BY date DESC LIMIT 252').bind(topStock.id).all<any>(),
    env.DB.prepare('SELECT * FROM chip_data WHERE symbol=? ORDER BY date DESC LIMIT 252').bind(topStock.symbol).all<any>(),
  ])

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_SERVICE_SECRET) headers['X-Service-Token'] = env.ML_SERVICE_SECRET

  const res = await fetch(`${mlUrl}/feature-drift`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      stock_id: topStock.id,
      symbol: topStock.symbol,
      prices: (prices.results ?? []).reverse(),
      indicators: (indicators.results ?? []).reverse(),
      chips: (chips.results ?? []).reverse(),
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    throw new Error(`drift_check_http_${res.status}`)
  }

  const data = await res.json() as any
  const date = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  await env.KV.put(`ml:drift:${date}`, JSON.stringify(data), { expirationTtl: 30 * 86400 })
  console.log(`[Drift Check] ${data.drifted_count}/${data.total_features} features drifted, needs_retrain=${data.needs_retrain}`)
}

export type MaintenanceTaskResult = {
  task: string
  ok: boolean
  changed: number
  error?: string
}

export type MaintenanceRunResult = {
  ok: boolean
  tasks: MaintenanceTaskResult[]
}

export async function runWeeklyCleanup(env: Bindings): Promise<MaintenanceRunResult> {
  console.log('[CleanupV2] Starting ownership-safe weekly cleanup...')
  const tasks: MaintenanceTaskResult[] = []
  const run = async (task: string, sql: string): Promise<void> => {
    try {
      const result = await env.DB.prepare(sql).run()
      tasks.push({ task, ok: true, changed: Number(result.meta?.changes ?? 0) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      tasks.push({ task, ok: false, changed: 0, error: message })
      console.error(`[CleanupV2] ${task} failed:`, error)
    }
  }

  // Canonical price/chip/history, predictions, factors and technical rows are
  // excluded. Producers must archive and verify R2 before enqueueing a scrub.
  await run(
    'alert_notifications_ephemeral',
    "DELETE FROM alert_notifications WHERE created_at < datetime('now', '-1 year')",
  )
  await run(
    'intraday_minute_bar_continuity_90d',
    "DELETE FROM intraday_minute_bars WHERE trade_date < date('now', '-90 days')",
  )

  const result = { ok: tasks.every((task) => task.ok), tasks }
  console.log(`[CleanupV2] completed ok=${result.ok} tasks=${tasks.length}`)
  return result
}

export async function checkAlerts(env: Bindings) {
  const { results } = await env.DB.prepare(
    'SELECT a.*, s.symbol, s.market FROM alert_rules a JOIN stocks s ON a.stock_id=s.id WHERE a.is_active=1'
  ).all<any>()

  for (const alert of results) {
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${alert.symbol}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8_000),
      })
      const json = await res.json() as any
      const price = json.quoteResponse?.result?.[0]?.regularMarketPrice ?? null

      if (!price) continue
      const triggered =
        (alert.rule_type === 'price_above' && price >= alert.threshold) ||
        (alert.rule_type === 'price_below' && price <= alert.threshold)

      if (!triggered) continue

      await env.DB.prepare(
        "UPDATE alert_rules SET last_triggered=datetime('now'), is_active=0 WHERE id=?"
      ).bind(alert.id).run()

      await env.DB.prepare(`
        INSERT INTO alert_notifications
          (user_id, alert_id, stock_symbol, rule_type, threshold, triggered_price)
        VALUES (?,?,?,?,?,?)
      `).bind(
        alert.user_id,
        alert.id,
        alert.symbol,
        alert.rule_type,
        alert.threshold,
        price,
      ).run().catch(() => {})

      console.log(`[Alert] Triggered: ${alert.symbol} ${alert.rule_type} @ ${price}`)
    } catch (e) {
      console.warn(`[Alert] ${alert.id}:`, e)
    }
  }
}

export async function fetchWeeklyShareholding(env: Bindings): Promise<void> {
  const retailLevels = new Set([
    '1-999', '1,000-5,000', '5,001-10,000', '10,001-15,000',
    '15,001-20,000', '20,001-30,000', '30,001-40,000', '40,001-50,000',
  ])
  const largeLevels = new Set(['400,001-600,000', '600,001-800,000', '800,001-1,000,000', '1,000,001以上'])

  try {
    const res = await fetch('https://openapi.tdcc.com.tw/v1/opendata/1-5', {
      headers: { 'User-Agent': 'StockVision/12.3' },
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      throw new Error(`tdcc_shareholding_http_${res.status}`)
    }

    const body = await res.json() as any[]
    if (!Array.isArray(body) || !body.length) {
      throw new Error('tdcc_shareholding_empty_response')
    }

    const { results: dbStocks } = await env.DB.prepare(
      'SELECT id, symbol FROM stocks WHERE in_current_watchlist=1'
    ).all<any>()
    const idMap = new Map<string, number>()
    for (const stock of dbStocks ?? []) idMap.set(stock.symbol, stock.id)

    type TdccRow = Record<string, unknown>
    const tdccText = (row: TdccRow, keys: string[]): string => {
      for (const key of keys) {
        const value = row[key]
        if (value != null) return String(value).trim()
      }
      return ''
    }

    const bySymbol = new Map<string, { date: string; rows: TdccRow[] }>()
    for (const row of body as TdccRow[]) {
      const symbol = tdccText(row, ['證券代號', 'SecuritiesCompanyCode'])
      if (!symbol || !idMap.has(symbol)) continue
      const date = tdccText(row, ['資料日期', '\ufeff資料日期', 'Date'])
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, { date, rows: [] })
      bySymbol.get(symbol)!.rows.push(row)
    }

    const statements: any[] = []
    for (const [symbol, { date: rawDate, rows }] of bySymbol.entries()) {
      const stockId = idMap.get(symbol)!
      let isoDate = rawDate.replace(/\//g, '-')
      if (isoDate.length === 8 && !isoDate.startsWith('20')) {
        const parts = rawDate.split('/')
        isoDate = `${parseInt(parts[0]) + 1911}-${parts[1]}-${parts[2]}`
      }

      const shareCount = (row: TdccRow) => parseInt(tdccText(row, ['股數', '股數(單位數)', 'Shares']).replace(/,/g, '')) || 0
      const holdingLevel = (row: TdccRow) => tdccText(row, ['持股分級', '持股/單位數分級', 'HoldingSharesLevel'])

      const totalShares = rows.reduce((sum, row) => sum + shareCount(row), 0)
      const totalHolders = rows.reduce((sum, row) => sum + (parseInt(tdccText(row, ['人數', 'NumberOfPeople']).replace(/,/g, '')) || 0), 0)
      const retailShares = rows
        .filter((row) => retailLevels.has(holdingLevel(row)))
        .reduce((sum, row) => sum + shareCount(row), 0)
      const largeShares = rows
        .filter((row) => largeLevels.has(holdingLevel(row)))
        .reduce((sum, row) => sum + shareCount(row), 0)

      statements.push(env.DB.prepare(`
        INSERT INTO shareholding (stock_id, date, total_shares, holder_count, retail_shares, retail_pct, large_holder_shares, large_holder_pct)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stock_id, date) DO UPDATE SET
          total_shares=excluded.total_shares, holder_count=excluded.holder_count,
          retail_shares=excluded.retail_shares, retail_pct=excluded.retail_pct,
          large_holder_shares=excluded.large_holder_shares, large_holder_pct=excluded.large_holder_pct
      `).bind(
        stockId,
        isoDate,
        totalShares,
        totalHolders,
        retailShares,
        totalShares > 0 ? (retailShares / totalShares) * 100 : null,
        largeShares,
        totalShares > 0 ? (largeShares / totalShares) * 100 : null,
      ))
    }

    for (let i = 0; i < statements.length; i += 50) {
      await env.DB.batch(statements.slice(i, i + 50))
    }

    console.log(`[Wave3] Shareholding (TDCC): ${statements.length} stocks written`)
  } catch (e) {
    console.warn('[Wave3] TDCC shareholding failed:', e)
    throw e
  }
}

async function backupD1Snapshot(env: Bindings) {
  try {
    const tables = ['paper_accounts', 'paper_positions', 'paper_orders'] as const
    const date = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
    for (const table of tables) {
      const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all()
      await env.KV.put(`backup:${table}:${date}`, JSON.stringify(results ?? []), { expirationTtl: 604800 })
    }
    console.log(`[Backup] D1 snapshot saved to KV (${tables.length} tables)`)
  } catch (e) {
    console.warn('[Backup] D1 snapshot failed:', e)
    throw e
  }
}

export async function runWeeklyLocalMaintenance(env: Bindings): Promise<MaintenanceRunResult> {
  const tasks: MaintenanceTaskResult[] = []
  const run = async (task: string, operation: () => Promise<unknown>): Promise<void> => {
    try {
      await operation()
      tasks.push({ task, ok: true, changed: 0 })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      tasks.push({ task, ok: false, changed: 0, error: message })
      console.error(`[Maintenance] ${task} failed:`, error)
    }
  }

  await run('weekly_shareholding', () => fetchWeeklyShareholding(env))
  await run('weekly_ic_audit', () => runWeeklyICAudit(env))
  await run('weekly_drift_check', () => runWeeklyDriftCheck(env))
  const { syncTimeverse } = await import('./timeverse')
  await run('timeverse_sync', () => syncTimeverse(env))
  await run('d1_snapshot_backup', () => backupD1Snapshot(env))
  return { ok: tasks.every((task) => task.ok), tasks }
}
