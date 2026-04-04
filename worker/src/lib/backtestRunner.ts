/**
 * backtestRunner.ts — Automated Backtest Cron (ROADMAP #4)
 *
 * Two modes:
 * 1. External Freqtrade: POST ${BACKTEST_SERVICE_URL}/run → Docker runs export_d1 → freqtrade → import_results
 * 2. Worker-native fallback: compute metrics from paper_orders + paper_daily_snapshots directly
 */
import type { Bindings } from '../types'

// ── Types ────────────────────────────────────────────────────────────────────
interface BacktestMetrics {
  strategy: string
  timerange: string
  total_trades: number
  win_rate: number | null
  sharpe: number | null
  sortino: number | null
  calmar: number | null
  max_drawdown: number | null
  cagr: number | null
  profit_factor: number | null
  expectancy: number | null
}

// ── Main Entry ───────────────────────────────────────────────────────────────
export async function runWeeklyBacktest(env: Bindings): Promise<string> {
  const backtestUrl = (env as any).BACKTEST_SERVICE_URL as string | undefined

  if (backtestUrl) {
    return await runExternalBacktest(env, backtestUrl)
  }

  // Fallback: Worker-native backtest from paper trading data
  return await runNativeBacktest(env)
}

// ── Mode 1: External Freqtrade Docker ────────────────────────────────────────
async function runExternalBacktest(env: Bindings, url: string): Promise<string> {
  console.log(`[Backtest] Triggering external Freqtrade: ${url}`)

  const res = await fetch(`${url}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.STOCKVISION_AUTH_TOKEN ?? ''}`,
    },
    body: JSON.stringify({ mode: 'weekly' }),
    signal: AbortSignal.timeout(540_000), // 9 min (Workers max ~10 min)
  }).catch((e: any) => {
    console.warn(`[Backtest] External service unreachable: ${e.message}`)
    return null
  })

  if (!res || !res.ok) {
    console.warn(`[Backtest] External failed (${res?.status}), falling back to native`)
    return await runNativeBacktest(env)
  }

  const body = await res.json<any>().catch(() => null)
  const msg = `外部回測完成: ${body?.total_trades ?? '?'} trades, Sharpe=${body?.sharpe ?? '?'}`
  console.log(`[Backtest] ${msg}`)
  return msg
}

// ── Mode 2: Worker-Native Backtest from Paper Trading ────────────────────────
async function runNativeBacktest(env: Bindings): Promise<string> {
  console.log('[Backtest] Running native backtest from paper trading data...')

  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  // 1. Fetch all closed round-trip trades (buy→sell pairs)
  const { results: orders } = await env.DB.prepare(`
    SELECT symbol, side, shares, price, commission, tax, total_cost, created_at
    FROM paper_orders
    WHERE account_id = 1
    ORDER BY created_at ASC
  `).all<any>()

  if (!orders || orders.length < 2) {
    console.log('[Backtest] Not enough orders for backtest')
    return '訂單不足，跳過回測'
  }

  // Build round-trip trades: match buys with sells per symbol (FIFO)
  const trades = buildRoundTrips(orders)

  if (trades.length === 0) {
    console.log('[Backtest] No completed round-trip trades')
    return '無已平倉交易，跳過回測'
  }

  // 2. Fetch daily snapshots for time-series metrics
  const { results: snapshots } = await env.DB.prepare(`
    SELECT date, total_value, pnl_pct
    FROM paper_daily_snapshots
    WHERE account_id = 1
    ORDER BY date ASC
  `).all<any>()

  // 3. Fetch initial cash
  const account = await env.DB.prepare(
    'SELECT initial_cash FROM paper_accounts WHERE id = 1'
  ).first<any>()
  const initialCash = account?.initial_cash ?? 2_000_000

  // 4. Calculate metrics
  const metrics = calculateMetrics(trades, snapshots ?? [], initialCash, today)

  // 5. Write to D1
  await writeBacktestResults(env, metrics, today)

  // 6. Discord notification
  await notifyDiscord(env, metrics)

  const msg = `原生回測完成: ${metrics.total_trades} trades, WR=${((metrics.win_rate ?? 0) * 100).toFixed(1)}%, Sharpe=${metrics.sharpe?.toFixed(2) ?? '-'}, MDD=${((metrics.max_drawdown ?? 0) * 100).toFixed(1)}%, PF=${metrics.profit_factor?.toFixed(2) ?? '-'}`
  console.log(`[Backtest] ${msg}`)
  return msg
}

