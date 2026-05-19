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

type DailyPipelineRunLaneProps = {
  recommendations?: any[]
  pendingBuys?: any[]
  quadrantFilters?: any[]
  recDate?: string
  loading?: boolean
  universeTotal?: number
}

type PipelineStage = {
  id: string
  label: string
  time: string
  count: number
  attrition: number
  color: string
  status: 'ok' | 'warn' | 'blocked'
  note: string
}

function signalOf(row: any): string {
  return String(row?.signal ?? row?.ml_signal ?? '').toUpperCase()
}

function stageTime(index: number, anchor?: string): string {
  const parsed = anchor ? new Date(anchor) : new Date()
  const base = Number.isNaN(parsed.getTime()) ? new Date() : parsed
  base.setDate(base.getDate() - 4 + index)
  return base.toISOString().slice(0, 10)
}

function stageColor(status: PipelineStage['status']): string {
  if (status === 'blocked') return '#fb7185'
  if (status === 'warn') return '#fbbf24'
  return '#38bdf8'
}

function blockedQuadrantCount(quadrantFilters: any[]): number {
  return quadrantFilters.filter((row) => {
    const action = String(row?.action ?? row?.status ?? '').toLowerCase()
    return action.includes('block') || action.includes('reject') || action.includes('exclude') || action.includes('排除')
  }).length
}

function buildPipelineStages(
  recommendations: any[],
  pendingBuys: any[],
  quadrantFilters: any[],
  recDate?: string,
  universeTotal = 882,
): PipelineStage[] {
  const mlBuyHold = recommendations.filter((row) => ['BUY', 'STRONG_BUY', 'HOLD'].includes(signalOf(row))).length
  const buySignals = recommendations.filter((row) => ['BUY', 'STRONG_BUY'].includes(signalOf(row))).length
  const qfBlocked = blockedQuadrantCount(quadrantFilters)
  const stages = [
    {
      id: 'universe',
      label: 'Universe',
      count: universeTotal,
      note: '可交易股票池',
    },
    {
      id: 'screener',
      label: 'Screener',
      count: recommendations.length,
      note: '多因子初篩通過',
    },
    {
      id: 'ml',
      label: 'ML Buy/Hold',
      count: mlBuyHold,
      note: `${buySignals} 檔 BUY / STRONG_BUY`,
    },
    {
      id: 'recommendation',
      label: 'Recommendation',
      count: Math.max(0, mlBuyHold - qfBlocked),
      note: qfBlocked ? `RRG / guardrail 排除 ${qfBlocked} 檔` : '推薦清單保留',
    },
    {
      id: 'paper_preview',
      label: 'Paper Preview',
      count: pendingBuys.length,
      note: pendingBuys.length ? '已進 pending buy' : '尚未產生 pending buy',
    },
  ]

  return stages.map((stage, index) => {
    const previous = index > 0 ? stages[index - 1].count : stage.count
    const status: PipelineStage['status'] =
      stage.id === 'paper_preview' && recommendations.length > 0 && stage.count === 0
        ? 'warn'
        : stage.id === 'recommendation' && qfBlocked > 0
          ? 'warn'
          : 'ok'

    return {
      ...stage,
      time: stageTime(index, recDate),
      attrition: Math.max(0, previous - stage.count),
      color: stageColor(status),
      status,
    }
  })
}

function buildMarkers(stages: PipelineStage[]): SeriesMarker<Time>[] {
  return stages
    .filter((stage) => stage.status !== 'ok' || stage.attrition > Math.max(8, stage.count))
    .map((stage) => ({
      time: stage.time,
      position: 'aboveBar',
      shape: stage.status === 'blocked' ? 'circle' : 'arrowDown',
      color: stage.color,
      text: `${stage.label} ${stage.status}`,
    }))
}

