import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AreaSeries,
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
import { Activity } from 'lucide-react'
import { paperOrdersFromPayload, paperPendingBuysFromPayload, paperPnlSnapshotsFromPayload } from '@/lib/paperPayload'

type PaperTradePerformanceChartProps = {
  pnl?: any
  orders?: unknown
  pendingBuys?: unknown
  loading?: boolean
}

type PerformancePoint = {
  time: string
  bot: number
  benchmark?: number
  twii?: number
  drawdown: number
  totalValue: number
}

const PERIODS = [
  { key: '1W', days: 7, label: '1W' },
  { key: '1M', days: 30, label: '1M' },
  { key: '3M', days: 90, label: '3M' },
  { key: 'ALL', days: 9999, label: 'ALL' },
] as const

function dateOnly(value: unknown): string | null {
  if (!value) return null
  const raw = String(value)
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function pct(value: number, base: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(base) || base <= 0) return 0
  return ((value / base) - 1) * 100
}

function buildPaperTradePerformancePoints(pnl: any, period: string): PerformancePoint[] {
  const rawSnapshots = paperPnlSnapshotsFromPayload(pnl)
  const allSnapshots = [...rawSnapshots]
    .filter((row) => dateOnly(row?.date ?? row?.snapshot_date ?? row?.ts))
    .sort((a, b) => String(dateOnly(a?.date ?? a?.snapshot_date ?? a?.ts)).localeCompare(String(dateOnly(b?.date ?? b?.snapshot_date ?? b?.ts))))

  if (!allSnapshots.length) return []

  const periodDays = PERIODS.find((row) => row.key === period)?.days ?? 9999
  const cutoffDate = new Date(Date.now() - periodDays * 86_400_000).toISOString().slice(0, 10)
  const snapshots = period === 'ALL' ? allSnapshots : allSnapshots.filter((row) => String(dateOnly(row?.date ?? row?.snapshot_date ?? row?.ts)) >= cutoffDate)
  const rows = snapshots.length ? snapshots : allSnapshots
  const first = rows[0]
  const baseValue = numberOrNull(first?.total_value ?? first?.portfolio_value) ?? 1_000_000
  const baseBenchmark = numberOrNull(first?.benchmark_value)
  const baseTwii = numberOrNull(first?.twii_value)

  return rows.map((row) => {
    const totalValue = numberOrNull(row?.total_value ?? row?.portfolio_value) ?? baseValue
    const benchmarkValue = numberOrNull(row?.benchmark_value)
    const twiiValue = numberOrNull(row?.twii_value)
    const maxDrawdown = Math.abs(numberOrNull(row?.max_drawdown_to_date ?? row?.drawdown ?? 0) ?? 0)

    return {
      time: String(dateOnly(row?.date ?? row?.snapshot_date ?? row?.ts)),
      bot: pct(totalValue, baseValue),
      benchmark: baseBenchmark && benchmarkValue ? pct(benchmarkValue, baseBenchmark) : undefined,
      twii: baseTwii && twiiValue ? pct(twiiValue, baseTwii) : undefined,
      drawdown: -maxDrawdown * 100,
      totalValue,
    }
  })
}

function executionTime(row: any): string | null {
  return dateOnly(row?.filled_at ?? row?.executed_at ?? row?.submitted_at ?? row?.created_at ?? row?.date ?? row?.trade_date)
}

function orderText(row: any): string {
  const symbol = row?.symbol ?? row?.stock_id ?? 'order'
  const status = String(row?.status ?? row?.execution_status ?? row?.side ?? '').toLowerCase()
  if (status.includes('fill')) return `${symbol} filled`
  if (status.includes('cancel')) return `${symbol} cancelled`
  if (status.includes('sell')) return `${symbol} sell`
  if (status.includes('buy')) return `${symbol} buy`
  return `${symbol} order`
}