// ── Round-Trip Builder (FIFO) ────────────────────────────────────────────────
interface RoundTrip {
  symbol: string
  buyDate: string
  sellDate: string
  buyPrice: number
  sellPrice: number
  shares: number
  profitRatio: number  // net of fees
  holdingDays: number
}

function buildRoundTrips(orders: any[]): RoundTrip[] {
  // Pending buy inventory per symbol: { shares, price, date }[]
  const inventory: Record<string, { shares: number; price: number; date: string }[]> = {}
  const trades: RoundTrip[] = []

  for (const o of orders) {
    const sym = o.symbol
    if (o.side === 'buy') {
      if (!inventory[sym]) inventory[sym] = []
      inventory[sym].push({ shares: o.shares, price: o.price, date: o.created_at.slice(0, 10) })
    } else if (o.side === 'sell') {
      if (!inventory[sym] || inventory[sym].length === 0) continue
      let remaining = o.shares
      while (remaining > 0 && inventory[sym].length > 0) {
        const lot = inventory[sym][0]
        const matched = Math.min(remaining, lot.shares)
        const buyCost = lot.price * matched * (1 + 0.001425) // 手續費
        const sellProceeds = o.price * matched * (1 - 0.001425 - 0.003) // 手續費+稅
        const profitRatio = (sellProceeds - buyCost) / buyCost

        const buyDate = lot.date
        const sellDate = o.created_at.slice(0, 10)
        const holdingDays = Math.max(1, Math.round(
          (new Date(sellDate).getTime() - new Date(buyDate).getTime()) / 86400_000
        ))

        trades.push({
          symbol: sym,
          buyDate,
          sellDate,
          buyPrice: lot.price,
          sellPrice: o.price,
          shares: matched,
          profitRatio,
          holdingDays,
        })

        lot.shares -= matched
        remaining -= matched
        if (lot.shares <= 0) inventory[sym].shift()
      }
    }
  }

  return trades
}

// ── Metrics Calculator ───────────────────────────────────────────────────────
function calculateMetrics(
  trades: RoundTrip[],
  snapshots: any[],
  initialCash: number,
  today: string,
): BacktestMetrics {
  const total = trades.length
  const wins = trades.filter(t => t.profitRatio > 0)
  const losses = trades.filter(t => t.profitRatio <= 0)

  const winRate = total > 0 ? wins.length / total : null

  // Profit factor
  const grossProfit = wins.reduce((s, t) => s + t.profitRatio, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.profitRatio, 0)) || 0.001
  const profitFactor = grossProfit / grossLoss

  // Expectancy
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0
  const wr = winRate ?? 0
  const expectancy = avgWin * wr - avgLoss * (1 - wr)

  // Time-series metrics from snapshots
  let sharpe: number | null = null
  let sortino: number | null = null
  let calmar: number | null = null
  let maxDrawdown: number | null = null
  let cagr: number | null = null

  if (snapshots.length >= 10) {
    const values = snapshots.map(s => s.total_value as number)
    const dailyReturns: number[] = []
    for (let i = 1; i < values.length; i++) {
      if (values[i - 1] > 0) dailyReturns.push((values[i] - values[i - 1]) / values[i - 1])
    }

    if (dailyReturns.length >= 5) {
      const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
      const variance = dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyReturns.length
      const std = Math.sqrt(variance)

      // Sharpe (annualized, risk-free = 0)
      sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : null

      // Sortino (only downside deviation)
      const downReturns = dailyReturns.filter(r => r < 0)
      if (downReturns.length > 0) {
        const downVariance = downReturns.reduce((a, b) => a + b ** 2, 0) / dailyReturns.length
        const downDev = Math.sqrt(downVariance)
        sortino = downDev > 0 ? (mean / downDev) * Math.sqrt(252) : null
      }
    }

    // Max Drawdown
    let peak = values[0]
    let maxDd = 0
    for (const v of values) {
      if (v > peak) peak = v
      const dd = peak > 0 ? (peak - v) / peak : 0
      if (dd > maxDd) maxDd = dd
    }
    maxDrawdown = maxDd

    // CAGR
    const firstValue = values[0]
    const lastValue = values[values.length - 1]
    const tradingDays = values.length
    if (firstValue > 0 && tradingDays > 1) {
      const years = tradingDays / 252
      cagr = years > 0 ? Math.pow(lastValue / firstValue, 1 / years) - 1 : null
    }

    // Calmar = CAGR / MDD
    if (cagr != null && maxDrawdown != null && maxDrawdown > 0) {
      calmar = cagr / maxDrawdown
    }
  }

  // Timerange
  const firstDate = trades[0]?.buyDate ?? snapshots[0]?.date ?? '?'
  const lastDate = trades[trades.length - 1]?.sellDate ?? today
  const timerange = `${firstDate.replace(/-/g, '')}–${lastDate.replace(/-/g, '')}`

  return {
    strategy: 'StockVision-Paper',
    timerange,
    total_trades: total,
    win_rate: winRate,
    sharpe,
    sortino,
    calmar,
    max_drawdown: maxDrawdown,
    cagr,
    profit_factor: profitFactor,
    expectancy,
  }
}

