import { twToday } from './lib/dateUtils'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Bindings, Variables, UpdateQueueMsg } from './types'
import { auth } from './routes/auth'
import { stocks, fetchAndStoreStockData, computeAndStoreIndicators } from './routes/stocks'
import { market, llm, watchlist, alerts, news, ml, notifications, system, recommendations, chat } from './routes/other'
import { paper, runPaperAutoTrade, setupMorningPendingBuys, runIntradayCheck, runEODExit, runDailySnapshot } from './routes/paper'

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// P3 資安：Security headers（防 XSS + clickjacking + MIME sniffing）
app.use('/api/*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('X-XSS-Protection', '1; mode=block')
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
})

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
  const { setTradingConfig, getTradingConfig, validateTradingConfig } = await import('./lib/tradingConfig')
  // 2026-04-09 fix: position 有 nested sub-object (kelly + swapWeights)，原本的淺層 spread
  // 會把 `{position: {kelly: {enabled: true}}}` 整個 swapWeights 打掉。改深層 merge。
  const current = await getTradingConfig(c.env.KV)
  const mergedPosition = {
    ...current.position,
    ...(body.position ?? {}),
    kelly:       { ...current.position.kelly,       ...(body.position?.kelly ?? {}) },
    swapWeights: { ...current.position.swapWeights, ...(body.position?.swapWeights ?? {}) },
  }
  const merged = {
    fees:       { ...current.fees,       ...body.fees },
    circuit:    { ...current.circuit,    ...body.circuit },
    exit:       { ...current.exit,       ...body.exit },
    position:   mergedPosition,
    screener:   { ...current.screener,   ...body.screener },
    rrg:        { ...current.rrg,        ...body.rrg },
    barrier:    { ...current.barrier,    ...body.barrier },
    ranking:    { ...current.ranking,    ...body.ranking },
    signal:     { ...current.signal,     ...body.signal },
    sltp:       { ...current.sltp,       ...body.sltp },
    L2_formula: { ...current.L2_formula, ...body.L2_formula },
  }
  const errors = validateTradingConfig(merged)
  if (errors.length > 0) return c.json({ error: 'Config validation failed', errors }, 400)
  await setTradingConfig(c.env.KV, merged)
  return c.json({ success: true, config: merged })
})

// ─── Admin: Push schema defaults into KV（僅補缺失 subsection） ─────────────
// 2026-04-09: 用途是補 Sprint 3+4 新加的 subsection（ranking/position.kelly/
// position.swapWeights 等）到已存在的 trading:config。不會覆蓋已存在的值。
// 使用：curl -X POST -H 'Authorization: Bearer $TOKEN' .../api/admin/config/push-defaults
app.post('/api/admin/config/push-defaults', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token || token !== c.env.STOCKVISION_AUTH_TOKEN)
    return c.json({ error: 'Unauthorized' }, 401)
  const { getTradingConfig, setTradingConfig, DEFAULT_TRADING_CONFIG } = await import('./lib/tradingConfig')
  const current = await getTradingConfig(c.env.KV)
  const d = DEFAULT_TRADING_CONFIG
  // 深層 merge：defaults 當底、current 覆蓋在上（已存在欄位保留原值）
  const filled = {
    fees:       { ...d.fees,       ...current.fees },
    circuit:    { ...d.circuit,    ...current.circuit },
    exit:       { ...d.exit,       ...current.exit },
    position: {
      ...d.position,
      ...current.position,
      kelly:       { ...d.position.kelly,       ...(current.position?.kelly ?? {}) },
      swapWeights: { ...d.position.swapWeights, ...(current.position?.swapWeights ?? {}) },
    },
    screener:   { ...d.screener,   ...current.screener },
    rrg:        { ...d.rrg,        ...current.rrg },
    barrier:    { ...d.barrier,    ...current.barrier },
    ranking:    { ...d.ranking,    ...current.ranking },
    signal:     { ...d.signal,     ...current.signal },
    sltp:       { ...d.sltp,       ...current.sltp },
    L2_formula: { ...d.L2_formula, ...current.L2_formula },
  }
  await setTradingConfig(c.env.KV, filled as any)
  return c.json({
    success: true,
    message: 'Schema defaults merged into KV (existing values preserved)',
    config: filled,
  })
})

// ─── Admin: KV 讀取（debug 用，繞過 wrangler 的 Windows UV_HANDLE_CLOSING bug）──
// 2026-04-09: wrangler kv key get 在本機 Node 17+ Windows 下會 assertion fail crash，
// 開這條路讓 debug/audit 能直接讀 KV。僅 GET、唯讀、auth required。
app.get('/api/admin/kv-get', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token || token !== c.env.STOCKVISION_AUTH_TOKEN)
    return c.json({ error: 'Unauthorized' }, 401)
  const key = c.req.query('key')
  if (!key) return c.json({ error: 'Missing ?key= param' }, 400)
  const type = (c.req.query('type') ?? 'text').toLowerCase()
  const value = type === 'json'
    ? await c.env.KV.get(key, 'json')
    : await c.env.KV.get(key, 'text')
  if (value === null) return c.json({ key, value: null, exists: false }, 404)
  return c.json({ key, value, exists: true })
})

// ─── Admin: Optuna Push (2026-04-07) ───────────────────────────────────────
// 統一閘門：所有 Optuna script 跑完透過此 endpoint 寫 KV
// 取代「local JSON → 人工 wrangler kv put」流程
//
// Body: { source: "barrier"|"signal"|"sltp"|"conformal"|"feature_window"|"risk_params"|"rrg"|"regime",
//         params: { ... },
//         meta?: { n_trials, best_score, run_id, ... } }
//
// 各 source 對應的目標 KV：
//   barrier        → trading:config.barrier
//   signal         → trading:config.signal
//   sltp           → trading:config.sltp + trading:config.exit (trail mults overlap)
//   conformal      → trading:config.L2_formula (conformal_*)
//   feature_window → trading:config.L2_formula (feature_*)
//   risk_params    → trading:config.circuit/exit (drawdown/trail/risk_pct)
//   rrg            → trading:config.rrg
//   regime         → trading:config.* per-regime（Phase B 後支援）
app.post('/api/admin/optuna-push', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token || token !== c.env.STOCKVISION_AUTH_TOKEN)
    return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<any>().catch(() => null)
  if (!body || !body.source || !body.params)
    return c.json({ error: 'Body must be { source, params, meta? }' }, 400)

  const { source, params, meta } = body

  const { getTradingConfig, setTradingConfig, validateTradingConfig } = await import('./lib/tradingConfig')
  const current = await getTradingConfig(c.env.KV)

  // 各 source 的 schema mapping + validation
  let merged: any = current
  let updatedFields: string[] = []

  switch (source) {
    case 'barrier': {
      // params: { upper_mult, lower_mult, upper_pct_cap, lower_pct_cap, max_days }
      const b = {
        upperMult:    Number(params.upper_mult ?? params.upperMult ?? current.barrier.upperMult),
        lowerMult:    Number(params.lower_mult ?? params.lowerMult ?? current.barrier.lowerMult),
        upperPctCap:  Number(params.upper_pct_cap ?? params.upperPctCap ?? current.barrier.upperPctCap),
        lowerPctCap:  Number(params.lower_pct_cap ?? params.lowerPctCap ?? current.barrier.lowerPctCap),
        maxDays:      Number(params.max_days ?? params.maxDays ?? current.barrier.maxDays),
      }
      merged = { ...current, barrier: b }
      updatedFields = Object.keys(b).map(k => `barrier.${k}`)
      break
    }
    case 'signal': {
      // params: { strong_signal_score, buy_signal_score, hold_signal_score, consensus_threshold, confidence_threshold? }
      const s = {
        strongSignalScore:   Number(params.strong_signal_score ?? current.signal.strongSignalScore),
        buySignalScore:      Number(params.buy_signal_score ?? current.signal.buySignalScore),
        holdSignalScore:     Number(params.hold_signal_score ?? current.signal.holdSignalScore),
        consensusThreshold:  Number(params.consensus_threshold ?? current.signal.consensusThreshold),
      }
      merged = { ...current, signal: s }
      updatedFields = Object.keys(s).map(k => `signal.${k}`)
      break
    }
    case 'sltp': {
      // params: { sl_mult, tp_mult, trailMultDefault, trailMultAt3pct, trailMultAt8pct,
      //          trail_switch_3pct, trail_switch_8pct, tp1SellRatio, timeStopDays, hardStopPct,
      //          slMultLow, tpMultLow, slMultHigh, tpMultHigh, volSkipThreshold }  ← Sprint 5.1
      const sltp = {
        slMultBase:        Number(params.sl_mult ?? params.slMultBase ?? current.sltp.slMultBase),
        tpMultBase:        Number(params.tp_mult ?? params.tpMultBase ?? current.sltp.tpMultBase),
        trailSwitch3pct:   Number(params.trail_switch_3pct ?? params.trailSwitch3pct ?? current.sltp.trailSwitch3pct),
        trailSwitch8pct:   Number(params.trail_switch_8pct ?? params.trailSwitch8pct ?? current.sltp.trailSwitch8pct),
        volThresholdLow:   Number(params.vol_threshold_low ?? params.volThresholdLow ?? current.sltp.volThresholdLow),
        volThresholdHigh:  Number(params.vol_threshold_high ?? params.volThresholdHigh ?? current.sltp.volThresholdHigh),
        // Sprint 5.1 Phase 7 Layer B: per-vol-branch multipliers
        slMultLow:         Number(params.sl_mult_low ?? params.slMultLow ?? current.sltp.slMultLow),
        tpMultLow:         Number(params.tp_mult_low ?? params.tpMultLow ?? current.sltp.tpMultLow),
        slMultHigh:        Number(params.sl_mult_high ?? params.slMultHigh ?? current.sltp.slMultHigh),
        tpMultHigh:        Number(params.tp_mult_high ?? params.tpMultHigh ?? current.sltp.tpMultHigh),
        // Sprint 5.1 Phase 7 Layer C: extreme low vol skip
        volSkipThreshold:  Number(params.vol_skip_threshold ?? params.volSkipThreshold ?? current.sltp.volSkipThreshold),
      }
      // exit section 也跟著更新（trailMult 跟 sltp 跨 section）
      const exit = {
        ...current.exit,
        trailMultDefault:  Number(params.trailMultDefault ?? current.exit.trailMultDefault),
        trailMultAt3pct:   Number(params.trailMultAt3pct ?? current.exit.trailMultAt3pct),
        trailMultAt8pct:   Number(params.trailMultAt8pct ?? current.exit.trailMultAt8pct),
        tp1SellRatio:      Number(params.tp1SellRatio ?? current.exit.tp1SellRatio),
        timeStopDays:      Number(params.timeStopDays ?? current.exit.timeStopDays),
        hardStopPct:       Number(params.hardStopPct ?? current.exit.hardStopPct),
      }
      merged = { ...current, sltp, exit }
      updatedFields = [...Object.keys(sltp).map(k => `sltp.${k}`), 'exit.trailMult*', 'exit.tp1SellRatio', 'exit.timeStopDays', 'exit.hardStopPct']
      break
    }
    case 'conformal': {
      // params: { coverage, min_calibration_size, max_residuals }
      // 寫進 L2_formula 的 conformal sub-fields（schema 已預留欄位 name 以 conformal_ 開頭）
      const L2 = {
        ...current.L2_formula,
        ...(params.coverage             != null && { conformal_coverage: Number(params.coverage) } as any),
        ...(params.min_calibration_size != null && { conformal_min_cal: Number(params.min_calibration_size) } as any),
        ...(params.max_residuals        != null && { conformal_max_residuals: Number(params.max_residuals) } as any),
      }
      merged = { ...current, L2_formula: L2 }
      updatedFields = ['L2_formula.conformal_*']
      break
    }
    case 'risk_params': {
      // params: { drawdown_halt, max_position_pct, trail_switch_1, trail_switch_2,
      //          trail_mult_1/2/3, risk_pct, min_hold_days }
      const circuit = {
        ...current.circuit,
        ...(params.drawdown_halt    != null && { drawdownHalt: Number(params.drawdown_halt) }),
        ...(params.max_position_pct != null && { maxPositionPct: Number(params.max_position_pct) }),
      }
      const exit = {
        ...current.exit,
        ...(params.trail_mult_1 != null && { trailMultDefault: Number(params.trail_mult_1) }),
        ...(params.trail_mult_2 != null && { trailMultAt3pct: Number(params.trail_mult_2) }),
        ...(params.trail_mult_3 != null && { trailMultAt8pct: Number(params.trail_mult_3) }),
      }
      const sltp = {
        ...current.sltp,
        ...(params.trail_switch_1 != null && { trailSwitch3pct: Number(params.trail_switch_1) }),
        ...(params.trail_switch_2 != null && { trailSwitch8pct: Number(params.trail_switch_2) }),
      }
      const position = {
        ...current.position,
        ...(params.risk_pct      != null && { riskPctPerTrade: Number(params.risk_pct) }),
        ...(params.min_hold_days != null && { swapMinHoldDays: Number(params.min_hold_days) }),
      }
      merged = { ...current, circuit, exit, sltp, position }
      updatedFields = ['circuit.drawdownHalt/maxPositionPct', 'exit.trailMult*', 'sltp.trailSwitch*', 'position.risk_pct/min_hold_days']
      break
    }
    case 'rrg': {
      // params: { leadingBonus, improvingBonus, weakeningBonus, laggingPenalty }
      const rrg = {
        leadingBonus:    Number(params.leadingBonus ?? params.leading_bonus ?? current.rrg.leadingBonus),
        improvingBonus:  Number(params.improvingBonus ?? params.improving_bonus ?? current.rrg.improvingBonus),
        weakeningBonus:  Number(params.weakeningBonus ?? params.weakening_bonus ?? current.rrg.weakeningBonus),
        laggingPenalty:  Number(params.laggingPenalty ?? params.lagging_penalty ?? current.rrg.laggingPenalty),
      }
      merged = { ...current, rrg }
      updatedFields = Object.keys(rrg).map(k => `rrg.${k}`)
      break
    }
    case 'feature_window':
    case 'regime': {
      // Phase B/C 後實作；目前先記錄但不寫 KV
      console.warn(`[OptunaPush] source=${source} not yet wired (deferred to Phase B/C)`)
      return c.json({
        success: false,
        message: `source '${source}' not yet wired`,
        deferred_to: 'Phase B/C',
      }, 501)
    }
    default:
      return c.json({ error: `Unknown source: ${source}`, allowed: ['barrier','signal','sltp','conformal','risk_params','rrg','feature_window','regime'] }, 400)
  }

  const errors = validateTradingConfig(merged)
  if (errors.length > 0) {
    return c.json({ error: 'Schema validation failed', errors, source, updatedFields }, 400)
  }

  await setTradingConfig(c.env.KV, merged)

  // Audit log
  const auditKey = `audit:optuna-push:${source}:${twToday()}`
  await c.env.KV.put(auditKey, JSON.stringify({
    source,
    params,
    meta: meta ?? null,
    updatedFields,
    pushed_at: new Date().toISOString(),
  }), { expirationTtl: 30 * 86400 })  // 30 day audit retention

  return c.json({
    success: true,
    source,
    updatedFields,
    audit_key: auditKey,
    message: `Optuna ${source} pushed to trading:config (${updatedFields.length} fields updated)`,
  })
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
  const date = c.req.query('date') ?? twToday() // TW date
  const { getCronLogs } = await import('./lib/cronLogger')
  const logs = await getCronLogs(c.env.KV, date)
  return c.json({ date, logs })
})

