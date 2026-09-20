import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { navTradingRoomApi } from '@/lib/navTradingRoomApi'
import { navNumber, navPercent } from '@/lib/navTradingRoom'
import type { PairedNavShadowReadModel } from '@/lib/pipelineMaturityContract'
import { alignStrategyAb } from '@/lib/strategyAbLive'

const panel = 'min-w-0 rounded-xl border border-[#263247] bg-[#070a10] p-4'
export default function StrategyAbLive({ data, date }: { data?: PairedNavShadowReadModel; date: string }) {
  const [experiment, setExperiment] = useState('')
  const pairs = data?.pairs.filter(pair => pair.comparison?.strategy_ab) ?? []
  const groups = [...new Set(pairs.map(pair => pair.comparison!.strategy_ab!.experiment_id))]
  const selected = groups.includes(experiment) ? experiment : groups[0]
  const select = (role: 'A' | 'B') => pairs.filter(pair => pair.comparison?.strategy_ab?.experiment_id === selected
    && pair.comparison.strategy_ab.role === role)
  const as = select('A'), bs = select('B')
  const a = useQuery({ queryKey: ['nav-comparison', as[0]?.pair_id, date], enabled: as.length === 1,
    queryFn: () => navTradingRoomApi.detail(as[0].pair_id, date || undefined), staleTime: 30_000 })
  const b = useQuery({ queryKey: ['nav-comparison', bs[0]?.pair_id, date], enabled: bs.length === 1,
    queryFn: () => navTradingRoomApi.detail(bs[0].pair_id, date || undefined), staleTime: 30_000 })
  const comparison = a.data && b.data ? alignStrategyAb(a.data, b.data) : null
  const rows = [['A 主方案', a.data], ['B 挑戰方案', b.data]] as const
  return <section className={panel} aria-label="A B 每日實際比較">
    <h2 className="text-lg font-semibold text-slate-100">A 主方案 vs B 挑戰方案 · 每日完整鏈路</h2>
    <p className="mt-2 text-sm leading-6 text-slate-300">A：價格 TimeXer＋三頭。B：外生特徵 TimeXer＋三頭＋EV 殘差 MLP。兩邊各自持倉、現金與 OPB，固定八組 ML；以下讀取每日配對帳本。</p>
    {groups.length > 1 && <label className="mt-3 block text-sm">比較版本 <select className="ml-2 rounded bg-slate-900 p-2" value={selected} onChange={e => setExperiment(e.target.value)}>{groups.map(id => <option key={id} value={id}>{id.slice(0, 12)}</option>)}</select></label>}
    {!data || data.status === 'unavailable' ? <p role="status" className="mt-4 text-amber-200">每日來源尚未取得或驗證失敗。</p>
      : as.length !== 1 || bs.length !== 1 ? <p role="status" className="mt-4 text-slate-400">尚未形成同一實驗的 A/B 完整帳本。下方歷史研究不會填入每日績效。</p>
        : a.isError || b.isError ? <p role="alert" className="mt-4 text-amber-200">A/B 帳本讀取失敗，請重新整理。</p>
          : !comparison ? <p role="status" className="mt-4">讀取 A/B 帳本…</p>
            : !comparison.aligned ? <p role="alert" className="mt-4 text-amber-200">{comparison.reason}；暫不計算績效差。</p>
              : <>
                <p className="mt-3 text-sm text-slate-400">共同帳務期間 {comparison.start}～{comparison.end} · 圖表顯示最近 {comparison.history.length} 日</p>
                <div className="mt-4 h-64" aria-label="A B 含應收退費淨值曲線"><ResponsiveContainer width="100%" height="100%"><LineChart data={comparison.history}><CartesianGrid stroke="#263247"/><XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 11 }}/><YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} tickFormatter={v => navPercent(v)}/><Tooltip formatter={v => navPercent(Number(v))}/><Legend/><Line isAnimationActive={false} type="linear" dataKey="A" name="A 含應收退費" stroke="#38bdf8" dot={false}/><Line isAnimationActive={false} type="linear" dataKey="B" name="B 含應收退費" stroke="#a78bfa" dot={false}/></LineChart></ResponsiveContainer></div>
                <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead className="text-slate-400"><tr><th>方案</th><th>原價扣費報酬</th><th>含應收退費報酬</th><th>應收退費</th><th>可用現金</th><th>持倉檔數</th><th>距高點回撤</th></tr></thead><tbody>{rows.map(([label, detail]) => { const account = detail!.latest!.candidate; return <tr key={label} className="border-t border-slate-800"><td className="py-3">{label}</td><td>{navPercent(account.nav! / detail!.initial_nav! - 1)}</td><td>{navPercent(account.estimated_nav_including_rebate! / detail!.initial_nav! - 1)}</td><td>{navNumber(account.rebate_receivable, 2)}</td><td>{navNumber(account.cash, 2)}</td><td>{account.positions.length}</td><td>{navPercent(account.drawdown)}</td></tr> })}</tbody></table></div>
                <p className="mt-3 text-xs leading-5 text-slate-400">成交時扣原價；月退估計按每筆 2.5 折、最低 20 元。名義入帳日為次月 10 日，未確認入帳的退費不增加可用現金。原價 NAV 與含應收估計分開呈現；回撤欄採原價 NAV。</p>
              </>}
  </section>
}
