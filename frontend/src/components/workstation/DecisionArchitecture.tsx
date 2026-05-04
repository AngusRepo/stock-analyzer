import type { ReactNode } from 'react'
import { ArrowRight, GitBranch, ShieldCheck, Workflow } from 'lucide-react'
import { WorkstationPanel, WorkstationPill, type WorkstationTone } from './WorkstationChrome'

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

export type TraceStep = {
  label: string
  detail: string
  tone?: WorkstationTone
}

export function DecisionTraceRail({
  title = 'Decision Trace',
  steps,
  compact = false,
}: {
  title?: string
  steps: TraceStep[]
  compact?: boolean
}) {
  return (
    <WorkstationPanel title={title} kicker="signal to action lineage">
      <div className={cx('grid gap-px bg-[#263247]', compact ? 'md:grid-cols-4' : 'md:grid-cols-6')}>
        {steps.map((step, index) => (
          <div key={`${step.label}-${index}`} className="bg-[#070a10] p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center border border-[#263247] bg-[#0b1220] font-mono text-[10px] text-amber-200">
                  {index + 1}
                </span>
                <p className="font-mono text-[11px] uppercase tracking-[0.13em] text-slate-100">{step.label}</p>
              </div>
              {index < steps.length - 1 && <ArrowRight className="hidden h-3.5 w-3.5 text-[#5e6a82] md:block" />}
            </div>
            <p className="mt-2 text-xs leading-5 text-[#8a92a6]">{step.detail}</p>
            <div className="mt-3">
              <WorkstationPill tone={step.tone ?? 'neutral'}>{step.tone ?? 'watch'}</WorkstationPill>
            </div>
          </div>
        ))}
      </div>
    </WorkstationPanel>
  )
}

export function AudienceRoleStrip() {
  return (
    <div className="grid gap-px border border-[#263247] bg-[#263247] md:grid-cols-3">
      {[
        {
          title: 'Dashboard',
          subtitle: 'friend-facing',
          body: '給一般朋友看的市場摘要：重點是可讀、少術語、快速知道今天系統看見什麼機會。',
          tone: 'info' as WorkstationTone,
        },
        {
          title: 'Bot',
          subtitle: 'admin execution',
          body: '給你自己操作：pending buys、debate、quote sanity、T1/T2/Stop 與 execution audit 必須可追溯。',
          tone: 'ok' as WorkstationTone,
        },
        {
          title: 'OBS',
          subtitle: 'root cause center',
          body: '回答哪裡壞、為什麼壞、影響哪些股票與哪個 run_id，而不是再多一張漂亮但無法診斷的儀表板。',
          tone: 'warn' as WorkstationTone,
        },
      ].map((item) => (
        <div key={item.title} className="bg-[#070a10] p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-[#fff1cf]">{item.title}</p>
            <WorkstationPill tone={item.tone}>{item.subtitle}</WorkstationPill>
          </div>
          <p className="mt-3 text-xs leading-5 text-[#8a92a6]">{item.body}</p>
        </div>
      ))}
    </div>
  )
}

export function RecommendationLaneExplainer() {
  return (
    <div className="grid gap-px overflow-hidden border border-[#263247] bg-[#263247] md:grid-cols-2">
      <div className="bg-[linear-gradient(135deg,#06140f,#071019)] p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-emerald-200">上市上櫃交易流</p>
          <WorkstationPill tone="ok">tradable lane</WorkstationPill>
        </div>
        <p className="mt-2 text-xs leading-5 text-[#8a92a6]">
          會進入 morning setup、T2/debate、pending buys 與盤中 quote sanity，這一區才會影響自動交易。
        </p>
      </div>
      <div className="bg-[linear-gradient(135deg,#171006,#0b0d12)] p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-amber-200">興櫃研究流</p>
          <WorkstationPill tone="warn">research only</WorkstationPill>
        </div>
        <p className="mt-2 text-xs leading-5 text-[#8a92a6]">
          可做 ML、IC、校準與研究觀察，但硬 gate 不進 morning setup、不產生 pending buys、不自動交易。
        </p>
      </div>
    </div>
  )
}

export function ObsDrilldownMap() {
  return (
    <WorkstationPanel title="OBS Drilldown Map" kicker="summary here, raw detail elsewhere">
      <div className="grid gap-px bg-[#263247] md:grid-cols-3">
        {[
          {
            href: '/scheduler',
            icon: Workflow,
            title: 'Scheduler',
            body: '檢查 run log、callback、duration anomaly 與觸發順序。',
            tone: 'info' as WorkstationTone,
          },
          {
            href: '/data-quality',
            icon: ShieldCheck,
            title: 'Data Quality',
            body: '檢查 price、chip、features、schema、parity 與 freshness。',
            tone: 'ok' as WorkstationTone,
          },
          {
            href: '/model-pool',
            icon: GitBranch,
            title: 'Model Pool',
            body: '檢查 lineage、IC、challenger、metadata 與 family balance。',
            tone: 'warn' as WorkstationTone,
          },
        ].map((item) => {
          const Icon = item.icon
          return (
            <a key={item.href} href={item.href} className="group block bg-[#070a10] p-4 transition-colors hover:bg-[#0c1420]">
              <div className="flex items-start justify-between gap-3">
                <Icon className="h-5 w-5 text-sky-300" />
                <WorkstationPill tone={item.tone}>open</WorkstationPill>
              </div>
              <p className="mt-3 font-mono text-[12px] uppercase tracking-[0.14em] text-slate-100 group-hover:text-[#fff1cf]">{item.title}</p>
              <p className="mt-2 text-xs leading-5 text-[#8a92a6]">{item.body}</p>
            </a>
          )
        })}
      </div>
    </WorkstationPanel>
  )
}

export function SignalInsightCard({
  title,
  value,
  detail,
  tone = 'neutral',
  children,
}: {
  title: string
  value: string
  detail?: string
  tone?: WorkstationTone
  children?: ReactNode
}) {
  return (
    <div className="border border-[#263247] bg-[#070a10] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#8a92a6]">{title}</p>
          <p className="mt-2 font-mono text-2xl font-semibold text-[#fff1cf]">{value}</p>
        </div>
        <WorkstationPill tone={tone}>{tone}</WorkstationPill>
      </div>
      {detail && <p className="mt-2 text-xs leading-5 text-[#8a92a6]">{detail}</p>}
      {children}
    </div>
  )
}
