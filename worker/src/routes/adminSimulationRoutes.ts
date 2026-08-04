import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'
import { hasServiceToken } from '../lib/auth'

export const adminSimulationRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function requireServiceToken(c: any) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!hasServiceToken(token, c.env.STOCKVISION_AUTH_TOKEN, c.env.STOCKVISION_AUTH_TOKEN_PREVIOUS)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  return null
}

adminSimulationRoutes.post('/api/admin/test/simulate-trade', async (c) => {
  const authError = requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => null)
  if (!body || !body.direction || body.entry == null || body.stop == null
      || body.target1 == null || body.target2 == null || !Array.isArray(body.bars)) {
    return c.json({
      error: 'Body must be { direction: "up"|"down", entry, stop, target1, target2, bars: [...] }',
    }, 400)
  }

  try {
    const { simulateTrade } = await import('../lib/predictionVerifier')
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

adminSimulationRoutes.post('/api/admin/test/score-multi-factor', async (c) => {
  const authError = requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => null)
  if (!body || !Array.isArray(body.prices) || body.marketReturn5d == null) {
    return c.json({
      error: 'Body must be { prices: CanonicalScreenerPrice[], chips?: [{date,foreign,trust,dealer,...canonicalChipFields}], marketReturn5d, cfg? }',
    }, 400)
  }

  try {
    const { scoreMultiFactor } = await import('../lib/marketScreener')
    const { getTradingConfig } = await import('../lib/tradingConfig')

    const baseCfg = await getTradingConfig(c.env.KV)
    const cfg = body.cfg
      ? { ...baseCfg, ...body.cfg, screener: { ...baseCfg.screener, ...(body.cfg.screener ?? {}) } }
      : baseCfg

    let chipDates: Map<string, any> | undefined
    if (Array.isArray(body.chips) && body.chips.length > 0) {
      chipDates = new Map()
      for (const chip of body.chips) {
        chipDates.set(String(chip.date), {
          foreign: Number(chip.foreign ?? 0),
          trust: Number(chip.trust ?? 0),
          dealer: Number(chip.dealer ?? chip.dealer_net ?? 0),
          brokerFlow: Number(chip.brokerFlow ?? chip.broker_net_shares ?? 0),
          estimatedAmount: chip.estimatedAmount ?? chip.broker_estimated_amount ?? null,
          brokerCount: chip.brokerCount ?? chip.broker_count ?? null,
          concentration: chip.concentration ?? chip.broker_concentration ?? null,
          marginBalance: chip.marginBalance ?? chip.margin_balance ?? null,
          shortBalance: chip.shortBalance ?? chip.short_balance ?? null,
          marginUsageRatio: chip.marginUsageRatio ?? chip.margin_usage_ratio ?? null,
          shortBuy: chip.shortBuy ?? chip.short_buy ?? null,
          shortSell: chip.shortSell ?? chip.short_sell ?? null,
          shortStockRepayment: chip.shortStockRepayment ?? chip.short_stock_repayment ?? null,
          shortUsageRatio: chip.shortUsageRatio ?? chip.short_usage_ratio ?? null,
          securityLendingSell: chip.securityLendingSell ?? chip.security_lending_sell ?? null,
          securityLendingSellReturn: chip.securityLendingSellReturn ?? chip.security_lending_sell_return ?? null,
          securityLendingSellBalance: chip.securityLendingSellBalance ?? chip.security_lending_sell_balance ?? null,
          securityLendingBalance: chip.securityLendingBalance ?? chip.security_lending_balance ?? null,
        })
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
