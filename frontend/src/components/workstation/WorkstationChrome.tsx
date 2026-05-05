import type { ReactNode } from 'react'

export type WorkstationTone = 'ok' | 'warn' | 'error' | 'info' | 'neutral'

const toneClass: Record<WorkstationTone, string> = {
  ok: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  warn: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  error: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
  info: 'border-sky-400/30 bg-sky-400/10 text-sky-300',
  neutral: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

export function WorkstationBackdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <style>
        {`
          @keyframes sv-orbit-soft {
            0%, 100% { transform: translate3d(0, 0, 0) rotate(-8deg) scale(1); }
            33% { transform: translate3d(26px, -18px, 0) rotate(6deg) scale(1.08); }
            66% { transform: translate3d(-20px, 22px, 0) rotate(12deg) scale(.96); }
          }
          @keyframes sv-orbit-slow {
            0%, 100% { transform: translate3d(0, 0, 0) rotate(10deg) scale(1); }
            40% { transform: translate3d(-32px, 16px, 0) rotate(-4deg) scale(1.12); }
            75% { transform: translate3d(14px, -26px, 0) rotate(-14deg) scale(.94); }
          }
          @keyframes sv-sparkle {
            0%, 100% { opacity: .18; transform: translateY(0) scale(.9); }
            50% { opacity: .72; transform: translateY(-9px) scale(1.12); }
          }
        `}
      </style>
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.032)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.024)_1px,transparent_1px)] bg-[size:18px_18px]" />
      <div className="absolute left-[17%] top-[10%] h-52 w-[22rem] rounded-[42%_58%_63%_37%/45%_38%_62%_55%] bg-slate-300/10 opacity-70 blur-3xl mix-blend-screen" style={{ animation: 'sv-orbit-soft 10s ease-in-out infinite' }} />
      <div className="absolute right-[10%] top-[22%] h-44 w-[25rem] rotate-12 rounded-[68%_32%_48%_52%/37%_58%_42%_63%] bg-sky-300/10 opacity-65 blur-3xl mix-blend-screen" style={{ animation: 'sv-orbit-slow 13s ease-in-out infinite' }} />
      <div className="absolute left-[44%] bottom-[12%] h-52 w-32 -rotate-12 rounded-[36%_64%_35%_65%/62%_34%_66%_38%] bg-rose-300/10 opacity-60 blur-3xl mix-blend-screen" style={{ animation: 'sv-orbit-soft 15s ease-in-out infinite reverse' }} />
      {[
        ['18%', '14%', '#7aa2c7', '0s'],
        ['58%', '20%', '#4cc9ff', '1.1s'],
        ['77%', '44%', '#ff6b8a', '1.7s'],
        ['67%', '72%', '#7aa2c7', '2.2s'],
      ].map(([left, top, color, delay]) => (
        <span
          key={`${left}-${top}`}
          className="absolute h-1.5 w-1.5 rounded-full opacity-70 mix-blend-screen shadow-[0_0_18px_currentColor]"
          style={{ left, top, color, animation: `sv-sparkle 3.2s ease-in-out ${delay} infinite` }}
        />
      ))}
    </div>
  )
}

export function WorkstationPill({ tone = 'neutral', children }: { tone?: WorkstationTone; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]', toneClass[tone])}>
      {children}
    </span>
  )
}

export function WorkstationPanel({
  title,
  kicker,
  children,
  className,
  action,
}: {
  title: string
  kicker?: string
  children: ReactNode
  className?: string
  action?: ReactNode
}) {
  return (
    <section className={cx('overflow-hidden rounded-2xl border border-[#2b3a49] bg-[#111821]/90 shadow-[0_14px_50px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.04)]', className)}>
      <header className="flex min-h-10 items-center justify-between border-b border-[#2b3a49] bg-[linear-gradient(90deg,#17202b,#111821_58%,#0d1722)] px-3">
        <div className="min-w-0">
          {kicker && <p className="text-[10px] tracking-[0.18em] text-[#8b9bab]">{kicker}</p>}
          <h2 className="truncate text-[12px] font-semibold tracking-[0.08em] text-[#e6edf3]">{title}</h2>
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

export function WorkstationCatCard({
  src,
  title,
  caption,
  tone = 'neutral',
  className,
}: {
  src: string
  title: string
  caption: string
  tone?: WorkstationTone
  className?: string
}) {
  return (
    <div className={cx(
      'group relative overflow-hidden rounded-2xl border border-[#2b3a49] bg-[#111821]/88 p-3 shadow-[0_14px_50px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.04)]',
      className,
    )}>
      <div className={cx(
        'absolute inset-0 opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100',
        tone === 'ok' && 'bg-emerald-400/10',
        tone === 'warn' && 'bg-amber-400/10',
        tone === 'error' && 'bg-rose-400/10',
        tone === 'info' && 'bg-sky-400/10',
        tone === 'neutral' && 'bg-slate-400/10',
      )} />
      <div className="relative flex items-center gap-3">
        <div className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-black/25 shadow-[0_12px_40px_rgba(0,0,0,0.35)] sm:h-24 sm:w-24">
          <img
            src={src}
            alt={title}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            loading="lazy"
          />
        </div>
        <div className="min-w-0">
          <WorkstationPill tone={tone}>{title}</WorkstationPill>
          <p className="mt-2 text-xs leading-5 text-slate-400">{caption}</p>
        </div>
      </div>
    </div>
  )
}

export function WorkstationPageTitle({
  kicker,
  title,
  description,
  action,
}: {
  kicker: string
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[#2b3a49] bg-[linear-gradient(90deg,#17202b,#111821_58%,#0d1722)] p-4 shadow-[0_18px_70px_rgba(0,0,0,0.18)] lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7aa2c7]">{kicker}</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-[#e6edf3]">{title}</h1>
        {description && <p className="mt-2 max-w-3xl text-xs leading-5 text-[#a8b6c5]">{description}</p>}
      </div>
      {action}
    </div>
  )
}
