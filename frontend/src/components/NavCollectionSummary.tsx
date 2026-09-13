import type { PairedNavShadowReadModel } from '@/lib/pipelineMaturityContract'
import { comparisonTitle } from '@/lib/navTradingRoom'

export default function NavCollectionSummary({ data }: { data?: PairedNavShadowReadModel }) {
  return <section aria-label="NAV 收集狀態" className="min-w-0 rounded-xl border border-slate-700/70 bg-slate-950/30 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="text-sm font-semibold">NAV 證據收集</h3>
      <a href="/bot?tab=nav" className="rounded border border-sky-400/50 px-3 py-2 text-sm text-sky-200 hover:bg-sky-400/10">到交易室看候選帳戶 →</a>
    </div>
    <p className="mt-2 text-sm text-slate-400">本區保留進度；晉級判定與阻擋原因依各階段 NAV gate。資產、持倉與成交統一在交易室查看。</p>
    {data?.pairs.length ? <ul className="mt-3 space-y-2 text-sm">{data.pairs.map(pair => <li key={pair.pair_id} className="break-words">
      {comparisonTitle(pair)}：有效報酬 {pair.sessions} 日／帳務 {pair.accounted_sessions} 日 · 最新 {pair.latest_accounting_session}
      {pair.unverified_sessions > 0 ? <span className="text-amber-200"> · {pair.unverified_sessions} 日報酬不可評估</span> : null}
    </li>)}</ul> : <p className="mt-3 text-sm text-amber-200">{!data || data.status === 'unavailable' ? 'NAV 資料無法確認；不是 0 日。' : '尚無完整配對 NAV 帳本；配置封存不等於 NAV 成熟。'}</p>}
    {data?.blockers.map(reason => <p key={reason} className="mt-2 break-words text-xs text-amber-200">{reason}</p>)}
  </section>
}
