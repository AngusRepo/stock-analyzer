import type { StrategyNavEvidence as Evidence } from '../lib/strategyNavContract'
import { DataState } from '@/components/ui/data-state'
import { StatusBadge } from '@/components/ui/status'
import { priceToneClass, type StatusTone } from '@/lib/colorTokens'
import { formatDate } from '@/lib/format'

const number = (value: number | null | undefined, percent = false) =>
  value == null || !Number.isFinite(value) ? '尚無可驗證數值'
    : percent ? `${(value * 100).toFixed(4)}%` : value.toPrecision(5)

const DECISION_LABEL: Record<string, [StatusTone, string]> = {
  PASS: ['ok', '通過'],
  FAIL: ['fail', '未通過'],
  HOLD: ['warn', '維持觀察'],
  PENDING: ['na', '等待檢查點'],
}

export default function StrategyNavEvidence({ data, loading, error, onRetry }: {
  data?: Evidence; loading: boolean; error?: Error | null; onRetry: () => void
}) {
  return <section className="mx-5 space-y-3 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.04] p-4" aria-label="Atomic 原始 NAV 評估">
    <h3 className="text-sm font-semibold text-cyan-100" title="同一策略的全部凍結比較逐一顯示原始判定，不是挑最好的一組。淨報酬已含成本；PASS 與歷史發布都不等於今日已成交或必然獲利。">Atomic 原始 NAV 評估</h3>
    {loading ? <DataState kind="loading" title="讀取原始 NAV 證據中" /> : null}
    {error && !loading ? <DataState kind="error" title="原始 NAV 證據讀取失敗" hint="不能當成未通過或 0 日" code={error.message} onRetry={onRetry} /> : null}
    {data?.status === 'display_unavailable' && !error && !loading ? <DataState
      kind="empty"
      title={data.unavailable_reason === 'strategy_nav_read_model_source_changed'
        ? 'NAV 原始來源已更新，顯示資料等待重新驗證。'
        : '目前版本的 NAV 顯示資料尚未產生。'}
      hint="不代表策略未通過或日數為 0；Alpha／命中樣本仍保留。"
      code={data.unavailable_reason ?? undefined}
      onRetry={onRetry}
    /> : null}
    {data && data.status !== 'display_unavailable' && !error && !loading ? <>
      <p className="text-xs text-slate-300">目前替換 owner：{data.current_replacement_owner === 'original_paired_daily_nav' ? '原始配對 NAV' : '舊 Atomic V7（NAV 仍獨立觀察）'} · 決策截止 {formatDate(data.as_of_date)} · {data.entry_count} 組原始比較</p>
      {data.read_model?.is_prior_business_date ? <DataState kind="stale" title={`顯示最近完成的原始證據（截至 ${formatDate(data.as_of_date)}）`} hint={`${formatDate(data.read_model.requested_as_of_date)} 尚未更新；下方判定與日數屬於上述截止日。`} /> : null}
      {data.status === 'not_registered' ? <DataState kind="empty" title="此策略版本尚未找到原始凍結 NAV 比較" hint="不把舊 Alpha 樣本換算成 NAV 成熟日。" /> : null}
      {data.status === 'unavailable' ? <DataState kind="error" title="有原始證據尚不可驗證" hint="下列完整列出，不以其他成功比較掩蓋。" /> : null}
      {data.entries.map(entry => {
        const nav = entry.nav
        const delta = nav?.mean_daily_nav_delta
        const [decisionTone, decisionLabel]: [StatusTone, string] = nav ? DECISION_LABEL[nav.decision] ?? ['na', nav.decision] : ['fail', '無法驗證']
        const values: Array<[string, string | number, string, string?]> = [
          ['已核對 NAV 日數', nav?.evaluable_date_count ?? '未知', nav ? `至少 ${nav.minimum_evaluable_dates} 日；最終 ${nav.maximum_evaluable_dates} 日檢查點` : '原始政策尚未具備'],
          ['平均每日淨報酬差（候選 − 基準）', number(delta, true), '> 0；以原始檢查點為準', priceToneClass(delta)],
          ['家族調整後 p 值', number(nav?.holm_adjusted_p), nav?.review_alpha == null ? '尚無原始額度' : `≤ ${number(nav.review_alpha)}`],
          ['原始檢查點日期', nav?.checkpoint_as_of_date ? formatDate(nav.checkpoint_as_of_date) : '尚無', '非每日重抽到通過'],
          ['最新訊號日', nav?.latest_signal_date ? formatDate(nav.latest_signal_date) : '尚無', '與決策截止日分開'],
          ['候選來源日', formatDate(entry.source_run_date), '不宣稱是第一個成熟日'],
        ]
        const identity = [
          `Artifact：${entry.artifact_id}`,
          `Family：${nav?.family_id ?? '尚無'}`,
          `Baseline checksum：${nav?.baseline_checksum ?? '尚無'}`,
          `Review：${nav?.review_id ?? '尚無'}`,
          `Decision checksum：${nav?.decision_checksum ?? '尚無'}`,
        ].join('\n')
        return <article key={entry.artifact_checksum} className="min-w-0 rounded-lg border border-white/10 bg-black/20 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0"><h4 className="break-words text-sm font-semibold text-slate-100">{entry.policy_definition.candidate.name ?? entry.policy_definition.candidate.id} → 替換 {entry.policy_definition.incumbent.name ?? entry.policy_definition.incumbent.id}</h4>
              <p className="mt-1 text-xs text-slate-400">目前查看策略在此比較是：{entry.strategy_roles.includes('candidate') ? '候選方' : '現行比較方'}</p></div>
            <div className="flex items-center gap-1.5">
              <StatusBadge tone={decisionTone} title={nav?.decision ?? 'UNAVAILABLE'}>{decisionLabel}</StatusBadge>
              <span title={identity} className="cursor-help rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-muted-foreground">身分</span>
            </div>
          </div>
          <p className="mt-2 break-words text-xs text-slate-300">原始原因：{nav?.reason ?? entry.error}</p>
          <dl className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{values.map(([label, value, target, tone]) => <div key={label} className="min-w-0">
            <dt className="text-xs text-slate-400">{label}</dt><dd className={`mt-1 break-words text-sm ${tone && delta != null && delta !== 0 ? tone : 'text-slate-100'}`}>{value}</dd>
            <dd className="mt-1 text-[11px] text-muted-foreground">{target}</dd>
          </div>)}</dl>
          <p className="mt-3 text-xs text-slate-300">{entry.publication ? `有已驗證的歷史發布 · policy cutoff ${formatDate(entry.publication.knowledge_cutoff_date)}；不等於目前比較已發布` : '沒有此 artifact 的已驗證歷史發布紀錄'}</p>
        </article>
      })}
    </> : null}
  </section>
}
