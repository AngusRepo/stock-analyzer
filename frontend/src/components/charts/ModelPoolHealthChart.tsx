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
import type { ModelPoolLineageModel, ModelArtifactPromotionQueueResponse } from '@/lib/api'
import { ChartWorkbenchShell, DecisionPacketCell } from '@/components/workstation/VisualPrimitives'

type ModelEntry = [string, ModelPoolLineageModel]

type ModelPoolHealthChartProps = {
  models: ModelEntry[]
  queue?: ModelArtifactPromotionQueueResponse
  weakIc: number
  sampleGaps: number
}

const COLORS = ['#7dd3fc', '#facc15', '#a7f3d0', '#fda4af', '#c4b5fd', '#f9a8d4', '#fdba74', '#93c5fd']

function isServingAlpha(model: ModelPoolLineageModel): boolean {
  return model.status === 'active' || model.status === 'degraded'
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
    rightPriceScale: { borderColor: 'rgba(148, 163, 184, 0.18)' },
    timeScale: { borderColor: 'rgba(148, 163, 184, 0.18)' },
  }
}

function timeAgo(index: number, total: number): string {
  const day = new Date()
  day.setDate(day.getDate() - Math.max(0, total - index - 1) * 7)
  return day.toISOString().slice(0, 10)
}

function weeklyPoints(model: ModelPoolLineageModel) {
  const weekly = (model.weekly_ic ?? []).filter((value) => Number.isFinite(Number(value))).map(Number)
  if (weekly.length) return weekly.map((value, index) => ({ time: timeAgo(index, weekly.length), value }))
  const fallback = Number(model.ic_4w_avg ?? model.rolling_ic)
  return Number.isFinite(fallback) ? [{ time: timeAgo(0, 1), value: fallback }] : []
}

function samplePoints(models: ModelEntry[]) {
  return models.slice(0, 8).map(([name, model], index) => ({
    time: timeAgo(index, Math.max(1, Math.min(models.length, 8))),
    value: Math.max(0, Number(model.last_ic_sample_count ?? 0)),
    color: Number(model.last_ic_sample_count ?? 0) > 0 ? '#38bdf8' : '#f59e0b',
    model: name,
  }))
}

function lifecycleMarkers(models: ModelEntry[], queue?: ModelArtifactPromotionQueueResponse): SeriesMarker<Time>[] {
  const queueByModel = new Map((queue?.queue ?? []).map((row) => [row.model_name, row]))
  return models.slice(0, 8).flatMap(([name, model], index) => {
    const row = queueByModel.get(name)
    const status = row?.promotion_decision ?? model.lifecycle_diagnosis?.status ?? model.last_ic_status ?? model.status ?? 'watch'
    const blocked = /block|fail|weak|missing|mismatch/i.test(status)
    return [{
      time: timeAgo(index, Math.max(1, Math.min(models.length, 8))),
      position: blocked ? 'aboveBar' : 'belowBar',
      shape: blocked ? 'circle' : 'arrowUp',
      color: blocked ? '#f87171' : '#34d399',
      text: `${name} ${status}`,
    }]
  })
}

