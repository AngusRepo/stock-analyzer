import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AreaSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  LineStyle,
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

type BenchmarkKey = '0050' | 'TWII' | '00918A' | '00631L' | '00403A'

type PerformancePoint = {
  time: string
  bot: number
  benchmarks: Partial<Record<BenchmarkKey, number>>
  drawdown: number
  totalValue: number
}

const PERIODS = [
  { key: '1W', days: 7, label: '1W' },
  { key: '1M', days: 30, label: '1M' },
  { key: '3M', days: 90, label: '3M' },
  { key: 'ALL', days: 9999, label: 'ALL' },
] as const

const BENCHMARK_SERIES: Array<{
  key: BenchmarkKey
  label: string
  color: string
  lineStyle: LineStyle
  width: 1 | 2
}> = [
  { key: '0050', label: '0050', color: '#818cf8', lineStyle: LineStyle.Dashed, width: 2 },
  { key: 'TWII', label: 'TWII', color: '#a78bfa', lineStyle: LineStyle.Dotted, width: 1 },
  { key: '00918A', label: '00918A', color: '#fbbf24', lineStyle: LineStyle.Solid, width: 1 },
  { key: '00631L', label: '00631L', color: '#fb7185', lineStyle: LineStyle.Solid, width: 1 },
  { key: '00403A', label: '00403A', color: '#38bdf8', lineStyle: LineStyle.Solid, width: 1 },
]

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

function benchmarkRawValue(row: any, key: BenchmarkKey): number | null {
  if (key === '0050') return numberOrNull(row?.benchmark_value)
  if (key === 'TWII') return numberOrNull(row?.twii_value)
  const map = row?.etf_benchmarks && typeof row.etf_benchmarks === 'object'
    ? row.etf_benchmarks as Record<string, unknown>
    : {}
  return numberOrNull(map[key] ?? row?.[`${key}_value`] ?? row?.[key])
}

function firstPositiveValue(rows: any[], getter: (row: any) => unknown, fallback: number) {
  for (const row of rows) {
    const value = numberOrNull(getter(row))
    if (value != null && value > 0) return value
  }
  return fallback
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
  const baseValue = firstPositiveValue(rows, (row) => row?.total_value ?? row?.portfolio_value, 1_000_000)
  const benchmarkBases = BENCHMARK_SERIES.reduce<Partial<Record<BenchmarkKey, number>>>((acc, item) => {
    const base = firstPositiveValue(rows, (row) => benchmarkRawValue(row, item.key), 0)
    if (base > 0) acc[item.key] = base
    return acc
  }, {})

  return rows.map((row) => {
    const totalValue = numberOrNull(row?.total_value ?? row?.portfolio_value) ?? baseValue
    const maxDrawdown = Math.abs(numberOrNull(row?.max_drawdown_to_date ?? row?.drawdown ?? 0) ?? 0)
    const benchmarks = BENCHMARK_SERIES.reduce<Partial<Record<BenchmarkKey, number>>>((acc, item) => {
      const raw = benchmarkRawValue(row, item.key)
      const base = benchmarkBases[item.key]
      if (raw != null && base != null && base > 0) acc[item.key] = pct(raw, base)
      return acc
    }, {})

    return {
      time: String(dateOnly(row?.date ?? row?.snapshot_date ?? row?.ts)),
      bot: pct(totalValue, baseValue),
      benchmarks,
      drawdown: -maxDrawdown * 100,
      totalValue,
    }
  })
}

function executionTime(row: any): string | null {
  return dateOnly(row?.filled_at ?? row?.executed_at ?? row?.submitted_at ?? row?.created_at ?? row?.date ?? row?.trade_date)
}

