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
import type { ObservabilityEvent, ObservabilityEventReport, ObservabilitySeverity } from '@/lib/api'

type ObservabilityEventTimelineProps = {
  report?: ObservabilityEventReport
  loading?: boolean
  error?: unknown
}

type EventPoint = {
  time: Time
  severityScore: number
  count: number
  color: string
  event: ObservabilityEvent
}

type SeverityBucket = {
  key: string
  label: string
  ok: number
  info: number
  warn: number
  error: number
  total: number
}

const SEVERITY_ORDER: Record<ObservabilitySeverity, number> = {
  ok: 1,
  info: 1.5,
  warn: 2.4,
  error: 3.4,
}

function severityColor(severity: ObservabilitySeverity): string {
  if (severity === 'error') return '#fb7185'
  if (severity === 'warn') return '#fbbf24'
  if (severity === 'ok') return '#34d399'
  return '#38bdf8'
}

function eventTime(value: string, fallbackIndex: number): Time {
  const parsed = new Date(value)
  if (!Number.isNaN(parsed.getTime())) return Math.floor(parsed.getTime() / 1000) as Time
  const fallback = new Date()
  fallback.setMinutes(fallback.getMinutes() - fallbackIndex * 5)
  return Math.floor(fallback.getTime() / 1000) as Time
}

function buildPoints(events: ObservabilityEvent[]): EventPoint[] {
  return [...events]
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    .map((event, index) => ({
      time: eventTime(event.ts, events.length - index),
      severityScore: SEVERITY_ORDER[event.severity] ?? 1.5,
      count: 1,
      color: severityColor(event.severity),
      event,
    }))
}

function buildMarkers(points: EventPoint[]): SeriesMarker<Time>[] {
  return points
    .filter((point) => point.event.severity === 'warn' || point.event.severity === 'error')
    .slice(-30)
    .map((point) => ({
      time: point.time,
      position: 'aboveBar',
      shape: point.event.severity === 'error' ? 'circle' : 'arrowDown',
      color: point.color,
      text: `${point.event.domain} ${point.event.status}`,
    }))
}

function bucketKey(event: ObservabilityEvent, fallbackIndex: number): { key: string; label: string } {
  const parsed = new Date(event.ts)
  const date = Number.isNaN(parsed.getTime())
    ? new Date(Date.now() - fallbackIndex * 30 * 60 * 1000)
    : parsed
  date.setMinutes(0, 0, 0)
  const key = date.toISOString()
  const label = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`
  return { key, label }
}

function buildSeverityBuckets(events: ObservabilityEvent[]): SeverityBucket[] {
  const parsedTimes = events
    .map((event) => new Date(event.ts).getTime())
    .filter((value) => Number.isFinite(value))
  const end = new Date(parsedTimes.length ? Math.max(...parsedTimes) : Date.now())
  end.setMinutes(0, 0, 0)
  const buckets = new Map<string, SeverityBucket>()
  for (let offset = 23; offset >= 0; offset -= 1) {
    const date = new Date(end.getTime() - offset * 60 * 60 * 1000)
    const key = date.toISOString()
    const label = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`
    buckets.set(key, { key, label, ok: 0, info: 0, warn: 0, error: 0, total: 0 })
  }
  events.forEach((event, index) => {
    const { key, label } = bucketKey(event, events.length - index)
    const row = buckets.get(key) ?? { key, label, ok: 0, info: 0, warn: 0, error: 0, total: 0 }
    const severity = event.severity ?? 'info'
    row[severity] += 1
    row.total += 1
    buckets.set(key, row)
  })
  return Array.from(buckets.values()).sort((a, b) => a.key.localeCompare(b.key)).slice(-24)
}

