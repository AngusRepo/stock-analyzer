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
import type { ResearchExperiment, StrategyDryRunResponse, StrategySpec } from '@/lib/api'

type StrategyExperimentTimelineProps = {
  specs: StrategySpec[]
  dryRun?: StrategyDryRunResponse | null
  experiments: ResearchExperiment[]
}

function chartOptions(width: number): DeepPartial<ChartOptions> {
  return {
    width,
    height: 340,
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: '#0d070c' },
      textColor: '#a88498',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    },
    grid: {
      vertLines: { color: 'rgba(168, 132, 152, 0.10)' },
      horzLines: { color: 'rgba(168, 132, 152, 0.10)' },
    },
    rightPriceScale: { borderColor: 'rgba(244, 114, 182, 0.22)' },
    timeScale: { borderColor: 'rgba(244, 114, 182, 0.22)' },
  }
}

function pseudoTime(index: number, total: number): string {
  const day = new Date()
  day.setDate(day.getDate() - Math.max(0, total - index - 1))
  return day.toISOString().slice(0, 10)
}

function dryRunSeries(specs: StrategySpec[], dryRun?: StrategyDryRunResponse | null) {
  const resultBySpec = new Map((dryRun?.results ?? []).map((row) => [row.specId, row]))
  return specs.map((spec, index) => {
    const result = resultBySpec.get(spec.id)
    return {
      time: pseudoTime(index, Math.max(1, specs.length)),
      value: Number(result?.matchRate ?? 0),
      spec,
      result,
    }
  })
}

function experimentMarkers(experiments: ResearchExperiment[]): SeriesMarker<Time>[] {
  return experiments.slice(0, 30).map((experiment, index) => {
    const status = String(experiment.status ?? 'queued')
    const blocked = /block|fail|attention/i.test(status)
    return {
      time: experiment.created_at?.slice(0, 10) || pseudoTime(index, Math.max(1, experiments.length)),
      position: blocked ? 'aboveBar' : 'belowBar',
      shape: blocked ? 'circle' : 'arrowUp',
      color: blocked ? '#f87171' : '#34d399',
      text: `${experiment.id} ${status}`,
    }
  })
}

function WorkbenchSkeleton() {
  const bars = [0.22, 0.38, 0.31, 0.58, 0.47, 0.64, 0.51, 0.72, 0.44, 0.61]

  return (
    <section className="sv-content-card overflow-hidden rounded-xl shadow-[0_18px_60px_rgba(0,0,0,0.26)]">
      <header className="grid gap-3 border-b border-[color:var(--sv-panel-border-soft)] bg-[color:var(--sv-panel-deep)] p-4 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-center">
        <div>
          <p className="sv-accent-text font-mono text-[10px] uppercase tracking-[0.2em]">Strategy Visual Workbench</p>
          <h2 className="sv-title-text mt-1 text-xl font-semibold">策略實驗圖面等待資料</h2>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-[color:var(--sv-text-soft)]">
            strategy API 目前沒有回傳可用 specs，所以先顯示工作台骨架。之後這裡會承接 dry-run 命中率、樣本量與 experiment marker，讓策略狀態先用圖面判讀，再下鑽看細節。
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
          <div className="border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-amber-200">specs 0</div>
          <div className="border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-sky-200">matched 0</div>
          <div className="border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-rose-200">api degraded</div>
        </div>
      </header>

      <div className="grid gap-px bg-[color:var(--sv-panel-border-soft)] lg:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.6fr)]">
        <div className="relative min-h-[360px] overflow-hidden bg-[color:var(--sv-panel-deep)] p-4">
          <div className="absolute inset-0 opacity-55 [background-image:linear-gradient(rgba(244,114,182,0.10)_1px,transparent_1px),linear-gradient(90deg,rgba(168,132,152,0.08)_1px,transparent_1px)] [background-size:42px_42px]" />
          <div className="relative flex h-[320px] items-end gap-3 border-l border-b border-[color:var(--sv-panel-border)] px-4 pb-6">
            {bars.map((height, index) => (
              <div key={index} className="flex flex-1 flex-col items-center gap-2">
                <div
                  className="w-full border border-[color:var(--sv-accent-border)] bg-[color:var(--sv-accent-soft)]"
                  style={{ height: `${Math.max(12, height * 210)}px` }}
                />
                <div className="h-1.5 w-1.5 bg-[color:var(--sv-accent)]" />
              </div>
            ))}
          </div>
          <div className="sv-muted-text relative mt-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em]">
            <span>dry-run match rate</span>
            <span>sample histogram</span>
            <span>experiment markers</span>
          </div>
        </div>

        <aside className="bg-[color:var(--sv-panel-deep)] p-4">
          <p className="sv-accent-text font-mono text-[10px] uppercase tracking-[0.18em]">operator focus</p>
          <div className="mt-3 space-y-2 text-xs">
            {[
              ['1', '確認 specs API 是否正常回傳'],
              ['2', '檢查 dry-run 命中率與 sample size'],
              ['3', '連回 evaluation plan / registry'],
            ].map(([step, text]) => (
              <div key={step} className="sv-content-card grid grid-cols-[28px_1fr] items-center gap-2 p-2 text-[color:var(--sv-text-soft)]">
                <span className="grid h-6 w-6 place-items-center bg-[color:var(--sv-panel-raised)] font-mono text-[color:var(--sv-accent)]">{step}</span>
                <span>{text}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </section>
  )
}

export default function StrategyExperimentTimeline({ specs, dryRun, experiments }: StrategyExperimentTimelineProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const points = useMemo(() => dryRunSeries(specs, dryRun), [specs, dryRun])
  const markers = useMemo(() => experimentMarkers(experiments), [experiments])
  const matched = dryRun?.results.reduce((sum, row) => sum + row.matched, 0) ?? 0
  const samples = dryRun?.results.reduce((sum, row) => sum + row.sampleSize, 0) ?? 0

  useEffect(() => {
    const container = containerRef.current
    if (!container || !points.length) return

    const chart = createChart(container, chartOptions(container.clientWidth || 720))
    chartRef.current = chart

    const matchSeries = chart.addSeries(LineSeries, {
      color: '#facc15',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'match rate',
    })
    matchSeries.setData(points.map((point) => ({ time: point.time, value: point.value })))
    if (markers.length) createSeriesMarkers(matchSeries, markers)

    const sampleSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      color: '#38bdf8',
    }, 1)
    sampleSeries.setData(points.map((point) => ({
      time: point.time,
      value: Number(point.result?.sampleSize ?? 0),
      color: point.result?.valid === false ? '#f87171' : '#38bdf8',
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
  }, [markers, points])

  if (!specs.length) return <WorkbenchSkeleton />

  return (
    <section className="sv-content-card overflow-hidden rounded-xl">
      <header className="grid gap-3 border-b border-[color:var(--sv-panel-border-soft)] bg-[color:var(--sv-panel-deep)] p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div>
          <p className="sv-accent-text font-mono text-[10px] uppercase tracking-[0.18em]">Strategy Visual Workbench</p>
          <h2 className="sv-title-text mt-1 text-base font-semibold">Dry-run match rate and experiment registry markers</h2>
        </div>
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <div className="border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-amber-200">specs {specs.length}</div>
          <div className="border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-sky-200">matched {matched}</div>
          <div className="border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-emerald-200">samples {samples}</div>
        </div>
      </header>
      <div ref={containerRef} className="min-h-[340px] w-full bg-[color:var(--sv-panel-deep)]" />
    </section>
  )
}
