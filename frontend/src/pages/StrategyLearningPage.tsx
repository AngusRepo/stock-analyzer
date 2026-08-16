import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import AppShell from '@/components/AppShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { strategyLabApi, type StrategyLearningResponse, type StrategyPromotionGate, type StrategyReplacementDecisionSummary, type StrategyReplacementGateSummary, type StrategySpec } from '@/lib/api'

type LearningRow = StrategyLearningResponse['specs'][number]

function pct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '資料尚未具備'
  return `${(Number(value) * 100).toFixed(1)}%`
}
function rewardMetric(value: number | null | undefined, unit: 'return_fraction' | 'r_multiple'): string {
  if (value == null || !Number.isFinite(Number(value))) return '資料尚未具備'
  return unit === 'r_multiple' ? `${Number(value).toFixed(3)}R` : pct(value)
}

function signedClass(value: number | null | undefined): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric === 0) return 'text-slate-300'
  return numeric > 0 ? 'text-rose-300' : 'text-emerald-300'
}


function statusClass(status: string): string {
  if (status === 'active' || status === 'active_monitor' || status === 'learning') return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
  if (status === 'shadow' || status === 'candidate' || status === 'candidate_ready') return 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200'
  if (status === 'reward_join_missing') return 'border-rose-400/30 bg-rose-400/10 text-rose-200'
  if (status === 'research' || status === 'not_ready' || status === 'no_reward' || status === 'pending_maturity' || status === 'no_matches') return 'border-amber-400/30 bg-amber-400/10 text-amber-200'
  return 'border-slate-600 bg-slate-800/50 text-slate-300'
}

function gateResultClass(pass: boolean | null): string {
  if (pass == null) return 'text-slate-500'
  return pass ? 'text-emerald-300' : 'text-rose-300'
}

function gateResultLabel(pass: boolean | null): string {
  if (pass == null) return '待累積'
  return pass ? '通過' : '未通過'
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: '正式選股中', active_monitor: '正式保留', active_cooldown: '正式降溫',
    learning: '持續學習', shadow: '影子觀察', candidate: '候選', candidate_ready: '候選已成熟',
    research: '研究中', not_ready: '證據未成熟', no_reward: '尚無成熟報酬',
    pending_maturity: '等待 T+5', no_matches: '尚未命中型態', reward_join_missing: '報酬串接缺漏',
    unavailable: '資料尚未具備',
  }
  return labels[status] ?? status.replace(/_/g, ' ')
}

type StrategyHealthBucket = 'healthy' | 'evidence_repair' | 'accumulating' | 'performance_cooldown'

function strategyHealthBucket(row: LearningRow, gate?: StrategyPromotionGate): StrategyHealthBucket {
  if (gate?.allocation_eligible === true) return 'healthy'
  if (
    !gate
    || row.learning.reward_state === 'reward_join_missing'
    || row.learning.reward_state === 'unavailable'
    || gate.missing_evidence.some((reason) => reason.includes('missing'))
  ) return 'evidence_repair'
  if (
    row.learning.reward_state === 'pending_maturity'
    || row.learning.reward_state === 'no_matches'
    || gate.missing_evidence.every((reason) => (
      reason.startsWith('decisions_lt_')
      || reason.startsWith('samples_lt_')
      || reason.startsWith('mature_dates_lt_')
    ))
  ) return 'accumulating'
  return 'performance_cooldown'
}

function strategyHealthLabel(bucket: StrategyHealthBucket): string {
  return {
    healthy: '健康：可進待買',
    evidence_repair: '資料管線待修',
    accumulating: '證據累積中',
    performance_cooldown: '績效未過門檻',
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
    status_must_enter_shadow_before_promotion: '必須先進入影子觀察階段',
    production_owned_by_s12_calibration_not_selection_replacement: '正式權責屬於 S12 校準，不由選股策略替換流程升級',
  }
  if (reason.startsWith('max_drawdown_lt_') || reason.startsWith('active_max_drawdown_lt_')) {
    return `最大回撤超過容許範圍（門檻 ${pct(Number(reason.replace(/^(active_)?max_drawdown_lt_/, ''))) }）`
  }
  return labels[reason] ?? reason.replace(/_/g, ' ')
}

