import { twToday } from './dateUtils'
import type { Bindings } from '../types'
import { classifyCronSummary, logCronResult } from './cronLogger'
import { runMorningWarmup } from './localMaintenance'
import { handleWorkerDomainCron } from './cronWorkerDomainTasks'
import { handleGcpDomainCron } from './cronGcpDomainTasks'
import { batchGetIntradayPrices } from './paperIntradayData'
import { executeRescoreSell } from './paperWorkerTasks'
import { runIntradayCheck } from './paperEntryTasks'
import { formatPendingBuyCronSummary } from './pendingBuyCronSummary'
import { buildPendingBuyStateSummary } from './pendingBuyStateSummary'

function twNow() {
  return new Date(Date.now() + 8 * 3600_000)
}

function twDateString() {
  return twNow().toISOString().slice(0, 10)
}

async function settlePaperT2(env: Bindings) {
  const today = twToday()
  const matured = await env.DB.prepare(
    "SELECT account_id, SUM(CASE WHEN side='buy' THEN -amount ELSE amount END) as net FROM paper_settlements WHERE settled=0 AND settlement_date <= ? GROUP BY account_id",
  ).bind(today).all<{ account_id: number; net: number }>()

  for (const row of matured?.results ?? []) {
    await env.DB.prepare(
      'UPDATE paper_accounts SET cash=cash+?, updated_at=datetime(\'now\') WHERE id=?',
    ).bind(row.net, row.account_id).run()
  }

  if ((matured?.results?.length ?? 0) > 0) {
    await env.DB.prepare(
      'UPDATE paper_settlements SET settled=1, settled_at=datetime(\'now\') WHERE settled=0 AND settlement_date <= ?',
    ).bind(today).run()
    console.log(`[T+2] settled ${matured.results.length} accounts: ${matured.results.map((r) => r.net).join(',')}`)
  }
}

async function runPreMarketWarmup(env: Bindings) {
  const results: string[] = []
  results.push('Worker:self ok')

  if (env.PAGES_ORIGIN) {
    try {
      const res = await fetch(env.PAGES_ORIGIN, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(10_000),
      })
      results.push(`Frontend:${res.ok ? 'ok' : `fail(${res.status})`}`)
    } catch (e: any) {
      results.push(`Frontend:error(${e.message})`)
    }
  } else {
    results.push('Frontend:skip(no PAGES_ORIGIN)')
  }

  if (env.ML_CONTROLLER_URL) {
    try {
      const res = await fetch(`${env.ML_CONTROLLER_URL}/health`, {
        headers: env.ML_CONTROLLER_SECRET ? { 'X-Controller-Token': env.ML_CONTROLLER_SECRET } : {},
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        results.push(`ML-Controller:fail(${res.status})`)
      } else {
        const health = await res.json().catch(() => ({})) as any
        const pipelineJob = health.pipelineJobConfigured ? 'ok' : 'missing'
        const verifyJob = health.verifyJobConfigured ? 'ok' : 'missing'
        const callback = health.callbackConfigured ? 'ok' : 'missing'
        results.push(`ML-Controller:ok pipelineJob=${pipelineJob} verifyJob=${verifyJob} callback=${callback}`)
      }
    } catch (e: any) {
      results.push(`ML-Controller:error(${e.message})`)
    }
  } else {
    results.push('ML-Controller:skip(no ML_CONTROLLER_URL)')
  }

  const proxyUrl = (env as any).SHIOAJI_PROXY_URL as string | undefined
  if (proxyUrl) {
    try {
      const res = await fetch(`${proxyUrl}/health`, {
        headers: { Authorization: `Bearer ${(env as any).PROXY_SERVICE_TOKEN ?? ''}` },
        signal: AbortSignal.timeout(10_000),
      })
      results.push(`Shioaji:${res.ok ? 'ok' : `fail(${res.status})`}`)
    } catch (e: any) {
      results.push(`Shioaji:error(${e.message})`)
    }
  }

  const summary = results.join(', ') || 'no warm targets'
  const hasDrift = results.some((item) => item.includes(':fail(') || item.includes(':error(') || item.includes('=missing'))
  return hasDrift ? `ERROR: control-plane drift ${summary}` : summary
}

