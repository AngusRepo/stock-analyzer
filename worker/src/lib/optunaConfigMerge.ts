import type { TradingConfig } from './tradingConfig'

export const COMPOSITE_OPTUNA_CONFIG_SOURCES = [
  'barrier',
  'signal',
  'sltp',
  'screener',
  'conformal',
  'risk_params',
  'rrg',
  'alpha_framework',
] as const

type AlphaFrameworkMerger = (config: any) => any

export function mergeOptunaConfigSource(
  current: TradingConfig,
  source: string,
  params: any,
  mergeAlphaFrameworkConfig: AlphaFrameworkMerger,
): { config: TradingConfig; updatedFields: string[] } {
  let config: any = current
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
      config = { ...current, barrier }
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
      config = { ...current, signal }
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
      config = { ...current, sltp, exit }
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
      config = { ...current, L2_formula }
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
      config = { ...current, circuit, exit, sltp, position }
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
      config = { ...current, rrg }
      updatedFields = Object.keys(rrg).map((key) => `rrg.${key}`)
      break
    }
    case 'screener': {
      const screener = {
        ...current.screener,
        ...(params.minPrice != null && { minPrice: Number(params.minPrice) }),
        ...(params.maxPrice != null && { maxPrice: Number(params.maxPrice) }),
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
      config = { ...current, screener, ranking }
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
      config = { ...current, alphaFramework }
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
    default:
      throw new Error(`unsupported composite Optuna source: ${source}`)
  }

  return { config, updatedFields }
}

export function mergeCompositeOptunaCandidate(
  current: TradingConfig,
  sources: Record<string, any>,
  mergeAlphaFrameworkConfig: AlphaFrameworkMerger,
): { config: TradingConfig; updatedFields: string[] } {
  const missing = COMPOSITE_OPTUNA_CONFIG_SOURCES.filter((source) => !sources[source])
  if (missing.length > 0) throw new Error(`composite Optuna candidate missing sources: ${missing.join(',')}`)

  let config = current
  const updatedFields: string[] = []
  for (const source of COMPOSITE_OPTUNA_CONFIG_SOURCES) {
    const merged = mergeOptunaConfigSource(config, source, sources[source], mergeAlphaFrameworkConfig)
    config = merged.config
    updatedFields.push(...merged.updatedFields)
  }
  return { config, updatedFields: [...new Set(updatedFields)] }
}
