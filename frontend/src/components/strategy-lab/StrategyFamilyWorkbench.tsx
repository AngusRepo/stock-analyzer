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
import type { ResearchExperimentsResponse, StrategyDryRunResponse, StrategyLearningResponse, StrategySpec } from '@/lib/api'

type StrategyFamilyId =
  | 'VOLATILITY_CONTRACTION_BREAKOUT'
  | 'TREND_RECLAIM_CONTINUATION'
  | 'SMART_MONEY_ACCUMULATION'
  | 'SMC_STRUCTURE_RECLAIM'
  | 'REVENUE_QUALITY_MOMENTUM'
  | 'SECTOR_ROTATION_CORE'

type StrategyFamilyDefinition = {
  id: StrategyFamilyId
  label: string
  layerRole: string
  objective: string
  factorHints: string[]
}

type StrategyFamilyWorkbenchProps = {
  specs: StrategySpec[]
  dryRun?: StrategyDryRunResponse | null
  learning?: StrategyLearningResponse | null
  experiments: ResearchExperimentsResponse['experiments']
}

const STRATEGY_FAMILIES: StrategyFamilyDefinition[] = [
  {
    id: 'VOLATILITY_CONTRACTION_BREAKOUT',
    label: 'Volatility Contraction',
    layerRole: 'L1 owner',
    objective: '找壓縮後放量突破，而不是單純高分股。',
    factorHints: ['BB squeeze', 'VCP', 'squeeze release', 'volume expansion'],
  },
  {
    id: 'TREND_RECLAIM_CONTINUATION',
    label: 'Trend Reclaim',
    layerRole: 'L1 owner',
    objective: '找趨勢修復後續攻，避免把下跌反彈誤當轉強。',
    factorHints: ['MA reclaim', 'RSI reclaim', 'MACD', 'ADX'],
  },
  {
    id: 'SMART_MONEY_ACCUMULATION',
    label: 'Smart Money',
    layerRole: 'L1 owner',
    objective: '找籌碼流與整理結構同時改善的股票。',
    factorHints: ['foreign flow', 'dealer flow', 'broker concentration', 'chip stability'],
  },
  {
    id: 'SMC_STRUCTURE_RECLAIM',
    label: 'SMC Structure',
    layerRole: 'L1 owner / L4 context',
    objective: '把 liquidity sweep、BOS/CHOCH、displacement 量化成可觀測結構。',
    factorHints: ['liquidity sweep', 'BOS', 'CHOCH', 'displacement'],
  },
  {
    id: 'REVENUE_QUALITY_MOMENTUM',
    label: 'Revenue Quality',
    layerRole: 'L1 owner',
    objective: '找營收/獲利品質與技術轉強同步的股票。',
    factorHints: ['revenue YoY', 'revenue MoM', 'EPS', 'ROE'],
  },
  {
    id: 'SECTOR_ROTATION_CORE',
    label: 'Sector Rotation',
    layerRole: 'L1 owner',
    objective: '找族群資金與核心股輪動，補足單股訊號的廣度。',
    factorHints: ['sector breadth', 'group relative strength', 'new money', 'leader stock'],
  },
]

function chartOptions(width: number): DeepPartial<ChartOptions> {
  return {
    width,
    height: 330,
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
    timeScale: { borderColor: 'rgba(148, 163, 184, 0.18)', timeVisible: false },
  }
}

function pseudoFamilyTime(index: number): string {
  return `2026-01-${String(index + 1).padStart(2, '0')}`
}

function classifyStrategyFamily(spec: StrategySpec): StrategyFamilyId {
  const text = `${spec.id} ${spec.name} ${spec.alphaBucket} ${spec.thesis}`.toLowerCase()
  if (/\b(smc|liquidity|sweep|bos|choch|displacement|order block|fvg)\b/.test(text)) return 'SMC_STRUCTURE_RECLAIM'
  if (/\b(sector|rotation|industry|group|theme|leader|relative strength)\b/.test(text)) return 'SECTOR_ROTATION_CORE'
  if (/\b(revenue|quality|eps|roe|margin|fundamental|profit)\b/.test(text)) return 'REVENUE_QUALITY_MOMENTUM'
  if (/\b(chip|broker|foreign|trust|dealer|accumulation|smart money)\b/.test(text)) return 'SMART_MONEY_ACCUMULATION'
  if (/\b(vcp|squeeze|contraction|breakout|bollinger|bb|volume expansion)\b/.test(text)) return 'VOLATILITY_CONTRACTION_BREAKOUT'
  if (/\b(trend|reclaim|rsi|macd|adx|ma|continuation|pullback)\b/.test(text)) return 'TREND_RECLAIM_CONTINUATION'
  return 'TREND_RECLAIM_CONTINUATION'
}

