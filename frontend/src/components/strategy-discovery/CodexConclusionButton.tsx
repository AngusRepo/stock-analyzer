import { Scale } from 'lucide-react'
import type { CodexButtonState } from '@/lib/strategyDiscoveryViewModel'

export function CodexConclusionButton({ enabled, state, pending, onClick }: {
  enabled: boolean
  state: CodexButtonState
  pending: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-primary-action="true"
      disabled={!enabled || pending}
      onClick={onClick}
      className="group flex min-h-24 flex-1 items-center justify-between rounded-[22px] border border-cyan-300/40 bg-cyan-300 px-5 text-left text-[#071517] shadow-[0_18px_48px_rgba(34,211,238,0.13)] transition hover:-translate-y-0.5 hover:bg-cyan-200 disabled:translate-y-0 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-[#202128] disabled:text-slate-500 disabled:shadow-none sm:px-7"
    >
      <span>
        <span className="block font-['Outfit'] text-2xl font-bold tracking-tight">Codex 結論</span>
        <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.18em] opacity-65">
          {pending ? 'loading verdict' : state.toLowerCase().split('_').join(' ')}
        </span>
      </span>
      <Scale className={`h-7 w-7 ${pending ? 'animate-pulse' : ''}`} aria-hidden="true" />
    </button>
  )
}
