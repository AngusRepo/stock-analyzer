import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import AppShell from '@/components/AppShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { strategyLabApi, type StrategyEvidenceProfile, type StrategyEvidenceProfilesResponse, type StrategyLearningResponse, type StrategyPromotionGate, type StrategyReplacementGateSummary, type StrategySpec } from '@/lib/api'

type LearningRow = StrategyLearningResponse['specs'][number]
const EMPTY_STRATEGY_WEIGHTS: Record<string, number> = {}

function pct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '資料尚未具備'
  return `${(Number(value) * 100).toFixed(1)}%`
}
function rewardMetric(value: number | null | undefined, unit: 'return_fraction' | 'r_multiple'): string {
  if (value == null || !Number.isFinite(Number(value))) return '資料尚未具備'
  return unit === 'r_multiple' ? `${Number(value).toFixed(3)}R` : pct(value)
}

function numericMetric(value: number | null | undefined, digits = 4): string {
  if (value == null || !Number.isFinite(Number(value))) return '資料尚未具備'
  return Number(value).toFixed(digits)
}

function percentageMetric(value: number | null | undefined, digits = 3): string {
  if (value == null || !Number.isFinite(Number(value))) return '資料尚未具備'
  return `${(Number(value) * 100).toFixed(digits)}%`
}

function integerMetric(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '資料尚未具備'
  return String(Math.round(Number(value)))
}

function policyGateBoolean(value: boolean | number | string | string[] | null | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function strategyWeight(weights: Record<string, number>, strategyId: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(weights, strategyId)) return null
  const value = Number(weights[strategyId])
  return Number.isFinite(value) ? value : null
}

function signedClass(value: number | null | undefined): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric === 0) return 'text-slate-300'
  return numeric > 0 ? 'text-rose-300' : 'text-emerald-300'
}


function statusClass(status: string): string {
  if (status === 'active' || status === 'active_monitor' || status === 'learning' || status === 'accepted') return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
  if (status === 'shadow' || status === 'candidate' || status === 'candidate_ready' || status === 'proposed') return 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200'
  if (status === 'reward_join_missing' || status === 'rejected' || status === 'prefilter_failed') return 'border-rose-400/30 bg-rose-400/10 text-rose-200'
  if (status === 'research' || status === 'not_ready' || status === 'no_reward' || status === 'pending_maturity' || status === 'no_matches') return 'border-amber-400/30 bg-amber-400/10 text-amber-200'
  return 'border-slate-600 bg-slate-800/50 text-slate-300'
}

function gateResultClass(pass: boolean | null): string {
  if (pass == null) return 'text-slate-500'
  return pass ? 'text-emerald-300' : 'text-rose-300'
}

function gateResultLabel(pass: boolean | null): string {
  if (pass == null) return '尚無判定'
  return pass ? '通過' : '未通過'
}

function activationGateStatusLabel(status: string): string {
  if (status === 'not_evaluated' || status === 'not_applicable') return 'not-evaluated'
  return status
}

function activationGatePass(status: string): boolean | null {
  if (status === 'accepted') return true
  if (status === 'prefilter_failed' || status === 'rejected') return false
  return null
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: '正式選股中', active_monitor: '正式保留', active_cooldown: '正式降溫',
    learning: '持續學習', shadow: '證據比較', candidate: '候選', candidate_ready: '候選已成熟',
    research: '研究中', not_ready: '證據未成熟', no_reward: '尚無成熟報酬',
    pending_maturity: '等待 T+5', no_matches: '尚未命中型態', reward_join_missing: '報酬串接缺漏',
    unavailable: '資料尚未具備',
  }
  return labels[status] ?? status.replace(/_/g, ' ')
}

type StrategyLifecycleLane = 'active' | 'candidate'
type StrategyHealthBucket = 'execution_eligible' | 'performance_cooldown' | 'evidence_repair' | 'accumulating' | 'prefilter_failed' | 'promotion_pending'
type StrategyHealthSection = {
  key: StrategyHealthBucket
  label: string
  description: string
  className: string
  countClassName: string
}

const ACTIVE_STRATEGY_HEALTH_SECTIONS: StrategyHealthSection[] = [
  {
    key: 'execution_eligible',
    label: '可進待買',
    description: 'Allocation gate 通過，且封存 formal policy contribution > 0。',
    className: 'border-emerald-400/20 bg-emerald-400/[0.04]',
    countClassName: 'border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-200',
  },
  {
    key: 'performance_cooldown',
    label: '績效降溫',
    description: 'Active lifecycle 保留，但 formal contribution = 0；仍持續選股與評估。',
    className: 'border-amber-400/20 bg-amber-400/[0.04]',
    countClassName: 'border-amber-400/25 bg-amber-400/[0.08] text-amber-200',
  },
  {
    key: 'accumulating',
    label: '證據累積',
    description: '持續選股與評估，等待 T+5、樣本數或成熟交易日。',
    className: 'border-cyan-400/20 bg-cyan-400/[0.04]',
    countClassName: 'border-cyan-400/25 bg-cyan-400/[0.08] text-cyan-200',
  },
  {
    key: 'evidence_repair',
    label: '資料待修',
    description: '需重建 decision、PIT reference、reward join 或 formal policy lineage。',
    className: 'border-rose-400/20 bg-rose-400/[0.04]',
    countClassName: 'border-rose-400/25 bg-rose-400/[0.08] text-rose-200',
  },
]

const CANDIDATE_STRATEGY_HEALTH_SECTIONS: StrategyHealthSection[] = [
  {
    key: 'accumulating',
    label: '證據累積',
    description: '持續選股與評估，等待 T+5、樣本數或成熟交易日。',
    className: 'border-cyan-400/20 bg-cyan-400/[0.04]',
    countClassName: 'border-cyan-400/25 bg-cyan-400/[0.08] text-cyan-200',
  },
  {
    key: 'evidence_repair',
    label: '資料待修',
    description: '需重建 decision、PIT reference 或 reward join。',
    className: 'border-rose-400/20 bg-rose-400/[0.04]',
    countClassName: 'border-rose-400/25 bg-rose-400/[0.08] text-rose-200',
  },
  {
    key: 'prefilter_failed',
    label: 'Atomic 前置門檻未過',
    description: 'Candidate 已完成可比性檢查，但尚未通過 Atomic V7 proposal 前置門檻。',
    className: 'border-rose-400/20 bg-rose-400/[0.04]',
    countClassName: 'border-rose-400/25 bg-rose-400/[0.08] text-rose-200',
  },
  {
    key: 'promotion_pending',
    label: '升級待比較',
    description: '成熟 Candidate 等待 Atomic V7 同日配對與投組風險比較；不是被共用績效門檻淘汰。',
    className: 'border-amber-400/20 bg-amber-400/[0.04]',
    countClassName: 'border-amber-400/25 bg-amber-400/[0.08] text-amber-200',
  },
]

const STRATEGY_HEALTH_SECTIONS_BY_LANE: Record<StrategyLifecycleLane, StrategyHealthSection[]> = {
  active: ACTIVE_STRATEGY_HEALTH_SECTIONS,
  candidate: CANDIDATE_STRATEGY_HEALTH_SECTIONS,
}

const STRATEGY_LIFECYCLE_LANES: Array<{
  key: StrategyLifecycleLane
  label: string
  description: string
  className: string
  countClassName: string
}> = [
  {
    key: 'active',
    label: 'Active strategies',
    description: '目前具 production lifecycle 的策略；四種健康狀態只描述待買資格與資料品質。',
    className: 'border-emerald-400/20 bg-emerald-400/[0.025]',
    countClassName: 'border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-200',
  },
  {
    key: 'candidate',
    label: 'Candidate strategies',
    description: 'Candidate 本身就是 evidence accumulation 狀態；沒有額外的 Shadow 策略 stage。',
    className: 'border-violet-400/20 bg-violet-400/[0.025]',
    countClassName: 'border-violet-400/25 bg-violet-400/[0.08] text-violet-200',
  },
]

function strategyLifecycleLane(row: LearningRow): StrategyLifecycleLane {
  return row.status === 'active' ? 'active' : 'candidate'
}

function strategyHealthBucket(
  row: LearningRow,
  gate: StrategyPromotionGate | undefined,
  formalWeight: number | null,
): StrategyHealthBucket {
  if (
    !gate
    || row.learning.reward_state === 'reward_join_missing'
    || row.learning.reward_state === 'unavailable'
    || (
      row.learning.reward_state === 'ready'
      && gate.missing_evidence.some((reason) => reason.endsWith('_missing'))
    )
  ) return 'evidence_repair'
  if (strategyLifecycleLane(row) === 'active') {
    if (formalWeight == null) return 'evidence_repair'
    if (gate.allocation_eligible === true && formalWeight > 0) return 'execution_eligible'
    return 'performance_cooldown'
  }
  if (
    String(gate.activation_gate.status) === 'prefilter_failed'
  ) return 'prefilter_failed'
  if (
    row.learning.reward_state === 'pending_maturity'
    || row.learning.reward_state === 'no_matches'
    || gate.missing_evidence.every((reason) => (
      reason.startsWith('decisions_lt_')
      || reason.startsWith('samples_lt_')
      || reason.startsWith('mature_dates_lt_')
    ))
  ) return 'accumulating'
  return 'promotion_pending'
}

function strategyHealthLabel(bucket: StrategyHealthBucket): string {
  return {
    execution_eligible: '可進待買',
    performance_cooldown: '績效降溫 · contribution 0',
    evidence_repair: '資料管線待修',
    accumulating: '證據累積中',
    prefilter_failed: 'Atomic 前置門檻未過',
    promotion_pending: '等待 Atomic V7 比較',
  }[bucket]
}

function gateReasonLabel(reason: string): string {
  if (reason.startsWith('decisions_lt_')) return `可評估決策不足 ${reason.replace('decisions_lt_', '')} 筆`
  if (reason.startsWith('samples_lt_')) return `成熟報酬樣本不足 ${reason.replace('samples_lt_', '')} 筆`
  if (reason.startsWith('mature_dates_lt_')) return `成熟交易日不足 ${reason.replace('mature_dates_lt_', '')} 天`
  if (reason.startsWith('match_rate_lt_')) return `型態命中率低於 ${pct(Number(reason.replace('match_rate_lt_', '')))}`
  if (reason.startsWith('hit_rate_lt_') || reason.startsWith('active_hit_rate_lt_')) {
    return `勝率低於 ${pct(Number(reason.replace(/^(active_)?hit_rate_lt_/, '')))}`
  }
  const labels: Record<string, string> = {
    avg_return_not_positive: '扣成本平均報酬未大於 0',
    active_avg_return_not_positive: '現任策略扣成本平均報酬未大於 0',
    date_return_lcb90_not_positive: '每日報酬 90% 保守下界未大於 0',
    active_date_return_lcb90_not_positive: '現任策略每日報酬 90% 保守下界未大於 0',
    max_drawdown_missing: '最大回撤資料缺漏',
    active_max_drawdown_missing: '現任策略最大回撤資料缺漏',
    active_hit_rate_missing: '現任策略勝率資料缺漏',
    active_avg_return_missing: '現任策略平均報酬資料缺漏',
    active_date_return_lcb90_missing: '現任策略 LCB90 資料缺漏',
    production_owned_by_s12_calibration_not_selection_replacement: '正式權責屬於 S12 校準，不由選股策略替換流程升級',
    atomic_replacement_v7_not_accepted: '尚未取得 Atomic V7 同日配對替換接受證據',
  }
  if (reason.startsWith('max_drawdown_lt_') || reason.startsWith('active_max_drawdown_lt_')) {
    return `最大回撤超過容許範圍（門檻 ${pct(Number(reason.replace(/^(active_)?max_drawdown_lt_/, ''))) }）`
  }
  return labels[reason] ?? reason.replace(/_/g, ' ')
}

const evidenceMetricLabels: Record<string, string> = {
  residual_return_lcb90: '相對適用基準 Alpha 的 90% 保守下界',
  rank_ic: '策略分數與未來 Alpha 的排名一致性',
  max_drawdown: '扣成本絕對報酬最大回撤',
  turnover_after_cost: '每單位換手帶來的扣成本報酬',
  regime_consistency: '不同盤勢的一致性',
  false_breakout_rate: '假突破率',
  tail_loss_cvar95: '最差 5% 尾部損失',
  time_to_reversion: '回歸所需時間',
  maximum_adverse_excursion: '持有期間最大不利波動',
  downside_capture: '適用基準下跌時的損失承受比',
  crowding_decay: '高擁擠與低擁擠訊號的 Alpha 差',
  fundamental_revision_persistence: '基本面修正的延續性',
}