// ─── 2026-04-08 Part 5 Option A: cron-callback endpoint ──────────────────────
// ml-controller posts here when a fire-and-forget pipeline finishes so the
// final cron:log:pipeline status reflects ml-controller's actual completion
// rather than Worker's CF-edge-truncated view (~144s subrequest timeout).
//
// Auth: Bearer token = STOCKVISION_AUTH_TOKEN (same secret both directions).
// Body: { task: string, status: 'success'|'error', summary: string,
//         duration_ms: number, error?: string, run_id?: string }
app.post('/api/admin/cron-callback', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token || token !== c.env.STOCKVISION_AUTH_TOKEN)
    return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<any>().catch(() => null)
  if (!body || typeof body.task !== 'string' || typeof body.status !== 'string') {
    return c.json({
      error: 'Body must be { task, status, summary?, duration_ms?, error?, run_id? }',
    }, 400)
  }
  if (body.status !== 'success' && body.status !== 'error') {
    return c.json({ error: 'status must be "success" or "error"' }, 400)
  }

  const { logCronResult } = await import('./lib/cronLogger')
  await logCronResult(c.env.KV, String(body.task), {
    status: body.status,
    summary: String(body.summary ?? ''),
    duration_ms: Number(body.duration_ms ?? 0),
    error: body.error != null ? String(body.error) : undefined,
  })
  console.log(
    `[cron-callback] ${body.task} ${body.status} ` +
    `run_id=${body.run_id ?? '-'} duration=${body.duration_ms}ms`
  )
  return c.json({ ok: true, task: body.task, status: body.status })
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

// ─── Monte Carlo MDD Results（P0#5，Dashboard 用）─────────────────────────────
app.get('/api/backtest/monte-carlo', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  if (token !== c.env.STOCKVISION_AUTH_TOKEN) {
    const { verifyJWT } = await import('./lib/auth')
    const payload = await verifyJWT(token, c.env.JWT_SECRET)
    if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  }
  const row = await c.env.DB.prepare(
    'SELECT * FROM monte_carlo_results ORDER BY run_date DESC, created_at DESC LIMIT 1'
  ).first()
  return c.json(row ?? null)
})

// ─── P1#15 L2: Decision Logs ─────────────────────────────────────────────────
app.get('/api/observability/decisions', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  if (token !== c.env.STOCKVISION_AUTH_TOKEN) {
    const { verifyJWT } = await import('./lib/auth')
    const payload = await verifyJWT(token, c.env.JWT_SECRET)
    if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  }
  const date = c.req.query('date') ?? twToday()
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM decision_logs WHERE date=? ORDER BY total_score DESC'
  ).bind(date).all()
  return c.json({ date, decisions: results ?? [] })
})

// ─── P1#15 L3: Model Health ─────────────────────────────────────────────────
app.get('/api/observability/model-health', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  if (token !== c.env.STOCKVISION_AUTH_TOKEN) {
    const { verifyJWT } = await import('./lib/auth')
    const payload = await verifyJWT(token, c.env.JWT_SECRET)
    if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  }
  const date = c.req.query('date') ?? twToday()
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM model_health_daily WHERE date=? ORDER BY model_name'
  ).bind(date).all()
  return c.json({ date, models: results ?? [] })
})

// ─── PBO Results（P0#6，Dashboard 用）─────────────────────────────────────────
app.get('/api/backtest/pbo', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  if (token !== c.env.STOCKVISION_AUTH_TOKEN) {
    const { verifyJWT } = await import('./lib/auth')
    const payload = await verifyJWT(token, c.env.JWT_SECRET)
    if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  }
  const row = await c.env.DB.prepare(
    'SELECT * FROM pbo_results ORDER BY run_date DESC, created_at DESC LIMIT 1'
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
    { task: 'eod-exit',         tw_time: '13:25',       description: 'EOD 收盤前出場（13:25-13:35 TW）' },
    { task: 'daily-snapshot',   tw_time: '14:20',       description: 'PnL+Sharpe+Drawdown' },
    { task: 'pipeline',          tw_time: '17:30',       description: 'LangGraph pipeline（fetch→screener→ML→recommend→verify）' },
    { task: 'ml-warmup',        tw_time: '17:50',       description: 'Cloud Run 預熱（pipeline 前）' },
    { task: 'adapt',            tw_time: '18:20',       description: '自適應參數更新' },
    { task: 'daily-report',     tw_time: '18:25',       description: '收盤報告 Discord' },
    { task: 'obsidian-daily',   tw_time: '18:40',       description: 'Obsidian 日誌 + progress.md' },
    { task: 'weekly-cleanup',   tw_time: '週日 04:00',  description: '清理+重訓+集保+IC+Timeverse' },
    { task: 'weekly-backtest',  tw_time: '週日 06:00',  description: '自動回測 + MC MDD + PBO' },
  ]
  return c.json({ schedule })
})

// ─── Admin: Sprint 6a.7 parity test endpoint ────────────────────────────────
// Used by ml-controller tests/test_cascade_parity.py to verify that
// backtest_engine.py step_position_one_bar() returns identical decisions to
// paper.ts checkExitConditions() for the same inputs. Stateless — no D1/KV writes.
// See memory/project_backtest_engine_design_rationale.md section 4.
app.post('/api/admin/test/exit-cascade', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token || token !== c.env.STOCKVISION_AUTH_TOKEN)
    return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<any>().catch(() => null)
  if (!body || !body.position || body.currentPrice == null || body.atr14 == null) {
    return c.json({
      error: 'Body must be { position, currentPrice, atr14, hasMlSell?, isEOD?, cfg? }',
    }, 400)
  }

  const { checkExitConditions } = await import('./routes/paper')
  const { getTradingConfig } = await import('./lib/tradingConfig')

  // Allow caller to supply partial cfg override; fall back to KV production cfg
  const baseCfg = await getTradingConfig(c.env.KV)
  const cfg = body.cfg ? { ...baseCfg, ...body.cfg } : baseCfg

  try {
    const decision = checkExitConditions(
      body.position,
      Number(body.currentPrice),
      Number(body.atr14),
      Boolean(body.hasMlSell ?? false),
      Boolean(body.isEOD ?? true),
      cfg,
    )
    // Normalize for parity comparison: return a stable shape
    return c.json({
      action: decision.action,
      reason: decision.reason,
      reason_category: _categorizeExitReason(decision.reason),
      sellShares: decision.sellShares ?? null,
      newTrailingStop: decision.newTrailingStop ?? null,
      newHighest: decision.newHighest ?? null,
      moveStopToEntry: decision.moveStopToEntry ?? false,
    })
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, 500)
  }
})

