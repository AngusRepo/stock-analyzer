import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Bindings, Variables, UpdateQueueMsg } from './types'
import { auth } from './routes/auth'
import { stocks, fetchAndStoreStockData, computeAndStoreIndicators } from './routes/stocks'
import { market, llm, watchlist, alerts, news, ml, notifications, system, recommendations, chat } from './routes/other'
import { paper, runPaperAutoTrade, setupMorningPendingBuys, runIntradayCheck, runEODExit, runDailySnapshot, pollIntradayStopLoss } from './routes/paper'

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

app.use('/api/*', cors({
  origin: (origin, c) => {
    // server-to-server（Cron、Queue）：無 Origin header，直接放行
    if (origin === undefined || origin === '') return ''
    // 'null' origin = sandboxed iframe 攻擊，明確拒絕
    if (origin === 'null') return null
    // 精確比對：避免 evil-stockvision.pages.dev 繞過；PAGES_ORIGIN 空白時不加入白名單
    const pagesOrigin = (c.env.PAGES_ORIGIN ?? '').trim()
    const allowed = new Set([
      ...(pagesOrigin ? [pagesOrigin] : []),
      'http://localhost:5173',
      'http://localhost:4173',
      'http://localhost:3000',
    ])
    return allowed.has(origin) ? origin : null
  },
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}))

// ─── Security Headers ──────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  await next()
  c.res.headers.set('X-Content-Type-Options', 'nosniff')
  c.res.headers.set('X-Frame-Options', 'DENY')
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  // CSP：API 回應不渲染 HTML，但前端靜態頁面由 Pages 負責
  if (c.req.path.startsWith('/api/')) {
    c.res.headers.set('Content-Security-Policy', "default-src 'none'")
  }
})

app.route('/api/auth',      auth)
app.route('/api/stocks',    stocks)
app.route('/api/market',    market)
app.route('/api/llm',       llm)
app.route('/api/watchlist', watchlist)
app.route('/api/alerts',    alerts)
app.route('/api/news',      news)
app.route('/api/ml',        ml)
app.route('/api/notifications', notifications)
app.route('/api/system',        system)
app.route('/api/recommendations', recommendations)
app.route('/api/chat',            chat)
app.route('/api/paper',           paper)
app.get('/api/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }))

app.post('/api/admin/update', async (c) => {
  const token = c.req.header('Authorization')?.slice(7)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const { verifyJWT } = await import('./lib/auth')
  const payload = await verifyJWT(token, c.env.JWT_SECRET)
  if (!payload || payload.role !== 'admin') return c.json({ error: 'Admin only' }, 403)
  c.executionCtx.waitUntil(runDailyUpdate(c.env))
  return c.json({ success: true, message: '每日更新已在背景執行' })
})

// ─── Admin: 交易參數配置（KV Config）──────────────────────────────────────
app.get('/api/admin/config', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token || token !== c.env.STOCKVISION_AUTH_TOKEN)
    return c.json({ error: 'Unauthorized' }, 401)
  const { getTradingConfig } = await import('./lib/tradingConfig')
  const config = await getTradingConfig(c.env.KV)
  return c.json(config)
})

app.put('/api/admin/config', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token || token !== c.env.STOCKVISION_AUTH_TOKEN)
    return c.json({ error: 'Unauthorized' }, 401)
  const body = await c.req.json<any>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON' }, 400)
  const { setTradingConfig, getTradingConfig } = await import('./lib/tradingConfig')
  // Merge: 讀取現有 config，覆蓋傳入的欄位
  const current = await getTradingConfig(c.env.KV)
  const merged = {
    fees: { ...current.fees, ...body.fees },
    circuit: { ...current.circuit, ...body.circuit },
    exit: { ...current.exit, ...body.exit },
    position: { ...current.position, ...body.position },
    screener: { ...current.screener, ...body.screener },
  }
  await setTradingConfig(c.env.KV, merged)
  return c.json({ success: true, config: merged })
})

// ─── Admin: Cron 執行日誌 ────────────────────────────────────────────────────
app.get('/api/admin/cron-logs', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token || token !== c.env.STOCKVISION_AUTH_TOKEN) {
    // 也允許 JWT 登入用戶
    const { verifyJWT } = await import('./lib/auth')
    const payload = await verifyJWT(token ?? '', c.env.JWT_SECRET)
    if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  }
  const date = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10) // TW date
  const { getCronLogs } = await import('./lib/cronLogger')
  const logs = await getCronLogs(c.env.KV, date)
  return c.json({ date, logs })
})

// ─── Backtest Results（最新回測結果，Dashboard 用）─────────────────────────────
app.get('/api/backtest/latest', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  // Allow JWT or auth token
  if (token !== c.env.STOCKVISION_AUTH_TOKEN) {
    const { verifyJWT } = await import('./lib/auth')
    const payload = await verifyJWT(token, c.env.JWT_SECRET)
    if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  }
  const row = await c.env.DB.prepare(
    'SELECT * FROM backtest_results ORDER BY run_date DESC, created_at DESC LIMIT 1'
  ).first()
  return c.json(row ?? null)
})

// ─── Admin: Adaptive Params（讀取 / 手動覆蓋）──────────────────────────────
app.get('/api/admin/adaptive-params', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  if (token !== c.env.STOCKVISION_AUTH_TOKEN) {
    const { verifyJWT } = await import('./lib/auth')
    const payload = await verifyJWT(token, c.env.JWT_SECRET)
    if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  }
  const { getAdaptiveParams } = await import('./lib/adaptiveConfig')
  const params = await getAdaptiveParams(c.env.KV)
  return c.json(params)
})

app.post('/api/admin/adaptive-params', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  if (token !== c.env.STOCKVISION_AUTH_TOKEN) {
    const { verifyJWT } = await import('./lib/auth')
    const payload = await verifyJWT(token, c.env.JWT_SECRET)
    if (!payload || payload.role !== 'admin') return c.json({ error: 'Admin only' }, 403)
  }
  const body = await c.req.json<any>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON' }, 400)
  const { getAdaptiveParams, setAdaptiveParams } = await import('./lib/adaptiveConfig')
  const current = await getAdaptiveParams(c.env.KV)
  const merged = { ...current, ...body, version: (current.version ?? 0) + 1 }
  await setAdaptiveParams(c.env.KV, merged)
  return c.json({ success: true, params: merged })
})

// ─── Cron Schedule（前端 Dashboard 動態取排程時間）────────────────────────────
app.get('/api/cron/schedule', (c) => {
  // Single source of truth for cron schedule — mirrors wrangler.toml
  const schedule = [
    { task: 'us-leading',       tw_time: '06:30',       description: '美股先行指標' },
    { task: 'morning-setup',    tw_time: '07:15',       description: '預熱+掛單+Debate' },
    { task: 'morning-briefing', tw_time: '07:50',       description: '盤前攻略 Discord' },
    { task: 'intraday-check',   tw_time: '09:00-13:30', description: '盤中限價買入+止損停利' },
    { task: 'screener',         tw_time: '14:00',       description: '全市場篩選' },
    { task: 'eod-exit',         tw_time: '14:10',       description: 'EOD 出場檢查' },
    { task: 'daily-snapshot',   tw_time: '14:20',       description: 'PnL+Sharpe+Drawdown' },
    { task: 'data-update',      tw_time: '15:05',       description: '收盤後抓股價/籌碼/新聞' },
    { task: 'ml-warmup',        tw_time: '15:25',       description: 'Cloud Run 預熱' },
    { task: 'ml-predict',       tw_time: '15:30',       description: 'ML 預測+大盤風險' },
    { task: 'recommendation',   tw_time: '15:35',       description: '每日選股推薦' },
    { task: 'verify',           tw_time: '16:00',       description: '預測驗證' },
    { task: 'adapt',            tw_time: '16:05',       description: '自適應參數更新' },
    { task: 'daily-report',     tw_time: '16:10',       description: '收盤報告 Discord' },
    { task: 'weekly-cleanup',   tw_time: '週日 04:00',  description: '清理+重訓+集保+IC+Timeverse' },
  ]
  return c.json({ schedule })
})