function thresholdKeys(spec: StrategySpec) {
  return Object.keys(spec.thresholds ?? {}).slice(0, 5)
}

function asPct(value?: number | null) {
  if (value == null || !Number.isFinite(Number(value))) return '-'
  return `${(Number(value) * 100).toFixed(1)}%`
}

function familyTone(id: StrategyFamilyId) {
  if (id === 'VOLATILITY_CONTRACTION_BREAKOUT') return 'border-amber-400/25 bg-amber-400/10 text-amber-100'
  if (id === 'TREND_RECLAIM_CONTINUATION') return 'border-sky-400/25 bg-sky-400/10 text-sky-100'
  if (id === 'SMART_MONEY_ACCUMULATION') return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100'
  if (id === 'SMC_STRUCTURE_RECLAIM') return 'border-fuchsia-400/25 bg-fuchsia-400/10 text-fuchsia-100'
  if (id === 'REVENUE_QUALITY_MOMENTUM') return 'border-cyan-400/25 bg-cyan-400/10 text-cyan-100'
  return 'border-violet-400/25 bg-violet-400/10 text-violet-100'
}

export default function StrategyFamilyWorkbench({ specs, dryRun, learning, experiments }: StrategyFamilyWorkbenchProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)

  const dryRunBySpec = useMemo(() => new Map((dryRun?.results ?? []).map((row) => [row.specId, row])), [dryRun])
  const learningBySpec = useMemo(() => new Map((learning?.specs ?? []).map((row) => [row.id, row])), [learning])

  const familyRows = useMemo(() => {
    return STRATEGY_FAMILIES.map((family, index) => {
      const familySpecs = specs.filter((spec) => classifyStrategyFamily(spec) === family.id)
      const activeSpecs = familySpecs.filter((spec) => spec.status === 'active' || spec.status === 'candidate')
      const matched = familySpecs.reduce((sum, spec) => sum + Number(dryRunBySpec.get(spec.id)?.matched ?? 0), 0)
      const sampleSize = familySpecs.reduce((sum, spec) => sum + Number(dryRunBySpec.get(spec.id)?.sampleSize ?? 0), 0)
      const learningRows = familySpecs.map((spec) => learningBySpec.get(spec.id)).filter(Boolean)
      const avgHitRate = learningRows.length
        ? learningRows.reduce((sum, row) => sum + Number(row?.learning.hit_rate ?? 0), 0) / learningRows.length
        : 0
      const blockers = familySpecs.filter((spec) => spec.status === 'retired' || spec.validation?.ok === false).length
      return {
        ...family,
        index,
        specs: familySpecs,
        activeSpecs,
        matched,
        sampleSize,
        matchRate: sampleSize ? matched / sampleSize : 0,
        avgHitRate,
        blockers,
      }
    })
  }, [dryRunBySpec, learningBySpec, specs])

  const markers = useMemo<SeriesMarker<Time>[]>(() => familyRows.map((row) => ({
    time: pseudoFamilyTime(row.index),
    position: row.blockers ? 'aboveBar' : 'belowBar',
    shape: row.blockers ? 'circle' : 'arrowUp',
    color: row.blockers ? '#fb7185' : '#34d399',
    text: `${row.label}: ${row.specs.length} variants`,
  })), [familyRows])

  const activeSpecCount = familyRows.reduce((sum, row) => sum + row.activeSpecs.length, 0)
  const matchedTotal = familyRows.reduce((sum, row) => sum + row.matched, 0)
  const sampleTotal = familyRows.reduce((sum, row) => sum + row.sampleSize, 0)
  const experimentCount = experiments.length

  useEffect(() => {
    const container = containerRef.current
    if (!container || !familyRows.length) return

    const chart = createChart(container, chartOptions(container.clientWidth || 720))
    chartRef.current = chart

    const matchedSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      color: '#fbbf24',
      title: 'dry-run matched',
    })
    matchedSeries.setData(familyRows.map((row) => ({
      time: pseudoFamilyTime(row.index),
      value: row.matched,
      color: row.blockers ? '#fb7185' : row.activeSpecs.length ? '#fbbf24' : '#64748b',
    })))

    const hitRateSeries = chart.addSeries(LineSeries, {
      color: '#38bdf8',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'learning hit rate',
    })
    hitRateSeries.setData(familyRows.map((row) => ({
      time: pseudoFamilyTime(row.index),
      value: Number((row.avgHitRate || row.matchRate || 0).toFixed(4)),
    })))
    createSeriesMarkers(hitRateSeries, markers)

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
  }, [familyRows, markers])

  return (
    <section className="overflow-hidden border border-[#263247] bg-[#0f151d]/96">
      <header className="grid gap-3 border-b border-[#263247] bg-[#070a10] p-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-300">L1 Strategy Family Cockpit</p>
          <h2 className="mt-1 text-base font-semibold text-[#f2ead8]">全市場 strategy-hit breadth，不做 raw top-up 正式補滿</h2>
          <p className="mt-2 max-w-4xl text-xs leading-5 text-[#9aa7bd]">
            這頁只管理 L1 family / variant 與 strategy-learning；L2 coarse、L3 family ML 與參數晉升在 Model Pool，單次 run path 在流程追蹤。
          </p>
        </div>
        <div className="grid grid-cols-4 gap-2 text-[11px]">
          <div className="border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-amber-200">families {STRATEGY_FAMILIES.length}</div>
          <div className="border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-sky-200">active variants {activeSpecCount}</div>
          <div className="border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-emerald-200">hits {matchedTotal}/{sampleTotal || '-'}</div>
          <div className="border border-violet-400/25 bg-violet-400/10 px-3 py-2 text-violet-200">experiments {experimentCount}</div>
        </div>
      </header>

      <div className="grid gap-px bg-[#263247] xl:grid-cols-[minmax(0,1.28fr)_minmax(360px,0.72fr)]">
        <div className="bg-[#070a10]">
          <div ref={containerRef} className="min-h-[330px] w-full" />
        </div>
        <aside className="grid gap-px bg-[#263247] md:grid-cols-2 xl:grid-cols-1">
          {familyRows.map((row) => (
            <div key={row.id} className="bg-[#070a10] p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-[11px] font-semibold text-[#fff1cf]">{row.label}</p>
                  <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-[#70809b]">{row.layerRole}</p>
                </div>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] ${familyTone(row.id)}`}>
                  {row.activeSpecs.length}/{row.specs.length}
                </span>
              </div>
              <p className="mt-2 text-xs leading-5 text-[#9aa7bd]">{row.objective}</p>
              <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-[11px]">
                <div className="border border-[#263247] bg-[#05070c] p-2">
                  <p className="text-[#70809b]">match</p>
                  <p className="mt-1 text-slate-100">{asPct(row.matchRate)}</p>
                </div>
                <div className="border border-[#263247] bg-[#05070c] p-2">
                  <p className="text-[#70809b]">hit</p>
                  <p className="mt-1 text-slate-100">{asPct(row.avgHitRate)}</p>
                </div>
                <div className="border border-[#263247] bg-[#05070c] p-2">
                  <p className="text-[#70809b]">block</p>
                  <p className="mt-1 text-slate-100">{row.blockers}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1">
                {row.factorHints.map((factor) => (
                  <span key={factor} className="rounded-full border border-[#263247] bg-[#05070c] px-2 py-0.5 text-[10px] text-[#c8d3df]">{factor}</span>
                ))}
              </div>
              <div className="mt-3 space-y-1">
                {row.specs.slice(0, 4).map((spec) => (
                  <div key={spec.id} className="flex items-center justify-between gap-2 border-l border-[#33415c] pl-2 text-[11px]">
                    <span className="min-w-0 truncate text-slate-200">{spec.name}</span>
                    <span className="shrink-0 text-[#70809b]">{thresholdKeys(spec).join(' / ') || spec.alphaBucket}</span>
                  </div>
                ))}
                {row.specs.length > 4 && <p className="text-[10px] text-[#70809b]">+{row.specs.length - 4} variants</p>}
              </div>
            </div>
          ))}
        </aside>
      </div>
    </section>
  )
}
