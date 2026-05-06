import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Database, ExternalLink, RefreshCw } from 'lucide-react'
import AppShell from '@/components/AppShell'
import { dataQualityApi, type DataQualityCheck } from '@/lib/api'
import { queryTtl } from '@/lib/queryPolicy'
import {
  WorkstationPageTitle,
  WorkstationPanel,
  WorkstationPill,
  type WorkstationTone,
} from '@/components/workstation/WorkstationChrome'

function statusTone(status?: string): WorkstationTone {
  if (status === 'ok' || status === 'PASS') return 'ok'
  if (status === 'warn' || status === 'WARN') return 'warn'
  if (status === 'fail' || status === 'BLOCK') return 'error'
  return 'neutral'
}

function scoreFromChecks(checks: DataQualityCheck[]) {
  if (!checks.length) return 0
  const score = checks.reduce((sum, check) => sum + (check.status === 'ok' ? 1 : check.status === 'warn' ? 0.5 : 0), 0)
  return Math.round((score / checks.length) * 100)
}

function metricSummary(check: DataQualityCheck): string {
  if (!check.metrics) return 'no metrics'
  return Object.entries(check.metrics)
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${typeof value === 'number' ? Number(value.toFixed(4)) : String(value)}`)
    .join(' / ')
}

function MiniBar({ tone, value }: { tone: WorkstationTone; value: number }) {
  const color = tone === 'ok' ? '#34d399' : tone === 'warn' ? '#fbbf24' : tone === 'error' ? '#fb7185' : '#94a3b8'
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
      <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, value))}%`, backgroundColor: color }} />
    </div>
  )
}

function DataQualityMetric({ label, value, tone, detail }: { label: string; value: string; tone: WorkstationTone; detail: string }) {
  return (
    <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">{label}</p>
        <WorkstationPill tone={tone}>{tone}</WorkstationPill>
      </div>
      <p className={`mt-2 font-mono text-2xl font-semibold ${tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'error' ? 'text-rose-300' : 'text-slate-200'}`}>
        {value}
      </p>
      <MiniBar tone={tone} value={tone === 'error' ? 100 : tone === 'warn' ? 62 : 92} />
      <p className="mt-2 truncate text-xs text-slate-500">{detail}</p>
    </div>
  )
}

function CheckRow({ check }: { check: DataQualityCheck }) {
  const tone = statusTone(check.status)
  return (
    <div className={`grid gap-3 border-b p-3 text-xs last:border-0 lg:grid-cols-[0.8fr_1fr_0.8fr_auto] ${
      check.status === 'fail' ? 'border-rose-500/25 bg-rose-950/15'
        : check.status === 'warn' ? 'border-amber-500/25 bg-amber-950/10'
          : 'border-[#263247] bg-[#05070c]'
    }`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <WorkstationPill tone={tone}>{check.status}</WorkstationPill>
          <p className="truncate text-sm font-semibold text-slate-100">{check.label}</p>
        </div>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-500">{check.id}</p>
        <MiniBar tone={tone} value={check.status === 'ok' ? 96 : check.status === 'warn' ? 62 : 100} />
      </div>
      <p className="line-clamp-2 leading-5 text-slate-400">{check.summary}</p>
      <p className="font-mono text-[10px] leading-5 text-slate-500">{metricSummary(check)}</p>
      <a href={`/data-quality?focus=${check.id}`} className="inline-flex items-start justify-end gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-200 hover:text-emerald-100">
        Inspect <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  )
}

export default function DataQualityPage() {
  const quality = useQuery({
    queryKey: ['data-quality', 'drilldown'],
    queryFn: () => dataQualityApi.status(),
    staleTime: queryTtl.realtime,
  })

  const report = quality.data
  const checks = report?.checks ?? []
  const gaps = useMemo(() => checks.filter((check) => check.status !== 'ok'), [checks])
  const okCount = checks.filter((check) => check.status === 'ok').length
  const warnCount = checks.filter((check) => check.status === 'warn').length
  const failCount = checks.filter((check) => check.status === 'fail').length
  const trustScore = scoreFromChecks(checks)

  return (
    <AppShell>
      <div className="space-y-4 p-4 lg:p-5">
        <WorkstationPageTitle
          kicker="Data Quality"
          title="Data Quality Drilldown / 資料品質"
          description="專注 freshness、schema、train/serve parity；OBS 看總覽，這頁看每一個檢查項目的證據。"
          action={
            <div className="flex flex-wrap gap-2">
              <a href="/obs" className="inline-flex items-center gap-1 rounded-full border border-[#d6a85f]/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#f1c16f]">
                OBS <ExternalLink className="h-3 w-3" />
              </a>
              <button
                type="button"
                onClick={() => void quality.refetch()}
                className="inline-flex items-center gap-1 rounded-full border border-[#d6a85f]/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#f1c16f]"
              >
                <RefreshCw className={`h-3 w-3 ${quality.isFetching ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
          }
        />

        {quality.error && (
          <div className="border border-rose-400/30 bg-rose-400/[0.05] p-3 text-sm text-rose-200">
            Data Quality API 載入失敗：{(quality.error as Error).message}
          </div>
        )}

        <section className="grid gap-3 md:grid-cols-4">
          <DataQualityMetric label="Trust Score" value={`${trustScore}%`} tone={failCount ? 'error' : warnCount ? 'warn' : 'ok'} detail={`date ${report?.date ?? '-'}`} />
          <DataQualityMetric label="Checks" value={String(checks.length)} tone={failCount ? 'error' : warnCount ? 'warn' : 'ok'} detail={`ok ${okCount} / warn ${warnCount} / fail ${failCount}`} />
          <DataQualityMetric label="Actionable Gaps" value={String(gaps.length)} tone={gaps.length ? 'warn' : 'ok'} detail={gaps.length ? 'fail/warn first' : 'no active gap'} />
          <DataQualityMetric label="Generated" value={report?.generated_at ? report.generated_at.slice(11, 16) : '-'} tone="info" detail={report?.generated_at ?? 'not generated'} />
        </section>

        <WorkstationPanel title="Actionable Data Gaps / 可處理缺口" kicker="fail and warn first">
          <div className="overflow-hidden">
            {gaps.length > 0 ? (
              gaps.map((check) => <CheckRow key={check.id} check={check} />)
            ) : (
              <div className="flex items-center gap-2 p-4 text-sm text-emerald-300">
                <CheckCircle2 className="h-4 w-4" /> 沒有 fail/warn data quality 缺口。
              </div>
            )}
          </div>
        </WorkstationPanel>

        <WorkstationPanel title="All Checks / 全部檢查" kicker="freshness, schema, parity">
          <div className="overflow-hidden">
            {checks.map((check) => <CheckRow key={check.id} check={check} />)}
            {!checks.length && (
              <div className="flex items-center gap-2 p-4 text-sm text-amber-200">
                <AlertTriangle className="h-4 w-4" /> 尚未取得 Data Quality checks。
              </div>
            )}
          </div>
        </WorkstationPanel>
      </div>
    </AppShell>
  )
}
