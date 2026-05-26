import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type ChartOptions,
  type DeepPartial,
  type IChartApi,
  type Time,
} from 'lightweight-charts'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { stocksApi } from '@/lib/api'
import {
  brokerFlowWindowSummary,
  buildBrokerFlowLine,
  buildChipFlowHistogram,
  latestChipFlowSummary,
  normalizeBrokerFlowRows,
  normalizeChipFlowRows,
} from '@/lib/chipFlowSeries'
import {
  buildAtrBandSeries,
  buildTradingPlanLevels,
  normalizeOhlcvRows,
} from '@/lib/tradingPlanLevels'

const RANGES = [
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
]

const MA_CONFIGS = [
  { period: 5, color: '#f59e0b', label: 'MA5' },
  { period: 10, color: '#ec4899', label: 'MA10' },
  { period: 20, color: '#3b82f6', label: 'MA20' },
  { period: 60, color: '#8b5cf6', label: 'MA60' },
  { period: 120, color: '#14b8a6', label: 'MA120' },
  { period: 240, color: '#f97316', label: 'MA240' },
]

function chartOptions(width: number): DeepPartial<ChartOptions> {
  return {
    width,
    height: 360,
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: '#94a3b8',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    },
    grid: {
      vertLines: { color: 'rgba(148, 163, 184, 0.08)' },
      horzLines: { color: 'rgba(148, 163, 184, 0.10)' },
    },
    rightPriceScale: {
      borderColor: 'rgba(148, 163, 184, 0.18)',
      scaleMargins: { top: 0.08, bottom: 0.18 },
    },
    timeScale: {
      borderColor: 'rgba(148, 163, 184, 0.18)',
      timeVisible: false,
      secondsVisible: false,
    },
    crosshair: {
      mode: CrosshairMode.MagnetOHLC,
      horzLine: { color: 'rgba(56, 189, 248, 0.28)' },
      vertLine: { color: 'rgba(56, 189, 248, 0.28)' },
    },
  }
}

function rowTime(row: any): Time {
  return String(row?.date ?? '').slice(0, 10) as Time
}

function fmtPrice(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '-'
  return Number(value).toFixed(2).replace(/\.?0+$/, '')
}

function fmtLots(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '-'
  return `${Number(value) > 0 ? '+' : ''}${Math.round(Number(value)).toLocaleString()}張`
}

function movingAverage(rows: any[], period: number) {
  return rows
    .map((row, index) => {
      if (index < period - 1) return null
      const window = rows.slice(index - period + 1, index + 1)
      const closes = window.map((item) => Number(item.close)).filter(Number.isFinite)
      if (closes.length !== period) return null
      return {
        time: rowTime(row),
        value: Math.round((closes.reduce((sum, value) => sum + value, 0) / period) * 100) / 100,
      }
    })
    .filter(Boolean) as Array<{ time: Time; value: number }>
}

