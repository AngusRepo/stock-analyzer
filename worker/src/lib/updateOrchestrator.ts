import type { Bindings, UpdateQueueMsg } from '../types'
import { checkAlerts } from './localMaintenance'
import { crawlAndStoreNews } from './news'
import { computeAndStoreIndicators } from './technicalIndicators'
import { fetchAndStoreStockData } from '../routes/stocks'
import { assertMarketDataReady } from './marketDataReadiness'
import { classifySchedulerSummary, logSchedulerResult } from './schedulerRunLogger'

const UPDATE_BATCH_SIZE = 25

const UPDATE_UNIVERSE_WHERE = `
  COALESCE(UPPER(market), '') NOT IN ('US', 'NYSE', 'NASDAQ')
  AND COALESCE(UPPER(market), '') NOT LIKE '%ETF%'
  AND COALESCE(UPPER(market), '') NOT LIKE '%WARRANT%'
`

function resolveUpdateDate(runDate?: string | null): string {
  const value = (runDate || '').trim()
  if (!value) return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid update date: ${value}; expected YYYY-MM-DD`)
  }
  return value
}

type ProcessUpdateBatchDeps = {
  runMarketScreener: (env: Bindings, runDate?: string) => Promise<any>
  runMLAndRiskV2: (env: Bindings, runDate?: string) => Promise<string>
}

export async function runBulkFetch(env: Bindings, force = false, runDate?: string): Promise<string> {
  const twDate = resolveUpdateDate(runDate)
  const lockKey = `cron:bulk-fetch:${twDate}`
  if (!force && await env.KV.get(lockKey)) {
    console.log(`[Cron] Bulk fetch already done today (${twDate}), skipping.`)
    const ready = await assertMarketDataReady(env.DB, twDate, { requireIndicators: false })
    return `bulk fetch skipped; ${ready.summary}`
  }

  try {
    const { bulkFetchAndStoreChipData, bulkFetchAndStorePrices } = await import('./twseApi')
    const [{ chipCount, marginCount }, priceCount] = await Promise.all([
      bulkFetchAndStoreChipData(env.DB, twDate, env.SHIOAJI_PROXY_URL, env.ML_CONTROLLER_SECRET),
      bulkFetchAndStorePrices(env.DB, twDate),
    ])
    console.log(`[Cron] Bulk: ${priceCount} prices + ${chipCount} chips + ${marginCount} margins`)
    const ready = await assertMarketDataReady(env.DB, twDate, { requireIndicators: false })
    await env.KV.put(lockKey, '1', { expirationTtl: 86400 })
    await fetchWave2Data(env, twDate).catch((e) => console.warn('[Wave2] failed:', e))
    return `${ready.summary}; fetched price=${priceCount} chip=${chipCount} margin=${marginCount}`
  } catch (e) {
    console.warn('[Cron] Bulk fetch failed:', e)
    throw e
  }
}

export async function runQueueUpdate(env: Bindings, runDate?: string, force = false) {
  const triggerTime = resolveUpdateDate(runDate)
  const lockKey = `cron:queue-update:${triggerTime}`
  if (!force && await env.KV.get(lockKey)) {
    console.log('[Cron] Queue update already triggered today, skipping.')
    return
  }

  console.log('[Cron] Kicking off queue update for full TW market indicator universe...')
  try {
    await env.UPDATE_QUEUE.send({ type: 'update_batch', cursor: 0, triggerTime })
    await logSchedulerResult(env.KV, 'indicator-queue', {
      status: 'running',
      summary: `indicator queue started for ${triggerTime}`,
      duration_ms: 0,
      run_date: triggerTime,
    })
    await env.KV.put(lockKey, '1', { expirationTtl: 86400 })
  } catch (e) {
    console.warn('[Cron] Queue update send failed, NOT writing lock:', e)
    throw e
  }
}

export async function runDailyUpdate(env: Bindings, force = false, runDate?: string): Promise<string> {
  const bulkSummary = await runBulkFetch(env, force, runDate)
  await runQueueUpdate(env, runDate, force)
  return bulkSummary
}

export async function fetchWave2Data(env: Bindings, today: string): Promise<void> {
  const {
    fetchTwseValuation,
    fetchTpexValuation,
    fetchTwseMonthlyRevenue,
    fetchTpexMonthlyRevenue,
    fetchMarketBreadth,
    fetchTwseFinancials,
    fetchTpexFinancials,
  } = await import('./twseApi')

  try {
    const breadth = await fetchMarketBreadth()
    if (breadth) {
      await env.DB.prepare(`
        INSERT INTO market_breadth (date, advance_count, decline_count, unchanged_count, advance_ratio)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          advance_count=excluded.advance_count,
          decline_count=excluded.decline_count,
          unchanged_count=excluded.unchanged_count,
          advance_ratio=excluded.advance_ratio
      `).bind(
        breadth.date,
        breadth.advance_count,
        breadth.decline_count,
        breadth.unchanged_count,
        breadth.advance_ratio,
      ).run()
      console.log(
        `[Wave2] Market breadth: ${breadth.advance_count}/${breadth.decline_count}/${breadth.unchanged_count} (${(breadth.advance_ratio * 100).toFixed(0)}%)`,
      )
    }
  } catch (e) {
    console.warn('[Wave2] Market breadth failed:', e)
  }

  try {
    const [twseVal, tpexVal] = await Promise.allSettled([fetchTwseValuation(today), fetchTpexValuation()])
    const valRows = [
      ...(twseVal.status === 'fulfilled' ? twseVal.value : []),
      ...(tpexVal.status === 'fulfilled' ? tpexVal.value : []),
    ]

    if (valRows.length) {
      const twNow = new Date(Date.now() + 8 * 3600_000)
      const currentQ = `${twNow.getFullYear()}Q${Math.ceil((twNow.getMonth() + 1) / 3)}`

      const stmts = valRows
        .filter((v) => v.pe !== null || v.pb !== null || v.dividend_yield !== null)
        .flatMap((v) => [
          env.DB.prepare(`
            UPDATE financials SET pe=?, pb=?, dividend_yield=?
            WHERE stock_id = (SELECT id FROM stocks WHERE symbol=?)
            AND period = (
              SELECT MAX(period)
              FROM financials
              WHERE stock_id = (SELECT id FROM stocks WHERE symbol=?)
                AND period LIKE '%Q%'
            )
          `).bind(v.pe, v.pb, v.dividend_yield, v.symbol, v.symbol),
          env.DB.prepare(`
            INSERT INTO financials (stock_id, period, period_type, pe, pb, dividend_yield)
            SELECT s.id, ?, 'quarterly', ?, ?, ?
            FROM stocks s WHERE s.symbol = ?
            AND NOT EXISTS (
              SELECT 1 FROM financials f
              WHERE f.stock_id = s.id AND f.period LIKE '%Q%'
            )
          `).bind(currentQ, v.pe, v.pb, v.dividend_yield, v.symbol),
        ])

      for (let i = 0; i < stmts.length; i += 50) {
        await env.DB.batch(stmts.slice(i, i + 50))
      }

      console.log(
        `[Wave2] PER/PBR: ${valRows.length} stocks (TWSE ${twseVal.status === 'fulfilled' ? twseVal.value.length : 0} + TPEX ${tpexVal.status === 'fulfilled' ? tpexVal.value.length : 0})`,
      )
    }
  } catch (e) {
    console.warn('[Wave2] PER/PBR failed:', e)
  }

  const day = parseInt(today.slice(8, 10), 10)
  if (day <= 12) {
    try {
      const [twseRev, tpexRev] = await Promise.allSettled([fetchTwseMonthlyRevenue(), fetchTpexMonthlyRevenue()])
      const revData = [
        ...(twseRev.status === 'fulfilled' ? twseRev.value : []),
        ...(tpexRev.status === 'fulfilled' ? tpexRev.value : []),
      ]

      if (revData.length) {
        const stmts = revData.map((r) =>
          env.DB.prepare(`
            INSERT INTO monthly_revenue (stock_id, date, revenue, revenue_yoy, revenue_mom)
            SELECT s.id, ?, ?, ?, ?
            FROM stocks s WHERE s.symbol = ?
            ON CONFLICT(stock_id, date) DO UPDATE SET
              revenue=excluded.revenue,
              revenue_yoy=excluded.revenue_yoy,
              revenue_mom=excluded.revenue_mom
          `).bind(r.year_month, r.revenue, r.revenue_yoy, r.revenue_mom, r.symbol),
        )

        for (let i = 0; i < stmts.length; i += 50) {
          await env.DB.batch(stmts.slice(i, i + 50))
        }

        console.log(
          `[Wave2] Monthly revenue: ${revData.length} entries (TWSE ${twseRev.status === 'fulfilled' ? twseRev.value.length : 0} + TPEX ${tpexRev.status === 'fulfilled' ? tpexRev.value.length : 0})`,
        )
      }
    } catch (e) {
      console.warn('[Wave2] Monthly revenue failed:', e)
    }
  }

  try {
    const [twseFin, tpexFin] = await Promise.allSettled([fetchTwseFinancials(), fetchTpexFinancials()])
    const finRows = [
      ...(twseFin.status === 'fulfilled' ? twseFin.value : []),
      ...(tpexFin.status === 'fulfilled' ? tpexFin.value : []),
    ]

    if (finRows.length) {
      const stmts = finRows
        .filter((f) => f.eps !== null)
        .map((f) => {
          const period = `${f.year}Q${f.quarter}`
          return env.DB.prepare(`
            INSERT INTO financials (stock_id, period, period_type, eps, revenue, roe, operating_income, net_income, total_assets, total_liabilities)
            SELECT s.id, ?, 'quarterly', ?, ?, ?, ?, ?, ?, ?
            FROM stocks s WHERE s.symbol = ?
            ON CONFLICT(stock_id, period) DO UPDATE SET
              eps=COALESCE(excluded.eps, financials.eps),
              revenue=COALESCE(excluded.revenue, financials.revenue),
              roe=COALESCE(excluded.roe, financials.roe),
              operating_income=COALESCE(excluded.operating_income, financials.operating_income),
              net_income=COALESCE(excluded.net_income, financials.net_income),
              total_assets=COALESCE(excluded.total_assets, financials.total_assets),
              total_liabilities=COALESCE(excluded.total_liabilities, financials.total_liabilities)
          `).bind(
            period,
            f.eps,
            f.revenue,
            f.roe,
            f.operating_income,
            f.net_income,
            f.total_assets,
            f.total_liabilities,
            f.symbol,
          )
        })

      for (let i = 0; i < stmts.length; i += 50) {
        await env.DB.batch(stmts.slice(i, i + 50))
      }

      console.log(`[Wave2] Financials: ${finRows.length} entries (TWSE+TPEX EPS+ROE)`)
    }
  } catch (e) {
    console.warn('[Wave2] Financials failed:', e)
  }

  if (env.ML_CONTROLLER_URL) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

    try {
      const res = await fetch(`${env.ML_CONTROLLER_URL}/twse/ex-dividend`, {
        headers,
        signal: AbortSignal.timeout(30000),
      })
      if (res.ok) {
        const exDivRows = await res.json() as any[]
        if (exDivRows.length) {
          await env.KV.put('market:ex_dividend_forecast', JSON.stringify(exDivRows), { expirationTtl: 86400 })
          console.log(`[Wave2] Ex-dividend (via controller): ${exDivRows.length} entries`)
        }
      }
    } catch (e) {
      console.warn('[Wave2] Ex-dividend proxy failed:', e)
    }

    try {
      const res = await fetch(`${env.ML_CONTROLLER_URL}/twse/attention-stocks`, {
        headers,
        signal: AbortSignal.timeout(30000),
      })
      if (res.ok) {
        const attentionSymbols = await res.json() as string[]
        if (attentionSymbols.length) {
          await env.KV.put('market:attention_stocks', JSON.stringify(attentionSymbols), { expirationTtl: 86400 })
          console.log(`[Wave2] Attention stocks (via controller): ${attentionSymbols.length} symbols`)
        }
      }
    } catch (e) {
      console.warn('[Wave2] Attention stocks proxy failed:', e)
    }
  }
}

export async function processUpdateBatch(
  msg: UpdateQueueMsg,
  env: Bindings,
  deps: ProcessUpdateBatchDeps,
): Promise<void> {
  const { cursor, triggerTime } = msg

  if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
    console.log(`[Queue] Invalid update trigger date ${triggerTime}, skipping.`)
    return
  }

  const { results: batch } = await env.DB.prepare(
    `SELECT id, symbol, market, name, in_current_watchlist
       FROM stocks
      WHERE ${UPDATE_UNIVERSE_WHERE}
        AND id > ?
      ORDER BY id ASC
      LIMIT ?`,
  ).bind(cursor, UPDATE_BATCH_SIZE).all<any>()

  const remainingCount = await env.DB.prepare(
    `SELECT COUNT(*) as cnt
       FROM stocks
      WHERE ${UPDATE_UNIVERSE_WHERE}
        AND id > ?`,
  ).bind(cursor).first<{ cnt: number }>().then((row) => row?.cnt ?? 0)

  if (batch.length === 0) {
    console.log('[Queue] All stocks updated.')
    await logSchedulerResult(env.KV, 'indicator-queue', {
      status: 'success',
      summary: `indicator queue complete for ${triggerTime}; no remaining stocks`,
      duration_ms: 0,
      run_date: triggerTime,
    })
    await checkAlerts(env)
    return
  }

  console.log(`[Queue] Update batch: ${batch.length} stocks (cursor=${cursor}, remaining=${remainingCount})`)

  for (const stock of batch) {
    try {
      const priceCount = await env.DB.prepare(
        'SELECT COUNT(*) as cnt FROM stock_prices WHERE stock_id=?',
      ).bind(stock.id).first<{ cnt: number }>()

      if ((priceCount?.cnt ?? 0) < 20 && Number(stock.in_current_watchlist ?? 0) === 1) {
        await fetchAndStoreStockData(env.DB, env.KV, stock, env.FINMIND_TOKEN)
      }

      await computeAndStoreIndicators(env.DB, stock.id)
      if (Number(stock.in_current_watchlist ?? 0) === 1) {
        await crawlAndStoreNews(env.DB, stock)
        await new Promise((resolve) => setTimeout(resolve, 300))
      } else {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    } catch (e) {
      console.error(`[Queue] Failed ${stock.symbol}:`, e)
    }
  }

  const lastId = batch[batch.length - 1].id

  if (remainingCount > UPDATE_BATCH_SIZE) {
    await env.UPDATE_QUEUE.send({
      type: 'update_batch',
      cursor: lastId,
      triggerTime,
    })
    console.log(
      `[Queue] Next batch queued (cursor=${lastId}, ${remainingCount - UPDATE_BATCH_SIZE} remaining)`,
    )
    return
  }

  console.log('[Queue] All stocks done. Running alert check...')
  await logSchedulerResult(env.KV, 'indicator-queue', {
    status: 'success',
    summary: `indicator queue complete for ${triggerTime}`,
    duration_ms: 0,
    run_date: triggerTime,
  })
  await checkAlerts(env)

  try {
    const screenerResult = await deps.runMarketScreener(env, triggerTime)
    const screenerSummary = typeof screenerResult === 'string'
      ? screenerResult
      : JSON.stringify(screenerResult)?.slice(0, 500) ?? ''
    await logSchedulerResult(env.KV, 'screener', {
      status: classifySchedulerSummary(screenerSummary),
      summary: screenerSummary,
      duration_ms: 0,
      run_date: triggerTime,
    })
    console.log(`[Queue] Event-driven: screener completed for ${triggerTime}`)
  } catch (e) {
    await logSchedulerResult(env.KV, 'screener', {
      status: 'error',
      summary: e instanceof Error ? e.message : String(e),
      duration_ms: 0,
      error: String(e),
      run_date: triggerTime,
    })
    console.warn('[Queue] Event-driven screener failed:', e)
    return
  }

  try {
    await deps.runMLAndRiskV2(env, triggerTime)
    console.log(`[Queue] Event-driven: triggered runMLAndRiskV2 after update complete for ${triggerTime}`)
  } catch (e) {
    console.warn('[Queue] Event-driven ML trigger failed:', e)
  }
}