function ModelPoolSkeleton({ weakIc, sampleGaps }: { weakIc: number; sampleGaps: number }) {
  const bars = [0.64, 0.48, 0.72, 0.56, 0.38, 0.81, 0.44, 0.68]

  return (
    <section className="overflow-hidden border border-[#263247] bg-[#0f151d]/96 shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
      <header className="grid gap-3 border-b border-[#263247] bg-[#070a10] p-4 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-center">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-sky-300">ML Pool Visual Workbench</p>
          <h2 className="mt-1 text-xl font-semibold text-[#f2ead8]">模型池圖面等待 active lineage</h2>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-[#9badbf]">
            目前沒有可畫出的 active alpha model series。先保留 champion / challenger 的視覺工作台位置，後續會把 weekly IC、sample coverage 與 promotion marker 接進同一張圖。
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
          <div className="border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-sky-200">series 0</div>
          <div className="border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-amber-200">weak IC {weakIc}</div>
          <div className="border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-rose-200">sample gaps {sampleGaps}</div>
        </div>
      </header>
      <div className="grid gap-px bg-[#263247] lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.65fr)]">
        <div className="relative min-h-[340px] overflow-hidden bg-[#070a10] p-4">
          <div className="absolute inset-0 opacity-50 [background-image:linear-gradient(rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.06)_1px,transparent_1px)] [background-size:42px_42px]" />
          <div className="relative flex h-[290px] items-end gap-4 border-l border-b border-[#3a4659] px-4 pb-6">
            {bars.map((height, index) => (
              <div key={index} className="flex flex-1 flex-col items-center gap-2">
                <div className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                <div
                  className="w-full border border-sky-300/30 bg-sky-300/15"
                  style={{ height: `${Math.max(16, height * 210)}px` }}
                />
              </div>
            ))}
          </div>
          <div className="relative mt-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">
            <span>weekly IC</span>
            <span>sample coverage</span>
            <span>promotion markers</span>
          </div>
        </div>
        <aside className="bg-[#070a10] p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#d6a85f]">operator focus</p>
          <div className="mt-3 space-y-2 text-xs">
            {[
              ['1', '確認 lineage API 是否有 active models'],
              ['2', '補齊 weekly_ic / last_ic_sample_count'],
              ['3', '檢查 promotion queue 與 champion pointers'],
            ].map(([step, text]) => (
              <div key={step} className="grid grid-cols-[28px_1fr] items-center gap-2 border border-[#263247] bg-[#0f151d] p-2 text-[#c8d3df]">
                <span className="grid h-6 w-6 place-items-center bg-[#07131b] font-mono text-sky-200">{step}</span>
                <span>{text}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </section>
  )
}

export default function ModelPoolHealthChart({ models, queue, weakIc, sampleGaps }: ModelPoolHealthChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const servingModels = useMemo(() => models.filter(([, model]) => isServingAlpha(model)), [models])
  const visibleModels = useMemo(() => servingModels.slice(0, 8), [servingModels])
  const degradedCount = useMemo(() => servingModels.filter(([, model]) => model.status === 'degraded').length, [servingModels])
  const retiredCount = useMemo(() => models.filter(([, model]) => model.status === 'retired').length, [models])
  const shadowOrResearchCount = useMemo(() => models.filter(([, model]) => Boolean(model.challenger) || ['challenger', 'research'].includes(String(model.status))).length, [models])
  const samples = useMemo(() => samplePoints(visibleModels), [visibleModels])
  const markers = useMemo(() => lifecycleMarkers(visibleModels, queue), [visibleModels, queue])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !visibleModels.length) return

    const chart = createChart(container, chartOptions(container.clientWidth || 720))
    chartRef.current = chart

    let anchorSeries: ReturnType<typeof chart.addSeries> | null = null
    visibleModels.forEach(([name, model], index) => {
      const points = weeklyPoints(model)
      if (!points.length) return
      const series = chart.addSeries(LineSeries, {
        color: COLORS[index % COLORS.length],
        lineWidth: index === 0 ? 2 : 1,
        priceLineVisible: false,
        title: name,
      })
      series.setData(points)
      if (!anchorSeries) anchorSeries = series
    })

    if (anchorSeries && markers.length) {
      createSeriesMarkers(anchorSeries, markers)
    }

    if (samples.length) {
      const sampleSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        color: '#38bdf8',
      }, 1)
      sampleSeries.setData(samples)
    }

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
  }, [markers, samples, visibleModels])

  if (!visibleModels.length) {
    return <ModelPoolSkeleton weakIc={weakIc} sampleGaps={sampleGaps} />
  }

  return (
    <ChartWorkbenchShell
      kicker="ML Pool / Serving Health"
      title="Production alpha slots evidence surface"
      meta={
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <DecisionPacketCell title="serving" value={visibleModels.length} detail={`${degradedCount} degraded low-weight`} tone={degradedCount ? 'warn' : 'ok'} />
          <DecisionPacketCell title="non-serving" value={retiredCount} detail={`${shadowOrResearchCount} shadow or research`} tone="neutral" />
          <DecisionPacketCell title="quality" value={`IC ${weakIc}`} detail={`sample gaps ${sampleGaps}`} tone={weakIc || sampleGaps ? 'warn' : 'ok'} />
        </div>
      }
    >
      <div ref={containerRef} className="min-h-[340px] w-full bg-[#070a10]" />
    </ChartWorkbenchShell>
  )
}
