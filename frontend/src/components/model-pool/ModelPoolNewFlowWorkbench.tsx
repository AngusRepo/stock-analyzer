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
import {
  MODEL_POOL_PRODUCTION_SLOT_IDS,
  MODEL_POOL_RETIRED_MODEL_IDS,
  MODEL_UPGRADE_CANDIDATES,
} from '@/lib/modelUpgradeTrack'
import type {
  ModelArtifactPromotionQueueResponse,
  ModelArtifactSelectionResponse,
  ModelChampionPointersResponse,
  ModelPoolLineageModel,
  ModelUpgradeResearchStatusRow,
} from '@/lib/api'
import {
  WorkstationPanel,
  WorkstationPill,
  type WorkstationTone,
} from '@/components/workstation/WorkstationChrome'

type ModelEntry = [string, ModelPoolLineageModel]

type ModelPoolNewFlowWorkbenchProps = {
  models: ModelEntry[]
  selection?: ModelArtifactSelectionResponse
  pointers?: ModelChampionPointersResponse
  promotionQueue?: ModelArtifactPromotionQueueResponse
  statusRows?: ModelUpgradeResearchStatusRow[]
}

const RETIRED_MODELS = new Set<string>(MODEL_POOL_RETIRED_MODEL_IDS)
const PRODUCTION_SLOT_MODELS = new Set<string>(MODEL_POOL_PRODUCTION_SLOT_IDS)
const COARSE_MODELS = new Set(['LightGBM', 'XGBoost', 'ExtraTrees'])
const TREE_MODELS = new Set(['LightGBM', 'XGBoost', 'ExtraTrees'])
const SEQUENCE_MODELS = new Set(['DLinear', 'PatchTST', 'iTransformer', 'TimesFM'])
const GRAPH_MODELS = new Set(['GNN'])
const TABULAR_NEURAL_MODELS = new Set(['TabM'])

function isServing(model: ModelPoolLineageModel): boolean {
  return model.status === 'active' || model.status === 'degraded'
}

function toneFromStatus(status?: string | null): WorkstationTone {
  if (status === 'active' || status === 'ready_for_review' || status === 'approved_for_patch' || status === 'pointer_ready') return 'ok'
  if (status === 'degraded' || status === 'evaluation_pending' || status === 'needs_attention') return 'warn'
  if (status === 'failed' || status === 'retired' || status === 'rejected') return 'error'
  return 'neutral'
}

function modelFamily(name: string, model?: ModelPoolLineageModel): 'Tree' | 'TabM' | 'Sequence' | 'GNN' | 'Other' {
  const family = `${model?.balance_family ?? ''} ${model?.model_type ?? ''}`.toLowerCase()
  if (TREE_MODELS.has(name) || family.includes('tree') || family.includes('boost')) return 'Tree'
  if (TABULAR_NEURAL_MODELS.has(name) || family.includes('tabm') || family.includes('tabular_neural')) return 'TabM'
  if (GRAPH_MODELS.has(name) || family.includes('graph') || family.includes('gnn')) return 'GNN'
  if (SEQUENCE_MODELS.has(name) || family.includes('sequence') || family.includes('time')) return 'Sequence'
  return 'Other'
}

function latestStatusFor(candidateId: string, rows?: ModelUpgradeResearchStatusRow[]) {
  return rows?.find((row) => row.candidate_id.toLowerCase() === candidateId.toLowerCase())
}