function SeverityStack({ bucket, max }: { bucket: SeverityBucket; max: number }) {
  const height = Math.max(12, Math.round((bucket.total / Math.max(1, max)) * 260))
  const segmentHeight = (count: number) => count ? `${Math.max(4, Math.round((count / bucket.total) * height))}px` : '0px'
  return (
    <div className="flex h-full min-w-0 flex-col items-center justify-end gap-1">
      <div className="flex w-full max-w-[44px] flex-col justify-end overflow-hidden border border-[#263247] bg-[#0f151d]" style={{ height: `${height}px` }} title={`${bucket.label} ok:${bucket.ok} info:${bucket.info} warn:${bucket.warn} error:${bucket.error}`}>
        <div className="bg-rose-400" style={{ height: segmentHeight(bucket.error) }} />
        <div className="bg-amber-300" style={{ height: segmentHeight(bucket.warn) }} />
        <div className="bg-sky-300" style={{ height: segmentHeight(bucket.info) }} />
        <div className="bg-emerald-300" style={{ height: segmentHeight(bucket.ok) }} />
      </div>
      <div className="font-mono text-[9px] leading-3 text-[#70809b] [writing-mode:vertical-rl]">{bucket.label}</div>
    </div>
  )
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
      scaleMargins: { top: 0.08, bottom: 0.18 },
    },
    timeScale: {
      borderColor: 'rgba(148, 163, 184, 0.18)',
      timeVisible: true,
      secondsVisible: false,
    },
  }
}

function EmptyWorkbench({ message }: { message: string }) {
  const bars = [0.38, 0.64, 0.51, 0.78, 0.44, 0.69, 0.57, 0.83, 0.48]

  return (
    <section className="overflow-hidden border border-[#263247] bg-[#0f151d]/96 shadow-[0_18px_60px_rgba(0,0,0,0.20)]">
      <header className="grid gap-3 border-b border-[#263247] bg-[#070a10] p-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-center">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-sky-300">Observability Visual Workbench</p>
          <h2 className="mt-1 text-xl font-semibold text-[#f2ead8]">OBS 事件圖面等待 events</h2>
          <p className="mt-2 text-xs leading-5 text-[#9badbf]">{message}</p>
        </div>
        <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
          <div className="border border-slate-500/25 bg-slate-500/10 px-3 py-2 text-slate-300">events 0</div>
          <div className="border border-slate-500/25 bg-slate-500/10 px-3 py-2 text-slate-300">domains N/A</div>
          <div className="border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-rose-200">api degraded</div>
        </div>
      </header>
      <div className="relative min-h-[300px] overflow-hidden bg-[#070a10] p-4">
        <div className="absolute inset-0 opacity-50 [background-image:linear-gradient(rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.06)_1px,transparent_1px)] [background-size:42px_42px]" />
        <div className="relative flex h-[250px] items-end gap-3 border-l border-b border-[#3a4659] px-4 pb-6">
          {bars.map((height, index) => (
            <div key={index} className="flex flex-1 flex-col items-center gap-2">
              <div
                className="w-full border border-sky-300/25 bg-sky-300/10"
                style={{ height: `${Math.max(16, height * 190)}px` }}
              />
              <div className="h-1.5 w-1.5 bg-amber-300" />
            </div>
          ))}
        </div>
        <div className="relative mt-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">
          <span>severity timeline</span>
          <span>event count</span>
          <span>warn / error markers</span>
        </div>
      </div>
    </section>
  )
}

