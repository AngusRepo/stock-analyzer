import type { IpoShadowReadModel, IpoModelMetrics } from '@/lib/ipoShadowContract'

function signed(value: number | null | undefined, percent = false) {
  if (value == null || !Number.isFinite(value)) return <span className="text-slate-400">尚無</span>
  return <span className={`font-mono tabular-nums ${value > 0 ? 'text-emerald-300' : value < 0 ? 'text-rose-300' : 'text-slate-200'}`}>
    {value > 0 ? '+' : ''}{(value * (percent ? 100 : 1)).toFixed(percent ? 2 : 3)}{percent ? '%' : ''}
  </span>
}

function ModelResult({ title, values }: { title: string; values: IpoModelMetrics | null }) {
  return <div className="min-w-0 rounded-lg border border-white/10 p-3">
    <h4 className="font-semibold text-slate-200">{title}</h4>
    <dl className="mt-2 space-y-1.5 text-sm">
      <div className="flex justify-between gap-3"><dt className="text-slate-400">排序相關 Rank IC</dt><dd>{signed(values?.rank_ic)}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-slate-400">預估誤差 RMSE</dt><dd className="tabular-nums text-slate-200">{values ? `${(values.rmse * 100).toFixed(2)} 百分點` : '尚無'}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-slate-400">同一 proxy 淨報酬</dt><dd>{signed(values?.proxy_net_return, true)}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-slate-400">資金使用／最大單檔</dt><dd className="tabular-nums text-slate-200">{values ? `${(values.invested_fraction * 100).toFixed(1)}% / ${(values.max_weight * 100).toFixed(1)}%` : '尚無'}</dd></div>
    </dl>
  </div>
}

export default function IpoShadowComparison({ data }: { data?: IpoShadowReadModel }) {
  const unavailable = !data || data.status === 'unavailable'
  const collectionBlocked = Boolean(data?.collection?.blockers?.length)
  return <section aria-labelledby="ipo-shadow-title" className="min-w-0 rounded-2xl border border-violet-300/20 bg-violet-400/[0.035] p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id="ipo-shadow-title" className="text-base font-semibold text-slate-100">L4 × IPO 同步對照</h3>
      <span className="rounded-full border border-violet-300/25 px-3 py-1 text-xs text-violet-200">僅 shadow · 不配置、不晉級</span>
    </div>
    <p className="mt-2 text-sm leading-6 text-slate-300">L4 保持現行多特徵學習與排序。IPO 在同一天、同一批股票上先封存預測，等五個交易日報酬成熟後，再跟當時記錄的 L4 比較。</p>
    <p className="mt-2 text-xs leading-5 text-slate-400">純 shadow 使用每日當次凍結的八模型候選輸出＋已封存 stacker，不等待正式 ensemble 晉級。對照 L4 保留原本 19 個特徵；不重訓、不改正式分數或配置。</p>
    <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[
        ['最新封存預測日', unavailable ? '讀取未完成' : data?.latest_frozen_date ?? '尚未封存'],
        ['已封存日期／股票列', !unavailable && data ? `${data.frozen_dates} 日 / ${data.frozen_rows} 列` : '尚無'],
        ['IPO 成熟日期', !unavailable && data ? `${data.mature_dates} 日` : '尚無'],
        ['L4 × IPO 完整配對', !unavailable && data ? `${data.paired_dates} 日` : '尚無'],
      ].map(([label, value]) => <div key={label} className="min-w-0 rounded-lg border border-white/[0.08] p-3">
        <p className="text-xs leading-5 text-slate-400">{label}</p><p className="mt-1 break-words text-base font-semibold tabular-nums text-slate-100">{value}</p>
      </div>)}
    </div>
    {unavailable ? <p role="status" className="mt-4 text-sm text-rose-300">IPO 資料尚未接通；L4 現有資料不受影響。{data?.blockers.join(' · ')}</p>
      : data.status === 'not_registered' ? <p className="mt-4 text-sm text-amber-200">{collectionBlocked
        ? '尚未開始累積：當日候選模型或 PIT 特徵尚未通過完整性檢查。請展開下方查看具體原因；不以補零或回放冒充前瞻樣本。'
        : '等待第一批當日純 shadow 前瞻快照。每日流程會檢查並封存輸入；歷史補跑不列入前瞻成熟日。'}</p>
        : data.daily.length === 0 ? <p className="mt-4 text-sm text-amber-200">預測已封存，等待真實報酬成熟。尚無績效不等於報酬為 0。</p> : null}
    {data?.collection ? <details className="mt-3 text-xs leading-5 text-slate-400">
      <summary className="cursor-pointer py-1">收集檢查：{data.collection.signal_date} · {collectionBlocked ? '輸入待補齊' : data.collection.status === 'ready_to_freeze' ? '銜接驗證通過，等待新交易日封存' : data.collection.status}</summary>
      <p>母體 {data.collection.candidate_rows ?? '尚無'} 列／完整輸入 {data.collection.eligible_rows ?? '尚無'} 列</p>
      <p>輸入來源：{data.collection.input_mode === 'frozen_stacker_prospective' ? '八模型候選＋固定 stacker（純 shadow）' : '正式原生輸入檢查'}</p>
      {data.collection.optional_model_missing_rows != null ? <p>序列歷史不足：{data.collection.optional_model_missing_rows} 個模型／股票組合；依既有 availability 特徵處理，不補造預測。</p> : null}
      {data.collection.model_set_signature ? <p className="break-all">模型版本：{data.collection.model_set_signature}</p> : null}
      <p className="break-words">{data.collection.blockers.join(' · ')}</p>
    </details> : null}
    <div className="mt-4 space-y-3">
      {(data?.daily ?? []).slice(0, 20).map(day => <details key={day.signal_date} className="rounded-xl border border-white/10 px-3 py-2" open={day.signal_date === data?.daily[0]?.signal_date}>
        <summary className="cursor-pointer py-2 text-sm text-slate-200">
          <span className="font-semibold">{day.signal_date}</span> 預測 · {day.outcome_known_date} 成熟 · {day.sample_count} 檔
          <span className="ml-3">IPO 相對 L4：{signed(day.proxy_return_delta, true)}</span>
        </summary>
        {day.paired ? null : <p className="mb-3 text-sm text-amber-200">當日 L4 對照不完整，不計入完整配對日，也不計算優劣增量。</p>}
        <div className="grid gap-3 pb-2 md:grid-cols-2"><ModelResult title="當日封存 L4" values={day.l4} /><ModelResult title="固定 IPO shadow" values={day.ipo} /></div>
      </details>)}
    </div>
    <p className="mt-4 text-xs leading-5 text-slate-400">比較採同一 long-only／可持有現金的研究配置模型，報酬僅扣一次 18 bps；不是正式 sparse＋OPB，也不是連續持倉績效。五日窗口可能重疊，少量日期不代表已證明有效。</p>
    <p className="mt-2 text-xs leading-5 text-slate-400">8/25–8/28 四日已看過的研究回放，不計入這裡的 IPO 前瞻成熟度。IPO 原始求解器僅達停止條件，尚未證明最優解；不因畫面數據較好而自動上線。</p>
    {data?.candidate_id ? <details className="mt-3 text-xs text-slate-400"><summary className="cursor-pointer py-1">固定版本與註冊時間</summary><p className="mt-1 break-all">{data.candidate_id}</p><p className="mt-1">{data.registered_at}</p></details> : null}
  </section>
}
