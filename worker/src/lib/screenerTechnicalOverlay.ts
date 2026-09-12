/** The original per-slate technical overlay. No I/O or model/strategy authority.
 * Share frozen bars, never the percentile calculation across different slates.
 */
import { computeTechnicalIndicators } from './technicalIndicators'

export interface ScreenerOverlayBar {
  symbol: string
  date: string
  close: number
  high: number
  low: number
  volume: number
}

export function applyScreenerTechnicalOverlay<T extends { symbol: string; score: number; reason: string; chip_score?: number | null }>(
  scored: T[], rawHistory: readonly ScreenerOverlayBar[], policySymbols: Iterable<string>,
) {
  const scope = new Set(policySymbols)
  // Filtering precedes percentiles; a union fetch must not alter either arm.
  const histRows = rawHistory.filter(row => scope.has(row.symbol))
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.date.localeCompare(b.date))
  const histBySymbol = new Map<string, { close: number; high: number; low: number; volume: number }[]>()
  for (const r of histRows) {
    if (!histBySymbol.has(r.symbol)) histBySymbol.set(r.symbol, [])
    histBySymbol.get(r.symbol)!.push({ close: r.close, high: r.high ?? r.close, low: r.low ?? r.close, volume: r.volume ?? 0 })
  }

  // ?? G1: ??universe ??intent ?曉?雿???adaptive ?瑼鳴???
  const intentMap = new Map<string, number>()
  for (const [sym, bars] of histBySymbol) {
    if (bars.length < 20) continue
    const latest = bars[bars.length - 1].close
    const first = bars[0].close
    let sumAbsRet = 0
    for (let i = 1; i < bars.length; i++) {
      if (bars[i - 1].close > 0) sumAbsRet += Math.abs((bars[i].close - bars[i - 1].close) / bars[i - 1].close)
    }
    const netReturn = first > 0 ? (latest - first) / first : 0
    intentMap.set(sym, sumAbsRet > 0 ? netReturn / sumAbsRet : 0)
  }
  // 閮??曉?雿?瑼?
  const intentValues = [...intentMap.values()].sort((a, b) => a - b)
  const p10 = intentValues[Math.floor(intentValues.length * 0.10)] ?? -0.3
  const p20 = intentValues[Math.floor(intentValues.length * 0.20)] ?? -0.1

  let trendPenalty = 0, intentPenalty = 0, adxPenalty = 0, liqPenalty = 0

  for (const c of scored) {
    const bars = histBySymbol.get(c.symbol)
    if (!bars || bars.length < 20) continue

    const latest = bars[bars.length - 1].close
    const first = bars[0].close
    const high60 = Math.max(...bars.map(b => b.close))

    // ??頝 60 ?仿?暺???
    const fromHigh = (latest - high60) / high60
    if (fromHigh < -0.15) {
      c.score -= 8
      c.reason += `嚗?擃?${(fromHigh * 100).toFixed(0)}%`
      trendPenalty++
    } else if (fromHigh < -0.10) {
      c.score -= 5
      trendPenalty++
    }

    // ??G1: Intent adaptive ?曉?雿??
    const intent = intentMap.get(c.symbol) ?? 0
    if (intent < p10 && intent < 0) {
      c.score -= 8  // ?撌?10%嚗楊頝?擃??迎?
      intentPenalty++
    } else if (intent < p20 && intent < 0) {
      c.score -= 5  // ?撌?20%
      intentPenalty++
    } else if (intent > 0.4) {
      c.score += 3  // ?芾釭?渡?銝撞
    }

    // ??G2+ADX: ?梁摰 ADX 14 閮?嚗????DX 餈撮 ADX??
    if (bars.length >= 28) {
      const technicals = computeTechnicalIndicators(
        bars.map(b => b.close),
        bars.map(b => b.high),
        bars.map(b => b.low),
        bars.map(b => b.volume),
      )
      const adx = technicals.adx14

      if (adx != null && adx < 15 && (c as any).chip_score >= 20) {
        c.score -= 5
        c.reason += ` | weak_adx_${adx.toFixed(0)}`
        adxPenalty++
      } else if (adx != null && adx > 30) {
        if (intent > 0.1) c.score += 2
      }
    }

    // ??G4: 瘚??批?蝝?銝?擃′?瑼鳴??典??豢??塚?
    const avgTurnover = bars.reduce((s, b) => s + b.close * b.volume, 0) / bars.length
    if (avgTurnover < 10_000_000) {        // < 1000 ??
      c.score -= 5
      liqPenalty++
    } else if (avgTurnover < 30_000_000) { // 1000~3000 ??
      c.score -= 2
      liqPenalty++
    } else if (avgTurnover > 100_000_000) { // > 1 ??
      c.score += 2  // 擃??批??
    }
  }
  return { trendPenalty, intentPenalty, adxPenalty, liqPenalty, p10, p20 }
}
