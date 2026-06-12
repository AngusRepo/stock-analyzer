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
  MODEL_POOL_ACTIVE_ALPHA_MODEL_IDS,
  MODEL_POOL_L2_COARSE_MODEL_IDS,
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
  WorkstationFlow,
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
const ACTIVE_ALPHA_MODELS = new Set<string>(MODEL_POOL_ACTIVE_ALPHA_MODEL_IDS)
const PRODUCTION_SLOT_MODELS = new Set<string>(MODEL_POOL_PRODUCTION_SLOT_IDS)
const COARSE_MODELS = new Set<string>(MODEL_POOL_L2_COARSE_MODEL_IDS)
const TREE_MODELS = new Set(['LightGBM', 'XGBoost', 'ExtraTrees'])
const SEQUENCE_MODELS = new Set(['DLinear', 'PatchTST', 'iTransformer', 'TimesFM'])
const GRAPH_MODELS = new Set(['GNN'])
const TABULAR_NEURAL_MODELS = new Set(['TabM'])

const ADAPTIVE_EVIDENCE_STEPS = [
  {
    label: 'Active-9 confidence hook',
    detail: 'Risk thresholds and PF quality use active-9 verified model_accuracy only; retired models stay out of confidence and quality multipliers.',
    tone: 'ok' as const,
  },
  {
    label: 'Mode B policy replay',
    detail: 'Weekly adaptive-meta-policy-replay compares LinUCB, NeuralUCB, NeuralTS, and NeuCB as evidence-only meta-policy candidates.',
    tone: 'info' as const,
  },
  {
    label: 'LinUCB multiplier replay',
    detail: 'Weekly linucb-multiplier-replay audits bandit_* L2 constants; L2 KV push also requires Mode B replay, PBO PASS, and walk-forward PASS.',
    tone: 'info' as const,
  },
  {
    label: 'Promotion gate',
    detail: 'Artifact and parameter candidates still need final compare, explicit approval when required, and champion pointer readiness.',
    tone: 'warn' as const,
  },
]

function isServing(model?: ModelPoolLineageModel): boolean {
  return model?.status === 'active' || model?.status === 'degraded'
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
    () => models.filter(([name]) => ACTIVE_ALPHA_MODELS.has(name) && !RETIRED_MODELS.has(name)),
    [models],
  )
  const byName = useMemo(() => new Map(liveModels), [liveModels])
  const serving = useMemo(() => liveModels.filter(([, model]) => isServing(model)), [liveModels])
  const coarse = useMemo(() => [...COARSE_MODELS].map((name) => [name, byName.get(name)] as const), [byName])
  const activeSlots = useMemo(
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
  const evidenceReady = activeSlots.filter((candidate) => {
    const row = latestStatusFor(candidate.id, statusRows)
    return row?.registry_status === 'ready_for_review' || row?.registry_status === 'approved_for_patch'
  }).length

  const chartPoints = useMemo(() => {
    const coarseServing = coarse.filter(([, model]) => isServing(model)).length
    const bars = [
      { label: 'L2 coarse', value: coarseServing, blockers: coarse.length - coarseServing, color: '#38bdf8' },
      { label: 'Active-9', value: serving.length, blockers: Math.max(0, activeSlots.length - serving.length), color: '#34d399' },
      { label: 'evidence', value: evidenceReady, blockers: activeSlots.length - evidenceReady, color: '#facc15' },
      { label: 'promotion', value: promotionCount, blockers: selectedArtifacts ? Math.max(0, selectedArtifacts - promotionCount) : 0, color: '#c084fc' },
    ]
    return bars.map((bar, index) => ({ ...bar, time: chartDay(index) }))
  }, [activeSlots.length, coarse, evidenceReady, promotionCount, selectedArtifacts, serving.length])

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
      title="Model Pool Cockpit"
      kicker="L2 coarse -> L3 family -> adaptive evidence -> promotion governance"
    >
      <div className="grid gap-3 border-b border-[#263247] p-3 lg:grid-cols-4">
        <StatCell
          label="L2 coarse"
          value={`${coarse.filter(([, model]) => isServing(model)).length}/3`}
          detail="LightGBM / XGBoost / ExtraTrees coarse gate health"
          tone={coarse.every(([, model]) => isServing(model)) ? 'ok' : 'warn'}
        />
        <StatCell
          label="Active-9 serving"
          value={`${serving.length}/${activeSlots.length}`}
          detail={`families ${Object.entries(familyCounts).map(([family, count]) => `${family}:${count}`).join(' / ') || 'none'}`}
          tone={serving.length === activeSlots.length ? 'ok' : serving.length ? 'warn' : 'error'}
        />
        <StatCell
          label="Evidence ready"
          value={`${evidenceReady}/${activeSlots.length}`}
          detail="Active-9 artifact, verified-row, and IC readiness"
          tone={evidenceReady === activeSlots.length ? 'ok' : evidenceReady ? 'warn' : 'info'}
        />
        <StatCell
          label="Governance"
          value={`${readyPointers}/${pointerTotal || 'N/A'}`}
          detail={`selected artifacts ${selectedArtifacts}; promotion queue ${promotionCount}`}
          tone={pointerTotal && readyPointers === pointerTotal ? 'ok' : 'warn'}
        />
      </div>

      <div className="border-b border-[#263247] bg-[#05070c] p-3">
        <WorkstationFlow steps={ADAPTIVE_EVIDENCE_STEPS} />
      </div>

      <div className="grid gap-px bg-[#263247] lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <div className="bg-[#070a10] p-3">
          <div ref={containerRef} className="min-h-[260px] w-full" aria-label="Active-9 evidence chain chart" />
          <p className="mt-2 text-[11px] leading-5 text-[#70809b]">
            Snapshot of the active-9 evidence chain. Rising blockers mean the next scheduler path
            should close artifact, verified-row, IC, or promotion evidence gaps.
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
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-300">Active-9 L3 slots</p>
            <div className="mt-2 grid gap-2">
              {activeSlots.map((candidate) => {
                const row = latestStatusFor(candidate.id, statusRows)
                const model = byName.get(candidate.id)
                return (
                  <div key={candidate.id} className="rounded-lg border border-[#263247] bg-[#05070c] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-mono text-[12px] font-semibold text-[#fff1cf]">{candidate.id}</p>
                        <p className="mt-0.5 text-[11px] text-[#70809b]">{candidate.layer} / {candidate.family} / {model?.version ?? 'no artifact'}</p>
                      </div>
                      <WorkstationPill tone={toneFromStatus(row?.registry_status ?? model?.status)}>
                        {row?.registry_status ?? model?.status ?? 'needs evidence'}
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
        Parameter search and allocator/meta proposals stay in Promotion & Parameter Governance.
        This cockpit is only the L2/L3 model evidence surface: active slots, artifacts, verified rows,
        blockers, and champion pointer readiness.
      </div>
    </WorkstationPanel>
  )
}
