import { Hono } from 'hono'
import { requireServiceToken } from '../lib/auth'
import type { Bindings, Variables } from '../types'

export const adminConfigCoreRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminConfigCoreRoutes.get('/api/admin/config', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const { getTradingConfig } = await import('../lib/tradingConfig')
  const config = await getTradingConfig(c.env.KV)
  return c.json(config)
})

adminConfigCoreRoutes.put('/api/admin/config', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON' }, 400)

  const { setTradingConfig, getTradingConfig, validateTradingConfig, mergeAlphaFrameworkConfig } = await import('../lib/tradingConfig')
  const current = await getTradingConfig(c.env.KV)
  const mergedPosition = {
    ...current.position,
    ...(body.position ?? {}),
    kelly: { ...current.position.kelly, ...(body.position?.kelly ?? {}) },
    swapWeights: { ...current.position.swapWeights, ...(body.position?.swapWeights ?? {}) },
  }
  const alphaBody = body.alphaFramework ?? body.alpha_framework ?? {}
  const alphaOverlayBody = alphaBody.riskOverlay ?? alphaBody.risk_overlay ?? {}
  const alphaAllocationBody = alphaBody.allocation ?? {}
  const alphaBodyWeights = alphaAllocationBody.weights ?? {}
  const mergedAlphaFramework = mergeAlphaFrameworkConfig({
    ...current.alphaFramework,
    ...alphaBody,
    riskOverlay: {
      ...current.alphaFramework.riskOverlay,
      ...alphaOverlayBody,
    },
    allocation: {
      ...current.alphaFramework.allocation,
      ...alphaAllocationBody,
      weights: {
        bull: { ...current.alphaFramework.allocation.weights.bull, ...(alphaBodyWeights.bull ?? {}) },
        bear: { ...current.alphaFramework.allocation.weights.bear, ...(alphaBodyWeights.bear ?? {}) },
        volatile: { ...current.alphaFramework.allocation.weights.volatile, ...(alphaBodyWeights.volatile ?? {}) },
        sideways: { ...current.alphaFramework.allocation.weights.sideways, ...(alphaBodyWeights.sideways ?? {}) },
      },
    },
  })
  const merged = {
    fees: { ...current.fees, ...body.fees },
    circuit: { ...current.circuit, ...body.circuit },
    exit: { ...current.exit, ...body.exit },
    position: mergedPosition,
    screener: { ...current.screener, ...body.screener },
    rrg: { ...current.rrg, ...body.rrg },
    barrier: { ...current.barrier, ...body.barrier },
    ranking: { ...current.ranking, ...body.ranking },
    ensemble_v2: { ...current.ensemble_v2, ...body.ensemble_v2 },
    signal: { ...current.signal, ...body.signal },
    sltp: { ...current.sltp, ...body.sltp },
    L2_formula: { ...current.L2_formula, ...body.L2_formula },
    risk: { ...current.risk, ...(body as any).risk },
    intraday: { ...current.intraday, ...body.intraday },
    momentum: { ...current.momentum, ...body.momentum },
    alphaFramework: mergedAlphaFramework,
  }
  const errors = validateTradingConfig(merged)
  if (errors.length > 0) return c.json({ error: 'Config validation failed', errors }, 400)

  const {
    PRODUCTION_OVERRIDE_HEADER,
    isExplicitProductionOverride,
    recordProductionOverride,
    validatePromotionPacketForProd,
  } = await import('../lib/parameterCandidateRegistry')
  const candidateId = typeof body.candidate_id === 'string' ? body.candidate_id : undefined
  const promotionPacketId = typeof body.promotion_packet_id === 'string' ? body.promotion_packet_id : undefined
  const overrideReason = String(body.override_reason ?? body.reason ?? '').trim()
  const promotionGate = await validatePromotionPacketForProd(c.env.DB, {
    candidateId,
    promotionPacketId,
  })
  const override = isExplicitProductionOverride(c.req.header(PRODUCTION_OVERRIDE_HEADER), overrideReason)
  if (!promotionGate.ok && !override) {
    return c.json({
      error: 'config_put_requires_promotion_packet_or_override',
      reason: promotionGate.error,
      hint: `Attach promotion_packet_id + candidate_id, or use ${PRODUCTION_OVERRIDE_HEADER}: true with override_reason.`,
    }, 400)
  }
  const overrideAudit = !promotionGate.ok
    ? await recordProductionOverride(c.env.DB, {
      route: '/api/admin/config',
      reason: overrideReason,
      candidateId,
      promotionPacketId,
      detail: { source: 'direct_put' },
    })
    : null

  await setTradingConfig(c.env.KV, merged, {
    source: overrideAudit ? 'manual_override' : 'parameter_promotion',
    push_id: promotionPacketId,
  })
  return c.json({
    success: true,
    config: merged,
    promotion_packet_id: promotionPacketId ?? null,
    override_audit_id: overrideAudit?.audit_id ?? null,
  })
})

