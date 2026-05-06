import { Hono } from 'hono'
import { requireServiceToken } from '../lib/auth'
import { categorizeExitReason, checkExitConditions } from '../lib/paperExitPolicy'
import type { Bindings, Variables } from '../types'

export const adminParityRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminParityRoutes.post('/api/admin/test/exit-cascade', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => null)
  if (!body || !body.position || body.currentPrice == null || body.atr14 == null) {
    return c.json({
      error: 'Body must be { position, currentPrice, atr14, hasMlSell?, isEOD?, cfg? }',
    }, 400)
  }

  const { getTradingConfig } = await import('../lib/tradingConfig')
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

    return c.json({
      action: decision.action,
      reason: decision.reason,
      reason_category: categorizeExitReason(decision.reason),
      sellShares: decision.sellShares ?? null,
      newTrailingStop: decision.newTrailingStop ?? null,
      newHighest: decision.newHighest ?? null,
      moveStopToEntry: decision.moveStopToEntry ?? false,
    })
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, 500)
  }
})