function bestReplacementDecision(
  row: LearningRow,
  replacement: StrategyReplacementGateSummary | null,
): { decision: StrategyReplacementDecisionSummary; role: 'candidate' | 'incumbent' } | null {
  if (!replacement) return null
  const key = `${row.id}:${row.version}`
  const ranked = replacement.decisions
    .reduce<Array<{ decision: StrategyReplacementDecisionSummary; role: 'candidate' | 'incumbent' }>>((items, decision) => {
      if (`${decision.candidate_strategy_id}:${decision.candidate_strategy_version}` === key) {
        items.push({ decision, role: 'candidate' })
      }
      else if (`${decision.replaced_strategy_id}:${decision.replaced_strategy_version}` === key) {
        items.push({ decision, role: 'incumbent' })
      }
      return items
    }, [])
    .sort((left, right) => {
      const statusRank = { accepted: 0, proposed: 1, rejected: 2 }
      const statusDelta = statusRank[left.decision.status] - statusRank[right.decision.status]
      if (statusDelta !== 0) return statusDelta
      return Number(right.decision.paired_delta_lcb90 ?? Number.NEGATIVE_INFINITY)
        - Number(left.decision.paired_delta_lcb90 ?? Number.NEGATIVE_INFINITY)
    })
  return ranked[0] ?? null
}