function buildExecutionMarkers(orders: unknown = [], pendingBuys: unknown = [], fallbackTime?: string): SeriesMarker<Time>[] {
  const orderRows = paperOrdersFromPayload(orders)
  const pendingRows = paperPendingBuysFromPayload(pendingBuys)
  const orderMarkers = orderRows
    .map((order): SeriesMarker<Time> | null => {
      const time = executionTime(order)
      if (!time) return null
      const side = String(order?.side ?? order?.action ?? order?.status ?? '').toLowerCase()
      const isSell = side.includes('sell')
      const isBlocked = String(order?.status ?? order?.execution_status ?? '').toLowerCase().includes('cancel')

      return {
        time,
        position: isSell ? 'aboveBar' : 'belowBar',
        shape: isBlocked ? 'circle' : isSell ? 'arrowDown' : 'arrowUp',
        color: isBlocked ? '#fbbf24' : isSell ? '#34d399' : '#fb7185',
        text: orderText(order),
      } satisfies SeriesMarker<Time>
    })
    .filter((marker): marker is SeriesMarker<Time> => marker !== null)

  const pendingMarkers = pendingRows.slice(0, 20).map((buy) => ({
    time: executionTime(buy) ?? fallbackTime ?? new Date().toISOString().slice(0, 10),
    position: 'belowBar',
    shape: 'circle',
    color: '#38bdf8',
    text: `${buy?.symbol ?? 'pending'} pending`,
  } satisfies SeriesMarker<Time>))

  return [...orderMarkers, ...pendingMarkers].slice(-80)
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
      scaleMargins: { top: 0.08, bottom: 0.22 },
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

function EmptyPanel({ message }: { message: string }) {
  return (
    <div className="grid min-h-[320px] place-items-center border border-[#263247] bg-[#070a10] px-4 text-center">
      <div>
        <Activity className="mx-auto mb-3 h-10 w-10 text-[#d6a85f]/45" />
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#d6a85f]">Paper Trading Visual Workbench</p>
        <p className="mt-2 text-sm text-slate-400">{message}</p>
      </div>
    </div>
  )
}

export default function PaperTradePerformanceChart({ pnl, orders = [], pendingBuys = [], loading }: PaperTradePerformanceChartProps) {
  const [period, setPeriod] = useState<string>('ALL')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const points = useMemo(() => buildPaperTradePerformancePoints(pnl, period), [period, pnl])
  const markers = useMemo(() => buildExecutionMarkers(orders, pendingBuys, points[points.length - 1]?.time), [orders, pendingBuys, points])
  const latest = points[points.length - 1]
  const maxDrawdown = points.length ? Math.min(...points.map((point) => point.drawdown)) : 0

  useEffect(() => {
    const container = containerRef.current
    if (!container || loading || !points.length) return

    const chart = createChart(container, chartOptions(container.clientWidth || 720))
    chartRef.current = chart

    const botSeries = chart.addSeries(AreaSeries, {
      lineColor: latest?.bot != null && latest.bot >= 0 ? '#fb7185' : '#34d399',
      topColor: 'rgba(251, 113, 133, 0.22)',
      bottomColor: 'rgba(52, 211, 153, 0.03)',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'bot',
    })
    botSeries.setData(points.map((point) => ({ time: point.time, value: point.bot })))
    if (markers.length) createSeriesMarkers(botSeries, markers)

    if (points.some((point) => point.benchmark != null)) {
      const benchmarkSeries = chart.addSeries(LineSeries, {
        color: '#818cf8',
        lineWidth: 1,
        lineStyle: 2,
        priceLineVisible: false,
        title: '0050',
      })
      benchmarkSeries.setData(points.filter((point) => point.benchmark != null).map((point) => ({ time: point.time, value: point.benchmark ?? 0 })))
    }

    if (points.some((point) => point.twii != null)) {
      const twiiSeries = chart.addSeries(LineSeries, {
        color: '#a78bfa',
        lineWidth: 1,
        lineStyle: 1,
        priceLineVisible: false,
        title: 'TWII',
      })
      twiiSeries.setData(points.filter((point) => point.twii != null).map((point) => ({ time: point.time, value: point.twii ?? 0 })))
    }

    const drawdownSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      color: '#34d399',
    }, 1)
    drawdownSeries.setData(points.map((point) => ({
      time: point.time,
      value: point.drawdown,
      color: point.drawdown < -5 ? '#34d399' : 'rgba(148, 163, 184, 0.35)',
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
  }, [latest?.bot, loading, markers, points])

  if (loading) return <EmptyPanel message="Paper performance API 載入中，先保留交易圖面位置。" />
  if (!points.length) return <EmptyPanel message="No performance data yet. Chart will appear after the first trading day." />

  return (
    <section className="overflow-hidden border border-[#263247] bg-[#0f151d]/96 shadow-[0_18px_60px_rgba(0,0,0,0.18)]">
      <header className="grid gap-3 border-b border-[#263247] bg-[#070a10] p-3 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-center">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#d6a85f]">Paper Trading Visual Workbench</p>
          <h2 className="mt-1 text-lg font-semibold text-[#f2ead8]">資產曲線與 execution markers</h2>
          <p className="mt-1 text-xs leading-5 text-[#9badbf]">
            Bot equity、0050 / TWII benchmark、drawdown 與 pending/fill/order markers 會放在同一個時間軸上。
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
          <div className="border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-rose-200">bot {latest?.bot.toFixed(2)}%</div>
          <div className="border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-emerald-200">mdd {maxDrawdown.toFixed(2)}%</div>
          <div className="border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-sky-200">events {markers.length}</div>
        </div>
      </header>

      <div className="border-b border-[#263247] bg-[#070a10] px-3 py-2">
        <div className="flex items-center gap-1">
          {PERIODS.map((row) => (
            <button
              key={row.key}
              type="button"
              onClick={() => setPeriod(row.key)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                period === row.key
                  ? 'border-emerald-500/30 bg-emerald-500/20 text-emerald-300'
                  : 'border-transparent text-muted-foreground hover:text-foreground/80'
              }`}
            >
              {row.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={containerRef} className="min-h-[340px] w-full bg-[#070a10]" />
    </section>
  )
}
