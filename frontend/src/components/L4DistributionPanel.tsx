import type { PipelineDecisionMaturityPacket } from '@/lib/pipelineMaturityContract'
import { DataState } from '@/components/ui/data-state'
import { priceToneClass } from '@/lib/colorTokens'
import { formatDate } from '@/lib/format'
import { humanizeId } from '@/lib/humanLabels'

// Values from worker pipelineDecisionMaturity (residual_model) and ml-controller l4_opb_selection (opb.status / arm_id).
const RESIDUAL_MODEL_LABELS: Record<string, string> = {
  TabPack: 'TabPack',
  Full_MLP_median: 'Full MLP（中位數）',
  MLP: 'MLP',
  none: '未使用殘差模型',
}
const OPB_STATUS_LABELS: Record<string, string> = {
  fixed_policy: '固定配置（未啟用學習）',
  arm_inert: '曝險為 0，不切換',
  cold_start_base: '樣本不足，用基準',
  no_positive_paired_edge: '無正向優勢，用基準',
  tied_paired_edge: '優勢持平，用基準',
  learned_policy: '學習選出',
  forced_counterfactual: '反事實比對（強制）',
}
// Arm ids: 'base' plus ml-controller online_portfolio_bandit.DEFAULT_ARMS.
const OPB_ARM_LABELS: Record<string, string> = {
  base: '基準配置',
  diversified_alpha: '分散（重 alpha）',
  diversified_all_eligible: '分散（全部合格標的）',
  liquidity_diversified: '分散（重流動性）',
  conservative_diversified: '保守分散',
  high_score_conservative: '高分保守',
}

export default function L4DistributionPanel({ data }: {
  data: NonNullable<PipelineDecisionMaturityPacket['l4_distribution']>
}) {
  const plan = data.plan
  const selected = plan ? Object.entries(plan.targets).filter(([,t]) => t.weight > 1e-7)
    .sort((a,b) => b[1].weight-a[1].weight || a[0].localeCompare(b[0])) : []
  const pct = (value: number) => `${(value*100).toFixed(2)}%`
  const invested = selected.reduce((sum,[,t]) => sum+t.weight,0)
  const effectiveCount = invested > 0 ? invested*invested/selected.reduce((sum,[,t]) => sum+t.weight*t.weight,0) : 0
  return <section className="min-w-0" aria-label="L4 配置資料">
    <p className="text-xs text-slate-400">殘差模型：<span title={data.residual_model}>{humanizeId(data.residual_model, RESIDUAL_MODEL_LABELS, data.residual_model ? '其他模型' : '尚未取得')}</span>。配置目標與實際成交分開記錄，實際持倉與成交請見模擬交易室。</p>
    {data.status === 'stale' && <DataState kind="stale" className="mt-2 px-0" title="以下為歷史配置" hint="日期與目前查詢日不同；不代表當日已完成配置。" />}
    {!plan ? <DataState kind={data.status === 'failed' ? 'error' : 'empty'} className="mt-2 px-0" title={data.status === 'failed' ? '組合資料讀取失敗；請查看執行紀錄。' : '尚未取得可用的 L4 配置。'} /> : <>
      {plan.prediction_coverage && <p className="mt-2 text-xs text-slate-400">有效 L3 預測 {plan.prediction_coverage.available}／{plan.prediction_coverage.candidate_count} 檔。{Object.keys(plan.prediction_coverage.unavailable).length > 0 && '缺少有效訊號的標的保留於候選池並禁止新買；既有持倉仍受硬風控保護。'}</p>}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {[
          ['訊號日期',formatDate(plan.signal_date)],['完整候選池',String(plan.proof.evaluated_candidate_count)],
          ['目標持股數',String(selected.length)],['目標現金',pct(plan.cash_weight)],
          ['有效持股數',effectiveCount.toFixed(2)],['總曝險上限',pct(plan.constraints.exposure_cap)],
          ['持股數上限',plan.constraints.max_positions == null ? '無明確檔數上限' : String(plan.constraints.max_positions)],
          ['OPB',`${humanizeId(plan.opb.status, OPB_STATUS_LABELS, '狀態不明')} · ${humanizeId(plan.opb.arm_id, OPB_ARM_LABELS, '替代配置組')}`,`${plan.opb.status} · ${plan.opb.arm_id}`],
        ].map(([label,value,code]) => <div key={label} className="min-w-0" title={code}><p className="text-xs text-slate-400">{label}</p><p className="mt-1 break-words text-sm font-medium">{value}</p></div>)}
      </div>
      <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[640px] whitespace-nowrap text-left text-xs [&_td]:px-2 [&_th]:px-2">
        <thead><tr className="border-b border-white/10 text-slate-400"><th className="py-2">股票</th><th>目標權重</th><th>決策時持倉權重</th><th>毛收益虧損機率</th><th>獲利／虧損幅度</th><th>五日預期收益（成本前）</th><th>狀態</th></tr></thead>
        <tbody>{Object.entries(plan.targets).filter(([,t]) => t.weight>1e-7 || t.current_weight>0)
          .sort((a,b)=>b[1].weight-a[1].weight || a[0].localeCompare(b[0])).map(([symbol,target]) => <tr key={symbol} className="border-b border-white/5">
            <td className="py-2">{symbol}</td><td>{pct(target.weight)}</td><td>{pct(target.current_weight)}</td>
            <td>{target.distribution ? pct(target.distribution.p_loss) : '—'}</td>
            <td>{target.distribution ? `${pct(target.distribution.gain)}／${pct(target.distribution.loss)}` : '—'}</td>
            <td className={target.expected_return_gross == null ? '' : priceToneClass(target.expected_return_gross)}>{target.expected_return_gross == null ? '無有效預測' : pct(target.expected_return_gross)}</td>
            <td>{target.locked ? '持倉鎖定' : target.weight === 0 ? '目標退出' : '依成交狀態調整'}</td>
          </tr>)}</tbody>
      </table></div>
      <p className="mt-2 text-xs text-slate-400"><span title={plan.model_checksum}>模型版本 {plan.model_checksum.slice(0,12)}</span> · <span title={plan.plan_id}>配置 {plan.plan_id.slice(0,12)}</span>。表格顯示目標；實際持倉與成交請見交易室。</p>
    </>}
  </section>
}
