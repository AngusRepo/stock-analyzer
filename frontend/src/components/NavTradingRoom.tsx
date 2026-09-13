import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, Legend } from 'recharts'
import PairedNavShadow from '@/components/PairedNavShadow'
import { comparisonTitle, navNumber, navPercent, navSign } from '@/lib/navTradingRoom'
import { navTradingRoomApi } from '@/lib/navTradingRoomApi'
import type { NavAccountView, NavComparisonDetail, NavFillView } from '@/lib/navTradingRoom'

const panel = 'min-w-0 rounded-xl border border-[#263247] bg-[#070a10] p-4'
const input = 'min-h-11 min-w-0 rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400'

function Account({ title, account, fills, receiptStatus }: { title: string; account: NavAccountView; fills: NavFillView[] | null;
  receiptStatus: NonNullable<NavComparisonDetail['latest']>['receipt_status'] }) {
  return <article className={panel} aria-label={title}>
    <h3 className="text-base font-semibold text-slate-100">{title}</h3>
    <p className="mt-3 text-xs text-slate-400">帳戶淨值 NAV · 新臺幣</p>
    <p className="mt-1 break-words text-2xl font-semibold tabular-nums text-slate-100">{navNumber(account.nav, 2)}</p>
    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
      <div><dt className="text-slate-400">可用現金</dt><dd className="mt-1 tabular-nums">{navNumber(account.cash, 2)}</dd></div>
      <div><dt className="text-slate-400">股票資金使用率</dt><dd className="mt-1 tabular-nums">{navPercent(account.stock_utilization)}</dd></div>
      <div><dt className="text-slate-400">當日淨報酬</dt><dd className={`mt-1 tabular-nums ${navSign(account.daily_return)}`}>{navPercent(account.daily_return)}</dd></div>
      <div><dt className="text-slate-400">距歷史高點回撤</dt><dd className={`mt-1 tabular-nums ${navSign(account.drawdown)}`}>{navPercent(account.drawdown)}</dd></div>
      <div><dt className="text-slate-400">當日交易成本</dt><dd className="mt-1 tabular-nums">{navNumber(account.costs, 2)}</dd></div>
      <div><dt className="text-slate-400">當日成交筆數</dt><dd className="mt-1 tabular-nums">{navNumber(account.fill_count)}</dd></div>
    </dl>
    {account.rights_count > 0 ? <p className="mt-3 text-sm text-amber-200">另有 {account.rights_count} 筆公司行動應收款／權利；不視為可用現金或股票部位。</p> : null}
    <h4 className="mt-5 text-sm font-medium text-slate-200">期末持倉 · 單位為股</h4>
    {account.positions.length ? <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[320px] text-left text-sm [&_th]:pr-4 [&_td]:pr-4 [&_td]:whitespace-nowrap"><thead className="text-xs text-slate-400"><tr><th className="py-2">股票</th><th>股數</th><th>估值價</th><th>市值</th></tr></thead><tbody>{account.positions.map(p => <tr key={p.symbol} className="border-t border-slate-800"><td className="py-2">{p.symbol}</td><td>{navNumber(p.shares)}</td><td>{navNumber(p.mark, 2)}</td><td>{navNumber(p.market_value, 2)}</td></tr>)}</tbody></table></div>
      : <p className="mt-2 text-sm text-slate-400">帳本確認無股票持倉。</p>}
    <h4 className="mt-5 text-sm font-medium text-slate-200">當日模擬成交</h4>
    {receiptStatus !== 'verified' || fills === null ? <p className="mt-2 text-sm text-amber-200">{receiptStatus === 'invalid' ? '成交收據驗證失敗，未顯示未驗證明細。' : '尚缺封存成交收據，不能推定零成交。'}</p>
      : fills.length ? <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[390px] text-left text-sm"><thead className="text-xs text-slate-400"><tr><th className="py-2">股票／方向</th><th>股數</th><th>成交價</th><th>手續費</th><th>稅</th></tr></thead><tbody>{fills.map(f => <tr key={f.fill_id} className="border-t border-slate-800"><td className="py-2">{f.symbol} · {f.side === 'buy' ? '買' : '賣'}</td><td>{navNumber(f.shares)}</td><td>{navNumber(f.price, 2)}</td><td>{navNumber(f.commission, 2)}</td><td>{navNumber(f.tax, 2)}</td></tr>)}</tbody></table></div>
        : <p className="mt-2 text-sm text-slate-400">封存收據確認當日無成交。</p>}
  </article>
}

