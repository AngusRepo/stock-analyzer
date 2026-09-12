import type { Bindings } from '../types'
import { batchGetIntradayOHLC } from './paperIntradayData'
import { paperDomainDatabase } from './paperDomainDatabase'
import { paperAccountId, paperExecutionNow, paperExecutionDate, paperExecutionFetch } from './paperExecutionScope'
export async function runIntradayRescore(env: Bindings, cron: string, twTodayStr: string) {
  const { getTradingConfig } = await import('./tradingConfig')
  const cfg = await getTradingConfig(env.KV)
  if (!cfg.intraday.rescoreEnabled) return 'SKIP: rescoreEnabled=false'

  const controllerUrl = env.ML_CONTROLLER_URL
  if (!controllerUrl) return 'SKIP: no ML_CONTROLLER_URL'

  const { results: positions } = await paperDomainDatabase(env).prepare(`
    SELECT symbol, name, shares, avg_cost, entry_price, entry_date,
           initial_stop, trailing_stop, tp1_price, tp1_hit
    FROM paper_positions WHERE account_id=? AND shares>0
  `).bind(paperAccountId()).all<any>()
  if (!positions || positions.length === 0) return 'No open positions'

  const symbols = positions.map((p: any) => p.symbol)
  const quoteMap = await batchGetIntradayOHLC(symbols, {
    SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (env as any).PROXY_SERVICE_TOKEN,
    requireBrokerQuote: true,
  })
  if (quoteMap.size === 0) return 'No intraday prices available'

  const prevDay = new Date(paperExecutionNow() + 8 * 3600_000 - 86400_000).toISOString().slice(0, 10)
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
    current_price: quoteMap.get(position.symbol)?.last ?? position.entry_price ?? position.avg_cost,
    ml_confidence: null,
    warn_history: warnHistoryMap[position.symbol] ?? null,
  }))

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

  const res = await paperExecutionFetch(`${controllerUrl}/intraday/rescore`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ positions: positionInputs, today: twTodayStr }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`ml-controller /intraday/rescore HTTP ${res.status}`)

  const result = await res.json() as any
  const exitSignals: any[] = []
  const warnSignals: any[] = []

  for (const row of result.results ?? []) {
    if (row.action !== 'EXIT') continue

    const cooldownKey = `intraday:rescore-cooldown:${row.symbol}:${twTodayStr}`
    if (await env.KV.get(cooldownKey)) continue

    exitSignals.push(row)
    await env.KV.put(cooldownKey, paperExecutionDate().toISOString(), { expirationTtl: cfg.intraday.rescoreCooldownMin * 60 })
  }

  warnSignals.push(...(result.results ?? []).filter((row: any) => row.action === 'WARN'))
  const cautionSignals = [...exitSignals, ...warnSignals]
  for (const signal of cautionSignals) {
    const warnKey = `intraday:warn:${signal.symbol}:${twTodayStr}`
    const existing = await env.KV.get(warnKey, 'json') as { count: number; first_conf: number } | null
    await env.KV.put(
      warnKey,
      JSON.stringify({
        count: (existing?.count ?? 0) + 1,
        first_conf: existing?.first_conf ?? signal.adjusted_confidence,
        last_conf: signal.adjusted_confidence,
        last_at: paperExecutionDate().toISOString(),
        last_action: signal.action,
        execution_policy: 'observe_only',
      }),
      { expirationTtl: 172800 },
    )
  }

  if ((exitSignals.length > 0 || warnSignals.length > 0) && (env as any).DISCORD_WEBHOOK_URL) {
    const { sendDiscordNotification } = await import('./notify')
    const slot = ({ '0 2 * * 1-5': '10:00', '0 3 * * 1-5': '11:00', '0 4 * * 1-5': '12:00', '30 4 * * 1-5': '12:30' } as Record<string, string>)[cron]
    const lines = [
      `ML Re-score (${slot ?? cron})`,
      ...exitSignals.map((signal: any) => `EXIT_SIGNAL only: ${signal.symbol} conf ${signal.original_confidence.toFixed(3)} -> ${signal.adjusted_confidence.toFixed(3)}; no auto-sell, exit owner remains TP/Stop policy`),
      ...warnSignals.map((warn: any) => `WARN: ${warn.symbol} conf ${warn.original_confidence.toFixed(3)} -> ${warn.adjusted_confidence.toFixed(3)} (${warn.is_same_day ? 'same-day' : 'overnight'})`),
    ]
    await sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL, lines.join('\n'))
  }

  return `${result.summary?.total ?? 0} positions: 0 auto EXIT, ${exitSignals.length} EXIT_SIGNAL, ${warnSignals.length} WARN, ${(result.summary?.hold ?? 0)} HOLD`
}