export default function ObservabilityEventTimeline({ report, loading, error }: ObservabilityEventTimelineProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const events = report?.events ?? []
  const points = useMemo(() => buildPoints(events), [events])
  const markers = useMemo(() => buildMarkers(points), [points])
  const buckets = useMemo(() => buildSeverityBuckets(events), [events])
  const maxBucket = useMemo(() => Math.max(1, ...buckets.map((bucket) => bucket.total)), [buckets])
  const counts = report?.counts ?? { ok: 0, info: 0, warn: 0, error: 0 }
  const topEvents = events.filter((event) => event.severity === 'error' || event.severity === 'warn').slice(0, 5)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !points.length) return

    const chart = createChart(container, chartOptions(container.clientWidth || 720))
    chartRef.current = chart

    const severitySeries = chart.addSeries(LineSeries, {
      color: Number(counts.error ?? 0) ? '#fb7185' : Number(counts.warn ?? 0) ? '#fbbf24' : '#38bdf8',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'severity',
    })
    severitySeries.setData(points.map((point) => ({ time: point.time, value: point.severityScore })))
    if (markers.length) createSeriesMarkers(severitySeries, markers)

    const eventSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      color: '#38bdf8',
    }, 1)
    eventSeries.setData(points.map((point) => ({
      time: point.time,
      value: point.count,
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
  }, [counts.error, counts.warn, markers, points])

  if (loading) return <EmptyWorkbench message="Observability API 載入中，先保留事件圖面位置。" />
  if (error) return <EmptyWorkbench message={error instanceof Error ? error.message : 'Observability API failed.'} />
  if (!points.length) return <EmptyWorkbench message="目前沒有 observability events；請確認 Worker admin observability endpoint。" />

  return (
    <section className="overflow-hidden border border-[#263247] bg-[#0f151d]/96 shadow-[0_18px_60px_rgba(0,0,0,0.20)]">
      <header className="grid gap-3 border-b border-[#263247] bg-[#070a10] p-4 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-center">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-sky-300">Observability Visual Workbench</p>
          <h2 className="mt-1 text-xl font-semibold text-[#f2ead8]">事件 severity timeline</h2>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-[#9badbf]">
            這張圖把 OBS events 的 ts、severity、domain 與 status 轉成可掃描的事件曲線。上方 marker 是 warn/error，右側列出最需要先處理的 operational evidence。
          </p>
        </div>
        <div className="grid grid-cols-4 gap-2 font-mono text-[11px]">
          <div className="border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-emerald-200">ok {counts.ok ?? 0}</div>
          <div className="border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-sky-200">info {counts.info ?? 0}</div>
          <div className="border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-amber-200">warn {counts.warn ?? 0}</div>
          <div className="border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-rose-200">error {counts.error ?? 0}</div>
        </div>
      </header>

      <div className="grid gap-px bg-[#263247] lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.55fr)]">
        <div className="min-h-[340px] w-full bg-[#070a10] p-4">
          <div className="grid h-[286px] items-end gap-1 border-l border-b border-[#263247] px-3 pb-4 [grid-template-columns:repeat(24,minmax(18px,1fr))]">
            {buckets.map((bucket) => (
              <SeverityStack key={bucket.key} bucket={bucket} max={maxBucket} />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 font-mono text-[10px] uppercase tracking-[0.14em] text-[#8a92a6]">
            <span className="inline-flex items-center gap-1"><i className="h-2 w-2 bg-rose-400" />error</span>
            <span className="inline-flex items-center gap-1"><i className="h-2 w-2 bg-amber-300" />warn</span>
            <span className="inline-flex items-center gap-1"><i className="h-2 w-2 bg-sky-300" />info</span>
            <span className="inline-flex items-center gap-1"><i className="h-2 w-2 bg-emerald-300" />ok</span>
            <span className="ml-auto text-[#70809b]">bucketed by hour; counts are visible without hover</span>
          </div>
          <div ref={containerRef} className="hidden" />
        </div>
        <aside className="bg-[#070a10] p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#d6a85f]">event focus</p>
          <div className="mt-3 space-y-2 text-xs">
            {topEvents.length ? topEvents.map((event) => (
              <div key={event.id} className="border border-[#263247] bg-[#0f151d] p-2 text-[#c8d3df]">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold">{event.title}</span>
                  <span className="font-mono text-[10px]" style={{ color: severityColor(event.severity) }}>{event.severity}</span>
                </div>
                <p className="mt-1 font-mono text-[10px] text-[#70809b]">{event.domain} / {event.status}</p>
                <p className="mt-1 line-clamp-2 text-[#8b9bab]">{event.next_action || event.summary}</p>
              </div>
            )) : (
              <div className="border border-emerald-400/25 bg-emerald-400/10 p-2 text-emerald-200">
                目前沒有 warn/error events。
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  )
}