// Local helper to categorize reasons for parity comparison (matches Python _exit_category)
function _categorizeExitReason(reason: string): string {
  if (reason.includes('硬上限') || reason.includes('HardStop')) return 'HardStop'
  if (reason.includes('ATR 初始止損') || reason.includes('InitStop')) return 'InitStop'
  if (reason.includes('Trailing Stop') || reason.includes('TrailStop')) return 'TrailStop'
  if (reason.includes('ML SELL')) return 'ML_SELL'
  if (reason.includes('TP2')) return 'TP2'
  if (reason.includes('TP1')) return 'TP1'
  if (reason.includes('時間止損') || reason.includes('TimeStop')) return 'TimeStop'
  if (reason.includes('trailing update')) return 'HoldTrailingUpdate'
  return 'HoldNoTrigger'
}

// Phase 5.2 (2026-04-08 audit): simulateTrade parity test endpoint
// Body: { direction: 'up'|'down', entry, stop, target1, target2, bars: [{open,high,low,close}] }
app.post('/api/admin/test/simulate-trade', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token || token !== c.env.STOCKVISION_AUTH_TOKEN)
    return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<any>().catch(() => null)
  if (!body || !body.direction || body.entry == null || body.stop == null
      || body.target1 == null || body.target2 == null || !Array.isArray(body.bars)) {
    return c.json({
      error: 'Body must be { direction: "up"|"down", entry, stop, target1, target2, bars: [...] }',
    }, 400)
  }

  try {
    const { simulateTrade } = await import('./lib/predictionVerifier')
    const result = simulateTrade(
      body.direction,
      Number(body.entry),
      Number(body.stop),
      Number(body.target1),
      Number(body.target2),
      body.bars,
    )
    return c.json(result)
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, 500)
  }
})

// Sprint 6a.7b (2026-04-08): scoreMultiFactor parity test endpoint
// Body: { prices: FMStockPrice[], chips: [{date, foreign, trust}], marketReturn5d, cfg?: Partial<TradingConfig> }
// Returns { base_score, chip_score, tech_score, momentum_score, reasons }
app.post('/api/admin/test/score-multi-factor', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token || token !== c.env.STOCKVISION_AUTH_TOKEN)
    return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<any>().catch(() => null)
  if (!body || !Array.isArray(body.prices) || body.marketReturn5d == null) {
    return c.json({
      error: 'Body must be { prices: FMStockPrice[], chips?: [{date,foreign,trust}], marketReturn5d, cfg? }',
    }, 400)
  }

  try {
    const { scoreMultiFactor } = await import('./lib/marketScreener')
    const { getTradingConfig } = await import('./lib/tradingConfig')

    const baseCfg = await getTradingConfig(c.env.KV)
    const cfg = body.cfg ? { ...baseCfg, ...body.cfg, screener: { ...baseCfg.screener, ...(body.cfg.screener ?? {}) } } : baseCfg

    // Build chipDates map (same shape as internal loadMarketDataFromD1 output)
    let chipDates: Map<string, { foreign: number; trust: number }> | undefined
    if (Array.isArray(body.chips) && body.chips.length > 0) {
      chipDates = new Map()
      for (const c of body.chips) {
        chipDates.set(String(c.date), { foreign: Number(c.foreign ?? 0), trust: Number(c.trust ?? 0) })
      }
    }

    const prices = body.prices as any[]
    const latestClose = Number(prices[prices.length - 1]?.close ?? 0)

    const result = scoreMultiFactor(
      prices as any,
      chipDates,
      Number(body.marketReturn5d),
      latestClose,
      cfg,
    )
    return c.json(result)
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, 500)
  }
})