async function runIntradayHeartbeat(env: Bindings, ctx: ExecutionContext, twTodayStr: string) {
  ctx.waitUntil((async () => {
    const started = Date.now()
    const { loadPendingBuySnapshot } = await import('./pendingBuyStore')
    await env.KV.put('cron:intraday-heartbeat', twNow().toISOString(), { expirationTtl: 3600 })
    const pendingBefore = await loadPendingBuySnapshot(env, twTodayStr, { allowFallbackRecent: false })
    const pendingBeforeState = buildPendingBuyStateSummary(pendingBefore.pendingBuys, pendingBefore.meta)
    const beforeRow = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM paper_orders WHERE created_at >= ? AND side='buy'",
    ).bind(twTodayStr).first<{ cnt: number }>()
    const before = beforeRow?.cnt ?? 0

    const intradayLock = await env.KV.get('cron:intraday-lock')
    if (intradayLock) {
      await logCronResult(env.KV, 'intraday-check', {
        status: 'running',
        summary: formatPendingBuyCronSummary('heartbeat locked', pendingBeforeState, { total_buys: before }),
        duration_ms: Date.now() - started,
      })
      return
    }

    await env.KV.put('cron:intraday-lock', '1', { expirationTtl: 120 })
    try {
      await runIntradayCheck(env)
    } finally {
      await env.KV.delete('cron:intraday-lock')
    }

    const afterRow = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM paper_orders WHERE created_at >= ? AND side='buy'",
    ).bind(twTodayStr).first<{ cnt: number }>()
    const after = afterRow?.cnt ?? 0
    const pendingAfter = await loadPendingBuySnapshot(env, twTodayStr, { allowFallbackRecent: false })
    const pendingAfterState = buildPendingBuyStateSummary(pendingAfter.pendingBuys, pendingAfter.meta)
    const buys = after - before
    await logCronResult(env.KV, 'intraday-check', {
      status: buys > 0 ? 'success' : pendingAfter.pendingBuys.length > 0 ? 'running' : 'skipped',
      summary: formatPendingBuyCronSummary('heartbeat ok', pendingAfterState, {
        before_active: pendingBeforeState.active_count,
        buys: Math.max(0, buys),
        total_buys: after,
      }),
      duration_ms: Date.now() - started,
    })
  })())
}

async function runIntradayRescore(env: Bindings, cron: string, twTodayStr: string) {
  const { getTradingConfig } = await import('./tradingConfig')
  const cfg = await getTradingConfig(env.KV)
  if (!cfg.intraday.rescoreEnabled) return 'SKIP: rescoreEnabled=false'

  const controllerUrl = env.ML_CONTROLLER_URL
  if (!controllerUrl) return 'SKIP: no ML_CONTROLLER_URL'

  const exitCountKey = `intraday:rescore-exits:${twTodayStr}`
  const exitCount = parseInt(await env.KV.get(exitCountKey) ?? '0', 10)
  if (exitCount >= cfg.intraday.maxRescoreExitsPerDay) {
    return `SKIP: daily exit limit reached (${exitCount}/${cfg.intraday.maxRescoreExitsPerDay})`
  }

  const { results: positions } = await env.DB.prepare(`
    SELECT symbol, name, shares, avg_cost, entry_price, entry_date,
           initial_stop, trailing_stop, tp1_price, tp1_hit
    FROM paper_positions WHERE account_id=1 AND shares>0
  `).all<any>()
  if (!positions || positions.length === 0) return 'No open positions'

  const symbols = positions.map((p: any) => p.symbol)
  const priceMap = await batchGetIntradayPrices(symbols, {
    SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (env as any).PROXY_SERVICE_TOKEN,
  })
  if (priceMap.size === 0) return 'No intraday prices available'

  const prevDay = new Date(Date.now() + 8 * 3600_000 - 86400_000).toISOString().slice(0, 10)
  const warnHistoryMap: Record<string, any> = {}
  for (const position of positions) {
    const todayWarn = await env.KV.get(`intraday:warn:${position.symbol}:${twTodayStr}`, 'json')
    const prevWarn = await env.KV.get(`intraday:warn:${position.symbol}:${prevDay}`, 'json')
    if (todayWarn || prevWarn) {
      warnHistoryMap[position.symbol] = {
        today: todayWarn,
        prev_day: prevWarn,
        consecutive_warns: ((todayWarn as any)?.count ?? 0) + ((prevWarn as any)?.count ?? 0),
      }
    }
  }

  const positionInputs = positions.map((position: any) => ({
    symbol: position.symbol,
    shares: position.shares,
    entry_price: position.entry_price ?? position.avg_cost,
    entry_date: position.entry_date ?? '2000-01-01',
    current_price: priceMap.get(position.symbol) ?? position.entry_price ?? position.avg_cost,
    ml_confidence: null,
    warn_history: warnHistoryMap[position.symbol] ?? null,
  }))

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

  const res = await fetch(`${controllerUrl}/intraday/rescore`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ positions: positionInputs, today: twTodayStr }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`ml-controller /intraday/rescore HTTP ${res.status}`)

  const result = await res.json() as any
  const exits: string[] = []
  let newExitCount = exitCount

  for (const row of result.results ?? []) {
    if (row.action !== 'EXIT' || row.is_same_day || newExitCount >= cfg.intraday.maxRescoreExitsPerDay) continue

    const cooldownKey = `intraday:rescore-cooldown:${row.symbol}:${twTodayStr}`
    if (await env.KV.get(cooldownKey)) continue

    const pos = positions.find((p: any) => p.symbol === row.symbol)
    const currentPrice = priceMap.get(row.symbol)
    if (!pos || !currentPrice) continue

    try {
      await executeRescoreSell(env, {
        symbol: row.symbol,
        shares: pos.shares,
        price: currentPrice,
        reason: `ML Re-score EXIT: conf ${row.original_confidence.toFixed(3)} -> ${row.adjusted_confidence.toFixed(3)} | ${row.reason}`,
        source: 'intraday_rescore',
      })
      exits.push(`${row.symbol} sold@${currentPrice}(conf ${row.adjusted_confidence.toFixed(2)})`)
      newExitCount += 1
      await env.KV.put(cooldownKey, new Date().toISOString(), { expirationTtl: cfg.intraday.rescoreCooldownMin * 60 })
    } catch (e: any) {
      console.error(`[Intraday-Rescore] Failed to sell ${row.symbol}:`, e)
    }
  }

  if (newExitCount > exitCount) {
    await env.KV.put(exitCountKey, String(newExitCount), { expirationTtl: 86400 })
  }

  const warns = (result.results ?? []).filter((row: any) => row.action === 'WARN')
  for (const warn of warns) {
    const warnKey = `intraday:warn:${warn.symbol}:${twTodayStr}`
    const existing = await env.KV.get(warnKey, 'json') as { count: number; first_conf: number } | null
    await env.KV.put(
      warnKey,
      JSON.stringify({
        count: (existing?.count ?? 0) + 1,
        first_conf: existing?.first_conf ?? warn.adjusted_confidence,
        last_conf: warn.adjusted_confidence,
        last_at: new Date().toISOString(),
      }),
      { expirationTtl: 172800 },
    )
  }

  if ((exits.length > 0 || warns.length > 0) && (env as any).DISCORD_WEBHOOK_URL) {
    const { sendDiscordNotification } = await import('./notify')
    const slot = ({ '0 2 * * 1-5': '10:00', '0 3 * * 1-5': '11:00', '0 4 * * 1-5': '12:00', '30 4 * * 1-5': '12:30' } as Record<string, string>)[cron]
    const lines = [
      `ML Re-score (${slot ?? cron})`,
      ...exits.map((line) => `EXIT: ${line}`),
      ...warns.map((warn: any) => `WARN: ${warn.symbol} conf ${warn.original_confidence.toFixed(3)} -> ${warn.adjusted_confidence.toFixed(3)} (${warn.is_same_day ? 'same-day' : 'overnight'})`),
    ]
    await sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL, lines.join('\n'))
  }

  return `${result.summary?.total ?? 0} positions: ${exits.length} EXIT, ${warns.length} WARN, ${(result.summary?.hold ?? 0)} HOLD`
}