function Comparison({ pair, date }: { pair: string; date: string }) {
  const query = useQuery({ queryKey: ['nav-comparison', pair, date], queryFn: () => navTradingRoomApi.detail(pair, date || undefined), staleTime: 30_000 })
  if (query.isPending) return <p role="status" className={panel}>讀取原始帳本與成交收據…</p>
  if (query.isError) return <div role="alert" className={panel}>NAV 明細讀取失敗。<button className={`${input} ml-3`} onClick={() => void query.refetch()}>重試明細</button></div>
  const data = query.data
  if (data.status !== 'available' || !data.latest) return <p role="alert" className={panel}>{data.status === 'not_found' ? '指定截止日尚無這組比較的帳本。' : '帳本讀取或完整性驗證失敗；不顯示為零資產。'}</p>
  const latest = data.latest, lastPoint = data.history[data.history.length - 1]
  return <div className="space-y-3">
    <section className={panel} aria-label="NAV 配對淨值曲線">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-base font-semibold">成本後 NAV 走勢</h3><p className="mt-1 text-sm text-slate-400">帳務日期 {data.history[0]?.date} ～ {latest.date}；非預測報酬，也不將缺值連成完整曲線。</p></div>
        <div><p className="text-xs text-slate-400">最新當日報酬差 · 候選 − 基準</p><p className={`mt-1 text-lg tabular-nums ${navSign(lastPoint?.net_return_delta)}`}>{lastPoint?.net_return_delta == null ? '不可評估' : `${navNumber(lastPoint.net_return_delta * 100, 2)} 個百分點`}</p></div></div>
      {data.history_truncated ? <p className="mt-2 text-xs text-amber-200">僅顯示截至所選日期最近 90 筆；調整截止日可查看更早紀錄。</p> : null}
      <div className="mt-4 h-72 min-w-0" role="img" aria-label={`候選與基準原始 NAV，共 ${data.history.length} 筆帳務日期`}>
        <ResponsiveContainer width="100%" height="100%"><LineChart data={data.history} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#263247" strokeDasharray="3 3" vertical={false}/><XAxis dataKey="date" tick={{ fill: '#cbd5e1', fontSize: 11 }} tickFormatter={value => value.slice(5)} minTickGap={24}/>
          <YAxis width={65} domain={['auto', 'auto']} tick={{ fill: '#cbd5e1', fontSize: 11 }} tickFormatter={value => new Intl.NumberFormat('zh-TW', { notation: 'compact' }).format(value)}/>
          <Tooltip formatter={(value: number) => navNumber(value, 2)} contentStyle={{ background: '#0f172a', border: '1px solid #475569', color: '#f1f5f9' }}/><Legend/>
          <Line type="linear" dataKey="baseline_nav" name="凍結基準" stroke="#cbd5e1" strokeDasharray="5 4" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false}/>
          <Line type="linear" dataKey="candidate_nav" name="候選模擬" stroke="#38bdf8" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false}/>
        </LineChart></ResponsiveContainer>
      </div>
      <details className="mt-3"><summary className="cursor-pointer text-sm text-sky-200">逐日淨值與報酬數據</summary><div className="mt-2 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead className="text-xs text-slate-400"><tr><th className="py-2">日期</th><th>基準 NAV</th><th>候選 NAV</th><th>基準報酬</th><th>候選報酬</th><th>差異（百分點）</th></tr></thead><tbody>{data.history.map(day => <tr key={day.date} className="border-t border-slate-800"><td className="py-2">{day.date}</td><td>{navNumber(day.baseline_nav, 2)}</td><td>{navNumber(day.candidate_nav, 2)}</td><td className={navSign(day.baseline_return)}>{navPercent(day.baseline_return)}</td><td className={navSign(day.candidate_return)}>{navPercent(day.candidate_return)}</td><td className={navSign(day.net_return_delta)}>{day.net_return_delta == null ? '不可評估' : navNumber(day.net_return_delta * 100, 2)}</td></tr>)}</tbody></table></div></details>
    </section>
    <p className="text-sm text-slate-400">以下為 {latest.date} 期末帳戶與當日成交；切換截止日可回看歷史。帳本保存成交結果，並非即時待送委託清單。</p>
    <div className="grid min-w-0 gap-3 lg:grid-cols-2">
      <Account title="凍結基準帳戶" account={latest.baseline} fills={latest.fills?.baseline ?? null} receiptStatus={latest.receipt_status}/>
      <Account title="候選模擬帳戶" account={latest.candidate} fills={latest.fills?.candidate ?? null} receiptStatus={latest.receipt_status}/>
    </div>
  </div>
}