export default function CandlestickChart({ stockId }: { stockId: number }) {
  const [days, setDays] = useState(90)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)

  const { data: prices = [], isLoading } = useQuery({
    queryKey: ['stocks', stockId, 'prices', days],
    queryFn: () => stocksApi.prices(stockId, days + 240),
    enabled: !!stockId,
  })

  const { data: indicators = [] } = useQuery({
    queryKey: ['stocks', stockId, 'indicators', days],
    queryFn: () => stocksApi.indicators(stockId, days + 240),
    enabled: !!stockId,
  })

  const { data: chips = [] } = useQuery({
    queryKey: ['stocks', stockId, 'chips', days],
    queryFn: () => stocksApi.chips(stockId, days + 20),
    enabled: !!stockId,
  })

  const { data: brokerFlowRows = [] } = useQuery({
    queryKey: ['stocks', stockId, 'broker-flow', days],
    queryFn: () => stocksApi.brokerFlow(stockId, days + 20),
    enabled: !!stockId,
  })

  const {
    candles,
    volume,
    maSeries,
    atrBand,
    sarData,
    chipFlow,
    brokerFlow,
    chipSummary,
    brokerSummary,
    planLevels,
  } = useMemo(() => {
    const allRows = normalizeOhlcvRows(prices as any[])
    const displayRows = allRows.slice(-days)
    const displayDates = new Set(displayRows.map((row) => row.date))
    const indicatorByDate = new Map(
      (indicators as any[]).map((row) => [String(row?.date ?? '').slice(0, 10), row]),
    )
    const chipRows = normalizeChipFlowRows(chips as any[])
    const brokerRows = normalizeBrokerFlowRows(brokerFlowRows as any[])
    return {
      candles: displayRows.map((row) => ({
        time: rowTime(row),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
      })),
      volume: displayRows.map((row) => {
        const open = Number(row.open)
        const close = Number(row.close)
        const value = Number(row.volume)
        return {
          time: rowTime(row),
          value: Number.isFinite(value) ? value : 0,
          color: close >= open ? 'rgba(239, 68, 68, 0.30)' : 'rgba(16, 185, 129, 0.30)',
        }
      }),
      maSeries: MA_CONFIGS
        .filter((ma) => ma.period <= days)
        .map((ma) => ({ ...ma, data: movingAverage(allRows, ma.period).slice(-days) })),
      atrBand: buildAtrBandSeries(allRows).filter((point) => displayDates.has(point.time)),
      sarData: displayRows
        .map((row) => {
          const indicator = indicatorByDate.get(row.date)
          const value = Number(indicator?.parabolicSar ?? indicator?.parabolic_sar)
          return Number.isFinite(value) ? { time: rowTime(row), value } : null
        })
        .filter(Boolean) as Array<{ time: Time; value: number }>,
      chipFlow: buildChipFlowHistogram(chipRows).filter((point) => displayDates.has(String(point.time))),
      brokerFlow: buildBrokerFlowLine(brokerRows).filter((point) => displayDates.has(String(point.time))),
      chipSummary: latestChipFlowSummary(chipRows),
      brokerSummary: brokerFlowWindowSummary(brokerRows, 5),
      planLevels: buildTradingPlanLevels(allRows.slice(-Math.max(days, 60))),
    }
  }, [prices, indicators, chips, brokerFlowRows, days])

  useEffect(() => {
    const container = containerRef.current
    if (!container || candles.length === 0) return

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
    candleSeries.setData(candles)

    if (volume.length) {
      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        priceLineVisible: false,
        lastValueVisible: false,
      }, 1)
      volumeSeries.setData(volume)
    }

    if (chipFlow.length) {
      const chipFlowSeries = chart.addSeries(HistogramSeries, {
        priceScaleId: '',
        priceLineVisible: false,
        lastValueVisible: false,
      }, 2)
      chipFlowSeries.setData(chipFlow)
    }

    if (brokerFlow.length) {
      const brokerFlowSeries = chart.addSeries(LineSeries, {
        color: '#a78bfa',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      }, 2)
      brokerFlowSeries.setData(brokerFlow)
    }

    for (const ma of maSeries) {
      const series = chart.addSeries(LineSeries, {
        color: ma.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      series.setData(ma.data)
    }

    if (atrBand.length) {
      const atrUpperSeries = chart.addSeries(LineSeries, {
        color: 'rgba(244, 63, 94, 0.55)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      atrUpperSeries.setData(atrBand.map((point) => ({ time: point.time as Time, value: point.upper })))

      const atrLowerSeries = chart.addSeries(LineSeries, {
        color: 'rgba(16, 185, 129, 0.55)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      atrLowerSeries.setData(atrBand.map((point) => ({ time: point.time as Time, value: point.lower })))
    }

    if (sarData.length) {
      const sarSeries = chart.addSeries(LineSeries, {
        color: '#facc15',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      sarSeries.setData(sarData)
    }

    const priceLines = [
      { price: planLevels?.resistance, title: '前高壓力', color: '#f59e0b' },
      { price: planLevels?.confirmation, title: '轉強確認', color: '#38bdf8' },
      { price: planLevels?.support, title: '關鍵支撐', color: '#10b981' },
      { price: planLevels?.volumeNode, title: '量能節點', color: '#a78bfa' },
      { price: planLevels?.atrLower, title: 'ATR 防守', color: '#f43f5e' },
    ]
    for (const line of priceLines) {
      if (!Number.isFinite(Number(line.price))) continue
      candleSeries.createPriceLine({
        price: Number(line.price),
        color: line.color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: line.title,
      })
    }

    chart.panes()[1]?.setHeight(72)
    chart.panes()[2]?.setHeight(72)
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
  }, [candles, volume, maSeries, atrBand, sarData, chipFlow, brokerFlow, planLevels])

  if (isLoading) return <Skeleton className="h-96 w-full" />
  if (!candles.length) return <p className="p-4 text-sm text-muted-foreground">暫無 K 線資料</p>

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {RANGES.map((range) => (
            <Button
              key={range.label}
              size="sm"
              variant={days === range.days ? 'default' : 'ghost'}
              className="h-7 px-2.5 text-xs"
              onClick={() => setDays(range.days)}
            >
              {range.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
          {MA_CONFIGS.filter((ma) => ma.period <= days).map((ma) => (
            <span key={ma.label} className="font-mono" style={{ color: ma.color }}>{ma.label}</span>
          ))}
        </div>
      </div>
      <div ref={containerRef} className="h-[360px] w-full rounded-md border border-border/50 bg-background/50" />
      {planLevels && (
        <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground sm:grid-cols-5">
          <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 font-mono text-amber-300">壓力 {fmtPrice(planLevels.resistance)}</span>
          <span className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-1 font-mono text-sky-300">轉強 {fmtPrice(planLevels.confirmation)}</span>
          <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 font-mono text-emerald-300">支撐 {fmtPrice(planLevels.support)}</span>
          <span className="rounded border border-violet-500/30 bg-violet-500/10 px-2 py-1 font-mono text-violet-300">量能 {fmtPrice(planLevels.volumeNode)}</span>
          <span className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 font-mono text-rose-300">ATR防守 {fmtPrice(planLevels.atrLower)}</span>
        </div>
      )}
      {chipSummary && (
        <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground sm:grid-cols-4">
          <span className={`rounded border px-2 py-1 font-mono ${chipSummary.totalLots >= 0 ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'}`}>
            法人 {fmtLots(chipSummary.totalLots)}
          </span>
          <span className="rounded border border-border/50 px-2 py-1 font-mono">外資 {fmtLots(chipSummary.foreignLots)}</span>
          <span className="rounded border border-border/50 px-2 py-1 font-mono">投信 {fmtLots(chipSummary.trustLots)}</span>
          <span className="rounded border border-border/50 px-2 py-1 font-mono">自營 {fmtLots(chipSummary.dealerLots)}</span>
        </div>
      )}
      {brokerSummary && (
        <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground sm:grid-cols-4">
          <span className={`rounded border px-2 py-1 font-mono ${brokerSummary.netLots >= 0 ? 'border-violet-500/30 bg-violet-500/10 text-violet-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'}`}>
            券商{brokerSummary.windowDays}日 {fmtLots(brokerSummary.netLots)}
          </span>
          <span className="rounded border border-border/50 px-2 py-1 font-mono">券商數 {brokerSummary.brokerCount ?? '-'}</span>
          <span className="rounded border border-border/50 px-2 py-1 font-mono">集中度 {brokerSummary.concentration == null ? '-' : brokerSummary.concentration.toFixed(2)}</span>
          <span className="rounded border border-violet-500/30 bg-violet-500/10 px-2 py-1 font-mono text-violet-300">分點線</span>
        </div>
      )}
    </div>
  )
}
