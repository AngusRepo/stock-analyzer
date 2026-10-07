import { ArrowRight } from 'lucide-react'
import type { SchedulerJob } from '@/lib/api'
import { WorkstationPill, type WorkstationTone } from '@/components/workstation/WorkstationChrome'

const upstream = [
  ['finlab-v4-backfill', 'FinLab 資料就緒'],
  ['update', '市場資料更新'],
  ['indicator-queue', '指標佇列'],
  ['regime-compute', 'HMM 市場狀態'],
  ['strategy-learning-mature-evidence', '成熟策略證據'],
  ['screener', 'Screener 初篩'],
  ['allocator-ev-readiness', '配置前置檢查'],
]
function tone(status?: string): WorkstationTone {
  return status === 'success' ? 'ok' : status === 'failed' ? 'error'
    : status === 'running' ? 'warn' : status === 'waiting' ? 'info' : 'neutral'
}
function label(status?: string) {
  return status === 'success' ? '完成' : status === 'failed' ? '失敗'
    : status === 'running' ? '執行中' : status === 'waiting' ? '等待上游'
      : status === 'sleep' ? '非本日排程' : status === 'skip' ? '略過' : '尚無收據'
}
export function pipelinePreparationLabel(job?: SchedulerJob): string {
  const summary = job?.summary ?? ''
  if (/awaiting_premarket|L3 已封存/.test(summary)) return 'L3 預測已封存；等待下一交易日盤前資訊後接續 L4 推薦'
  if (/dependency=input_prep|stage=prep\b/.test(summary)) return '目前階段：特徵資料準備；等待批次完成收據'
  if (/dependency=input_snapshot|stage=snapshot\b/.test(summary)) return '目前階段：輸入快照準備'
  if (/modal_prediction=(?:triggered|running|spawned)\b/.test(summary)) return '目前階段：ML 預測'
  return job?.lastStatus === 'success' ? '流程已完成；各子階段狀態依自己的收據呈現' : '各子階段狀態依自己的啟動與完成收據呈現'
}
function Stage({ id, title, job, detail }: { id: string; title: string; job?: SchedulerJob; detail?: string }) {
  return <div data-stage={id} className="min-w-0 rounded-xl border border-[#263247] bg-[#05070c] p-3">
    <p className="text-xs text-slate-100">{title}</p>
    <div className="mt-2"><WorkstationPill tone={tone(job?.lastStatus)}>{label(job?.lastStatus)}</WorkstationPill></div>
    <p className="mt-2 text-[10px] text-[#8a92a6]">業務日 {job?.statusRunDate || '—'}</p>
    {detail && <p className="mt-1 text-[10px] leading-4 text-[#8a92a6]">{detail}</p>}
    {job?.summary && <p className="mt-2 line-clamp-2 break-words text-[10px] leading-4 text-[#70809b]" title={job.summary}>{job.summary}</p>}
  </div>
}
export default function SchedulerPipelineChain({ jobs, loading, error }: {
  jobs: SchedulerJob[]; loading?: boolean; error?: unknown
}) {
  const byId = new Map(jobs.map(job => [job.id, job]))
  const root = byId.get('evening-chain')
  const pipeline = byId.get('pipeline')
  if (error) return <div role="alert" className="p-4 text-sm text-rose-200">流程狀態讀取失敗：{String((error as Error).message || error)}</div>
  if (loading && !jobs.length) return <div className="p-4 text-sm text-slate-400">讀取當日流程收據…</div>
  if (!jobs.length) return <div className="p-4 text-sm text-slate-500">尚未取得流程狀態。</div>
  return <div className="space-y-4 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><p className="text-xs text-slate-100">每日流程鏈 · 業務日 {root?.statusRunDate || pipeline?.statusRunDate || '—'}</p>
        <p className="mt-1 text-[11px] leading-5 text-[#8a92a6]">資料更新 → 指標 → 當日風險品質／HMM → 成熟策略證據 → 初篩 → 配置前置檢查</p></div>
      {root && <WorkstationPill tone={tone(root.lastStatus)}>整體流程：{label(root.lastStatus)}</WorkstationPill>}
    </div>
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
      {upstream.map(([id, title]) => <Stage key={id} id={id} title={title} job={byId.get(id)}
        detail={id === 'regime-compute' ? '前置：同日風險資料品質驗證' : undefined} />)}
    </div>
    <div data-stage="pipeline" className="rounded-xl border border-[#d6a85f]/35 bg-[#d6a85f]/[0.03] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-[#f1c16f]">Pipeline · 下游流程容器</p>
        <WorkstationPill tone={tone(pipeline?.lastStatus)}>{label(pipeline?.lastStatus)}</WorkstationPill>
      </div>
      <p className="mt-2 text-xs text-[#b9b1a1]">{pipelinePreparationLabel(pipeline)}</p>
      <p className="mt-1 text-[11px] leading-5 text-[#8a92a6]">資料準備 → ML Predict／L3 封存 → 次交易日盤前資訊 → Recommendation／L4。共用業務日與 run ID；等待上游的階段不表示正在計算。</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-start">
        <Stage id="ml-predict" title="ML Predict · 模型預測" job={byId.get('ml-predict')} />
        <ArrowRight aria-hidden="true" className="hidden h-4 w-4 self-center text-amber-300 sm:block" />
        <Stage id="recommendation" title="Recommendation · 推薦評分與配置" job={byId.get('recommendation')} />
      </div>
    </div>
  </div>
}