function compactStrategyId(strategyId: string): string {
  return strategyId.replace(/^stock_tech_/, '').replace(/_v\d+$/, '').replace(/_/g, ' ')
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

function StrategyGateDetails({
  row,
  gate,
  paired,
  replacementGate,
}: {
  row: LearningRow
  gate: StrategyPromotionGate | undefined
  paired: { decision: StrategyReplacementDecisionSummary; role: 'candidate' | 'incumbent' } | null
  replacementGate: StrategyReplacementGateSummary | null
}) {
  if (!gate) {
    return <p className="mt-3 text-xs text-slate-500">Promotion threshold evidence is unavailable.</p>
  }
  const thresholds = gate.thresholds
  const evidence = gate.evidence
  const isActiveIncumbent = gate.strategy_status === 'active'
  const hitRateThreshold = isActiveIncumbent
    ? thresholds.active_retention_min_hit_rate
    : thresholds.min_hit_rate
  const isS12ExecutionOwner = row.learning.reward_owner === 's12_execution_replay_v3_net'
  const decision = paired?.decision ?? null
  const policy = replacementGate?.policy ?? null
  const run = replacementGate?.latest_run ?? null
  const mddPass = evidence.max_drawdown_pct == null ? null : evidence.max_drawdown_pct >= thresholds.min_max_drawdown
  const readiness = [
    { label: '可評估決策數', description: 'PIT 欄位齊全、可公平判定策略是否命中的決策筆數。', value: String(evidence.decisions), target: `>= ${thresholds.min_evaluable_decisions}`, pass: evidence.decisions >= thresholds.min_evaluable_decisions },
    { label: '型態命中率', description: '可評估股票中，符合這個策略進場型態的比例。', value: pct(evidence.match_rate), target: `>= ${pct(thresholds.min_match_rate)}`, pass: evidence.match_rate == null ? null : evidence.match_rate >= thresholds.min_match_rate },
    { label: '成熟報酬樣本', description: '已走完 T+5 並扣除交易成本、可計算績效的樣本數。', value: String(evidence.samples), target: `>= ${thresholds.min_reward_samples}`, pass: evidence.samples >= thresholds.min_reward_samples },
    { label: '勝率', description: '成熟樣本中，扣除成本後仍為正報酬的比例。', value: pct(evidence.hit_rate), target: `>= ${pct(hitRateThreshold)}`, pass: evidence.hit_rate == null ? null : evidence.hit_rate >= hitRateThreshold },
    { label: '扣成本平均報酬', description: '每筆成熟樣本扣除來回交易成本後的平均結果。', value: rewardMetric(evidence.avg_return_pct, row.learning.reward_unit), target: '> 0', pass: evidence.avg_return_pct == null ? null : evidence.avg_return_pct > thresholds.min_avg_cost_net_return_exclusive },
    { label: '每日報酬 90% 保守下界（LCB90）', description: '把統計不確定性算進去後，仍有九成信心水準可守住的報酬下界。', value: rewardMetric(evidence.date_return_lcb90, row.learning.reward_unit), target: '> 0', pass: evidence.date_return_lcb90 == null ? null : evidence.date_return_lcb90 > thresholds.min_date_return_lcb90_exclusive },
    { label: '最大回撤（MDD）', description: '觀察期內從高點跌到低點的最差幅度；越接近 0 越好。', value: rewardMetric(evidence.max_drawdown_pct, row.learning.reward_unit), target: `>= ${rewardMetric(thresholds.min_max_drawdown, row.learning.reward_unit)}`, pass: mddPass },
    { label: '成熟交易日數', description: '至少有一筆報酬已成熟、可納入每日統計的不同交易日數。', value: String(evidence.mature_dates), target: `>= ${thresholds.min_mature_dates}`, pass: evidence.mature_dates >= thresholds.min_mature_dates },
  ]

  let pairMetrics: Array<{ label: string; description: string; value: string; target: string; pass: boolean | null }> = []
  if (decision && policy) {
    const pairMddPass = decision.candidate_max_drawdown == null || decision.incumbent_max_drawdown == null
      ? null
      : decision.candidate_max_drawdown >= decision.incumbent_max_drawdown - policy.max_drawdown_degradation
    const pairTurnoverPass = decision.candidate_turnover == null || decision.incumbent_turnover == null
      ? null
      : decision.candidate_turnover <= decision.incumbent_turnover + policy.max_turnover_increase
    const pairCorrelationPass = decision.return_correlation == null
      ? null
      : decision.return_correlation <= policy.max_duplicate_return_correlation
        || (decision.candidate_max_drawdown != null && decision.incumbent_max_drawdown != null && decision.candidate_max_drawdown > decision.incumbent_max_drawdown)
        || (decision.candidate_turnover != null && decision.incumbent_turnover != null && decision.candidate_turnover < decision.incumbent_turnover)
    pairMetrics = [
      { label: '同日配對樣本', description: '候選與現任策略在同一批交易日可直接公平比較的日數。', value: String(decision.paired_dates), target: `>= ${policy.min_paired_dates}`, pass: decision.paired_dates >= policy.min_paired_dates },
      { label: '相對優勢 90% 保守下界', description: '候選扣除現任策略後的增量報酬，算入不確定性後是否仍大於 0。', value: pct(decision.paired_delta_lcb90), target: '> 0', pass: decision.paired_delta_lcb90 == null ? null : decision.paired_delta_lcb90 > policy.min_paired_delta_lcb90_exclusive },
      { label: '候選扣成本平均報酬', description: '候選本身必須賺錢，不能只因現任更差就通過。', value: pct(decision.candidate_absolute_cost_net_mean), target: '> 0', pass: decision.candidate_absolute_cost_net_mean == null ? null : decision.candidate_absolute_cost_net_mean > policy.min_candidate_absolute_cost_net_mean_exclusive },
      { label: '回撤相對現任', description: '候選的最差跌幅不能比被替換策略惡化太多。', value: `${pct(decision.candidate_max_drawdown)} / ${pct(decision.incumbent_max_drawdown)}`, target: `within ${pct(policy.max_drawdown_degradation)}`, pass: pairMddPass },
      { label: '換手率相對現任', description: '候選不能靠過度交易製造紙上績效。', value: `${pct(decision.candidate_turnover)} / ${pct(decision.incumbent_turnover)}`, target: `within ${pct(policy.max_turnover_increase)}`, pass: pairTurnoverPass },
      { label: '報酬相關性', description: '越高代表兩策略越像；過度重複通常不值得替換。', value: decision.return_correlation == null ? '資料尚未具備' : decision.return_correlation.toFixed(3), target: `<= ${policy.max_duplicate_return_correlation.toFixed(2)} or risk improves`, pass: pairCorrelationPass },
    ]
  }
  const counterpart = decision
    ? paired?.role === 'candidate'
      ? decision.replaced_strategy_id
      : decision.candidate_strategy_id
    : null

  return (
    <div className="mt-3 space-y-3 border-t border-slate-800 pt-3 text-[11px]">
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="font-semibold text-slate-300">{isActiveIncumbent ? '正式策略續留門檻' : '候選策略升級門檻'}</span>
          <span className="text-slate-500">{isActiveIncumbent ? `續留勝率 >= ${pct(thresholds.active_retention_min_hit_rate)}` : `升級勝率 >= ${pct(thresholds.min_hit_rate)}`} · 使用滾動證據</span>
        </div>
        <div className="grid gap-x-4 md:grid-cols-2">
          {readiness.map((item) => <GateMetric key={item.label} {...item} />)}
        </div>
      </div>

      <div className="border-t border-slate-800 pt-3">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-slate-300">原子替換 V7 門檻（候選能否取代現任）</span>
          <span className="font-mono text-slate-500">{run ? `Evidence as of ${run.as_of_date} · mature paired dates ${run.sample_dates} · ${run.status === 'shadow' ? 'shadow（不影響 production）' : run.status}` : replacementGate?.evidence_status ?? 'evidence not ready'}</span>
        </div>
        {isS12ExecutionOwner ? (
          <p className="text-slate-500">Not applicable: S12 is owned by execution calibration, not selection-strategy replacement.</p>
        ) : decision && policy ? (
          <>
            <p className="mb-1 text-slate-500">
              {paired?.role === 'candidate' ? 'Replace' : 'Challenged by'}{' '}
              <span className="text-slate-300">{compactStrategyId(counterpart ?? '')}</span>{' '}
              · {decision.replacement_scope ?? 'scope unavailable'} · <span className={statusClass(decision.status)}>{decision.status}</span>
            </p>
            <div className="grid gap-x-4 md:grid-cols-2">
              {pairMetrics.map((item) => <GateMetric key={item.label} {...item} />)}
            </div>
            <p className="mt-2 text-slate-500">
              Full portfolio gates: cost-net LCB <span className={gateResultClass(run?.promotion_gates.full_portfolio_positive_cost_net_lcb ?? null)}>{gateResultLabel(run?.promotion_gates.full_portfolio_positive_cost_net_lcb ?? null)}</span>
              {' · '}correlation <span className={gateResultClass(run?.portfolio_risk.correlation_pass ?? null)}>{gateResultLabel(run?.portfolio_risk.correlation_pass ?? null)}</span>
              {' · '}turnover <span className={gateResultClass(run?.portfolio_risk.turnover_pass ?? null)}>{gateResultLabel(run?.portfolio_risk.turnover_pass ?? null)}</span>
              {' · '}owner coverage <span className={gateResultClass(run?.promotion_gates.registry_and_serving_owner_coverage_complete ?? null)}>{gateResultLabel(run?.promotion_gates.registry_and_serving_owner_coverage_complete ?? null)}</span>
            </p>
            {decision.rejection_reasons.length > 0 && <p className="mt-1 text-amber-200">Blocked: {decision.rejection_reasons.join(', ').replace(/_/g, ' ')}</p>}
          </>
        ) : policy ? (
          <p className="leading-5 text-slate-500">
            No paired proposal for this strategy in the latest Atomic V7 run. Required: {policy.min_paired_dates}+ paired dates, residual LCB90 &gt; 0, cost-net mean &gt; 0, MDD within {pct(policy.max_drawdown_degradation)}, turnover within {pct(policy.max_turnover_increase)}, and correlation &le; {policy.max_duplicate_return_correlation.toFixed(2)} unless risk improves. Cross-family replacement also requires every full-portfolio gate to pass.
          </p>
        ) : (
          <p className="text-slate-500">Replacement policy evidence is unavailable.</p>
        )}
      </div>
    </div>
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
  policyWeights,
  replacementGate,
  requestedDate,
  empty,
}: {
  title: string
  description: string
  rows: LearningRow[]
  gateById: Map<string, StrategyPromotionGate>
  policyWeights: Record<string, number>
  replacementGate: StrategyReplacementGateSummary | null
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

      <div className="grid grid-cols-1 gap-px bg-slate-900 xl:grid-cols-2">
        {rows.map((row) => {
          const gate = gateById.get(`${row.id}:${row.version}`)
          const hasWeight = Object.prototype.hasOwnProperty.call(policyWeights, row.id)
          const weight = Number(policyWeights[row.id] ?? 0)
          const executionEligible = gate?.allocation_eligible === true && Number.isFinite(weight) && weight > 0
          const paired = bestReplacementDecision(row, replacementGate)
          const evidence = gate?.missing_evidence ?? []
          const evidenceLabels = gate ? (evidence.length ? evidence : ['全部待買門檻已通過']) : ['報酬帳本資料未取得']
          const healthBucket = strategyHealthBucket(row, gate)
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
                  <Badge variant="outline" className={statusClass(healthBucket === 'healthy' ? 'active' : healthBucket === 'evidence_repair' ? 'reward_join_missing' : 'not_ready')}>{strategyHealthLabel(healthBucket)}</Badge>
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
                </div>
                <div className="rounded-lg border border-slate-800/80 bg-slate-900/45 p-2">
                  <dt className="text-xs text-slate-500">滾動成熟交易日</dt>
                  <dd className="mt-1 font-mono text-sm text-cyan-200">{row.learning.evidence_available ? rollingMature : '-'}</dd>
                  <div className={`mt-1 text-xs ${signedClass(row.learning.rolling_date_return_lcb90)}`}>{row.learning.evidence_available ? rewardPending || rewardMissing || noMatches ? rollingMature : <>LCB90 {rewardMetric(row.learning.rolling_date_return_lcb90, row.learning.reward_unit)}</> : 'Unavailable'}</div>
                </div>
                <div className="rounded-lg border border-slate-800/80 bg-slate-900/45 p-2"><dt className="text-xs text-slate-500">Rolling hit / avg</dt><dd className="mt-1 font-mono text-sm text-slate-300">{rewardPending || rewardMissing || noMatches ? rollingMature : <>{pct(row.learning.rolling_hit_rate)} / <span className={signedClass(row.learning.rolling_avg_return_pct)}>{rewardMetric(row.learning.rolling_avg_return_pct, row.learning.reward_unit)}</span></>}</dd></div>
                <div className="rounded-lg border border-slate-800/80 bg-slate-900/45 p-2"><dt className="text-xs text-slate-500">Rolling MDD</dt><dd className={`mt-1 font-mono text-sm ${signedClass(row.learning.rolling_max_drawdown_pct)}`}>{rewardPending || rewardMissing || noMatches ? rollingMature : rewardMetric(row.learning.rolling_max_drawdown_pct, row.learning.reward_unit)}</dd></div>
              </dl>

              <div className="grid gap-3">
                <div className="rounded-xl border border-slate-800 bg-slate-900/35 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                    <span>待買資格相對權重（Pending-buy gate share）</span>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={executionEligible ? statusClass('active') : statusClass('not_ready')}>{executionEligible ? '可讓推薦進入待買' : '只選股與評估，不進待買'}</Badge>
                      <span className="font-mono text-slate-300">{hasWeight ? pct(weight) : '未取得待買權重'}</span>
                    </div>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
                    <div className="h-full bg-emerald-300" style={{ width: `${hasWeight ? Math.max(0, Math.min(100, weight * 100)) : 0}%` }} />
                  </div>
                  <p className="mt-2 text-xs text-slate-500">這個百分比只在「已通過全部門檻」的策略之間正規化，用來決定哪個策略可讓推薦進待買；不是帳戶資金、下單金額或部位比例。0% 仍繼續選股與累積證據。</p>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-900/35 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={statusClass(gate?.decision ?? 'ledger_pending')}>{gate?.decision ?? 'ledger pending'}</Badge>
                    <span className="text-xs text-slate-500">{gate?.current_stage ?? 'stage unavailable'} &rarr; {gate?.recommended_stage ?? gate?.recommended_next_status ?? 'reward gate unavailable'}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {evidenceLabels.slice(0, 3).map((item) => (
                      <span key={item} className={`rounded-md border px-2 py-1 text-xs ${evidence.length ? 'border-amber-400/20 bg-amber-400/[0.06] text-amber-200' : gate ? 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-200' : 'border-slate-600/40 bg-slate-800/50 text-slate-400'}`}>{gateReasonLabel(item)}</span>
                    ))}
                  </div>
                  <StrategyGateDetails row={row} gate={gate} paired={paired} replacementGate={replacementGate} />
                </div>
              </div>
            </article>
          )
        })}
        {!rows.length && <div className="px-5 py-8 text-sm text-slate-500 xl:col-span-2">{empty}</div>}
      </div>
    </section>
  )
}
export default function StrategyLearningPage() {
  const [learning, setLearning] = useState<StrategyLearningResponse | null>(null)
  const [rows, setRows] = useState<LearningRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      setNotice(null)
      const [ledgerResult, registryResult] = await Promise.allSettled([
        strategyLabApi.learning(),
        strategyLabApi.specs(),
      ])
      const ledger = ledgerResult.status === 'fulfilled' ? ledgerResult.value : null
      const registry = registryResult.status === 'fulfilled' ? registryResult.value : null
      if (!ledger && !registry) {
        const ledgerError = ledgerResult.status === 'rejected' ? String(ledgerResult.reason) : 'unknown ledger error'
        const registryError = registryResult.status === 'rejected' ? String(registryResult.reason) : 'unknown registry error'
        throw new Error(`Strategy APIs unavailable. ledger=${ledgerError}; registry=${registryError}`)
      }

      setLearning(ledger)
      if (registry) {
        const ledgerById = new Map((ledger?.specs ?? []).map((row) => [`${row.id}:${row.version}`, row]))
        setRows(registry.specs.map((spec) => ledgerById.get(`${spec.id}:${spec.version}`) ?? registryLearningRow(spec)))
      } else {
        setRows(ledger?.specs ?? [])
      }

      if (!ledger) setNotice('Reward ledger API unavailable; showing canonical strategy registry rows without reward metrics.')
      else if (!registry) setNotice('Strategy registry API unavailable; showing the latest reward-ledger snapshot.')
      else if ((ledger.specs ?? []).length === 0) setNotice('Reward ledger returned no specs; showing canonical strategy registry rows.')
    } catch (cause) {
      setLearning(null)
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
  const learningRows = useMemo(() => visibleRows.filter((row) => row.status === 'research' || row.status === 'shadow' || row.status === 'candidate'), [visibleRows])
  const gateById = useMemo(() => new Map((learning?.promotion_gate ?? []).map((gate) => [`${gate.strategy_id}:${gate.strategy_version}`, gate])), [learning])
  const activeHealthCounts = useMemo(() => {
    const counts: Record<StrategyHealthBucket, number> = {
      healthy: 0,
      evidence_repair: 0,
      accumulating: 0,
      performance_cooldown: 0,
    }
    for (const row of activeRows) {
      counts[strategyHealthBucket(row, gateById.get(`${row.id}:${row.version}`))] += 1
    }
    return counts
  }, [activeRows, gateById])
  const executionEligibleCount = useMemo(() => {
    const weights = learning?.policy_state_preview?.strategy_weights ?? {}
    return (learning?.promotion_gate ?? []).filter((gate) => (
      gate.allocation_eligible === true
      && Number.isFinite(Number(weights[gate.strategy_id]))
      && Number(weights[gate.strategy_id]) > 0
    )).length
  }, [learning])
  const policy = learning?.policy_state_preview
  const positiveGateWeights = Object.entries(policy?.strategy_weights ?? {})
    .filter(([, weight]) => Number.isFinite(Number(weight)) && Number(weight) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
  const concentratedGateShare = activeRows.length > 1 && positiveGateWeights.length === 1
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
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">這裡分開顯示：是否仍參與選股、證據累積到哪裡、是否達到升級門檻，以及推薦能否進入待買。0% 待買權重不等於策略死亡，也不是帳戶資金比例。</p>
          </div>
          <Button size="sm" variant="outline" className="rounded-full border-emerald-400/25 text-emerald-200" disabled={refreshing} onClick={() => { setRefreshing(true); void load() }}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> 重新讀取證據
          </Button>
        </header>

        {loading ? (
          <div className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/70 p-5 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading reward ledger...</div>
        ) : (
          <>
            <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><div className="text-xs text-slate-500">正式參與選股的策略</div><div className="mt-2 font-mono text-2xl text-emerald-200">{activeRows.length}</div><div className="mt-1 text-xs text-slate-500">代表 registry=active，不代表每個都能進待買</div></div>
              <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] p-4"><div className="text-xs text-slate-400">目前可讓推薦進待買</div><div className="mt-2 font-mono text-2xl text-emerald-100">{learning ? executionEligibleCount : '-'}</div><div className="mt-1 text-xs text-slate-500">必須同時通過報酬、勝率、回撤、成熟度與保守下界</div></div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><div className="text-xs text-slate-500">持續接受評估的策略</div><div className="mt-2 font-mono text-2xl text-cyan-200">{visibleRows.length}</div><div className="mt-1 text-xs text-slate-500">共用同一條推薦／評估資料流；待買權重 0% 仍持續學習</div></div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><div className="text-xs text-slate-500">升級／續留勝率門檻</div><div className="mt-2 font-mono text-xl text-slate-100">52% / 48%</div><div className="mt-1 text-xs text-slate-500">候選策略至少 52%；現任策略至少 48%</div></div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><div className="text-xs text-slate-500">待買政策預覽</div><div className="mt-2 flex items-center gap-2 font-mono text-lg text-slate-100"><ShieldCheck className="h-4 w-4" /> {statusLabel(policy?.status ?? 'unavailable')}</div><div className="mt-1 text-xs text-slate-500">{policy?.evidence.production_effect ? '會影響待買資格' : '只做影子觀察'}；此頁只讀、不會直接改權重</div></div>
            </section>

            <details className="rounded-2xl border border-slate-700/80 bg-slate-950/70 px-4 py-3 text-sm text-slate-300">
              <summary className="cursor-pointer font-semibold text-slate-100">名詞白話說明（點開查看）</summary>
              <dl className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <div><dt className="font-semibold text-emerald-200">PIT（當時可知資料）</dt><dd className="mt-1 text-xs leading-5 text-slate-500">只使用那個交易日當下已公開、已入庫的資料，禁止拿未來資訊回頭美化結果。</dd></div>
                <div><dt className="font-semibold text-emerald-200">T+5 成熟報酬</dt><dd className="mt-1 text-xs leading-5 text-slate-500">推薦後走完五個交易日，才能知道扣除成本後的真實結果。</dd></div>
                <div><dt className="font-semibold text-emerald-200">LCB90</dt><dd className="mt-1 text-xs leading-5 text-slate-500">90% 信心水準的保守報酬下界；大於 0 才代表不是只靠運氣看起來賺錢。</dd></div>
                <div><dt className="font-semibold text-emerald-200">Pending-buy gate</dt><dd className="mt-1 text-xs leading-5 text-slate-500">最後一道待買資格門。沒通過仍會選股與學習，但不能單靠該策略把推薦送進待買。</dd></div>
                <div><dt className="font-semibold text-emerald-200">Gate share</dt><dd className="mt-1 text-xs leading-5 text-slate-500">只在通過待買門檻的策略間比較的相對權重；不是資金配置或下單比例。</dd></div>
                <div><dt className="font-semibold text-emerald-200">Blocked／資料尚未具備／不適用</dt><dd className="mt-1 text-xs leading-5 text-slate-500">Blocked 是必要條件明確失敗；資料尚未具備是證據缺漏；不適用表示這個欄位本來就不屬於該階段。</dd></div>
              </dl>
            </details>

            <section className="rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.05] px-4 py-3 text-sm leading-6 text-cyan-50">
              <span className="font-semibold">單一推薦資料流：</span>
              所有未退役策略都持續選股、產生推薦標籤並累積證據；只有「待買資格」控制推薦能不能進入待買，不會把未過門檻的策略移出學習系統。
            </section>
            {concentratedGateShare && concentratedStrategy ? (
              <section className="rounded-2xl border border-amber-400/30 bg-amber-400/[0.08] px-4 py-3 text-sm leading-6 text-amber-50">
                <span className="font-semibold">待買資格過度集中（非健康穩態）：</span>
                目前 13 個正式策略只有 <code className="rounded bg-slate-950/70 px-1.5 py-0.5 text-xs">{concentratedStrategy[0]}</code> 通過全部門檻，所以在通過者之間的相對權重會顯示 {pct(Number(concentratedStrategy[1]))}。這不是全帳戶押一個策略；其餘 {activeRows.length - 1} 個策略仍選股與學習，但暫時不能單靠自身訊號讓推薦進待買。系統維持 fail-closed，不會為了湊數放寬門檻。
              </section>
            ) : null}

            <section className="rounded-2xl border border-slate-700/80 bg-slate-950/70 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-slate-100">正式策略健康分流</h2>
                  <p className="mt-1 text-xs leading-5 text-slate-500">不把所有未通過都叫 Blocked：先分辨是能自動補資料、只需等待成熟，還是真實績效不合格。</p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                  <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-2"><div className="font-mono text-lg text-emerald-200">{activeHealthCounts.healthy}</div><div className="text-[11px] text-slate-500">可進待買</div></div>
                  <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/[0.06] px-3 py-2"><div className="font-mono text-lg text-cyan-200">{activeHealthCounts.accumulating}</div><div className="text-[11px] text-slate-500">證據累積</div></div>
                  <div className="rounded-lg border border-rose-400/20 bg-rose-400/[0.06] px-3 py-2"><div className="font-mono text-lg text-rose-200">{activeHealthCounts.evidence_repair}</div><div className="text-[11px] text-slate-500">資料待修</div></div>
                  <div className="rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2"><div className="font-mono text-lg text-amber-200">{activeHealthCounts.performance_cooldown}</div><div className="text-[11px] text-slate-500">績效降溫</div></div>
                </div>
              </div>
              <div className="mt-3 grid gap-2 text-xs leading-5 text-slate-400 md:grid-cols-3">
                <p><span className="font-semibold text-rose-200">資料待修：</span>重建 decision／PIT reference／reward join；這類才應進自動修復 queue。</p>
                <p><span className="font-semibold text-cyan-200">證據累積：</span>維持選股與評估，等 T+5、樣本數與成熟交易日自然增加，不用人工放行。</p>
                <p><span className="font-semibold text-amber-200">績效降溫：</span>勝率、扣成本報酬、回撤或 LCB90 真的不合格；保留研究資料，但待買權重維持 0，交由一進一出替換流程處理。</p>
              </div>
            </section>

            {error && <div className="rounded-xl border border-rose-400/25 bg-rose-400/[0.06] p-4 text-sm text-rose-200">{error}</div>}
            {notice && <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-4 text-sm text-amber-100">{notice}</div>}
            {result && <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] p-4 text-sm text-emerald-200">{result}</div>}

            <div className="grid gap-4 xl:grid-cols-2 xl:items-start">
              <StrategyLedgerGroup
                title="正式選股策略"
                description="Registry 狀態為 active 的選股參與者。待買相對權重是另一份執行資格政策；0% 不會停止推薦、標籤或報酬證據累積。"
                rows={activeRows}
                gateById={gateById}
                policyWeights={policy?.strategy_weights ?? {}}
                replacementGate={learning?.replacement_gate ?? null}
                requestedDate={learning?.date ?? null}
                empty="目前沒有 active strategy reward rows。"
              />
              <StrategyLedgerGroup
                title="研究、影子與候選策略"
                description="研究、影子與候選策略跟正式策略共用同一條推薦／評估資料流；52% 勝率只管候選升級，不阻斷證據累積。"
                rows={learningRows}
                gateById={gateById}
                policyWeights={policy?.strategy_weights ?? {}}
                replacementGate={learning?.replacement_gate ?? null}
                requestedDate={learning?.date ?? null}
                empty="目前沒有 learning、shadow 或 candidate strategy rows。"
              />
            </div>

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
