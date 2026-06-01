import { useEffect, useMemo, useRef } from 'react'
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type ChartOptions,
  type DeepPartial,
  type IChartApi,
} from 'lightweight-charts'
import type { DashboardV4ChartPacket } from '@/lib/api'
import {
  buildDashboardV4ChartViewModel,
  summarizeDashboardV4Packet,
  type ChartLaneStatus,
} from '@/lib/dashboardV4ChartViewModel'

type DashboardV4LightweightChartProps = {
  packet?: DashboardV4ChartPacket
  loading?: boolean
  error?: unknown
}

function laneColor(status: ChartLaneStatus) {
  if (status === 'ok') return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200'
  if (status === 'warn') return 'border-amber-400/25 bg-amber-400/10 text-amber-200'
  if (status === 'error') return 'border-rose-400/30 bg-rose-400/10 text-rose-200'
  return 'border-slate-500/25 bg-slate-500/10 text-slate-300'
}

function chartOptions(width: number): DeepPartial<ChartOptions> {
  return {
    width,
    height: 430,
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
      scaleMargins: { top: 0.08, bottom: 0.12 },
    },
    timeScale: {
      borderColor: 'rgba(148, 163, 184, 0.18)',
      timeVisible: false,
      secondsVisible: false,
    },
    crosshair: {
      horzLine: { color: 'rgba(214, 168, 95, 0.35)' },
      vertLine: { color: 'rgba(214, 168, 95, 0.35)' },
    },
  }
}

function LoadingPanel() {
  return (
    <div className="sv-content-card grid min-h-[460px] place-items-center rounded-xl">
      <div className="h-28 w-full max-w-xl animate-pulse rounded bg-[color:var(--sv-panel-raised)]" />
    </div>
  )
}
function EmptyPanel({ message, status = 'waiting' }: { message: string; status?: 'waiting' | 'filtered' | 'error' }) {
  const tone = status === 'error'
    ? 'text-rose-300'
    : status === 'filtered'
      ? 'text-amber-200'
      : 'sv-accent-text'

  return (
    <section
      data-testid="dashboard-v4-chart-empty-state"
      className="sv-content-card rounded-xl p-4"
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0">
          <p className={`${tone} font-mono text-[10px] uppercase tracking-[0.18em]`}>Dashboard V4 chart status</p>
          <h2 className="sv-title-text mt-1 text-base font-semibold">chart unavailable</h2>
          <p className="sv-muted-text mt-1 text-xs leading-5">{message}</p>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-[10px] lg:min-w-[280px]">
          {[
            { label: 'packet', value: status === 'waiting' ? 'pending' : status },
            { label: 'candles', value: status === 'filtered' ? '0' : '-' },
            { label: 'action', value: status === 'error' ? 'retry' : 'wait' },
          ].map((item) => (
            <div key={item.label} className="rounded-lg border border-[color:var(--sv-panel-border-soft)] bg-[color:var(--sv-panel-raised)] px-2 py-2">
              <p className="sv-muted-text font-mono uppercase tracking-[0.12em]">{item.label}</p>
              <p className="sv-title-text mt-1 truncate font-mono">{item.value}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export default function DashboardV4LightweightChart({ packet, loading, error }: DashboardV4LightweightChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const viewModel = useMemo(() => packet ? buildDashboardV4ChartViewModel(packet) : null, [packet])
  const summary = useMemo(() => packet ? summarizeDashboardV4Packet(packet) : null, [packet])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !viewModel || viewModel.candles.length === 0) return

    const chart = createChart(container, chartOptions(container.clientWidth || 720))
    chartRef.current = chart

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#ef4444',
      downColor: '#10b981',
      borderUpColor: '#ef4444',
      borderDownColor: '#10b981',
      wickUpColor: '#f87171',
      wickDownColor: '#34d399',
    })
    candleSeries.setData(viewModel.candles)
    createSeriesMarkers(candleSeries, viewModel.modelMarkers)

    if (viewModel.volume.length) {
      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        color: 'rgba(148, 163, 184, 0.35)',
      }, 1)
      volumeSeries.setData(viewModel.volume)
    }

    if (viewModel.sectorFlow.length) {
      const sectorFlowSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        color: '#d6a85f',
      }, 2)
      sectorFlowSeries.setData(viewModel.sectorFlow)
    }

    chart.timeScale().fitContent()

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      chart.applyOptions({ width: Math.max(320, Math.floor(entry.contentRect.width)) })
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [viewModel])

  if (loading) return <LoadingPanel />
  if (error) return <EmptyPanel status="error" message={error instanceof Error ? error.message : 'Dashboard V4 chart packet failed to load.'} />
  if (!viewModel) return <EmptyPanel status="waiting" message="No Dashboard V4 chart packet yet." />
  if (!viewModel.candles.length) return <EmptyPanel status="filtered" message="No valid OHLC rows were available after the data-quality filter." />

  return (
    <section className="sv-content-card overflow-hidden rounded-xl shadow-[0_8px_26px_rgba(0,0,0,0.16)]">
      <header className="grid gap-3 border-b border-[color:var(--sv-panel-border-soft)] bg-[color:var(--sv-panel-deep)] p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0">
          <p className="sv-accent-text font-mono text-[10px] uppercase tracking-[0.18em]">Dashboard V4 / Lightweight Charts</p>
          <h2 className="sv-title-text mt-1 truncate text-lg font-semibold">{viewModel.title}</h2>
          <p className="sv-muted-text mt-1 font-mono text-[11px]">{viewModel.subtitle}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3 lg:min-w-[520px]">
          {viewModel.lanes.map((lane) => (
            <div key={lane.id} className={`border px-2.5 py-2 ${laneColor(lane.status)}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono uppercase tracking-[0.12em]">{lane.label}</span>
                <span className="font-mono text-xs">{lane.value}</span>
              </div>
              <p className="mt-1 truncate text-[10px] opacity-75">{lane.detail}</p>
            </div>
          ))}
        </div>
      </header>

      <div ref={containerRef} className="min-h-[430px] w-full bg-[color:var(--sv-panel-deep)]" />

      <footer className="sv-muted-text grid gap-2 border-t border-[color:var(--sv-panel-border-soft)] bg-[color:var(--sv-panel-deep)] p-3 text-[11px] lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <span className="sv-accent-text">regime</span> {viewModel.regimeLabel}
          <span className="mx-2 text-slate-600">/</span>
          <span className="sv-accent-text">quality</span> {viewModel.dataQualityStatus}
          <span className="mx-2 text-slate-600">/</span>
          <span className="sv-accent-text">warnings</span> {summary?.warningCount ?? 0}
        </div>
        {summary?.hasExternalWidget && (
          <span className="text-rose-300">external widget source blocked by Dashboard V4 policy</span>
        )}
      </footer>
    </section>
  )
}