adminConfigCoreRoutes.post('/api/admin/config/push-defaults', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError
  const body = await c.req.json<any>().catch(() => null) ?? {}

  const { getTradingConfig, setTradingConfig, DEFAULT_TRADING_CONFIG, mergeAlphaFrameworkConfig } = await import('../lib/tradingConfig')
  const current = await getTradingConfig(c.env.KV)
  const d = DEFAULT_TRADING_CONFIG
  const filled = {
    fees: { ...d.fees, ...current.fees },
    circuit: { ...d.circuit, ...current.circuit },
    exit: { ...d.exit, ...current.exit },
    position: {
      ...d.position,
      ...current.position,
      kelly: { ...d.position.kelly, ...(current.position?.kelly ?? {}) },
      swapWeights: { ...d.position.swapWeights, ...(current.position?.swapWeights ?? {}) },
    },
    screener: { ...d.screener, ...current.screener },
    rrg: { ...d.rrg, ...current.rrg },
    barrier: { ...d.barrier, ...current.barrier },
    ranking: { ...d.ranking, ...current.ranking },
    ensemble_v2: { ...d.ensemble_v2, ...(current as any).ensemble_v2 },
    signal: { ...d.signal, ...current.signal },
    sltp: { ...d.sltp, ...current.sltp },
    L2_formula: { ...d.L2_formula, ...current.L2_formula },
    risk: { ...d.risk, ...(current as any).risk },
    intraday: { ...d.intraday, ...(current as any).intraday },
    momentum: { ...d.momentum, ...(current as any).momentum },
    alphaFramework: mergeAlphaFrameworkConfig((current as any).alphaFramework ?? (current as any).alpha_framework),
  }

  const overrideReason = String(body.override_reason ?? body.reason ?? '').trim()
  const { PRODUCTION_OVERRIDE_HEADER, isExplicitProductionOverride, recordProductionOverride } = await import('../lib/parameterCandidateRegistry')
  if (!isExplicitProductionOverride(c.req.header(PRODUCTION_OVERRIDE_HEADER), overrideReason)) {
    return c.json({
      error: 'push_defaults_requires_production_override',
      hint: `Use ${PRODUCTION_OVERRIDE_HEADER}: true with override_reason.`,
    }, 400)
  }
  const overrideAudit = await recordProductionOverride(c.env.DB, {
    route: '/api/admin/config/push-defaults',
    reason: overrideReason,
    detail: { source: 'push_defaults' },
  })

  await setTradingConfig(c.env.KV, filled as any, {
    source: 'manual_override',
    push_id: overrideAudit.audit_id,
  })
  return c.json({
    success: true,
    override_audit_id: overrideAudit.audit_id,
    message: 'Schema defaults 已補齊到 KV，既有值會保留',
    config: filled,
  })
})

adminConfigCoreRoutes.get('/api/admin/kv-get', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const key = c.req.query('key')
  if (!key) return c.json({ error: 'Missing ?key= param' }, 400)

  const type = (c.req.query('type') ?? 'text').toLowerCase()
  const value = type === 'json'
    ? await c.env.KV.get(key, 'json')
    : await c.env.KV.get(key, 'text')

  if (value === null) return c.json({ key, value: null, exists: false }, 404)
  return c.json({ key, value, exists: true })
})
