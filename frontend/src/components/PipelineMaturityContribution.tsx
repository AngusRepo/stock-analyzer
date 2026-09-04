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
  serving: { label: '正式服務中', cls: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' },
  ready: { label: '證據已備妥', cls: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200' },
  collecting: { label: '累積中', cls: 'border-amber-400/30 bg-amber-400/10 text-amber-200' },
  failed_quality: { label: '品質未過', cls: 'border-rose-400/30 bg-rose-400/10 text-rose-200' },
  blocked: { label: '必要條件被擋住', cls: 'border-rose-400/30 bg-rose-400/10 text-rose-200' },
  unavailable: { label: '資料尚未具備', cls: 'border-slate-400/30 bg-slate-400/10 text-slate-300' },
}

const MODE_STYLE = {
  production: { label: '正式路徑', cls: 'border-emerald-400/25 text-emerald-200' },
  shadow: { label: '影子學習（不影響正式結果）', cls: 'border-violet-400/25 text-violet-200' },
  evidence_only: { label: '只累積證據', cls: 'border-amber-400/25 text-amber-200' },
} as const

const METRIC_LABELS: Record<string, string> = {
  strategy_count: '策略數', matrix_cells: 'PIT 策略×股票標籤格數', challenger_route_rows: '下游 Route V2 分數列數',
  oof_max_date: '樣本外證據最晚日期', overlap_pairs: '有重疊的策略配對數', eligible_pairs: '可評估的樣本外策略配對數',
  edge_count: '策略重複關係邊數', effective_strategies: '去除重複後的有效策略數', sample_count: 'Route V2 已標記觀察數',
  incumbent_route_avg: '現行 Route 當日平均分（非績效）', challenger_route_avg: '候選 Route 當日平均分（非績效）', route_floor: '只用訓練集選出的最低 Route 分數',
  incumbent_sample_count: '同日配對的現行 Route 樣本', paired_date_count: '現行與候選 Route 完整配對日期',
  absolute_spread_lcb90: '候選 Route 絕對報酬價差 LCB90', challenger_incumbent_delta_lcb90: '候選相對現行 Route 連續權重增量 LCB90',
  brier: '機率誤差（Brier，需優於基準）', walk_forward: '離線候選跨窗驗證', strict_pit_rows: '正式 L4 PIT 樣本列數',
  strict_pit_dates: '正式 L4 PIT 交易日數', shadow_walk_forward: 'Rolling cohort 診斷跨窗驗證', frozen_forward_quality: 'Rolling cohort 診斷品質',
  shadow_usable_samples: '最新監控封包 usable samples', shadow_usable_dates: '最新監控封包 usable dates',
  shadow_oof_rows: '最新監控封包 OOF rows', shadow_oof_max_date: '最新監控封包 OOF 截止日',
  shadow_evidence_advanced: '相較前一監控業務日是否有新增成熟 evidence',
  frozen_forward_dates: 'Rolling cohort 診斷 OOF 交易日數', structure_samples: 'S12 影子結構樣本', structure_dates: 'S12 影子結構交易日',
  execution_samples: 'S12 影子實際執行樣本', execution_dates: 'S12 影子實際執行交易日', selection_corr_lcb90: '選股相關性 90% 保守下界（診斷）',
  selection_spread_lcb90: '選股價差報酬 90% 保守下界（診斷）', champion_corr_delta: '相對正式 L4 的相關性增量下界（診斷）',
  champion_spread_delta: '相對正式 L4 的價差增量下界（診斷）', final_champion_comparison: '離線候選最終交易 EV 配對比較',
  execution_expert: '條件式執行專家（影子診斷）', execution_probability: '執行機率專家（影子診斷）',
  serving_forward_guard_state: '正式服務 artifact 的 T+5 保護狀態', serving_forward_evaluable_dates: '正式服務 forward 可評估交易日',
  serving_forward_degraded_streak: '正式服務品質連續惡化日數', serving_forward_recovery_streak: '正式服務品質連續恢復日數',
  sector_source_signal_dates: '目前已合法累積的 PIT sector signal dates（供後續 cohort）',
  prospective_gate_decision: '每日鎖定候選正式判定', prospective_evaluable_dates: '每日鎖定候選成熟 OOS 日期',
  prospective_corr_lcb90: 'L4 相對正式 ML 排序增量 LCB90', prospective_spread_lcb90: 'L4 相對正式 ML 價差增量 LCB90',
  prospective_corr_delta_lcb90: 'L4+ 相對 L4 排序增量 LCB90', prospective_spread_delta_lcb90: 'L4+ 相對 L4 價差增量 LCB90',
  prospective_top_return_lcb90: '候選 Top bucket 成本後報酬 LCB90', prospective_prediction_max_date: '最新成熟 pre-outcome 預測日',
  prospective_trained_until: '候選訓練截止日', prospective_label_known_min: '首筆結果揭露日', prospective_label_known_max: '最新結果揭露日',
  prospective_selection_semantic_floor: '修正後 selection semantic 起點',
  prospective_candidate_state: '鎖定候選 registry 狀態',
}

const FIELD_LABELS: Record<string, string> = {
  Artifact: '產物 ID', Cadence: '更新頻率', Role: '用途角色', 'Date means': '日期代表意義', Availability: '資料可用狀態',
  Reason: '原因', State: '服務狀態', Model: '模型版本', Contract: '資料契約版本', Mode: '服務模式', 'Effective at': '生效時間',
  'Observed at': '觀測時間', Identity: '身分／lineage 確認', Validation: '驗證版本', 'Run date': '執行日期', 'OOF max': '樣本外證據最晚日期',
  Cohort: '固定評估 cohort', Evaluation: '評估 ID', 'Business date': '業務日期', Fingerprint: '模型指紋', 'Evaluable dates': '可評估交易日',
  'Previous business date': '前一監控業務日', 'Evidence comparable': '是否同 cohort／同 evaluator 可比較',
  'Evidence advanced': '是否新增成熟 evidence', 'OOF min': '樣本外證據最早日期', 'OOF dates': '樣本外交易日數',
  'OOF rows': '樣本外列數', 'Usable samples': '可用樣本數', 'Usable dates': '可用交易日數',
  'Degraded streak': '連續惡化日數', 'Recovery streak': '連續恢復日數', 'Last date': '最新預測日期', 'Lineage bound': '是否綁定同一產物 lineage',
}

const BLOCKER_LABELS: Record<string, string> = {
  insufficient_paired_mature_oof_residual_returns: '同日配對的成熟 OOF residual return 日期仍不足',
  enough_total_dates: '總成熟日期不足',
  enough_train_dates: '訓練日期不足',
  enough_oos_dates: 'OOS 日期不足',
  route_floor_selected_on_train_only: '尚無法只用訓練集選出 route floor',
  incumbent_route_lineage_complete: '現行 Route 的同日配對證據尚未完整',
  top_bucket_cost_net_return_lcb90_positive: 'Top bucket 成本後報酬 LCB90 未轉正',
  absolute_spread_lcb90_positive: '候選 Route 絕對報酬排序方向 LCB90 未轉正',
  residual_spread_lcb90_positive: 'Residual spread LCB90 未轉正',
  challenger_continuous_weight_beats_incumbent_lcb90_positive: '候選 Route 尚未以全候選連續權重 LCB90 證明優於現行 Route',
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
  threshold_margin_evidence_incomplete: '策略命中的 raw threshold margin 尚未完整',
  challenger_affinity_projection_incomplete: 'Raw margin 已存在，但 challenger affinity projection 尚未完整',
  primary_expected_return_not_allowed: '尚未取得 primary expected-return 權限',
  current_day_threshold_affinity_complete: '當日 Threshold V2 affinity 尚未完整',
  current_day_challenger_route_complete: '當日 Route V2 分數尚未完整持久化',
  current_day_incumbent_route_complete: '當日現行 Route 分數尚未完整持久化',
  current_day_challenger_route_incomplete: '當日通過 L0 的股票尚未全部留下 Route V2 分數',
  joint_promotion_not_committed: 'Threshold V2 與 Route V2 尚未共同完成 promotion commit',
  formal_labeler_upgrade_pending: '既有 production evidence 存在；正式 revenue-PIT labeler 尚未物化',
  'data_validity:date_count_below_validation_floor': '可用交易日未達離線驗證下限',
  'residual_adjustment:insufficient_dates': 'Residual adjustment 的獨立交易日不足，尚不能執行正式 walk-forward',
  'residual_champion:residual_adjustment_model_not_validated': 'Residual candidate 尚未通過驗證；只阻擋 L4+ residual，production 維持 safe-abstention',
  prospective_date_count_below_floor: '每日鎖定候選成熟 OOS 日期未滿 10 日；維持 PENDING，不判失敗',
  prospective_top_return_lcb90_not_positive: 'Top bucket 成本後報酬 LCB90 尚未轉正',
  prospective_corr_lcb90_not_positive: 'L4 排序相關性 LCB90 尚未轉正',
  prospective_spread_lcb90_not_positive: 'L4 多空價差 LCB90 尚未轉正',
  prospective_corr_delta_lcb90_inferior_to_formal_ml: 'L4 排序相關性增量 LCB90 低於正式 ML baseline',
  prospective_spread_delta_lcb90_inferior_to_formal_ml: 'L4 多空價差增量 LCB90 低於正式 ML baseline',
  offline_candidate_rejected: '離線候選已拒絕；每日前瞻成熟門檻不適用',
  prospective_corr_delta_lcb90_inferior_to_l4: 'L4+ 排序相關性增量 LCB90 低於 L4',
  prospective_spread_delta_lcb90_inferior_to_l4: 'L4+ 多空價差增量 LCB90 低於 L4',
  prospective_recent_two_dates_jointly_inferior: 'L4+ 最近兩個成熟日的排序與價差增量同時為負',
  offline_gate_not_pass: '候選離線入場門檻未通過',
  offline_validation_packet_not_pass: '候選離線 validation packet 未通過',
  owner_operational_parity_not_pass: '候選尚未通過正式 owner operational parity',
  prediction_not_after_candidate_trained_until: '預測日期未晚於候選訓練截止日，不能算入成熟度',
  label_known_not_after_candidate_freeze: '該日結果在候選 freeze 前已知，為避免 look-ahead 不計入成熟度',
  label_known_date_missing: '缺少結果實際揭露日，無法驗證 no-look-ahead',
  candidate_trained_until_invalid: '候選訓練截止日缺失或晚於 freeze 日期',
  prospective_trained_until_mismatch: '候選與成熟證據的訓練截止日 lineage 不一致',
  selection_semantic_floor_missing: '找不到 canonical V5 selection semantic 起點',
  prediction_before_selection_semantic_floor: '包含負向排序修正前的舊 semantic 日期，不能算入成熟度',
  prospective_label_known_range_invalid: '成熟證據的結果揭露日期範圍無效',
  prospective_forward_query_failed: '每日鎖定候選 pre-outcome 證據查詢失敗',
  prospective_forward_evidence_missing: '每日鎖定候選 pre-outcome 證據尚未物化',
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
  if (value == null || value === '') {
    if (metric.availability === 'pending') return '等待中'
    if (metric.availability === 'not_applicable') return '不適用'
    if (metric.availability === 'missing') return '資料缺漏'
    if (metric.availability === 'blocked') return '此範圍證據被 lineage 擋住'
    return '資料尚未具備'
  }
  if (typeof value === 'boolean') return value ? '通過' : '未通過'
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
  if (normalized.startsWith('formal_labeler_upgrade_pending:')) {
    return BLOCKER_LABELS.formal_labeler_upgrade_pending
  }
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
        <p className="min-w-0 text-xs leading-5 text-slate-500">{METRIC_LABELS[metric.key] ?? metric.label}</p>
        {metric.passed === true ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" /> : null}
        {metric.passed === false ? <CircleAlert className="h-3.5 w-3.5 shrink-0 text-rose-400" /> : null}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={`sv-num break-all text-sm font-semibold ${tone}`}>{displayValue(metric)}</span>
        {target ? <span className="sv-num text-[11px] text-slate-600">門檻 {target}</span> : null}
      </div>
      {metric.note ? <p className="mt-1 text-[11px] leading-4 text-slate-600">{metric.note}</p> : null}
      {metric.reason_code ? <code className="mt-1 block break-all text-[10px] leading-4 text-slate-700">{metric.reason_code}</code> : null}
    </div>
  )
}

function MetricSection({
  title,
  description,
  metrics,
  collapsible = false,
}: {
  title: string
  description: string
  metrics: PipelineMaturityMetric[]
  collapsible?: boolean
}) {
  if (!metrics.length) return null
  const body = (
    <>
      <p className="text-xs font-semibold text-slate-200">{title}</p>
      <p className="mt-1 text-[11px] leading-4 text-slate-500">{description}</p>
      <div className="mt-2 grid border-y border-white/[0.07] px-1 sm:grid-cols-2">
        {metrics.map((item) => <MetricCell key={item.key} metric={item} />)}
      </div>
    </>
  )
  if (!collapsible) return <div>{body}</div>
  return (
    <details className="rounded-lg border border-white/[0.07] bg-black/15 p-3">
      <summary className="cursor-pointer text-xs font-semibold text-slate-300">{title} · {metrics.length} 項</summary>
      <p className="mt-1 text-[11px] leading-4 text-slate-500">{description}</p>
      <div className="mt-2 grid border-y border-white/[0.07] px-1 sm:grid-cols-2">
        {metrics.map((item) => <MetricCell key={item.key} metric={item} />)}
      </div>
    </details>
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
  const priorFiniteHistory = [...history.slice(0, -1)].reverse().find((point) => point.value != null && point.identity_valid !== false) ?? null
  const previousHistory = [...history.slice(0, -1)].reverse().find((point) => (
    point.value != null
    && point.identity_valid !== false
    && point.artifact_contract_version === latestHistory?.artifact_contract_version
  )) ?? null
  const historyDelta = latestHistory?.value != null && latestHistory.identity_valid !== false && previousHistory?.value != null
    ? latestHistory.value - previousHistory.value
    : null
  const historyMetric = (value: number | null) => displayValue({
    key: 'history',
    label: 'history',
    value,
    unit: latestHistory?.unit,
  })
  const historyComparison = historyDelta != null
    ? `${historyDelta > 0 ? '+' : ''}${historyMetric(historyDelta)}`
    : latestHistory?.value == null || latestHistory.identity_valid === false
      ? 'Current evidence unavailable or identity-blocked'
      : priorFiniteHistory && priorFiniteHistory.artifact_contract_version !== latestHistory.artifact_contract_version
        ? `First comparable ${latestHistory.artifact_contract_version ?? 'contract'} evidence · prior ${priorFiniteHistory.artifact_contract_version ?? 'contract unknown'}`
        : 'First comparable evidence'
  const historyTrend = history
    .filter((point) => point.value != null
      && point.identity_valid !== false
      && point.artifact_contract_version === latestHistory?.artifact_contract_version)
    .slice(-4).map((point) => `${point.evidence_date.slice(5)} ${displayValue({ key: 'history', label: 'history', value: point.value, unit: point.unit })}`).join(' | ')
  const blockerGroups = stage.blocker_groups?.length
    ? stage.blocker_groups
    : [{ scope: 'stage', title: 'Blockers', blockers: stage.blockers }]
  const scopedCandidateStage = stage.id === 'l4' || stage.id === 'fusion'
  const allPromotionMetrics = scopedCandidateStage
    ? stage.metrics.filter((item) => item.scope === 'promotion_gate')
    : stage.metrics
  const prospectiveMetrics = scopedCandidateStage
    ? allPromotionMetrics.filter((item) => item.key.startsWith('prospective_'))
    : []
  const offlinePromotionMetrics = scopedCandidateStage
    ? allPromotionMetrics.filter((item) => !item.key.startsWith('prospective_'))
    : allPromotionMetrics
  const lifecycleMetrics = stage.metrics.filter((item) => item.scope === 'lifecycle')
  const productionMetrics = stage.metrics.filter((item) => item.scope === 'production')
  const monitoringMetrics = stage.metrics.filter((item) => item.scope === 'monitoring')
  const diagnosticMetrics = stage.metrics.filter((item) => item.scope === 'diagnostic')
  const evidenceScopes = stage.lineage.evidence_scopes
  const productionServingState = evidenceScopes?.serving_pointer
    ? evidenceScopes.serving_pointer.artifact_state === 'safe_abstention'
      ? 'Production：安全基線運作中（learned alpha 貢獻 0；上游選股流程持續運作）'
      : evidenceScopes.serving_pointer.artifact_state === 'serving'
        ? 'Production：learned expected-return artifact 正式服務中'
        : `Production：serving pointer ${evidenceScopes.serving_pointer.availability}`
    : null
  const metricByKey = new Map(stage.metrics.map((item) => [item.key, item]))
  const prospectiveDateMetric = metricByKey.get('prospective_evaluable_dates')
  const prospectiveDecisionMetric = metricByKey.get('prospective_gate_decision')
  const prospectiveMaxDateMetric = metricByKey.get('prospective_prediction_max_date')
  const prospectiveTrainedUntilMetric = metricByKey.get('prospective_trained_until')
  const prospectiveSemanticFloorMetric = metricByKey.get('prospective_selection_semantic_floor')
  const offlineCandidateRejected = scopedCandidateStage && evidenceScopes?.offline_candidate
    ? ['offline_failed', 'rejected'].includes(String(metricByKey.get('prospective_candidate_state')?.value ?? '').toLowerCase())
      || offlinePromotionMetrics.some((item) => item.passed === false)
    : false
  const scopedEvidenceTruth = scopedCandidateStage && evidenceScopes?.offline_candidate
    ? [
      `鎖定候選 freeze ${evidenceScopes.offline_candidate.source_run_date ?? '缺漏'}`,
      `訓練截止 ${prospectiveTrainedUntilMetric?.value ?? '尚無'}`,
      `合格前瞻證據起算 ${prospectiveSemanticFloorMetric?.value ?? '尚無'}`,
      offlineCandidateRejected
        ? '離線已拒絕 · 每日 pre-outcome 門檻不適用'
        : `每日成熟 OOS ${prospectiveDateMetric?.value ?? 0}/${prospectiveDateMetric?.target ?? 10}`,
      offlineCandidateRejected ? null : `最新成熟預測日 ${prospectiveMaxDateMetric?.value ?? '尚無'}`,
      offlineCandidateRejected ? null : `正式 gate ${prospectiveDecisionMetric?.value ?? 'MISSING'}`,
    ].filter(Boolean).join(' · ')
    : null
  const evidenceScopeRows = [
    evidenceScopes?.frozen_forward ? {
      scope: 'frozen_forward',
      title: 'Rolling cohort 日更診斷（非升級門檻）',
      rows: [
        ['Cohort', evidenceScopes.frozen_forward.cohort_id],
        ['Evaluation', evidenceScopes.frozen_forward.evaluation_id],
        ['Model', evidenceScopes.frozen_forward.model_version],
        ['Validation', evidenceScopes.frozen_forward.validation_schema_version],
        ['Business date', evidenceScopes.frozen_forward.business_date],
        ['Previous business date', evidenceScopes.frozen_forward.previous_business_date],
        ['Evidence comparable', evidenceScopes.frozen_forward.evidence_comparable_to_previous_business_date == null ? null : evidenceScopes.frozen_forward.evidence_comparable_to_previous_business_date ? '是' : '否'],
        ['Evidence advanced', evidenceScopes.frozen_forward.evidence_advanced_from_previous_business_date == null
          ? evidenceScopes.frozen_forward.previous_business_date ? '不可比較（lineage 不同）' : '首次證據'
          : evidenceScopes.frozen_forward.evidence_advanced_from_previous_business_date ? '是' : '否，只有封包日期前進'],
        ['Cadence', evidenceScopes.frozen_forward.cadence],
        ['Role', evidenceScopes.frozen_forward.role],
        ['Date means', '監控封包的執行業務日，不等於成熟 OOF 有增加'],
        ['Availability', evidenceScopes.frozen_forward.availability],
        ['Reason', evidenceScopes.frozen_forward.reason_code],
        ['OOF min', evidenceScopes.frozen_forward.oof_min_date],
        ['OOF max', evidenceScopes.frozen_forward.oof_max_date],
        ['OOF dates', evidenceScopes.frozen_forward.oof_date_count == null ? null : String(evidenceScopes.frozen_forward.oof_date_count)],
        ['OOF rows', evidenceScopes.frozen_forward.oof_row_count == null ? null : String(evidenceScopes.frozen_forward.oof_row_count)],
        ['Usable samples', evidenceScopes.frozen_forward.sample_count == null ? null : String(evidenceScopes.frozen_forward.sample_count)],
        ['Usable dates', evidenceScopes.frozen_forward.date_count == null ? null : String(evidenceScopes.frozen_forward.date_count)],
      ],
    } : null,
    evidenceScopes?.offline_candidate ? {
      scope: 'offline_candidate',
      title: `${evidenceScopes.offline_candidate.cadence} 離線候選來源（只建立／排隊 candidate）`,
      rows: [
        ['Cadence', evidenceScopes.offline_candidate.cadence],
        ['Role', evidenceScopes.offline_candidate.role],
        ['Date means', '離線候選本身的資料／OOF 截止日'],
        ['Availability', evidenceScopes.offline_candidate.availability],
        ['Reason', evidenceScopes.offline_candidate.reason_code],
        ['Identity', evidenceScopes.offline_candidate.identity_assurance],
        ['Artifact', evidenceScopes.offline_candidate.artifact_id],
        ['Model', evidenceScopes.offline_candidate.model_version],
        ['Contract', evidenceScopes.offline_candidate.artifact_contract_version],
        ['Validation', evidenceScopes.offline_candidate.validation_schema_version],
        ['Candidate freeze date', evidenceScopes.offline_candidate.source_run_date],
        ['OOF prediction max', evidenceScopes.offline_candidate.oof_max_date],
        ['Label known max', evidenceScopes.offline_candidate.label_known_max_date],
      ],
    } : null,
    evidenceScopes?.serving_pointer ? {
      scope: 'serving_pointer',
      title: '目前正式服務中的產物（Production pointer）',
      rows: [
        ['Artifact', evidenceScopes.serving_pointer.artifact_id],
        ['Cadence', evidenceScopes.serving_pointer.cadence],
        ['Role', evidenceScopes.serving_pointer.role],
        ['Date means', evidenceScopes.serving_pointer.date_semantic],
        ['Availability', evidenceScopes.serving_pointer.availability],
        ['Reason', evidenceScopes.serving_pointer.reason_code],
        ['State', evidenceScopes.serving_pointer.artifact_state],
        ['Model', evidenceScopes.serving_pointer.model_version],
        ['Contract', evidenceScopes.serving_pointer.artifact_contract_version],
        ['Mode', evidenceScopes.serving_pointer.serving_mode],
        ['Effective at', evidenceScopes.serving_pointer.updated_at],
        ['Observed at', evidenceScopes.serving_pointer.observed_at],
      ],
    } : null,
    evidenceScopes?.runtime_guard ? {
      scope: 'runtime_guard',
      title: '正式服務產物的每日 T+5 品質保護',
      rows: [
        ['Artifact', evidenceScopes.runtime_guard.artifact_id],
        ['Fingerprint', evidenceScopes.runtime_guard.model_fingerprint],
        ['Model', evidenceScopes.runtime_guard.model_version],
        ['State', evidenceScopes.runtime_guard.state],
        ['Evaluable dates', String(evidenceScopes.runtime_guard.evaluable_date_count)],
        ['Degraded streak', String(evidenceScopes.runtime_guard.degraded_streak)],
        ['Recovery streak', String(evidenceScopes.runtime_guard.recovery_streak)],
        ['Cadence', evidenceScopes.runtime_guard.cadence],
        ['Role', evidenceScopes.runtime_guard.role],
        ['Date means', evidenceScopes.runtime_guard.date_semantic],
        ['Availability', evidenceScopes.runtime_guard.availability],
        ['Reason', evidenceScopes.runtime_guard.reason_code],
        ['Last date', evidenceScopes.runtime_guard.last_prediction_date],
        ['Lineage bound', evidenceScopes.runtime_guard.lineage_bound ? 'Yes' : 'No'],
      ],
    } : null,
  ].filter((item): item is { scope: string; title: string; rows: Array<Array<string | null>> } => item != null)
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
          {productionServingState ? <p className="mt-2 text-xs font-semibold leading-5 text-emerald-200">{productionServingState}</p> : null}
          {scopedEvidenceTruth ? <p className="mt-2 rounded-md border border-cyan-300/15 bg-cyan-300/[0.05] px-2.5 py-2 text-[11px] leading-5 text-cyan-100">{scopedEvidenceTruth}</p> : null}
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
            <div className="space-y-4">
              <MetricSection
                title={scopedCandidateStage
                  ? '每日鎖定候選正式升級門檻'
                  : '成熟度證據'}
                description={scopedCandidateStage
                  ? '固定同一候選，只計入訓練截止日後、且 candidate freeze 當下答案尚未揭露的 immutable PIT 日期；0–9 日維持 PENDING，不判失敗；滿 10 日才依 LCB90 判定。Weekly 新候選不會重置已鎖定候選成熟度。'
                  : '本階段的正式成熟度欄位。'}
                metrics={prospectiveMetrics}
              />
              <MetricSection
                title={`${evidenceScopes?.offline_candidate?.cadence ?? 'weekly'} 離線候選生成與入場門檻`}
                description="只負責建立可進入每日 pre-outcome 驗證的不可變候選；不直接 promote，也不取代每日累積的正式升級判定。"
                metrics={offlinePromotionMetrics}
              />
              <MetricSection
                title="Rolling cohort 日更診斷（非升級成熟度）"
                description="用 rolling 75/25 cohort 觀察整體資料流是否退化；不是鎖定候選、不是 production artifact，也不會改寫 promotion maturity。"
                metrics={monitoringMetrics}
              />
              <MetricSection
                title="Production 物化覆蓋與下一批候選 readiness"
                description="正式 L4 PIT 交易日數只代表 production materialization coverage；source readiness 供下一批候選使用，不回頭改寫舊 candidate，也不直接取得 promotion 權限。"
                metrics={lifecycleMetrics}
              />
              <MetricSection
                title="正式 serving artifact runtime guard"
                description="只監控目前實際 serving 的 artifact；N/A 表示 safe-abstention 下不需要 residual guard。"
                metrics={productionMetrics}
              />
              <MetricSection
                title="診斷與不適用欄位（非必要門檻）"
                description="供 root-cause 分析；FAIL、缺值或 N/A 不會單獨阻擋 Fusion v14 serving。"
                metrics={diagnosticMetrics}
                collapsible
              />
            </div>
          </div>

          <div className="min-w-0 space-y-3">
            <div>
              <p className="text-xs font-semibold text-slate-500">
                {scopedCandidateStage ? '分範圍的未通過條件' : '尚未通過的必要條件'}
              </p>
              {scopedCandidateStage ? (
                <p className="mt-1 text-[11px] leading-4 text-slate-600">
                  離線候選門檻只決定候選能否升級，不等於目前 production 被擋；正式狀態請以 Production serving pointer 範圍為準。
                </p>
              ) : null}
              {blockerGroups.some((group) => group.blockers.length) ? (
                <div className="mt-2 space-y-3">
                  {blockerGroups.map((group) => (
                    <div key={group.scope}>
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{group.title}</p>
                      <div className="space-y-1.5">
                        {group.blockers.length ? group.blockers.map((blocker) => (
                          <div key={blocker} className="border-l-2 border-rose-400/45 pl-2">
                            <p className="text-xs leading-5 text-rose-200">{blockerText(blocker)}</p>
                            <code className="mt-0.5 block break-all text-[11px] leading-4 text-slate-600">系統代碼：{blocker}</code>
                          </div>
                        )) : <p className="text-[11px] text-emerald-300">No blockers in this scope</p>}
                      </div>
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
              <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-500"><Database className="h-3.5 w-3.5" /> 資料來源與版本 lineage</p>
              <dl className="mt-2 grid grid-cols-[84px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px] leading-4">
                <dt className="text-slate-600">{scopedCandidateStage ? '離線升級候選截止日' : '資料截止日'}</dt><dd className="sv-num break-all text-slate-400">{stage.lineage.data_cutoff_date ?? stage.lineage.evidence_date ?? '資料尚未具備'}</dd>
                <dt className="text-slate-600">成熟結果已知截至</dt><dd className="sv-num break-all text-slate-400">{stage.lineage.mature_outcome_max_date ?? '尚未發布'}</dd>
                <dt className="text-slate-600">OOF 訊號截止日</dt><dd className="sv-num break-all text-slate-400">{stage.lineage.oof_applicable === false ? '不適用（此階段不是 OOF）' : stage.lineage.oof_max_date ?? `資料尚未具備 · ${stage.lineage.oof_unavailable_reason ?? '原因未提供'}`}</dd>
                <dt className="text-slate-600">監控封包業務日（非成熟進度）</dt><dd className="sv-num break-all text-slate-400">{stage.lineage.frozen_forward_business_date ?? '不適用／尚未具備'}</dd>
                {stage.lineage.cadence ? <><dt className="text-slate-600">更新頻率</dt><dd className="sv-num break-all text-slate-400">{stage.lineage.cadence}</dd></> : null}
                {stage.lineage.role ? <><dt className="text-slate-600">用途角色</dt><dd className="sv-num break-all text-slate-400">{stage.lineage.role}</dd></> : null}
                <dt className="text-slate-600">前次證據</dt><dd className="sv-num break-all text-slate-400">{previousHistory?.evidence_date ?? '首次證據'}</dd>
                <dt className="text-slate-600">相較前次變化</dt><dd className="sv-num break-words text-cyan-300">{historyComparison}</dd>
                <dt className="text-slate-600">近期趨勢</dt><dd className="sv-num break-words text-slate-400">{historyTrend || '尚無前次歷史'}</dd>
                <dt className="text-slate-600">版本</dt><dd className="sv-num break-all text-slate-400">{stage.version ?? '資料尚未具備'}</dd>
                <dt className="text-slate-600">產物 ID</dt><dd className="sv-num break-all text-slate-400">{stage.lineage.artifact_id ?? '不適用'}</dd>
                <dt className="text-slate-600">來源</dt><dd className="break-words text-slate-400">{stage.lineage.source}</dd>
                {stage.lineage.evidence_semantics ? <><dt className="text-slate-600">資料截止規則</dt><dd className="break-words text-slate-400">{stage.lineage.evidence_semantics}</dd></> : null}
              </dl>
              {evidenceScopeRows.length ? (
                <div className="mt-3 grid gap-2">
                  {evidenceScopeRows.map((scope) => (
                    <div key={scope.scope} className="rounded-lg border border-white/[0.07] bg-black/15 p-2">
                      <p className="text-[11px] font-semibold text-cyan-200">{scope.title}</p>
                      <dl className="mt-1 grid grid-cols-[76px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[10px] leading-4">
                        {scope.rows.map(([label, value]) => (
                          <div key={label} className="contents">
                            <dt className="text-slate-600">{FIELD_LABELS[label] ?? label}</dt>
                            <dd className="sv-num break-all text-slate-400">{value ?? (label === 'Reason' ? '沒有額外原因' : '資料缺漏')}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ))}
                </div>
              ) : null}
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
        <div className="space-y-3 p-4">
          <div className="grid gap-3 lg:grid-cols-3">
            {[1, 2, 3].map((row) => <div key={row} className="h-64 animate-pulse rounded-[18px] border border-white/[0.06] bg-white/[0.032]" />)}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {[4, 5].map((row) => <div key={row} className="h-64 animate-pulse rounded-[18px] border border-white/[0.06] bg-white/[0.032]" />)}
          </div>
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
  const allocationOwnerLabel = data.current_allocation_utility_owner === 'expected_return_owner'
    ? ownerLabel
    : 'Score V2 正式選股效用'
  const summaryItems = [
    { label: '正式預期報酬負責者', value: ownerLabel },
    { label: '目前配置效用負責者', value: allocationOwnerLabel },
    { label: '正式影響選股的階段', value: String(data.summary.production) },
    { label: '只觀察、不影響正式結果', value: String(data.summary.shadow) },
    { label: '證據仍在累積', value: String(data.summary.collecting) },
    { label: '必要門檻未通過', value: String(data.summary.failed_or_blocked) },
  ]
  const strategyRouteBundle = data.strategy_route_bundle
  const upstreamStageIds = new Set<PipelineMaturityStage['id']>([
    'threshold_margin_affinity_v2',
    'oof_redundancy',
    'route_score_v2',
  ])
  const expectedReturnStageIds = new Set<PipelineMaturityStage['id']>(['l4', 'fusion'])
  const upstreamStages = data.stages.filter((stage) => upstreamStageIds.has(stage.id))
  const expectedReturnStages = data.stages.filter((stage) => expectedReturnStageIds.has(stage.id))
  const otherStages = data.stages.filter((stage) => !upstreamStageIds.has(stage.id) && !expectedReturnStageIds.has(stage.id))

  return (
    <section className="sv-readable-card-content overflow-hidden rounded-[24px] border border-white/[0.09] bg-[linear-gradient(180deg,rgba(22,23,30,0.96),rgba(10,11,15,0.985))] shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_18px_52px_rgba(0,0,0,0.42)]" aria-labelledby="pipeline-maturity-title">
      <div className="border-b border-white/[0.08] px-5 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold text-amber-300">誰負責正式決策、證據成熟到哪裡</p>
            <h2 id="pipeline-maturity-title" className="mt-1 text-base font-semibold text-slate-100">各階段目前是否真的影響正式選股</h2>
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
        <details className="mt-3 rounded-xl border border-white/[0.07] bg-black/20 px-3 py-2 text-xs text-slate-400">
          <summary className="cursor-pointer font-semibold text-slate-200">頁面名詞白話說明</summary>
          <div className="mt-2 grid gap-2 leading-5 md:grid-cols-2 xl:grid-cols-4">
            <p><span className="font-semibold text-emerald-200">正式服務中（Production）</span>：這個 owner 的輸出目前真的會進入正式選股或風控。</p>
            <p><span className="font-semibold text-cyan-200">影子觀察（Shadow）</span>：會算結果、累積證據，但不會改正式推薦。</p>
            <p><span className="font-semibold text-amber-200">累積中（Collecting）</span>：資料存在，但樣本數、交易日或正式 labeler 尚未滿足升級條件。</p>
            <p><span className="font-semibold text-rose-200">必要門檻未通過（Blocked）</span>：有明確必要條件失敗；不是單純欄位空白。</p>
            <p><span className="font-semibold text-slate-200">資料尚未具備</span>：應該有資料但目前缺漏，因此系統保守不採用。</p>
            <p><span className="font-semibold text-slate-200">不適用（N/A）</span>：這個欄位本來就不屬於該階段，不是故障。</p>
            <p><span className="font-semibold text-slate-200">PIT</span>：只使用當時已知資料，禁止未來資料回頭滲入。</p>
            <p><span className="font-semibold text-slate-200">OOF</span>：模型未用該樣本訓練時產生的樣本外預測，用來避免自我驗證。</p>
          </div>
        </details>
      </div>

      {strategyRouteBundle ? (
        <div className="mx-4 mt-4 rounded-[18px] border border-cyan-400/20 bg-cyan-400/[0.045] p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Route className="h-4 w-4 text-cyan-300" />
                <h3 className="text-sm font-semibold text-slate-100">門檻證據 V2 + 路由分數 V2 必須一起升級</h3>
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
            </div>
            <div className="grid shrink-0 grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-xl border border-white/[0.07] px-3 py-2"><p className="text-slate-500">門檻資料覆蓋</p><p className="mt-1 font-semibold text-slate-100">{strategyRouteBundle.threshold_coverage_ready ? '已完整' : '尚未完整'}</p></div>
              <div className="rounded-xl border border-white/[0.07] px-3 py-2"><p className="text-slate-500">已有 Route 分數／應有股票</p><p className="sv-num mt-1 font-semibold text-slate-100">{strategyRouteBundle.current_route_rows}/{strategyRouteBundle.current_reference_rows}</p></div>
              <div className="rounded-xl border border-white/[0.07] px-3 py-2"><p className="text-slate-500">成熟交易日／要求日數</p><p className="sv-num mt-1 font-semibold text-slate-100">{strategyRouteBundle.route_mature_dates}/{strategyRouteBundle.route_required_dates}</p></div>
            </div>
          </div>
          {strategyRouteBundle.maturity_projection ? (
            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-white/[0.07] px-3 py-2">
                <p className="text-slate-500">合法／待成熟／不可重建</p>
                <p className="sv-num mt-1 font-semibold text-slate-100">{strategyRouteBundle.maturity_projection.eligibleDates}/{strategyRouteBundle.maturity_projection.pendingDates}/{strategyRouteBundle.maturity_projection.unavailableDates}</p>
              </div>
              <div className="rounded-xl border border-white/[0.07] px-3 py-2">
                <p className="text-slate-500">最早待成熟日期</p>
                <p className="sv-num mt-1 font-semibold text-slate-100">{strategyRouteBundle.maturity_projection.earliestPendingMaturityDate ?? '官方日曆尚未具備'}</p>
              </div>
              <div className="rounded-xl border border-white/[0.07] px-3 py-2">
                <p className="text-slate-500">最佳情境達 11 日</p>
                <p className="sv-num mt-1 font-semibold text-slate-100">{strategyRouteBundle.maturity_projection.bestCaseThresholdDate ?? '尚無法投影'}</p>
              </div>
              <div className="rounded-xl border border-white/[0.07] px-3 py-2">
                <p className="text-slate-500">仍需合法成熟日</p>
                <p className="sv-num mt-1 font-semibold text-slate-100">{strategyRouteBundle.maturity_projection.datesRemaining}</p>
              </div>
              <p className="text-[11px] leading-4 text-slate-500 sm:col-span-2 xl:col-span-4">未來日期僅為最佳情境投影；每一日仍須完整 V5 carrier、T+5 outcome、canonical identity 與 re-audit 全部通過，才會真正計入。</p>
            </div>
          ) : null}
          {strategyRouteBundle.blockers.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {strategyRouteBundle.blockers.map((blocker) => <span key={blocker} className="rounded-full border border-rose-400/20 bg-rose-400/[0.06] px-2 py-1 text-[11px] text-rose-200">{blockerText(blocker)}</span>)}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-3 p-4">
        <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,32fr)_minmax(0,32fr)_minmax(0,36fr)]">
          {upstreamStages.map((stage) => <StageRow key={stage.id} stage={stage} />)}
        </div>
        <div className="grid items-start gap-3 lg:grid-cols-2">
          {expectedReturnStages.map((stage) => <StageRow key={stage.id} stage={stage} />)}
        </div>
        {otherStages.length ? (
          <div className="grid items-start gap-3 lg:grid-cols-2">
            {otherStages.map((stage) => <StageRow key={stage.id} stage={stage} />)}
          </div>
        ) : null}
      </div>
    </section>
  )
}
