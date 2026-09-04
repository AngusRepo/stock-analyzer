import type { RiskConfig } from './riskConfig'
import type { CircuitBreakerState, LegacyLayerDeps } from './riskTypes'

export interface IntradayNavState {
  tradeDate: string
  peakNav: number
  lastNav: number
  halted: boolean
  updatedAt: string
}

export interface IntradayDrawdownEvaluation {
  state: IntradayNavState
  drawdown: number
  triggered: boolean
}

function finitePositive(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function evaluateIntradayDrawdown(params: {
  tradeDate: string
  currentNav: number
  previous: IntradayNavState | null
  haltThreshold: number
  nowIso?: string
}): IntradayDrawdownEvaluation {
  const currentNav = finitePositive(params.currentNav)
  if (currentNav == null) throw new Error('intraday_nav_invalid')
  const previousPeak = params.previous?.tradeDate === params.tradeDate
    ? finitePositive(params.previous.peakNav)
    : null
  const peakNav = Math.max(previousPeak ?? currentNav, currentNav)
  const drawdown = peakNav > 0 ? (peakNav - currentNav) / peakNav : 0
  const drawdownTriggered = drawdown >= Math.max(0, params.haltThreshold)
  const halted = params.previous?.tradeDate === params.tradeDate && params.previous.halted === true
    ? true
    : drawdownTriggered
  return {
    state: {
      tradeDate: params.tradeDate,
      peakNav,
      lastNav: currentNav,
      halted,
      updatedAt: params.nowIso ?? new Date().toISOString(),
    },
    drawdown,
    triggered: halted,
  }
}

function p9HaltState(state: IntradayNavState, deps: LegacyLayerDeps): CircuitBreakerState {
  const drawdown = state.peakNav > 0 ? (state.peakNav - state.lastNav) / state.peakNav : 0
  const reason = `P9 intraday drawdown halt latched for ${state.tradeDate}: ${(drawdown * 100).toFixed(2)}%`
  return {
    ...deps.defaults,
    halt: true,
    maxPositionPct: 0,
    buyConfThreshold: 1,
    sellConfThreshold: 1,
    targetExposurePct: 0,
    deRiskExistingPositions: true,
    triggeredLayers: ['P9'],
    haltReasons: [`[P9] ${reason}`],
    reason,
  }
}

export async function readP9IntradayHalt(
  kv: KVNamespace,
  tradeDate: string,
  deps: LegacyLayerDeps,
): Promise<CircuitBreakerState | null> {
  const state = await kv.get(`risk:intraday_nav_peak:${tradeDate}`, 'json').catch(() => null) as IntradayNavState | null
  if (!state || state.tradeDate !== tradeDate || state.halted !== true) return null
  return p9HaltState(state, deps)
}

export async function checkP9IntradayDrawdown(
  kv: KVNamespace,
  tradeDate: string,
  currentNav: number,
  riskConfig: RiskConfig,
  deps: LegacyLayerDeps,
): Promise<{ state: CircuitBreakerState | null; evaluation: IntradayDrawdownEvaluation }> {
  const key = `risk:intraday_nav_peak:${tradeDate}`
  const previous = await kv.get(key, 'json').catch(() => null) as IntradayNavState | null
  const evaluation = evaluateIntradayDrawdown({
    tradeDate,
    currentNav,
    previous,
    haltThreshold: riskConfig.portfolio.intradayDrawdownHalt,
  })
  await kv.put(key, JSON.stringify(evaluation.state), { expirationTtl: 3 * 86400 })
  if (!evaluation.triggered) return { state: null, evaluation }

  return {
    evaluation,
    state: {
      ...deps.defaults,
      halt: true,
      maxPositionPct: 0,
      buyConfThreshold: 1,
      sellConfThreshold: 1,
      targetExposurePct: 0,
      deRiskExistingPositions: true,
      triggeredLayers: ['P9'],
      haltReasons: [`[P9] 盤中組合回撤 ${(evaluation.drawdown * 100).toFixed(2)}%`],
      reason: `盤中組合回撤 ${(evaluation.drawdown * 100).toFixed(2)}% 達 P9 上限 ${(riskConfig.portfolio.intradayDrawdownHalt * 100).toFixed(2)}%`,
    },
  }
}

export function mergeIntradayPortfolioRisk(
  base: CircuitBreakerState,
  overlay: CircuitBreakerState | null,
): CircuitBreakerState {
  if (!overlay) return base
  const baseTarget = base.targetExposurePct == null ? 1 : base.targetExposurePct
  const overlayTarget = overlay.targetExposurePct == null ? 1 : overlay.targetExposurePct
  return {
    ...base,
    halt: base.halt || overlay.halt,
    maxPositionPct: Math.min(base.maxPositionPct, overlay.maxPositionPct),
    buyConfThreshold: Math.max(base.buyConfThreshold, overlay.buyConfThreshold),
    sellConfThreshold: Math.max(base.sellConfThreshold, overlay.sellConfThreshold),
    targetExposurePct: Math.min(baseTarget, overlayTarget),
    deRiskExistingPositions: Boolean(base.deRiskExistingPositions || overlay.deRiskExistingPositions),
    triggeredLayers: [...new Set([...(base.triggeredLayers ?? []), ...(overlay.triggeredLayers ?? [])])],
    haltReasons: [...new Set([...(base.haltReasons ?? []), ...(overlay.haltReasons ?? [])])],
    reason: [base.reason, overlay.reason].filter(Boolean).join(' | '),
  }
}
