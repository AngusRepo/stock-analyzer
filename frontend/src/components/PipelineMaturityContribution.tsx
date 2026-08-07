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
  SlidersHorizontal,
} from 'lucide-react'

const STATUS_STYLE: Record<PipelineMaturityStatus, { label: string; cls: string }> = {
  serving: { label: 'Production serving', cls: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' },
  ready: { label: 'Evidence ready', cls: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200' },
  collecting: { label: '累積中', cls: 'border-amber-400/30 bg-amber-400/10 text-amber-200' },
  failed_quality: { label: '品質未過', cls: 'border-rose-400/30 bg-rose-400/10 text-rose-200' },
  blocked: { label: 'Blocked', cls: 'border-rose-400/30 bg-rose-400/10 text-rose-200' },
  unavailable: { label: 'Unavailable', cls: 'border-slate-400/30 bg-slate-400/10 text-slate-300' },
}

const MODE_STYLE = {
  production: { label: '正式貢獻', cls: 'border-emerald-400/25 text-emerald-200' },
  shadow: { label: 'Shadow learning', cls: 'border-violet-400/25 text-violet-200' },
  evidence_only: { label: 'Evidence only', cls: 'border-amber-400/25 text-amber-200' },
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
  oos_prediction_target_corr_lcb90_not_positive: 'OOS 預測與實現報酬的相關性 LCB90 未轉正',
  oos_top_bottom_spread_lcb90_not_economic: 'OOS top-bottom 成本後 spread 的 LCB90 尚未具經濟性',
  oos_log_loss_advantage_lcb90_not_positive: 'Execution probability 的 log-loss 優勢 LCB90 未轉正',
  paired_oos_dates_insufficient: '可做同日期 paired comparison 的 OOS 日期不足',
  primary_residual_adjustment_model_not_validated: 'Residual adjustment model 的 OOS gate 未通過',
  fusion_corr_delta_lcb90_inferior_to_canonical_l4: 'L4 + residual 的 correlation LCB90 劣於同版本 L4',
  fusion_spread_delta_lcb90_inferior_to_canonical_l4: 'L4 + residual 的 spread LCB90 劣於同版本 L4',
  fusion_top_trade_ev_lcb90_not_positive: 'L4 + residual 的 top five-session EV LCB90 未轉正',
  recent_two_oos_dates_both_corr_and_spread_inferior: '最近兩個 OOS 日期的 correlation 與 spread 都劣於 L4',
  multiple_testing_not_passed: '多策略搜尋後的 multiple-testing 修正未通過',
  approved_correction_missing: '多策略搜尋缺少 White Reality Check、Hansen SPA 或 Deflated Sharpe 修正',
  corrected_test_not_passed: 'Multiple-testing 修正後仍未通過',
  adjusted_p_value_gt_0_10: 'Multiple-testing 調整後 p-value 大於 0.10',
  artifact_contract_version_incompatible: 'Serving artifact contract 與目前版本不相容',
  policy_value_head_count_not_one: 'Fusion v14 不是單一 residual adjustment head',
  policy_value_heads_incompatible: 'Fusion v14 head 必須只有 residual_adjustment_model',
  residual_adjustment_model_missing: 'Fusion residual adjustment model 缺失',
  legacy_s12_serving_heads_forbidden: 'Artifact 仍含已退役的 S12 serving heads',
  third_selection_serving_head_forbidden: 'Artifact 仍含額外 selection serving head',
  residual_adjustment_model_candidate_time_s12_feature_forbidden: 'Residual model 錯誤使用 candidate-time S12 feature',
  artifact_missing: '正式 artifact 不存在',
  champion_pointer_missing: 'Champion pointer 不存在',
  validation_not_pass: 'Artifact validation 尚未 PASS',
  promotion_state_not_serving: '尚未進入 serving promotion state',
  threshold_margin_evidence_incomplete: '策略命中的 raw threshold margin 尚未完整',
  challenger_affinity_projection_incomplete: 'Raw margin 已存在，但 challenger affinity projection 尚未完整',
  primary_expected_return_not_allowed: '尚未取得 primary expected-return 權限',
  current_day_threshold_affinity_complete: '當日 Threshold V2 affinity 尚未完整',
  current_day_challenger_route_complete: '當日 Route V2 分數尚未完整持久化',
  current_day_challenger_route_incomplete: '當日通過 L0 的股票尚未全部留下 Route V2 分數',
  joint_promotion_not_committed: 'Threshold V2 與 Route V2 尚未共同完成 promotion commit',
}

function stageIcon(id: PipelineMaturityStage['id']) {
  const cls = 'h-4 w-4'
  if (id === 'threshold_margin_affinity_v2') return <SlidersHorizontal className={cls} />
  if (id === 'oof_redundancy') return <GitCompareArrows className={cls} />
  if (id === 'route_score_v2') return <Route className={cls} />
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
  const evidenceScopes = stage.evidence_scopes ?? []
  const offlineScope = evidenceScopes.find((scope) => scope.key === 'offline_candidate') ?? null
  const scopedHistory = evidenceScopes.length > 0
  const latestHistory = history[history.length - 1] ?? null
  const previousHistory = history[history.length - 2] ?? null
  const lineageEvidenceDate = scopedHistory ? latestHistory?.evidence_date ?? offlineScope?.business_date ?? null : stage.lineage.evidence_date
  const lineageOofMaxDate = scopedHistory ? offlineScope?.oof_max_date ?? null : stage.lineage.oof_max_date
  const lineageVersion = scopedHistory ? offlineScope?.version ?? null : stage.version
  const lineageArtifact = scopedHistory ? offlineScope?.artifact_id ?? null : stage.lineage.artifact_id
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
            {evidenceScopes.length ? (
              <div className="space-y-3">
                {evidenceScopes.map((scope) => {
                  const scopeStatus = STATUS_STYLE[scope.status]
                  return (
                    <section key={scope.key} className="overflow-hidden rounded-xl border border-white/[0.07] bg-black/[0.12]">
                      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-white/[0.06] px-3 py-2.5">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-slate-200">{scope.label}</p>
                          <p className="mt-1 break-words text-[11px] leading-4 text-slate-500">{scope.note}</p>
                        </div>
                        <Badge variant="outline" className={`h-auto rounded-full px-2 py-0.5 text-[10px] ${scopeStatus.cls}`}>{scopeStatus.label}</Badge>
                      </div>
                      <dl className="grid grid-cols-[78px_minmax(0,1fr)] gap-x-2 gap-y-1 border-b border-white/[0.06] px-3 py-2 text-[10px] leading-4">
                        <dt className="text-slate-600">Business</dt><dd className="sv-num break-all text-slate-400">{scope.business_date ?? 'N/A'}</dd>
                        <dt className="text-slate-600">OOF max</dt><dd className="sv-num break-all text-slate-400">{scope.oof_max_date ?? 'N/A'}</dd>
                        <dt className="text-slate-600">Updated</dt><dd className="sv-num break-all text-slate-400">{scope.updated_at ?? 'N/A'}</dd>
                        <dt className="text-slate-600">Version</dt><dd className="sv-num break-all text-slate-400">{scope.version ?? 'Unavailable'}</dd>
                        <dt className="text-slate-600">Artifact</dt><dd className="sv-num break-all text-slate-400">{scope.artifact_id ?? 'N/A'}</dd>
                      </dl>
                      <div className="grid px-1 sm:grid-cols-2">
                        {scope.metrics.map((item) => <MetricCell key={`${scope.key}:${item.key}`} metric={item} />)}
                      </div>
                    </section>
                  )
                })}
              </div>
            ) : (
              <div className="grid border-y border-white/[0.07] px-1 sm:grid-cols-2">
                {stage.metrics.map((item) => <MetricCell key={item.key} metric={item} />)}
              </div>
            )}
          </div>

          <div className="min-w-0 space-y-3">
            <div>
              <p className="text-xs font-semibold text-slate-500">尚未通過 / Blockers</p>
              {evidenceScopes.length ? (
                <div className="mt-2 space-y-3">
                  {evidenceScopes.map((scope) => (
                    <div key={scope.key} className="rounded-lg border border-white/[0.06] px-2.5 py-2">
                      <p className="text-[11px] font-semibold text-slate-400">{scope.label}</p>
                      {scope.blockers.length ? (
                        <div className="mt-1.5 space-y-1.5">
                          {scope.blockers.map((blocker) => (
                            <div key={blocker} className="border-l-2 border-rose-400/45 pl-2">
                              <p className="text-xs leading-5 text-rose-200">{blockerText(blocker)}</p>
                              <code className="mt-0.5 block break-all text-[11px] leading-4 text-slate-600">{blocker}</code>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-300">
                          <CheckCircle2 className="h-3.5 w-3.5" /> 此 scope 無 blocker
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : stage.blockers.length ? (
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
              <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-500"><Database className="h-3.5 w-3.5" /> {scopedHistory ? '同 contract offline history' : 'Lineage'}</p>
              <dl className="mt-2 grid grid-cols-[84px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px] leading-4">
                <dt className="text-slate-600">Evidence</dt><dd className="sv-num break-all text-slate-400">{lineageEvidenceDate ?? '尚無 evidence'}</dd>
                <dt className="text-slate-600">Previous</dt><dd className="sv-num break-all text-slate-400">{previousHistory?.evidence_date ?? (scopedHistory ? '尚無同 contract 前一筆' : 'First evidence')}</dd>
                <dt className="text-slate-600">Delta</dt><dd className="sv-num break-all text-cyan-300">{historyDelta == null ? (scopedHistory ? '尚無同 contract 可比較數值' : 'Not comparable') : `${historyDelta > 0 ? '+' : ''}${historyMetric(historyDelta)}`}</dd>
                <dt className="text-slate-600">Trend</dt><dd className="sv-num break-words text-slate-400">{historyTrend || (scopedHistory ? '尚無同 contract 歷史' : 'No prior history')}</dd>
                <dt className="text-slate-600">OOF max</dt><dd className="sv-num break-all text-slate-400">{stage.lineage.oof_applicable === false ? 'N/A (not OOF)' : lineageOofMaxDate ?? '尚無 OOF evidence'}</dd>
                <dt className="text-slate-600">Version</dt><dd className="sv-num break-all text-slate-400">{lineageVersion ?? 'Unavailable'}</dd>
                <dt className="text-slate-600">Artifact</dt><dd className="sv-num break-all text-slate-400">{lineageArtifact ?? 'Not applicable'}</dd>
                {stage.lineage.comparison_contract ? <><dt className="text-slate-600">Contract</dt><dd className="sv-num break-all text-slate-400">{stage.lineage.comparison_contract}</dd></> : null}
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
      <section className="sv-readable-card-content overflow-hidden rounded-[24px] border border-white/[0.09] bg-[linear-gradient(180deg,rgba(22,23,30,0.96),rgba(10,11,15,0.985))]" aria-label="成熟度與決策貢獻載入中">
        <div className="p-5"><div className="h-5 w-64 animate-pulse rounded bg-white/[0.08]" /></div>
        <div className="grid gap-3 p-4 lg:grid-cols-2">
          {[1, 2, 3, 4, 5, 6].map((row) => <div key={row} className="h-64 animate-pulse rounded-[18px] border border-white/[0.06] bg-white/[0.032]" />)}
        </div>
      </section>
    )
  }

  if (error || !data) {
    return (
      <section className="sv-readable-card-content rounded-[24px] border border-rose-400/25 bg-rose-400/[0.06] p-5">
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
  const strategyRouteBundle = data.strategy_route_bundle

  return (
    <section className="sv-readable-card-content overflow-hidden rounded-[24px] border border-white/[0.09] bg-[linear-gradient(180deg,rgba(22,23,30,0.96),rgba(10,11,15,0.985))] shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_18px_52px_rgba(0,0,0,0.42)]" aria-labelledby="pipeline-maturity-title">
      <div className="border-b border-white/[0.08] px-5 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold text-amber-300">Decision ownership & evidence maturity</p>
            <h2 id="pipeline-maturity-title" className="mt-1 text-base font-semibold text-slate-100">成熟度監控（非完整流程圖）</h2>
            <p className="mt-1 max-w-4xl text-xs leading-5 text-slate-500">
              本區只列需要獨立成熟度門檻的 owner，不代表流程跳過 L2/L3。完整 runtime 為 L0 → L0.5 → L1 → L1.25 → L1.5 → L2 → L3 → L4 → L4+；L3.5 只保留 observe-only conflict telemetry，不是 serving gate。
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

      {strategyRouteBundle ? (
        <div className="mx-4 mt-4 rounded-[18px] border border-cyan-400/20 bg-cyan-400/[0.045] p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Route className="h-4 w-4 text-cyan-300" />
                <h3 className="text-sm font-semibold text-slate-100">Threshold V2 + Route V2 joint promotion</h3>
                <Badge variant="outline" className={`h-auto rounded-full px-2 py-0.5 text-[11px] ${STATUS_STYLE[strategyRouteBundle.status].cls}`}>
                  {STATUS_STYLE[strategyRouteBundle.status].label}
                </Badge>
                <Badge variant="outline" className={`h-auto rounded-full px-2 py-0.5 text-[11px] ${MODE_STYLE[strategyRouteBundle.contribution_mode].cls}`}>
                  {MODE_STYLE[strategyRouteBundle.contribution_mode].label}
                </Badge>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-400">
                Threshold 完整只代表當日策略門檻資料可用；必須同時具備全 universe Route 分數、purged OOS 品質通過與同一份 promotion commit，才會進 production。
              </p>
              <p className="mt-1 text-[11px] leading-5 text-slate-500">
                L1 Threshold V2 與 L1.5 Route V2 是同一組 challenger，必須一起 promotion；L1.25 是既有 production redundancy control，獨立持續貢獻，不參與這次 joint promotion。
              </p>
            </div>
            <div className="grid shrink-0 grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-xl border border-white/[0.07] px-3 py-2"><p className="text-slate-500">Threshold</p><p className="mt-1 font-semibold text-slate-100">{strategyRouteBundle.threshold_coverage_ready ? 'ready' : 'blocked'}</p></div>
              <div className="rounded-xl border border-white/[0.07] px-3 py-2"><p className="text-slate-500">Route rows</p><p className="sv-num mt-1 font-semibold text-slate-100">{strategyRouteBundle.current_route_rows}/{strategyRouteBundle.current_reference_rows}</p></div>
              <div className="rounded-xl border border-white/[0.07] px-3 py-2"><p className="text-slate-500">Mature dates</p><p className="sv-num mt-1 font-semibold text-slate-100">{strategyRouteBundle.route_mature_dates}/{strategyRouteBundle.route_required_dates}</p></div>
            </div>
          </div>
          {strategyRouteBundle.blockers.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {strategyRouteBundle.blockers.map((blocker) => <span key={blocker} className="rounded-full border border-rose-400/20 bg-rose-400/[0.06] px-2 py-1 text-[11px] text-rose-200">{blockerText(blocker)}</span>)}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid items-start gap-3 p-4 lg:grid-cols-2">
        {data.stages.map((stage) => <StageRow key={stage.id} stage={stage} />)}
      </div>
    </section>
  )
}
