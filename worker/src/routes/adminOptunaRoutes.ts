import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireAdminOrServiceToken, requireServiceToken } from '../lib/auth'
import { evaluateGaPromotion, formatGaPromotionNotification } from '../lib/gaPromotion'
import { sendOperatorNotification } from '../lib/notify'
import {
  LEGACY_REGIME_KEY,
  LEGACY_REGIME_META_KEY,
  MARKET_REGIME_STATE_KEY,
  buildMarketRegimeState,
  persistMarketRegimeState,
} from '../lib/marketRegimeState'
import type { Bindings, Variables } from '../types'

export const adminOptunaRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminOptunaRoutes.post('/api/admin/ga-promotion/review', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => null)
  const action = String(body?.action ?? '').toLowerCase()
  const level = String(body?.level ?? 'L3').toUpperCase()
  if (!['request', 'approve', 'reject'].includes(action)) {
    return c.json({ error: "action must be 'request', 'approve', or 'reject'" }, 400)
  }
  if (!['L3', 'L4'].includes(level)) {
    return c.json({ error: 'level must be L3 or L4' }, 400)
  }

  const latestKey = 'optimizer:ga:latest'
  const previousRaw = await c.env.KV.get(latestKey, 'json').catch(() => null) as any
  if (!previousRaw) return c.json({ error: 'optimizer:ga:latest missing' }, 404)

  const now = new Date().toISOString()
  const promotionPatch: Record<string, unknown> = {
    ...((previousRaw as any).promotion ?? {}),
    requested_level: level,
    reviewed_at: now,
    reviewed_by: body?.reviewed_by ?? body?.approved_by ?? 'Wei',
    review_action: action,
    review_reason: body?.reason ?? null,
  }
  if (action === 'approve') {
    promotionPatch.approved_level = level
    promotionPatch.approved_at = now
  }
  if (action === 'reject') {
    promotionPatch.requested_level = null
    promotionPatch.rejected_level = level
    promotionPatch.rejected_at = now
    promotionPatch.approved_level = null
  }

  const nextState: Record<string, any> = {
    ...(previousRaw as Record<string, unknown>),
    promotion: promotionPatch,
    updated_at: now,
    production_learning_loop: true,
    mutates_trading_config: false,
  }
  const promotion = evaluateGaPromotion(nextState as Record<string, any>, previousRaw)
  nextState.status = promotion.status
  nextState.promotion = {
    ...promotionPatch,
    ...promotion,
    evaluated_at: now,
    previous_level: previousRaw?.promotion?.level ?? null,
    trading_config_unchanged: true,
  }

  const auditKey = `optimizer:ga:review:${twToday()}:${Date.now()}`
  await c.env.KV.put(latestKey, JSON.stringify(nextState))
  await c.env.KV.put(auditKey, JSON.stringify({
    source: 'ga_optimizer',
    action,
    level,
    reviewer: nextState.promotion.reviewed_by,
    reason: body?.reason ?? null,
    promotion,
    latest_key: latestKey,
    reviewed_at: now,
    trading_config_unchanged: true,
  }), { expirationTtl: 180 * 86400 })

  return c.json({
    success: true,
    source: 'ga_optimizer',
    action,
    level,
    updatedKeys: [latestKey, auditKey],
    promotion: nextState.promotion,
    mutates_trading_config: false,
    message: 'GA promotion review recorded; trading:config remains unchanged.',
  })
})

