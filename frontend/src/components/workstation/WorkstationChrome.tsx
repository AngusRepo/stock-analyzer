import type { ReactNode } from 'react'

export type WorkstationTone = 'ok' | 'warn' | 'error' | 'info' | 'neutral'

const toneClass: Record<WorkstationTone, string> = {
  ok: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  warn: 'border-[color:var(--sv-accent-border)] bg-[var(--sv-accent-soft)] text-[color:var(--sv-accent)]',
  error: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
  info: 'border-[#00d2ff]/30 bg-[#00d2ff]/10 text-[#a5e7ff]',
  neutral: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

export function WorkstationBackdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="absolute inset-0 opacity-60 bg-[linear-gradient(rgba(255,255,255,0.022)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.016)_1px,transparent_1px)] bg-[size:22px_22px]" />
      <div className="absolute left-[17%] top-[10%] hidden h-48 w-[20rem] rounded-[42%_58%_63%_37%/45%_38%_62%_55%] opacity-35 md:block" style={{ background: 'radial-gradient(circle at 42% 44%, var(--sv-accent-soft), transparent 72%)' }} />
      <div className="absolute right-[10%] top-[22%] hidden h-40 w-[22rem] rotate-12 rounded-[68%_32%_48%_52%/37%_58%_42%_63%] opacity-32 md:block" style={{ background: 'radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--sv-accent-2) 16%, transparent), transparent 74%)' }} />
      <div className="absolute left-[44%] bottom-[12%] hidden h-44 w-28 -rotate-12 rounded-[36%_64%_35%_65%/62%_34%_66%_38%] bg-[radial-gradient(circle_at_50%_45%,rgba(0,192,118,0.14),rgba(0,192,118,0.05)_50%,transparent_74%)] opacity-30 lg:block" />
    </div>
  )
}

export function WorkstationPill({ tone = 'neutral', children }: { tone?: WorkstationTone; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] shadow-[0_0_14px_var(--sv-accent-shadow)]', toneClass[tone])}>
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
    <section className={cx('sv-workstation-panel', className)}>
      <header className="sv-workstation-panel-header flex min-h-10 items-center justify-between px-3">
        <div className="min-w-0">
          {kicker && <p className="text-[10px] tracking-[0.2em] text-[color:var(--sv-text-muted)]">{kicker}</p>}
          <h2 className="truncate font-['Space_Grotesk'] text-[13px] font-semibold tracking-[0.08em] text-[color:var(--sv-title-text)]">{title}</h2>
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
      'group relative overflow-hidden rounded-xl border border-[color:var(--sv-panel-border)] bg-[var(--sv-panel)] p-3 shadow-[0_8px_26px_rgba(0,0,0,0.16),inset_0_1px_0_rgba(255,255,255,0.04)]',
      className,
    )}>
      <div className={cx(
        'absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100',
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
    <div className="sv-page-title flex flex-col gap-3 rounded-xl p-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--sv-accent)]">{kicker}</p>
        <h1 className="mt-1 font-['Space_Grotesk'] text-2xl font-semibold tracking-tight text-[color:var(--sv-title-text)]">{title}</h1>
        {description && <p className="mt-2 max-w-3xl text-xs leading-5 text-[color:var(--sv-text-soft)]">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function WorkstationMetricTile({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  tone?: WorkstationTone
}) {
  const valueColor = tone === 'ok'
    ? 'text-emerald-300'
    : tone === 'warn'
      ? 'text-[#ffd87f]'
      : tone === 'error'
        ? 'text-rose-300'
        : tone === 'info'
          ? 'text-[#a5e7ff]'
          : 'text-[#f2ead8]'

  return (
    <div className="sv-panel-deep min-h-[92px] rounded-xl border p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
      <div className="flex items-start justify-between gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--sv-text-muted)]">{label}</p>
        <WorkstationPill tone={tone}>{tone}</WorkstationPill>
      </div>
      <div className={`mt-2 font-['Space_Grotesk'] text-2xl font-semibold ${valueColor}`}>{value}</div>
      {detail && <div className="mt-2 text-xs leading-5 text-[color:var(--sv-text-muted)]">{detail}</div>}
    </div>
  )
}

export function WorkstationTickerStrip({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; tone?: WorkstationTone; detail?: ReactNode }>
}) {
  return (
    <div className="grid overflow-hidden rounded-xl border border-[color:var(--sv-panel-border)] bg-[var(--sv-panel-deep)] sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`} className="border-b border-[color:var(--sv-panel-border)] p-3 sm:border-r xl:border-b-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--sv-text-muted)]">{item.label}</p>
          <div className={cx(
            "mt-1 font-['Space_Grotesk'] text-lg font-semibold",
            item.tone === 'ok' ? 'text-emerald-300'
              : item.tone === 'warn' ? 'text-[#ffd87f]'
                : item.tone === 'error' ? 'text-rose-300'
                  : item.tone === 'info' ? 'text-[#a5e7ff]'
                    : 'text-[color:var(--sv-title-text)]',
          )}>
            {item.value}
          </div>
          {item.detail && <p className="mt-1 text-[11px] leading-4 text-[color:var(--sv-text-muted)]">{item.detail}</p>}
        </div>
      ))}
    </div>
  )
}

export function WorkstationFlow({
  steps,
}: {
  steps: Array<{ label: string; detail: string; tone?: WorkstationTone }>
}) {
  return (
    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
      {steps.map((step, index) => (
        <div key={step.label} className="relative rounded-xl border border-[color:var(--sv-panel-border)] bg-[var(--sv-panel-deep)] p-3">
          <div className="mb-3 flex items-start justify-between gap-2">
            <span className="grid h-6 w-6 place-items-center border border-[color:var(--sv-accent-border)] bg-[var(--sv-accent-soft)] font-mono text-[10px] text-[color:var(--sv-accent)]">{index + 1}</span>
            <WorkstationPill tone={step.tone ?? 'neutral'}>{step.tone ?? 'step'}</WorkstationPill>
          </div>
          <p className="text-sm font-semibold text-[color:var(--sv-title-text)]">{step.label}</p>
          <p className="mt-2 text-xs leading-5 text-[color:var(--sv-text-muted)]">{step.detail}</p>
        </div>
      ))}
    </div>
  )
}