const evidenceMetricDescriptions: Record<string, string> = {
  residual_return_lcb90: '已扣交易成本並扣除同產業／市場分群／大盤同期報酬；> 0 才是嚴格通過。負值是信心下界，不是平均 Alpha。',
  rank_ic: '越接近 +1，策略分數越能把未來 Alpha 高低排對；0 代表沒有穩定排序能力。',
  max_drawdown: '用每日扣成本絕對報酬複利計算；通常為負，越接近 0 越好。',
  turnover_after_cost: '扣成本平均報酬 ÷ 單邊換手率；> 0 較好，避免靠頻繁交易製造紙上績效。',
  regime_consistency: '使用訊號當下已記錄的 PIT 盤勢切片，取各支援盤勢 Alpha 90% 保守下界中的最差值；> 0 才算跨盤勢穩定。',
  false_breakout_rate: '主要觀察週期扣成本報酬 <= 0 的比例；越低越好。',
  tail_loss_cvar95: '最差 5% 樣本的平均扣成本報酬；通常為負，越接近 0 越好。',
  time_to_reversion: '第一次出現正相對 Alpha 的離散週期；交易日越短越好。',
  maximum_adverse_excursion: '由正式 Market 價格的還原權息開盤與持有期間最低價計算最深浮虧；通常為負，越接近 0 越好。',
  downside_capture: '基準下跌時，策略跌幅 ÷ 基準跌幅；低於 1 代表少跌。',
  crowding_decay: '高重疊訊號 Alpha 減低重疊訊號 Alpha；負值代表越擁擠越衰退。',
  fundamental_revision_persistence: '由 append-only revenue observations 比較連續月份修正方向；+1 代表連續上修、-1 代表連續下修、0 代表方向未延續。',
}

function evidenceMetricStatusLabel(status: string | undefined): string {
  return {
    ready: '已成熟',
    insufficient_samples: '已算出，樣本累積中',
    dependency_pending: '等待正式資料依賴',
    not_available: '目前條件不足（原因見下方）',
    not_materialized: '尚未執行物化',
  }[status ?? 'not_materialized'] ?? String(status)
}

function evidenceMetricValue(metric: string, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '尚無數值'
  if (metric === 'time_to_reversion') return `${Number(value).toFixed(1)} 個交易日`
  if (metric === 'rank_ic' || metric === 'regime_consistency' || metric === 'fundamental_revision_persistence') {
    return Number(value).toFixed(3)
  }
  return pct(Number(value))
}

function evidenceMetricAvailabilityReason(metricRow: {
  metric: string
  status: string
  sample_count: number
  mature_dates: number
  evidence: Record<string, unknown>
} | undefined): string | null {
  if (!metricRow || metricRow.status === 'ready') return null
  const missing = String(metricRow.evidence?.missing_reason ?? '')
  if (missing === 'no_strategy_hits_in_observation_window') {
    return '目前觀察窗沒有正式命中。Candidate 仍會持續產生零 production-effect evidence；需先恢復可驗證命中，再談調整門檻或升級。'
  }
  if (missing === 'rank_ic_cross_section_not_identifiable') {
    const observedDates = Number(metricRow.evidence?.observation_dates ?? 0)
    const constantDates = Number(metricRow.evidence?.constant_affinity_dates ?? 0)
    return `已有 ${metricRow.sample_count} 筆／${observedDates} 個成熟訊號日，但 ${constantDates} 日的策略 affinity 在日內沒有橫斷面差異，Rank IC 無法識別；需等待採用連續 affinity 的新日期成熟，不能把舊 binary affinity 回填成分數。`
  }
  if (missing === 'insufficient_mature_dates_for_estimator') {
    const observedDates = Number(metricRow.evidence?.observation_dates ?? metricRow.mature_dates)
    return `已有 ${metricRow.sample_count} 筆／${observedDates} 個成熟訊號日，其中 ${metricRow.mature_dates} 日可供此估計器使用；至少需 2 個可估計日。`
  }
  if (missing === 'fewer_than_two_supported_regimes_with_two_mature_dates') {
    return '正式 PIT 盤勢已接通，但目前還沒有至少 2 種支援盤勢、且各自累積 2 個成熟交易日。'
  }
  if (missing === 'adjusted_price_path_unavailable') {
    return metricRow.sample_count === 0
      ? '目前觀察窗沒有策略命中，因此沒有持有路徑；不是價格資料依賴未物化。'
      : '部分命中尚未對到完整的進場日至出場日還原權息價格路徑。'
  }
  if (missing === 'fewer_than_three_distinct_pit_revenue_months') {
    return '至少需要三個在訊號當時已進入 append-only ledger 的營收月份。若歷史營收是在訊號日後才匯入，PIT 契約禁止回填成「當時已知」；需等待匯入後的新訊號完成結果窗。'
  }
  if (metricRow.metric === 'turnover_after_cost' && Number(metricRow.evidence?.average_one_way_turnover ?? 0) === 0) {
    return '候選集合在目前成熟日期沒有變動，實測單邊周轉為 0，報酬 ÷ 周轉的分母無法成立。'
  }
  if (metricRow.sample_count === 0) return '策略在目前觀察窗沒有正式命中；這是零訊號，不是資料流中斷。'
  if (metricRow.mature_dates < 2) return `已有 ${metricRow.sample_count} 筆，但只涵蓋 ${metricRow.mature_dates} 個成熟交易日，暫時無法估計穩定性。`
  return `已取得 ${metricRow.sample_count} 筆／${metricRow.mature_dates} 個可估計成熟日；正式 metric 門檻為至少 20 筆且 5 日。`
}

function compactStrategyId(value: string): string {
  const cleaned = value.replace(/^(stock_tech_|finlab_ai_skill_|alpha_miner_)/, '').replace(/_v\d+$/, '').replace(/_/g, ' ')
  return cleaned.length > 34 ? `${cleaned.slice(0, 31)}...` : cleaned
}
function GateMetric({
  label,
  description,
  value,
  target,
  pass,
}: {
  label: string
  description: string
  value: string
  target: string
  pass: boolean | null
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 border-b border-slate-800/60 py-1 last:border-0">
      <span className="min-w-0 text-slate-500">
        <span className="block truncate">{label}</span>
        <span className="mt-0.5 block text-[10px] leading-4 text-slate-600">{description}</span>
      </span>
      <span className="shrink-0 text-right font-mono text-slate-300">
        {value} <span className="text-slate-600">/ {target}</span>{' '}
        <span className={gateResultClass(pass)}>{gateResultLabel(pass)}</span>
      </span>
    </div>
  )
}

function DiagnosticMetric({
  label,
  description,
  value,
  role,
}: {
  label: string
  description: string
  value: string
  role: string
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 border-b border-slate-800/60 py-1 last:border-0">
      <span className="min-w-0 text-slate-500">
        <span className="block truncate">{label}</span>
        <span className="mt-0.5 block text-[10px] leading-4 text-slate-600">{description}</span>
      </span>
      <span className="shrink-0 text-right font-mono text-slate-300">
        {value} <span className="block text-[10px] text-cyan-200/70">{role}</span>
      </span>
    </div>
  )
}

function StrategyGateDetails({ row, gate }: { row: LearningRow; gate: StrategyPromotionGate | undefined }) {
  if (!gate) return <p className="mt-3 text-xs text-slate-500">Promotion threshold evidence is unavailable.</p>
  const thresholds = gate.thresholds
  const evidence = gate.evidence
  const isActiveIncumbent = gate.strategy_status === 'active'
  const isS12ExecutionOwner = row.learning.reward_owner === 's12_execution_replay_v3_net'
  const hardGates = [
    { label: '可評估決策數', description: 'PIT 欄位齊全、可公平判定策略是否命中的決策筆數。', value: String(evidence.decisions), target: `>= ${thresholds.min_evaluable_decisions}`, pass: evidence.decisions >= thresholds.min_evaluable_decisions },
    { label: '成熟報酬樣本', description: '已走完結果窗並扣除交易成本、可計算績效的樣本數。', value: String(evidence.samples), target: `>= ${thresholds.min_reward_samples}`, pass: evidence.samples >= thresholds.min_reward_samples },
    { label: '成熟交易日數', description: '至少有一筆報酬成熟、可納入每日統計的不同交易日數。', value: String(evidence.mature_dates), target: `>= ${thresholds.min_mature_dates}`, pass: evidence.mature_dates >= thresholds.min_mature_dates },
    ...(gate.activation_gate.required ? [{
      label: 'Atomic V7 相對替換',
      description: '同日 paired、HAC4、Holm family-wise correction、minimum economic delta、power 與全組合風險 gate。',
      value: activationGateStatusLabel(gate.activation_gate.status),
      target: 'accepted',
      pass: activationGatePass(gate.activation_gate.status),
    }] : []),
  ]
  const diagnostics = [
    { label: '型態命中率', description: '用來檢查 setup 是否過窄或資料斷線；稀有型態不因通用命中率被淘汰。', value: pct(evidence.match_rate), role: '僅供診斷 · 非門檻' },
    { label: '勝率', description: '必須搭配平均獲利／虧損幅度解讀；不以共用 52%／48% 判定升降級。', value: pct(evidence.hit_rate), role: '僅供診斷 · 非門檻' },
    {
      label: isS12ExecutionOwner ? '扣成本平均 R' : '相對基準扣成本平均 Alpha',
      description: isS12ExecutionOwner ? '每筆執行 replay 扣除成本後的平均 R multiple。' : '先扣來回成本，再扣同產業／市場同期報酬；Candidate → Active 仍只走 Atomic V7。',
      value: rewardMetric(evidence.avg_return_pct, row.learning.reward_unit),
      role: isActiveIncumbent ? 'Active 權重輸入 · 非門檻' : '僅供診斷 · 非門檻',
    },
    { label: '日期 Alpha 均值 LCB90', description: '平均 Alpha 的單側 90% 下界，不代表每天或每筆交易都不會虧損；升級使用 Atomic V7 paired LCB95 HAC。', value: rewardMetric(evidence.date_return_lcb90, row.learning.reward_unit), role: '僅供診斷 · 非門檻' },
    { label: '日期投組 Alpha 曲線 MDD', description: '成熟日期相對基準扣成本 Alpha 複利曲線的回撤；不是單一股票一天的漲跌幅。Atomic V7 只比較相對惡化。', value: rewardMetric(evidence.max_drawdown_pct, row.learning.reward_unit), role: '僅供診斷 · 非門檻' },
  ]
  return (
    <div className="mt-3 border-t border-slate-800 pt-3 text-[11px]">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold text-slate-300">{isActiveIncumbent ? 'Active：成熟度與權重監控' : 'Candidate evidence → Active：Atomic V7'}</span>
        <span className="text-slate-500">門檻路由比較（原 Shadow A；非 lifecycle stage）</span>
      </div>
      <p className="mb-2 rounded-md border border-emerald-400/20 bg-emerald-400/[0.05] px-2 py-1.5 text-[10px] leading-4 text-emerald-100/80">共用 hard gate 只管資料可比性與成熟度；它適用於 Candidate evidence。平均 Alpha、match rate、hit rate、MDD、LCB90 保留為診斷。策略 setup threshold 由版本化 Strategy Spec 管理，正式升級只由 Atomic V7 相對替換管理。</p>
      <section aria-label="共用成熟度門檻">
        <h3 className="text-xs font-semibold text-slate-200">共用成熟度門檻</h3>
        <div className="mt-1 grid gap-x-4 md:grid-cols-2">{hardGates.map((item) => <GateMetric key={item.label} {...item} />)}</div>
      </section>
      <section className="mt-3 border-t border-slate-800 pt-3" aria-label="觀察指標">
        <h3 className="text-xs font-semibold text-slate-200">觀察指標（不判定通過／失敗）</h3>
        <p className="mt-1 text-[10px] leading-4 text-slate-500">這些數值會持續累積以提高解讀可信度，但不是 Candidate 升降級門檻；沒有「待通過」狀態。</p>
        <div className="mt-1 grid gap-x-4 md:grid-cols-2">{diagnostics.map((item) => <DiagnosticMetric key={item.label} {...item} />)}</div>
      </section>
    </div>
  )
}

