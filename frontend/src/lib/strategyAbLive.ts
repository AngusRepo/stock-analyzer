import type { NavComparisonDetail } from './navTradingRoom'

/** Never compare different starts/capital or silently drop missing sessions. */
export function alignStrategyAb(a: NavComparisonDetail, b: NavComparisonDetail) {
  const fail = (reason: string) => ({ aligned: false as const, reason, history: [], start: '', end: '' })
  if (a.status !== 'available' || b.status !== 'available' || a.blockers.length || b.blockers.length)
    return fail('兩邊尚未都有通過驗證的帳本')
  if (a.strategy_ab?.role !== 'A' || b.strategy_ab?.role !== 'B'
    || a.strategy_ab.experiment_id !== b.strategy_ab.experiment_id
    || !a.baseline_checksum || a.baseline_checksum !== b.baseline_checksum)
    return fail('A/B 實驗或共同基準身份不同')
  if (!a.initial_nav || !b.initial_nav || !Number.isFinite(a.initial_nav) || !Number.isFinite(b.initial_nav)
    || Math.abs(a.initial_nav - b.initial_nav) > 1e-6 || a.initial_nav <= 0
    || !a.initial_session_date || a.initial_session_date !== b.initial_session_date)
    return fail('A/B 起始日期或起始資金未對齊')
  if (!a.latest || !b.latest || a.latest.date !== b.latest.date || !a.history.length
    || a.history.length !== b.history.length || a.history.some((row, i) => row.date !== b.history[i].date))
    return fail('A/B 帳務日期缺漏或尚未同步')
  if ([a, b].some(detail => detail.latest!.receipt_status !== 'verified'
    || detail.latest!.candidate.nav == null || !Number.isFinite(detail.latest!.candidate.nav)
    || detail.latest!.candidate.estimated_nav_including_rebate == null
    || !Number.isFinite(detail.latest!.candidate.estimated_nav_including_rebate))) return fail('最新帳務數值或成交收據尚未完整')
  if ([a, b].some(detail => detail.history.some(row => row.candidate_estimated_nav_including_rebate == null
    || !Number.isFinite(row.candidate_estimated_nav_including_rebate)))) return fail('應收退費明細尚未完整')
  return { aligned: true as const, reason: '', start: a.initial_session_date, end: a.latest.date,
    history: a.history.map((row, i) => ({ date: row.date,
      A: row.candidate_estimated_nav_including_rebate! / a.initial_nav! - 1,
      B: b.history[i].candidate_estimated_nav_including_rebate! / b.initial_nav! - 1 })) }
}
