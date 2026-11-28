import type { ReactNode } from 'react'
import { WorkstationStatusPill, WorkstationToneIcon, type WorkstationTone } from './WorkstationChrome'

export type ApprovalReviewMetric = {
  label: string
  candidate?: ReactNode
  champion?: ReactNode
  delta?: ReactNode
  value?: ReactNode
  detail?: ReactNode
  tone?: WorkstationTone
}

export type ApprovalReviewGate = {
  label: string
  status: 'pass' | 'warn' | 'fail' | 'missing' | 'info'
  detail?: ReactNode
}

export type ApprovalReviewImpact = {
  label: string
  value: ReactNode
  detail?: ReactNode
  tone?: WorkstationTone
}

function gateTone(status: ApprovalReviewGate['status']): WorkstationTone {
  if (status === 'pass') return 'ok'
  if (status === 'fail' || status === 'missing') return 'error'
  if (status === 'warn') return 'warn'
  return 'info'
}

function gateLabel(status: ApprovalReviewGate['status']) {
  if (status === 'pass') return '通過'
  if (status === 'fail') return '未通過'
  if (status === 'missing') return '缺資料'
  if (status === 'warn') return '注意'
  return '資訊'
}

export function ApprovalReviewPanel({
  title,
  kicker = 'manual approval review',
  status,
  statusTone = 'warn',
  candidate,
  champion,
  summary,
  metrics,
  gates,
  impacts,
  blockers = [],
  nextAction,
  actions,
}: {
  title: string
  kicker?: string
  status: ReactNode
  statusTone?: WorkstationTone
  candidate?: ReactNode
  champion?: ReactNode
  summary?: ReactNode
  metrics?: ApprovalReviewMetric[]
  gates?: ApprovalReviewGate[]
  impacts?: ApprovalReviewImpact[]
  blockers?: ReactNode[]
  nextAction?: ReactNode
  actions?: ReactNode
}) {
  const metricRows = metrics ?? []
  const gateRows = gates ?? []
  const impactRows = impacts ?? []

  return (
    <div className="overflow-hidden border-t border-border">
      <div className="border-b border-[#263247] bg-[#08111a] px-3 py-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="sv-num text-[11px] normal-case text-[#8a9ab0]">{kicker}</p>
            <p className="mt-1 text-sm font-semibold text-[#f2ead8]">{title}</p>
          </div>
          <WorkstationStatusPill tone={statusTone}>{status}</WorkstationStatusPill>
        </div>
        {summary && <p className="mt-2 text-xs leading-5 text-[#a7b4c7]">{summary}</p>}
      </div>

      {(candidate || champion) && (
        <div className="grid gap-px bg-[#263247] md:grid-cols-2">
          <div className="bg-[#070a10] p-3">
            <p className="sv-num text-[11px] normal-case text-[#8a9ab0]">Candidate / 這次要批准</p>
            <div className="mt-2 text-xs leading-5 text-slate-200">{candidate ?? '-'}</div>
          </div>
          <div className="bg-[#070a10] p-3">
            <p className="sv-num text-[11px] normal-case text-[#8a9ab0]">Current / 現行基準</p>
            <div className="mt-2 text-xs leading-5 text-slate-200">{champion ?? '-'}</div>
          </div>
        </div>
      )}

      {metricRows.length > 0 && (
        <div className="border-t border-[#263247] p-3">
          <p className="sv-num text-[11px] normal-case text-[#8a9ab0]">數據比較</p>
          <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {metricRows.map((metric) => (
              <div key={metric.label} className="border-l-2 border-border p-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="sv-num text-[11px] normal-case text-[#8a9ab0]">{metric.label}</p>
                  {metric.tone && <WorkstationStatusPill tone={metric.tone} />}
                </div>
                {metric.value != null ? (
                  <div className="mt-2 sv-num text-lg text-[#fff1cf]">{metric.value}</div>
                ) : (
                  <div className="mt-2 grid grid-cols-3 gap-2 break-all sv-num text-[12px]">
                    <div>
                      <p className="text-[#657489]">候選</p>
                      <p className="mt-1 text-slate-100">{metric.candidate ?? '-'}</p>
                    </div>
                    <div>
                      <p className="text-[#657489]">現行</p>
                      <p className="mt-1 text-slate-100">{metric.champion ?? '-'}</p>
                    </div>
                    <div>
                      <p className="text-[#657489]">差值</p>
                      <p className="mt-1 text-slate-100">{metric.delta ?? '-'}</p>
                    </div>
                  </div>
                )}
                {metric.detail && <p className="mt-2 text-[11px] leading-4 text-[#8a9ab0]">{metric.detail}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {gateRows.length > 0 && (
        <div className="border-t border-[#263247] p-3">
          <p className="sv-num text-[11px] normal-case text-[#8a9ab0]">Promotion gate checklist</p>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {gateRows.map((gate) => (
              <div key={gate.label} className="flex items-start justify-between gap-3 border-l-2 border-border p-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-100">{gate.label}</p>
                  {gate.detail && <p className="mt-1 text-[11px] leading-4 text-[#8a9ab0]">{gate.detail}</p>}
                </div>
                <WorkstationStatusPill tone={gateTone(gate.status)}>{gateLabel(gate.status)}</WorkstationStatusPill>
              </div>
            ))}
          </div>
        </div>
      )}

      {impactRows.length > 0 && (
        <div className="border-t border-[#263247] p-3">
          <p className="sv-num text-[11px] normal-case text-[#8a9ab0]">批准後影響範圍</p>
          <div className="mt-2 grid gap-2 md:grid-cols-3">
            {impactRows.map((impact) => (
              <div key={impact.label} className="border-l-2 border-border p-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="sv-num text-[11px] normal-case text-[#8a9ab0]">{impact.label}</p>
                  {impact.tone && <WorkstationStatusPill tone={impact.tone} />}
                </div>
                <div className="mt-2 text-xs font-semibold text-slate-100">{impact.value}</div>
                {impact.detail && <p className="mt-1 text-[11px] leading-4 text-[#8a9ab0]">{impact.detail}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {(blockers.length > 0 || nextAction || actions) && (
        <div className="border-t border-[#263247] bg-[#071019] p-3">
          {blockers.length > 0 && (
            <div className="mb-3 border-l-2 border-warn p-2 text-xs leading-5 text-foreground">
              <span className="inline-flex items-center gap-1 font-semibold text-warn"><WorkstationToneIcon tone="warn" />Blockers / 注意事項</span>
              {/* 一項一列：同一行串接的 inline span 換行時框會互相疊住。 */}
              <ul className="mt-1 space-y-0.5 break-words">{blockers.map((item, index) => <li key={index}>{item}</li>)}</ul>
            </div>
          )}
          {nextAction && <p className="mb-3 text-xs leading-5 text-[#a7b4c7]">next: {nextAction}</p>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
    </div>
  )
}
