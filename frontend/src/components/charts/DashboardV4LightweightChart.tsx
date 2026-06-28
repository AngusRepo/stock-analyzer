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
    layout: {
      background: { type: ColorType.Solid, color: '#0a0b0f' },
      textColor: '#8992a3',
      fontFamily: 'Manrope, Noto Sans TC, system-ui, sans-serif',
    },
    grid: {
      vertLines: { color: 'rgba(255, 255, 255, 0.045)' },
      horzLines: { color: 'rgba(255, 255, 255, 0.055)' },
    },
    rightPriceScale: {
      borderColor: 'rgba(255, 255, 255, 0.035)',
      scaleMargins: { top: 0.08, bottom: 0.12 },
    },
    timeScale: {
      borderColor: 'rgba(255, 255, 255, 0.035)',
      timeVisible: false,
      secondsVisible: false,
    },
    crosshair: {
      horzLine: { color: 'rgba(214, 168, 95, 0.42)' },
      vertLine: { color: 'rgba(214, 168, 95, 0.42)' },
    },
  }
}

function LoadingPanel() {
  return (
    <div className="grid min-h-[460px] place-items-center rounded-[20px] border border-white/[0.08] bg-[#0a0b0f]">
      <div className="h-28 w-full max-w-xl animate-pulse rounded bg-slate-800/50" />
    </div>
  )
}
function EmptyPanel({ message }: { message: string }) {
  return (
    <div className="grid min-h-[460px] place-items-center rounded-[20px] border border-white/[0.08] bg-[#0a0b0f] px-4 text-center">
      <div>
        <p className="sv-num text-[11px] normal-case text-amber-200">chart unavailable</p>
        <p className="mt-2 text-sm text-slate-400">{message}</p>
      </div>
    </div>
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
      upColor: '#ff3b45',
      downColor: '#00c076',
      borderUpColor: '#ff3b45',
      borderDownColor: '#00c076',
      wickUpColor: '#ff6b72',
      wickDownColor: '#28d190',
    })
    candleSeries.setData(viewModel.candles)
    createSeriesMarkers(candleSeries, viewModel.modelMarkers)

    if (viewModel.volume.length) {
      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        color: 'rgba(148, 163, 184, 0.24)',
      }, 1)
      volumeSeries.setData(viewModel.volume)
    }

    if (viewModel.sectorFlow.length) {
      const sectorFlowSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        color: 'rgba(214, 168, 95, 0.82)',
      }, 2)
      sectorFlowSeries.setData(viewModel.sectorFlow)
    }

    chart.timeScale().fitContent()

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      chart.applyOptions({ width: Math.max(320, Math.floor(entry.contentRect.width)), height: 430 })
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [viewModel])

  if (loading) return <LoadingPanel />
  if (error) return <EmptyPanel message={error instanceof Error ? error.message : 'Dashboard V4 chart packet failed to load.'} />
  if (!viewModel) return <EmptyPanel message="No Dashboard V4 chart packet yet." />
  if (!viewModel.candles.length) return <EmptyPanel message="No valid OHLC rows were available after the data-quality filter." />

  return (
    <section className="overflow-hidden rounded-[22px] border border-white/[0.09] bg-[linear-gradient(180deg,rgba(22,23,30,0.96),rgba(10,11,15,0.985))] shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_18px_52px_rgba(0,0,0,0.34)]">
      <header className="grid gap-3 border-b border-white/[0.07] bg-[#101116] p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0">
          <p className="sv-num text-[10px] normal-case text-[#d6a85f]">Dashboard V4 / Lightweight Charts</p>
          <h2 className="mt-1 truncate text-lg font-semibold text-[#f2ead8]">{viewModel.title}</h2>
          <p className="mt-1 sv-num text-[11px] text-[#8b9bab]">{viewModel.subtitle}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3 lg:min-w-[520px]">
          {viewModel.lanes.map((lane) => (
            <div key={lane.id} className={`border px-2.5 py-2 ${laneColor(lane.status)}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="sv-num normal-case">{lane.label}</span>
                <span className="sv-num text-xs">{lane.value}</span>
              </div>
              <p className="mt-1 truncate text-[10px] opacity-75">{lane.detail}</p>
            </div>
          ))}
        </div>
      </header>

      <div ref={containerRef} className="h-[430px] min-h-[430px] max-h-[430px] w-full overflow-hidden bg-[#0a0b0f]" />

      <footer className="grid gap-2 border-t border-white/[0.07] bg-[#101116] p-3 text-[11px] text-[#8b9bab] lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <span className="text-[#d6a85f]">regime</span> {viewModel.regimeLabel}
          <span className="mx-2 text-slate-600">/</span>
          <span className="text-[#d6a85f]">quality</span> {viewModel.dataQualityStatus}
          <span className="mx-2 text-slate-600">/</span>
          <span className="text-[#d6a85f]">warnings</span> {summary?.warningCount ?? 0}
        </div>
        {summary?.hasExternalWidget && (
          <span className="text-rose-300">external widget source blocked by Dashboard V4 policy</span>
        )}
      </footer>
    </section>
  )
}