function AtomicReplacementSummary({ replacementGate }: { replacementGate: StrategyReplacementGateSummary | null }) {
  const policy = replacementGate?.policy ?? null
  const run = replacementGate?.latest_run ?? null
  const champion = run?.champion_comparison ?? null
  const candidatePortfolio = run?.candidate_portfolio ?? null
  const candidatePrefilters = replacementGate?.candidate_prefilters ?? []
  const prefilterPassedCount = candidatePrefilters.filter((row) => row.evidence_status === 'ready' && row.production_eligible === true).length
  const prefilterFailedCount = candidatePrefilters.filter((row) => row.evidence_status === 'ready' && row.production_eligible === false).length
  const evidencePendingCount = candidatePrefilters.filter((row) => row.evidence_status !== 'ready' || row.production_eligible == null).length
  const fixedGateGroups = policy ? [
    {
      title: 'A. Candidate prefilter（先決條件）',
      gates: [
        '有效 observation dates >= ' + policy.candidate_prefilter_min_observation_dates,
        'Marginal-edge LCB90 > ' + percentageMetric(policy.candidate_prefilter_min_marginal_edge_lcb90_exclusive),
        'Absolute hit-return cost-net mean > ' + percentageMetric(policy.candidate_prefilter_min_absolute_hit_return_mean_exclusive),
        '三項必須同時通過，才會建立 Candidate → Active pair；缺 evidence 不算失敗。',
      ],
    },
    {
      title: 'B. Candidate vs Active 同日 pair',
      gates: [
        'T+' + policy.outcome_horizon_trading_days + ' sector／market-neutral cost-net outcome',
        '同日 paired dates >= ' + policy.min_paired_dates,
        'Newey-West Bartlett HAC lag = ' + policy.hac_lag + '；有效 paired dates >= ' + policy.min_effective_paired_dates,
        'Paired delta LCB95 HAC > ' + percentageMetric(policy.min_paired_delta_lcb95_hac_exclusive),
        'Minimum economic delta = ' + pct(policy.minimum_economic_paired_delta) + '；Holm-local-alpha power >= ' + pct(policy.min_power_at_minimum_economic_delta),
        'Holm-Bonferroni family-wise alpha = ' + policy.familywise_alpha + '，adjusted p-value 必須被拒絕虛無假設',
        'Candidate absolute cost-net mean > ' + percentageMetric(policy.min_candidate_absolute_cost_net_mean_exclusive),
        'Candidate absolute cost-net LCB95 HAC > ' + percentageMetric(policy.min_candidate_absolute_cost_net_lcb95_hac_exclusive),
        'Candidate MDD 相對 incumbent 惡化 <= ' + pct(policy.max_drawdown_degradation),
        'Candidate turnover 相對 incumbent 增加 <= ' + pct(policy.max_turnover_increase),
        'Return correlation <= ' + numericMetric(policy.max_duplicate_return_correlation, 2) + '；若更高，Candidate 必須改善 MDD 或 turnover',
      ],
    },
    {
      title: 'C. 完整 portfolio 與原子 cutover',
      gates: [
        '至少存在一組通過 HAC、Holm、power 與 pair risk gates 的 replacement。',
        '替換後 full portfolio paired dates >= ' + policy.min_paired_dates + '、有效 dates >= ' + policy.min_effective_paired_dates + '、paired delta LCB95 HAC > 0、power >= ' + pct(policy.min_power_at_minimum_economic_delta),
        '替換後 full portfolio absolute cost-net mean > 0，LCB95 HAC > ' + percentageMetric(policy.min_final_portfolio_absolute_cost_net_lcb95_hac_exclusive),
        'Full portfolio MDD 惡化 <= ' + pct(policy.max_drawdown_degradation) + '、turnover 增加 <= ' + pct(policy.max_turnover_increase),
        'Full portfolio return correlation <= ' + numericMetric(policy.max_duplicate_return_correlation, 2) + '；若更高，必須改善 MDD 或 turnover',
        'Registry Active 與 serving production owner coverage 必須完整一致。',
        'Active 數量前後不變；Candidate 升級與 incumbent 降級必須 atomic one-in-one-out。',
        '以上 full portfolio gates 全部通過，且該 business date 明確允許 promotion，才可 cutover。',
      ],
    },
  ] : []
  const runMetrics = policy && run ? [
    {
      label: 'Full portfolio paired dates',
      description: '最新組合與 champion 的同日比較日期。',
      value: integerMetric(champion?.paired_dates),
      target: '>= ' + policy.min_paired_dates,
      pass: champion?.paired_dates == null ? null : champion.paired_dates >= policy.min_paired_dates,
    },
    {
      label: 'Full portfolio effective dates',
      description: 'HAC 調整後的有效樣本數。',
      value: numericMetric(champion?.effective_paired_dates, 1),
      target: '>= ' + policy.min_effective_paired_dates,
      pass: policyGateBoolean(run.promotion_gates.full_portfolio_effective_sample_pass),
    },
    {
      label: 'Full portfolio paired LCB95 HAC',
      description: '相對 champion 的 paired residual delta 單側 95% HAC 下界。',
      value: percentageMetric(champion?.paired_residual_delta_lcb95_hac),
      target: '> 0%',
      pass: policyGateBoolean(run.promotion_gates.paired_champion_improvement_lcb95_hac),
    },
    {
      label: 'Full portfolio power',
      description: '在 minimum economic delta 下的 Holm-local-alpha power。',
      value: pct(champion?.power_at_minimum_economic_delta),
      target: '>= ' + pct(policy.min_power_at_minimum_economic_delta),
      pass: policyGateBoolean(run.promotion_gates.full_portfolio_power_80pct_pass),
    },
    {
      label: 'Full portfolio absolute LCB95 HAC',
      description: '替換後 Candidate portfolio 的絕對 cost-net HAC 下界。',
      value: percentageMetric(candidatePortfolio?.absolute_lcb95_hac),
      target: '> ' + percentageMetric(policy.min_final_portfolio_absolute_cost_net_lcb95_hac_exclusive),
      pass: policyGateBoolean(run.promotion_gates.full_portfolio_absolute_cost_net_lcb95_hac),
    },
    {
      label: 'Full portfolio absolute mean',
      description: '替換後組合的絕對 cost-net 平均報酬。',
      value: percentageMetric(candidatePortfolio?.absolute_mean),
      target: '> 0%',
      pass: candidatePortfolio?.absolute_mean == null ? null : candidatePortfolio.absolute_mean > 0,
    },
    {
      label: 'Full portfolio MDD baseline / final',
      description: '替換後組合 MDD 不得比 baseline 惡化超過政策容許值。',
      value: percentageMetric(run.portfolio_risk.baseline_max_drawdown) + ' / ' + percentageMetric(run.portfolio_risk.final_max_drawdown),
      target: 'degradation <= ' + pct(policy.max_drawdown_degradation),
      pass: run.portfolio_risk.baseline_max_drawdown == null || run.portfolio_risk.final_max_drawdown == null
        ? null
        : run.portfolio_risk.final_max_drawdown >= run.portfolio_risk.baseline_max_drawdown - policy.max_drawdown_degradation,
    },
    {
      label: 'Full portfolio turnover baseline / final',
      description: '替換後組合 turnover 增加不得超過政策容許值。',
      value: percentageMetric(run.portfolio_risk.baseline_turnover) + ' / ' + percentageMetric(run.portfolio_risk.final_turnover),
      target: 'increase <= ' + pct(policy.max_turnover_increase),
      pass: run.portfolio_risk.turnover_pass,
    },
    {
      label: 'Full portfolio return correlation',
      description: '與 baseline 高度重複時，必須同時證明 MDD 或 turnover 改善。',
      value: numericMetric(run.portfolio_risk.return_correlation, 3),
      target: '<= ' + numericMetric(policy.max_duplicate_return_correlation, 2) + ' or risk improvement',
      pass: run.portfolio_risk.correlation_pass,
    },
    {
      label: 'Production owner count',
      description: 'Atomic one-in-one-out 前後正式 owner 數量。',
      value: integerMetric(run.production_owner_count_before) + ' → ' + integerMetric(run.production_owner_count_after),
      target: 'unchanged',
      pass: policyGateBoolean(run.promotion_gates.active_count_unchanged),
    },
    {
      label: 'Serving owner coverage',
      description: 'Registry Active 與 serving owner 必須完整一致。',
      value: gateResultLabel(run.serving_owner_coverage_complete),
      target: '通過',
      pass: run.serving_owner_coverage_complete,
    },
    {
      label: 'Holm-accepted replacement exists',
      description: '至少一組 pair 通過 HAC、Holm、power 與 pair risk gates。',
      value: gateResultLabel(policyGateBoolean(run.promotion_gates.accepted_hac_holm_replacement_exists)),
      target: '通過',
      pass: policyGateBoolean(run.promotion_gates.accepted_hac_holm_replacement_exists),
    },
    {
      label: 'Atomic one-in-one-out contract',
      description: 'Candidate 升 Active 與 incumbent 降 Candidate 必須在同一原子 cutover。',
      value: gateResultLabel(policyGateBoolean(run.promotion_gates.registry_cutover_is_atomic_one_in_one_out)),
      target: '通過',
      pass: policyGateBoolean(run.promotion_gates.registry_cutover_is_atomic_one_in_one_out),
    },
    {
      label: 'Full portfolio all gates',
      description: '完整 portfolio firewall 的合成判定。',
      value: gateResultLabel(policyGateBoolean(run.promotion_gates.full_portfolio_all_gates_pass)),
      target: '通過',
      pass: policyGateBoolean(run.promotion_gates.full_portfolio_all_gates_pass),
    },
  ] : []
  return (
    <section className="rounded-2xl border border-slate-700/80 bg-slate-950/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="font-semibold text-slate-100">共享 Portfolio Firewall：原子替換 V7</h2><p className="mt-1 text-xs text-slate-500">這是所有 Candidate 共用的「能否取代現任 Active」投資組合風險政策，不是策略 setup threshold。</p></div>
        <Badge variant="outline" className={statusClass(run?.status ?? replacementGate?.evidence_status ?? 'not_ready')}>{run ? [run.as_of_date, run.status === 'shadow' ? '比較中' : run.status].join(' · ') : replacementGate?.evidence_status ?? 'evidence not ready'}</Badge>
      </div>
      {policy ? <p className="mt-3 text-xs leading-5 text-slate-400">至少 {policy.min_paired_dates} 個同日 pair、有效日期至少 {policy.min_effective_paired_dates}、HAC{policy.hac_lag} paired delta LCB95 &gt; 0、Holm family-wise α {policy.familywise_alpha}、minimum economic delta {pct(policy.minimum_economic_paired_delta)}、power {pct(policy.min_power_at_minimum_economic_delta)}，並限制相對 MDD 惡化 {pct(policy.max_drawdown_degradation)}、換手增加 {pct(policy.max_turnover_increase)}、重複報酬相關性 {policy.max_duplicate_return_correlation.toFixed(2)}。</p> : <p className="mt-3 text-xs text-slate-500">Replacement policy evidence is unavailable.</p>}
      {policy ? (
        <section className="mt-3 rounded-xl border border-violet-400/25 bg-violet-400/[0.05] p-3" aria-label="Atomic V7 完整門檻總表">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-xs font-semibold text-violet-100">Atomic V7 完整門檻總表（固定顯示）</h3>
              <p className="mt-1 text-[11px] leading-5 text-slate-400">prefilter-failed = 已有 evidence，但三道先決門檻至少一項未過；evidence-pending = 尚無可判定 evidence，不能算失敗，也還不能建立 pair。</p>
            </div>
            <div className="flex flex-wrap gap-1 text-[10px]">
              <span className="rounded border border-emerald-400/30 px-2 py-1 text-emerald-200">prefilter pass {prefilterPassedCount}</span>
              <span className="rounded border border-rose-400/30 px-2 py-1 text-rose-200">prefilter failed {prefilterFailedCount}</span>
              <span className="rounded border border-amber-400/30 px-2 py-1 text-amber-200">evidence pending {evidencePendingCount}</span>
            </div>
          </div>
          <div className="mt-3 grid gap-3 xl:grid-cols-3">
            {fixedGateGroups.map((group) => (
              <article key={group.title} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                <h4 className="text-[11px] font-semibold text-slate-200">{group.title}</h4>
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-[10px] leading-4 text-slate-400">
                  {group.gates.map((gate) => <li key={gate}>{gate}</li>)}
                </ol>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {policy && candidatePrefilters.length > 0 ? (
        <details className="mt-3 rounded-lg border border-cyan-400/20 bg-cyan-400/[0.04] p-3">
          <summary className="cursor-pointer text-xs font-semibold text-cyan-100">Candidate prefilter actual / target / pass</summary>
          <p className="mt-2 text-[11px] leading-5 text-slate-500">這三道 prefilter 只套用 Challenger Candidate，決定它能否形成 Candidate → incumbent pair；incumbent Active 是同日 portfolio benchmark，雙方比較值列在下方 pair inspector。</p>
          <div className="mt-2 grid gap-2">
            {candidatePrefilters.map((prefilter) => {
              const evidenceReady = prefilter.evidence_status === 'ready'
              const prefilterPassed = evidenceReady && prefilter.production_eligible === true
              const prefilterFailed = evidenceReady && prefilter.production_eligible === false
              const prefilterStatus = prefilterPassed
                ? 'prefilter-pass'
                : prefilterFailed
                  ? 'prefilter-failed'
                  : 'evidence-missing（持續累積）'
              const metrics = [
                {
                  label: 'Candidate observation dates',
                  description: 'Date-clustered marginal-edge 有效觀察日期。',
                  value: integerMetric(prefilter.observation_dates),
                  target: '>= ' + policy.candidate_prefilter_min_observation_dates,
                  pass: evidenceReady
                    ? prefilter.observation_dates >= policy.candidate_prefilter_min_observation_dates
                    : null,
                },
                {
                  label: 'Candidate marginal-edge LCB90',
                  description: 'Leave-one-strategy-out date-clustered marginal edge 的單側 90% 下界。',
                  value: percentageMetric(prefilter.marginal_edge_lcb90),
                  target: '> ' + percentageMetric(policy.candidate_prefilter_min_marginal_edge_lcb90_exclusive),
                  pass: !evidenceReady || prefilter.marginal_edge_lcb90 == null
                    ? null
                    : prefilter.marginal_edge_lcb90 > policy.candidate_prefilter_min_marginal_edge_lcb90_exclusive,
                },
                {
                  label: 'Candidate absolute hit-return mean',
                  description: 'Candidate 命中樣本扣除成本後的 absolute mean。',
                  value: percentageMetric(prefilter.absolute_hit_return_mean),
                  target: '> ' + percentageMetric(policy.candidate_prefilter_min_absolute_hit_return_mean_exclusive),
                  pass: !evidenceReady || prefilter.absolute_hit_return_mean == null
                    ? null
                    : prefilter.absolute_hit_return_mean > policy.candidate_prefilter_min_absolute_hit_return_mean_exclusive,
                },
              ]
              return (
                <details key={[prefilter.strategy_id, prefilter.strategy_version].join(':')} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                  <summary className="cursor-pointer text-xs">
                    <span className="text-slate-300">{compactStrategyId(prefilter.strategy_id)}</span>
                    <span className={['ml-2 rounded border px-1.5 py-0.5', statusClass(prefilterPassed ? 'accepted' : prefilterFailed ? 'rejected' : 'pending_maturity')].join(' ')}>{prefilterStatus}</span>
                  </summary>
                  <p className="mt-2 font-mono text-[10px] text-slate-500">{prefilter.strategy_version} · evidence {prefilter.evidence_status} · observations {prefilter.candidate_observations} · marginal mean {percentageMetric(prefilter.marginal_edge_mean)} · raw weight {evidenceReady ? percentageMetric(prefilter.production_weight_raw) : '資料尚未具備'}</p>
                  <div className="mt-2 grid gap-x-4 md:grid-cols-2">{metrics.map((metric) => <GateMetric key={metric.label} {...metric} />)}</div>
                </details>
              )
            })}
          </div>
        </details>
      ) : run ? <p className="mt-2 text-xs text-slate-500">Candidate prefilter：目前沒有可投影的 Candidate evidence；不會把它誤標成 pending pair。</p> : null}
      {run && <p className="mt-2 text-xs text-slate-500">全組合：cost-net LCB95 HAC <span className={gateResultClass(policyGateBoolean(run.promotion_gates.full_portfolio_positive_cost_net_lcb95_hac))}>{gateResultLabel(policyGateBoolean(run.promotion_gates.full_portfolio_positive_cost_net_lcb95_hac))}</span>{' · '}correlation <span className={gateResultClass(run.portfolio_risk.correlation_pass)}>{gateResultLabel(run.portfolio_risk.correlation_pass)}</span>{' · '}turnover <span className={gateResultClass(run.portfolio_risk.turnover_pass)}>{gateResultLabel(run.portfolio_risk.turnover_pass)}</span>{' · '}owner coverage <span className={gateResultClass(policyGateBoolean(run.promotion_gates.registry_and_serving_owner_coverage_complete))}>{gateResultLabel(policyGateBoolean(run.promotion_gates.registry_and_serving_owner_coverage_complete))}</span></p>}
      {runMetrics.length > 0 ? (
        <details className="mt-3 rounded-lg border border-slate-800 bg-slate-900/30 p-3">
          <summary className="cursor-pointer text-xs font-semibold text-slate-300">Full portfolio actual / target / pass</summary>
          <div className="mt-2 grid gap-x-4 md:grid-cols-2">{runMetrics.map((metric) => <GateMetric key={metric.label} {...metric} />)}</div>
        </details>
      ) : null}
      {replacementGate?.decisions.length ? (
        <div className="mt-3 grid gap-2">
          {replacementGate.decisions.map((decision) => {
            const mddPass = decision.candidate_max_drawdown == null || decision.incumbent_max_drawdown == null || !policy
              ? null
              : decision.candidate_max_drawdown >= decision.incumbent_max_drawdown - policy.max_drawdown_degradation
            const turnoverPass = decision.candidate_turnover == null || decision.incumbent_turnover == null || !policy
              ? null
              : decision.candidate_turnover <= decision.incumbent_turnover + policy.max_turnover_increase
            const correlationPass = decision.return_correlation == null || !policy
              ? null
              : decision.return_correlation <= policy.max_duplicate_return_correlation
                || (
                  decision.candidate_max_drawdown != null
                  && decision.incumbent_max_drawdown != null
                  && decision.candidate_turnover != null
                  && decision.incumbent_turnover != null
                  && (
                    decision.candidate_max_drawdown > decision.incumbent_max_drawdown
                    || decision.candidate_turnover < decision.incumbent_turnover
                  )
                )
            const pairMetrics = policy ? [
              {
                label: 'Statistical policy',
                description: '此 pair 實際使用的統計政策版本。',
                value: decision.statistical_policy_version ?? '資料尚未具備',
                target: policy.policy_version,
                pass: decision.statistical_policy_version == null ? null : decision.statistical_policy_version === policy.policy_version,
              },
              {
                label: 'Paired dates',
                description: 'Candidate 與 incumbent 在相同 PIT 日期形成的 portfolio pair。',
                value: integerMetric(decision.paired_dates),
                target: '>= ' + policy.min_paired_dates,
                pass: decision.paired_dates >= policy.min_paired_dates,
              },
              {
                label: 'Effective paired dates',
                description: '依自相關調整後的有效 paired 樣本。',
                value: numericMetric(decision.effective_paired_dates, 1),
                target: '>= ' + policy.min_effective_paired_dates,
                pass: decision.effective_paired_dates == null ? null : decision.effective_paired_dates >= policy.min_effective_paired_dates,
              },
              {
                label: 'HAC lag',
                description: 'Newey-West Bartlett dependence adjustment lag。',
                value: integerMetric(decision.hac_lag),
                target: '= ' + policy.hac_lag,
                pass: decision.hac_lag == null ? null : decision.hac_lag === policy.hac_lag,
              },
              {
                label: 'Paired delta mean',
                description: 'Candidate sleeve 取代 incumbent 後的平均 residual delta；MED 是 power reference，不是獨立 hard gate。',
                value: percentageMetric(decision.paired_delta_mean),
                target: 'MED ref ' + percentageMetric(decision.minimum_economic_delta ?? policy.minimum_economic_paired_delta),
                pass: null,
              },
              {
                label: 'Paired delta LCB90 IID',
                description: 'Legacy IID 診斷值；正式判定使用 LCB95 HAC。',
                value: percentageMetric(decision.paired_delta_lcb90),
                target: 'diagnostic only',
                pass: null,
              },
              {
                label: 'Paired delta HAC SE',
                description: 'Paired delta 的 HAC standard error。',
                value: percentageMetric(decision.paired_delta_hac_standard_error),
                target: 'reported',
                pass: null,
              },
              {
                label: 'Paired delta LCB95 HAC',
                description: '正式 paired improvement confidence gate。',
                value: percentageMetric(decision.paired_delta_lcb95_hac),
                target: '> ' + percentageMetric(policy.min_paired_delta_lcb95_hac_exclusive),
                pass: decision.paired_delta_lcb95_hac == null ? null : decision.paired_delta_lcb95_hac > policy.min_paired_delta_lcb95_hac_exclusive,
              },
              {
                label: 'One-sided p / Holm local α',
                description: '同一 family 內依 Holm rank 使用 local alpha。',
                value: numericMetric(decision.paired_delta_one_sided_p_value, 6) + ' / ' + numericMetric(decision.holm_local_alpha, 6),
                target: 'p <= local α',
                pass: decision.holm_rejected,
              },
              {
                label: 'Holm family / rank',
                description: '多重比較 family 大小與此 pair 的排序。',
                value: integerMetric(decision.holm_family_size) + ' / ' + integerMetric(decision.holm_rank),
                target: 'metadata present',
                pass: decision.holm_family_size == null || decision.holm_rank == null ? null : true,
              },
              {
                label: 'Holm adjusted p',
                description: 'Family-wise adjusted p-value。',
                value: numericMetric(decision.holm_adjusted_p_value, 6),
                target: '<= ' + numericMetric(policy.familywise_alpha, 3),
                pass: decision.holm_rejected,
              },
              {
                label: 'Power at minimum economic delta',
                description: '使用此 pair Holm local alpha 計算的檢定力。',
                value: pct(decision.paired_delta_power_at_minimum_economic_delta),
                target: '>= ' + pct(policy.min_power_at_minimum_economic_delta),
                pass: decision.paired_delta_power_at_minimum_economic_delta == null
                  ? null
                  : decision.paired_delta_power_at_minimum_economic_delta >= policy.min_power_at_minimum_economic_delta,
              },
              {
                label: 'Candidate absolute mean',
                description: 'Candidate 自身 absolute cost-net mean。',
                value: percentageMetric(decision.candidate_absolute_cost_net_mean),
                target: '> ' + percentageMetric(policy.min_candidate_absolute_cost_net_mean_exclusive),
                pass: decision.candidate_absolute_cost_net_mean == null
                  ? null
                  : decision.candidate_absolute_cost_net_mean > policy.min_candidate_absolute_cost_net_mean_exclusive,
              },
              {
                label: 'Candidate absolute effective dates',
                description: 'Candidate absolute return 的 HAC 有效樣本。',
                value: numericMetric(decision.candidate_absolute_effective_dates, 1),
                target: 'reported',
                pass: decision.candidate_absolute_effective_dates == null ? null : true,
              },
              {
                label: 'Candidate absolute HAC SE',
                description: 'Candidate absolute cost-net mean 的 HAC standard error。',
                value: percentageMetric(decision.candidate_absolute_hac_standard_error),
                target: 'reported',
                pass: null,
              },
              {
                label: 'Candidate absolute LCB95 HAC',
                description: 'Candidate 自身的 absolute safety gate。',
                value: percentageMetric(decision.candidate_absolute_cost_net_lcb95_hac),
                target: '> ' + percentageMetric(policy.min_candidate_absolute_cost_net_lcb95_hac_exclusive),
                pass: decision.candidate_absolute_cost_net_lcb95_hac == null
                  ? null
                  : decision.candidate_absolute_cost_net_lcb95_hac > policy.min_candidate_absolute_cost_net_lcb95_hac_exclusive,
              },
              {
                label: 'MDD Candidate / incumbent',
                description: 'Candidate MDD 不得比 incumbent 惡化超過容許值。',
                value: percentageMetric(decision.candidate_max_drawdown) + ' / ' + percentageMetric(decision.incumbent_max_drawdown),
                target: 'degradation <= ' + pct(policy.max_drawdown_degradation),
                pass: mddPass,
              },
              {
                label: 'Turnover Candidate / incumbent',
                description: 'Candidate turnover 不得比 incumbent 增加超過容許值。',
                value: numericMetric(decision.candidate_turnover, 3) + ' / ' + numericMetric(decision.incumbent_turnover, 3),
                target: 'increase <= ' + numericMetric(policy.max_turnover_increase, 3),
                pass: turnoverPass,
              },
              {
                label: 'Return correlation',
                description: '高相關時必須同時證明 MDD 或 turnover 改善。',
                value: numericMetric(decision.return_correlation, 3),
                target: '<= ' + numericMetric(policy.max_duplicate_return_correlation, 2) + ' or risk improvement',
                pass: correlationPass,
              },
            ] : []
            return (
              <details key={decision.decision_id || [decision.candidate_strategy_id, decision.replaced_strategy_id].join(':')} className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-xs">
                <summary className="cursor-pointer">
                  <span className="text-slate-300">{compactStrategyId(decision.candidate_strategy_id)} → {compactStrategyId(decision.replaced_strategy_id)}</span>
                  <span className={['ml-2 rounded border px-1.5 py-0.5', statusClass(decision.status)].join(' ')}>{decision.status}</span>
                </summary>
                <p className="mt-2 font-mono text-[10px] text-slate-500">decision {decision.decision_id} · run {decision.run_id} · {decision.as_of_date} · {decision.replacement_scope ?? 'scope unavailable'}</p>
                <div className="mt-2 grid gap-x-4 md:grid-cols-2">{pairMetrics.map((metric) => <GateMetric key={metric.label} {...metric} />)}</div>
                {decision.rejection_reasons.length > 0 ? <p className="mt-2 text-amber-200">rejection: {decision.rejection_reasons.join(', ').replace(/_/g, ' ')}</p> : null}
              </details>
            )
          })}
        </div>
      ) : <p className="mt-2 text-xs text-slate-500">Pair verdict：not-evaluated。最新一次尚未形成可稽核的 Candidate → incumbent pair。</p>}
    </section>
  )
}
function registryLearningRow(spec: StrategySpec): LearningRow {
  return {
    ...spec,
    learning: {
      evidence_available: false,
      reward_owner: 'selection_edge_v4',
      decisions: 0,
      reward_unit: 'return_fraction',
      reward_cost_basis: 'net_after_roundtrip_cost',
      evaluable_decisions: 0,
      unavailable_decisions: 0,
      matched: 0,
      match_rate: null,
      today_decisions: 0,
      today_evaluable_decisions: 0,
      today_unavailable_decisions: 0,
      today_matched: 0,
      rolling_decisions: 0,
      rolling_evaluable_decisions: 0,
      rolling_unavailable_decisions: 0,
      rolling_matched: 0,
      rolling_match_rate: null,
      rolling_sessions: 0,
      samples: 0,
      hit_rate: null,
      avg_return_pct: null,
      max_drawdown_pct: null,
      rolling_samples: 0,
      rolling_hit_rate: null,
      rolling_avg_return_pct: null,
      rolling_max_drawdown_pct: null,
      rolling_reward_dates: 0,
      rolling_date_return_mean: null,
      rolling_date_return_lcb90: null,
      latest_decision_date: null,
      latest_reward_date: null,
      first_decision_date: null,
      first_matched_date: null,
      mature_label_max_date: null,
      reward_state: 'unavailable',
      reward_status_reason: 'reward ledger unavailable',
      status: 'unavailable',
    },
  }
}

function StrategyLedgerGroup({
  title,
  description,
  rows,
  gateById,
  profileById,
  formalPolicyWeights,
  requestedDate,
  empty,
}: {
  title: string
  description: string
  rows: LearningRow[]
  gateById: Map<string, StrategyPromotionGate>
  profileById: Map<string, StrategyEvidenceProfile>
  formalPolicyWeights: Record<string, number>
  requestedDate: string | null
  empty: string
}) {
  return (
    <section className="sv-readable-card-content h-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/70">
      <header className="flex min-h-[112px] flex-wrap items-end justify-between gap-3 border-b border-slate-800 px-4 py-4 lg:px-5">
        <div>
          <h2 className="font-['Space_Grotesk'] text-lg font-semibold text-slate-100">{title}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">{description}</p>
        </div>
        <Badge variant="outline" className="border-slate-700 bg-slate-900 text-slate-300">{rows.length} strategies</Badge>
      </header>

      <div className="grid grid-cols-1 gap-px bg-slate-900">
        {rows.map((row) => {
          const gate = gateById.get(`${row.id}:${row.version}`)
          const profile = profileById.get(`${row.id}:${row.version}`)
          const healthBucket = strategyHealthBucket(row, gate, strategyWeight(formalPolicyWeights, row.id))
          const rewardPending = row.learning.reward_state === 'pending_maturity'
          const rewardMissing = row.learning.reward_state === 'reward_join_missing'
          const noMatches = row.learning.reward_state === 'no_matches'
          const rewardCount = rewardPending ? 'Pending T+5' : rewardMissing ? 'Join missing' : noMatches ? 'No setups' : String(row.learning.samples)
          const rollingMature = rewardPending ? 'Pending T+5' : rewardMissing ? 'Join missing' : noMatches ? 'No setups' : String(row.learning.rolling_reward_dates)
          const currentDecisionPending = Boolean(requestedDate && row.learning.today_decisions === 0 && row.learning.latest_decision_date !== requestedDate)
          const currentDecisionLabel = currentDecisionPending
            ? `${requestedDate} 尚未產生；最新 decision date ${row.learning.latest_decision_date ?? '無歷史資料'}`
            : `${requestedDate ?? row.learning.latest_decision_date ?? '今日'} 可評估 ${row.learning.today_evaluable_decisions} · 命中 ${row.learning.today_matched} · PIT 欄位不足 ${row.learning.today_unavailable_decisions}`
          return (
            <article key={`${row.id}:${row.version}`} className="min-w-0 space-y-4 bg-slate-950/70 px-4 py-4 lg:px-5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">{row.name}</h3>
                  <Badge variant="outline" className={statusClass(row.status)}>{statusLabel(row.status)}</Badge>
                  <Badge variant="outline" className={statusClass(row.learning.status)}>{statusLabel(row.learning.status)}</Badge>
                  <Badge variant="outline" className={statusClass(healthBucket === 'execution_eligible' ? 'active' : healthBucket === 'evidence_repair' ? 'reward_join_missing' : 'not_ready')}>{strategyHealthLabel(healthBucket)}</Badge>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-slate-500">{row.id} &middot; {row.alphaBucket}</p>
              </div>

              <dl className="grid grid-cols-2 gap-2 2xl:grid-cols-3">
                <div className="rounded-lg border border-slate-800/80 bg-slate-900/45 p-2">
                  <dt className="text-xs text-slate-500">可評估決策</dt>
                  <dd className="mt-1 font-mono text-sm text-slate-200">{row.learning.evidence_available ? row.learning.evaluable_decisions : '-'}</dd>
                  <div className="mt-1 text-xs text-slate-500">{row.learning.evidence_available ? <>PIT 欄位不足 {row.learning.unavailable_decisions} · 總決策 {row.learning.decisions}</> : 'evidence not ready'}</div>
                  <div className={`mt-1 text-xs ${currentDecisionPending ? 'text-amber-300' : 'text-cyan-300'}`}>{currentDecisionLabel}</div>
                  <div className="mt-1 text-xs text-slate-500">{row.learning.reward_owner === 's12_execution_replay_v3_net' ? 'S12 execution reward' : 'selection edge reward'}</div>
                </div>
                <div className="rounded-lg border border-slate-800/80 bg-slate-900/45 p-2">
                  <dt className="text-xs text-slate-500">滾動可評估</dt>
                  <dd className="mt-1 font-mono text-sm text-slate-200">{row.learning.evidence_available ? row.learning.rolling_evaluable_decisions : '-'}</dd>
                  <div className="mt-1 text-xs text-slate-500">{row.learning.evidence_available ? <>PIT 欄位不足 {row.learning.rolling_unavailable_decisions} · {row.learning.rolling_sessions} 個決策日</> : 'evidence not ready'}</div>
                </div>
                <div className="rounded-lg border border-slate-800/80 bg-slate-900/45 p-2">
                  <dt className="text-xs text-slate-500">累積成熟報酬樣本</dt>
                  <dd className={`mt-1 font-mono text-sm ${rewardMissing ? 'text-rose-300' : rewardPending || noMatches ? 'text-amber-200' : 'text-slate-200'}`}>{row.learning.evidence_available ? rewardCount : '-'}</dd>
                  <div className="mt-1 text-xs leading-4 text-slate-500">{row.learning.reward_status_reason}</div>
                  {row.learning.reward_state === 'ready' && row.learning.latest_reward_date && row.learning.mature_label_max_date && row.learning.latest_reward_date < row.learning.mature_label_max_date && <div className="mt-1 text-[10px] leading-4 text-cyan-300">資料管線已成熟至 {row.learning.mature_label_max_date}；此策略最後一次正式命中在 {row.learning.latest_reward_date}，之後沒有新的成熟命中，並非資料停更。</div>}
                </div>
                <div className="rounded-lg border border-slate-800/80 bg-slate-900/45 p-2">
                  <dt className="text-xs text-slate-500">滾動成熟交易日</dt>
                  <dd className="mt-1 font-mono text-sm text-cyan-200">{row.learning.evidence_available ? rollingMature : '-'}</dd>
                  <div className={`mt-1 text-xs ${signedClass(row.learning.rolling_date_return_lcb90)}`}>{row.learning.evidence_available ? rewardPending || rewardMissing || noMatches ? rollingMature : <>LCB90 {rewardMetric(row.learning.rolling_date_return_lcb90, row.learning.reward_unit)}</> : 'Unavailable'}</div>
                </div>
                <div className="rounded-lg border border-slate-800/80 bg-slate-900/45 p-2"><dt className="text-xs text-slate-500">{row.learning.reward_owner === 's12_execution_replay_v3_net' ? 'Execution 勝率 / 平均 R' : '相對基準勝率 / 平均 Alpha'}</dt><dd className="mt-1 font-mono text-sm text-slate-300">{rewardPending || rewardMissing || noMatches ? rollingMature : <>{pct(row.learning.rolling_hit_rate)} / <span className={signedClass(row.learning.rolling_avg_return_pct)}>{rewardMetric(row.learning.rolling_avg_return_pct, row.learning.reward_unit)}</span></>}</dd><div className="mt-1 text-[10px] leading-4 text-slate-600">{row.learning.reward_owner === 's12_execution_replay_v3_net' ? '執行 replay 的扣成本結果。' : '扣成本並扣除同產業／市場同期報酬；不等於股票絕對漲跌。'}</div></div>
                <div className="rounded-lg border border-slate-800/80 bg-slate-900/45 p-2"><dt className="text-xs text-slate-500">{row.learning.reward_owner === 's12_execution_replay_v3_net' ? 'Execution MDD' : '相對基準 Alpha MDD'}</dt><dd className={`mt-1 font-mono text-sm ${signedClass(row.learning.rolling_max_drawdown_pct)}`}>{rewardPending || rewardMissing || noMatches ? rollingMature : rewardMetric(row.learning.rolling_max_drawdown_pct, row.learning.reward_unit)}</dd></div>
              </dl>

              <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-cyan-100">此策略自己的 evidence 契約</span>
                  <Badge variant="outline" className={profile?.outcome_contract_status !== 'multi_horizon_pending' ? statusClass('active') : statusClass('not_ready')}>
                    {profile?.outcome_contract_status === 'primary_horizon_shadow_available'
                      ? '主要週期結果已物化'
                      : profile?.outcome_contract_status === 'fixed_5d_available'
                        ? '主要週期沿用正式 5 日結果'
                        : profile ? '主要週期結果待物化' : 'Profile 尚未取得'}
                  </Badge>
                </div>
                {profile ? (
                  <>
                    <p className="mt-2 text-xs leading-5 text-slate-400">
                      主要觀察 <span className="font-mono text-cyan-100">{profile.primary_horizon_days} 個交易日</span>
                      {' · '}交叉檢查 {profile.evaluation_horizon_days.join('／')} 日
                      {' · '}目前有 {profile.available_outcome_horizon_days.join('／')} 日可用結果。
                    </p>
                    <p className="mt-1 text-[11px] text-cyan-100/70">指標已算出 {profile.metric_completion?.materialized ?? 0} / {profile.metric_completion?.total ?? profile.required_metrics.length}；樣本與成熟交易日都達標 {profile.metric_completion?.ready ?? 0} / {profile.metric_completion?.total ?? profile.required_metrics.length}。</p>
                    <p className="mt-1 text-[11px] text-slate-500">「已成熟」只代表資料量足以判讀，不代表績效通過；請依各指標下方的好壞方向解讀。</p>
                    <div className="mt-2 grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
                      {profile.required_metrics.map((metric) => {
                        const metricRow = profile.metric_evidence?.find((item) => item.metric === metric)
                        const ready = metricRow?.status === 'ready'
                        const pendingDependency = metricRow?.status === 'dependency_pending'
                        const availabilityReason = evidenceMetricAvailabilityReason(metricRow)
                        return (
                          <div key={metric} className={`rounded-md border px-2 py-1 text-[11px] ${ready ? 'border-emerald-400/25 bg-emerald-400/[0.06] text-emerald-200' : pendingDependency ? 'border-amber-400/25 bg-amber-400/[0.06] text-amber-200' : 'border-cyan-400/20 bg-cyan-400/[0.04] text-cyan-200'}`}>
                            <span className="block">{evidenceMetricLabels[metric] ?? metric}</span>
                            <span className="mt-0.5 block font-mono text-[10px]">
                              <span className="opacity-75">{evidenceMetricStatusLabel(metricRow?.status)} · </span>
                              <span className={signedClass(metricRow?.value)}>{evidenceMetricValue(metric, metricRow?.value)}</span>
                              <span className="opacity-75"> · n={metricRow?.sample_count ?? 0} / {metricRow?.mature_dates ?? 0} 日</span>
                            </span>
                            <span className="mt-1 block text-[10px] leading-4 text-slate-400">{evidenceMetricDescriptions[metric] ?? '此指標尚未提供白話定義。'}</span>
                            {availabilityReason && <span className="mt-1 block text-[10px] leading-4 text-amber-200/80">原因：{availabilityReason}</span>}
                          </div>
                        )
                      })}
                    </div>
                    <p className="mt-2 text-xs leading-5 text-cyan-100/70">
                      {profile.production_authority === 'formal_owner_input_active'
                        ? '正式 multi-horizon evidence input：fully ready 指標會在 ±25% 上限內調整此策略正式待買權重；樣本不足維持中性，不會被當成 0 分。'
                        : profile.production_authority === 'formal_owner_input_ready'
                          ? '正式 evidence input 已就緒，等待下一版 immutable production policy materialization 後生效。'
                          : 'Comparison-only evidence：此 profile 尚未取得正式權責，只供比較與持續學習。'}
                    </p>
                  </>
                ) : <p className="mt-2 text-xs text-amber-200">Evidence profile API 未回傳此策略；這是資料缺漏，不代表策略績效失敗。</p>}
              </div>

            </article>
          )
        })}
        {!rows.length && <div className="px-5 py-8 text-sm text-slate-500">{empty}</div>}
      </div>
    </section>
  )
}

function StrategyStageTransitionCard({
  row,
  gate,
}: {
  row: LearningRow | null
  gate: StrategyPromotionGate | undefined
}) {
  if (!row) return <aside className="sv-readable-card-content rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-xs text-slate-500">Stage transition unavailable.</aside>
  const evidence = gate?.missing_evidence ?? []
  const evidenceLabels = gate ? (evidence.length ? evidence : ['成熟度／allocation gate 已通過']) : ['報酬帳本資料未取得']
  return (
    <aside className="sv-readable-card-content rounded-2xl border border-slate-800 bg-slate-950/70 p-4 xl:sticky xl:top-4 xl:self-start">
      <header className="-mx-4 -mt-4 flex min-h-[56px] items-center border-b border-slate-800 px-4 py-4">
        <h2 className="truncate text-[15px] font-bold text-slate-100">Stage transition</h2>
      </header>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={statusClass(gate?.decision ?? 'ledger_pending')}>{gate?.decision ?? 'ledger pending'}</Badge>
      </div>
      <p className="mt-3 font-mono text-xs leading-5 text-slate-300">
        {gate?.current_stage ?? 'stage unavailable'} &rarr; {gate?.recommended_stage ?? gate?.recommended_next_status ?? 'reward gate unavailable'}
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {evidenceLabels.slice(0, 3).map((item) => (
          <span key={item} className={`rounded-md border px-2 py-1 text-[10px] ${evidence.length ? 'border-amber-400/20 bg-amber-400/[0.06] text-amber-200' : gate ? 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-200' : 'border-slate-600/40 bg-slate-800/50 text-slate-400'}`}>{gateReasonLabel(item)}</span>
        ))}
      </div>
      <StrategyGateDetails row={row} gate={gate} />
    </aside>
  )
}

function StrategyHealthBoard({
  rows,
  gateById,
  formalPolicyWeights,
  previewPolicyWeights,
  selectedKey,
  onSelect,
}: {
  rows: LearningRow[]
  gateById: Map<string, StrategyPromotionGate>
  formalPolicyWeights: Record<string, number>
  previewPolicyWeights: Record<string, number>
  selectedKey: string | null
  onSelect: (key: string) => void
}) {
  const lanes = STRATEGY_LIFECYCLE_LANES.map((lane) => {
    const laneRows = rows.filter((row) => strategyLifecycleLane(row) === lane.key)
    return {
      ...lane,
      rows: laneRows,
      groups: STRATEGY_HEALTH_SECTIONS_BY_LANE[lane.key].map((section) => ({
        ...section,
        rows: laneRows.filter((row) => {
          const key = `${row.id}:${row.version}`
          return strategyHealthBucket(row, gateById.get(key), strategyWeight(formalPolicyWeights, row.id)) === section.key
        }),
      })),
    }
  })

  return (
    <section className="rounded-2xl border border-slate-700/80 bg-slate-950/70 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-100">策略健康分流</h2>
          <p className="mt-1 max-w-4xl text-xs leading-5 text-slate-500">左側為 Active，右側為 Candidate；兩欄各自依待買資格、證據累積、資料待修與績效降溫分流。Shadow A 只存在於下方 threshold route comparison 的 evidence mode，不是策略 stage。</p>
        </div>
        <Badge variant="outline" className="border-slate-700 bg-slate-900 text-slate-300">共 {rows.length} 個策略</Badge>
      </header>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {lanes.map((lane) => (
          <section key={lane.key} className={`min-w-0 rounded-2xl border p-3 ${lane.className}`}>
            <header className="flex min-h-[76px] items-start justify-between gap-3 border-b border-slate-800/80 pb-3">
              <div>
                <h3 className="text-base font-semibold text-slate-100">{lane.label}</h3>
                <p className="mt-1 text-xs leading-5 text-slate-500">{lane.description}</p>
              </div>
              <Badge variant="outline" className={`sv-num shrink-0 ${lane.countClassName}`}>{lane.rows.length}</Badge>
            </header>

            <div className="mt-3 grid gap-3 2xl:grid-cols-2">
              {lane.groups.map((group) => (
                <section key={`${lane.key}:${group.key}`} className={`min-w-0 rounded-xl border p-3 ${group.className}`}>
                  <header className="flex items-start justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-semibold text-slate-100">{group.label}</h4>
                      <p className="mt-1 text-[11px] leading-4 text-slate-500">{group.description}</p>
                    </div>
                    <Badge variant="outline" className={`sv-num shrink-0 ${group.countClassName}`}>{group.rows.length}</Badge>
                  </header>

                  <div className="mt-3 space-y-2">
                    {group.rows.map((row) => {
                      const key = `${row.id}:${row.version}`
                      const gate = gateById.get(key)
                      const formalWeight = strategyWeight(formalPolicyWeights, row.id)
                      const previewWeight = strategyWeight(previewPolicyWeights, row.id)
                      const selected = selectedKey === key
                      return (
                        <button
                          key={key}
                          type="button"
                          aria-pressed={selected}
                          aria-label={`查看策略 ${row.name}`}
                          onClick={() => onSelect(key)}
                          className={[
                            'w-full rounded-lg border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70',
                            selected ? 'border-cyan-300/40 bg-cyan-300/[0.09]' : 'border-slate-800/90 bg-slate-950/65 hover:border-slate-700 hover:bg-slate-900/75',
                          ].join(' ')}
                        >
                          <span className="flex min-w-0 items-start justify-between gap-2">
                            <span className={['min-w-0 line-clamp-2 text-xs font-semibold', selected ? 'text-cyan-100' : 'text-slate-200'].join(' ')}>{row.name}</span>
                            <span className="sv-num shrink-0 text-right text-[10px] text-slate-400">
                              <span className="block">正式 contribution {formalWeight == null ? '未取得' : pct(formalWeight)}</span>
                              <span className="mt-0.5 block text-cyan-200/70">Preview {previewWeight == null ? '未取得' : pct(previewWeight)}</span>
                            </span>
                          </span>
                          <span className="mt-1.5 flex flex-wrap items-center gap-1">
                            <span className={['rounded border px-1.5 py-0.5 text-[10px]', statusClass(row.status)].join(' ')}>{lane.key === 'active' ? 'Active' : 'Candidate'} · {statusLabel(row.status)}</span>
                          </span>
                          <span className="mt-2 flex items-center justify-between gap-2 text-[10px] text-slate-500">
                            <span className="sv-num">{row.learning.rolling_reward_dates} mature dates</span>
                            <span className="sv-num">{gate?.missing_evidence.length ?? 0} gaps</span>
                          </span>
                        </button>
                      )
                    })}
                    {!group.rows.length && <p className="rounded-lg border border-dashed border-slate-800 px-3 py-4 text-center text-[11px] text-slate-600">此分類目前沒有策略。</p>}
                  </div>
                </section>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  )
}
function StrategyLineageInspector({
  row,
  gate,
  profile,
  snapshotDate,
  formalPolicyWeight,
  previewPolicyWeight,
  lanes,
}: {
  row: LearningRow | null
  gate: StrategyPromotionGate | undefined
  profile: StrategyEvidenceProfile | undefined
  snapshotDate: string | null
  formalPolicyWeight: number | null
  previewPolicyWeight: number | null
  lanes: StrategyEvidenceProfilesResponse['lanes'] | null
}) {
  if (!row) return <aside className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-xs text-slate-500">請先從策略佇列選擇一個策略。</aside>
  const missing = gate?.missing_evidence ?? []
  const formalPolicy = lanes?.formal.production_effect === true
    ? lanes.formal.formal_policy_lineage ?? null
    : null
  const executionEligible = gate?.allocation_eligible === true && formalPolicyWeight != null && formalPolicyWeight > 0
  const formalContributionZero = row.status === 'active' && formalPolicyWeight === 0
  return (
    <aside className="space-y-3 xl:sticky xl:top-4 xl:self-start">
      <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-100">Lineage inspector</h2>
          <Badge variant="outline" className={statusClass(executionEligible ? 'active' : 'not_ready')}>{executionEligible ? '可進待買' : '持續學習'}</Badge>
        </div>
        <dl className="mt-3 space-y-2 text-xs">
          <div className="flex justify-between gap-3"><dt className="text-slate-500">Snapshot</dt><dd className="font-mono text-slate-300">{snapshotDate ?? '未取得'}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-slate-500">Strategy</dt><dd className="min-w-0 truncate font-mono text-slate-300">{row.id}:{row.version}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-slate-500">Reward owner</dt><dd className="min-w-0 truncate font-mono text-slate-300">{row.learning.reward_owner}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-slate-500">Latest decision</dt><dd className="font-mono text-slate-300">{row.learning.latest_decision_date ?? '尚無'}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-slate-500">Latest reward</dt><dd className="font-mono text-slate-300">{row.learning.latest_reward_date ?? '尚無'}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-slate-500">Evidence authority</dt><dd className="text-right text-slate-300">{profile?.production_authority ?? 'profile missing'}</dd></div>
        </dl>
      </section>
      <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
        <h3 className="text-xs font-semibold text-slate-200">正式權責</h3>
        <dl className="mt-3 space-y-2 text-[11px]">
          <div className="flex justify-between gap-3"><dt className="text-slate-500">Production firewall</dt><dd className={lanes?.formal.production_effect ? 'text-emerald-300' : 'text-slate-500'}>{lanes?.formal.production_effect ? 'effective' : 'unavailable'}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-slate-500">Formal policy</dt><dd className="text-right font-mono text-slate-300">{formalPolicy ? [formalPolicy.policy_id, formalPolicy.version].join(' · v') : '未取得'}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-slate-500">Knowledge cutoff</dt><dd className="font-mono text-slate-300">{formalPolicy?.knowledge_cutoff_date ?? '未取得'}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-slate-500">Threshold route comparison</dt><dd className="text-cyan-300">{lanes?.threshold_route_shadow.mature_dates ?? 0} / {lanes?.threshold_route_shadow.required_mature_dates ?? 11} dates</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-slate-500">Multi-horizon owner</dt><dd className={lanes?.multi_horizon_formal.production_effect ? 'text-violet-300' : 'text-slate-500'}>{lanes?.multi_horizon_formal.production_effect ? 'formal owner' : 'pending'}</dd></div>
        </dl>
      </section>
      <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
        <h3 className="text-xs font-semibold text-slate-200">成熟度／allocation gate 結果</h3>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(missing.length ? missing : ['成熟度／allocation gate 已通過']).slice(0, 6).map((reason) => (
            <span key={reason} className={['rounded-md border px-2 py-1 text-[10px]', missing.length ? 'border-amber-400/20 bg-amber-400/[0.06] text-amber-200' : 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-200'].join(' ')}>{gateReasonLabel(reason)}</span>
          ))}
        </div>
      </section>
      <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-slate-200">正式 pending-buy contribution</h3>
          <Badge variant="outline" className={statusClass(executionEligible ? 'active' : 'not_ready')}>{executionEligible ? '可讓推薦進入待買' : formalContributionZero ? '績效降溫 · contribution 0' : '只選股與評估'}</Badge>
        </div>
        <p className="mt-2 font-mono text-lg text-slate-100">{formalPolicyWeight == null ? '未取得正式 contribution' : pct(formalPolicyWeight)}</p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
          <div className="h-full bg-emerald-300" style={{ width: (formalPolicyWeight == null ? 0 : Math.max(0, Math.min(100, formalPolicyWeight * 100))) + '%' }} />
        </div>
        <p className="mt-2 text-[11px] leading-5 text-slate-500">此值只來自封存 formal policy。必須同時滿足 allocation gate 與 formal contribution &gt; 0 才能標示「可進待買」；不是帳戶資金、下單金額或部位比例。</p>
        <div className="mt-3 rounded-lg border border-cyan-400/20 bg-cyan-400/[0.05] p-2">
          <div className="flex items-center justify-between gap-2 text-[11px]"><span className="font-semibold text-cyan-100">Preview weight（診斷）</span><span className="font-mono text-cyan-200">{previewPolicyWeight == null ? '未取得' : pct(previewPolicyWeight)}</span></div>
          <p className="mt-1 text-[10px] leading-4 text-slate-500">Read-time preview；不是 formal production policy，不能單獨判定待買資格。</p>
        </div>
      </section>
    </aside>
  )
}

export default function StrategyLearningPage() {
  const [learning, setLearning] = useState<StrategyLearningResponse | null>(null)
  const [profiles, setProfiles] = useState<StrategyEvidenceProfile[]>([])
  const [strategyLanes, setStrategyLanes] = useState<StrategyEvidenceProfilesResponse['lanes'] | null>(null)
  const [rows, setRows] = useState<LearningRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [selectedStrategyKey, setSelectedStrategyKey] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      setNotice(null)
      const [ledgerResult, registryResult, profilesResult] = await Promise.allSettled([
        strategyLabApi.learning(),
        strategyLabApi.specs(),
        strategyLabApi.evidenceProfiles(),
      ])
      const ledger = ledgerResult.status === 'fulfilled' ? ledgerResult.value : null
      const registry = registryResult.status === 'fulfilled' ? registryResult.value : null
      const evidencePayload = profilesResult.status === 'fulfilled' ? profilesResult.value : null
      const evidenceProfiles = evidencePayload?.profiles ?? []
      if (!ledger && !registry) {
        const ledgerError = ledgerResult.status === 'rejected' ? String(ledgerResult.reason) : 'unknown ledger error'
        const registryError = registryResult.status === 'rejected' ? String(registryResult.reason) : 'unknown registry error'
        throw new Error(`Strategy APIs unavailable. ledger=${ledgerError}; registry=${registryError}`)
      }

      setLearning(ledger)
      setProfiles(evidenceProfiles)
      setStrategyLanes(evidencePayload?.lanes ?? null)
      if (registry) {
        const ledgerById = new Map((ledger?.specs ?? []).map((row) => [`${row.id}:${row.version}`, row]))
        setRows(registry.specs.map((spec) => ledgerById.get(`${spec.id}:${spec.version}`) ?? registryLearningRow(spec)))
      } else {
        setRows(ledger?.specs ?? [])
      }

      if (!ledger) setNotice('Reward ledger API unavailable; showing canonical strategy registry rows without reward metrics.')
      else if (!registry) setNotice('Strategy registry API unavailable; showing the latest reward-ledger snapshot.')
      else if ((ledger.specs ?? []).length === 0) setNotice('Reward ledger returned no specs; showing canonical strategy registry rows.')
      else if (profilesResult.status === 'rejected') setNotice('Strategy evidence profile API unavailable; current-semantic evidence is unavailable and no legacy maturity fallback is shown.')
    } catch (cause) {
      setLearning(null)
      setProfiles([])
      setStrategyLanes(null)
      setRows([])
      setError(cause instanceof Error ? cause.message : 'Strategy APIs unavailable')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const visibleRows = useMemo(() => rows.filter((row) => row.status !== 'retired'), [rows])
  const activeRows = useMemo(() => visibleRows.filter((row) => row.status === 'active'), [visibleRows])
  const gateById = useMemo(() => new Map((learning?.promotion_gate ?? []).map((gate) => [`${gate.strategy_id}:${gate.strategy_version}`, gate])), [learning])
  const profileById = useMemo(() => new Map(profiles.map((profile) => [`${profile.strategy_id}:${profile.strategy_version}`, profile])), [profiles])
  const previewPolicy = learning?.policy_state_preview ?? null
  const previewPolicyWeights = previewPolicy?.strategy_weights ?? EMPTY_STRATEGY_WEIGHTS
  const formalPolicy = strategyLanes?.formal.production_effect === true
    ? strategyLanes.formal.formal_policy_lineage ?? null
    : null
  const formalBasePolicyVersion = strategyLanes?.formal.base_policy_version ?? null
  const formalBasePolicyAsOfDate = strategyLanes?.formal.base_policy_as_of_date ?? null
  const previewPolicyVersion = previewPolicy?.version ?? null
  const formalPolicyRefreshRequired = Boolean(
    formalPolicy
    && formalBasePolicyVersion
    && previewPolicyVersion
    && formalBasePolicyVersion !== previewPolicyVersion
  )
  const formalPolicyWeights = formalPolicy?.strategy_weights ?? EMPTY_STRATEGY_WEIGHTS
  const orderedRows = useMemo(() => {
    const priority: Record<StrategyHealthBucket, number> = {
      evidence_repair: 0,
      prefilter_failed: 1,
      performance_cooldown: 2,
      promotion_pending: 3,
      accumulating: 4,
      execution_eligible: 5,
    }
    return [...visibleRows].sort((left, right) => {
      const leftGate = gateById.get([left.id, left.version].join(':'))
      const rightGate = gateById.get([right.id, right.version].join(':'))
      return priority[strategyHealthBucket(left, leftGate, strategyWeight(formalPolicyWeights, left.id))]
        - priority[strategyHealthBucket(right, rightGate, strategyWeight(formalPolicyWeights, right.id))]
        || left.name.localeCompare(right.name, 'zh-Hant')
    })
  }, [visibleRows, gateById, formalPolicyWeights])
  useEffect(() => {
    if (!orderedRows.some((row) => [row.id, row.version].join(':') === selectedStrategyKey)) {
      setSelectedStrategyKey(orderedRows[0] ? [orderedRows[0].id, orderedRows[0].version].join(':') : null)
    }
  }, [orderedRows, selectedStrategyKey])
  const selectedRow = useMemo(() => orderedRows.find((row) => [row.id, row.version].join(':') === selectedStrategyKey) ?? null, [orderedRows, selectedStrategyKey])
  const selectedGate = selectedRow ? gateById.get([selectedRow.id, selectedRow.version].join(':')) : undefined
  const selectedProfile = selectedRow ? profileById.get([selectedRow.id, selectedRow.version].join(':')) : undefined
  const executionEligibleCount = useMemo(() => {
    return (learning?.promotion_gate ?? []).filter((gate) => (
      gate.allocation_eligible === true
      && (strategyWeight(formalPolicyWeights, gate.strategy_id) ?? 0) > 0
    )).length
  }, [learning?.promotion_gate, formalPolicyWeights])
  const selectedFormalPolicyWeight = selectedRow ? strategyWeight(formalPolicyWeights, selectedRow.id) : null
  const selectedPreviewPolicyWeight = selectedRow ? strategyWeight(previewPolicyWeights, selectedRow.id) : null
  const positiveGateWeights = Object.entries(formalPolicyWeights)
    .filter(([, weight]) => Number.isFinite(Number(weight)) && Number(weight) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
  const concentratedGateShare = formalPolicy != null && activeRows.length > 1 && positiveGateWeights.length === 1
  const concentratedStrategy = positiveGateWeights[0] ?? null

  async function runAction(key: string, action: () => Promise<unknown>, success: string) {
    try {
      setBusy(key)
      setError(null)
      setResult(null)
      await action()
      setResult(success)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${key} failed`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <AppShell>
      <main className="space-y-5 p-4 lg:p-6">
        <header className="flex flex-col gap-4 rounded-3xl border border-emerald-400/15 bg-[radial-gradient(circle_at_14%_15%,rgba(52,211,153,0.12),transparent_30%),linear-gradient(135deg,#101714,#0b0f14_68%)] p-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold tracking-[0.14em] text-emerald-300">策略學習與報酬帳本</p>
            <h1 className="mt-2 flex items-center gap-2 font-['Space_Grotesk'] text-2xl font-semibold tracking-tight text-slate-50"><Activity className="h-5 w-5 text-emerald-300" /> 策略現在能做什麼、為什麼</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">這裡分開顯示：是否仍參與選股、證據累積到哪裡、是否達到升級門檻，以及推薦能否進入待買。0% formal contribution 不等於策略死亡，也不是帳戶資金比例。</p>
          </div>
          <Button size="sm" variant="outline" className="rounded-full border-emerald-400/25 text-emerald-200" disabled={refreshing} onClick={() => { setRefreshing(true); void load() }}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> 重新讀取證據
          </Button>
        </header>

        {loading ? (
          <div className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/70 p-5 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading reward ledger...</div>
        ) : (
          <>
            <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><div className="text-xs text-slate-500">正式參與選股的策略 / 持續評估</div><div className="mt-2 font-mono text-2xl text-emerald-200">{activeRows.length} <span className="text-sm text-slate-600">/ {visibleRows.length}</span></div><div className="mt-1 text-xs text-slate-500">待買權重 0% 仍持續學習、選股與累積證據；此處以 formal contribution 為準</div></div>
              <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] p-4"><div className="text-xs text-slate-400">目前可讓推薦進待買</div><div className="mt-2 font-mono text-2xl text-emerald-100">{formalPolicy ? executionEligibleCount : '-'}</div><div className="mt-1 text-xs text-slate-500">Allocation gate 與 formal contribution &gt; 0 必須同時成立；formal lineage 未取得時不判定</div></div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><div className="text-xs text-slate-500">Canonical lifecycle</div><div className="mt-2 font-mono text-xl text-slate-100">Candidate → Active</div><div className="mt-1 text-xs text-slate-500">沒有 Shadow strategy stage；升級由 Atomic V7 同日配對替換決定</div></div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><div className="text-xs text-slate-500">待買政策 Preview（診斷）</div><div className="mt-2 flex items-center gap-2 font-mono text-lg text-slate-100"><ShieldCheck className="h-4 w-4" /> {statusLabel(previewPolicy?.status ?? 'unavailable')}</div><div className="mt-1 text-xs text-slate-500">{previewPolicy?.evidence.production_effect ? 'API source 標記 production-effect' : '零 production-effect 比較'}；此欄仍是 read-time preview，不代表封存 formal policy</div></div>
            </section>

            <section className="rounded-2xl border border-slate-700/80 bg-slate-950/70 px-4 py-3 text-xs leading-5 text-slate-400">
              <h2 className="font-semibold text-slate-100">Active 正式 contribution 分配</h2>
              <p className="mt-1">raw score = max(0, rolling date-return mean) × min(samples / 100, 1) × min(mature dates / 30, 1)；只在 allocation gate 通過且 raw score &gt; 0 的 Active 之間正規化為 100%，再經 multi-horizon multiplier 與 formal firewall 重算。此 contribution 只控制推薦能否進待買，不是資金或部位比例。</p>
              <p className="mt-1 font-mono text-[10px] text-slate-500">formal base {formalBasePolicyVersion ?? 'unavailable'} · as-of {formalBasePolicyAsOfDate ?? 'unavailable'} · preview {previewPolicyVersion ?? 'unavailable'}</p>
            </section>

            {formalPolicyRefreshRequired ? (
              <section className="rounded-2xl border border-amber-400/30 bg-amber-400/[0.08] px-4 py-3 text-sm leading-6 text-amber-50" role="status">
                <span className="font-semibold">正式政策版本落後：</span>
                目前頁面正式 contribution 仍來自 {formalBasePolicyVersion}（{formalBasePolicyAsOfDate ?? '日期未取得'}），current preview 已是 {previewPolicyVersion}。系統不會用 read-time preview 冒充 production；正式權重會維持 fail-closed，直到 governed materialization 產生並封存新版 formal policy。
              </section>
            ) : null}

            <details className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
              <summary className="cursor-pointer text-sm font-semibold text-slate-200">治理與權責詳情：Production firewall／Threshold route comparison／Multi-horizon</summary>
            <section className="grid gap-3 lg:grid-cols-3">
              <article className="rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.06] p-4">
                <div className="flex items-center justify-between gap-2"><h2 className="font-semibold text-emerald-100">正式：Production contribution firewall</h2><Badge variant="outline" className={statusClass(strategyLanes?.formal.status ?? 'unavailable')}>{strategyLanes?.formal.production_effect ? '有 production 權限' : '權限資料未取得'}</Badge></div>
                <p className="mt-2 text-xs leading-5 text-slate-400">正式 firewall 負責最後待買資格與相對權重；multi-horizon evidence 是其中的正式輸入。正式封存版本 {strategyLanes?.formal.version ?? '資料尚未具備'}；正式證據截止 {strategyLanes?.formal.as_of_date ?? '資料尚未具備'}。Adaptive base {strategyLanes?.formal.base_policy_version ?? '資料尚未具備'} 截止 {strategyLanes?.formal.base_policy_as_of_date ?? '資料尚未具備'}，兩者日期不必相同。</p>
              </article>
              <article className="rounded-2xl border border-cyan-400/25 bg-cyan-400/[0.06] p-4">
                <div className="flex items-center justify-between gap-2"><h2 className="font-semibold text-cyan-100">Threshold route comparison（原 Shadow A）</h2><Badge variant="outline" className={statusClass(strategyLanes?.threshold_route_shadow.status ?? 'not_ready')}>evidence mode；不是 stage</Badge></div>
                <p className="mt-2 text-xs leading-5 text-slate-400">每個 Candidate 都有自己的型態命中與送評路由。此 lane 的 <span className="font-mono text-cyan-100">{strategyLanes?.threshold_route_shadow.mature_dates ?? 0} / {strategyLanes?.threshold_route_shadow.required_mature_dates ?? 11}</span> 日期只代表路由估計器成熟度；LCB90、殘差優勢與校準誤差是比較診斷，不能自行把 Candidate 升級。正式 activation 只走 Atomic V7。</p>
              </article>
              <article className="rounded-2xl border border-violet-400/25 bg-violet-400/[0.06] p-4">
                <div className="flex items-center justify-between gap-2"><h2 className="font-semibold text-violet-100">正式：Multi-horizon evidence（原 Shadow B）</h2><Badge variant="outline" className="border-violet-400/30 bg-violet-400/10 text-violet-200">{strategyLanes?.multi_horizon_formal.production_effect ? '正式 evidence owner' : strategyLanes?.multi_horizon_formal.production_integration_ready ? '已就緒，待正式 policy closure' : '結果資料已齊，指標建置中'}</Badge></div>
                <p className="mt-2 text-xs leading-5 text-slate-400">依策略特性使用 3、5 或 10 日結果窗評估；fully ready 才以 bounded multiplier 加減正式權重，未成熟保持 1.0 中性。主週期結果已具資料的 profile：<span className="font-mono text-violet-100">{strategyLanes?.multi_horizon_formal.ready_primary_profiles ?? 0} / {strategyLanes?.multi_horizon_formal.total_profiles ?? profiles.length}</span>。</p>
                <p className="mt-1 text-[11px] text-slate-500">已封存正式 policy 吸收的 fully-ready profile：{Number(strategyLanes?.multi_horizon_formal.active_policy_evidence_owner?.ready_profile_count ?? 0)}；最新一輪 input 已完整物化 {strategyLanes?.multi_horizon_formal.metric_materialized_profiles ?? 0} / {strategyLanes?.multi_horizon_formal.total_profiles ?? profiles.length}、本輪 fully ready {strategyLanes?.multi_horizon_formal.metric_ready_profiles ?? 0}。最新一輪仍缺 {strategyLanes?.multi_horizon_formal.missing_required_metrics?.length ?? 0} 種資料依賴；這只讓該輪未成熟 profile 維持 1.0 中性，不撤銷已封存的 formal-owner 權責。</p>
                <p className="mt-1 text-[11px] text-slate-500">物化筆數：{(strategyLanes?.multi_horizon_formal.horizon_coverage ?? []).map((row) => `${row.horizon_days} 日 ${row.outcome_rows}`).join(' · ') || '尚未開始'}</p>
              </article>
            </section>

            </details>

            <AtomicReplacementSummary replacementGate={learning?.replacement_gate ?? null} />

            <details className="rounded-2xl border border-slate-700/80 bg-slate-950/70 px-4 py-3 text-sm text-slate-300">
              <summary className="cursor-pointer font-semibold text-slate-100">名詞白話說明（點開查看）</summary>
              <dl className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <div><dt className="font-semibold text-emerald-200">PIT（當時可知資料）</dt><dd className="mt-1 text-xs leading-5 text-slate-500">只使用那個交易日當下已公開、已入庫的資料，禁止拿未來資訊回頭美化結果。</dd></div>
                <div><dt className="font-semibold text-emerald-200">T+5 成熟報酬</dt><dd className="mt-1 text-xs leading-5 text-slate-500">推薦後走完五個交易日，才能知道扣除成本後的真實結果。</dd></div>
                <div><dt className="font-semibold text-emerald-200">LCB90</dt><dd className="mt-1 text-xs leading-5 text-slate-500">成熟交易日平均 Alpha 的單側 90% 信賴下界；大於 0 是平均 edge 的統計證據，不代表每天或每筆交易都不會出現負報酬。</dd></div>
                <div><dt className="font-semibold text-emerald-200">Pending-buy gate</dt><dd className="mt-1 text-xs leading-5 text-slate-500">最後一道待買資格門。沒通過仍會選股與學習，但不能單靠該策略把推薦送進待買。</dd></div>
                <div><dt className="font-semibold text-emerald-200">Gate share</dt><dd className="mt-1 text-xs leading-5 text-slate-500">只在通過待買門檻的策略間比較的相對權重；不是資金配置或下單比例。</dd></div>
                <div><dt className="font-semibold text-emerald-200">Blocked／資料尚未具備／不適用</dt><dd className="mt-1 text-xs leading-5 text-slate-500">Blocked 是必要條件明確失敗；資料尚未具備是證據缺漏；不適用表示這個欄位本來就不屬於該階段。</dd></div>
              </dl>
            </details>

            {concentratedGateShare && concentratedStrategy ? (
              <section className="rounded-2xl border border-amber-400/30 bg-amber-400/[0.08] px-4 py-3 text-sm leading-6 text-amber-50">
                <span className="font-semibold">待買資格過度集中（非健康穩態）：</span>
                目前 13 個正式策略只有 <code className="rounded bg-slate-950/70 px-1.5 py-0.5 text-xs">{concentratedStrategy[0]}</code> 通過全部門檻，所以在通過者之間的相對權重會顯示 {pct(Number(concentratedStrategy[1]))}。這不是全帳戶押一個策略；其餘 {activeRows.length - 1} 個策略仍選股與學習，但暫時不能單靠自身訊號讓推薦進待買。系統維持 fail-closed，不會為了湊數放寬門檻。
              </section>
            ) : null}

            <StrategyHealthBoard
              rows={orderedRows}
              gateById={gateById}
              formalPolicyWeights={formalPolicyWeights}
              previewPolicyWeights={previewPolicyWeights}
              selectedKey={selectedStrategyKey}
              onSelect={setSelectedStrategyKey}
            />

            {error && <div className="rounded-xl border border-rose-400/25 bg-rose-400/[0.06] p-4 text-sm text-rose-200">{error}</div>}
            {notice && <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-4 text-sm text-amber-100">{notice}</div>}
            {result && <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] p-4 text-sm text-emerald-200">{result}</div>}

            <section className="grid gap-4 xl:grid-cols-[minmax(0,10fr)_minmax(0,7fr)_minmax(0,3fr)] xl:items-start">
              <div className="min-w-0">
                {selectedRow ? (
                  <StrategyLedgerGroup
                    title="策略工作區"
                    description={selectedRow.status === 'active' ? '正式策略：查看此策略自己的續留門檻、multi-horizon evidence 與待買資格。' : '學習策略：查看此策略自己的升級門檻與 comparison-only evidence。'}
                    rows={[selectedRow]}
                    gateById={gateById}
                    profileById={profileById}
                    formalPolicyWeights={formalPolicyWeights}
                    requestedDate={learning?.date ?? null}
                    empty="目前篩選沒有可顯示的策略。"
                  />
                ) : <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6 text-sm text-slate-500">目前篩選沒有可顯示的策略。</div>}
              </div>
              <StrategyStageTransitionCard row={selectedRow} gate={selectedGate} />
              <StrategyLineageInspector
                row={selectedRow}
                gate={selectedGate}
                profile={selectedProfile}
                snapshotDate={learning?.date ?? null}
                formalPolicyWeight={selectedFormalPolicyWeight}
                previewPolicyWeight={selectedPreviewPolicyWeight}
                lanes={strategyLanes}
              />
            </section>

            <footer className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <p className="max-w-2xl text-xs leading-5 text-slate-500">Decision log → verify/paper outcome → reward ledger → allocation policy。選股與 evaluation 不受 allocation=0 影響；所有 pending-buy 入口都必須取得明確 execution eligibility。</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void runAction('decision log', () => strategyLabApi.materializeDecisionLog({ limit: 500, dry_run: false, confirm: true }), '決策紀錄已更新。')}>物化決策紀錄</Button>
                <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void runAction('reward ledger', () => strategyLabApi.refreshStrategyRewardLedger({ limit: 5000, dry_run: false, confirm: true }), '報酬帳本已更新。')}>更新報酬帳本</Button>
                <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void runAction('adaptive policy', () => strategyLabApi.refreshStrategyPolicyState({ dry_run: false, confirm: true }), '自適應策略政策已更新。')}>重算待買政策</Button>
              </div>
            </footer>
          </>
        )}
      </main>
    </AppShell>
  )
}