export default function NavTradingRoom() {
  const queryClient = useQueryClient()
  const [selection, setSelection] = useState('')
  const [date, setDate] = useState('')
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const query = useQuery({ queryKey: ['nav-comparisons', date], queryFn: () => navTradingRoomApi.comparisons(date || undefined), staleTime: 30_000 })
  const data = query.data
  const selected = data?.pairs.find(pair => pair.pair_id === selection) ?? data?.pairs.find(pair => !pair.lifecycle) ?? data?.pairs[0]
  return <section aria-label="NAV 候選比較" className="min-w-0 space-y-3">
    <div className={panel}><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">NAV 候選比較</h2><span className="rounded border border-sky-400/30 px-2 py-1 text-xs text-sky-200">隔離模擬 · 唯讀</span></div>
      <p className="mt-2 text-sm leading-6 text-slate-300">看候選機制與凍結基準如何配置資金、買賣及承擔虧損。這些不是現行 Paper 帳戶，不會因查看或切換比較而下單、改權重或晉級。</p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-2 text-xs text-slate-400">比較組合（含歷史封存）<select aria-label="比較組合" className={`${input} w-full`} value={selected?.pair_id ?? ''} onChange={e => setSelection(e.target.value)} disabled={!data?.pairs.length}>
          {!data?.pairs.length ? <option value="">尚無比較帳本</option> : data.pairs.map(pair => <option key={pair.pair_id} value={pair.pair_id}>{comparisonTitle(pair)}</option>)}
        </select></label>
        <label className="flex min-w-0 flex-col gap-2 text-xs text-slate-400">帳務截止日（留空為最新）<input aria-label="帳務截止日" type="date" max={today} value={date} onChange={e => setDate(e.target.value)} className={input}/></label>
        <button className={input} disabled={query.isFetching} onClick={() => void Promise.all([query.refetch(), queryClient.invalidateQueries({ queryKey: ['nav-comparison'] })])}>重新整理</button>
      </div>
    </div>
    {query.isPending ? <p role="status" className={panel}>讀取 NAV 比較列表…</p> : query.isError ? <p role="alert" className={panel}>比較列表讀取失敗，請重新整理；不是沒有候選。</p>
      : data?.status === 'unavailable' ? <p role="alert" className={panel}>NAV 來源或身份驗證失敗；不顯示為 0 日。{data.blockers.join('、')}</p>
        : selected ? <><p className="break-words text-sm text-sky-200">{comparisonTitle(selected)}</p><p className="text-sm text-slate-300">有效 NAV 報酬 {selected.sessions} 日 · 帳務 {selected.accounted_sessions} 日 · 最新 {selected.latest_accounting_session}{selected.lifecycle ? ' · 此比較已封存' : ''}</p>
          <Comparison key={selected.pair_id} pair={selected.pair_id} date={date}/>
          <details className={panel}><summary className="cursor-pointer text-sm text-sky-200">比較定義、成熟度與來源版本</summary><div className="mt-3"><PairedNavShadow data={{ ...data!, pairs: [selected] }}/></div></details></>
          : <div className={panel}><h3 className="font-medium">尚無配對模擬帳本</h3><p className="mt-2 text-sm leading-6 text-slate-400">{data?.allocation_context_dates ? '配置已有封存，尚待兩邊執行與帳務完成。' : '尚未取得可配對的配置與執行證據。'}不拿歷史 EV、命中率或現行 Paper 資產補成候選 NAV。</p></div>}
  </section>
}
