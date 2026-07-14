import { Activity, RotateCcw } from 'lucide-react'
import type { AnalysisButtonState } from '@/lib/strategyDiscoveryViewModel'

export function AnalysisButton({ enabled, state, pending, onClick }: {
  enabled: boolean
  state: AnalysisButtonState
  pending: boolean
  onClick: () => void
}) {
  const recoverable = state === 'FAILED_RECOVERABLE'
  const Icon = recoverable ? RotateCcw : Activity
  return (
    <button
      type="button"
      data-primary-action="true"
      disabled={!enabled || pending}
      onClick={onClick}
      className="group relative flex min-h-24 flex-1 items-center justify-between overflow-hidden rounded-[22px] border border-amber-300/40 bg-amber-300 px-5 text-left text-[#17140d] shadow-[0_18px_48px_rgba(245,158,11,0.16)] transition hover:-translate-y-0.5 hover:bg-amber-200 disabled:translate-y-0 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-[#202128] disabled:text-slate-500 disabled:shadow-none sm:px-7"
    >
      <span>
        <span className="block font-['Outfit'] text-2xl font-bold tracking-tight">完整分析</span>
        <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.18em] opacity-65">
          {pending ? 'starting' : recoverable ? 'resume checkpoint' : state.toLowerCase()}
        </span>
      </span>
      <Icon className={`h-7 w-7 ${pending ? 'animate-pulse' : ''}`} aria-hidden="true" />
    </button>
  )
}
