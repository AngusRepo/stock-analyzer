import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Database, ExternalLink, RefreshCw } from 'lucide-react'
import AppShell from '@/components/AppShell'
import { dataQualityApi, type DataQualityCheck, type V41DataRuntimeStatus } from '@/lib/api'
import { queryTtl } from '@/lib/queryPolicy'
import DataQualityTrendChart from '@/components/charts/DataQualityTrendChart'
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

function DataRuntimeSourcePanel({ runtime }: { runtime?: V41DataRuntimeStatus }) {
  type SourcePanelRow = NonNullable<V41DataRuntimeStatus['source_coverage']>[number]
  const coverageRows = runtime?.source_coverage ?? []
  const canonical = runtime?.canonical_rows
  const legacyRows = runtime?.source_quality_metrics ?? []
  const sources = ['ptt', 'anue', 'd1_news', 'finlab', 'official_rss', 'company_ir_rss', 'gdelt_events']
  const fallbackRows: SourcePanelRow[] = legacyRows.map((row) => ({
    source: row.source,
    role: row.dataset,
    rows: row.latest_materialization ? 1 : 0,
    freshness_status: row.freshness_status,
    missing_rate: row.missing_rate,
    duplicate_rate: row.duplicate_rate,
    entity_link_confidence: row.entity_link_confidence,
    latest_materialization: row.latest_materialization,
    decision_effect: 'quality_metric_only',
    runtime_state: row.latest_materialization ? 'production' : 'missing',
  }))
  const sourceCounts = new Map<string, SourcePanelRow>(
    coverageRows.length
      ? coverageRows.map((row) => [row.source, row])
      : fallbackRows.map((row) => [row.source, row]),
  )

  return (
    <WorkstationPanel title="FinLab Dagster Data Quality" kicker="source coverage, freshness, missing, duplicate, schema drift">
      <div className="grid gap-px bg-[#263247] lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="grid gap-px bg-[#263247] md:grid-cols-2 xl:grid-cols-4">
          {sources.map((source) => {
            const row = sourceCounts.get(source)
            const missing = row ? Math.round(row.missing_rate * 100) : 100
            const duplicate = row ? Math.round(row.duplicate_rate * 100) : 0
            const tone: WorkstationTone = !row || row.runtime_state === 'missing' ? 'warn' : missing < 20 ? 'ok' : 'warn'
            return (
              <div key={source} className="bg-[#05070c] p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-100">{source}</p>
                  <WorkstationPill tone={tone}>{row?.freshness_status ?? 'missing'}</WorkstationPill>
                </div>
                <MiniBar tone={tone} value={row ? Math.max(0, 100 - missing) : 0} />
                <p className="mt-2 text-[10px] leading-4 text-slate-500">
                  rows {row?.rows ?? 0} / missing {missing}% / dup {duplicate}%
                </p>
                <p className="mt-1 truncate text-[10px] text-slate-600">{row?.role ?? 'not wired'} / {row?.decision_effect ?? 'no effect'}</p>
                <p className="mt-1 truncate text-[10px] text-slate-600">{row?.latest_materialization ?? 'no materialization'}</p>
              </div>
            )
          })}
        </div>
        <aside className="grid gap-2 bg-[#070a10] p-3 text-xs">
          <DataQualityMetric label="Theme Signals" value={String(runtime?.theme_signals?.total ?? 0)} tone={(runtime?.theme_signals?.total ?? 0) > 0 ? 'ok' : 'warn'} detail={`${runtime?.theme_signals?.sources ?? 0} sources`} />
          <DataQualityMetric label="Canonical Rows" value={String((canonical?.market_daily ?? 0) + (canonical?.chip_daily ?? 0) + (canonical?.revenue_monthly ?? 0))} tone={(canonical?.market_daily ?? 0) > 0 ? 'ok' : 'warn'} detail={`price ${canonical?.market_daily ?? 0} / chip ${canonical?.chip_daily ?? 0} / revenue ${canonical?.revenue_monthly ?? 0}`} />
          <DataQualityMetric label="Gap Fill" value={String(runtime?.gap_fill_candidates?.total ?? 0)} tone={(runtime?.gap_fill_candidates?.quarantined ?? 0) > 0 ? 'warn' : 'info'} detail={`candidate ${runtime?.gap_fill_candidates?.candidates ?? 0} / quarantine ${runtime?.gap_fill_candidates?.quarantined ?? 0}`} />
        </aside>
      </div>
    </WorkstationPanel>
  )
}

function CheckRow({ check, focused }: { check: DataQualityCheck; focused?: boolean }) {
  const tone = statusTone(check.status)
  return (
    <div id={`dq-${check.id}`} className={`scroll-mt-24 grid gap-3 border-b p-3 text-xs last:border-0 lg:grid-cols-[0.8fr_1fr_0.8fr_auto] ${
      focused ? 'ring-1 ring-amber-300/60 ' : ''
    }${
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
  const runtime = useQuery({
    queryKey: ['data-quality', 'v4-1-runtime'],
    queryFn: () => dataQualityApi.v41RuntimeStatus(),
    staleTime: queryTtl.realtime,
  })

  const report = quality.data
  const checks = report?.checks ?? []
  const focusId = useMemo(() => {
    const raw = new URLSearchParams(window.location.search).get('focus')
    if (raw === 'price_data') return 'price_freshness'
    return raw ?? ''
  }, [])
  const gaps = useMemo(() => checks.filter((check) => check.status !== 'ok'), [checks])
  const okCount = checks.filter((check) => check.status === 'ok').length
  const warnCount = checks.filter((check) => check.status === 'warn').length
  const failCount = checks.filter((check) => check.status === 'fail').length
  const trustScore = scoreFromChecks(checks)
  const reportTone: WorkstationTone = !checks.length ? 'neutral' : failCount ? 'error' : warnCount ? 'warn' : 'ok'

  useEffect(() => {
    if (!focusId || !checks.length) return
    window.setTimeout(() => {
      document.getElementById(`dq-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 0)
  }, [checks.length, focusId])

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
          <DataQualityMetric label="Trust Score" value={checks.length ? `${trustScore}%` : 'N/A'} tone={reportTone} detail={`date ${report?.date ?? '-'}`} />
          <DataQualityMetric label="Checks" value={String(checks.length)} tone={reportTone} detail={`ok ${okCount} / warn ${warnCount} / fail ${failCount}`} />
          <DataQualityMetric label="Actionable Gaps" value={String(gaps.length)} tone={!checks.length ? 'neutral' : gaps.length ? 'warn' : 'ok'} detail={gaps.length ? 'fail/warn first' : checks.length ? 'no active gap' : 'no report'} />
          <DataQualityMetric label="Generated" value={report?.generated_at ? report.generated_at.slice(11, 16) : '-'} tone="info" detail={report?.generated_at ?? 'not generated'} />
        </section>

        <DataQualityTrendChart
          report={report}
          loading={quality.isLoading}
          error={quality.error}
        />

        <DataRuntimeSourcePanel runtime={runtime.data} />

        <WorkstationPanel title="Actionable Data Gaps / 可處理缺口" kicker="fail and warn first">
          <div className="overflow-hidden">
            {gaps.length > 0 ? (
              gaps.map((check) => <CheckRow key={check.id} check={check} focused={check.id === focusId} />)
            ) : (
              <div className="flex items-center gap-2 p-4 text-sm text-emerald-300">
                <CheckCircle2 className="h-4 w-4" /> 沒有 fail/warn data quality 缺口。
              </div>
            )}
          </div>
        </WorkstationPanel>

        <WorkstationPanel title="All Checks / 全部檢查" kicker="freshness, schema, parity">
          <div className="overflow-hidden">
            {checks.map((check) => <CheckRow key={check.id} check={check} focused={check.id === focusId} />)}
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
