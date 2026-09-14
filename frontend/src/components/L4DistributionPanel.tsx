import type { PipelineDecisionMaturityPacket } from '@/lib/pipelineMaturityContract'

export default function L4DistributionPanel({ data }: {
  data: NonNullable<PipelineDecisionMaturityPacket['l4_distribution']>
}) {
  const plan = data.plan
  const selected = plan ? Object.entries(plan.targets).filter(([,t]) => t.weight > 1e-7)
    .sort((a,b) => b[1].weight-a[1].weight || a[0].localeCompare(b[0])) : []
  const pct = (value: number) => `${(value*100).toFixed(2)}%`
  const invested = selected.reduce((sum,[,t]) => sum+t.weight,0)
  const effectiveCount = invested > 0 ? invested*invested/selected.reduce((sum,[,t]) => sum+t.weight*t.weight,0) : 0
  return <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5" aria-label="新 L4 與組合配置">
    <h2 className="text-lg font-semibold">L4 三頭模型 · 收益分布與組合配置</h2>
    <p className="mt-2 text-sm text-slate-400">完整可用 L3 訊號 → 虧損機率／獲利幅度／虧損幅度 → 保留 EV 正負號的 sparse＋OPB → 全池配置 → 成交回饋</p>
    <p className="mt-2 text-sm text-slate-400">殘差動能與預測誤差校正目前未啟用，仍列研究觀察。</p>
    <p role="status" className="mt-3 text-sm text-amber-200">{data.efficacy_status === 'paired_comparison_passed' ? '已通過對齊歷史帳戶比較；持續觀察 Paper 實際績效。' : 'Paper 試驗：績效優於原正式策略尚未證實。'}</p>
    {data.status === 'stale' && <p role="status" className="mt-4 text-amber-300">以下為歷史配置，日期與目前查詢日不同；不代表當日已完成配置。</p>}
    {!plan ? <p role="status" className="mt-5">{data.status === 'failed' ? '組合資料讀取失敗；請查看執行紀錄。' : '新 L4 已設定，等待第一份通過驗證的配置。'}</p> : <>
      {plan.prediction_coverage && <p className="mt-4 text-sm text-slate-400">有效 L3 預測 {plan.prediction_coverage.available}／{plan.prediction_coverage.candidate_count} 檔。{Object.keys(plan.prediction_coverage.unavailable).length > 0 && '缺少有效訊號的標的保留於候選池並禁止新買；既有持倉仍受硬風控保護。'}</p>}
      <div className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          ['訊號日期',plan.signal_date],['完整候選池',String(plan.proof.evaluated_candidate_count)],
          ['目標持股數',String(selected.length)],['目標現金',pct(plan.cash_weight)],
          ['有效持股數',effectiveCount.toFixed(2)],['總曝險上限',pct(plan.constraints.exposure_cap)],
          ['持股數上限',plan.constraints.max_positions == null ? '無明確檔數上限' : String(plan.constraints.max_positions)],
          ['OPB',`${plan.opb.status} · ${plan.opb.arm_id}`],
        ].map(([label,value]) => <div key={label}><p className="text-xs text-slate-400">{label}</p><p className="mt-1 font-medium">{value}</p></div>)}
      </div>
      <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[900px] whitespace-nowrap text-left text-sm [&_td]:px-2 [&_th]:px-2">
        <thead><tr className="border-b border-white/10 text-slate-400"><th className="py-2">股票</th><th>目標權重</th><th>決策時持倉權重</th><th>毛收益虧損機率</th><th>獲利／虧損幅度</th><th>五日預期收益（成本前）</th><th>狀態</th></tr></thead>
        <tbody>{Object.entries(plan.targets).filter(([,t]) => t.weight>1e-7 || t.current_weight>0)
          .sort((a,b)=>b[1].weight-a[1].weight || a[0].localeCompare(b[0])).map(([symbol,target]) => <tr key={symbol} className="border-b border-white/5">
            <td className="py-2">{symbol}</td><td>{pct(target.weight)}</td><td>{pct(target.current_weight)}</td>
            <td>{target.distribution ? pct(target.distribution.p_loss) : '—'}</td>
            <td>{target.distribution ? `${pct(target.distribution.gain)}／${pct(target.distribution.loss)}` : '—'}</td>
            <td>{target.expected_return_gross == null ? '無有效預測' : pct(target.expected_return_gross)}</td>
            <td>{target.locked ? '持倉鎖定' : target.weight === 0 ? '目標退出' : '依成交狀態調整'}</td>
          </tr>)}</tbody>
      </table></div>
      <p className="mt-3 text-xs text-slate-400">模型版本 {plan.model_checksum.slice(0,12)} · 配置 {plan.plan_id.slice(0,12)}。表格顯示目標；實際持倉與成交請見交易室。</p>
    </>}
  </section>
}
