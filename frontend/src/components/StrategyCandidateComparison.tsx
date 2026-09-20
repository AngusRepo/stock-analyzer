import { useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import evidence from '@/data/candidateComparisonResearch.json'
import { navNumber, navPercent } from '@/lib/navTradingRoom'
import { rebateView, scheduledRebateDate } from '@/lib/candidateComparison'

const panel = 'min-w-0 rounded-xl border border-[#263247] bg-[#070a10] p-4'
const input = 'min-h-11 rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400'
const roles = ['primary', 'challenger'] as const
const titles = { primary: 'A · 主候選', challenger: 'B · 第一挑戰' }
const scenarios = evidence.scenarios.map(row => ({ ...row, views: { primary: rebateView(row.accounts.primary, evidence.initial_cash), challenger: rebateView(row.accounts.challenger, evidence.initial_cash) } }))

/** Verified frozen research; independent of prospective authenticated NAV reads. */
export default function StrategyCandidateComparison() {
  const [scenarioId, setScenarioId] = useState('2026-09-02_5')
  const [adjusted, setAdjusted] = useState(true)
  const scenario = scenarios.find(row => row.id === scenarioId)!
  const chart = scenario.views.primary.history.map((day, i) => ({ date: day.date,
    primary: (adjusted ? day.adjusted_return : day.gross_return) * 100,
    challenger: (adjusted ? scenario.views.challenger.history[i].adjusted_return : scenario.views.challenger.history[i].gross_return) * 100,
  }))
  const starts = scenarios.filter(row => row.slippage_bps === 5)
  const startMean = (role: typeof roles[number], field: 'gross_return' | 'adjusted_return') => starts.reduce((sum, row) => sum + row.views[role].latest[field], 0) / starts.length
  const months = [...new Set(roles.flatMap(role => scenario.views[role].months.map(month => month.month)))].sort()
  return <section className="min-w-0 space-y-3" aria-label="主候選與第一挑戰比較">
    <div className={panel}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold text-slate-100">主候選 vs 第一挑戰</h2><span className="rounded border border-amber-400/30 px-2 py-1 text-xs text-amber-200">研究回放 · 固定快照</span></div>
      <p className="mt-2 text-sm leading-6 text-slate-300">兩邊都保留八組 L3 模型，以 TimeXer 取代 DLinear，接相同 signed EV sparse＋OPB 配置。</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-sky-500/30 p-3"><p className="font-medium text-sky-200">A · 已選定主候選</p><p className="mt-1 text-sm text-slate-300">價格 TimeXer ＋ 三頭 L4</p></div>
        <div className="rounded-lg border border-violet-400/30 p-3"><p className="font-medium text-violet-200">B · 第一挑戰候選</p><p className="mt-1 text-sm text-slate-300">137 外生特徵 TimeXer ＋ 三頭 L4 ＋ EV 殘差 MLP</p><p className="mt-1 text-xs text-slate-400">MLP 接收 L3 與三頭訊號，修正 EV；不是聯合修正三個頭的版本。</p></div>
      </div>
      <p className="mt-3 text-xs leading-5 text-amber-100">訊號截至 {evidence.last_signal_date}；估值截至 {evidence.valuation_through}；證據整理於 {evidence.evidence_date}。尚未接入這兩個候選的每日配對帳本，重新整理不會延伸此研究期間，也不計入上線 NAV 資格。</p>
      <p className="mt-2 text-xs leading-5 text-slate-400">每帳戶起始 100 萬元、最多五檔、完整候選池、相同配置與成交規則。全期含 MLP 暖機期；9/2 起重新建立現金帳戶，才是 MLP 啟用期比較（8 個訊號日）。</p>
    </div>

    <div className={panel}>
      <h3 className="font-medium text-slate-100">月退後的成本與收益</h3>
      <p className="mt-2 text-sm leading-6 text-slate-300">手續費 2.5 折，次月 10 日月退；每筆折後至少 20 元。原價 40 元退 20 元，原價 20 元不退。交易稅與滑價不退。</p>
      <p className="mt-2 text-xs leading-5 text-amber-100">同一批成交加計預估月退應收，未重跑退費再投入後的配置。可用現金維持原帳本；沒有入帳憑證，不假定已收到退費。券商取整及假日入帳規則未納入。</p>
      <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[480px] text-left text-sm [&_th]:pr-4 [&_td]:pr-4"><thead className="text-xs text-slate-400"><tr><th className="py-2">期間 · 5 bps 滑價</th><th>A 原始</th><th>A 含預估月退</th><th>B 原始</th><th>B 含預估月退</th></tr></thead><tbody>
        {starts.filter(row => ['2026-08-05', '2026-09-02'].includes(row.signal_start)).map(row => <tr key={row.id} className="border-t border-slate-800"><td className="py-3">{row.signal_start === '2026-08-05' ? '全期 8/5–9/18' : '啟用期 9/2–9/18'}</td>{roles.flatMap(role => [<td key={`${role}-gross`}>{navPercent(row.views[role].latest.gross_return)}</td>, <td key={`${role}-rebate`} className="font-medium text-slate-100">{navPercent(row.views[role].latest.adjusted_return)}</td>])}</tr>)}
        <tr className="border-t border-slate-700"><td className="py-3">六起始日平均（期間重疊）</td>{roles.flatMap(role => [<td key={`${role}-mean-gross`}>{navPercent(startMean(role, 'gross_return'))}</td>, <td key={`${role}-mean-adjusted`} className="font-medium text-slate-100">{navPercent(startMean(role, 'adjusted_return'))}</td>])}</tr>
      </tbody></table></div>
    </div>

    <div className={panel}>
      <label className="flex max-w-sm flex-col gap-2 text-xs text-slate-400">比較情境 · 各自從現金重新開始<select className={input} aria-label="研究比較情境" value={scenarioId} onChange={event => setScenarioId(event.target.value)}>{evidence.scenarios.map(row => <option key={row.id} value={row.id}>{row.signal_start} 起 · 滑價 {row.slippage_bps} bps／邊</option>)}</select></label>
      <label className="mt-3 flex min-h-11 items-center gap-2 text-sm text-slate-200"><input type="checkbox" className="size-4" checked={adjusted} onChange={event => setAdjusted(event.target.checked)}/>曲線含預估月退</label>
      <div className="mt-4 h-72 min-w-0" role="img" aria-label="主候選與第一挑戰累積收益曲線">
        <ResponsiveContainer width="100%" height="100%"><LineChart data={chart} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#263247" strokeDasharray="3 3" vertical={false}/><XAxis dataKey="date" tick={{ fill: '#cbd5e1', fontSize: 11 }} tickFormatter={value => value.slice(5)} minTickGap={24}/>
          <YAxis width={55} tick={{ fill: '#cbd5e1', fontSize: 11 }} tickFormatter={value => `${value}%`}/>
          <Tooltip formatter={(value: number) => `${navNumber(value, 2)}%`} contentStyle={{ background: '#0f172a', border: '1px solid #475569', color: '#f1f5f9' }}/><Legend/>
          <Line type="linear" dataKey="primary" name="A · 主候選" stroke="#38bdf8" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false}/>
          <Line type="linear" dataKey="challenger" name="B · 第一挑戰" stroke="#c4b5fd" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false}/>
        </LineChart></ResponsiveContainer>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">{roles.map(role => {
        const source = scenario.accounts[role], last = source.ledger[source.ledger.length - 1]
        const account = scenario.views[role]
        const { commission, tax } = account
        const metrics: Array<[string, string]> = [
          ['含預估月退報酬', navPercent(account.latest.adjusted_return)], ['含預估月退最大回撤', navPercent(account.adjusted_drawdown)],
          ['預估退費應收', navNumber(account.estimated_rebate, 2)], ['折後手續費', navNumber(account.net_commission, 2)],
          ['原始成本後報酬', navPercent(source.summary.net_return)], ['原始最大回撤', navPercent(source.summary.max_drawdown)],
          ['原價手續費', navNumber(commission, 2)], ['交易稅（不退）', navNumber(tax, 2)],
          ['滑價（已含於成交價）', navNumber(source.summary.slippage_cost, 2)], ['原始可用現金', navNumber(last.cash, 2)],
          ['平均股票資金使用率', navPercent(source.summary.mean_exposure)], ['成交筆數／曾交易標的', `${source.summary.fill_count}／${source.summary.unique_traded_symbols}`],
        ]
        return <article key={role} className="min-w-0 rounded-lg border border-slate-700 p-3" aria-label={titles[role]}><h3 className={role === 'primary' ? 'font-medium text-sky-200' : 'font-medium text-violet-200'}>{titles[role]}</h3><dl className="mt-3 grid grid-cols-2 gap-3 text-sm">{metrics.map(([label, value]) => <div key={label}><dt className="text-xs text-slate-400">{label}</dt><dd className="mt-1 tabular-nums text-slate-100">{value}</dd></div>)}</dl><p className="mt-3 text-xs leading-5 text-slate-400">期末帳本標的：{last.symbols.join('、')}。公司行動形成的微小剩餘部位仍列入。</p></article>
      })}</div>
    </div>

    <div className={panel}>
      <h3 className="font-medium text-slate-100">每月退費明細 · 目前情境</h3>
      <p className="mt-2 text-xs leading-5 text-slate-400">預定日為次月 10 日，尚未調整假日。這些是模擬成交，沒有實際入帳憑證；預定日期已到也不代表已入帳。</p>
      <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[650px] text-left text-sm [&_th]:pr-4 [&_td]:pr-4"><thead className="text-xs text-slate-400"><tr><th>成交月份</th><th>預定退費日</th><th>A 原價手續費</th><th>A 預估退費</th><th>B 原價手續費</th><th>B 預估退費</th></tr></thead><tbody>{months.map(month => <tr key={month} className="border-t border-slate-800"><td className="py-3">{month}</td><td>{scheduledRebateDate(month)}</td>{roles.flatMap(role => { const item = scenario.views[role].months.find(row => row.month === month); return [<td key={`${role}-fee`}>{navNumber(item?.commission ?? 0, 2)}</td>, <td key={`${role}-rebate`}>{navNumber(item?.estimated_rebate ?? 0, 2)}</td>] })}</tr>)}</tbody></table></div>
    </div>

    <details className={panel}><summary className="cursor-pointer text-sm text-sky-200">逐日淨值與原始可用現金</summary><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[780px] text-left text-sm [&_th]:pr-3 [&_td]:pr-3"><thead className="text-xs text-slate-400"><tr><th>日期</th><th>A 原始 NAV</th><th>A 含預估月退</th><th>A 現金</th><th>B 原始 NAV</th><th>B 含預估月退</th><th>B 現金</th></tr></thead><tbody>{scenario.views.primary.history.map((day, i) => <tr key={day.date} className="border-t border-slate-800"><td className="py-2">{day.date}</td>{[day, scenario.views.challenger.history[i]].flatMap((row, j) => [<td key={`${j}-nav`}>{navNumber(row.nav, 2)}</td>, <td key={`${j}-adjusted`}>{navNumber(row.adjusted_nav, 2)}</td>, <td key={`${j}-cash`}>{navNumber(row.cash, 2)}</td>])}</tr>)}</tbody></table></div></details>

    <details className={panel}><summary className="cursor-pointer text-sm text-sky-200">六個起始日比較 · 含預估月退</summary><p className="mt-2 text-xs leading-5 text-slate-400">起始日期不同但結束日相同，期間彼此重疊，不是六個獨立樣本。兩者的績效差異尚未證明具有統計顯著性。</p><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[400px] text-left text-sm"><thead className="text-xs text-slate-400"><tr><th>起始訊號日</th><th>A 報酬</th><th>B 報酬</th><th>B − A 百分點</th></tr></thead><tbody>{starts.map(row => <tr key={row.id} className="border-t border-slate-800"><td className="py-2">{row.signal_start}</td><td>{navPercent(row.views.primary.latest.adjusted_return)}</td><td>{navPercent(row.views.challenger.latest.adjusted_return)}</td><td>{navNumber((row.views.challenger.latest.adjusted_return - row.views.primary.latest.adjusted_return) * 100, 2)}</td></tr>)}</tbody></table></div></details>

    <details className={panel}><summary className="cursor-pointer text-sm text-sky-200">兩邊完整成交紀錄與資料來源</summary><p className="mt-2 text-xs leading-5 text-slate-400">下一交易日開盤模擬成交；並非正式 Paper 成交。未完整重播 debate、盤中風控、T+2 與公司行動實際入帳，不將這份研究視為正式可交易收益。</p>{roles.map(role => <div key={role} className="mt-4"><h4 className="text-sm font-medium">{titles[role]}</h4><p className="mt-1 break-all text-xs text-slate-500">{scenario.accounts[role].source}<br/>SHA-256：{scenario.accounts[role].sha256}</p><div className="mt-2 overflow-x-auto"><table className="w-full min-w-[650px] text-left text-sm"><thead className="text-xs text-slate-400"><tr><th>日期</th><th>股票</th><th>方向</th><th>股數</th><th>成交價</th><th>手續費</th><th>交易稅</th></tr></thead><tbody>{scenario.accounts[role].fills.map((fill, i) => <tr key={i} className="border-t border-slate-800"><td className="py-2">{fill.date}</td><td>{fill.symbol}</td><td>{fill.side === 'buy' ? '買' : '賣'}</td><td>{navNumber(fill.shares)}</td><td>{navNumber(fill.price, 2)}</td><td>{navNumber(fill.commission, 2)}</td><td>{navNumber(fill.tax, 2)}</td></tr>)}</tbody></table></div></div>)}</details>
  </section>
}
