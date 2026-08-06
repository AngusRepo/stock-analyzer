import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import AppShell from '@/components/AppShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { strategyLabApi, type StrategyLearningResponse, type StrategyPromotionGate, type StrategyReplacementDecisionSummary, type StrategyReplacementGateSummary, type StrategySpec } from '@/lib/api'

type LearningRow = StrategyLearningResponse['specs'][number]

function pct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return 'Unavailable'
  return `${(Number(value) * 100).toFixed(1)}%`
}
function rewardMetric(value: number | null | undefined, unit: 'return_fraction' | 'r_multiple'): string {
  if (value == null || !Number.isFinite(Number(value))) return 'Unavailable'
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
  if (pass == null) return 'PENDING'
  return pass ? 'PASS' : 'FAIL'
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
  value,
  target,
  pass,
}: {
  label: string
  value: string
  target: string
  pass: boolean | null
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 border-b border-slate-800/60 py-1 last:border-0">
      <span className="truncate text-slate-500">{label}</span>
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
  const isS12ExecutionOwner = row.learning.reward_owner === 's12_execution_replay_v3_net'
  const decision = paired?.decision ?? null
  const policy = replacementGate?.policy ?? null
  const run = replacementGate?.latest_run ?? null
  const mddPass = evidence.max_drawdown_pct == null ? null : evidence.max_drawdown_pct >= thresholds.min_max_drawdown
  const readiness = [
    { label: 'Evaluable decisions', value: String(evidence.decisions), target: `>= ${thresholds.min_evaluable_decisions}`, pass: evidence.decisions >= thresholds.min_evaluable_decisions },
    { label: 'Setup match rate', value: pct(evidence.match_rate), target: `>= ${pct(thresholds.min_match_rate)}`, pass: evidence.match_rate == null ? null : evidence.match_rate >= thresholds.min_match_rate },
    { label: 'Reward samples', value: String(evidence.samples), target: `>= ${thresholds.min_reward_samples}`, pass: evidence.samples >= thresholds.min_reward_samples },
    { label: 'Hit rate', value: pct(evidence.hit_rate), target: `>= ${pct(thresholds.min_hit_rate)}`, pass: evidence.hit_rate == null ? null : evidence.hit_rate >= thresholds.min_hit_rate },
    { label: 'Cost-net average', value: rewardMetric(evidence.avg_return_pct, row.learning.reward_unit), target: '> 0', pass: evidence.avg_return_pct == null ? null : evidence.avg_return_pct > thresholds.min_avg_cost_net_return_exclusive },
    { label: 'Date LCB90', value: rewardMetric(evidence.date_return_lcb90, row.learning.reward_unit), target: '> 0', pass: evidence.date_return_lcb90 == null ? null : evidence.date_return_lcb90 > thresholds.min_date_return_lcb90_exclusive },
    { label: 'Max drawdown', value: rewardMetric(evidence.max_drawdown_pct, row.learning.reward_unit), target: `>= ${rewardMetric(thresholds.min_max_drawdown, row.learning.reward_unit)}`, pass: mddPass },
    { label: 'Mature dates', value: String(evidence.mature_dates), target: `>= ${thresholds.min_mature_dates}`, pass: evidence.mature_dates >= thresholds.min_mature_dates },
  ]

  let pairMetrics: Array<{ label: string; value: string; target: string; pass: boolean | null }> = []
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
      { label: 'Paired dates', value: String(decision.paired_dates), target: `>= ${policy.min_paired_dates}`, pass: decision.paired_dates >= policy.min_paired_dates },
      { label: 'Residual delta LCB90', value: pct(decision.paired_delta_lcb90), target: '> 0', pass: decision.paired_delta_lcb90 == null ? null : decision.paired_delta_lcb90 > policy.min_paired_delta_lcb90_exclusive },
      { label: 'Candidate cost-net mean', value: pct(decision.candidate_absolute_cost_net_mean), target: '> 0', pass: decision.candidate_absolute_cost_net_mean == null ? null : decision.candidate_absolute_cost_net_mean > policy.min_candidate_absolute_cost_net_mean_exclusive },
      { label: 'MDD vs incumbent', value: `${pct(decision.candidate_max_drawdown)} / ${pct(decision.incumbent_max_drawdown)}`, target: `within ${pct(policy.max_drawdown_degradation)}`, pass: pairMddPass },
      { label: 'Turnover vs incumbent', value: `${pct(decision.candidate_turnover)} / ${pct(decision.incumbent_turnover)}`, target: `within ${pct(policy.max_turnover_increase)}`, pass: pairTurnoverPass },
      { label: 'Return correlation', value: decision.return_correlation == null ? 'Unavailable' : decision.return_correlation.toFixed(3), target: `<= ${policy.max_duplicate_return_correlation.toFixed(2)} or risk improves`, pass: pairCorrelationPass },
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
          <span className="font-semibold text-slate-300">Candidate readiness thresholds</span>
          <span className="text-slate-500">rolling evidence</span>
        </div>
        <div className="grid gap-x-4 md:grid-cols-2">
          {readiness.map((item) => <GateMetric key={item.label} {...item} />)}
        </div>
      </div>

      <div className="border-t border-slate-800 pt-3">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-slate-300">Atomic replacement thresholds</span>
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
            No paired proposal for this strategy in the latest V6 run. Required: {policy.min_paired_dates}+ paired dates, residual LCB90 &gt; 0, cost-net mean &gt; 0, MDD within {pct(policy.max_drawdown_degradation)}, turnover within {pct(policy.max_turnover_increase)}, and correlation &le; {policy.max_duplicate_return_correlation.toFixed(2)} unless risk improves. Cross-family replacement also requires every full-portfolio gate to pass.
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
          const paired = bestReplacementDecision(row, replacementGate)
          const evidence = gate?.missing_evidence ?? []
          const evidenceLabels = gate ? (evidence.length ? evidence : ['evidence ready']) : ['reward ledger unavailable']
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
                  <Badge variant="outline" className={statusClass(row.status)}>{row.status}</Badge>
                  <Badge variant="outline" className={statusClass(row.learning.status)}>{row.learning.status}</Badge>
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
                  <dt className="text-xs text-slate-500">Lifetime rewards</dt>
                  <dd className={`mt-1 font-mono text-sm ${rewardMissing ? 'text-rose-300' : rewardPending || noMatches ? 'text-amber-200' : 'text-slate-200'}`}>{row.learning.evidence_available ? rewardCount : '-'}</dd>
                  <div className="mt-1 text-xs leading-4 text-slate-500">{row.learning.reward_status_reason}</div>
                </div>
                <div className="rounded-lg border border-slate-800/80 bg-slate-900/45 p-2">
                  <dt className="text-xs text-slate-500">Rolling mature dates</dt>
                  <dd className="mt-1 font-mono text-sm text-cyan-200">{row.learning.evidence_available ? rollingMature : '-'}</dd>
                  <div className={`mt-1 text-xs ${signedClass(row.learning.rolling_date_return_lcb90)}`}>{row.learning.evidence_available ? rewardPending || rewardMissing || noMatches ? rollingMature : <>LCB90 {rewardMetric(row.learning.rolling_date_return_lcb90, row.learning.reward_unit)}</> : 'Unavailable'}</div>
                </div>
                <div className="rounded-lg border border-slate-800/80 bg-slate-900/45 p-2"><dt className="text-xs text-slate-500">Rolling hit / avg</dt><dd className="mt-1 font-mono text-sm text-slate-300">{rewardPending || rewardMissing || noMatches ? rollingMature : <>{pct(row.learning.rolling_hit_rate)} / <span className={signedClass(row.learning.rolling_avg_return_pct)}>{rewardMetric(row.learning.rolling_avg_return_pct, row.learning.reward_unit)}</span></>}</dd></div>
                <div className="rounded-lg border border-slate-800/80 bg-slate-900/45 p-2"><dt className="text-xs text-slate-500">Rolling MDD</dt><dd className={`mt-1 font-mono text-sm ${signedClass(row.learning.rolling_max_drawdown_pct)}`}>{rewardPending || rewardMissing || noMatches ? rollingMature : rewardMetric(row.learning.rolling_max_drawdown_pct, row.learning.reward_unit)}</dd></div>
              </dl>

              <div className="grid gap-3">
                <div className="rounded-xl border border-slate-800 bg-slate-900/35 p-3">
                  <div className="flex justify-between gap-3 text-xs text-slate-500"><span>Policy weight</span><span className="font-mono text-slate-300">{hasWeight ? pct(weight) : 'Not allocated'}</span></div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
                    <div className="h-full bg-emerald-300" style={{ width: `${hasWeight ? Math.max(0, Math.min(100, weight * 100)) : 0}%` }} />
                  </div>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-900/35 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={statusClass(gate?.decision ?? 'ledger_pending')}>{gate?.decision ?? 'ledger pending'}</Badge>
                    <span className="text-xs text-slate-500">{gate?.current_stage ?? 'stage unavailable'} &rarr; {gate?.recommended_stage ?? gate?.recommended_next_status ?? 'reward gate unavailable'}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {evidenceLabels.slice(0, 3).map((item) => (
                      <span key={item} className={`rounded-md border px-2 py-1 text-xs ${evidence.length ? 'border-amber-400/20 bg-amber-400/[0.06] text-amber-200' : gate ? 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-200' : 'border-slate-600/40 bg-slate-800/50 text-slate-400'}`}>{item.replace(/_/g, ' ')}</span>
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
  const totals = useMemo(() => visibleRows.reduce((acc, row) => ({ decisions: acc.decisions + row.learning.decisions, samples: acc.samples + row.learning.samples }), { decisions: 0, samples: 0 }), [visibleRows])
  const policy = learning?.policy_state_preview

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
            <p className="text-xs font-semibold tracking-[0.14em] text-emerald-300">STRATEGY LEARNING</p>
            <h1 className="mt-2 flex items-center gap-2 font-['Space_Grotesk'] text-2xl font-semibold tracking-tight text-slate-50"><Activity className="h-5 w-5 text-emerald-300" /> Learning + Reward Ledger</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">只保留後驗學習、reward evidence、shadow policy weight 與 promotion readiness；不在此頁重複實驗、模型或 dry-run 操作。</p>
          </div>
          <Button size="sm" variant="outline" className="rounded-full border-emerald-400/25 text-emerald-200" disabled={refreshing} onClick={() => { setRefreshing(true); void load() }}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Refresh ledger
          </Button>
        </header>

        {loading ? (
          <div className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/70 p-5 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading reward ledger...</div>
        ) : (
          <>
            <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><div className="text-xs text-slate-500">Active strategies</div><div className="mt-2 font-mono text-2xl text-emerald-200">{activeRows.length}</div></div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><div className="text-xs text-slate-500">Learning + shadowing</div><div className="mt-2 font-mono text-2xl text-cyan-200">{learningRows.length}</div></div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><div className="text-xs text-slate-500">Lifetime decision / reward rows</div><div className="mt-2 font-mono text-2xl text-slate-100">{learning ? totals.decisions : '-'} / {learning ? totals.samples : '-'}</div></div>
              <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] p-4"><div className="text-xs text-slate-400">Adaptive policy</div><div className="mt-2 flex items-center gap-2 font-mono text-lg text-emerald-100"><ShieldCheck className="h-4 w-4" /> {policy?.status ?? 'unavailable'}</div><div className="mt-1 text-xs text-slate-500">{learning ? policy?.evidence.production_effect ? `production active · owner ${policy.evidence.threshold_owner}` : 'shadow only · no production effect' : 'ledger unavailable'}</div></div>
            </section>

            {error && <div className="rounded-xl border border-rose-400/25 bg-rose-400/[0.06] p-4 text-sm text-rose-200">{error}</div>}
            {notice && <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-4 text-sm text-amber-100">{notice}</div>}
            {result && <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] p-4 text-sm text-emerald-200">{result}</div>}

            <div className="grid gap-4 xl:grid-cols-2 xl:items-start">
              <StrategyLedgerGroup
                title="Active strategies"
                description="目前 production active 的策略。Reward ledger 用來監控已上線策略，不在此頁改變 production allocation。"
                rows={activeRows}
                gateById={gateById}
                policyWeights={policy?.strategy_weights ?? {}}
                replacementGate={learning?.replacement_gate ?? null}
                requestedDate={learning?.date ?? null}
                empty="目前沒有 active strategy reward rows。"
              />
              <StrategyLedgerGroup
                title="Learning + shadowing strategies"
                description="Research、shadow 與 candidate 策略集中在這裡，依 reward samples 與 evidence gap 決定是否繼續學習。"
                rows={learningRows}
                gateById={gateById}
                policyWeights={policy?.strategy_weights ?? {}}
                replacementGate={learning?.replacement_gate ?? null}
                requestedDate={learning?.date ?? null}
                empty="目前沒有 learning、shadow 或 candidate strategy rows。"
              />
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <p className="max-w-2xl text-xs leading-5 text-slate-500">Decision log → verify/paper outcome → reward ledger → Adaptive strategy policy。自動效果只限策略權重與門檻；不直接下單，也不改模型 vote。</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void runAction('decision log', () => strategyLabApi.materializeDecisionLog({ limit: 500, dry_run: false, confirm: true }), 'Decision log 已更新。')}>Materialize decision log</Button>
                <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void runAction('reward ledger', () => strategyLabApi.refreshStrategyRewardLedger({ limit: 5000, dry_run: false, confirm: true }), 'Reward ledger 已更新。')}>Refresh reward ledger</Button>
                <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void runAction('adaptive policy', () => strategyLabApi.refreshStrategyPolicyState({ dry_run: false, confirm: true }), 'Adaptive strategy policy 已更新。')}>Refresh adaptive policy</Button>
              </div>
            </footer>
          </>
        )}
      </main>
    </AppShell>
  )
}
