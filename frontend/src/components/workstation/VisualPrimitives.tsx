import type { ReactNode } from 'react'

export type VisualTone = 'ok' | 'warn' | 'error' | 'info' | 'neutral'

const TONE_CLASS: Record<VisualTone, string> = {
  ok: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200',
  warn: 'border-amber-400/25 bg-amber-400/10 text-amber-200',
  error: 'border-rose-400/25 bg-rose-400/10 text-rose-200',
  info: 'border-sky-400/25 bg-sky-400/10 text-sky-200',
  neutral: 'border-[#263247] bg-[#0b111b] text-[#aab6c8]',
}

const BAR_CLASS: Record<VisualTone, string> = {
  ok: 'bg-emerald-300',
  warn: 'bg-amber-300',
  error: 'bg-rose-300',
  info: 'bg-sky-300',
  neutral: 'bg-slate-400',
}

export function StatusPill({ tone = 'neutral', children }: { tone?: VisualTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${TONE_CLASS[tone]}`}>
      {children}
    </span>
  )
}

export function WeightBar({
  label,
  value,
  tone = 'info',
}: {
  label: string
  value: number
  tone?: VisualTone
}) {
  const safe = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
  return (
    <div>
      <div className="mb-1 flex justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#8a92a6]">
        <span>{label}</span>
        <span>{Math.round(safe)}%</span>
      </div>
      <div className="h-2 overflow-hidden bg-[#172033]">
        <div className={`h-full ${BAR_CLASS[tone]}`} style={{ width: `${safe}%` }} />
      </div>
    </div>
  )
}

export function MiniSparkline({ values, tone = 'info' }: { values: Array<number | null | undefined>; tone?: VisualTone }) {
  const numeric = values.map(Number).filter(Number.isFinite)
  const points = numeric.length ? numeric.slice(-8) : [0]
  const min = Math.min(...points)
  const max = Math.max(...points)
  const spread = max - min || 1
  const barClass = BAR_CLASS[tone]
  return (
    <div className="flex h-8 items-end gap-0.5">
      {points.map((value, index) => (
        <span
          key={`${index}-${value}`}
          className={`w-1.5 ${barClass}`}
          style={{ height: `${Math.max(15, ((value - min) / spread) * 85 + 15)}%` }}
        />
      ))}
    </div>
  )
}

export function DecisionPacketCell({
  title,
  value,
  detail,
  tone = 'neutral',
}: {
  title: string
  value: ReactNode
  detail?: ReactNode
  tone?: VisualTone
}) {
  return (
    <div className={`border p-2 ${TONE_CLASS[tone]}`}>
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] opacity-75">{title}</p>
      <div className="mt-1 text-sm font-semibold">{value}</div>
      {detail ? <div className="mt-1 text-[11px] leading-4 opacity-80">{detail}</div> : null}
    </div>
  )
}

export function ChartWorkbenchShell({
  kicker,
  title,
  meta,
  children,
}: {
  kicker: string
  title: string
  meta?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="overflow-hidden border border-[#263247] bg-[#0f151d]/96">
      <header className="grid gap-3 border-b border-[#263247] bg-[#070a10] p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-sky-300">{kicker}</p>
          <h2 className="mt-1 text-base font-semibold text-[#f2ead8]">{title}</h2>
        </div>
        {meta}
      </header>
      {children}
    </section>
  )
}