adminOptunaRoutes.post('/api/admin/optuna-push', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => null)
  if (!body || !body.source || !body.params) {
    return c.json({ error: 'Body must be { source, params, meta? }' }, 400)
  }

  const { source, params, meta } = body
  if (source === 'regime') {
    const label = String(params.label ?? 'sideways')
    const validLabels = new Set(['bull_market', 'volatile', 'sideways', 'bear_market'])
    if (!validLabels.has(label)) {
      return c.json({
        error: `Invalid regime label: ${label}`,
        allowed: Array.from(validLabels),
      }, 400)
    }

    const state = buildMarketRegimeState({
      label,
      runDate: typeof meta?.run_date === 'string' ? meta.run_date : null,
      computedAt: typeof meta?.computed_at === 'string' ? meta.computed_at : null,
      params,
    })
    await persistMarketRegimeState(c.env.KV, state)

    const auditKey = `audit:optuna-push:regime:${twToday()}`
    await c.env.KV.put(auditKey, JSON.stringify({
      source: 'regime',
      params,
      market_regime_state: state,
      meta: meta ?? null,
      pushed_at: new Date().toISOString(),
    }), { expirationTtl: 30 * 86400 })

    return c.json({
      success: true,
      source: 'regime',
      regime: label,
      updatedKeys: [MARKET_REGIME_STATE_KEY, LEGACY_REGIME_KEY, LEGACY_REGIME_META_KEY],
    })
  }

  const { getTradingConfig, setTradingConfig, validateTradingConfig, writeSandbox, mergeAlphaFrameworkConfig } = await import('../lib/tradingConfig')
  const current = await getTradingConfig(c.env.KV)

  let merged: any = current
  let updatedFields: string[] = []

  switch (source) {
    case 'barrier': {
      const barrier = {
        upperMult: Number(params.upper_mult ?? params.upperMult ?? current.barrier.upperMult),
        lowerMult: Number(params.lower_mult ?? params.lowerMult ?? current.barrier.lowerMult),
        upperPctCap: Number(params.upper_pct_cap ?? params.upperPctCap ?? current.barrier.upperPctCap),
        lowerPctCap: Number(params.lower_pct_cap ?? params.lowerPctCap ?? current.barrier.lowerPctCap),
        maxDays: Number(params.max_days ?? params.maxDays ?? current.barrier.maxDays),
      }
      merged = { ...current, barrier }
      updatedFields = Object.keys(barrier).map((key) => `barrier.${key}`)
      break
    }
    case 'signal': {
      const signal = {
        strongSignalScore: Number(params.strong_signal_score ?? current.signal.strongSignalScore),
        buySignalScore: Number(params.buy_signal_score ?? current.signal.buySignalScore),
        holdSignalScore: Number(params.hold_signal_score ?? current.signal.holdSignalScore),
        consensusThreshold: Number(params.consensus_threshold ?? current.signal.consensusThreshold),
      }
      merged = { ...current, signal }
      updatedFields = Object.keys(signal).map((key) => `signal.${key}`)
      break
    }
    case 'sltp': {
      const sltp = {
        slMultBase: Number(params.sl_mult ?? params.slMultBase ?? current.sltp.slMultBase),
        tpMultBase: Number(params.tp_mult ?? params.tpMultBase ?? current.sltp.tpMultBase),
        trailSwitch3pct: Number(params.trail_switch_3pct ?? params.trailSwitch3pct ?? current.sltp.trailSwitch3pct),
        trailSwitch8pct: Number(params.trail_switch_8pct ?? params.trailSwitch8pct ?? current.sltp.trailSwitch8pct),
        volThresholdLow: Number(params.vol_threshold_low ?? params.volThresholdLow ?? current.sltp.volThresholdLow),
        volThresholdHigh: Number(params.vol_threshold_high ?? params.volThresholdHigh ?? current.sltp.volThresholdHigh),
        slMultLow: Number(params.sl_mult_low ?? params.slMultLow ?? current.sltp.slMultLow),
        tpMultLow: Number(params.tp_mult_low ?? params.tpMultLow ?? current.sltp.tpMultLow),
        slMultHigh: Number(params.sl_mult_high ?? params.slMultHigh ?? current.sltp.slMultHigh),
        tpMultHigh: Number(params.tp_mult_high ?? params.tpMultHigh ?? current.sltp.tpMultHigh),
        volSkipThreshold: Number(params.vol_skip_threshold ?? params.volSkipThreshold ?? current.sltp.volSkipThreshold),
      }
      const exit = {
        ...current.exit,
        trailMultDefault: Number(params.trailMultDefault ?? current.exit.trailMultDefault),
        trailMultAt3pct: Number(params.trailMultAt3pct ?? current.exit.trailMultAt3pct),
        trailMultAt8pct: Number(params.trailMultAt8pct ?? current.exit.trailMultAt8pct),
        tp1SellRatio: Number(params.tp1SellRatio ?? current.exit.tp1SellRatio),
        timeStopDays: Number(params.timeStopDays ?? current.exit.timeStopDays),
        hardStopPct: Number(params.hardStopPct ?? current.exit.hardStopPct),
      }
      merged = { ...current, sltp, exit }
      updatedFields = [
        ...Object.keys(sltp).map((key) => `sltp.${key}`),
        'exit.trailMult*',
        'exit.tp1SellRatio',
        'exit.timeStopDays',
        'exit.hardStopPct',
      ]
      break
    }
    case 'conformal': {
      const L2_formula = {
        ...current.L2_formula,
        ...(params.coverage != null && { conformal_coverage: Number(params.coverage) }),
        ...(params.min_calibration_size != null && { conformal_min_cal: Number(params.min_calibration_size) }),
        ...(params.max_residuals != null && { conformal_max_residuals: Number(params.max_residuals) }),
      }
      merged = { ...current, L2_formula }
      updatedFields = ['L2_formula.conformal_*']
      break
    }
    case 'risk_params': {
      const circuit = {
        ...current.circuit,
        ...(params.drawdown_halt != null && { drawdownHalt: Number(params.drawdown_halt) }),
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
        ...(params.risk_pct != null && { riskPctPerTrade: Number(params.risk_pct) }),
        ...(params.min_hold_days != null && { swapMinHoldDays: Number(params.min_hold_days) }),
      }
      merged = { ...current, circuit, exit, sltp, position }
      updatedFields = [
        'circuit.drawdownHalt/maxPositionPct',
        'exit.trailMult*',
        'sltp.trailSwitch*',
        'position.risk_pct/min_hold_days',
      ]
      break
    }
    case 'rrg': {
      const rrg = {
        leadingBonus: Number(params.leadingBonus ?? params.leading_bonus ?? current.rrg.leadingBonus),
        improvingBonus: Number(params.improvingBonus ?? params.improving_bonus ?? current.rrg.improvingBonus),
        weakeningBonus: Number(params.weakeningBonus ?? params.weakening_bonus ?? current.rrg.weakeningBonus),
        laggingPenalty: Number(params.laggingPenalty ?? params.lagging_penalty ?? current.rrg.laggingPenalty),
      }
      merged = { ...current, rrg }
      updatedFields = Object.keys(rrg).map((key) => `rrg.${key}`)
      break
    }
    case 'screener': {
      const screener = {
        ...current.screener,
        ...(params.minPrice != null && { minPrice: Number(params.minPrice) }),
        ...(params.maxPrice != null && { maxPrice: Number(params.maxPrice) }),
        ...(params.minAvgVolume != null && { minAvgVolume: Number(params.minAvgVolume) }),
        ...(params.minDailyTurnover != null && { minDailyTurnover: Number(params.minDailyTurnover) }),
        ...(params.maxPerIndustry != null && { maxPerIndustry: Number(params.maxPerIndustry) }),
        ...(params.maxCandidates != null && { maxCandidates: Number(params.maxCandidates) }),
        ...(Array.isArray(params.chipScoreTiers) && { chipScoreTiers: params.chipScoreTiers.map(Number) }),
        ...(Array.isArray(params.chipIntensityThresholds) && { chipIntensityThresholds: params.chipIntensityThresholds.map(Number) }),
        ...(Array.isArray(params.consecBuyBonusTiers) && { consecBuyBonusTiers: params.consecBuyBonusTiers.map(Number) }),
        ...(Array.isArray(params.consecBuyDayThresholds) && { consecBuyDayThresholds: params.consecBuyDayThresholds.map(Number) }),
        ...(Array.isArray(params.rsiScoreTiers) && { rsiScoreTiers: params.rsiScoreTiers.map(Number) }),
        ...(params.macdNegativeFactor != null && { macdNegativeFactor: Number(params.macdNegativeFactor) }),
        ...(params.keltnerMultiplier != null && { keltnerMultiplier: Number(params.keltnerMultiplier) }),
        ...(params.natrThreshold != null && { natrThreshold: Number(params.natrThreshold) }),
        ...(Array.isArray(params.excessReturnRange) && { excessReturnRange: params.excessReturnRange.map(Number) }),
        ...(Array.isArray(params.volRatioRange) && { volRatioRange: params.volRatioRange.map(Number) }),
      }
      const rankingParams = params.ranking
      const ranking = rankingParams ? {
        ...current.ranking,
        ...(rankingParams.alpha != null && { alpha: Number(rankingParams.alpha) }),
        ...(rankingParams.beta != null && { beta: Number(rankingParams.beta) }),
        ...(rankingParams.gamma != null && { gamma: Number(rankingParams.gamma) }),
      } : current.ranking
      merged = { ...current, screener, ranking }
      updatedFields = [
        ...Object.keys(screener).map((key) => `screener.${key}`),
        ...(rankingParams ? Object.keys(rankingParams).map((key) => `ranking.${key}`) : []),
      ]
      break
    }
    case 'alpha_framework': {
      const alphaParams = params.alphaFramework ?? params.alpha_framework ?? params
      const alphaFramework = mergeAlphaFrameworkConfig({
        ...current.alphaFramework,
        ...alphaParams,
        riskOverlay: {
          ...current.alphaFramework.riskOverlay,
          ...(alphaParams.riskOverlay ?? alphaParams.risk_overlay ?? {}),
        },
        allocation: {
          ...current.alphaFramework.allocation,
          ...(alphaParams.allocation ?? {}),
          weights: {
            bull: {
              ...current.alphaFramework.allocation.weights.bull,
              ...((alphaParams.allocation?.weights ?? {}).bull ?? {}),
            },
            bear: {
              ...current.alphaFramework.allocation.weights.bear,
              ...((alphaParams.allocation?.weights ?? {}).bear ?? {}),
            },
            volatile: {
              ...current.alphaFramework.allocation.weights.volatile,
              ...((alphaParams.allocation?.weights ?? {}).volatile ?? {}),
            },
            sideways: {
              ...current.alphaFramework.allocation.weights.sideways,
              ...((alphaParams.allocation?.weights ?? {}).sideways ?? {}),
            },
          },
        },
      })
      merged = { ...current, alphaFramework }
      updatedFields = [
        'alphaFramework.riskOverlay',
        'alphaFramework.allocation.slateSize',
        'alphaFramework.allocation.scoreRoundDecimals',
        'alphaFramework.allocation.weights',
        'alphaFramework.classification',
        'alphaFramework.regimeBucketMultipliers',
        'alphaFramework.scoring',
        'alphaFramework.executionOverlay',
        'alphaFramework.quality',
      ]
      break
    }
    case 'feature_window':
      console.warn(`[OptunaPush] source=${source} not yet wired (deferred to Phase B/C)`)
      return c.json({
        success: false,
        message: `source '${source}' not yet wired`,
        deferred_to: 'Phase B/C',
      }, 501)
    case 'ga_optimizer': {
      const now = new Date().toISOString()
      const previousRaw = await c.env.KV.get('optimizer:ga:latest', 'json').catch(() => null) as any
      const previousPromotion = previousRaw?.promotion && typeof previousRaw.promotion === 'object'
        ? previousRaw.promotion
        : {}
      const learningState = {
        ...(params && typeof params === 'object' ? params : {}),
        source: 'ga_optimizer',
        optimizer: params?.optimizer ?? 'GAOptimizer',
        status: params?.status ?? 'learning',
        production_learning_loop: true,
        mutates_trading_config: false,
        updated_at: now,
        meta: meta ?? null,
      }
      const incomingPromotion = (learningState as any).promotion && typeof (learningState as any).promotion === 'object'
        ? (learningState as any).promotion
        : {}
      learningState.promotion = {
        ...previousPromotion,
        ...incomingPromotion,
      }
      const promotion = evaluateGaPromotion(learningState, previousRaw)
      learningState.status = promotion.status
      learningState.promotion = {
        ...previousPromotion,
        ...incomingPromotion,
        ...promotion,
        evaluated_at: now,
        previous_level: previousRaw?.promotion?.level ?? null,
        trading_config_unchanged: true,
      }
      const latestKey = 'optimizer:ga:latest'
      const historyKey = `optimizer:ga:history:${twToday()}:${Date.now()}`
      const auditKey = `audit:optuna-push:ga_optimizer:${twToday()}`
      const promotionKey = `optimizer:ga:promotion:${twToday()}:${Date.now()}`

      await c.env.KV.put(latestKey, JSON.stringify(learningState))
      await c.env.KV.put(historyKey, JSON.stringify(learningState), { expirationTtl: 90 * 86400 })
      await c.env.KV.put(promotionKey, JSON.stringify({
        source: 'ga_optimizer',
        latest_key: latestKey,
        history_key: historyKey,
        decision: promotion,
        best_score: learningState.best?.score ?? meta?.best_score ?? null,
        pushed_at: now,
      }), { expirationTtl: 180 * 86400 })
      await c.env.KV.put(auditKey, JSON.stringify({
        target: 'production_meta_optimizer_learning_state',
        source: 'ga_optimizer',
        meta: meta ?? null,
        latest_key: latestKey,
        history_key: historyKey,
        promotion_key: promotionKey,
        promotion,
        pushed_at: now,
      }), { expirationTtl: 30 * 86400 })

      const shouldNotify = promotion.autoPromoted ||
        promotion.approvalRequiredForNextLevel ||
        previousRaw?.promotion?.level !== promotion.level
      const notificationChannel = shouldNotify
        ? await sendOperatorNotification(c.env, formatGaPromotionNotification(learningState, promotion))
        : 'not_sent:no_channel_configured'
      const { recordGaParameterCandidate } = await import('../lib/parameterCandidateRegistry')
      const candidate = await recordGaParameterCandidate(c.env.DB, {
        promotionKey,
        runId: meta?.run_id ?? meta?.push_id,
        cadence: meta?.cadence,
        promotion: promotion as any,
        metadata: {
          latest_key: latestKey,
          history_key: historyKey,
          audit_key: auditKey,
          meta: meta ?? null,
        },
      })

      return c.json({
        success: true,
        target: 'production_meta_optimizer_learning_state',
        source: 'ga_optimizer',
        candidate_id: candidate.candidate_id,
        candidate_status: candidate.status,
        updatedKeys: [latestKey, historyKey, promotionKey],
        audit_key: auditKey,
        promotion,
        notification_channel: notificationChannel,
        message: 'GAOptimizer production learning state updated; trading:config unchanged until gated promotion approval.',
      })
    }
    case 'l2_sensitivity': {
      const pcircuit = (params && typeof params.circuit === 'object' && params.circuit) || {}
      const pL2 = (params && typeof params.L2_formula === 'object' && params.L2_formula) || {}
      const circuit = { ...current.circuit, ...pcircuit }
      const L2_formula = { ...current.L2_formula, ...pL2 }
      merged = { ...current, circuit, L2_formula }
      updatedFields = [
        ...Object.keys(pcircuit).map((key) => `circuit.${key}`),
        ...Object.keys(pL2).map((key) => `L2_formula.${key}`),
      ]
      break
    }
    default:
      return c.json({
        error: `Unknown source: ${source}`,
        allowed: ['barrier', 'signal', 'sltp', 'screener', 'conformal', 'risk_params', 'rrg', 'alpha_framework', 'feature_window', 'ga_optimizer', 'regime', 'l2_sensitivity'],
      }, 400)
  }

  const errors = validateTradingConfig(merged)
  if (errors.length > 0) {
    return c.json({ error: 'Schema validation failed', errors, source, updatedFields }, 400)
  }

  const wantsProd = c.req.query('prod') === '1'
  const confirmProd = c.req.header('X-Confirm-Prod') === 'true'
  const promotionPacketId = typeof body.promotion_packet_id === 'string'
    ? body.promotion_packet_id
    : typeof meta?.promotion_packet_id === 'string'
      ? meta.promotion_packet_id
      : undefined
  const candidateId = typeof body.candidate_id === 'string'
    ? body.candidate_id
    : typeof meta?.candidate_id === 'string'
      ? meta.candidate_id
      : undefined
  const overrideReason = String(body.override_reason ?? meta?.override_reason ?? body.reason ?? '').trim()

  if (wantsProd && !confirmProd) {
    return c.json({
      error: 'prod=1 requires header X-Confirm-Prod: true (double-gate)',
      hint: 'Drop ?prod=1 to write to sandbox (safe), or add the header to force prod.',
    }, 400)
  }

  if (wantsProd && confirmProd) {
    const {
      PRODUCTION_OVERRIDE_HEADER,
      isExplicitProductionOverride,
      recordProductionOverride,
      validatePromotionPacketForProd,
    } = await import('../lib/parameterCandidateRegistry')
    const promotionGate = await validatePromotionPacketForProd(c.env.DB, {
      candidateId,
      promotionPacketId,
    })
    const override = isExplicitProductionOverride(c.req.header(PRODUCTION_OVERRIDE_HEADER), overrideReason)
    if (!promotionGate.ok && !override) {
      return c.json({
        error: 'prod_optuna_push_requires_promotion_packet_or_override',
        reason: promotionGate.error,
        hint: `Attach promotion_packet_id + candidate_id, or use ${PRODUCTION_OVERRIDE_HEADER}: true with override_reason.`,
      }, 400)
    }
    const overrideAudit = !promotionGate.ok
      ? await recordProductionOverride(c.env.DB, {
        route: '/api/admin/optuna-push?prod=1',
        reason: overrideReason,
        candidateId,
        promotionPacketId,
        detail: { source, updatedFields, meta: meta ?? null },
      })
      : null
    const snapshotResult = await setTradingConfig(c.env.KV, merged, {
      source,
      push_id: meta?.run_id ?? meta?.push_id,
    })

    const auditKey = `audit:optuna-push:${source}:${twToday()}`
    await c.env.KV.put(auditKey, JSON.stringify({
      target: 'prod',
      source,
      params,
      meta: meta ?? null,
      updatedFields,
      pushed_at: new Date().toISOString(),
      snapshot_id: snapshotResult.snapshotId,
      snapshot_skipped: snapshotResult.skipped,
      promotion_packet_id: promotionPacketId ?? null,
      override_audit_id: overrideAudit?.audit_id ?? null,
    }), { expirationTtl: 30 * 86400 })

    return c.json({
      success: true,
      target: 'prod',
      source,
      updatedFields,
      audit_key: auditKey,
      snapshot_id: snapshotResult.snapshotId,
      snapshot_skipped: snapshotResult.skipped,
      promotion_packet_id: promotionPacketId ?? null,
      override_audit_id: overrideAudit?.audit_id ?? null,
      message: `Optuna ${source} pushed to PROD trading:config (${updatedFields.length} fields updated)`,
    })
  }

  const sandboxId = await writeSandbox(c.env.KV, source, merged, {
    push_id: meta?.run_id ?? meta?.push_id,
    note: meta?.note,
    metadata: meta ?? undefined,
  })
  const { recordParameterCandidateFromSandbox } = await import('../lib/parameterCandidateRegistry')
  const candidate = await recordParameterCandidateFromSandbox(c.env.DB, {
    source,
    sandboxId,
    configHash: sandboxId.split(':').pop(),
    cadence: meta?.cadence,
    runId: meta?.run_id ?? meta?.push_id,
    metadata: {
      meta: meta ?? null,
      updatedFields,
      audit_source: 'optuna_push',
    },
  })

  const auditKey = `audit:optuna-push:${source}:${twToday()}`
  await c.env.KV.put(auditKey, JSON.stringify({
    target: 'sandbox',
    source,
    params,
    meta: meta ?? null,
    updatedFields,
    pushed_at: new Date().toISOString(),
    sandbox_id: sandboxId,
    candidate_id: candidate.candidate_id,
  }), { expirationTtl: 30 * 86400 })

  return c.json({
    success: true,
    target: 'sandbox',
    source,
    updatedFields,
    audit_key: auditKey,
    sandbox_id: sandboxId,
    candidate_id: candidate.candidate_id,
    candidate_status: candidate.status,
    message: `Optuna ${source} written to SANDBOX (prod unchanged). Run candidate validation, then promote with promotion_packet_id or explicit production override.`,
  })
})