// ─── Admin: 手動觸發 cron 任務（STOCKVISION_AUTH_TOKEN 驗證 + Rate Limit）───
app.post('/api/admin/trigger/:task', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token || token !== c.env.STOCKVISION_AUTH_TOKEN)
    return c.json({ error: 'Unauthorized' }, 401)

  // Rate limiting: 100 req/hr per token（防 API 濫用 → D1 寫入爆量 + Cloud Run 帳單飆升）
  const rlKey = `ratelimit:admin:${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 13)}`
  const rlCount = parseInt(await c.env.KV.get(rlKey) ?? '0')
  if (rlCount >= 100) return c.json({ error: 'Rate limit exceeded (100/hr)' }, 429)
  await c.env.KV.put(rlKey, String(rlCount + 1), { expirationTtl: 3600 })

  const task = c.req.param('task')

  // ── 非交易日防呆：週末+國定假日，資料寫入類 task 全擋（加 ?force=1 繞過）──
  const DATA_TASKS = new Set(['screener', 'update', 'ml', 'recommendation', 'paper-trade', 'morning-setup', 'intraday-check', 'eod-exit', 'pipeline', 'adapt'])
  if (DATA_TASKS.has(task) && !c.req.query('force')) {
    const twNow = new Date(Date.now() + 8 * 3600_000)
    const dayOfWeek = twNow.getUTCDay() // 0=Sun, 6=Sat
    const twDate = twNow.toISOString().slice(0, 10)
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
    const isHoliday = await c.env.KV.get(`holiday:${twDate}`)
    if (isWeekend || isHoliday) {
      return c.json({ error: `非交易日（${isWeekend ? '週末' : isHoliday}），跳過 ${task}。加 ?force=1 強制執行。` }, 400)
    }
  }

  const taskMap: Record<string, () => Promise<any>> = {
    screener:      () => runMarketScreener(c.env),
    update:        () => runDailyUpdate(c.env, !!c.req.query('force')),
    ml:            () => runMLAndRiskV2(c.env),
    'ml-legacy':   () => runMLAndRisk(c.env),  // 2026-04-07 LangGraph A+B 重構前舊版，保留 fallback 1 週
    recommendation:() => runDailyRecommendation(c.env),
    'paper-trade': () => runPaperAutoTrade(c.env),
    'morning-setup': () => setupMorningPendingBuys(c.env),
    'intraday-check': () => {
      // 防呆：非交易時間不執行（避免手動觸發造成異常成交）
      const h = (new Date().getUTCHours() + 8) % 24
      const m = new Date().getUTCMinutes()
      const open = h >= 9 && (h < 13 || (h === 13 && m <= 30))
      if (!open && !c.req.query('force')) return Promise.resolve('SKIPPED: 非交易時間（加 ?force=1 強制）')
      return runIntradayCheck(c.env)
    },
    'eod-exit': () => {
      // 防呆：只在 13:25~13:35 TW 執行（收盤前最後出場窗口）
      // 台股 13:30 收盤，BOT 應在收盤前出場，不依賴盤後定價（不保證成交）
      const h = (new Date().getUTCHours() + 8) % 24
      const m = new Date().getUTCMinutes()
      const twTime = h * 100 + m  // e.g. 1325
      const validEod = twTime >= 1325 && twTime <= 1335
      if (!validEod && !c.req.query('force')) return Promise.resolve('SKIPPED: 非 EOD 時段 13:25-13:35 TW（加 ?force=1 強制）')
      return runEODExit(c.env)
    },
    'daily-snapshot': () => runDailySnapshot(c.env),
    warmup:        () => runMorningWarmup(c.env),
    'morning-briefing': async () => { const { generateMorningBriefing } = await import('./lib/morningBriefing'); return generateMorningBriefing(c.env) },
    'daily-report':     async () => { const { generateDailyReport } = await import('./lib/dailyReport'); return generateDailyReport(c.env) },
    'obsidian-daily':   async () => {
      if (!c.env.ML_CONTROLLER_URL) return 'SKIP: ML_CONTROLLER_URL not set'
      const headers: Record<string,string> = { 'Content-Type': 'application/json' }
      if (c.env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = c.env.ML_CONTROLLER_SECRET
      const twDate = twToday()
      const res = await fetch(`${c.env.ML_CONTROLLER_URL}/obsidian/daily`, { method: 'POST', headers, body: JSON.stringify({ date: twDate }), signal: AbortSignal.timeout(60000) })
      return res.ok ? await res.json() : `HTTP ${res.status}`
    },
    'weekly-audit':     () => runWeeklyAudit(c.env),
    'timeverse-sync':   async () => { const { syncTimeverse } = await import('./lib/timeverse'); return syncTimeverse(c.env) },
    'us-leading':       async () => { const { fetchAndStoreUSLeading } = await import('./lib/usLeading'); return fetchAndStoreUSLeading(c.env) },
    'adapt':            async () => { const { runAdaptiveUpdate } = await import('./lib/adaptiveEngine'); return runAdaptiveUpdate(c.env) },
    // Phase 5.5 (2026-04-08 audit): V1 verify kept as manual backup during dual-run
    'verify':           async () => { await runPredictionVerification(c.env); return 'V1 verify 完成' },
    // Phase 5.5 V2: trigger ml-controller LangGraph verify pipeline manually
    'verify-v2':        async () => {
      if (!c.env.ML_CONTROLLER_URL) return 'SKIP: ML_CONTROLLER_URL not set'
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (c.env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = c.env.ML_CONTROLLER_SECRET
      const res = await fetch(`${c.env.ML_CONTROLLER_URL}/verify/run`, {
        method: 'POST', headers,
        body: JSON.stringify({ lookback_days: 5, limit: 200 }),
        signal: AbortSignal.timeout(280_000),
      })
      if (!res.ok) return `HTTP ${res.status}: ${await res.text()}`
      return await res.json()
    },
    'reclassify-tags':  async () => { const { reclassifyTags } = await import('./lib/tagReclassifier'); return reclassifyTags(c.env) },
    'sync-industries':  async () => { const { syncIndustryTags } = await import('./lib/twseApi'); return syncIndustryTags(c.env.DB, c.env.KV) },
    // 'backfill-rrg' trigger removed in Phase 6.6 of 4/8 audit along with
    // marketScreener's Z-score RRG. Backfill now lives in ml-controller.
    'factor-ic':        async () => { const { calcFactorIC } = await import('./lib/marketScreener'); return calcFactorIC(c.env) },
    'mae-analysis':     async () => { const { analyzeMAE } = await import('./lib/marketScreener'); return analyzeMAE(c.env) },
    // ── 完整 Pipeline：依序等待每步完成（呼叫模組級 runFullPipeline 共用 helper）──
    pipeline: () => runFullPipeline(c.env),
    backtest: () => runWeeklyBacktest(c.env),
    'monte-carlo': () => runWeeklyMonteCarlo(c.env),
    pbo: () => runWeeklyPBO(c.env),
    lifecycle: () => runWeeklyLifecycleCheck(c.env),
    'monthly-optuna': () => runMonthlyOptunaResearch(c.env),
  }
  const fn = taskMap[task]
  if (!fn) return c.json({ error: `Unknown task: ${task}`, available: Object.keys(taskMap) }, 400)

  const { logCronResult } = await import('./lib/cronLogger')

  // Fix 2026-04-07: long-running tasks 用 executionCtx.waitUntil 在背景跑
  // 避免 CF Worker fetch handler ~5 分鐘 wall-clock limit 把 ML predict 砍掉
  // Caller 改為 poll D1（predictions / daily_recommendations）或 KV cron log 確認完成
  //
  // Bug fix 2026-04-07 (M5): waitUntil 預算 ~30 sec，real long-running 跑不完。
  // 加 ?sync=1 走 sync mode：caller 等 fetch handler runtime（wall clock 數十分鐘
  // 都 OK，只要中間都在 await fetch 不是 CPU bound），用於手動補資料場景。
  const syncMode = c.req.query('sync') === '1'
  const LONG_RUNNING = new Set(['pipeline', 'ml', 'update', 'recommendation', 'screener', 'backtest', 'monte-carlo', 'pbo', 'monthly-optuna'])
  if (LONG_RUNNING.has(task) && !syncMode) {
    const t0 = Date.now()
    await logCronResult(c.env.KV, task, { status: 'success', summary: 'started (background)', duration_ms: 0 })
    c.executionCtx.waitUntil((async () => {
      try {
        const result = await fn()
        const summary = typeof result === 'string' ? result : JSON.stringify(result)?.slice(0, 200) ?? ''
        await logCronResult(c.env.KV, task, { status: 'success', summary, duration_ms: Date.now() - t0 })
      } catch (e: any) {
        await logCronResult(c.env.KV, task, { status: 'error', summary: e?.message ?? 'Unknown error', duration_ms: Date.now() - t0, error: String(e) })
      }
    })())
    return c.json({ success: true, message: `${task} 已啟動（背景執行，poll cron log）`, triggered_at: new Date().toISOString(), mode: 'async' })
  }

  // 短任務同步執行 + 寫 cron log
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

// [REMOVED] debug-chips endpoint — FinMind fully deprecated, replaced by TWSE/TPEX bulk APIs

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

  // 取得今日當沖標的清單 → KV（paper.ts 盤中用來判斷可否同日賣出）
  try {
    const { fetchDayTradeEligible } = await import('./lib/twseApi')
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

// ─── Cron 1a：15:05 TW — Bulk Fetch（全市場 prices+chips → D1）──────────────
async function runBulkFetch(env: Bindings, force = false) {
  const twDate = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const lockKey = `cron:bulk-fetch:${twDate}`
  if (!force && await env.KV.get(lockKey)) {
    console.log(`[Cron] Bulk fetch already done today (${twDate}), skipping.`)
    return
  }

  try {
    const { bulkFetchAndStoreChipData, bulkFetchAndStorePrices } = await import('./lib/twseApi')
    const [{ chipCount, marginCount }, priceCount] = await Promise.all([
      bulkFetchAndStoreChipData(env.DB, twDate, env.SHIOAJI_PROXY_URL, env.ML_CONTROLLER_SECRET),
      bulkFetchAndStorePrices(env.DB, twDate),
    ])
    console.log(`[Cron] Bulk: ${priceCount} prices + ${chipCount} chips + ${marginCount} margins`)
    // Bug fix 2026-04-07: 0 row 不寫 lock，避免下次 cron 早退（assumes done）
    // 真實案例：早 cron 在 TWSE 釋出 4/7 收盤前跑 → priceCount=0 → 寫 lock →
    // 17:30 pipeline cron 看到 lock 直接 skip → pipeline error "stock_prices 0 rows"
    if (priceCount === 0) {
      console.warn(`[Cron] priceCount=0 for ${twDate} → NOT writing lock (will retry next trigger)`)
    } else {
      await env.KV.put(lockKey, '1', { expirationTtl: 86400 })
    }
  } catch (e) {
    console.warn('[Cron] Bulk fetch failed:', e)
  }

  // Wave 2：月營收 + 大盤廣度（並行）
  const triggerTime = twDate
  await fetchWave2Data(env, triggerTime).catch(e => console.warn('[Wave2] failed:', e))
}

// ─── Cron 1b：15:15 TW — Queue Update（篩後候選股 Yahoo+指標+新聞）─────────
async function runQueueUpdate(env: Bindings) {
  const triggerTime = new Date().toISOString().split('T')[0]
  const lockKey = `cron:queue-update:${triggerTime}`
  if (await env.KV.get(lockKey)) {
    console.log(`[Cron] Queue update already triggered today, skipping.`)
    return
  }

  // Bug fix 2026-04-07: lock 只在 send 成功後寫，避免 send 失敗仍 lock 整天
  console.log('[Cron] Kicking off Queue update for screened candidates...')
  try {
    await env.UPDATE_QUEUE.send({ type: 'update_batch', cursor: 0, triggerTime })
    await env.KV.put(lockKey, '1', { expirationTtl: 86400 })
  } catch (e) {
    console.warn('[Cron] Queue update send failed, NOT writing lock:', e)
    throw e
  }
}

// ─── Legacy wrapper（admin trigger 用）────────────────────────────────────────
async function runDailyUpdate(env: Bindings, force = false) {
  await runBulkFetch(env, force)
  await runQueueUpdate(env)
}

// ─── Wave 2 數據：PER/PBR + 月營收 + 大盤廣度（全部改用 TWSE/TPEX 官方 API）──
async function fetchWave2Data(env: Bindings, today: string): Promise<void> {
  const { fetchTwseValuation, fetchTpexValuation, fetchTwseMonthlyRevenue, fetchTpexMonthlyRevenue, fetchMarketBreadth, fetchTwseFinancials, fetchTpexFinancials, fetchExDividendForecast, fetchAttentionStocks } = await import('./lib/twseApi')

  // ── 大盤廣度（TWSE opendata，不需 FinMind）──────────────────────────
  try {
    const breadth = await fetchMarketBreadth()
    if (breadth) {
      await env.DB.prepare(`
        INSERT INTO market_breadth (date, advance_count, decline_count, unchanged_count, advance_ratio)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          advance_count=excluded.advance_count, decline_count=excluded.decline_count,
          unchanged_count=excluded.unchanged_count, advance_ratio=excluded.advance_ratio
      `).bind(breadth.date, breadth.advance_count, breadth.decline_count, breadth.unchanged_count, breadth.advance_ratio).run()
      console.log(`[Wave2] Market breadth: ${breadth.advance_count}↑ ${breadth.decline_count}↓ ${breadth.unchanged_count}→ (${(breadth.advance_ratio*100).toFixed(0)}%)`)
    }
  } catch (e) { console.warn('[Wave2] Market breadth failed:', e) }

  // ── PER/PBR/殖利率（TWSE + TPEX）──────────────────────────────────
  try {
    const [twseVal, tpexVal] = await Promise.allSettled([fetchTwseValuation(today), fetchTpexValuation()])
    const valRows = [
      ...(twseVal.status === 'fulfilled' ? twseVal.value : []),
      ...(tpexVal.status === 'fulfilled' ? tpexVal.value : []),
    ]
    if (valRows.length) {
      // 取當前季度（e.g. 2026Q1）
      const twNow = new Date(Date.now() + 8 * 3600_000)
      const currentQ = `${twNow.getFullYear()}Q${Math.ceil((twNow.getMonth() + 1) / 3)}`

      const stmts = valRows
        .filter(v => v.pe !== null || v.pb !== null || v.dividend_yield !== null)
        .flatMap(v => [
          // 先嘗試 UPDATE 最新 Q 記錄
          env.DB.prepare(`
            UPDATE financials SET pe=?, pb=?, dividend_yield=?
            WHERE stock_id = (SELECT id FROM stocks WHERE symbol=?)
            AND period = (SELECT MAX(period) FROM financials WHERE stock_id = (SELECT id FROM stocks WHERE symbol=?) AND period LIKE '%Q%')
          `).bind(v.pe, v.pb, v.dividend_yield, v.symbol, v.symbol),
          // 如果沒有 Q 記錄（OTC 等），INSERT 一筆
          env.DB.prepare(`
            INSERT INTO financials (stock_id, period, period_type, pe, pb, dividend_yield)
            SELECT s.id, ?, 'quarterly', ?, ?, ?
            FROM stocks s WHERE s.symbol = ?
            AND NOT EXISTS (SELECT 1 FROM financials f WHERE f.stock_id = s.id AND f.period LIKE '%Q%')
          `).bind(currentQ, v.pe, v.pb, v.dividend_yield, v.symbol),
        ])
      for (let i = 0; i < stmts.length; i += 50) {
        await env.DB.batch(stmts.slice(i, i + 50))
      }
      console.log(`[Wave2] PER/PBR: ${valRows.length} stocks (TWSE ${twseVal.status === 'fulfilled' ? twseVal.value.length : 0} + TPEX ${tpexVal.status === 'fulfilled' ? tpexVal.value.length : 0})`)
    }
  } catch (e) { console.warn('[Wave2] PER/PBR failed:', e) }

  // ── 月營收（TWSE + TPEX opendata，每月前 12 天抓）──────────────────
  const day = parseInt(today.slice(8, 10))
  if (day <= 12) {
    try {
      const [twseRev, tpexRev] = await Promise.allSettled([fetchTwseMonthlyRevenue(), fetchTpexMonthlyRevenue()])
      const revData = [
        ...(twseRev.status === 'fulfilled' ? twseRev.value : []),
        ...(tpexRev.status === 'fulfilled' ? tpexRev.value : []),
      ]
      if (revData.length) {
        const stmts = revData.map(r =>
          env.DB.prepare(`
            INSERT INTO monthly_revenue (stock_id, date, revenue, revenue_yoy, revenue_mom)
            SELECT s.id, ?, ?, ?, ?
            FROM stocks s WHERE s.symbol = ?
            ON CONFLICT(stock_id, date) DO UPDATE SET
              revenue=excluded.revenue, revenue_yoy=excluded.revenue_yoy, revenue_mom=excluded.revenue_mom
          `).bind(r.year_month, r.revenue, r.revenue_yoy, r.revenue_mom, r.symbol)
        )
        for (let i = 0; i < stmts.length; i += 50) {
          await env.DB.batch(stmts.slice(i, i + 50))
        }
        console.log(`[Wave2] Monthly revenue: ${revData.length} entries (TWSE ${twseRev.status === 'fulfilled' ? twseRev.value.length : 0} + TPEX ${tpexRev.status === 'fulfilled' ? tpexRev.value.length : 0})`)
      }
    } catch (e) { console.warn('[Wave2] Monthly revenue failed:', e) }
  }

  // ── 財報 EPS/ROE（TWSE + TPEX opendata，季報更新時才有新資料）──────
  try {
    const [twseFin, tpexFin] = await Promise.allSettled([fetchTwseFinancials(), fetchTpexFinancials()])
    const finRows = [
      ...(twseFin.status === 'fulfilled' ? twseFin.value : []),
      ...(tpexFin.status === 'fulfilled' ? tpexFin.value : []),
    ]
    if (finRows.length) {
      const stmts = finRows
        .filter(f => f.eps !== null)
        .map(f => {
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
          `).bind(period, f.eps, f.revenue, f.roe, f.operating_income, f.net_income, f.total_assets, f.total_liabilities, f.symbol)
        })
      for (let i = 0; i < stmts.length; i += 50) {
        await env.DB.batch(stmts.slice(i, i + 50))
      }
      console.log(`[Wave2] Financials: ${finRows.length} entries (TWSE+TPEX opendata EPS+ROE)`)
    }
  } catch (e) { console.warn('[Wave2] Financials failed:', e) }

  // ── 除權除息 + 注意股（透過 Controller proxy，避免 CF Worker IP 被 TWSE 擋）──
  if (env.ML_CONTROLLER_URL) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

    try {
      const res = await fetch(`${env.ML_CONTROLLER_URL}/twse/ex-dividend`, { headers, signal: AbortSignal.timeout(30000) })
      if (res.ok) {
        const exDivRows = await res.json() as any[]
        if (exDivRows.length) {
          await env.KV.put('market:ex_dividend_forecast', JSON.stringify(exDivRows), { expirationTtl: 86400 })
          console.log(`[Wave2] Ex-dividend (via Controller): ${exDivRows.length} entries`)
        }
      }
    } catch (e) { console.warn('[Wave2] Ex-dividend proxy failed:', e) }

    try {
      const res = await fetch(`${env.ML_CONTROLLER_URL}/twse/attention-stocks`, { headers, signal: AbortSignal.timeout(30000) })
      if (res.ok) {
        const attentionSymbols = await res.json() as string[]
        if (attentionSymbols.length) {
          await env.KV.put('market:attention_stocks', JSON.stringify(attentionSymbols), { expirationTtl: 86400 })
          console.log(`[Wave2] Attention stocks (via Controller): ${attentionSymbols.length} symbols`)
        }
      }
    } catch (e) { console.warn('[Wave2] Attention stocks proxy failed:', e) }
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
      // 價格：只在歷史不足 20 筆時 fetch Yahoo（每日 TWSE bulk 已處理當日價格）
      const priceCount = await env.DB.prepare(
        'SELECT COUNT(*) as cnt FROM stock_prices WHERE stock_id=?'
      ).bind(stock.id).first<{ cnt: number }>()
      if ((priceCount?.cnt ?? 0) < 20) {
        await fetchAndStoreStockData(env.DB, env.KV, stock, env.FINMIND_TOKEN)
      }
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
  // C3: KV lock — prevent concurrent ML predict runs (cron + event-driven overlap)
  // Fix 2026-04-07: TTL 600→120s（防 wall-clock kill 時 lock 殘留 10 分鐘）+ try/finally cleanup
  const twDate = twToday()
  const lockKey = `lock:ml-predict:${twDate}`
  const existing = await env.KV.get(lockKey)
  if (existing) { console.log('[ML] Already running, skip'); return 'LOCKED' }
  await env.KV.put(lockKey, '1', { expirationTtl: 120 })

  try {
  console.log(`[Cron] Starting market risk + ML batch predict... (controller=${env.ML_CONTROLLER_URL ? 'SET' : 'NOT_SET'}, mlService=${env.ML_SERVICE_URL ? 'SET' : 'NOT_SET'})`)

  // 1. 大盤風險（直接執行，速度快）
  try {
    const { calcMarketRisk } = await import('./lib/marketRisk')
    const risk = await calcMarketRisk(env.DB, env.ANTHROPIC_API_KEY, env.ML_CONTROLLER_URL, env.ML_CONTROLLER_SECRET)
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

  // 2. ML 並行預測（Worker → Controller → Modal）
  if (!env.ML_CONTROLLER_URL) {
    console.warn('[ML] ML_CONTROLLER_URL not set — skipping ML predict. Deploy Controller to Cloud Run first.')
    // 仍然觸發 recommendation（用 screener 分數，ML=0）
    try {
      await runDailyRecommendation(env)
    } catch (e) { console.warn('[ML] recommendation fallback failed:', e) }
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

  // twDate already declared at top of runMLAndRisk via twToday()
  const usSignalRaw = await env.KV.get(`us:leading:${twDate}`, 'json') as any
  const breadthResult = await env.DB.prepare(
    'SELECT date, advance_ratio, bull_alignment_pct FROM market_breadth ORDER BY date DESC LIMIT 5'
  ).all<any>().catch(() => ({ results: [] }))
  const latestBreadth = breadthResult.results?.[0]

  const { getAdaptiveParams } = await import('./lib/adaptiveConfig')
  const adaptiveParams = await getAdaptiveParams(env.KV)

  // Read trading config for barrier params (Optuna #1 searchable via KV)
  const { getTradingConfig } = await import('./lib/tradingConfig')
  const tradingCfg = await getTradingConfig(env.KV)

  // P1#8: Read lifecycle weight overrides from D1
  let lifecycleWeights: Record<string, number> = {}
  try {
    const lcRow = await env.DB.prepare('SELECT state_json FROM model_lifecycle_state WHERE id=1').first<any>()
    if (lcRow?.state_json) {
      const states = JSON.parse(lcRow.state_json)
      for (const [name, s] of Object.entries(states as Record<string, any>)) {
        if (s.weight_mult != null && s.weight_mult !== 1.0) {
          lifecycleWeights[name] = s.weight_mult
        }
      }
      if (Object.keys(lifecycleWeights).length > 0) {
        console.log(`[ML] Lifecycle weights active: ${JSON.stringify(lifecycleWeights)}`)
      }
    }
  } catch (e) { console.warn('[ML] Lifecycle weights read failed:', e) }

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
        env.DB.prepare('SELECT date, foreign_net, trust_net, dealer_net FROM chip_data WHERE symbol=? ORDER BY date DESC LIMIT 200').bind(stock.symbol).all<any>(),
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
        lifecycle_weights: lifecycleWeights,
        barrier_params: {
          upper_mult: tradingCfg.barrier.upperMult,
          lower_mult: tradingCfg.barrier.lowerMult,
          upper_pct_cap: tradingCfg.barrier.upperPctCap,
          lower_pct_cap: tradingCfg.barrier.lowerPctCap,
          max_days: tradingCfg.barrier.maxDays,
        },
      })
    } catch (e) {
      console.error(`[ML] Failed building payload for ${stock.symbol}:`, e)
    }
  }

  if (!payloads.length) {
    console.warn('[ML] No payloads built, skipping')
    return
  }

  // ── 2c. Controller 一次性推論 ──────────────────────────────────────────────
  // 2026-04-07 F3: 砍掉 BATCH_SIZE=20 序列分批
  // 之前序列分批是「worker 端排程」，但 worker await 每批 = 序列等待
  // 改成一次扔全部 stocks 給 controller，讓 modal.map() 內部真並行（max_containers=20）
  // 預期 33 stocks: ~50-70s vs 之前 169s+524 timeout
  const t0 = Date.now()
  const results: any[] = []
  console.log(`[ML] Sending ${payloads.length} stocks (single batch, controller-side parallel)`)
  try {
    const batchResult = await postController(env, '/batch-predict', { stocks: payloads }, 600_000) as any
    results.push(...(batchResult.results ?? []))
    console.log(`[ML] All done: ${results.length}/${payloads.length}`)
  } catch (e: any) {
    console.error(`[ML] Batch predict failed: ${e.message}`)
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`[ML] All batches done: ${results.length}/${payloads.length} in ${elapsed}s`)

  // ── 2d. 寫入 D1 predictions + KV 快取 ─────────────────────────────────────
  let written = 0
  for (const data of results) {
    if (data.error) continue
    try {
      await env.KV.put(`ml:predict:${data.stock_id}`, JSON.stringify(data), { expirationTtl: 86400 })
      // trade_signal: 簡化版（buy/sell/hold）保留向下相容
      // signal_raw: ensemble 原始 signal（STRONG_BUY/BUY/HOLD/SELL/STRONG_SELL/NO_SIGNAL）
      const rawSignal = data.signal ?? 'NO_SIGNAL'
      // NO_SIGNAL → null（跳過，不寫 trade_signal）
      const tradeSignal = rawSignal.includes('BUY') ? 'buy'
        : rawSignal.includes('SELL') ? 'sell'
        : rawSignal === 'NO_SIGNAL' ? null
        : 'hold'
      // H2: Delete stale prediction for same stock+model+date before INSERT (prevent duplicates)
      await env.DB.prepare(
        `DELETE FROM predictions WHERE stock_id=? AND model_name='ensemble' AND date(generated_at)=date('now')`
      ).bind(data.stock_id).run().catch(() => {})
      await env.DB.prepare(`
        INSERT INTO predictions
          (stock_id, model_name, generated_at, horizon, direction_accuracy,
           forecast_data, entry_price, stop_loss, target1, target2, trade_signal, feature_version, signal_raw)
        VALUES (?,?,datetime('now'),?,?,?,?,?,?,?,?,?,?)
      `).bind(
        data.stock_id, 'ensemble', 14, data.confidence ?? null,
        JSON.stringify({ signal: rawSignal, models: data.models, forecasts: data.forecasts, arf_features: data.arf_features }),
        data.entry_price ?? null, data.stop_loss ?? null,
        data.target1 ?? null, data.target2 ?? null,
        tradeSignal,
        data.feature_version ?? null,
        rawSignal,  // 保留原始 signal
      ).run().catch((e: any) => console.warn(`[ML] D1 insert failed for ${data.symbol}:`, e?.message ?? e))
      written++
      console.log(`[ML] ${data.symbol} → ${data.signal}`)
    } catch (e) {
      console.error(`[ML] Write failed for stock_id=${data.stock_id}:`, e)
    }
  }
  console.log(`[ML] Batch predict done: ${written}/${payloads.length} written, ${elapsed}s total`)

  // ── 2d+. Store per-model timing & feature count to KV ──────────────────
  {
    const timingAgg: Record<string, number[]> = {}
    const featureCounts: number[] = []
    for (const data of results) {
      if (data.model_timings_ms) {
        for (const [model, ms] of Object.entries(data.model_timings_ms)) {
          if (!timingAgg[model]) timingAgg[model] = []
          timingAgg[model].push(ms as number)
        }
      }
      if (data.feature_count) featureCounts.push(data.feature_count as number)
    }
    const avgTimings: Record<string, number> = {}
    for (const [model, arr] of Object.entries(timingAgg)) {
      avgTimings[model] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
    }
    await env.KV.put(`ml:perf:${twDate}`, JSON.stringify({
      avg_model_timings_ms: avgTimings,
      avg_feature_count: featureCounts.length ? Math.round(featureCounts.reduce((a, b) => a + b, 0) / featureCounts.length) : 0,
      total_stocks: results.length,
      total_time_s: parseFloat(elapsed),
    }), { expirationTtl: 30 * 86400 })
    console.log(`[ML] Performance stored: ${Object.keys(avgTimings).length} models, avg features=${featureCounts[0] ?? 0}`)
  }

  // ── 2e. Event-driven chain: ML complete → trigger recommendation ───────
  try {
    await runDailyRecommendation(env)
    console.log('[ML] Event-driven: triggered recommendation after ML complete')
  } catch (e) {
    console.warn('[ML] Event-driven recommendation trigger failed (cron fallback still active):', e)
  }
  } finally {
    // Fix 2026-04-07: 確保 lock 不論 success/error/throw 都會清除
    await env.KV.delete(lockKey).catch(() => {})
  }
}

// ─── 2026-04-07 LangGraph A+B Refactor: runMLAndRiskV2 ─────────────────────
// thin trigger — 把 ML business logic 整段交給 ml-controller LangGraph V2
// Worker 只負責: market_risk 計算 (~5s) + 觸發 controller /pipeline/v2/run + lock 管理
//
// 之前的 runMLAndRisk (上面 ~300 行) 違反 MVC：worker 做了 ML payload build /
// batch dispatch / D1 predictions 寫入 / hybrid ranking / LLM reasons，
// 都應該是 ml-controller 的責任。完整 audit 見 memory/project_langgraph_real_refactor.md
//
// runMLAndRisk 舊版保留 1 週做 rollback safety，2026-04-14 後砍。
async function runMLAndRiskV2(env: Bindings): Promise<string> {
  const twDate = twToday()
  const lockKey = `lock:ml-predict:${twDate}`
  const existing = await env.KV.get(lockKey)
  if (existing) { console.log('[ML V2] Already running, skip'); return 'LOCKED' }
  // 2026-04-08 Part 5 Option A: TTL bumped 600→1800 so background pipeline on
  // ml-controller has headroom to finish before lock expires. ml-controller
  // callback does not clear this lock; TTL cleanup only.
  await env.KV.put(lockKey, '1', { expirationTtl: 1800 })  // 30 min TTL

  try {
    if (!env.ML_CONTROLLER_URL) {
      console.warn('[ML V2] ML_CONTROLLER_URL not set, falling back to legacy runMLAndRisk')
      return await runMLAndRisk(env) as any
    }

    // 1. Market risk (~5 sec) — 仍在 worker 做，因為 marketRisk.ts 邏輯複雜不值得搬
    try {
      const { calcMarketRisk } = await import('./lib/marketRisk')
      const risk = await calcMarketRisk(
        env.DB, env.ANTHROPIC_API_KEY, env.ML_CONTROLLER_URL, env.ML_CONTROLLER_SECRET
      )
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
      console.log(`[ML V2] Market risk: ${risk.riskLevel} (${risk.riskScore}/100)`)
    } catch (e) {
      console.error('[ML V2] Market risk failed (non-blocking):', e)
    }

    // 2. Trigger ml-controller LangGraph V2 — fire-and-forget (Option A)
    // ml-controller returns 202 immediately with a run_id; pipeline runs in
    // background. ml-controller posts /api/admin/cron-callback when done, so
    // cron:log:* gets overwritten with real completion status.
    // Worker no longer waits for pipeline body — CF edge ~144s subrequest
    // timeout was truncating fetch and falsely reporting errors.
    // See project_session_2026_04_08_part5.md for rationale.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

    console.log('[ML V2] Triggering ml-controller /pipeline/v2/run (async, expect 202)...')
    const t0 = Date.now()
    const res = await fetch(`${env.ML_CONTROLLER_URL}/pipeline/v2/run?date=${twDate}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30_000),  // 30s is plenty to receive 202
    })
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

    if (res.status !== 202 && !res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Pipeline V2 trigger HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    let runId = 'unknown'
    try {
      const body = await res.json() as any
      runId = String(body?.run_id ?? 'unknown')
    } catch { /* body may be empty */ }
    console.log(`[ML V2] Triggered in ${elapsed}s, run_id=${runId} (awaiting callback for final status)`)
    return `triggered run_id=${runId}, callback expected`
  } catch (e: any) {
    // Trigger-phase failure (unreachable / auth / 30s timeout) — clear lock
    // so next attempt can retry; ml-controller callback will not arrive.
    await env.KV.delete(lockKey).catch(() => {})
    throw e
  }
  // Note: on success, lockKey is NOT cleared here. It expires via TTL (1800s).
  // ml-controller callback does not touch it.
}

// processMLBatch removed in Phase 3 — ML batch predict now handled by Controller /batch-predict
// Legacy ML_QUEUE fallback retained in runMLAndRisk for rollback safety


// ─── Cron P2#16：Weekly AI Audit Report（Controller 觸發） ────────────────────
async function runWeeklyAudit(env: Bindings) {
  const CTRL_URL = env.ML_CONTROLLER_URL
  if (!CTRL_URL) return 'skipped (no controller URL)'
  console.log('[Audit] Generating weekly AI audit report...')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

  const resp = await fetch(`${CTRL_URL}/audit/weekly`, {
    method: 'POST', headers, signal: AbortSignal.timeout(120_000),
  }).catch(() => null)
  if (!resp?.ok) return 'failed'
  const r = await resp.json() as Record<string, any>
  if (r.status !== 'success') return `failed: ${r.error ?? r.status}`

  // Push report to Discord
  if ((env as any).DISCORD_WEBHOOK_URL && r.report) {
    const { sendDiscordNotification } = await import('./lib/notify')
    await sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL,
      `📋 **Weekly AI Audit Report** (${r.report_date})\n\n${r.report}`.slice(0, 2000))
  }
  return `report generated, return=${r.l1?.weekly_return ?? 'N/A'}`
}


// ─── Cron: Monthly Optuna Parameter Re-search ────────────────────────────────
async function runMonthlyOptunaResearch(env: Bindings) {
  // Phase 1.6 (2026-04-07): 改 call Controller (Cloud Run) 而非 Modal
  // 原因：Modal web function 150s response timeout 限制，且 Optuna 不需要 ML inference 環境
  // Controller 自己會 push KV，Worker 不用做轉發
  const CTRL_URL = env.ML_CONTROLLER_URL
  if (!CTRL_URL) return 'skipped (no ML_CONTROLLER_URL)'
  console.log('[Monthly] Starting Optuna parameter re-search (Cloud Run)...')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

  const sources = ['barrier', 'signal', 'sltp', 'conformal', 'risk_params', 'rrg', 'feature_window'] as const
  const results: string[] = []

  for (const src of sources) {
    try {
      const r = await fetch(`${CTRL_URL}/optuna/${src}`, {
        method: 'POST', headers,
        body: JSON.stringify({ n_trials: 200, push_kv: true, dry_run: false }),
        signal: AbortSignal.timeout(900_000),  // 15 min per source（Cloud Run 不像 Modal 有 150s 限制）
      })
      results.push(`${src}:${r.ok ? 'OK' : `HTTP${r.status}`}`)
    } catch (e: any) {
      results.push(`${src}:ERROR(${e?.message?.slice(0, 30) ?? 'unknown'})`)
    }
  }

  const summary = results.join(', ')
  console.log(`[Monthly] Optuna re-search: ${summary}`)

  if ((env as any).DISCORD_WEBHOOK_URL) {
    const { sendDiscordNotification } = await import('./lib/notify')
    await sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL,
      `🔬 **Monthly Optuna Re-search Complete**\n${summary}`)
  }

  return summary
}


// ─── Cron P1#8：Model Lifecycle Check（Controller 觸發） ─────────────────────
async function runWeeklyLifecycleCheck(env: Bindings) {
  const CTRL_URL = env.ML_CONTROLLER_URL
  if (!CTRL_URL) return 'skipped (no controller URL)'
  console.log('[Lifecycle] Running weekly model lifecycle check...')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

  const resp = await fetch(`${CTRL_URL}/lifecycle/check?degrade=0.45&restore=0.55`, {
    method: 'POST', headers, signal: AbortSignal.timeout(60_000),
  }).catch(() => null)

  if (!resp?.ok) return 'failed'
  const r = await resp.json() as Record<string, any>
  if (r.status === 'failed' || r.status === 'error') return `failed: ${r.error ?? r.status}`
  const degraded = Object.values(r.models ?? {}).filter((m: any) => m.status === 'degraded').length
  const events = (r.events ?? []).length
  return `${degraded} degraded, ${events} events, guard=${r.balance_guard}`
}


// ─── Cron P0#4：每週日回測（Controller 觸發） ─────────────────────────────────
async function runWeeklyBacktest(env: Bindings) {
  const CTRL_URL = env.ML_CONTROLLER_URL
  if (!CTRL_URL) {
    console.warn('[Backtest] ML_CONTROLLER_URL not set, skipping')
    return 'skipped (no controller URL)'
  }
  console.log('[Backtest] Triggering weekly backtest via Controller...')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

  const resp = await fetch(`${CTRL_URL}/backtest/run`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(300_000), // 5 min timeout
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    console.error(`[Backtest] Controller returned ${resp.status}: ${text.slice(0, 200)}`)
    return `failed (${resp.status})`
  }

  const result = await resp.json() as Record<string, any>
  console.log('[Backtest] Result:', JSON.stringify(result).slice(0, 500))
  if (result.status === 'failed' || result.status === 'error') {
    console.error(`[Backtest] Pipeline failed: ${result.error ?? 'unknown'}`)
    return `failed: ${result.error ?? result.status}`
  }
  return `trades=${result.total_trades ?? 0}, win=${result.win_rate ?? '-'}, sharpe=${result.sharpe ?? '-'}`
}


// ─── Cron P0#5：Monte Carlo MDD（Controller 觸發） ───────────────────────────
async function runWeeklyMonteCarlo(env: Bindings) {
  const CTRL_URL = env.ML_CONTROLLER_URL
  if (!CTRL_URL) {
    console.warn('[MonteCarlo] ML_CONTROLLER_URL not set, skipping')
    return 'skipped (no controller URL)'
  }
  console.log('[MonteCarlo] Running Monte Carlo MDD simulation...')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

  // Run both paper and backtest sources
  const results: string[] = []
  for (const source of ['paper', 'backtest'] as const) {
    const resp = await fetch(`${CTRL_URL}/backtest/monte-carlo?n=1000&source=${source}`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(120_000), // 2 min timeout
    }).catch(() => null)

    if (!resp?.ok) {
      results.push(`${source}:failed`)
      continue
    }
    const r = await resp.json() as Record<string, any>
    if (r.status === 'failed' || r.status === 'error') {
      results.push(`${source}:${r.error ?? 'failed'}`)
    } else {
      results.push(`${source}:${r.go_live_verdict}(95th=${r.mdd_95th})`)
    }
  }
  const summary = results.join(', ')
  console.log(`[MonteCarlo] ${summary}`)
  return summary
}


// ─── Cron P0#6：PBO 過擬合檢測（Controller 觸發） ───────────────────────────
async function runWeeklyPBO(env: Bindings) {
  const CTRL_URL = env.ML_CONTROLLER_URL
  if (!CTRL_URL) return 'skipped (no controller URL)'
  console.log('[PBO] Running Probability of Backtest Overfitting analysis...')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

  const resp = await fetch(`${CTRL_URL}/backtest/pbo?partitions=10&source=backtest`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(120_000),
  }).catch(() => null)

  if (!resp?.ok) return 'failed'
  const r = await resp.json() as Record<string, any>
  if (r.status === 'failed' || r.status === 'error') return `failed: ${r.error ?? r.status}`
  const summary = `PBO=${r.pbo}(${r.go_live_verdict}), OOS=${r.oos_mean_return}`
  console.log(`[PBO] ${summary}`)
  return summary
}


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
    env.DB.prepare('SELECT date, foreign_net, trust_net, dealer_net FROM chip_data WHERE symbol=? ORDER BY date DESC LIMIT 200').bind(topStock.symbol).all<any>(),
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