function buildExecutionMarkers(orders: unknown = [], pendingBuys: unknown = [], fallbackTime?: string): SeriesMarker<Time>[] {
  const orderRows = paperOrdersFromPayload(orders)
  const pendingRows = paperPendingBuysFromPayload(pendingBuys)
  const orderMarkers = orderRows
    .map((order, index): SeriesMarker<Time> | null => {
      const time = executionTime(order)
      if (!time) return null
      const side = String(order?.side ?? order?.action ?? order?.status ?? '').toLowerCase()
      const isSell = side.includes('sell')
      const isBlocked = String(order?.status ?? order?.execution_status ?? '').toLowerCase().includes('cancel')

      return {
        id: `order-${index}-${time}`,
        time,
        position: isSell ? 'aboveBar' : 'belowBar',
        shape: isBlocked ? 'circle' : isSell ? 'arrowDown' : 'arrowUp',
        color: isBlocked ? '#fbbf24' : isSell ? '#34d399' : '#fb7185',
        size: 0.8,
      } satisfies SeriesMarker<Time>
    })
    .filter((marker): marker is SeriesMarker<Time> => marker !== null)

  const pendingMarkers = pendingRows.slice(0, 20).map((buy, index) => ({
    id: `pending-${index}-${executionTime(buy) ?? fallbackTime ?? 'latest'}`,
    time: executionTime(buy) ?? fallbackTime ?? new Date().toISOString().slice(0, 10),
    position: 'belowBar',
    shape: 'circle',
    color: '#38bdf8',
    size: 0.65,
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

function latestBenchmarkReturn(points: PerformancePoint[], key: BenchmarkKey): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = points[index]?.benchmarks[key]
    if (value != null) return value
  }
  return null
}

function formatPct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 'n/a'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
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
  const visibleBenchmarks = useMemo(
    () => BENCHMARK_SERIES.filter((item) => points.some((point) => point.benchmarks[item.key] != null)),
    [points],
  )

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

    for (const benchmark of visibleBenchmarks) {
      const series = chart.addSeries(LineSeries, {
        color: benchmark.color,
        lineWidth: benchmark.width,
        lineStyle: benchmark.lineStyle,
        priceLineVisible: false,
        title: benchmark.label,
      })
      series.setData(points
        .filter((point) => point.benchmarks[benchmark.key] != null)
        .map((point) => ({ time: point.time, value: point.benchmarks[benchmark.key] ?? 0 })))
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
  }, [latest?.bot, loading, markers, points, visibleBenchmarks])

  if (loading) return <EmptyPanel message="Paper performance API 載入中，正在整理資產曲線。" />
  if (!points.length) return <EmptyPanel message="No performance data yet. Chart will appear after the first trading day." />

  return (
    <section className="overflow-hidden border border-[#263247] bg-[#0f151d]/96 shadow-[0_18px_60px_rgba(0,0,0,0.18)]">
      <header className="grid gap-3 border-b border-[#263247] bg-[#070a10] p-3 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-center">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#d6a85f]">Paper Trading Visual Workbench</p>
          <h2 className="mt-1 text-lg font-semibold text-[#f2ead8]">資產曲線與基準比較</h2>
          <p className="mt-1 text-xs leading-5 text-[#9badbf]">
            Bot equity、0050/TWII 與 ETF benchmark 同軸比較；買賣事件改為無文字標記，避免遮住曲線。
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
          <div className="border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-rose-200">bot {formatPct(latest?.bot)}</div>
          <div className="border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-emerald-200">mdd {maxDrawdown.toFixed(2)}%</div>
          <div className="border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-sky-200">bench {visibleBenchmarks.length}</div>
        </div>
      </header>

      <div className="border-b border-[#263247] bg-[#070a10] px-3 py-2">
        <div className="flex flex-wrap items-center gap-1">
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
        <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px]">
          <span className="inline-flex items-center gap-1 rounded-full border border-rose-400/20 px-2 py-1 text-rose-200">
            <span className="h-2 w-2 rounded-full bg-rose-400" /> BOT {formatPct(latest?.bot)}
          </span>
          {BENCHMARK_SERIES.map((item) => {
            const value = latestBenchmarkReturn(points, item.key)
            const active = value != null
            return (
              <span
                key={item.key}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 ${
                  active ? 'border-slate-500/30 text-slate-200' : 'border-slate-700/40 text-slate-600'
                }`}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: active ? item.color : '#475569' }} />
                {item.label} {formatPct(value)}
              </span>
            )
          })}
        </div>
      </div>

      <div ref={containerRef} className="min-h-[340px] w-full bg-[#070a10]" />
    </section>
  )
}
