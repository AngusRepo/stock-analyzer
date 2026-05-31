import { useEffect, useMemo, useRef } from 'react'
import {
  ColorType,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type ChartOptions,
  type DeepPartial,
  type IChartApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts'
import type { SchedulerJob, SchedulerStatus } from '@/lib/api'

type SchedulerCadenceChartProps = {
  status?: SchedulerStatus
  loading?: boolean
  error?: unknown
}

type CadencePoint = {
  time: string
  slo: number
  issueCount: number
  color: string
  failures: number
  skips: number
}

function durationRiskScore(job: SchedulerJob): number {
  if (job.lastStatus === 'waiting' || job.lastStatus === 'sleep' || job.lastStatus === 'skip') return 0
  if (job.durationConcern === 'suspicious_short') return 1
  if (job.lastDuration === '--' || job.lastDuration === 'N/A') return 1
  return 0
}

function pointDate(index: number, total: number): string {
  const date = new Date()
  date.setDate(date.getDate() - Math.max(0, total - index - 1))
  return date.toISOString().slice(0, 10)
}

function issueColor(failures: number, skips: number): string {
  if (failures > 0) return '#fb7185'
  if (skips > 0) return '#fbbf24'
  return '#38bdf8'
}

function buildCadencePoints(jobs: SchedulerJob[]): CadencePoint[] {
  const windowSize = Math.max(7, ...jobs.map((job) => job.history7d?.length ?? 0))
  return Array.from({ length: windowSize }, (_, index) => {
    let success = 0
    let failed = 0
    let skip = 0

    for (const job of jobs) {
      const history = job.history7d ?? []
      const offset = windowSize - history.length
      const status = history[index - offset]
      if (status === 'success') success += 1
      if (status === 'failed') failed += 1
      if (status === 'skip') skip += 1
    }

    const denominator = success + failed + skip
    const durationIssues = index === windowSize - 1
      ? jobs.reduce((sum, job) => sum + durationRiskScore(job), 0)
      : 0

    return {
      time: pointDate(index, windowSize),
      slo: denominator ? Math.round((success / denominator) * 100) : 0,
      issueCount: failed + durationIssues,
      color: issueColor(failed, skip),
      failures: failed,
      skips: skip,
    }
  })
}

function buildMarkers(points: CadencePoint[]): SeriesMarker<Time>[] {
  return points
    .filter((point) => point.issueCount > 0 || point.slo < 95)
    .map((point) => ({
      time: point.time,
      position: 'aboveBar',
      shape: point.failures > 0 ? 'circle' : 'arrowDown',
      color: point.failures > 0 ? '#fb7185' : '#fbbf24',
      text: point.failures > 0 ? `${point.failures} failed` : `${point.slo}% slo`,
    }))
}

function chartOptions(width: number): DeepPartial<ChartOptions> {
  return {
    width,
    height: 340,
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: '#070a10' },
      textColor: '#9aa6bd',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    },
    grid: {
      vertLines: { color: 'rgba(148, 163, 184, 0.08)' },
      horzLines: { color: 'rgba(148, 163, 184, 0.08)' },
    },
    rightPriceScale: {
      borderColor: 'rgba(148, 163, 184, 0.18)',
      scaleMargins: { top: 0.08, bottom: 0.2 },
    },
    timeScale: {
      borderColor: 'rgba(148, 163, 184, 0.18)',
      timeVisible: false,
      secondsVisible: false,
    },
  }
}

function EmptyWorkbench({ message }: { message: string }) {
  const bars = [0.48, 0.72, 0.56, 0.84, 0.62, 0.38, 0.76]

  return (
    <section className="sv-content-card overflow-hidden">
      <header className="grid gap-3 border-b border-[color:var(--sv-panel-border-soft)] bg-[color:var(--sv-panel-deep)] p-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-center">
        <div>
          <p className="sv-accent-text font-mono text-[10px] uppercase tracking-[0.18em]">Scheduler Visual Workbench</p>
          <h2 className="sv-title-text mt-1 text-xl font-semibold">排程節奏圖面等待 jobs</h2>
          <p className="sv-muted-text mt-2 text-xs leading-5">{message}</p>
        </div>
        <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
          <div className="border border-slate-500/25 bg-slate-500/10 px-3 py-2 text-slate-300">jobs 0</div>
          <div className="border border-slate-500/25 bg-slate-500/10 px-3 py-2 text-slate-300">7d slo N/A</div>
          <div className="border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-rose-200">api degraded</div>
        </div>
      </header>
      <div className="relative min-h-[300px] overflow-hidden bg-[color:var(--sv-panel-deep)] p-4">
        <div className="absolute inset-0 opacity-50 [background-image:linear-gradient(rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.06)_1px,transparent_1px)] [background-size:42px_42px]" />
        <div className="relative flex h-[250px] items-end gap-3 border-l border-b border-[#3a4659] px-4 pb-6">
          {bars.map((height, index) => (
            <div key={index} className="flex flex-1 flex-col items-center gap-2">
              <div
                className="w-full border border-amber-300/25 bg-amber-300/10"
                style={{ height: `${Math.max(18, height * 190)}px` }}
              />
              <div className="h-1.5 w-1.5 bg-sky-300" />
            </div>
          ))}
        </div>
        <div className="sv-muted-text relative mt-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em]">
          <span>7d cadence</span>
          <span>failed density</span>
          <span>duration risk</span>
        </div>
      </div>
    </section>
  )
}