function chartOptions(width: number): DeepPartial<ChartOptions> {
  return {
    width,
    height: 260,
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

function chartDay(index: number): string {
  const day = new Date()
  day.setDate(day.getDate() - (3 - index))
  return day.toISOString().slice(0, 10)
}

function StatCell({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string
  value: string | number
  detail: string
  tone?: WorkstationTone
}) {
  return (
    <div className="border border-[#263247] bg-[#05070c] p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#7f8da8]">{label}</p>
        <WorkstationPill tone={tone}>{tone}</WorkstationPill>
      </div>
      <p className="mt-2 font-mono text-2xl font-semibold text-[#fff1cf]">{value}</p>
      <p className="mt-1 text-xs leading-5 text-[#8a92a6]">{detail}</p>
    </div>
  )
}

function ModelBadge({ name, model }: { name: string; model?: ModelPoolLineageModel }) {
  const status = model?.status ?? 'missing'
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[#263247] bg-[#070a10] px-3 py-2">
      <div className="min-w-0">
        <p className="truncate font-mono text-[12px] font-semibold text-slate-100">{name}</p>
        <p className="mt-0.5 truncate text-[11px] text-[#70809b]">{modelFamily(name, model)} / {model?.version ?? 'no artifact'}</p>
      </div>
      <WorkstationPill tone={toneFromStatus(status)}>{status}</WorkstationPill>
    </div>
  )
}

export default function ModelPoolNewFlowWorkbench({
  models,
  selection,
  pointers,
  promotionQueue,
  statusRows,
}: ModelPoolNewFlowWorkbenchProps) {
  const chartRef = useRef<IChartApi | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const liveModels = useMemo(
    () => models.filter(([name]) => !RETIRED_MODELS.has(name)),
    [models],
  )
  const byName = useMemo(() => new Map(liveModels), [liveModels])
  const serving = useMemo(() => liveModels.filter(([, model]) => isServing(model)), [liveModels])
  const coarse = useMemo(() => [...COARSE_MODELS].map((name) => [name, byName.get(name)] as const), [byName])
  const nearProduction = useMemo(
    () => MODEL_UPGRADE_CANDIDATES.filter((candidate) => PRODUCTION_SLOT_MODELS.has(candidate.id)),
    [],
  )
  const familyCounts = useMemo(() => {
    return serving.reduce<Record<string, number>>((acc, [name, model]) => {
      const family = modelFamily(name, model)
      acc[family] = (acc[family] ?? 0) + 1
      return acc
    }, {})
  }, [serving])
  const readyPointers = pointers?.ready_count ?? 0
  const pointerTotal = pointers?.model_count ?? 0
  const selectedArtifacts = Object.values(selection?.models ?? {}).reduce((sum, row) => {
    return sum + (row.monthly_release_candidate ? 1 : 0) + (row.weekly_drift_candidate ? 1 : 0)
  }, 0)
  const promotionCount = promotionQueue?.count ?? promotionQueue?.queue?.length ?? 0
  const nearReady = nearProduction.filter((candidate) => {
    const row = latestStatusFor(candidate.id, statusRows)
    return row?.registry_status === 'ready_for_review' || row?.registry_status === 'approved_for_patch'
  }).length

  const chartPoints = useMemo(() => {
    const bars = [
      { label: 'L2 coarse', value: coarse.filter(([, model]) => model && isServing(model)).length, blockers: coarse.filter(([, model]) => !model || !isServing(model)).length, color: '#38bdf8' },
      { label: 'L3 serving', value: serving.length, blockers: liveModels.length - serving.length, color: '#34d399' },
      { label: 'near-prod', value: nearReady, blockers: nearProduction.length - nearReady, color: '#facc15' },
      { label: 'promotion', value: promotionCount, blockers: selectedArtifacts ? Math.max(0, selectedArtifacts - promotionCount) : 0, color: '#c084fc' },
    ]
    return bars.map((bar, index) => ({ ...bar, time: chartDay(index) }))
  }, [coarse, liveModels.length, nearProduction.length, nearReady, promotionCount, selectedArtifacts, serving.length])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const chart = createChart(container, chartOptions(container.clientWidth || 720))
    chartRef.current = chart

    const countSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      color: '#38bdf8',
      title: 'model count',
    })
    countSeries.setData(chartPoints.map((point) => ({
      time: point.time,
      value: point.value,
      color: point.color,
    })))

    const blockerSeries = chart.addSeries(LineSeries, {
      color: '#f87171',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'blockers',
    })
    blockerSeries.setData(chartPoints.map((point) => ({
      time: point.time,
      value: point.blockers,
    })))

    const markers: SeriesMarker<Time>[] = chartPoints.map((point) => ({
      time: point.time,
      position: point.blockers > 0 ? 'aboveBar' : 'belowBar',
      shape: point.blockers > 0 ? 'circle' : 'arrowUp',
      color: point.blockers > 0 ? '#f87171' : '#34d399',
      text: `${point.label}: ${point.value}`,
    }))
    createSeriesMarkers(blockerSeries, markers)

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
  }, [chartPoints])

  return (
    <WorkstationPanel
      title="Model Pool Cockpit / 新流程模型池"
      kicker="L2 coarse -> L3 family -> promotion and parameter governance"
    >
      <div className="grid gap-3 border-b border-[#263247] p-3 lg:grid-cols-4">
        <StatCell
          label="L2 coarse"
          value={`${coarse.filter(([, model]) => model && isServing(model)).length}/3`}
          detail="LightGBM / XGBoost / ExtraTrees coarse gate health"
          tone={coarse.every(([, model]) => model && isServing(model)) ? 'ok' : 'warn'}
        />
        <StatCell
          label="L3 serving"
          value={serving.length}
          detail={`families ${Object.entries(familyCounts).map(([family, count]) => `${family}:${count}`).join(' / ') || 'none'}`}
          tone={serving.length ? 'ok' : 'warn'}
        />
        <StatCell
          label="Near production"
          value={`${nearReady}/${nearProduction.length}`}
          detail="TabM / GNN / iTransformer / TimesFM evidence readiness"
          tone={nearReady === nearProduction.length ? 'ok' : nearReady ? 'warn' : 'info'}
        />
        <StatCell
          label="Governance"
          value={`${readyPointers}/${pointerTotal || 'N/A'}`}
          detail={`selected artifacts ${selectedArtifacts}; promotion queue ${promotionCount}`}
          tone={pointerTotal && readyPointers === pointerTotal ? 'ok' : 'warn'}
        />
      </div>

      <div className="grid gap-px bg-[#263247] lg:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
        <div className="bg-[#070a10] p-3">
          <div ref={containerRef} className="min-h-[260px] w-full" />
          <p className="mt-2 text-[11px] leading-5 text-[#70809b]">
            這張圖只做當前層級 snapshot：柱狀是該層可用數，紅線是 blocker 數；完整 run path 留在流程追蹤頁。
          </p>
        </div>
        <div className="space-y-3 bg-[#070a10] p-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-sky-300">L2 coarse gate</p>
            <div className="mt-2 grid gap-2">
              {coarse.map(([name, model]) => <ModelBadge key={name} name={name} model={model} />)}
            </div>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-300">L3 production targets</p>
            <div className="mt-2 grid gap-2">
              {nearProduction.map((candidate) => {
                const row = latestStatusFor(candidate.id, statusRows)
                return (
                  <div key={candidate.id} className="rounded-lg border border-[#263247] bg-[#05070c] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-mono text-[12px] font-semibold text-[#fff1cf]">{candidate.id}</p>
                        <p className="mt-0.5 text-[11px] text-[#70809b]">{candidate.layer} / {candidate.family}</p>
                      </div>
                      <WorkstationPill tone={toneFromStatus(row?.registry_status)}>
                        {row?.registry_status ?? 'needs evidence'}
                      </WorkstationPill>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-[#9aa7bd]">{candidate.roleZh}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {candidate.requiredEvidence.slice(0, 4).map((item) => (
                        <WorkstationPill key={item} tone="neutral">{item}</WorkstationPill>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-[#263247] bg-[#05070c] p-3 text-xs leading-5 text-[#9aa7bd]">
        參數比較與晉升資訊不移除：它屬於下方 Promotion & Parameter Governance。那裡處理 artifact candidate、final compare、champion pointer、Wei approval 與 allocator/meta 參數 proposal；不再混進 L2/L3 模型家族健康圖。
      </div>
    </WorkstationPanel>
  )
}
