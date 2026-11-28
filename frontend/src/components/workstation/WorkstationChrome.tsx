import type { ReactNode } from 'react'
import { StatusIcon } from '@/components/ui/status'

export type WorkstationTone = 'ok' | 'warn' | 'error' | 'info' | 'neutral'

const toneClass: Record<WorkstationTone, string> = {
  ok: 'border-ok/30 bg-ok/10 text-ok',
  warn: 'border-warn/35 bg-warn/10 text-warn',
  error: 'border-fail/35 bg-fail/10 text-fail',
  info: 'border-[#00d2ff]/30 bg-[#00d2ff]/10 text-[#a5e7ff]',
  neutral: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

export function WorkstationBackdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="absolute inset-0 opacity-55 bg-[linear-gradient(rgba(255,255,255,0.024)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.018)_1px,transparent_1px)] bg-[size:24px_24px]" />
      <div className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(240,195,101,0.28),transparent)]" />
    </div>
  )
}

const TONE_LABEL: Record<WorkstationTone, string> = { ok: '正常', warn: '注意', error: '異常', info: '資訊', neutral: '—' }

/** 把 ok／warn／error 這類英文 tone 換成畫面可讀的中文短名。 */
export function workstationToneLabel(tone: WorkstationTone): string {
  return TONE_LABEL[tone]
}

/** 狀態 tone 的圖示（ok／warn／error）；info／neutral 不畫。 */
export function WorkstationToneIcon({ tone, size = 10 }: { tone: WorkstationTone; size?: number }) {
  if (tone === 'neutral' || tone === 'info') return null
  return <StatusIcon tone={tone === 'error' ? 'fail' : tone} size={size} title={TONE_LABEL[tone]} />
}

/** 狀態徽章：圖示＋中文短名，原始 tone 放 title。 */
export function WorkstationStatusPill({ tone, children }: { tone: WorkstationTone; children?: ReactNode }) {
  return (
    <span title={tone} className={cx('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]', toneClass[tone])}>
      <WorkstationToneIcon tone={tone} />
      {children ?? TONE_LABEL[tone]}
    </span>
  )
}

export function WorkstationPill({ tone = 'neutral', children }: { tone?: WorkstationTone; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center rounded-full border px-2.5 py-1 sv-num text-[11px] normal-case shadow-[0_0_14px_rgba(240,185,11,0.05)]', toneClass[tone])}>
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
    // One frame per section: flat card surface, plain header (no warm gold gradient). Children must not add a second card frame.
    <section className={cx('overflow-hidden rounded-lg border border-border bg-card', className)}>
      <header className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-4 py-2">
        <div className="min-w-0">
          {kicker && <p className="text-[11px] text-muted-foreground">{kicker}</p>}
          <h2 className="break-words text-[15px] font-semibold text-foreground">{title}</h2>
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
      'group relative overflow-hidden rounded-xl border border-[#2b3a49] bg-[#0f151d]/94 p-3 shadow-[0_8px_26px_rgba(0,0,0,0.16),inset_0_1px_0_rgba(255,255,255,0.04)]',
      className,
    )}>
      <div className={cx(
        'absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100',
        tone === 'ok' && 'bg-ok/10',
        tone === 'warn' && 'bg-warn/10',
        tone === 'error' && 'bg-fail/10',
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
    <div className="flex flex-col gap-3 rounded-2xl border border-[#2b3a49] bg-[linear-gradient(120deg,#171714,#111821_54%,#0b1118)] p-5 shadow-[0_10px_30px_rgba(0,0,0,0.17),inset_0_1px_0_rgba(240,185,11,0.08)] lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="text-[11px] font-semibold normal-case text-[#d6a85f]">{kicker}</p>
        <h1 className="mt-1 font-['Space_Grotesk'] text-3xl font-semibold text-[#f2ead8]">{title}</h1>
        {description && <p className="mt-2 max-w-3xl text-sm leading-6 text-[#a8b6c5]">{description}</p>}
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
    ? 'text-ok'
    : tone === 'warn'
      ? 'text-warn'
      : tone === 'error'
        ? 'text-fail'
        : tone === 'info'
          ? 'text-[#a5e7ff]'
          : 'text-[#f2ead8]'

  return (
    <div className="min-h-[92px] rounded-xl border border-[#2b3a49] bg-[#070a10]/78 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
      <div className="flex items-start justify-between gap-3">
        <p className="sv-num text-[11px] normal-case text-[#7f8ba0]">{label}</p>
        {tone !== 'neutral' && tone !== 'info' && <StatusIcon tone={tone === 'error' ? 'fail' : tone} size={12} />}
      </div>
      <div className={`mt-2 font-['Space_Grotesk'] text-2xl font-semibold ${valueColor}`}>{value}</div>
      {detail && <div className="mt-2 text-xs leading-5 text-[#8b9bab]">{detail}</div>}
    </div>
  )
}

export function WorkstationTickerStrip({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; tone?: WorkstationTone; detail?: ReactNode }>
}) {
  return (
    <div className="grid overflow-hidden rounded-xl border border-[#2b3a49] bg-[#070a10] sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`} className="border-b border-[#2b3a49] p-3 sm:border-r xl:border-b-0">
          <p className="sv-num text-[11px] normal-case text-[#7f8ba0]">{item.label}</p>
          <div className={cx(
            "mt-1 font-['Space_Grotesk'] text-lg font-semibold",
            item.tone === 'ok' ? 'text-ok'
              : item.tone === 'warn' ? 'text-warn'
                : item.tone === 'error' ? 'text-fail'
                  : item.tone === 'info' ? 'text-[#a5e7ff]'
                    : 'text-[#f2ead8]',
          )}>
            {item.value}
          </div>
          {item.detail && <p className="mt-1 text-[11px] leading-4 text-[#8b9bab]">{item.detail}</p>}
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
        <div key={step.label} className="relative rounded-xl border border-[#2b3a49] bg-[#070a10]/80 p-3">
          <div className="mb-3 flex items-start justify-between gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg border border-[#3a3125] bg-[#171714] sv-num text-[11px] text-[#ffd87f]">{index + 1}</span>
            {step.tone && step.tone !== 'neutral' && step.tone !== 'info' && <StatusIcon tone={step.tone === 'error' ? 'fail' : step.tone} size={12} />}
          </div>
          <p className="text-sm font-semibold text-[#f2ead8]">{step.label}</p>
          <p className="mt-2 text-xs leading-5 text-[#8b9bab]">{step.detail}</p>
        </div>
      ))}
    </div>
  )
}
