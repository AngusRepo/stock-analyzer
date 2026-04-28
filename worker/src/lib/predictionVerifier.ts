type TradeOutcome = {
  outcome: string
  tradePnlPct: number
  tradePnlR: number
  maxFavorable: number
  maxAdverse: number
}

export function simulateTrade(
  direction: 'up' | 'down',
  entry: number,
  stop: number,
  target1: number,
  target2: number,
  bars: any[],
): TradeOutcome {
  const isLong = direction === 'up'
  const riskPerShare = Math.abs(entry - stop)

  let maxFavorable = 0
  let maxAdverse = 0
  let outcome = 'expired'
  let exitPrice = bars[bars.length - 1]?.close ?? entry
  let hitTarget1 = false

  for (const bar of bars) {
    const high = bar.high ?? bar.close
    const low = bar.low ?? bar.close

    if (isLong) {
      maxFavorable = Math.max(maxFavorable, (high - entry) / entry)
      maxAdverse = Math.max(maxAdverse, (entry - low) / entry)

      if (high >= target2) {
        outcome = 'hit_target2'
        exitPrice = target2
        break
      }
      if (high >= target1) {
        outcome = 'hit_target1'
        exitPrice = target1
        hitTarget1 = true
      }
      if (!hitTarget1 && low <= stop) {
        outcome = 'hit_stop'
        exitPrice = stop
        break
      }
      continue
    }

    maxFavorable = Math.max(maxFavorable, (entry - low) / entry)
    maxAdverse = Math.max(maxAdverse, (high - entry) / entry)

    if (low <= target2) {
      outcome = 'hit_target2'
      exitPrice = target2
      break
    }
    if (low <= target1) {
      outcome = 'hit_target1'
      exitPrice = target1
      hitTarget1 = true
    }
    if (!hitTarget1 && high >= stop) {
      outcome = 'hit_stop'
      exitPrice = stop
      break
    }
  }

  const rawPnl = isLong
    ? (exitPrice - entry) / entry
    : (entry - exitPrice) / entry
  const tradePnlR = riskPerShare > 0 ? rawPnl * entry / riskPerShare : 0

  return {
    outcome,
    tradePnlPct: Math.round(rawPnl * 10000) / 10000,
    tradePnlR: Math.round(tradePnlR * 100) / 100,
    maxFavorable: Math.round(maxFavorable * 10000) / 10000,
    maxAdverse: Math.round(maxAdverse * 10000) / 10000,
  }
}
