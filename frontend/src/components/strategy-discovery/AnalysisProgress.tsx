import { Check, CircleDashed } from 'lucide-react'
import type { AnalysisRun } from '@/lib/strategyDiscoveryViewModel'
import { formatStep } from '@/lib/strategyDiscoveryViewModel'

export function AnalysisProgress({ run }: { run: AnalysisRun }) {
  const completed = Math.min(run.completed_steps, run.total_steps)
  return (
    <section aria-label="分析進度" className="border-y border-white/10 bg-white/[0.025] px-5 py-5 sm:px-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-100">完整分析進行中</p>
          <p className="mt-1 text-xs text-slate-400">目前階段：{formatStep(run.current_step)}</p>
        </div>
        <span className="font-mono text-sm text-amber-200">已完成 {completed} / {run.total_steps}</span>
      </div>
      <ol className="mt-5 grid grid-cols-5 gap-1 sm:grid-cols-10" aria-label="Workflow checkpoint">
        {Array.from({ length: run.total_steps }, (_, index) => {
          const done = index < completed
          const current = index === completed
          return (
            <li key={index} className={`h-1.5 rounded-full ${done ? 'bg-emerald-400' : current ? 'bg-amber-300' : 'bg-white/10'}`}>
              <span className="sr-only">Checkpoint {index + 1}: {done ? '完成' : current ? '進行中' : '等待'}</span>
            </li>
          )
        })}
      </ol>
      <div className="mt-3 flex items-center gap-2 text-[11px] text-slate-500">
        {completed > 0 ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <CircleDashed className="h-3.5 w-3.5" />}
        僅依已寫入的 checkpoint 計算，不使用時間推估。
      </div>
    </section>
  )
}
