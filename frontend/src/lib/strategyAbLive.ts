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


/** One native paired account: A is the verified baseline, B the challenger. */
export function alignPaperPrimary(detail: NavComparisonDetail) {
  const fail = (reason: string) => ({ aligned: false as const, reason, history: [], start: '', end: '' })
  const primary = detail.strategy_ab?.baseline_primary
  if (detail.status !== 'available' || detail.blockers.length || detail.latest?.receipt_status !== 'verified')
    return fail('配對帳本與成交收據尚未通過驗證')
  if (detail.strategy_ab?.role !== 'B' || primary?.role !== 'A'
    || primary.recipe !== 'price_timexer_three_head' || primary.l3_checksum !== detail.baseline_checksum)
    return fail('A 主策略基準身份未對齊')
  if (!detail.initial_nav || !Number.isFinite(detail.initial_nav) || detail.initial_nav <= 0
    || !detail.initial_session_date || !detail.history.length
    || detail.history[detail.history.length - 1]?.date !== detail.latest.date)
    return fail('起始資金或帳務日期尚未完整')
  if (['baseline', 'candidate'].some(arm => {
    const account = detail.latest![arm as 'baseline' | 'candidate']
    return account.nav == null || !Number.isFinite(account.nav)
      || account.estimated_nav_including_rebate == null || !Number.isFinite(account.estimated_nav_including_rebate)
  }) || detail.history.some(row => row.baseline_estimated_nav_including_rebate == null
    || !Number.isFinite(row.baseline_estimated_nav_including_rebate)
    || row.candidate_estimated_nav_including_rebate == null || !Number.isFinite(row.candidate_estimated_nav_including_rebate)))
    return fail('A/B 淨值或應收退費資料未完整')
  return { aligned: true as const, reason: '', start: detail.initial_session_date, end: detail.latest.date,
    history: detail.history.map(row => ({ date: row.date,
      A: row.baseline_estimated_nav_including_rebate! / detail.initial_nav! - 1,
      B: row.candidate_estimated_nav_including_rebate! / detail.initial_nav! - 1 })) }
}
