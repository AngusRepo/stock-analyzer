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
import type { DataQualityCheck, DataQualityReport, DataQualityStatus } from '@/lib/api'

type DataQualityTrendChartProps = {
  report?: DataQualityReport
  loading?: boolean
  error?: unknown
}

type EvidencePoint = {
  time: string
  score: number
  severity: number
  color: string
  check: DataQualityCheck
}

function statusScore(status: DataQualityStatus): number {
  if (status === 'ok') return 1
  if (status === 'warn') return 0.5
  return 0
}

function statusColor(status: DataQualityStatus): string {
  if (status === 'ok') return '#34d399'
  if (status === 'warn') return '#fbbf24'
  return '#fb7185'
}

function statusSeverity(status: DataQualityStatus): number {
  if (status === 'ok') return 1
  if (status === 'warn') return 0.55
  return 0.2
}

function generatedDate(report?: DataQualityReport): Date {
  const raw = report?.generated_at || report?.date
  const parsed = raw ? new Date(raw) : new Date()
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

function pointTime(index: number, total: number, anchor: Date): string {
  const day = new Date(anchor)
  day.setDate(anchor.getDate() - Math.max(0, total - index - 1))
  return day.toISOString().slice(0, 10)
}

function buildEvidencePoints(report?: DataQualityReport): EvidencePoint[] {
  const checks = report?.checks ?? []
  const anchor = generatedDate(report)
  return checks.map((check, index) => ({
    time: pointTime(index, Math.max(1, checks.length), anchor),
    score: statusScore(check.status),
    severity: statusSeverity(check.status),
    color: statusColor(check.status),
    check,
  }))
}

function buildMarkers(points: EvidencePoint[]): SeriesMarker<Time>[] {
  return points
    .filter((point) => point.check.status !== 'ok')
    .map((point) => ({
      time: point.time,
      position: 'aboveBar',
      shape: point.check.status === 'fail' ? 'circle' : 'arrowDown',
      color: statusColor(point.check.status),
      text: `${point.check.id} ${point.check.status}`,
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
  const bars = [0.64, 0.42, 0.76, 0.58, 0.34, 0.69, 0.51, 0.84]

  return (
    <section className="overflow-hidden border border-[#263247] bg-[#0f151d]/96">
      <header className="grid gap-3 border-b border-[#263247] bg-[#070a10] p-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-center">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-300">Data Quality Visual Workbench</p>
          <h2 className="mt-1 text-xl font-semibold text-[#f2ead8]">資料品質圖面等待 checks</h2>
          <p className="mt-2 text-xs leading-5 text-[#9badbf]">{message}</p>
        </div>
        <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
          <div className="border border-slate-500/25 bg-slate-500/10 px-3 py-2 text-slate-300">checks 0</div>
          <div className="border border-slate-500/25 bg-slate-500/10 px-3 py-2 text-slate-300">score N/A</div>
          <div className="border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-rose-200">api degraded</div>
        </div>
      </header>
      <div className="relative min-h-[300px] overflow-hidden bg-[#070a10] p-4">
        <div className="absolute inset-0 opacity-50 [background-image:linear-gradient(rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.06)_1px,transparent_1px)] [background-size:42px_42px]" />
        <div className="relative flex h-[250px] items-end gap-3 border-l border-b border-[#3a4659] px-4 pb-6">
          {bars.map((height, index) => (
            <div key={index} className="flex flex-1 flex-col items-center gap-2">
              <div
                className="w-full border border-emerald-300/25 bg-emerald-300/10"
                style={{ height: `${Math.max(16, height * 190)}px` }}
              />
              <div className="h-1.5 w-1.5 bg-amber-300" />
            </div>
          ))}
        </div>
        <div className="relative mt-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">
          <span>freshness</span>
          <span>schema</span>
          <span>train / serve parity</span>
        </div>
      </div>
    </section>
  )
}

export default function DataQualityTrendChart({ report, loading, error }: DataQualityTrendChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const points = useMemo(() => buildEvidencePoints(report), [report])
  const markers = useMemo(() => buildMarkers(points), [points])
  const okCount = points.filter((point) => point.check.status === 'ok').length
  const warnCount = points.filter((point) => point.check.status === 'warn').length
  const failCount = points.filter((point) => point.check.status === 'fail').length
  const trustScore = points.length
    ? Math.round((points.reduce((sum, point) => sum + point.score, 0) / points.length) * 100)
    : 0
  const topGaps = points.filter((point) => point.check.status !== 'ok').slice(0, 5)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !points.length) return

    const chart = createChart(container, chartOptions(container.clientWidth || 720))
    chartRef.current = chart

    const scoreSeries = chart.addSeries(LineSeries, {
      color: failCount ? '#fb7185' : warnCount ? '#fbbf24' : '#34d399',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'quality score',
    })
    scoreSeries.setData(points.map((point) => ({ time: point.time, value: point.score })))
    if (markers.length) createSeriesMarkers(scoreSeries, markers)

    const severitySeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      color: '#34d399',
    }, 1)
    severitySeries.setData(points.map((point) => ({
      time: point.time,
      value: point.severity,
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
  }, [failCount, markers, points, warnCount])

  if (loading) return <EmptyWorkbench message="Data Quality API 載入中，先保留資料品質圖面位置。" />
  if (error) return <EmptyWorkbench message={error instanceof Error ? error.message : 'Data Quality API failed.'} />
  if (!points.length) return <EmptyWorkbench message="目前沒有 data-quality checks；請確認 Worker admin data-quality endpoint。" />

  return (
    <section className="overflow-hidden border border-[#263247] bg-[#0f151d]/96 shadow-[0_18px_60px_rgba(0,0,0,0.20)]">
      <header className="grid gap-3 border-b border-[#263247] bg-[#070a10] p-4 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-center">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-300">Data Quality Visual Workbench</p>
          <h2 className="mt-1 text-xl font-semibold text-[#f2ead8]">資料品質 evidence surface</h2>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-[#9badbf]">
            這張圖把本次 freshness、schema、train/serve parity 與 feature coverage checks 轉成可掃描的品質曲線與缺口 marker。這不是歷史趨勢，等 V4 operations timeline contract 補齊後再接多日序列。
          </p>
        </div>
        <div className="grid grid-cols-4 gap-2 font-mono text-[11px]">
          <div className="border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-emerald-200">score {trustScore}%</div>
          <div className="border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-emerald-200">ok {okCount}</div>
          <div className="border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-amber-200">warn {warnCount}</div>
          <div className="border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-rose-200">fail {failCount}</div>
        </div>
      </header>

      <div className="grid gap-px bg-[#263247] lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.55fr)]">
        <div ref={containerRef} className="min-h-[340px] w-full bg-[#070a10]" />
        <aside className="bg-[#070a10] p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#d6a85f]">gap focus</p>
          <div className="mt-3 space-y-2 text-xs">
            {topGaps.length ? topGaps.map((point) => (
              <a
                key={point.check.id}
                href={`/data-quality?focus=${point.check.id}`}
                className="block border border-[#263247] bg-[#0f151d] p-2 text-[#c8d3df] hover:border-[#d6a85f]/50"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold">{point.check.label}</span>
                  <span className="font-mono text-[10px]" style={{ color: point.color }}>{point.check.status}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[#8b9bab]">{point.check.summary}</p>
              </a>
            )) : (
              <div className="border border-emerald-400/25 bg-emerald-400/10 p-2 text-emerald-200">
                目前沒有 fail/warn checks。
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  )
}
