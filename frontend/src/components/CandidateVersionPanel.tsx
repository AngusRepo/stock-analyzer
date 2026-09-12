import type { CandidateVersionComparison } from '@/lib/pipelineMaturityContract'

export default function CandidateVersionPanel({ versions }: { versions?: CandidateVersionComparison }) {
  if (!versions) return null
  return <section aria-label="候選版本對照" className="mb-4 rounded-lg border border-white/10 p-3 text-xs leading-5">
    <h4 className="font-semibold text-slate-200">候選版本對照</h4>
    <p className="mt-1 text-slate-400">最新紀錄不等於正在驗證；下方 NAV 日數與判定只屬於 NAV 評估候選，不會轉移到新版。</p>
    <div className="mt-3 grid gap-3 md:grid-cols-2">
      {([
        ['最新候選紀錄', versions.latest_candidate, versions.latest_query_status],
        ['本頁 NAV 評估候選', versions.evaluated_candidate, versions.evaluation_query_status],
      ] as const).map(([title, candidate, queryStatus]) => <div key={title} className="min-w-0 rounded border border-white/10 p-3">
        <p className="font-semibold text-slate-200">{title}</p>
        {queryStatus === 'error' ? <p className="text-amber-200">讀取失敗，不能判定沒有候選</p>
          : !candidate ? <p className="text-slate-400">尚無候選紀錄</p> : <>
            <p className="mt-1 text-slate-300">候選來源日：{candidate.generated_date ?? '未知'}</p>
            <p className="text-slate-400">模型訓練截止：{candidate.trained_until ?? '未驗證'}</p>
            {!candidate.identity_valid || queryStatus === 'blocked'
              ? <p className="text-amber-200">候選身分或 NAV 證據驗證受阻，不能套用其他版本數據</p> : null}
            <p className="text-slate-400">離線診斷：{candidate.offline_decision ?? '尚無資料'}（非 NAV 採用判定）</p>
            <details className="mt-2 text-slate-400"><summary className="cursor-pointer">Cohort 與產物身分</summary>
              <p className="break-all">{candidate.cohort_id ?? 'cohort 未驗證'}</p>
              <p className="break-all">{candidate.artifact_id ?? 'artifact 未知'}</p>
              <p className="break-all">checksum：{candidate.checksum ?? '未知'}</p>
            </details>
          </>}
      </div>)}
    </div>
    {versions.different_artifacts === true ? <p className="mt-2 text-slate-300">兩欄是不同候選，不可混用成熟日或績效。</p>
      : versions.different_artifacts === false ? <p className="mt-2 text-slate-400">兩欄是同一候選，沒有另外一組成熟度。</p> : null}
  </section>
}