export default function SchedulerCadenceChart({ status, loading, error }: SchedulerCadenceChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const jobs = status?.jobs ?? []
  const points = useMemo(() => buildCadencePoints(jobs), [jobs])
  const markers = useMemo(() => buildMarkers(points), [points])
  const failedJobs = jobs.filter((job) => job.lastStatus === 'failed')
  const durationRiskJobs = jobs.filter((job) => durationRiskScore(job) > 0)
  const activeJobs = status?.stats.active ?? jobs.filter((job) => job.lastStatus === 'running').length
  const latestPoint = points[points.length - 1]
  const focusJobs = [...failedJobs, ...durationRiskJobs.filter((job) => job.lastStatus !== 'failed')].slice(0, 5)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !jobs.length || !points.length) return

    const chart = createChart(container, chartOptions(container.clientWidth || 720))
    chartRef.current = chart

    const sloSeries = chart.addSeries(LineSeries, {
      color: failedJobs.length ? '#fb7185' : durationRiskJobs.length ? '#fbbf24' : '#34d399',
      lineWidth: 2,
      priceLineVisible: false,
      title: '7d slo',
    })
    sloSeries.setData(points.map((point) => ({ time: point.time, value: point.slo })))
    if (markers.length) createSeriesMarkers(sloSeries, markers)

    const issueSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      color: '#38bdf8',
    }, 1)
    issueSeries.setData(points.map((point) => ({
      time: point.time,
      value: point.issueCount,
      color: point.color,
    })))

    chart.timeScale().fitContent()
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) chart.applyOptions({ width: Math.max(320, Math.floor(entry.contentRect.width)) })
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [durationRiskJobs.length, failedJobs.length, jobs.length, markers, points])

  if (loading) return <EmptyWorkbench message="Scheduler API 載入中，先保留排程節奏圖面位置。" />
  if (error) return <EmptyWorkbench message={error instanceof Error ? error.message : 'Scheduler API failed.'} />
  if (!jobs.length) return <EmptyWorkbench message="目前沒有 scheduler jobs；請確認 Worker admin scheduler endpoint。" />

  return (
    <section className="sv-content-card overflow-hidden shadow-[0_18px_60px_rgba(0,0,0,0.20)]">
      <header className="grid gap-3 border-b border-[color:var(--sv-panel-border-soft)] bg-[color:var(--sv-panel-deep)] p-4 lg:grid-cols-[minmax(0,1fr)_460px] lg:items-center">
        <div>
          <p className="sv-accent-text font-mono text-[10px] uppercase tracking-[0.18em]">Scheduler Visual Workbench</p>
          <h2 className="sv-title-text mt-1 text-xl font-semibold">排程健康度 cadence surface</h2>
          <p className="sv-muted-text mt-2 max-w-2xl text-xs leading-5">
            這張圖把每個 job 的 history7d、failed density 與 suspicious duration 轉成可掃描的 SLO 曲線；下方長條越高，代表當天失敗或 callback/duration 風險越高。
          </p>
        </div>
        <div className="grid grid-cols-4 gap-2 font-mono text-[11px]">
          <div className="border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-sky-200">jobs {status?.stats.total ?? jobs.length}</div>
          <div className="border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-emerald-200">7d slo {status?.stats.successRate7d ?? latestPoint?.slo ?? 0}%</div>
          <div className="border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-amber-200">active {activeJobs}</div>
          <div className="border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-rose-200">risk {failedJobs.length + durationRiskJobs.length}</div>
        </div>
      </header>

      <div className="grid gap-px bg-[color:var(--sv-panel-border-soft)] lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.55fr)]">
        <div ref={containerRef} className="min-h-[340px] w-full bg-[color:var(--sv-panel-deep)]" />
        <aside className="bg-[color:var(--sv-panel-deep)] p-4">
          <p className="sv-accent-text font-mono text-[10px] uppercase tracking-[0.18em]">run focus</p>
          <div className="mt-3 space-y-2 text-xs">
            {focusJobs.length ? focusJobs.map((job) => (
              <a
                key={job.id}
                href={`/scheduler?focus=${job.id}`}
                className="sv-content-card block p-2 text-[color:var(--sv-text-main)] hover:border-[color:var(--sv-accent-border)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold">{job.name}</span>
                  <span className="font-mono text-[10px] text-rose-300">{job.lastStatus}</span>
                </div>
                <p className="sv-muted-text mt-1 font-mono text-[10px]">{job.group} / {job.lastDuration || '-'}</p>
                <p className="sv-muted-text mt-1 line-clamp-2">{job.durationConcernReason || job.summary || job.schedule}</p>
              </a>
            )) : (
              <div className="border border-emerald-400/25 bg-emerald-400/10 p-2 text-emerald-200">
                目前沒有 failed 或 suspicious duration jobs。
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  )
}
