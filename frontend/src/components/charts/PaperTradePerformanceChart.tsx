import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AreaSeries,
  ColorType,
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
import { paperOrdersFromPayload, paperPendingBuysFromPayload } from '@/lib/paperPayload'
import {
  benchmarkBases,
  benchmarkLineData,
  botLineData,
  buildPaperTradePerformancePoints,
  periodMaxDrawdown,
  dateOnly,
  gapBandData,
  periodRows,
  sortedSnapshots,
  type BenchmarkKey,
  type PerformancePoint,
} from '@/lib/paperPerformanceSeries'
import { TW_COLORS, priceToneClass } from '@/lib/colorTokens'
import { formatDateShort, formatSignedPct } from '@/lib/format'
import { DataState } from '@/components/ui/data-state'

type PaperTradePerformanceChartProps = {
  pnl?: any
  orders?: unknown
  pendingBuys?: unknown
  loading?: boolean
  /** /paper/pnl 讀取失敗：顯示讀取失敗，不要當成「還沒有資產紀錄」。 */
  error?: unknown
  onRetry?: () => void
}

const PERIODS = [
  { key: '1W', label: '1W' },
  { key: '1M', label: '1M' },
  { key: '3M', label: '3M' },
  { key: 'ALL', label: 'ALL' },
] as const

// 11/26 Wei 定案：只和大盤（TWII）與 0050 比；差距帶只畫 bot↔0050。
// 基準線用中性系列色（不是漲跌、也不是狀態），避免和 bot 的紅綠混讀。
const BENCHMARK_SERIES: Array<{
  key: BenchmarkKey
  label: string
  color: string
  lineStyle: LineStyle
  width: 1 | 2
}> = [
  { key: '0050', label: '0050', color: '#a78bfa', lineStyle: LineStyle.Solid, width: 2 },
  { key: 'TWII', label: '大盤 TWII', color: '#94a3b8', lineStyle: LineStyle.Dashed, width: 1 },
]
const CHART_BG = '#0a0b0f'
const CHART_HEIGHT = 280

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
        color: isBlocked ? TW_COLORS.warn : isSell ? TW_COLORS.down : TW_COLORS.up,
        size: 0.8,
      } satisfies SeriesMarker<Time>
    })
    .filter((marker): marker is SeriesMarker<Time> => marker !== null)

  const pendingMarkers = pendingRows.slice(0, 20).map((buy, index) => ({
    id: `pending-${index}-${executionTime(buy) ?? fallbackTime ?? 'latest'}`,
    time: executionTime(buy) ?? fallbackTime ?? new Date().toISOString().slice(0, 10),
    position: 'belowBar',
    shape: 'circle',
    color: TW_COLORS.ok,
    size: 0.65,
  } satisfies SeriesMarker<Time>))

  return [...orderMarkers, ...pendingMarkers].slice(-80)
}

