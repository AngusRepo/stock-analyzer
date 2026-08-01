import type {
  PipelineDecisionMaturityPacket,
  PipelineMaturityMetric,
  PipelineMaturityStage,
  PipelineMaturityStatus,
} from '@/lib/pipelineMaturityContract'
import { Badge } from '@/components/ui/badge'
import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Database,
  GitCompareArrows,
  RefreshCw,
  Route,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react'

const STATUS_STYLE: Record<PipelineMaturityStatus, { label: string; cls: string }> = {
  serving: { label: 'Production serving', cls: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' },
  ready: { label: 'Evidence ready', cls: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200' },
  collecting: { label: '累積中', cls: 'border-amber-400/30 bg-amber-400/10 text-amber-200' },
  failed_quality: { label: '品質未過', cls: 'border-rose-400/30 bg-rose-400/10 text-rose-200' },
  blocked: { label: 'Blocked', cls: 'border-rose-400/30 bg-rose-400/10 text-rose-200' },
  abstaining: { label: 'Safe abstention', cls: 'border-slate-400/30 bg-slate-400/10 text-slate-200' },
  unavailable: { label: 'Unavailable', cls: 'border-slate-400/30 bg-slate-400/10 text-slate-300' },
}

const MODE_STYLE = {
  production: { label: '正式貢獻', cls: 'border-emerald-400/25 text-emerald-200' },
  shadow: { label: 'Shadow learning', cls: 'border-violet-400/25 text-violet-200' },
  evidence_only: { label: 'Evidence only', cls: 'border-amber-400/25 text-amber-200' },
  abstention: { label: '不出手基線', cls: 'border-slate-400/25 text-slate-200' },
} as const

const BLOCKER_LABELS: Record<string, string> = {
  insufficient_paired_mature_oof_residual_returns: '同日配對的成熟 OOF residual return 日期仍不足',
  enough_total_dates: '總成熟日期不足',
  enough_train_dates: '訓練日期不足',
  enough_oos_dates: 'OOS 日期不足',
  route_floor_selected_on_train_only: '尚無法只用訓練集選出 route floor',
  top_bucket_cost_net_return_lcb90_positive: 'Top bucket 成本後報酬 LCB90 未轉正',
  residual_spread_lcb90_positive: 'Residual spread LCB90 未轉正',
  calibrated_probability_beats_climatology: '校準機率尚未優於 climatology baseline',
  selected_validation_mean_r: 'S12 validation 平均 R 未達 0',
  selected_validation_hit_rate: 'S12 validation 勝率未達門檻',
  validation_mean_non_degradation: 'S12 篩選後 validation 未優於 baseline',
  validation_drawdown_non_degradation: 'S12 validation drawdown 劣化',
  pit_sector_alpha_samples_low: 'PIT sector alpha 樣本不足',
  pit_sector_alpha_dates_low: 'PIT sector alpha 日期不足',
  oos_date_cluster_corr_lcb90_not_positive: '日期聚類 OOS correlation LCB90 未轉正',
  oos_date_cluster_spread_lcb90_not_above_cost: '日期聚類 top-bottom spread LCB90 未高於成本',
  oos_top_quintile_return_not_positive: 'OOS top quintile 平均成本後報酬未轉正',
  oos_date_cluster_top_quintile_return_lcb90_not_positive: 'OOS top quintile 報酬 LCB90 未轉正',
  walk_forward_not_stable: 'Purged walk-forward 跨窗不穩定',
  artifact_missing: '正式 artifact 不存在',
  champion_pointer_missing: 'Champion pointer 不存在',
  validation_not_pass: 'Artifact validation 尚未 PASS',
  promotion_state_not_serving: '尚未進入 serving promotion state',
  primary_expected_return_not_allowed: '尚未取得 primary expected-return 權限',
}

function stageIcon(id: PipelineMaturityStage['id']) {
  const cls = 'h-4 w-4'
  if (id === 'threshold_margin_affinity_v2') return <SlidersHorizontal className={cls} />
  if (id === 'oof_redundancy') return <GitCompareArrows className={cls} />
  if (id === 'route_score_v2') return <Route className={cls} />
  if (id === 's12') return <ShieldCheck className={cls} />
  if (id === 'l4') return <BrainCircuit className={cls} />
  return <Activity className={cls} />
}

function displayValue(metric: PipelineMaturityMetric): string {
  const value = metric.value
  if (value == null || value === '') return metric.note ? 'Pending' : 'Unavailable'
  if (typeof value === 'boolean') return value ? 'PASS' : 'FAIL'
  if (typeof value === 'string') return value.replace(/_/g, ' ')
  if (!Number.isFinite(value)) return '-'
  if (metric.unit === 'rows' || metric.unit === 'dates' || metric.unit === 'count') {
    return value.toLocaleString('zh-TW', { maximumFractionDigits: 0 })
  }
  if (metric.unit === 'return') return `${(value * 100).toFixed(3)}%`
  if (metric.unit === 'r_multiple') return `${value.toFixed(3)}R`
  if (metric.unit === 'score') return value.toFixed(2)
  return value.toFixed(4)
}

function targetText(metric: PipelineMaturityMetric): string | null {
  if (metric.target == null || metric.target === '') return null
  const operator = metric.comparator === 'gt' ? '>' : metric.comparator === 'lt' ? '<' : metric.comparator === 'eq' ? '=' : '≥'
  const target = displayValue({ ...metric, value: metric.target })
  return `${operator} ${target}`
}

function blockerText(blocker: string): string {
  const normalized = blocker.replace(/^serving_contract:/, '')
  const direct = BLOCKER_LABELS[normalized]
  if (direct) return direct
  const suffix = Object.entries(BLOCKER_LABELS).find(([key]) => normalized.endsWith(key))
  return suffix?.[1] ?? normalized.replace(/_/g, ' ')
}

function MetricCell({ metric }: { metric: PipelineMaturityMetric }) {
  const target = targetText(metric)
  const tone = metric.passed === true
    ? 'text-emerald-300'
    : metric.passed === false
      ? 'text-rose-300'
      : 'text-[#dfe7f5]'
  return (
    <div className="min-w-0 border-b border-white/[0.06] py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:px-3 sm:last:border-r-0">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-xs leading-5 text-slate-500">{metric.label}</p>
        {metric.passed === true ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" /> : null}
        {metric.passed === false ? <CircleAlert className="h-3.5 w-3.5 shrink-0 text-rose-400" /> : null}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={`sv-num break-all text-sm font-semibold ${tone}`}>{displayValue(metric)}</span>
        {target ? <span className="sv-num text-[11px] text-slate-600">門檻 {target}</span> : null}
      </div>
      {metric.note ? <p className="mt-1 text-[11px] leading-4 text-slate-600">{metric.note}</p> : null}
    </div>
  )
}

function StageRow({ stage }: { stage: PipelineMaturityStage }) {
  const status = STATUS_STYLE[stage.status]
  const mode = MODE_STYLE[stage.contribution_mode]
  const progress = stage.progress
  const progressLabel = progress
    ? progress.complete
      ? `資料門檻完成 · ${progress.current}/${progress.required} ${progress.unit}`
      : `尚差 ${progress.remaining} ${progress.unit} · ${progress.current}/${progress.required}`
    : '沒有可計算的數量門檻'
  const history = stage.history ?? []
  const latestHistory = history[history.length - 1] ?? null
  const previousHistory = history[history.length - 2] ?? null
  const historyDelta = latestHistory?.value != null && previousHistory?.value != null
    ? latestHistory.value - previousHistory.value
    : null
  const historyMetric = (value: number | null) => displayValue({
    key: 'history',
    label: 'history',
    value,
    unit: latestHistory?.unit,
  })
  const historyTrend = history.slice(-4).map((point) => `${point.evidence_date.slice(5)} ${displayValue({ key: 'history', label: 'history', value: point.value, unit: point.unit })}`).join(' | ')
  return (
    <details open className="group overflow-hidden rounded-[18px] border border-white/[0.07] bg-white/[0.032]">
      <summary className="grid cursor-pointer list-none gap-4 px-4 py-4 marker:hidden">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-white/[0.08] bg-black/20 text-amber-300">
              {stageIcon(stage.id)}
            </span>
            <div className="min-w-0">
              <p className="sv-num text-[11px] font-semibold text-amber-300">{stage.layer}</p>
              <h3 className="break-words text-sm font-bold text-slate-100">{stage.title}</h3>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant="outline" className={`h-auto whitespace-normal rounded-full px-2 py-0.5 text-[11px] ${status.cls}`}>{status.label}</Badge>
            <Badge variant="outline" className={`h-auto whitespace-normal rounded-full px-2 py-0.5 text-[11px] ${mode.cls}`}>{mode.label}</Badge>
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="font-semibold text-slate-500">成熟進度</span>
            <span className="sv-num text-right text-slate-300">{progressLabel}</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-sm bg-black/35">
            <div
              className={`h-full rounded-sm ${progress?.complete ? 'bg-emerald-400' : stage.status === 'failed_quality' ? 'bg-rose-400' : 'bg-amber-400'}`}
              style={{ width: `${Math.max(2, Math.round((progress?.ratio ?? 0) * 100))}%` }}
            />
          </div>
          <p className="mt-2 break-words text-xs leading-5 text-slate-500">{stage.decision}</p>
        </div>

        <div className="min-w-0 border-t border-white/[0.07] pt-3">
          <p className="text-xs font-semibold text-slate-500">本階段實際貢獻</p>
          <p className="mt-1 break-words text-sm leading-6 text-slate-300">{stage.production_effect}</p>
        </div>
      </summary>

      <div className="border-t border-white/[0.06] bg-black/[0.12] px-4 py-4 lg:px-5">
        <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.5fr)_minmax(240px,0.8fr)]">
          <div className="min-w-0">
            <div className="mb-3 flex items-start gap-2">
              <Activity className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
              <div>
                <p className="text-xs font-semibold text-slate-100">責任邊界與決策用途</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">{stage.contribution}</p>
              </div>
            </div>
            <div className="grid border-y border-white/[0.07] px-1 sm:grid-cols-2">
              {stage.metrics.map((item) => <MetricCell key={item.key} metric={item} />)}
            </div>
          </div>

          <div className="min-w-0 space-y-3">
            <div>
              <p className="text-xs font-semibold text-slate-500">尚未通過 / Blockers</p>
              {stage.blockers.length ? (
                <div className="mt-2 space-y-1.5">
                  {stage.blockers.map((blocker) => (
                    <div key={blocker} className="border-l-2 border-rose-400/45 pl-2">
                      <p className="text-xs leading-5 text-rose-200">{blockerText(blocker)}</p>
                      <code className="mt-0.5 block break-all text-[11px] leading-4 text-slate-600">{blocker}</code>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-300">
                  <CheckCircle2 className="h-3.5 w-3.5" /> 目前沒有 blocker
                </p>
              )}
            </div>

            <div className="border-t border-white/[0.07] pt-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-500"><Database className="h-3.5 w-3.5" /> Lineage</p>
              <dl className="mt-2 grid grid-cols-[84px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px] leading-4">
                <dt className="text-slate-600">Evidence</dt><dd className="sv-num break-all text-slate-400">{stage.lineage.evidence_date ?? 'Unavailable'}</dd>
                <dt className="text-slate-600">Previous</dt><dd className="sv-num break-all text-slate-400">{previousHistory?.evidence_date ?? 'First evidence'}</dd>
                <dt className="text-slate-600">Delta</dt><dd className="sv-num break-all text-cyan-300">{historyDelta == null ? 'Not comparable' : `${historyDelta > 0 ? '+' : ''}${historyMetric(historyDelta)}`}</dd>
                <dt className="text-slate-600">Trend</dt><dd className="sv-num break-words text-slate-400">{historyTrend || 'No prior history'}</dd>
                <dt className="text-slate-600">OOF max</dt><dd className="sv-num break-all text-slate-400">{stage.lineage.oof_applicable === false ? 'N/A (not OOF)' : stage.lineage.oof_max_date ?? 'Unavailable'}</dd>
                <dt className="text-slate-600">Version</dt><dd className="sv-num break-all text-slate-400">{stage.version ?? 'Unavailable'}</dd>
                <dt className="text-slate-600">Artifact</dt><dd className="sv-num break-all text-slate-400">{stage.lineage.artifact_id ?? 'Not applicable'}</dd>
                <dt className="text-slate-600">Source</dt><dd className="break-words text-slate-400">{stage.lineage.source}</dd>
                {stage.lineage.evidence_semantics ? <><dt className="text-slate-600">Cutoff</dt><dd className="break-words text-slate-400">{stage.lineage.evidence_semantics}</dd></> : null}
              </dl>
            </div>
          </div>
        </div>
      </div>
    </details>
  )
}

export default function PipelineMaturityContribution({
  data,
  loading,
  error,
  onRetry,
}: {
  data?: PipelineDecisionMaturityPacket
  loading: boolean
  error?: Error | null
  onRetry: () => void
}) {
  if (loading) {
    return (
      <section className="overflow-hidden rounded-[24px] border border-white/[0.09] bg-[linear-gradient(180deg,rgba(22,23,30,0.96),rgba(10,11,15,0.985))]" aria-label="成熟度與決策貢獻載入中">
        <div className="p-5"><div className="h-5 w-64 animate-pulse rounded bg-white/[0.08]" /></div>
        <div className="grid gap-3 p-4 lg:grid-cols-2">
          {[1, 2, 3, 4, 5, 6].map((row) => <div key={row} className="h-64 animate-pulse rounded-[18px] border border-white/[0.06] bg-white/[0.032]" />)}
        </div>
      </section>
    )
  }

  if (error || !data) {
    return (
      <section className="rounded-[24px] border border-rose-400/25 bg-rose-400/[0.06] p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" />
            <div>
              <h2 className="font-semibold text-rose-100">成熟度與決策貢獻讀取失敗</h2>
              <p className="mt-1 break-words text-xs leading-5 text-rose-100/65">{error?.message ?? 'pipeline maturity evidence unavailable'}</p>
            </div>
          </div>
          <button type="button" onClick={onRetry} className="inline-flex items-center justify-center gap-2 rounded-md border border-rose-300/25 bg-rose-300/10 px-3 py-2 text-xs font-semibold text-rose-100 hover:bg-rose-300/15">
            <RefreshCw className="h-4 w-4" /> 重新載入
          </button>
        </div>
      </section>
    )
  }

  const ownerLabel = data.current_expected_return_owner === 'allocator_ev_fusion'
    ? 'Fusion'
    : data.current_expected_return_owner === 'l4_alpha_ev'
      ? 'Canonical L4'
      : '無正式 EV owner'
  const summaryItems = [
    { label: 'Expected-return owner', value: ownerLabel },
    { label: '正式貢獻階段', value: String(data.summary.production) },
    { label: 'Shadow learning', value: String(data.summary.shadow) },
    { label: '累積中', value: String(data.summary.collecting) },
    { label: '品質未過 / blocked', value: String(data.summary.failed_or_blocked) },
  ]

  return (
    <section className="overflow-hidden rounded-[24px] border border-white/[0.09] bg-[linear-gradient(180deg,rgba(22,23,30,0.96),rgba(10,11,15,0.985))] shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_18px_52px_rgba(0,0,0,0.42)]" aria-labelledby="pipeline-maturity-title">
      <div className="border-b border-white/[0.08] px-5 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold text-amber-300">Decision ownership & evidence maturity</p>
            <h2 id="pipeline-maturity-title" className="mt-1 text-base font-semibold text-slate-100">成熟度與決策貢獻</h2>
            <p className="mt-1 max-w-4xl text-xs leading-5 text-slate-500">
              分開呈現資料門檻、OOS 品質門檻與 production 權限。進度滿格只代表資料足夠，不代表 artifact 已通過或已接手。
            </p>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-slate-600">
            <Clock3 className="h-3.5 w-3.5" />
            <span className="sv-num">evidence {data.requested_date} · generated {new Date(data.generated_at).toLocaleString('zh-TW', { hour12: false })}</span>
          </div>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {summaryItems.map((item) => (
            <div key={item.label} className="min-w-0 rounded-[14px] border border-white/[0.06] bg-white/[0.032] px-3 py-3">
              <p className="truncate text-[11px] font-semibold text-slate-500" title={item.label}>{item.label}</p>
              <p className="mt-2 break-words sv-num text-sm font-bold text-slate-100">{item.value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid items-start gap-3 p-4 lg:grid-cols-2">
        {data.stages.map((stage) => <StageRow key={stage.id} stage={stage} />)}
      </div>
    </section>
  )
}
