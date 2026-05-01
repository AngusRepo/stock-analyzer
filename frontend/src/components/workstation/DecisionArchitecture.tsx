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
          subtitle: '給朋友看的投資情報頁',
          body: '只回答今天市場與推薦重點，不暴露排程、模型治理、資料庫維運語言。',
          tone: 'info' as WorkstationTone,
        },
        {
          title: 'Bot',
          subtitle: '給你自己的交易控制台',
          body: '集中 pending buys、debate、quote sanity、持倉、T1/T2/Stop 與 execution audit。',
          tone: 'ok' as WorkstationTone,
        },
        {
          title: 'OBS',
          subtitle: '系統可靠度與 root cause',
          body: '只看症狀、影響、原因、下一步；細節再 drill down 到 Scheduler/DataQuality/ModelPool。',
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
          <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-emerald-200">上市上櫃交易池</p>
          <WorkstationPill tone="ok">tradable lane</WorkstationPill>
        </div>
        <p className="mt-2 text-xs leading-5 text-[#8a92a6]">
          會進入 morning setup、T2/debate、pending buys 與盤中 quote sanity。這一區才會影響自動交易。
        </p>
      </div>
      <div className="bg-[linear-gradient(135deg,#171006,#0b0d12)] p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-amber-200">興櫃研究池</p>
          <WorkstationPill tone="warn">research only</WorkstationPill>
        </div>
        <p className="mt-2 text-xs leading-5 text-[#8a92a6]">
          可做 ML / IC / calibration evidence，但硬 gate 不進 morning setup、不產生 pending buys、不自動交易。
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
            body: '只在需要查 run log、callback、交易日曆、duration anomaly 時進去。',
            tone: 'info' as WorkstationTone,
          },
          {
            href: '/data-quality',
            icon: ShieldCheck,
            title: 'Data Quality',
            body: '只在需要查 price/chip/features/schema/parity freshness 時進去。',
            tone: 'ok' as WorkstationTone,
          },
          {
            href: '/model-pool',
            icon: GitBranch,
            title: 'Model Pool',
            body: '只在需要查 lineage、IC、challenger、metadata、family balance 時進去。',
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