function chartOptions(width: number): DeepPartial<ChartOptions> {
  return {
    width,
    height: CHART_HEIGHT,
    layout: {
      background: { type: ColorType.Solid, color: CHART_BG },
      textColor: '#8992a3',
      fontFamily: 'Segoe UI Variable, PingFang TC, Microsoft JhengHei, system-ui, sans-serif',
    },
    // 差距帶的下緣用背景色蓋掉下方，格線會被蓋得一段一段，所以不畫格線。
    grid: {
      vertLines: { visible: false },
      horzLines: { visible: false },
    },
    rightPriceScale: {
      borderColor: 'rgba(255, 255, 255, 0.035)',
      scaleMargins: { top: 0.08, bottom: 0.08 },
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

function latestBenchmarkReturn(points: PerformancePoint[], key: BenchmarkKey): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = points[index]?.benchmarks[key]
    if (value != null) return value
  }
  return null
}

function EmptyPanel({ kind, message, code, onRetry }: { kind: 'loading' | 'empty' | 'error'; message: string; code?: string; onRetry?: () => void }) {
  return (
    <div className="grid min-h-[200px] place-items-center">
      <DataState kind={kind} title={message} code={code} onRetry={onRetry} />
    </div>
  )
}

export default function PaperTradePerformanceChart({ pnl, orders = [], pendingBuys = [], loading, error, onRetry }: PaperTradePerformanceChartProps) {
  const [period, setPeriod] = useState<string>('ALL')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const points = useMemo(() => buildPaperTradePerformancePoints(pnl, period), [period, pnl])
  const bases = useMemo(() => benchmarkBases(periodRows(sortedSnapshots(pnl), period)), [period, pnl])
  const markers = useMemo(() => buildExecutionMarkers(orders, pendingBuys, points[points.length - 1]?.time), [orders, pendingBuys, points])
  const latest = points[points.length - 1]
  const maxDrawdown = periodMaxDrawdown(points)
  const visibleBenchmarks = useMemo(
    () => BENCHMARK_SERIES.filter((item) => points.some((point) => point.benchmarks[item.key] != null)),
    [points],
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container || loading || !points.length) return

    const chart = createChart(container, chartOptions(container.clientWidth || 720))
    chartRef.current = chart

    // 先畫差距帶（較高者上色、較低者用背景色蓋掉），再把三條線疊在上面。
    const band = gapBandData(points, '0050', { lead: 'rgba(255, 77, 79, 0.22)', lag: 'rgba(34, 197, 94, 0.22)', background: CHART_BG })
    const bandOptions = { lineVisible: false, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false } as const
    chart.addSeries(AreaSeries, { ...bandOptions, topColor: 'transparent', bottomColor: 'transparent' }).setData(band.upper)
    chart.addSeries(AreaSeries, { ...bandOptions, topColor: CHART_BG, bottomColor: CHART_BG }).setData(band.lower)

    for (const benchmark of visibleBenchmarks) {
      const series = chart.addSeries(LineSeries, {
        color: benchmark.color,
        lineWidth: benchmark.width,
        lineStyle: benchmark.lineStyle,
        priceLineVisible: false,
        title: benchmark.label,
      })
      // Missing adj_close days are whitespace points so the line breaks instead of bridging the gap.
      series.setData(benchmarkLineData(points, benchmark.key))
    }

    const botSeries = chart.addSeries(LineSeries, {
      color: latest?.bot != null && latest.bot < 0 ? TW_COLORS.down : TW_COLORS.up,
      lineWidth: 2,
      priceLineVisible: false,
      title: '模擬帳戶',
    })
    botSeries.setData(botLineData(points))
    if (markers.length) createSeriesMarkers(botSeries, markers)

    chart.timeScale().fitContent()
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) chart.applyOptions({ width: Math.max(320, Math.floor(entry.contentRect.width)), height: CHART_HEIGHT })
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [latest?.bot, loading, markers, points, visibleBenchmarks])

  if (loading) return <EmptyPanel kind="loading" message="資產曲線載入中" />
  if (error && !points.length) return <EmptyPanel kind="error" message="資產曲線讀取失敗" code={error instanceof Error ? error.message : undefined} onRetry={onRetry} />
  if (!points.length) return <EmptyPanel kind="empty" message="還沒有資產紀錄；第一個交易日收盤後出現" />

  const start = points[0]?.time
  return (
    <section className="overflow-hidden" data-testid="paper-performance-chart">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 sv-num text-[11px]">
        <span className="sr-only">Paper Trading Visual Workbench</span>
        <div className="flex items-center gap-0.5">
          {PERIODS.map((row) => (
            <button
              key={row.key}
              type="button"
              onClick={() => setPeriod(row.key)}
              className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                period === row.key ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {row.label}
            </button>
          ))}
        </div>
        <span className="text-muted-foreground" title="bot 與基準都從期間第一個資產紀錄日起算">起點 {start ? formatDateShort(start) : '—'}</span>
        <span className="inline-flex items-center gap-1">
          <span className="h-0.5 w-3" style={{ backgroundColor: (latest?.bot ?? 0) < 0 ? TW_COLORS.down : TW_COLORS.up }} />
          模擬帳戶 <b className={priceToneClass(latest?.bot)}>{formatSignedPct(latest?.bot)}</b>
        </span>
        {BENCHMARK_SERIES.map((item) => {
          const value = latestBenchmarkReturn(points, item.key)
          const base = bases[item.key]
          const late = base && !base.aligned
          const gap = value != null && latest?.bot != null && !late ? latest.bot - value : null
          return (
            <span
              key={item.key}
              className={`inline-flex items-center gap-1 ${value != null ? 'text-foreground' : 'text-muted-foreground'}`}
              title={late ? `${item.label} 在起點日沒有資料，從 ${base.startDate} 起算，與模擬帳戶不同區間，不算差距` : `${item.label} 與模擬帳戶同起點`}
            >
              <span className="h-0.5 w-3" style={{ backgroundColor: value != null ? item.color : '#475569' }} />
              {item.label} <b className={priceToneClass(value)}>{formatSignedPct(value)}</b>
              {gap != null && <span className={priceToneClass(gap)}>（差 {gap >= 0 ? '+' : ''}{gap.toFixed(1)} pt）</span>}
              {late && <span className="text-warn">自 {formatDateShort(base.startDate)} 起算</span>}
            </span>
          )
        })}
        <span className="ml-auto" title="所選期間內模擬帳戶總值從期間最高點的最大跌幅（不含期間之前的回撤）">期間 MDD <b className={maxDrawdown != null && maxDrawdown < 0 ? 'text-down' : 'text-muted-foreground'}>{maxDrawdown == null ? '—' : formatSignedPct(maxDrawdown)}</b></span>
      </header>

      <div ref={containerRef} className="h-[280px] min-h-[280px] max-h-[280px] w-full overflow-hidden bg-[#0a0b0f]" />
      <div className="flex gap-3 px-3 py-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><i className="inline-block h-2 w-3 rounded-sm" style={{ background: 'rgba(255, 77, 79, 0.35)' }} />領先 0050</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block h-2 w-3 rounded-sm" style={{ background: 'rgba(34, 197, 94, 0.35)' }} />落後 0050</span>
      </div>
    </section>
  )
}
