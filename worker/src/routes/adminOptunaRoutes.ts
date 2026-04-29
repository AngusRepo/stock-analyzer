import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireServiceToken } from '../lib/auth'
import type { Bindings, Variables } from '../types'

export const adminOptunaRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminOptunaRoutes.post('/api/admin/optuna-push', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => null)
  if (!body || !body.source || !body.params) {
    return c.json({ error: 'Body must be { source, params, meta? }' }, 400)
  }

  const { source, params, meta } = body
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
    case 'regime': {
      const label = String(params.label ?? 'sideways')
      const validLabels = new Set(['bull_market', 'volatile', 'sideways', 'bear_market'])
      if (!validLabels.has(label)) {
        return c.json({
          error: `Invalid regime label: ${label}`,
          allowed: Array.from(validLabels),
        }, 400)
      }

      await c.env.KV.put('ml:regime', label, { expirationTtl: 2 * 86400 })
      await c.env.KV.put('ml:regime:meta', JSON.stringify({
        label,
        regime_index: Number(params.regime_index ?? 2),
        hmm_state: Number(params.hmm_state ?? -1),
        label_zh: String(params.label_zh ?? ''),
        regime_surface: params.regime_surface ?? params.regime_probabilities ?? params.probabilities ?? {},
        consensus_threshold: Number(params.consensus_threshold ?? 0.60),
        weight_multipliers: params.weight_multipliers ?? {},
        pushed_at: new Date().toISOString(),
      }), { expirationTtl: 2 * 86400 })

      const auditKey = `audit:optuna-push:regime:${twToday()}`
      await c.env.KV.put(auditKey, JSON.stringify({
        source: 'regime',
        params,
        meta: meta ?? null,
        pushed_at: new Date().toISOString(),
      }), { expirationTtl: 30 * 86400 })

      return c.json({
        success: true,
        source: 'regime',
        regime: label,
        updatedKeys: ['ml:regime', 'ml:regime:meta'],
      })
    }
    default:
      return c.json({
        error: `Unknown source: ${source}`,
        allowed: ['barrier', 'signal', 'sltp', 'screener', 'conformal', 'risk_params', 'rrg', 'alpha_framework', 'feature_window', 'regime', 'l2_sensitivity'],
      }, 400)
  }

  const errors = validateTradingConfig(merged)
  if (errors.length > 0) {
    return c.json({ error: 'Schema validation failed', errors, source, updatedFields }, 400)
  }

  const wantsProd = c.req.query('prod') === '1'
  const confirmProd = c.req.header('X-Confirm-Prod') === 'true'

  if (wantsProd && !confirmProd) {
    return c.json({
      error: 'prod=1 requires header X-Confirm-Prod: true (double-gate)',
      hint: 'Drop ?prod=1 to write to sandbox (safe), or add the header to force prod.',
    }, 400)
  }

  if (wantsProd && confirmProd) {
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
    }), { expirationTtl: 30 * 86400 })

    return c.json({
      success: true,
      target: 'prod',
      source,
      updatedFields,
      audit_key: auditKey,
      snapshot_id: snapshotResult.snapshotId,
      snapshot_skipped: snapshotResult.skipped,
      message: `Optuna ${source} pushed to PROD trading:config (${updatedFields.length} fields updated)`,
    })
  }

  const sandboxId = await writeSandbox(c.env.KV, source, merged, {
    push_id: meta?.run_id ?? meta?.push_id,
    note: meta?.note,
    metadata: meta ?? undefined,
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
  }), { expirationTtl: 30 * 86400 })

  return c.json({
    success: true,
    target: 'sandbox',
    source,
    updatedFields,
    audit_key: auditKey,
    sandbox_id: sandboxId,
    message: `Optuna ${source} written to SANDBOX (prod unchanged). Promote via POST /api/admin/config/promote {sandbox_id} + X-Confirm-Prod: true`,
  })
})
