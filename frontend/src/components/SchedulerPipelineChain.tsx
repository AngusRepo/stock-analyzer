import { ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SchedulerJob } from '@/lib/api'
import JobRunTiming from './observability/JobRunTiming'
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
  if (job?.pipelineProgress && ['running','waiting'].includes(job.lastStatus)) {
    const p = job.pipelineProgress
    return `${p.status === 'waiting' ? '等待依賴' : p.status === 'blocked' ? '輸入條件未滿足' : p.status === 'failed' ? '階段失敗' : p.status === 'completed' ? '階段結束' : '目前階段'}：${pipelinePhaseName(p.phase)}`
  }
  if (/dependency=input_prep|stage=prep\b/.test(summary)) return '目前階段：特徵資料準備；等待批次完成收據'
  if (/dependency=input_snapshot|stage=snapshot\b/.test(summary)) return '目前階段：輸入快照準備'
  if (/modal_prediction=(?:triggered|running|spawned)\b/.test(summary)) return '目前階段：ML 預測'
  return job?.lastStatus === 'success' ? '流程已完成；各子階段狀態依自己的收據呈現' : '各子階段狀態依自己的啟動與完成收據呈現'
}
export function pipelinePhaseName(phase: string): string {
  return ({ startup: '工作啟動', node_load_inputs: '讀取選股輸入', node_load_market_env: '市場環境',
    awaiting_premarket: '次交易日盤前資訊', modal_prediction: '模型預測結果', input_prep: '特徵批次結果', input_adjusted: '還原股價',
    node_capture_atomic_inputs: 'Atomic 輸入重播', input_snapshot: '輸入快照匯出',
    feature_preparation: '特徵資料準備', node_build_payloads: '特徵與推論輸入',
    seal_l2_inputs: '封存 L2 輸入', prepare_prediction_request: '準備 L3 請求', dispatch_prediction: '派送 L3 模型',
    node_l2_timesfm_enrich: 'L2 時序特徵', node_l3_formal_predict: 'L3 模型預測',
    node_compute_personas: '推薦特徵', node_recommend: 'L4 配置', node_llm_reasons: '推薦說明',
    node_write_d1: '寫入結果', node_paired_nav_setup: '配對證據', node_compute_sector_flow: '產業資金流',
    node_compute_pit_residual_shadow: '殘差證據', node_export_dataset_snapshot: '研究快照',
  } as Record<string,string>)[phase] ?? phase
}
export function PipelinePhaseDetails({ job }: { job?: SchedulerJob }) {
  const p = job?.pipelineProgress
  if (!p) return <p className="mt-2 text-[11px] text-slate-400">此執行尚無階段回報；不能由 waiting 判定 Job 尚未啟動。</p>
  return <div className="mt-3 space-y-2" aria-label="Pipeline 階段紀錄">
    <p className="text-[11px] text-slate-400">階段回報時間：{new Date(p.observed_at).toLocaleTimeString('zh-TW', {timeZone:'Asia/Taipei',hour12:false})}</p>
    <ol className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {p.completed.map((row,index) => <li key={`${index}-${row.phase}`} className="rounded border border-[#263247] p-2 text-xs">
        <span>{pipelinePhaseName(row.phase)}</span>
        <span className="mt-1 block text-slate-400">{row.status === 'failed' ? '失敗' : row.status === 'blocked' ? '輸入條件未滿足' : '結束'} · {Math.floor(row.elapsed_ms/60000)}分 {Math.floor(row.elapsed_ms%60000/1000)}秒</span>
      </li>)}
    </ol>
  </div>
}
export function matureEvidencePhaseLabel(job?: SchedulerJob): string | null {
  if (job?.id !== 'strategy-learning-mature-evidence' || job.lastStatus !== 'running') return null
  const phase = /\bphase=([a-z_]+)/.exec(job.summary ?? '')?.[1]
  return ({ recover_mature_selection: '補齊成熟選股證據', canonical_selection_labels: '更新成熟標籤',
    marginal_edge: '計算策略邊際效果', reward_ledger: '更新策略回饋紀錄' } as Record<string, string>)[phase ?? ''] ?? null
}
export function SchedulerStageCard({ id, title, job, timingJob, detail, onSelect, selected, current, statusText, statusTone, leading, overview, visualState, justCompleted }: {
  id: string; title: string; job?: SchedulerJob; detail?: string;
  timingJob?: SchedulerJob;
  onSelect?: () => void; selected?: boolean; current?: boolean;
  statusText?: string; statusTone?: WorkstationTone;
  leading?: ReactNode; overview?: boolean; visualState?: string; justCompleted?: boolean;
}) {
  const Element = onSelect ? 'button' : 'div'
  const phaseLabel = matureEvidencePhaseLabel(job) ?? (job?.id === 'pipeline' ? pipelinePreparationLabel(job) : null)
  return <Element data-stage={id} data-chain-stage={onSelect ? id : undefined}
    className={'min-w-0 rounded-xl border border-[#263247] bg-[#05070c] p-3' + (overview ? ` readiness-task is-${visualState}${justCompleted ? ' just-completed' : ''}` : '') + (onSelect ? ' w-full text-left focus-visible:outline-2 focus-visible:outline-amber-300' : '') + (selected ? ' ring-1 ring-amber-300' : '')}
    onClick={onSelect} aria-current={current ? 'step' : undefined}
    aria-label={onSelect ? `${title}: ${statusText || label(job?.lastStatus)}` : undefined}>
    {overview ? <>
      {leading}
      <span className="readiness-task__copy"><strong>{title}</strong>
        <span className="readiness-task__meta"><span className="readiness-task__status" title={statusText}>{statusText?.replace(/^Historical replay · [^·]+ · /, '') || label(job?.lastStatus)}</span><span>業務日 {job?.statusRunDate || '—'}</span></span>
        {phaseLabel && <span className="text-[10px] text-slate-400">{phaseLabel}</span>}
        <JobRunTiming job={timingJob ?? job} />
      </span>
    </> : <>
    <p className="text-xs text-slate-100">{title}</p>
    <div className="mt-2"><WorkstationPill tone={statusTone ?? tone(job?.lastStatus)}>{statusText || label(job?.lastStatus)}</WorkstationPill></div>
    <p className="mt-2 text-[10px] text-[#8a92a6]">業務日 {job?.statusRunDate || '—'}</p>
    {detail && <p className="mt-1 text-[10px] leading-4 text-[#8a92a6]">{detail}</p>}
    {job?.summary && <p className="mt-2 line-clamp-2 break-words text-[10px] leading-4 text-[#70809b]" title={job.summary}>{job.summary}</p>}
    </>}
  </Element>
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
      {upstream.map(([id, title]) => <SchedulerStageCard key={id} id={id} title={title} job={byId.get(id)}
        detail={id === 'regime-compute' ? '前置：同日風險資料品質驗證' : undefined} />)}
    </div>
    <div data-stage="pipeline" className="rounded-xl border border-[#d6a85f]/35 bg-[#d6a85f]/[0.03] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-[#f1c16f]">Pipeline · 下游流程容器</p>
        <WorkstationPill tone={tone(pipeline?.lastStatus)}>{label(pipeline?.lastStatus)}</WorkstationPill>
      </div>
      <p className="mt-2 text-xs text-[#b9b1a1]">{pipelinePreparationLabel(pipeline)}</p>
      <PipelinePhaseDetails job={pipeline} />
      <p className="mt-1 text-[11px] leading-5 text-[#8a92a6]">資料準備 → ML Predict／L3 封存 → 次交易日盤前資訊 → Recommendation／L4。共用業務日與 run ID；等待上游的階段不表示正在計算。</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-start">
        <SchedulerStageCard id="ml-predict" title="ML Predict · 模型預測" job={byId.get('ml-predict')} />
        <ArrowRight aria-hidden="true" className="hidden h-4 w-4 self-center text-amber-300 sm:block" />
        <SchedulerStageCard id="recommendation" title="Recommendation · 推薦評分與配置" job={byId.get('recommendation')} />
      </div>
    </div>
  </div>
}