// ── D1 Write ─────────────────────────────────────────────────────────────────
async function writeBacktestResults(env: Bindings, m: BacktestMetrics, runDate: string) {
  await env.DB.prepare(`
    INSERT OR REPLACE INTO backtest_results
      (run_date, strategy, timerange, total_trades, win_rate,
       sharpe, sortino, calmar, max_drawdown, cagr,
       profit_factor, expectancy, raw_results)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    runDate,
    m.strategy,
    m.timerange,
    m.total_trades,
    m.win_rate,
    m.sharpe,
    m.sortino,
    m.calmar,
    m.max_drawdown,
    m.cagr,
    m.profit_factor,
    m.expectancy,
    JSON.stringify(m),
  ).run()

  console.log(`[Backtest] Written to D1: ${runDate} / ${m.strategy}`)
}

// ── Discord Notification ─────────────────────────────────────────────────────
async function notifyDiscord(env: Bindings, m: BacktestMetrics) {
  const webhookUrl = (env as any).DISCORD_WEBHOOK_URL
  if (!webhookUrl) return

  const embed = {
    title: '📊 週回測報告',
    color: (m.sharpe ?? 0) > 1 ? 0x22c55e : (m.sharpe ?? 0) > 0 ? 0xeab308 : 0xef4444,
    fields: [
      { name: 'Strategy', value: m.strategy, inline: true },
      { name: 'Timerange', value: m.timerange, inline: true },
      { name: 'Trades', value: String(m.total_trades), inline: true },
      { name: 'Win Rate', value: m.win_rate != null ? `${(m.win_rate * 100).toFixed(1)}%` : '-', inline: true },
      { name: 'Sharpe', value: m.sharpe?.toFixed(2) ?? '-', inline: true },
      { name: 'Sortino', value: m.sortino?.toFixed(2) ?? '-', inline: true },
      { name: 'MDD', value: m.max_drawdown != null ? `${(m.max_drawdown * 100).toFixed(1)}%` : '-', inline: true },
      { name: 'CAGR', value: m.cagr != null ? `${(m.cagr * 100).toFixed(1)}%` : '-', inline: true },
      { name: 'Calmar', value: m.calmar?.toFixed(2) ?? '-', inline: true },
      { name: 'PF', value: m.profit_factor?.toFixed(2) ?? '-', inline: true },
      { name: 'Expectancy', value: m.expectancy?.toFixed(4) ?? '-', inline: true },
    ],
    timestamp: new Date().toISOString(),
  }

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  }).catch(e => console.warn('[Backtest] Discord notification failed:', e))
}
