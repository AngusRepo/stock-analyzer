/** Frozen replay accounting; user confirmed a post-discount minimum of NT$20. */
export interface ResearchFill { commission: number; tax: number; slippage_cost: number }

export function commissionTotals(fills: ResearchFill[]) {
  return fills.reduce((total, fill) => {
    if (![fill.commission, fill.tax, fill.slippage_cost].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Invalid cost evidence')
    return { commission: total.commission + fill.commission, tax: total.tax + fill.tax, slippage: total.slippage + fill.slippage_cost }
  }, { commission: 0, tax: 0, slippage: 0 })
}

/** Nominal next-month day 10; holiday settlement must not be invented. */
export function scheduledRebateDate(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid fee month')
  const [year, monthNumber] = month.split('-').map(Number)
  return `${year + (monthNumber === 12 ? 1 : 0)}-${String(monthNumber === 12 ? 1 : monthNumber + 1).padStart(2, '0')}-10`
}

export function estimatedRebate(commission: number): number {
  if (!Number.isFinite(commission) || commission < 0) throw new Error('Invalid commission')
  return Math.max(0, commission - Math.max(20, commission * 0.25))
}

export interface ResearchAccount {
  ledger: Array<{ date: string; nav: number; cash: number; exposure: number; positions: number; symbols: string[] }>
  fills: Array<ResearchFill & { date: string }>
}

/** Same fills, accrued rebate only. No assumed cash receipt or reinvestment. */
export function rebateView(account: ResearchAccount, initialCash: number) {
  if (!Number.isFinite(initialCash) || initialCash <= 0 || !account.ledger.length) throw new Error('Missing account basis')
  const costs = commissionTotals(account.fills)
  const byDay = new Map<string, number>()
  const months = new Map<string, { month: string; scheduled_date: string; commission: number; estimated_rebate: number }>()
  const dates = new Set(account.ledger.map(day => day.date))
  for (const fill of account.fills) {
    if (!dates.has(fill.date)) throw new Error('Fill has no valuation date')
    const rebate = estimatedRebate(fill.commission)
    byDay.set(fill.date, (byDay.get(fill.date) ?? 0) + rebate)
    const monthKey = fill.date.slice(0, 7)
    const month = months.get(monthKey) ?? { month: monthKey, scheduled_date: scheduledRebateDate(monthKey), commission: 0, estimated_rebate: 0 }
    month.commission += fill.commission; month.estimated_rebate += rebate
    months.set(monthKey, month)
  }
  let accrued = 0, grossPeak = initialCash, adjustedPeak = initialCash, grossDrawdown = 0, adjustedDrawdown = 0, previousDate = ''
  const history = account.ledger.map(day => {
    if (day.date <= previousDate || !Number.isFinite(day.nav) || day.nav <= 0 || !Number.isFinite(day.cash)) throw new Error('Invalid ordered ledger')
    previousDate = day.date
    accrued += byDay.get(day.date) ?? 0
    const adjustedNav = day.nav + accrued
    grossPeak = Math.max(grossPeak, day.nav); adjustedPeak = Math.max(adjustedPeak, adjustedNav)
    grossDrawdown = Math.min(grossDrawdown, day.nav / grossPeak - 1)
    adjustedDrawdown = Math.min(adjustedDrawdown, adjustedNav / adjustedPeak - 1)
    return { ...day, estimated_rebate: accrued, adjusted_nav: adjustedNav, gross_return: day.nav / initialCash - 1, adjusted_return: adjustedNav / initialCash - 1 }
  })
  return { ...costs, history, latest: history[history.length - 1], months: [...months.values()],
    estimated_rebate: accrued, net_commission: costs.commission - accrued,
    gross_drawdown: grossDrawdown, adjusted_drawdown: adjustedDrawdown,
    confirmed_rebate_received: null,
  }
}