// ─── Admin: 手動觸發 cron 任務（STOCKVISION_AUTH_TOKEN 驗證）────────────────
app.post('/api/admin/trigger/:task', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token || token !== c.env.STOCKVISION_AUTH_TOKEN)
    return c.json({ error: 'Unauthorized' }, 401)

  const task = c.req.param('task')
  /** 等待 Queue 消費完畢（輪詢 stock_prices 更新數量） */
  const waitForQueue = async (table: string, dateCol: string, minExpected: number, timeoutMs = 300_000) => {
    const twToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const row = await c.env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM ${table} WHERE ${dateCol} = ?`
      ).bind(twToday).first<{ cnt: number }>()
      if ((row?.cnt ?? 0) >= minExpected) return row?.cnt
      await new Promise(r => setTimeout(r, 10_000)) // 10 秒輪詢一次
    }
    throw new Error(`Queue timeout: ${table} only has ${(await c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${dateCol}=?`).bind(twToday).first<any>())?.cnt ?? 0} rows after ${timeoutMs / 1000}s`)
  }

  const taskMap: Record<string, () => Promise<any>> = {
    screener:      () => runMarketScreener(c.env),
    update:        () => runDailyUpdate(c.env),
    ml:            () => runMLAndRisk(c.env),
    recommendation:() => runDailyRecommendation(c.env),
    'paper-trade': () => runPaperAutoTrade(c.env),
    'morning-setup': () => setupMorningPendingBuys(c.env),
    'intraday-check': () => runIntradayCheck(c.env),
    'eod-exit': () => runEODExit(c.env),
    'daily-snapshot': () => runDailySnapshot(c.env),
    warmup:        () => runMorningWarmup(c.env),
    'morning-briefing': async () => { const { generateMorningBriefing } = await import('./lib/morningBriefing'); return generateMorningBriefing(c.env) },
    'daily-report':     async () => { const { generateDailyReport } = await import('./lib/dailyReport'); return generateDailyReport(c.env) },
    'timeverse-sync':   async () => { const { syncTimeverse } = await import('./lib/timeverse'); return syncTimeverse(c.env) },
    'us-leading':       async () => { const { fetchAndStoreUSLeading } = await import('./lib/usLeading'); return fetchAndStoreUSLeading(c.env) },
    'adapt':            async () => { const { runAdaptiveUpdate } = await import('./lib/adaptiveEngine'); return runAdaptiveUpdate(c.env) },
    'reclassify-tags':  async () => { const { reclassifyTags } = await import('./lib/tagReclassifier'); return reclassifyTags(c.env) },
    // ── 完整 Pipeline：依序等待每步完成 ──
    pipeline: async () => {
      const steps: string[] = []
      const activeCount = (await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM stocks WHERE is_active=1").first<any>())?.cnt ?? 60

      // 1. Screener
      await runMarketScreener(c.env)
      steps.push('screener')

      // 2. Data update + 等 queue 消化
      await runDailyUpdate(c.env)
      const updated = await waitForQueue('stock_prices', 'date', Math.floor(activeCount * 0.8))
      steps.push(`data-update(${updated} prices)`)

      // 3. ML predict + 等 queue 消化
      await runMLAndRisk(c.env)
      const predicted = await waitForQueue('predictions', "date(generated_at)", Math.floor(activeCount * 0.5))
      steps.push(`ml-predict(${predicted} predictions)`)

      // 4. Recommendation（chip_data 已更新）
      await runDailyRecommendation(c.env)
      steps.push('recommendation')

      return { steps, message: '完整 pipeline 完成' }
    },
  }
  const fn = taskMap[task]
  if (!fn) return c.json({ error: `Unknown task: ${task}`, available: Object.keys(taskMap) }, 400)

  // 同步執行 + 寫 cron log（讓 Dashboard 能顯示最新狀態）
  const { logCronResult } = await import('./lib/cronLogger')
  const t0 = Date.now()
  try {
    const result = await fn()
    const summary = typeof result === 'string' ? result : JSON.stringify(result)?.slice(0, 200) ?? ''
    await logCronResult(c.env.KV, task, { status: 'success', summary, duration_ms: Date.now() - t0 })
    return c.json({ success: true, message: `${task} 完成`, triggered_at: new Date().toISOString(), result })
  } catch (e: any) {
    await logCronResult(c.env.KV, task, { status: 'error', summary: e?.message ?? 'Unknown error', duration_ms: Date.now() - t0, error: String(e) })
    return c.json({ success: false, message: `${task} 失敗`, error: e.message }, 500)
  }
})

// ─── Debug: 測試單支股票 FinMind chip fetch ─────────────────────────────────
app.get('/api/admin/debug-chips/:symbol', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token || token !== c.env.STOCKVISION_AUTH_TOKEN) return c.json({ error: 'Unauthorized' }, 401)

  const symbol = c.req.param('symbol')
  const { fetchTWChips, aggregateChips } = await import('./lib/finmind')
  const chipStart = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]

  try {
    const chipRows = await fetchTWChips(c.env.FINMIND_TOKEN, symbol, chipStart)
    const chipMap = aggregateChips(chipRows)
    return c.json({
      symbol,
      finmind_token_set: !!c.env.FINMIND_TOKEN,
      chipStart,
      raw_rows: chipRows.length,
      sample_raw: chipRows.slice(0, 5),
      aggregated_dates: Object.keys(chipMap).length,
      sample_aggregated: Object.fromEntries(Object.entries(chipMap).slice(-3)),
    })
  } catch (e: any) {
    return c.json({ error: e.message, stack: e.stack })
  }
})

// ─── 每批處理的股票數量 ──────────────────────────────────────────────────────
// 免費方案：6 支（每支 ~3s，30s 限制內安全完成）
// Workers Paid：可調高到 30+
const BATCH_SIZE    = 6