async function runWeeklyDriftCheck(env: Bindings) {
  const ML_URL = env.ML_SERVICE_URL
  if (!ML_URL) return

  // 用跟 IC audit 相同的資料最多股票
  const topStock = await env.DB.prepare(`
    SELECT s.id, s.symbol FROM stocks s
    JOIN stock_prices sp ON sp.stock_id=s.id
    WHERE s.is_active=1
    GROUP BY s.id ORDER BY COUNT(*) DESC LIMIT 1
  `).first<any>()
  if (!topStock) return

  const [prices, indicators, chips] = await Promise.all([
    env.DB.prepare('SELECT * FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 252').bind(topStock.id).all<any>(),
    env.DB.prepare('SELECT * FROM technical_indicators WHERE stock_id=? ORDER BY date DESC LIMIT 252').bind(topStock.id).all<any>(),
    env.DB.prepare('SELECT * FROM chip_data WHERE symbol=? ORDER BY date DESC LIMIT 252').bind(topStock.symbol).all<any>(),
  ])

  const mlHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_SERVICE_SECRET) mlHeaders['X-Service-Token'] = env.ML_SERVICE_SECRET

  const res = await fetch(`${ML_URL}/feature-drift`, {
    method: 'POST',
    headers: mlHeaders,
    body: JSON.stringify({
      stock_id: topStock.id, symbol: topStock.symbol,
      prices: (prices.results ?? []).reverse(),
      indicators: (indicators.results ?? []).reverse(),
      chips: (chips.results ?? []).reverse(),
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    console.warn(`[Drift Check] HTTP ${res.status}`)
    return
  }

  const data = await res.json() as any
  const twDate = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  await env.KV.put(`ml:drift:${twDate}`, JSON.stringify(data), { expirationTtl: 30 * 86400 })
  console.log(`[Drift Check] ${data.drifted_count}/${data.total_features} features drifted, needs_retrain=${data.needs_retrain}`)
}

async function runWeeklyRetrain(env: Bindings) {
  console.log('[WeeklyRetrain] Starting weekly model retraining...')

  // 讀取 barrier params（與 predict 一致）
  const { getTradingConfig } = await import('./lib/tradingConfig')
  const tradingCfg = await getTradingConfig(env.KV)

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

  // P1#9: Read weak features from IC audit (stored by runWeeklyICaudit)
  let weakFeatures: string[] = []
  try {
    const wfJson = await env.KV.get('ml:weak_features')
    if (wfJson) {
      weakFeatures = JSON.parse(wfJson)
      console.log(`[WeeklyRetrain] IC audit: ${weakFeatures.length} weak features to exclude`)
    }
  } catch (e) { console.warn('[WeeklyRetrain] Failed reading weak features:', e) }

  // 建構 payloads
  const payloads: any[] = []
  for (const stock of (stocks ?? [])) {
    try {
      const [prices, indicators, chips] = await Promise.all([
        env.DB.prepare('SELECT * FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 252').bind(stock.id).all<any>(),
        env.DB.prepare('SELECT * FROM technical_indicators WHERE stock_id=? ORDER BY date DESC LIMIT 252').bind(stock.id).all<any>(),
        env.DB.prepare('SELECT * FROM chip_data WHERE symbol=? ORDER BY date DESC LIMIT 252').bind(stock.symbol).all<any>(),
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
        weak_features: weakFeatures,  // P1#9: IC audit 無效特徵
        use_optuna: true,             // P1#9: 啟用 Optuna 超參數搜索
        barrier_params: {
          upper_mult: tradingCfg.barrier.upperMult,
          lower_mult: tradingCfg.barrier.lowerMult,
          upper_pct_cap: tradingCfg.barrier.upperPctCap,
          lower_pct_cap: tradingCfg.barrier.lowerPctCap,
          max_days: tradingCfg.barrier.maxDays,
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

  for (const alert of results) {
    try {
      let price: number | null = null

      // 台股 + 美股統一走 Yahoo Finance（台股 symbol 帶 .TW/.TWO 後綴）
      const res  = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${alert.symbol}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8_000) })
      const json = await res.json() as any
      price = json.quoteResponse?.result?.[0]?.regularMarketPrice ?? null

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

// ─── Wave 3：集保分布（TDCC opendata，替代 FinMind TaiwanStockShareholding）──
// TDCC 每週更新一次（通常週四）
async function fetchWeeklyShareholding(env: Bindings): Promise<void> {
  const retailLevels = new Set(['1-999', '1,000-5,000', '5,001-10,000', '10,001-15,000',
    '15,001-20,000', '20,001-30,000', '30,001-40,000', '40,001-50,000'])
  const largeLevels = new Set(['400,001-600,000', '600,001-800,000', '800,001-1,000,000', '1,000,001以上'])

  try {
    // TDCC opendata 1-5：全市場持股分布（JSON，按股票代號 + 持股級距）
    const res = await fetch('https://openapi.tdcc.com.tw/v1/opendata/1-5', {
      headers: { 'User-Agent': 'StockVision/12.3' },
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) { console.warn(`[Wave3] TDCC opendata HTTP ${res.status}`); return }
    const body = await res.json() as any[]
    if (!Array.isArray(body) || !body.length) { console.warn('[Wave3] TDCC empty response'); return }

    // 建 symbol → stock_id map
    const { results: dbStocks } = await env.DB.prepare('SELECT id, symbol FROM stocks WHERE is_active=1').all<any>()
    const idMap = new Map<string, number>()
    for (const s of dbStocks ?? []) idMap.set(s.symbol, s.id)

    // TDCC 欄位：證券代號, 持股/單位數分級, 人數, 股數(單位數), 佔集保庫存數比例(%)
    //   日期欄位: 資料日期 (YYYY/MM/DD or YYY/MM/DD ROC format)
    type TDCCRow = { '證券代號': string; '持股/單位數分級': string; '人數': string; '股數(單位數)': string; '佔集保庫存數比例(%)': string; '資料日期': string }
    const bySymbol = new Map<string, { date: string; rows: TDCCRow[] }>()
    for (const r of body as TDCCRow[]) {
      const sym = (r['證券代號'] ?? '').trim()
      if (!sym || !idMap.has(sym)) continue
      if (!bySymbol.has(sym)) bySymbol.set(sym, { date: r['資料日期'] ?? '', rows: [] })
      bySymbol.get(sym)!.rows.push(r)
    }

    const BATCH = 50
    const stmts: D1PreparedStatement[] = []
    for (const [sym, { date: rawDate, rows }] of bySymbol.entries()) {
      const stockId = idMap.get(sym)!
      // 轉換日期（民國 YYY/MM/DD → ISO 或 ISO YYYY/MM/DD）
      let isoDate = rawDate.replace(/\//g, '-')
      if (isoDate.length === 8 && !isoDate.startsWith('20')) {
        // ROC format: 115/03/20 → 2026-03-20
        const parts = rawDate.split('/')
        isoDate = `${parseInt(parts[0]) + 1911}-${parts[1]}-${parts[2]}`
      }

      const totalShares = rows.reduce((s, r) => s + (parseInt(r['股數(單位數)'].replace(/,/g, '')) || 0), 0)
      const totalHolders = rows.reduce((s, r) => s + (parseInt(r['人數'].replace(/,/g, '')) || 0), 0)
      const retailShares = rows.filter(r => retailLevels.has(r['持股/單位數分級']))
        .reduce((s, r) => s + (parseInt(r['股數(單位數)'].replace(/,/g, '')) || 0), 0)
      const largeShares = rows.filter(r => largeLevels.has(r['持股/單位數分級']))
        .reduce((s, r) => s + (parseInt(r['股數(單位數)'].replace(/,/g, '')) || 0), 0)

      stmts.push(env.DB.prepare(`
        INSERT INTO shareholding (stock_id, date, total_shares, holder_count, retail_shares, retail_pct, large_holder_shares, large_holder_pct)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stock_id, date) DO UPDATE SET
          total_shares=excluded.total_shares, holder_count=excluded.holder_count,
          retail_shares=excluded.retail_shares, retail_pct=excluded.retail_pct,
          large_holder_shares=excluded.large_holder_shares, large_holder_pct=excluded.large_holder_pct
      `).bind(
        stockId, isoDate, totalShares, totalHolders, retailShares,
        totalShares > 0 ? (retailShares / totalShares) * 100 : null,
        largeShares,
        totalShares > 0 ? (largeShares / totalShares) * 100 : null,
      ))
    }

    for (let i = 0; i < stmts.length; i += BATCH) {
      await env.DB.batch(stmts.slice(i, i + BATCH))
    }
    console.log(`[Wave3] Shareholding (TDCC): ${stmts.length} stocks written`)
  } catch (e) { console.warn('[Wave3] TDCC shareholding failed:', e) }
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
  const { runBottomUpScreener } = await import('./lib/marketScreener')
  return runBottomUpScreener(env)
}

// ─── 完整 Pipeline：bulk-fetch → screener → queue-update → ml → recommendation ──
// LangGraph 修復（2026-04-07）：取代 Controller /pipeline/run 繞路
// 原架構：Worker → Controller → Worker (ML) → Modal → Controller → Worker (4-5 層 HTTP)
// 新架構：Worker → Modal (1 層 HTTP)，消除 300s timeout 壓力
async function runFullPipeline(env: Bindings): Promise<{ steps: string[]; message: string }> {
  const waitForQueue = async (table: string, dateCol: string, minExpected: number, timeoutMs = 300_000) => {
    const twTodayStr = twToday()
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM ${table} WHERE ${dateCol} = ?`
      ).bind(twTodayStr).first<{ cnt: number }>()
      if ((row?.cnt ?? 0) >= minExpected) return row?.cnt ?? 0
      await new Promise(r => setTimeout(r, 10_000))
    }
    const final = (await env.DB.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${dateCol}=?`).bind(twTodayStr).first<any>())?.cnt ?? 0
    throw new Error(`Queue timeout: ${table} only has ${final} rows after ${timeoutMs / 1000}s`)
  }

  const steps: string[] = []

  // 1. Bulk Fetch（全市場 prices+chips → D1）
  await runBulkFetch(env)
  steps.push('bulk-fetch')

  // 2. Screener T1+T2
  const result: any = await runMarketScreener(env)
  steps.push(`screener(${result?.candidates?.length ?? 0} candidates)`)

  const activeCount = (await env.DB.prepare("SELECT COUNT(*) as cnt FROM stocks WHERE is_active=1").first<any>())?.cnt ?? 60

  // 3. Queue Update（候選股 Yahoo+指標+新聞）
  await runQueueUpdate(env)
  const updated = await waitForQueue('stock_prices', 'date', Math.floor(activeCount * 0.8))
  steps.push(`queue-update(${updated} prices)`)

  // 4. ML predict (LangGraph V2 — controller-side, includes recommendation + LLM reasons)
  // 2026-04-07 重構：runMLAndRiskV2 thin trigger 把整段 ML/recommendation 交給 ml-controller
  await runMLAndRiskV2(env)
  const predicted = await waitForQueue('predictions', "date(generated_at)", Math.floor(activeCount * 0.5))
  steps.push(`ml-predict-v2(${predicted} predictions)`)

  // 5. Recommendation（評分，T2 已在 Screener 完成）
  // V2 已在 controller 內整合 recommendation + LLM reasons，這裡保留 fallback skip
  await runDailyRecommendation(env)
  steps.push('recommendation')

  return { steps, message: '完整 pipeline 完成' }
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
    // "0 20 * * 6"   → 每週日 04:00 台北 (UTC Sat 20:00) → 清理舊資料
    // "0 22 * * 6"   → 每週日 06:00 台北 (UTC Sat 22:00) → 自動回測
    // ── 國定假日檢查（台股休市日不跑任何交易相關 cron）──────────────────
    const twTodayStr = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
    const twDayOfWeek = new Date(Date.now() + 8 * 3600_000).getUTCDay()
    const isWeekend = twDayOfWeek === 0 || twDayOfWeek === 6
    const isHoliday = await env.KV.get(`holiday:${twTodayStr}`)
    const weekendCrons = new Set(['0 20 * * 6', '0 22 * * 6', '0 16 1-7 * 6'])
    if ((isWeekend || isHoliday) && !weekendCrons.has(cron)) {
      console.log(`[Cron] ${twTodayStr} 休市（${isWeekend ? '週末' : isHoliday}），跳過 ${cron}`)
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

    if (cron === '15 23 * * SUN-THU') {
      runWithLog('morning-setup', async () => {
        await runMorningWarmup(env)
        await setupMorningPendingBuys(env)
        const pending = await env.KV.get(`paper:pending_buys:${twTodayStr}`)
        const count = pending ? JSON.parse(pending).length : 0
        return `預熱完成，掛單 ${count} 支`
      })
    } else if (cron === '15 9 * * 1-5') {
      runWithLog('ml-warmup', async () => {
        if (env.ML_SERVICE_URL) {
          const h: Record<string, string> = {}
          if (env.ML_SERVICE_SECRET) h['X-Service-Token'] = env.ML_SERVICE_SECRET
          const r = await fetch(`${env.ML_SERVICE_URL}/warmup`, { headers: h, signal: AbortSignal.timeout(90_000) }).catch(() => null)
          return r?.ok ? 'Cloud Run 預熱完成（models loaded）' : 'Cloud Run 預熱失敗（cron fallback 仍有效）'
        }
        return '跳過（ML_SERVICE_URL 未設定）'
      })
    } else if (cron === '30 9 * * 1-5') {
      // 17:30 TW → Single pipeline trigger
      // LangGraph 修復（2026-04-07）：Worker 內建 await gates，取代 Controller /pipeline/run 繞路
      // 原：Worker → Controller → Worker(ML) → Modal → Controller → Worker（4-5 層 HTTP, >300s timeout）
      // 新：Worker → Modal（1 層 HTTP），預算 < 300s
      // Individual tasks 仍可透過 /admin/trigger/:task 手動觸發
      runWithLog('pipeline', async () => {
        const { steps, message } = await runFullPipeline(env)
        // Phase 5.5 (2026-04-08 audit): B6 fire-and-forget removed.
        // Verify now runs in its own cron at 19:00 TW (V2 via ml-controller LangGraph).
        // Old V1 runPredictionVerification kept as manual backup via /admin/trigger/verify.
        return `${message} (${steps.join(' → ')})`
      })
    } else if (cron === '20 10 * * 1-5') {
      runWithLog('adapt', async () => {
        const { runAdaptiveUpdate } = await import('./lib/adaptiveEngine')
        return await runAdaptiveUpdate(env)
      })
    } else if (cron === '0 11 * * 1-5') {
      // Phase 5.5 (2026-04-08 audit): 19:00 TW → D-2 verify pipeline V2
      // Calls ml-controller /verify/run (LangGraph) — replaces worker silently-failing V1.
      runWithLog('verify-v2', async () => {
        const controllerUrl = env.ML_CONTROLLER_URL
        if (!controllerUrl) return '跳過（ML_CONTROLLER_URL 未設定）'
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET
        const res = await fetch(`${controllerUrl}/verify/run`, {
          method: 'POST', headers,
          body: JSON.stringify({ lookback_days: 5, limit: 200 }),
          signal: AbortSignal.timeout(280_000),
        })
        if (!res.ok) throw new Error(`Controller /verify/run HTTP ${res.status}`)
        const data = await res.json() as any
        return `verified ${data.verified}/${data.pending} correct ${data.correct} pnl ${(data.total_pnl_pct * 100).toFixed(1)}% arf ${data.arf_updated}`
      })
    } else if (cron === '25 5 * * 1-5') {
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
        ).bind(twTodayStr).first<{ cnt: number }>()
        const before = ordersBefore?.cnt ?? 0

        // VULN-40 fix: KV lock to prevent concurrent intraday executions
        const intradayLock = await env.KV.get('cron:intraday-lock')
        if (intradayLock) {
          // Another execution still running, skip
          return
        }
        await env.KV.put('cron:intraday-lock', '1', { expirationTtl: 120 }) // 2 min TTL
        try {
          await runIntradayCheck(env)
        } finally {
          await env.KV.delete('cron:intraday-lock')
        }

        const ordersAfter = await env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM paper_orders WHERE created_at >= ? AND side='buy'"
        ).bind(twTodayStr).first<{ cnt: number }>()
        const after = ordersAfter?.cnt ?? 0
        if (after > before) {
          const { logCronResult } = await import('./lib/cronLogger')
          await logCronResult(env.KV, 'intraday-check', {
            status: 'success', summary: `盤中成交 ${after - before} 筆（累計 ${after} 筆）`, duration_ms: 0,
          })
        }
      })())
    } else if (cron === '30 22 * * SUN-THU') {
      runWithLog('us-leading', async () => {
        const { fetchAndStoreUSLeading } = await import('./lib/usLeading')
        const signal = await fetchAndStoreUSLeading(env)
        return signal ? `SOX ${((signal.sox_return ?? 0) * 100).toFixed(1)}% | ${signal.sentiment}` : '抓取失敗'
      })
    } else if (cron === '50 23 * * SUN-THU') {
      runWithLog('morning-briefing', async () => {
        const { generateMorningBriefing } = await import('./lib/morningBriefing')
        return await generateMorningBriefing(env)
      })
    } else if (cron === '25 10 * * 1-5') {
      runWithLog('daily-report', async () => {
        const { generateDailyReport } = await import('./lib/dailyReport')
        return await generateDailyReport(env)
      })
    } else if (cron === '40 10 * * 1-5') {
      // 18:40 TW → Obsidian daily notes + progress.md sync
      runWithLog('obsidian-daily', async () => {
        if (!env.ML_CONTROLLER_URL) return 'SKIP: ML_CONTROLLER_URL not set'
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET
        const twDate = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
        const res = await fetch(`${env.ML_CONTROLLER_URL}/obsidian/daily`, {
          method: 'POST', headers, body: JSON.stringify({ date: twDate }), signal: AbortSignal.timeout(60000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        return typeof json === 'string' ? json : JSON.stringify(json).slice(0, 300)
      })
    } else if (cron === '30 10 * * 5') {
      // 週五 18:30 TW → P2#16 Weekly AI Audit Report
      runWithLog('weekly-audit', async () => {
        return await runWeeklyAudit(env)
      })
    } else if (cron === '0 20 * * 6') {
      // 週日 04:00 TW (=UTC Sat 20:00) → 清理 + 重訓 + IC + Timeverse + 備份
      runWithLog('weekly-cleanup', async () => {
        await runWeeklyCleanup(env)
        await runWeeklyRetrain(env)
        // P1#8: Model lifecycle check (after retrain, uses fresh accuracy data)
        await runWeeklyLifecycleCheck(env).catch(e => console.warn('[Lifecycle] failed:', e))
        await fetchWeeklyShareholding(env).catch(e => console.warn('[Wave3] Shareholding failed:', e))
        await runWeeklyICaudit(env).catch(e => console.warn('[IC Audit] failed:', e))
        await runWeeklyDriftCheck(env).catch(e => console.warn('[Drift Check] failed:', e))
        const { syncTimeverse } = await import('./lib/timeverse')
        await syncTimeverse(env).catch(e => console.warn('[Timeverse] sync failed:', e))
        // P1 資安：D1 關鍵表 weekly snapshot → KV（災難恢復用，7 天 TTL）
        try {
          const tables = ['paper_accounts', 'paper_positions', 'paper_orders'] as const
          const twDate = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
          for (const t of tables) {
            const { results } = await env.DB.prepare(`SELECT * FROM ${t}`).all()
            await env.KV.put(`backup:${t}:${twDate}`, JSON.stringify(results ?? []), { expirationTtl: 604800 })
          }
          console.log(`[Backup] D1 snapshot saved to KV (${tables.length} tables)`)
        } catch (e) { console.warn('[Backup] D1 snapshot failed:', e) }
        return '週清理 + 重訓 + 集保 + IC審計 + Timeverse同步 + D1備份完成'
      })
    } else if (cron === '0 22 * * 6') {
      // 週日 06:00 TW (=UTC Sat 22:00) → P0#4 回測 + P0#5 MC + P0#6 PBO
      runWithLog('weekly-backtest', async () => {
        const bt = await runWeeklyBacktest(env)
        const mc = await runWeeklyMonteCarlo(env).catch(e => { console.warn('[MC]', e); return 'failed' })
        const pbo = await runWeeklyPBO(env).catch(e => { console.warn('[PBO]', e); return 'failed' })
        return `bt(${bt}) | mc(${mc}) | pbo(${pbo})`
      })
    } else if (cron === '0 16 1-7 * 6') {
      // 每月第一個週六 00:00 TW (=UTC Sat 16:00) → Optuna 參數重搜
      runWithLog('monthly-optuna', async () => {
        return await runMonthlyOptunaResearch(env)
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