export async function handleScheduledCron(
  event: ScheduledEvent,
  env: Bindings,
  ctx: ExecutionContext,
) {
  const cron = event.cron
  const twTodayStr = twDateString()
  const twDayOfWeek = twNow().getUTCDay()
  const isWeekend = twDayOfWeek === 0 || twDayOfWeek === 6
  const isHoliday = await env.KV.get(`holiday:${twTodayStr}`)
  const weekendCrons = new Set(['0 20 * * 6', '0 22 * * 6', '30 22 * * 6', '0 */6 * * *'])

  if ((isWeekend || isHoliday) && !weekendCrons.has(cron)) {
    console.log(`[Cron] ${twTodayStr} holiday/weekend, skipping ${cron}`)
    return
  }

  const runWithLog = (task: string, fn: () => Promise<string>) =>
    ctx.waitUntil((async () => {
      const startedAt = Date.now()
      try {
        const summary = await fn()
        const status = classifyCronSummary(summary)
        await logCronResult(env.KV, task, {
          status,
          summary,
          duration_ms: Date.now() - startedAt,
        })
      } catch (e: any) {
        await logCronResult(env.KV, task, {
          status: 'error',
          summary: e?.message ?? 'Unknown error',
          duration_ms: Date.now() - startedAt,
          error: String(e),
        }, env as any)
      }
    })())

  const workerHandled = await handleWorkerDomainCron({
    cron,
    env,
    ctx,
    twTodayStr,
    runWithLog,
    runPreMarketWarmup,
    settlePaperT2,
    runIntradayHeartbeat,
    runIntradayRescore,
  })

  const gcpHandled = await handleGcpDomainCron({
    cron,
    env,
    runWithLog,
  })

  if (!workerHandled && !gcpHandled) {
    console.warn(`[Cron] Unhandled cron expression: ${cron}`)
  }
}
