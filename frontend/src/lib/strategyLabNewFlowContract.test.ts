import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = process.cwd()
const appPath = path.join(root, 'src', 'App.tsx')
const pagePath = path.join(root, 'src', 'pages', 'StrategyLearningPage.tsx')
const apiPath = path.join(root, 'src', 'lib', 'api.ts')

assert(fs.existsSync(pagePath), 'Strategy Lab should have a dedicated Learning + Reward Ledger page')

const app = fs.readFileSync(appPath, 'utf8')
const page = fs.readFileSync(pagePath, 'utf8')
const api = fs.readFileSync(apiPath, 'utf8')

assert(app.includes("import('./pages/StrategyLearningPage')"), '/strategy-lab should route to the focused learning page')
assert(page.includes('策略學習與報酬帳本'), 'Strategy Lab should expose the production learning and reward-ledger mission')
assert(page.includes('StrategyHealthBoard'), 'Strategy Lab should expose an always-visible strategy health board')
assert(page.includes('StrategyLineageInspector'), 'Strategy Lab should expose a production lineage inspector')
assert(page.includes('ACTIVE_STRATEGY_HEALTH_SECTIONS') && page.includes('CANDIDATE_STRATEGY_HEALTH_SECTIONS') && page.includes('group.rows.length'), 'Health board must use lane-specific buckets and show each count')
assert(page.includes('STRATEGY_LIFECYCLE_LANES') && page.includes("key: 'active'") && page.includes("key: 'candidate'"), 'Health board must split Active from Candidate before applying health buckets')
const activeSections = page.slice(page.indexOf('const ACTIVE_STRATEGY_HEALTH_SECTIONS'), page.indexOf('const CANDIDATE_STRATEGY_HEALTH_SECTIONS'))
const candidateSections = page.slice(page.indexOf('const CANDIDATE_STRATEGY_HEALTH_SECTIONS'), page.indexOf('const STRATEGY_HEALTH_SECTIONS_BY_LANE'))
assert(activeSections.includes("key: 'performance_cooldown'") && activeSections.includes('formal contribution = 0') && !activeSections.includes("key: 'promotion_pending'"), 'Active must route zero formal contribution to performance cooldown and never show promotion pending')
assert(candidateSections.includes("key: 'promotion_pending'") && !candidateSections.includes("key: 'performance_cooldown'"), 'Only Candidate may expose promotion pending')
assert(candidateSections.includes("key: 'prefilter_failed'") && page.includes("String(gate.activation_gate.status) === 'prefilter_failed'"), 'Candidate prefilter failure must have its own bucket instead of promotion pending')
assert(page.includes('strategyLifecycleLane(row) === lane.key') && page.includes('xl:grid-cols-2'), 'Active and Candidate lanes must stay in visible left/right columns')
assert(page.includes('沒有額外的 Shadow 策略 stage'), 'Candidate must be the evidence accumulation lifecycle state')
assert(page.includes('rows={orderedRows}'), 'Health board must render every non-retired strategy without a hidden filter')
assert(!page.includes('StrategyViewFilter') && !page.includes('queueRows'), 'The old filtered queue must not hide strategy rows')
assert(page.includes("row.status !== 'retired'"), 'Retired strategies should stay outside the workspace')
assert(page.includes('rows={[selectedRow]}'), 'The evidence workspace must render one selected strategy instead of every card at once')
assert(page.includes('xl:grid-cols-[minmax(0,10fr)_minmax(0,7fr)_minmax(0,3fr)]'), 'Desktop workspace, stage transition, and lineage inspector must use the requested 5:3.5:1.5 ratio')
assert(page.includes('共用 hard gate 只管資料可比性與成熟度'), 'Stage transition must disclose the common maturity-only gate role')
assert(page.includes('sv-readable-card-content rounded-2xl') && page.includes('<h2 className="truncate text-[15px] font-bold text-slate-100">Stage transition</h2>'), 'Stage transition must use the homepage 15px bold title role and readable body typography')
assert(page.includes('共用成熟度門檻') && page.includes('觀察指標（不判定通過／失敗）'), 'Hard gates and diagnostics must render as separate semantic groups')
assert(page.includes('Active 權重輸入 · 非門檻') && page.includes('僅供診斷 · 非門檻'), 'Diagnostic values must state their non-gating role')
assert(!page.includes("if (pass == null) return '待累積'") && !page.includes('不設共用 hard gate'), 'Diagnostic metrics must not inherit a pending gate label')
assert(page.includes('不代表每天或每筆交易都不會出現負報酬'), 'LCB90 copy must describe an average-confidence statistic rather than impossible loss prevention')
assert(page.includes('不是單一股票一天的漲跌幅'), 'MDD copy must distinguish the date-portfolio alpha curve from a single-stock daily limit move')
assert(page.includes('Atomic V7 相對替換'), 'Candidate activation must expose the practical paired replacement gate')
assert(page.indexOf('<StrategyStageTransitionCard') < page.indexOf('<StrategyLineageInspector'), 'Stage transition must sit between the strategy workspace and lineage inspector')
assert(page.indexOf('formalPolicyWeight == null') > page.indexOf('missing.length ? missing'), 'Formal pending-buy contribution must follow the current gate result in the inspector')
assert(page.includes('className="grid grid-cols-1 gap-px bg-slate-900"'), 'A single selected strategy must fill the complete ledger workspace')
assert(page.includes('aria-pressed={selected}') && page.includes('focus-visible:ring-2'), 'Strategy selectors must expose selection state and keyboard focus')
assert(!page.includes('正式策略健康分流詳情'), 'Strategy health routing must stay visible without a disclosure arrow')
assert(!page.includes('xl:grid-cols-2 xl:items-start'), 'The old all-strategies two-column wall must not return')
assert(page.includes('row.learning.today_matched'), 'strategy cards must expose daily matched count instead of forcing users to infer it from reward or policy fields')
assert(page.includes('strategyLabApi.learning()'), 'The focused page should load the canonical reward ledger response')
assert(page.includes('Promise.allSettled') && page.includes('strategyLabApi.specs()') && page.includes('strategyLabApi.evidenceProfiles()'), 'Strategy Lab must load all three production read models without making one failure erase the others')
assert(page.includes('registryLearningRow'), 'Strategy Lab must keep registry rows visible when the reward-ledger endpoint is unavailable')
assert(!page.includes("reason.includes('missing')"), 'Strategy health routing must not treat every metric name containing missing as a broken data pipeline')
assert(page.includes("row.learning.reward_state === 'no_matches'") && page.includes("row.learning.reward_state === 'reward_join_missing'"), 'No-match accumulation and true reward-join repair must remain distinct')
assert(page.includes('gate.strategy_id') && page.includes('profile.strategy_id') && page.includes('strategy_version'), 'All joins must preserve exact id:version identity')
assert(!page.includes('StrategyLifecycleSwimlane'), 'The focused page should not repeat lifecycle experiment navigation')
assert(!page.includes('MetaLearningDecisionDesk'), 'The focused page should not repeat meta-learning experiment controls')
assert(!page.includes('ModelUpgradeLaunchpad'), 'Model research controls belong in Model Pool, not the reward ledger page')
assert(!page.includes('Pre-trade Spec + Dry-run'), 'Strategy Lab should not repeat pre-trade spec/dry-run UI')
assert(page.includes('previewPolicy?.evidence.production_effect') && page.includes('不是 formal production policy'), 'Adaptive preview must be labeled diagnostic and must not impersonate formal policy')
assert(page.includes('currentDecisionPending'), 'Strategy cards must distinguish a not-yet-produced day from a real 0/0/0 decision batch')
assert(page.includes('StrategyGateDetails'), 'Selected strategy must retain its own readiness thresholds and evidence')
assert(page.includes('replacement_gate'), 'Strategy cards must consume canonical replacement evidence from the API')
assert(page.includes('AtomicReplacementSummary'), 'Cross-family replacement must remain available once in governance details')
assert(page.includes('gate?.allocation_eligible === true && formalWeight != null && formalWeight > 0'), 'Pending-buy health requires both the allocation gate and a positive formal weight')
assert(page.includes('formal_policy_lineage') && page.includes('formalPolicyWeights') && page.includes("formalPolicy ? executionEligibleCount : '-'"), 'Formal lineage must own weight display and execution-eligible counts, failing closed when unavailable')
assert(page.includes('const formalPolicy = strategyLanes?.formal.production_effect === true') && page.includes('const formalPolicy = lanes?.formal.production_effect === true'), 'Formal weights and inspector must require both production effect and formal lineage')
assert(page.includes('正式 contribution') && page.includes('Preview weight（診斷）'), 'Formal and preview weights must be visibly separate')
assert(page.includes('activationGateStatusLabel') && page.includes("return 'not-evaluated'") && page.includes('activationGatePass'), 'Activation state must preserve proposed/rejected/accepted and expose no evaluation explicitly')
assert(!page.includes("status === 'pending'") && page.includes("status === 'prefilter_failed'") && page.includes("status === 'not_evaluated'"), 'Activation helpers must use explicit evidence/prefilter/evaluation states and reject generic pending')
const activationGateType = api.slice(api.indexOf('activation_gate:'), api.indexOf('missing_evidence:', api.indexOf('activation_gate:')))
assert(!activationGateType.includes("| 'pending'") && activationGateType.includes("'evidence_pending'") && activationGateType.includes("'prefilter_failed'") && activationGateType.includes("'not_evaluated'"), 'Activation API union must not expose generic pending')
assert(page.includes('Pair verdict：not-evaluated') && !page.includes("value: gate.activation_gate.status === 'accepted' ? 'accepted' : 'pending'"), 'Missing pairs and non-accepted decisions must not collapse into generic pending')
assert(page.includes('full_portfolio_positive_cost_net_lcb95_hac') && page.includes('full_portfolio_absolute_cost_net_lcb95_hac') && !page.includes('full_portfolio_positive_cost_net_lcb)'), 'Full-portfolio paired and absolute cost-net gates must use the distinct V7 LCB95 HAC keys')
assert(page.includes('Full portfolio MDD baseline / final') && page.includes('Full portfolio turnover baseline / final') && page.includes('Full portfolio return correlation'), 'Full-portfolio firewall must expose risk actuals against their targets')
assert(page.includes('Holm-accepted replacement exists') && page.includes('Atomic one-in-one-out contract') && page.includes('Full portfolio all gates'), 'Full-portfolio firewall must expose statistical, atomic-cutover, and composite verdicts')
assert(api.includes('candidate_prefilters') && page.includes('candidatePrefilters'), 'Atomic V7 must project and consume Candidate prefilter evidence')
assert(page.includes('Candidate prefilter actual / target / pass') && page.includes('prefilter-failed') && page.includes('不會把它誤標成 pending pair'), 'Candidate prefilter must expose explicit pass/fail/no-evidence states')
assert(page.includes("const evidenceReady = prefilter.evidence_status === 'ready'") && page.includes('prefilter.production_eligible === false') && page.includes('evidence-missing（持續累積）'), 'Missing Candidate prefilter evidence must remain pending/missing; only ready plus production_eligible=false may fail')
assert(!page.includes("prefilter.production_eligible ? 'prefilter-pass' : 'prefilter-failed'"), 'Nullable Candidate eligibility must not collapse missing evidence into prefilter failure')
assert(page.includes('Candidate observation dates') && page.includes('Candidate marginal-edge LCB90') && page.includes('Candidate absolute hit-return mean'), 'Candidate prefilter must render every actual against its versioned target')
for (const field of [
  'effective_paired_dates',
  'paired_delta_hac_standard_error',
  'paired_delta_lcb95_hac',
  'paired_delta_one_sided_p_value',
  'paired_delta_power_at_minimum_economic_delta',
  'candidate_absolute_cost_net_lcb95_hac',
  'holm_local_alpha',
  'holm_adjusted_p_value',
  'holm_rejected',
]) {
  assert(api.includes(field) && page.includes(field), 'Atomic V7 field must be typed and rendered: ' + field)
}
assert(page.includes('MDD Candidate / incumbent') && page.includes('Turnover Candidate / incumbent') && page.includes('Return correlation'), 'Pair inspector must render Candidate/incumbent risk comparisons')
assert(page.includes('actual / target / pass') && page.includes('GateMetric key={metric.label}'), 'Atomic inspector must expose actual, target, and pass for run and pair metrics')
assert(page.includes('materializeDecisionLog') && page.includes('refreshStrategyRewardLedger') && page.includes('refreshStrategyPolicyState'), 'Operational actions must survive the readability refactor')

console.log('strategyLabNewFlowContract: OK')