function chartOptions(width: number): DeepPartial<ChartOptions> {
  return {
    width,
    height: 320,
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
  const bars = [0.86, 0.56, 0.46, 0.32, 0.24]

  return (
    <section className="overflow-hidden border border-[#263247] bg-[#0f151d]/96">
      <header className="grid gap-3 border-b border-[#263247] bg-[#070a10] p-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-center">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#d6a85f]">Pipeline Visual Workbench</p>
          <h2 className="mt-1 text-xl font-semibold text-[#f2ead8]">每日流程圖面等待資料</h2>
          <p className="mt-2 text-xs leading-5 text-[#9badbf]">{message}</p>
        </div>
        <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
          <div className="border border-slate-500/25 bg-slate-500/10 px-3 py-2 text-slate-300">recs 0</div>
          <div className="border border-slate-500/25 bg-slate-500/10 px-3 py-2 text-slate-300">pending 0</div>
          <div className="border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-amber-200">loading</div>
        </div>
      </header>
      <div className="relative min-h-[280px] overflow-hidden bg-[#070a10] p-4">
        <div className="absolute inset-0 opacity-50 [background-image:linear-gradient(rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.06)_1px,transparent_1px)] [background-size:42px_42px]" />
        <div className="relative flex h-[230px] items-end gap-3 border-l border-b border-[#3a4659] px-4 pb-6">
          {bars.map((height, index) => (
            <div key={index} className="flex flex-1 flex-col items-center gap-2">
              <div
                className="w-full border border-[#d6a85f]/25 bg-[#d6a85f]/10"
                style={{ height: `${Math.max(18, height * 180)}px` }}
              />
              <div className="h-1.5 w-1.5 bg-sky-300" />
            </div>
          ))}
        </div>
        <div className="relative mt-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">
          <span>fetch</span>
          <span>screener</span>
          <span>ml</span>
          <span>decision</span>
          <span>paper</span>
        </div>
      </div>
    </section>
  )
}

export default function DailyPipelineRunLane({
  recommendations = [],
  pendingBuys = [],
  quadrantFilters = [],
  recDate,
  loading,
  universeTotal,
}: DailyPipelineRunLaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const stages = useMemo(
    () => buildPipelineStages(recommendations, pendingBuys, quadrantFilters, recDate, universeTotal),
    [pendingBuys, quadrantFilters, recDate, recommendations, universeTotal],
  )
  const markers = useMemo(() => buildMarkers(stages), [stages])
  const buySignals = recommendations.filter((row) => ['BUY', 'STRONG_BUY'].includes(signalOf(row))).length
  const holdSignals = recommendations.filter((row) => signalOf(row) === 'HOLD').length
  const qfBlocked = blockedQuadrantCount(quadrantFilters)

  useEffect(() => {
    const container = containerRef.current
    if (!container || loading || !stages.length) return

    const chart = createChart(container, chartOptions(container.clientWidth || 720))
    chartRef.current = chart

    const funnelSeries = chart.addSeries(LineSeries, {
      color: pendingBuys.length ? '#34d399' : recommendations.length ? '#fbbf24' : '#38bdf8',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'candidate funnel',
    })
    funnelSeries.setData(stages.map((stage) => ({ time: stage.time, value: stage.count })))
    if (markers.length) createSeriesMarkers(funnelSeries, markers)

    const attritionSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      color: '#d6a85f',
    }, 1)
    attritionSeries.setData(stages.map((stage) => ({
      time: stage.time,
      value: stage.attrition,
      color: stage.color,
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
  }, [loading, markers, pendingBuys.length, recommendations.length, stages])

  if (loading) return <EmptyWorkbench message="Pipeline API 載入中，先保留每日流程圖面位置。" />

  return (
    <section className="overflow-hidden border border-[#263247] bg-[#0f151d]/96 shadow-[0_18px_60px_rgba(0,0,0,0.20)]">
      <header className="grid gap-3 border-b border-[#263247] bg-[#070a10] p-4 lg:grid-cols-[minmax(0,1fr)_460px] lg:items-center">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#d6a85f]">Pipeline Visual Workbench</p>
          <h2 className="mt-1 text-xl font-semibold text-[#f2ead8]">候選漏斗與決策 run lane</h2>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-[#9badbf]">
            這張圖把每日 recommendations、ML signal、RRG filter 與 pending buy 轉成可掃描的候選漏斗；長條表示各階段 attrition / blocker，marker 指出需要人工確認的流程點。
          </p>
        </div>
        <div className="grid grid-cols-4 gap-2 font-mono text-[11px]">
          <div className="border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-sky-200">recs {recommendations.length}</div>
          <div className="border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-rose-200">buy {buySignals}</div>
          <div className="border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-amber-200">hold {holdSignals}</div>
          <div className="border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-emerald-200">pending {pendingBuys.length}</div>
        </div>
      </header>

      <div className="grid gap-px bg-[#263247] lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <div ref={containerRef} className="min-h-[320px] w-full bg-[#070a10]" />
        <aside className="bg-[#070a10] p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#d6a85f]">stage inspector</p>
          <div className="mt-3 space-y-2 text-xs">
            {stages.map((stage) => (
              <div key={stage.id} className="border border-[#263247] bg-[#0f151d] p-2 text-[#c8d3df]">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold">{stage.label}</span>
                  <span className="font-mono text-[10px]" style={{ color: stage.color }}>{stage.count}</span>
                </div>
                <p className="mt-1 font-mono text-[10px] text-[#70809b]">attrition {stage.attrition} / {stage.status}</p>
                <p className="mt-1 line-clamp-2 text-[#8b9bab]">{stage.note}</p>
              </div>
            ))}
            {qfBlocked > 0 && (
              <div className="border border-amber-400/25 bg-amber-400/10 p-2 text-amber-200">
                RRG / guardrail 目前排除 {qfBlocked} 檔；請在下方象限過濾結果追原因。
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  )
}