// ── Phase 3: Controller Helper ─────────────────────────────────────────────
async function postController(env: Bindings, path: string, body: any, timeoutMs = 300_000): Promise<any> {
  const url = env.ML_CONTROLLER_URL
  if (!url) throw new Error('ML_CONTROLLER_URL not set')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET
  const res = await fetch(`${url}${path}`, {
    method: 'POST', headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Controller ${path} HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json() as Promise<any>
}

// ─── Cron 0：每日 09:00 — 開盤前預熱（含喚醒 ML 服務）────────────────────────
async function runMorningWarmup(env: Bindings) {
  console.log('[Cron] Morning warmup starting...')

  // 喚醒 Cloud Run ML 服務（避免 15:30 冷啟動）
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

  // 清除 KV 快取，確保今日資料不會被昨日快取污染
  const keysToDelete = ['market:risk:latest', 'market:overview']
  await Promise.allSettled(keysToDelete.map(k => env.KV.delete(k)))
  console.log('[Cron] Morning warmup done.')
}

// ─── Cron 1：每日 15:05 — 啟動資料更新 Queue ────────────────────────────────
async function runDailyUpdate(env: Bindings) {
  const triggerTime = new Date().toISOString().split('T')[0]  // YYYY-MM-DD
  // 冪等保護：同一天不重複觸發（防止 admin 手動 + Cron 雙重觸發浪費 FinMind 配額）
  const lockKey = `cron:daily-update:${triggerTime}`
  if (await env.KV.get(lockKey)) {
    console.log(`[Cron] Daily update already triggered today (${triggerTime}), skipping.`)
    return
  }
  await env.KV.put(lockKey, '1', { expirationTtl: 86400 })
  console.log('[Cron] Kicking off daily update via Queue...')
  await env.UPDATE_QUEUE.send({ type: 'update_batch', cursor: 0, triggerTime })

  // Wave 2：月營收 + 大盤廣度（與 Queue batch 並行，不阻塞）
  await fetchWave2Data(env, triggerTime).catch(e => console.warn('[Wave2] failed:', e))
  console.log('[Cron] First batch queued + Wave2 data fetched.')
}

// ─── Wave 2 數據：月營收 + 大盤廣度 ────────────────────────────────────────
async function fetchWave2Data(env: Bindings, today: string): Promise<void> {
  const { fetchBulkMonthlyRevenue, fetchTWMarketBreadth } = await import('./lib/finmind')
  const token = env.FINMIND_TOKEN

  // ── 大盤廣度（每日）──────────────────────────────────────────────────
  try {
    const breadthData = await fetchTWMarketBreadth(token, today)
    if (breadthData.length > 0) {
      const b = breadthData[breadthData.length - 1]
      const total = (b.AdvanceCount ?? 0) + (b.DeclineCount ?? 0) + (b.UnchangedCount ?? 0)
      const advRatio = total > 0 ? b.AdvanceCount / total : 0.5
      await env.DB.prepare(`
        INSERT INTO market_breadth (date, advance_count, decline_count, unchanged_count, advance_ratio)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          advance_count=excluded.advance_count, decline_count=excluded.decline_count,
          unchanged_count=excluded.unchanged_count, advance_ratio=excluded.advance_ratio
      `).bind(b.date, b.AdvanceCount, b.DeclineCount, b.UnchangedCount, advRatio).run()
      console.log(`[Wave2] Market breadth: ${b.AdvanceCount}↑ ${b.DeclineCount}↓ ${b.UnchangedCount}→ (${(advRatio*100).toFixed(0)}%)`)
    }
  } catch (e) { console.warn('[Wave2] Market breadth failed:', e) }

  // ── 月營收（每月 1-10 日抓上月數據）─────────────────────────────────
  const day = parseInt(today.slice(8, 10))
  if (day <= 12) {  // 每月前 12 天嘗試抓（營收陸續公佈）
    try {
      // 上月日期
      const d = new Date(today)
      d.setMonth(d.getMonth() - 1)
      const prevMonth = d.toISOString().slice(0, 7)  // "2026-02"
      const startDate = `${prevMonth}-01`

      const revData = await fetchBulkMonthlyRevenue(token, startDate)
      if (revData.length > 0) {
        // 批次寫入（每支股票一筆）
        const stmts = []
        for (const r of revData) {
          const yearMonth = `${r.revenue_year}-${String(r.revenue_month).padStart(2, '0')}`
          // 查 stock_id
          stmts.push(
            env.DB.prepare(`
              INSERT INTO monthly_revenue (stock_id, date, revenue, revenue_yoy, revenue_mom)
              SELECT s.id, ?, ?, NULL, NULL
              FROM stocks s WHERE s.symbol = ?
              ON CONFLICT(stock_id, date) DO UPDATE SET revenue=excluded.revenue
            `).bind(yearMonth, r.revenue, r.stock_id)
          )
        }
        // D1 batch 限制 100 筆
        for (let i = 0; i < stmts.length; i += 100) {
          await env.DB.batch(stmts.slice(i, i + 100))
        }
        console.log(`[Wave2] Monthly revenue: ${revData.length} entries for ${prevMonth}`)
      }
    } catch (e) { console.warn('[Wave2] Monthly revenue failed:', e) }
  }
}

// ─── Queue Consumer：處理一批股票資料更新，完成後自動推下一批 ────────────────
async function processUpdateBatch(
  msg: UpdateQueueMsg,
  env: Bindings,
): Promise<void> {
  const { cursor, triggerTime } = msg

  // 防止跨天的舊訊息汙染（Queue 訊息最多保留 4 天）
  const today = new Date().toISOString().split('T')[0]
  if (triggerTime !== today) {
    console.log(`[Queue] Stale message from ${triggerTime}, skipping.`)
    return
  }

  // [CODE-REVIEW-FIX] 2026-03-23: 改用 SQL WHERE id > ? LIMIT ? 替代 JS filter（避免 O(n) 全表掃描）
  // 先查剩餘總數（用於 log），再取本批次
  const { results: batch } = await env.DB.prepare(
    'SELECT id, symbol, market, name FROM stocks WHERE is_active=1 AND id > ? ORDER BY id ASC LIMIT ?'
  ).bind(cursor, BATCH_SIZE).all<any>()

  // 查剩餘筆數供 log 用（不 SELECT *，只計數）
  const remainingCount = await env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM stocks WHERE is_active=1 AND id > ?'
  ).bind(cursor).first<{ cnt: number }>().then(r => r?.cnt ?? 0)

  if (batch.length === 0) {
    console.log('[Queue] All stocks updated.')
    await checkAlerts(env)
    return
  }

  console.log(`[Queue] Update batch: ${batch.length} stocks (cursor=${cursor}, remaining=${remainingCount})`)

  for (const stock of batch) {
    try {
      await fetchAndStoreStockData(env.DB, env.KV, stock, env.FINMIND_TOKEN)
      // SRP：指標計算獨立於資料抓取，在同一 pipeline stage 呼叫但邏輯分離
      await computeAndStoreIndicators(env.DB, stock.id)
      await crawlAndStoreNews(env.DB, stock)
      await new Promise(r => setTimeout(r, 300))
    } catch (e) {
      console.error(`[Queue] Failed ${stock.symbol}:`, e)
    }
  }

  const lastId = batch[batch.length - 1].id

  if (remainingCount > BATCH_SIZE) {
    // 還有剩 → 立刻推下一批到 Queue，Worker 結束後馬上接續
    await env.UPDATE_QUEUE.send({
      type: 'update_batch',
      cursor: lastId,
      triggerTime,
    })
    console.log(`[Queue] Next batch queued (cursor=${lastId}, ${remainingCount - BATCH_SIZE} remaining)`)
  } else {
    // 全部完成
    console.log('[Queue] All stocks done. Running alert check...')
    await checkAlerts(env)

    // #12 Event-driven chain: update complete → trigger ML (don't wait for 15:30 cron)
    try {
      await runMLAndRisk(env)  // idempotent — lockKey 保護不會重複執行
      console.log('[Queue] Event-driven: triggered runMLAndRisk after update complete')
    } catch (e) {
      console.warn('[Queue] Event-driven ML trigger failed (cron fallback still active):', e)
    }
  }
}

// ─── Cron 2：每日 15:30 — 計算大盤風險 + Controller 並行 ML 預測 ─────────────
async function runMLAndRisk(env: Bindings) {
  const today = new Date().toISOString().split('T')[0]
  const lockKey = `cron:ml-risk:${today}`
  if (await env.KV.get(lockKey)) {
    console.log(`[Cron] ML+Risk already triggered today (${today}), skipping.`)
    return
  }
  await env.KV.put(lockKey, '1', { expirationTtl: 86400 })
  console.log(`[Cron] Starting market risk + ML batch predict... (controller=${env.ML_CONTROLLER_URL ? 'SET' : 'NOT_SET'}, mlService=${env.ML_SERVICE_URL ? 'SET' : 'NOT_SET'})`)

  // 1. 大盤風險（直接執行，速度快）
  try {
    const { calcMarketRisk } = await import('./lib/marketRisk')
    const risk = await calcMarketRisk(env.FINMIND_TOKEN, env.ANTHROPIC_API_KEY)
    await env.DB.prepare(`
      INSERT OR REPLACE INTO market_risk
        (date, vix, vix_level, twii_close, twii_vol20, twii_ma20, twii_bias,
         foreign_consecutive_sell, foreign_net_5d, margin_ratio,
         limit_down_count, limit_down_pct, risk_score, risk_level, risk_summary)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      risk.date, risk.vix, risk.vixLevel, risk.twiiClose, risk.twiiVol20,
      risk.twiiMa20, risk.twiiBias, risk.foreignConsecutiveSell,
      risk.foreignNet5d, risk.marginRatio, risk.limitDownCount, risk.limitDownPct,
      risk.riskScore, risk.riskLevel, risk.riskSummary,
    ).run()
    await env.KV.delete('market:risk:latest')
    console.log(`[Cron] Market risk: ${risk.riskLevel} (${risk.riskScore}/100)`)
  } catch (e) {
    console.error('[Cron] Market risk failed:', e)
  }

  // 2. ML 並行預測（Controller → Modal .map）
  if (!env.ML_CONTROLLER_URL) {
    // Fallback: 若 Controller 未部署，走舊路徑（Phase 3 過渡期）
    if (env.ML_SERVICE_URL && env.ML_QUEUE) {
      try {
        const mlHeaders: Record<string, string> = {}
        if (env.ML_SERVICE_SECRET) mlHeaders['X-Service-Token'] = env.ML_SERVICE_SECRET
        await fetch(`${env.ML_SERVICE_URL}/warmup`, { headers: mlHeaders, signal: AbortSignal.timeout(90_000) }).catch(() => {})
        await env.ML_QUEUE.send({ type: 'ml_batch', cursor: 0, triggerTime: today })
        console.log('[Cron] ML_CONTROLLER_URL not set, falling back to legacy ML_QUEUE')
      } catch (e) { console.error('[Cron] Legacy ML fallback failed:', e) }
    } else {
      console.warn('[Cron] Neither ML_CONTROLLER_URL nor ML_SERVICE_URL set, skipping ML')
    }
    return
  }

  // ── 2a. 查詢共用資料（查一次，所有股票共用）────────────────────────────────
  const marketRiskRow = await env.DB.prepare(
    'SELECT risk_level, risk_score, risk_summary FROM market_risk ORDER BY date DESC LIMIT 1'
  ).first<any>()

  const twiiPrices = await env.DB.prepare(`
    SELECT date, close FROM stock_prices
    WHERE stock_id=(SELECT id FROM stocks WHERE symbol='TAIEX' OR symbol='^TWII' LIMIT 1)
    ORDER BY date DESC LIMIT 25
  `).all<any>()
  const twiiArr = (twiiPrices.results ?? []).reverse().map((r: any) => r.close)
  const twii1d = twiiArr.length > 1 ? (twiiArr[twiiArr.length-1] - twiiArr[twiiArr.length-2]) / twiiArr[twiiArr.length-2] : 0
  const twii5d = twiiArr.length > 5 ? (twiiArr[twiiArr.length-1] - twiiArr[twiiArr.length-6]) / twiiArr[twiiArr.length-6] : 0
  const twiiMa20 = twiiArr.length >= 20 ? twiiArr.slice(-20).reduce((a: number, b: number) => a + b, 0) / 20 : twiiArr[twiiArr.length-1]
  const twiiBias20d = twiiArr.length > 0 ? (twiiArr[twiiArr.length-1] - twiiMa20) / twiiMa20 : 0

  const { results: marketHistory } = await env.DB.prepare(`
    SELECT date, risk_score, risk_level, twii_bias as market_bias_20d, twii_close
    FROM market_risk ORDER BY date ASC LIMIT 500
  `).all<any>().catch(() => ({ results: [] }))
  const marketHistoryMap: Record<string, any> = {}
  for (let i = 0; i < (marketHistory ?? []).length; i++) {
    const row = marketHistory![i]
    const prev1 = i >= 1 ? marketHistory![i - 1].twii_close : null
    const prev5 = i >= 5 ? marketHistory![i - 5].twii_close : null
    marketHistoryMap[row.date] = {
      risk_score: row.risk_score, risk_level: row.risk_level,
      market_bias_20d: row.market_bias_20d,
      market_return_1d: prev1 ? (row.twii_close - prev1) / prev1 : 0,
      market_return_5d: prev5 ? (row.twii_close - prev5) / prev5 : 0,
    }
  }

  const twToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const usSignalRaw = await env.KV.get(`us:leading:${twToday}`, 'json') as any
  const breadthResult = await env.DB.prepare(
    'SELECT date, advance_ratio, bull_alignment_pct FROM market_breadth ORDER BY date DESC LIMIT 5'
  ).all<any>().catch(() => ({ results: [] }))
  const latestBreadth = breadthResult.results?.[0]

  const { getAdaptiveParams } = await import('./lib/adaptiveConfig')
  const adaptiveParams = await getAdaptiveParams(env.KV)

  // ── 2b. 逐股查詢 + 建構 payload ──────────────────────────────────────────
  const { results: allStocks } = await env.DB.prepare(
    'SELECT * FROM stocks WHERE is_active=1 ORDER BY id ASC'
  ).all<any>()

  const payloads: any[] = []
  for (const stock of (allStocks ?? [])) {
    try {
      const [prices, indicators, chips, newsRows] = await Promise.all([
        env.DB.prepare('SELECT date, close, high, low, open, volume FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(stock.id).all<any>(),
        env.DB.prepare('SELECT date, ma5, ma10, ma20, ma60, rsi14, macd_hist as macdHist, bb_upper, bb_lower, atr14 FROM technical_indicators WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(stock.id).all<any>(),
        env.DB.prepare('SELECT date, foreign_net, trust_net, dealer_net FROM chip_data WHERE stock_id=? ORDER BY date DESC LIMIT 200').bind(stock.id).all<any>(),
        env.DB.prepare("SELECT date(published_at) as date, AVG(CASE sentiment WHEN 'positive' THEN 1 WHEN 'negative' THEN -1 ELSE 0 END) as score FROM news WHERE stock_id=? GROUP BY date(published_at) ORDER BY date DESC LIMIT 90").bind(stock.id).all<any>(),
      ])

      const { results: accRows } = await env.DB.prepare(`
        SELECT model_name, accuracy, profit_factor, expectancy,
               avg_win_pct, avg_loss_pct, avg_trade_pnl_r, hit_target_rate, hit_stop_rate
        FROM model_accuracy WHERE stock_id=? AND period='30d' AND total_count >= 5
      `).bind(stock.id).all<any>().catch(() => ({ results: [] }))

      const realAccuracies: Record<string, number> = {}
      const modelStats: Record<string, any> = {}
      for (const a of (accRows ?? [])) {
        realAccuracies[a.model_name] = a.accuracy
        modelStats[a.model_name] = {
          profit_factor: a.profit_factor, expectancy: a.expectancy,
          avg_win_pct: a.avg_win_pct, avg_loss_pct: a.avg_loss_pct,
          avg_pnl_r: a.avg_trade_pnl_r, hit_target_rate: a.hit_target_rate,
          hit_stop_rate: a.hit_stop_rate,
        }
      }

      // Per-stock: margin + retail + revenue
      const marginRow = await env.DB.prepare(
        'SELECT margin_balance, short_ratio FROM margin_data WHERE stock_id=? ORDER BY date DESC LIMIT 1'
      ).bind(stock.id).first<any>().catch(() => null)
      const margin5dAgo = await env.DB.prepare(
        'SELECT margin_balance FROM margin_data WHERE stock_id=? ORDER BY date DESC LIMIT 1 OFFSET 5'
      ).bind(stock.id).first<any>().catch(() => null)
      const retailRow = await env.DB.prepare(
        'SELECT retail_pct FROM shareholding WHERE stock_id=? ORDER BY date DESC LIMIT 1'
      ).bind(stock.id).first<any>().catch(() => null)
      const revRow = await env.DB.prepare(
        'SELECT revenue_yoy FROM monthly_revenue WHERE stock_id=? ORDER BY date DESC LIMIT 1'
      ).bind(stock.id).first<any>().catch(() => null)

      const marketEnv = {
        risk_score:      marketRiskRow?.risk_score ?? 50,
        risk_level:      marketRiskRow?.risk_level ?? 'medium',
        twii_return_1d:  twii1d,
        twii_return_5d:  twii5d,
        twii_bias_20d:   twiiBias20d,
        history:         marketHistoryMap,
        us_sox_return:     usSignalRaw?.sox_return ?? null,
        us_gspc_return:    usSignalRaw?.gspc_return ?? null,
        us_dxy_return:     usSignalRaw?.dxy_return ?? null,
        us_hy_spread:      usSignalRaw?.hy_spread ?? null,
        us_hy_spread_chg:  usSignalRaw?.hy_spread_chg ?? null,
        us_vix:            usSignalRaw?.vix_close ?? null,
        us_sentiment:      usSignalRaw?.sentiment ?? null,
        advance_ratio:     latestBreadth?.advance_ratio ?? null,
        bull_alignment_pct: latestBreadth?.bull_alignment_pct ?? null,
        revenue_yoy:       revRow?.revenue_yoy ?? null,
        margin_balance:    marginRow?.margin_balance ?? null,
        short_ratio:       marginRow?.short_ratio ?? null,
        margin_change_5d:  margin5dAgo?.margin_balance
          ? (marginRow!.margin_balance - margin5dAgo.margin_balance) / margin5dAgo.margin_balance
          : null,
        retail_pct:        retailRow?.retail_pct ?? null,
      }

      payloads.push({
        stock_id: stock.id, symbol: stock.symbol,
        prices: (prices.results ?? []).reverse(),
        indicators: (indicators.results ?? []).reverse(),
        chips: (chips.results ?? []).reverse(),
        sentiment_scores: (newsRows.results ?? []).reverse(),
        horizon: 14,
        real_accuracies: realAccuracies,
        model_stats: modelStats,
        market: stock.market ?? 'TW',
        market_env: marketEnv,
        adaptive_params: adaptiveParams,
      })
    } catch (e) {
      console.error(`[ML] Failed building payload for ${stock.symbol}:`, e)
    }
  }

  if (!payloads.length) {
    console.warn('[ML] No payloads built, skipping')
    return
  }

  // ── 2c. Controller 並行推論（Modal .map → 50 stocks in ~30s）────────────
  console.log(`[ML] Sending ${payloads.length} stocks to Controller /batch-predict...`)
  const t0 = Date.now()
  const controllerResult = await postController(env, '/batch-predict', { stocks: payloads }) as any
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  const results = controllerResult.results ?? []
  console.log(`[ML] Controller returned ${results.length} results in ${elapsed}s (${controllerResult.errors ?? 0} errors)`)

  // ── 2d. 寫入 D1 predictions + KV 快取 ─────────────────────────────────────
  let written = 0
  for (const data of results) {
    if (data.error) continue
    try {
      await env.KV.put(`ml:predict:${data.stock_id}`, JSON.stringify(data), { expirationTtl: 86400 })
      await env.DB.prepare(`
        INSERT INTO predictions
          (stock_id, model_name, generated_at, horizon, direction_accuracy,
           forecast_data, entry_price, stop_loss, target1, target2, trade_signal, feature_version)
        VALUES (?,?,datetime('now'),?,?,?,?,?,?,?,?,?)
      `).bind(
        data.stock_id, 'ensemble', 14, data.confidence ?? null,
        JSON.stringify({ signal: data.signal, models: data.models, forecasts: data.forecasts, arf_features: data.arf_features }),
        data.entry_price ?? null, data.stop_loss ?? null,
        data.target1 ?? null, data.target2 ?? null,
        data.signal?.includes('BUY') ? 'buy' : data.signal?.includes('SELL') ? 'sell' : 'hold',
        data.feature_version ?? null,
      ).run().catch((e: any) => console.warn(`[ML] D1 insert failed for ${data.symbol}:`, e?.message ?? e))
      written++
      console.log(`[ML] ${data.symbol} → ${data.signal}`)
    } catch (e) {
      console.error(`[ML] Write failed for stock_id=${data.stock_id}:`, e)
    }
  }
  console.log(`[ML] Batch predict done: ${written}/${payloads.length} written, ${elapsed}s total`)

  // ── 2e. Event-driven chain: ML complete → trigger recommendation ───────
  try {
    await runDailyRecommendation(env)
    console.log('[ML] Event-driven: triggered recommendation after ML complete')
  } catch (e) {
    console.warn('[ML] Event-driven recommendation trigger failed (cron fallback still active):', e)
  }
}

// processMLBatch removed in Phase 3 — ML batch predict now handled by Controller /batch-predict
// Legacy ML_QUEUE fallback retained in runMLAndRisk for rollback safety


// ─── Cron 3：每週日 04:00 — D1 舊資料清理 ────────────────────────────────────
// ─── Cron 5（內嵌於週日清理）：每週重訓所有股票的 ML 模型 ──────────────────
// ─── Weekly IC Audit：用資料最多的股票跑 Factor IC check ─────────────────────
async function runWeeklyICaudit(env: Bindings) {
  const ML_URL = env.ML_SERVICE_URL
  if (!ML_URL) return

  // 找資料最多的 active 股票
  const topStock = await env.DB.prepare(`
    SELECT s.id, s.symbol FROM stocks s
    JOIN stock_prices sp ON sp.stock_id=s.id
    WHERE s.is_active=1
    GROUP BY s.id ORDER BY COUNT(*) DESC LIMIT 1
  `).first<any>()
  if (!topStock) return

  const [prices, indicators, chips] = await Promise.all([
    env.DB.prepare('SELECT date, close, high, low, open, volume FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(topStock.id).all<any>(),
    env.DB.prepare('SELECT date, ma5, ma10, ma20, ma60, rsi14, macd_hist as macdHist, bb_upper, bb_lower, atr14 FROM technical_indicators WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(topStock.id).all<any>(),
    env.DB.prepare('SELECT date, foreign_net, trust_net, dealer_net FROM chip_data WHERE stock_id=? ORDER BY date DESC LIMIT 200').bind(topStock.id).all<any>(),
  ])

  const mlHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_SERVICE_SECRET) mlHeaders['X-Service-Token'] = env.ML_SERVICE_SECRET

  const res = await fetch(`${ML_URL}/factor-ic-audit`, {
    method: 'POST',
    headers: mlHeaders,
    body: JSON.stringify({
      prices: (prices.results ?? []).reverse(),
      indicators: (indicators.results ?? []).reverse(),
      chips: (chips.results ?? []).reverse(),
    }),
    signal: AbortSignal.timeout(120_000),
  })

  if (!res.ok) {
    console.warn(`[IC Audit] HTTP ${res.status}`)
    return
  }

  const data = await res.json() as any
  console.log(`[IC Audit] ${data.effective_count} effective / ${data.weak_count} weak features`)

  // 存 weak features 到 KV，ML predict 時可讀取降權
  if (data.weak_features?.length) {
    await env.KV.put('ml:weak_features', JSON.stringify(data.weak_features), { expirationTtl: 7 * 86400 })
  }

  // 存詳細結果到 D1 factor_scores
  for (const r of (data.details ?? [])) {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO factor_scores (feature, ic_mean, ic_std, icir, ic_trend, effective, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(r.feature, r.ic_mean, r.ic_std, r.icir, r.ic_trend, r.effective ? 1 : 0)
      .run().catch(() => {})
  }
}

async function runWeeklyRetrain(env: Bindings) {
  console.log('[WeeklyRetrain] Starting weekly model retraining...')

  // 共用市況
  const marketRiskRow = await env.DB.prepare(
    'SELECT risk_level, risk_score FROM market_risk ORDER BY date DESC LIMIT 1'
  ).first<any>()
  const { results: mrHistory } = await env.DB.prepare(
    'SELECT date, risk_score, risk_level, twii_bias as market_bias_20d FROM market_risk ORDER BY date DESC LIMIT 500'
  ).all<any>().catch(() => ({ results: [] }))
  const mrHistMap: Record<string, any> = {}
  for (const row of (mrHistory ?? [])) {
    mrHistMap[row.date] = { risk_score: row.risk_score, risk_level: row.risk_level, market_bias_20d: row.market_bias_20d }
  }

  const { results: stocks } = await env.DB.prepare(
    "SELECT id, symbol, market FROM stocks WHERE market IN ('TW','TWO','TWSE','OTC') AND is_active=1 ORDER BY id LIMIT 50"
  ).all<any>()

  // 建構 payloads
  const payloads: any[] = []
  for (const stock of (stocks ?? [])) {
    try {
      const [prices, indicators, chips] = await Promise.all([
        env.DB.prepare('SELECT * FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 252').bind(stock.id).all<any>(),
        env.DB.prepare('SELECT * FROM technical_indicators WHERE stock_id=? ORDER BY date DESC LIMIT 252').bind(stock.id).all<any>(),
        env.DB.prepare('SELECT * FROM chip_data WHERE stock_id=? ORDER BY date DESC LIMIT 252').bind(stock.id).all<any>(),
      ])
      if ((prices.results?.length ?? 0) < 60) continue
      payloads.push({
        stock_id: stock.id, symbol: stock.symbol,
        market: stock.market ?? 'TW',
        prices: (prices.results ?? []).reverse(),
        indicators: (indicators.results ?? []).reverse(),
        chips: (chips.results ?? []).reverse(),
        market_env: {
          risk_score: marketRiskRow?.risk_score ?? 50,
          risk_level: marketRiskRow?.risk_level ?? 'medium',
          history: mrHistMap,
        },
      })
    } catch (e) {
      console.error(`[WeeklyRetrain] Failed building payload for ${stock.symbol}:`, e)
    }
  }

  if (!payloads.length) {
    console.log('[WeeklyRetrain] No stocks to retrain')
    return
  }

  // Controller 並行重訓
  if (env.ML_CONTROLLER_URL) {
    const t0 = Date.now()
    const result = await postController(env, '/batch-retrain', { stocks: payloads }) as any
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`[WeeklyRetrain] Done: ${result.retrained}/${payloads.length} retrained in ${elapsed}s`)
  } else if (env.ML_SERVICE_URL) {
    // Legacy fallback: sequential retrain via ML Service
    let retrained = 0
    for (const p of payloads) {
      try {
        const res = await fetch(`${env.ML_SERVICE_URL}/retrain`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(env.ML_SERVICE_SECRET ? { 'X-Service-Token': env.ML_SERVICE_SECRET } : {}),
          },
          body: JSON.stringify(p),
          signal: AbortSignal.timeout(120_000),
        })
        if (res.ok) { retrained++; console.log(`[WeeklyRetrain] Retrained ${p.symbol}`) }
      } catch (e) { console.error(`[WeeklyRetrain] Failed ${p.symbol}:`, e) }
    }
    console.log(`[WeeklyRetrain] Legacy done: ${retrained} retrained`)
  } else {
    console.warn('[WeeklyRetrain] Neither ML_CONTROLLER_URL nor ML_SERVICE_URL set')
  }
}

async function runWeeklyCleanup(env: Bindings) {
  console.log('[Cleanup] Starting weekly D1 cleanup...')
  const results: string[] = []

  const run = async (label: string, sql: string) => {
    try {
      const r = await env.DB.prepare(sql).run()
      const msg = `${label}: 刪除 ${r.meta?.changes ?? 0} 筆`
      results.push(msg)
      console.log(`[Cleanup] ${msg}`)
    } catch (e) {
      console.error(`[Cleanup] ${label} failed:`, e)
    }
  }

  // 新聞：只保留 90 天（情感分析不需要更久）
  await run('news',
    "DELETE FROM news WHERE published_at < datetime('now', '-90 days')")

  // 警報通知：只保留 30 天（讀過就沒用）
  await run('alert_notifications',
    "DELETE FROM alert_notifications WHERE created_at < datetime('now', '-30 days')")

  // ML 預測記錄：只保留 1 年
  await run('predictions',
    "DELETE FROM predictions WHERE generated_at < datetime('now', '-1 year')")

  // 大盤風險：只保留 2 年
  await run('market_risk',
    "DELETE FROM market_risk WHERE date < date('now', '-2 years')")

  // 因子評分：只保留 1 年（歷史因子分析不需要太久）
  await run('factor_scores',
    "DELETE FROM factor_scores WHERE date < date('now', '-1 year')")

  // 技術指標：只保留 3 年（圖表最多拉 3 年）
  await run('technical_indicators',
    "DELETE FROM technical_indicators WHERE date < date('now', '-3 years')")

  // 股價：只保留 5 年（ML 訓練需要足夠歷史）
  await run('stock_prices',
    "DELETE FROM stock_prices WHERE date < date('now', '-5 years')")

  // 籌碼：只保留 2 年
  await run('chip_data',
    "DELETE FROM chip_data WHERE date < date('now', '-2 years')")

  // VACUUM：整理碎片空間（D1 支援）
  try {
    await env.DB.prepare('VACUUM').run()
    results.push('VACUUM 完成')
    console.log('[Cleanup] VACUUM done')
  } catch (e) {
    console.warn('[Cleanup] VACUUM failed (non-critical):', e)
  }

  console.log(`[Cleanup] Done. ${results.length} tasks completed.`)
}

async function checkAlerts(env: Bindings) {
  const { results } = await env.DB.prepare(
    'SELECT a.*, s.symbol, s.market FROM alert_rules a JOIN stocks s ON a.stock_id=s.id WHERE a.is_active=1'
  ).all<any>()

  const { fetchTWCurrentPrice } = await import('./lib/finmind')

  for (const alert of results) {
    try {
      const isTW = alert.market === 'TWSE' || alert.market === 'OTC' || /^\d{4,}/.test(alert.symbol)
      let price: number | null = null

      if (isTW && env.FINMIND_TOKEN) {
        // 台股：FinMind
        price = await fetchTWCurrentPrice(env.FINMIND_TOKEN, alert.symbol.replace(/\.TW$|\.TWO$/, ''))
      } else {
        // 美股：Yahoo
        // [CODE-REVIEW-FIX] 2026-03-23: 加 timeout 防止 Worker 無限等待
        const res  = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${alert.symbol}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8_000) })
        const json = await res.json() as any
        price = json.quoteResponse?.result?.[0]?.regularMarketPrice ?? null
      }

      if (!price) continue
      const triggered = (alert.rule_type === 'price_above' && price >= alert.threshold) ||
                        (alert.rule_type === 'price_below' && price <= alert.threshold)
      if (triggered) {
        // 停用警報
        await env.DB.prepare(
          "UPDATE alert_rules SET last_triggered=datetime('now'), is_active=0 WHERE id=?"
        ).bind(alert.id).run()

        // 寫入通知紀錄（前端 badge 讀取）
        await env.DB.prepare(`
          INSERT INTO alert_notifications
            (user_id, alert_id, stock_symbol, rule_type, threshold, triggered_price)
          VALUES (?,?,?,?,?,?)
        `).bind(
          alert.user_id, alert.id, alert.symbol,
          alert.rule_type, alert.threshold, price,
        ).run().catch(() => {})

        console.log(`[Alert] Triggered: ${alert.symbol} ${alert.rule_type} @ ${price}`)
      }
    } catch (e) { console.warn(`[Alert] ${alert.id}:`, e) }
  }
}

// ─── Wave 3：集保餘額（每週日抓 active 股票）──────────────────────────────
async function fetchWeeklyShareholding(env: Bindings): Promise<void> {
  const { fetchTWShareholding } = await import('./lib/finmind')
  const token = env.FINMIND_TOKEN
  const startDate = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)

  const { results: activeStocks } = await env.DB.prepare(
    'SELECT id, symbol FROM stocks WHERE is_active=1 ORDER BY id'
  ).all<any>()

  let count = 0
  for (const stock of (activeStocks ?? [])) {
    try {
      const rows = await fetchTWShareholding(token, stock.symbol, startDate)
      if (!rows.length) continue

      // 按日期分組
      const byDate = new Map<string, typeof rows>()
      for (const r of rows) {
        if (!byDate.has(r.date)) byDate.set(r.date, [])
        byDate.get(r.date)!.push(r)
      }

      // 取最新日期
      const latestDate = [...byDate.keys()].sort().pop()
      if (!latestDate) continue
      const latest = byDate.get(latestDate)!

      // 計算散戶占比（持股 <50 張 = <50,000 股 的級距）
      const totalShares = latest.reduce((s, r) => s + r.unit, 0)
      const totalHolders = latest.reduce((s, r) => s + r.people, 0)
      // 散戶級距：1-999, 1000-5000, 5001-10000, 10001-15000, 15001-20000, 20001-30000, 30001-40000, 40001-50000
      const retailLevels = ['1-999', '1,000-5,000', '5,001-10,000', '10,001-15,000', '15,001-20,000', '20,001-30,000', '30,001-40,000', '40,001-50,000']
      const retailShares = latest.filter(r => retailLevels.includes(r.HoldingSharesLevel)).reduce((s, r) => s + r.unit, 0)
      const retailPct = totalShares > 0 ? (retailShares / totalShares) * 100 : null
      // 大戶：>= 400 張 = >= 400,000 股
      const largeLevels = ['400,001-600,000', '600,001-800,000', '800,001-1,000,000', '1,000,001以上']
      const largeShares = latest.filter(r => largeLevels.includes(r.HoldingSharesLevel)).reduce((s, r) => s + r.unit, 0)
      const largePct = totalShares > 0 ? (largeShares / totalShares) * 100 : null

      await env.DB.prepare(`
        INSERT INTO shareholding (stock_id, date, total_shares, holder_count, retail_shares, retail_pct, large_holder_shares, large_holder_pct)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stock_id, date) DO UPDATE SET
          total_shares=excluded.total_shares, holder_count=excluded.holder_count,
          retail_shares=excluded.retail_shares, retail_pct=excluded.retail_pct,
          large_holder_shares=excluded.large_holder_shares, large_holder_pct=excluded.large_holder_pct
      `).bind(stock.id, latestDate, totalShares, totalHolders, retailShares, retailPct, largeShares, largePct).run()
      count++
      await new Promise(r => setTimeout(r, 300))  // FinMind rate limit
    } catch (e) { console.warn(`[Shareholding] ${stock.symbol} failed:`, e) }
  }
  console.log(`[Wave3] Shareholding: ${count}/${activeStocks?.length ?? 0} stocks updated`)
}

import { crawlAndStoreNews } from './lib/news'

// ─── Cron 4：每日 16:00 — 預測驗證 + 準確率更新 + 記憶更新 ─────────────────
async function runPredictionVerification(env: Bindings) {
  const { runPredictionVerification: verify } = await import('./lib/predictionVerifier')
  await verify(env)  // Phase 3: pass full env for Controller ARF feedback
}

async function runDailyRecommendation(env: Bindings) {
  const { runDailyRecommendation: rec } = await import('./lib/dailyRecommendation')
  await rec(env)
}

async function runMarketScreener(env: Bindings) {
  const { runMarketScreener: screener } = await import('./lib/marketScreener')
  return screener(env)
}

export default {
  fetch: app.fetch,

  // ── Cron 排程 ──────────────────────────────────────────────────────────────
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    const cron = event.cron
    // "0 6 * * 1-5"  → 14:00 台北 → 全市場篩選（Market Screener）
    // "5 7 * * 1-5"  → 15:05 台北 → 推第一批到 UPDATE_QUEUE
    // "0 1 * * 1-5"  → 09:00 台北 → 開盤前預熱
    // "30 7 * * 1-5" → 15:30 台北 → 大盤風險 + 推第一批到 ML_QUEUE
    // "0 20 * * 0"   → 每週日 04:00 台北 → 清理舊資料
    // ── 國定假日檢查（台股休市日不跑任何交易相關 cron）──────────────────
    const twToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
    const isHoliday = await env.KV.get(`holiday:${twToday}`)
    if (isHoliday && cron !== '0 20 * * 0') {
      // 週清理照跑，其他全跳過
      console.log(`[Cron] ${twToday} 休市（${isHoliday}），跳過 ${cron}`)
      return
    }

    // ── Cron → Task mapping（含 logging）────────────────────────────────────
    const { logCronResult } = await import('./lib/cronLogger')

    /** 包裝 cron 執行：計時 + 寫 log + catch error */
    const runWithLog = (task: string, fn: () => Promise<string>) =>
      ctx.waitUntil((async () => {
        const t0 = Date.now()
        try {
          const summary = await fn()
          await logCronResult(env.KV, task, { status: 'success', summary, duration_ms: Date.now() - t0 })
        } catch (e: any) {
          await logCronResult(env.KV, task, { status: 'error', summary: e?.message ?? 'Unknown error', duration_ms: Date.now() - t0, error: String(e) })
        }
      })())

    if (cron === '15 23 * * 1-5') {
      runWithLog('morning-setup', async () => {
        await runMorningWarmup(env)
        await setupMorningPendingBuys(env)
        const pending = await env.KV.get(`paper:pending_buys:${twToday}`)
        const count = pending ? JSON.parse(pending).length : 0
        return `預熱完成，掛單 ${count} 支`
      })
    } else if (cron === '25 7 * * 1-5') {
      runWithLog('ml-warmup', async () => {
        if (env.ML_SERVICE_URL) {
          const h: Record<string, string> = {}
          if (env.ML_SERVICE_SECRET) h['X-Service-Token'] = env.ML_SERVICE_SECRET
          const r = await fetch(`${env.ML_SERVICE_URL}/warmup`, { headers: h, signal: AbortSignal.timeout(90_000) }).catch(() => null)
          return r?.ok ? 'Cloud Run 預熱完成（models loaded）' : 'Cloud Run 預熱失敗（cron fallback 仍有效）'
        }
        return '跳過（ML_SERVICE_URL 未設定）'
      })
    } else if (cron === '0 6 * * 1-5') {
      runWithLog('screener', async () => {
        const result = await runMarketScreener(env)
        return `篩選完成：${result.hotSectors?.length ?? 0} 概念、${result.candidates?.length ?? 0} 候選股`
      })
    } else if (cron === '5 7 * * 1-5') {
      runWithLog('data-update', async () => {
        await runDailyUpdate(env)
        return '資料更新已排入 Queue'
      })
    } else if (cron === '30 7 * * 1-5') {
      runWithLog('ml-predict', async () => {
        await runMLAndRisk(env)
        return 'ML 預測 + 大盤風險完成（Controller 並行推論）'
      })
    } else if (cron === '35 7 * * 1-5') {
      runWithLog('recommendation', async () => {
        await runDailyRecommendation(env)
        const recs = await env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM daily_recommendations WHERE date=? AND has_buy_signal=1"
        ).bind(twToday).first<any>()
        return `推薦完成：${recs?.cnt ?? 0} 支 BUY signal`
      })
    } else if (cron === '0 8 * * 1-5') {
      runWithLog('verify', async () => {
        await runPredictionVerification(env)
        return '預測驗證完成'
      })
    } else if (cron === '5 8 * * 1-5') {
      runWithLog('adapt', async () => {
        const { runAdaptiveUpdate } = await import('./lib/adaptiveEngine')
        return await runAdaptiveUpdate(env)
      })
    } else if (cron === '10 6 * * 1-5') {
      runWithLog('eod-exit', async () => {
        await runEODExit(env)
        return 'EOD 出場檢查完成'
      })
    } else if (cron === '20 6 * * 1-5') {
      runWithLog('daily-snapshot', async () => {
        await runDailySnapshot(env)
        return 'Daily Snapshot 完成'
      })
    } else if (cron === '* 1-5 * * 1-5') {
      // 盤中每分鐘：寫 heartbeat（確認 cron 觸發）+ 有交易時寫 log
      ctx.waitUntil((async () => {
        await env.KV.put('cron:intraday-heartbeat', new Date(Date.now() + 8 * 3600_000).toISOString(), { expirationTtl: 3600 })
        const ordersBefore = await env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM paper_orders WHERE created_at >= ? AND side='buy'"
        ).bind(twToday).first<{ cnt: number }>()
        const before = ordersBefore?.cnt ?? 0

        await runIntradayCheck(env)

        const ordersAfter = await env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM paper_orders WHERE created_at >= ? AND side='buy'"
        ).bind(twToday).first<{ cnt: number }>()
        const after = ordersAfter?.cnt ?? 0
        if (after > before) {
          const { logCronResult } = await import('./lib/cronLogger')
          await logCronResult(env.KV, 'intraday-check', {
            status: 'success', summary: `盤中成交 ${after - before} 筆（累計 ${after} 筆）`, duration_ms: 0,
          })
        }
      })())
    } else if (cron === '30 22 * * 1-5') {
      runWithLog('us-leading', async () => {
        const { fetchAndStoreUSLeading } = await import('./lib/usLeading')
        const signal = await fetchAndStoreUSLeading(env)
        return signal ? `SOX ${((signal.sox_return ?? 0) * 100).toFixed(1)}% | ${signal.sentiment}` : '抓取失敗'
      })
    } else if (cron === '50 23 * * 1-5') {
      runWithLog('morning-briefing', async () => {
        const { generateMorningBriefing } = await import('./lib/morningBriefing')
        return await generateMorningBriefing(env)
      })
    } else if (cron === '10 8 * * 1-5') {
      runWithLog('daily-report', async () => {
        const { generateDailyReport } = await import('./lib/dailyReport')
        return await generateDailyReport(env)
      })
    } else if (cron === '0 20 * * 0') {
      runWithLog('weekly-cleanup', async () => {
        await runWeeklyCleanup(env)
        await runWeeklyRetrain(env)
        await fetchWeeklyShareholding(env).catch(e => console.warn('[Wave3] Shareholding failed:', e))
        // Weekly IC audit: 用資料最多的一支股票跑 factor IC check
        await runWeeklyICaudit(env).catch(e => console.warn('[IC Audit] failed:', e))
        // Timeverse 台股研究資料庫同步
        const { syncTimeverse } = await import('./lib/timeverse')
        await syncTimeverse(env).catch(e => console.warn('[Timeverse] sync failed:', e))
        return '週清理 + 重訓 + 集保 + IC審計 + Timeverse同步完成'
      })
    } else {
      console.warn(`[Cron] Unhandled cron expression: ${cron}`)
    }
  },

  // ── Queue Consumer：接收批次訊息，處理完立刻推下一批 ──────────────────────
  // Phase 3: ML_QUEUE 已移除（改走 Controller /batch-predict），只剩 UPDATE_QUEUE
  async queue(
    batch: MessageBatch<UpdateQueueMsg>,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await processUpdateBatch(msg.body, env)
        msg.ack()
      } catch (e) {
        console.error(`[Queue] Message failed, will retry:`, e)
        msg.retry()
      }
    }
  },
}
