import type { StrategyNavEvidence as Evidence } from '../lib/strategyNavContract'

const number = (value: number | null | undefined, percent = false) =>
  value == null || !Number.isFinite(value) ? '尚無可驗證數值'
    : percent ? `${(value * 100).toFixed(4)}%` : value.toPrecision(5)

export default function StrategyNavEvidence({ data, loading, error, onRetry }: {
  data?: Evidence; loading: boolean; error?: Error | null; onRetry: () => void
}) {
  return <section className="mx-5 space-y-3 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.04] p-4" aria-label="Atomic 原始 NAV 評估">
    <h3 className="text-sm font-semibold text-cyan-100">Atomic 原始 NAV 評估</h3>
    <p className="text-xs leading-5 text-slate-400">同一策略的全部凍結比較，逐一顯示原始判定；不是挑最好的一組。淨報酬已含成本，不再次扣費。PASS 與歷史發布紀錄都不等於今日已成交或必然獲利。</p>
    {loading ? <p role="status" className="text-sm text-cyan-200">讀取原始 NAV 證據中…</p> : null}
    {error ? <div role="alert" className="text-sm text-rose-200">原始 NAV 證據讀取失敗，不能當成未通過或 0 日。<button type="button" onClick={onRetry} className="ml-3 underline">重試</button></div> : null}
    {data && !error && !loading ? <>
      <p className="text-xs text-slate-300">目前替換 owner：{data.current_replacement_owner === 'original_paired_daily_nav' ? '原始配對 NAV' : '舊 Atomic V7（NAV 仍獨立觀察）'} · 決策截止 {data.as_of_date} · {data.entry_count} 組原始比較</p>
      {data.status === 'not_registered' ? <p className="text-sm text-amber-200">此策略版本尚未找到原始凍結 NAV 比較；沒有把舊 Alpha 樣本換算成 NAV 成熟日。</p> : null}
      {data.status === 'unavailable' ? <p role="alert" className="text-sm text-rose-200">有原始證據尚不可驗證；下列完整列出，不以其他成功比較掩蓋。</p> : null}
      {data.entries.map(entry => {
        const nav = entry.nav
        const delta = nav?.mean_daily_nav_delta
        const values: Array<[string, string | number, string]> = [
          ['已核對 NAV 日數', nav?.evaluable_date_count ?? '未知', nav ? `至少 ${nav.minimum_evaluable_dates} 日；最終 ${nav.maximum_evaluable_dates} 日檢查點` : '原始政策尚未具備'],
          ['平均每日淨報酬差（候選 − 基準）', number(delta, true), '> 0；以原始檢查點為準'],
          ['家族調整後 p 值', number(nav?.holm_adjusted_p), nav?.review_alpha == null ? '尚無原始額度' : `≤ ${number(nav.review_alpha)}`],
          ['原始檢查點日期', nav?.checkpoint_as_of_date ?? '尚無', '非每日重抽到通過'],
          ['最新訊號日', nav?.latest_signal_date ?? '尚無', '與決策截止日分開'],
          ['候選來源日', entry.source_run_date, '不宣稱是第一個成熟日'],
        ]
        return <article key={entry.artifact_checksum} className="min-w-0 rounded-lg border border-white/10 bg-black/20 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0"><h4 className="break-words text-sm font-semibold text-slate-100">{entry.policy_definition.candidate.name ?? entry.policy_definition.candidate.id} → 替換 {entry.policy_definition.incumbent.name ?? entry.policy_definition.incumbent.id}</h4>
              <p className="mt-1 text-xs text-slate-400">目前查看策略在此比較是：{entry.strategy_roles.includes('candidate') ? '候選方' : '現行比較方'}</p></div>
            <span className={nav?.decision === 'PASS' ? 'text-emerald-300' : nav?.decision === 'FAIL' || !nav ? 'text-rose-300' : 'text-amber-200'}>{nav?.decision ?? 'UNAVAILABLE'}</span>
          </div>
          <p className="mt-2 break-words text-xs text-slate-300">原始原因：{nav?.reason ?? entry.error}</p>
          <dl className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{values.map(([label, value, target]) => <div key={label} className="min-w-0">
            <dt className="text-xs text-slate-400">{label}</dt><dd className={`mt-1 break-words text-sm ${label.startsWith('平均') && delta != null && delta !== 0 ? delta > 0 ? 'text-emerald-300' : 'text-rose-300' : 'text-slate-100'}`}>{value}</dd>
            <dd className="mt-1 text-[11px] text-slate-500">{target}</dd>
          </div>)}</dl>
          <p className="mt-3 text-xs text-slate-300">{entry.publication ? `有已驗證的歷史發布 · policy cutoff ${entry.publication.knowledge_cutoff_date}；不等於目前比較已發布` : '沒有此 artifact 的已驗證歷史發布紀錄'}</p>
          <details className="mt-3 text-xs text-slate-400"><summary className="cursor-pointer">原始身分與 lineage</summary><dl className="mt-2 space-y-1 break-all">
            <dt>Artifact</dt><dd>{entry.artifact_id}</dd><dt>Family</dt><dd>{nav?.family_id ?? '尚無'}</dd>
            <dt>Baseline checksum</dt><dd>{nav?.baseline_checksum ?? '尚無'}</dd><dt>Review</dt><dd>{nav?.review_id ?? '尚無'}</dd>
            <dt>Decision checksum</dt><dd>{nav?.decision_checksum ?? '尚無'}</dd>
          </dl></details>
        </article>
      })}
    </> : null}
  </section>
}
