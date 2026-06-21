export type MarketOutlookConfidence = 'low' | 'medium' | 'high'

export interface MarketOptimisticOutlook {
  schema_version: 'market-outlook-v1'
  date: string
  index: 'TWII'
  horizon_trading_days: number
  base_price: number | null
  ma20: number | null
  optimistic_target: number | null
  upside_pct: number | null
  confidence: MarketOutlookConfidence
  target_basis: 'twii_20d_vol_regime_risk_chip_breadth_v1'
  source_factors: {
    twii_bias_pct: number | null
    twii_vol20_pct: number | null
    regime_family: string | null
    risk_level: string | null
    foreign_net_5d_billion: number | null
    bull_alignment_pct: number | null
  }
  components: {
    horizon_vol_pct: number | null
    volatility_component_pct: number | null
    regime_component_pct: number
    trend_component_pct: number
    chip_component_pct: number
    breadth_component_pct: number
    risk_scale: number
  }
  missing_reasons: string[]
  summary: string
}

function finiteNumber(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function cleanText(value: unknown): string | null {
  const text = String(value ?? '').trim().toLowerCase()
  return text ? text : null
}

function regimeComponentPct(family: string | null): number {
  if (family === 'bull') return 2.5
  if (family === 'sideways') return 1.2
  if (family === 'volatile') return 0.8
  if (family === 'bear') return 0.4
  return 1.0
}

function riskScale(level: string | null): number {
  if (level === 'green' || level === 'low') return 1.15
  if (level === 'yellow' || level === 'medium') return 0.95
  if (level === 'orange') return 0.75
  if (level === 'red' || level === 'high') return 0.50
  if (level === 'black' || level === 'very_high') return 0.25
  return 0.85
}

function chipComponentPct(foreignNet5d: number | null): number {
  if (foreignNet5d == null) return 0
  if (foreignNet5d >= 120) return 0.8
  if (foreignNet5d >= 40) return 0.4
  if (foreignNet5d <= -160) return -1.0
  if (foreignNet5d <= -60) return -0.5
  return 0
}

function breadthComponentPct(bullAlignmentPct: number | null): number {
  if (bullAlignmentPct == null) return 0
  if (bullAlignmentPct >= 55) return 0.8
  if (bullAlignmentPct >= 42) return 0.3
  if (bullAlignmentPct <= 22) return -0.9
  if (bullAlignmentPct <= 32) return -0.4
  return 0
}

function trendComponentPct(basePrice: number | null, ma20: number | null, twiiBiasPct: number | null): number {
  if (twiiBiasPct != null) {
    if (twiiBiasPct >= 0) return clamp(twiiBiasPct * 0.32, 0, 2.5)
    if (basePrice != null && ma20 != null && ma20 > basePrice) {
      const recoveryToMa20Pct = ((ma20 / basePrice) - 1) * 100
      return clamp(recoveryToMa20Pct * 0.35, 0, 1.8)
    }
    return clamp(twiiBiasPct * 0.18, -1.5, 0)
  }
  if (basePrice != null && ma20 != null && ma20 > 0) {
    return clamp(((basePrice / ma20) - 1) * 100 * 0.25, -1.2, 1.8)
  }
  return 0
}

function confidence(missingReasons: string[], presentCount: number): MarketOutlookConfidence {
  if (missingReasons.includes('twii_close_missing')) return 'low'
  if (presentCount >= 5 && missingReasons.length <= 1) return 'high'
  if (presentCount >= 3) return 'medium'
  return 'low'
}

export function buildMarketOptimisticOutlook(input: {
  marketRiskRow: Record<string, unknown>
  regimeState?: { family?: unknown } | null
  factorPacket?: { level?: unknown; missing_reasons?: Record<string, string> } | null
}): MarketOptimisticOutlook {
  const row = input.marketRiskRow
  const date = String(row.date ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10))
  const basePrice = finiteNumber(row.twii_close ?? row.twiiClose)
  const ma20 = finiteNumber(row.twii_ma20 ?? row.twiiMa20)
  const twiiBiasPct = finiteNumber(row.twii_bias ?? row.twiiBias)
  const twiiVol20Pct = finiteNumber(row.twii_vol20 ?? row.twiiVol20)
  const foreignNet5d = finiteNumber(row.foreign_net_5d ?? row.foreignNet5d)
  const bullAlignmentPct = finiteNumber(row.bull_alignment_pct ?? row.bullAlignmentPct)
  const family = cleanText(input.regimeState?.family ?? row.regime_family)
  const level = cleanText(input.factorPacket?.level ?? row.risk_level ?? row.riskLevel)
  const missingReasons: string[] = []

  if (basePrice == null || basePrice <= 0) missingReasons.push('twii_close_missing')
  if (ma20 == null || ma20 <= 0) missingReasons.push('twii_ma20_missing')
  if (twiiVol20Pct == null || twiiVol20Pct <= 0) missingReasons.push('twii_vol20_missing')
  if (!family) missingReasons.push('regime_family_missing')
  if (!level) missingReasons.push('risk_level_missing')
  if (foreignNet5d == null) missingReasons.push('foreign_net_5d_missing')
  if (bullAlignmentPct == null) missingReasons.push('bull_alignment_pct_missing')

  const horizonTradingDays = 20
  const annualVolPct = twiiVol20Pct ?? 22
  const horizonVolPct = clamp(annualVolPct * Math.sqrt(horizonTradingDays / 252), 2, 14)
  const volatilityComponentPct = horizonVolPct * 0.35
  const components = {
    horizon_vol_pct: round2(horizonVolPct),
    volatility_component_pct: round2(volatilityComponentPct),
    regime_component_pct: regimeComponentPct(family),
    trend_component_pct: round2(trendComponentPct(basePrice, ma20, twiiBiasPct)),
    chip_component_pct: chipComponentPct(foreignNet5d),
    breadth_component_pct: breadthComponentPct(bullAlignmentPct),
    risk_scale: riskScale(level),
  }
  const rawUpsidePct = (
    volatilityComponentPct +
    components.regime_component_pct +
    components.trend_component_pct +
    components.chip_component_pct +
    components.breadth_component_pct
  ) * components.risk_scale
  const maxUpsidePct = level === 'green' ? 12 : level === 'yellow' ? 9 : level === 'orange' ? 7 : level === 'red' ? 5 : 3
  const upsidePct = basePrice == null || basePrice <= 0
    ? null
    : round2(clamp(rawUpsidePct, 0.3, maxUpsidePct))
  const target = basePrice != null && upsidePct != null
    ? round2(basePrice * (1 + upsidePct / 100))
    : null
  const presentCount = [
    basePrice,
    ma20,
    twiiBiasPct,
    twiiVol20Pct,
    family,
    level,
    foreignNet5d,
    bullAlignmentPct,
  ].filter((value) => value != null && value !== '').length
  const conf = confidence(missingReasons, presentCount)
  const summary = target == null || upsidePct == null
    ? 'TWII optimistic target unavailable'
    : `TWII optimistic target ${target.toFixed(2)} (+${upsidePct.toFixed(2)}%) over ${horizonTradingDays} trading days`

  return {
    schema_version: 'market-outlook-v1',
    date,
    index: 'TWII',
    horizon_trading_days: horizonTradingDays,
    base_price: basePrice == null ? null : round2(basePrice),
    ma20: ma20 == null ? null : round2(ma20),
    optimistic_target: target,
    upside_pct: upsidePct,
    confidence: conf,
    target_basis: 'twii_20d_vol_regime_risk_chip_breadth_v1',
    source_factors: {
      twii_bias_pct: twiiBiasPct == null ? null : round2(twiiBiasPct),
      twii_vol20_pct: twiiVol20Pct == null ? null : round2(twiiVol20Pct),
      regime_family: family,
      risk_level: level,
      foreign_net_5d_billion: foreignNet5d == null ? null : round2(foreignNet5d),
      bull_alignment_pct: bullAlignmentPct == null ? null : round2(bullAlignmentPct),
    },
    components,
    missing_reasons: missingReasons,
    summary,
  }
}
