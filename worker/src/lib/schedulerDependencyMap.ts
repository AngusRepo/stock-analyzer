export type SchedulerConsolidationClass =
  | 'keep_scheduler'
  | 'merge_into_chain'
  | 'downstream_evidence'
  | 'manual_maintenance_candidate'
  | 'disable_candidate'

export interface SchedulerDependencySpec {
  task: string
  owner: 'gcp_scheduler' | 'worker_chain' | 'controller_chain' | 'manual_only'
  consolidationClass: SchedulerConsolidationClass
  currentFunction: string
  replacementOwner?: string
  upstream: string[]
  downstream: string[]
  requiredBeforeDisable: string[]
  operatorRisk: 'low' | 'medium' | 'high'
  recommendation: string
}

export const SCHEDULER_DEPENDENCY_MAP: Record<string, SchedulerDependencySpec> = {
  'evening-chain': {
    task: 'evening-chain',
    owner: 'gcp_scheduler',
    consolidationClass: 'keep_scheduler',
    currentFunction: 'Post-market root chain: update -> indicators -> screener -> regime -> pipeline, then callback chains.',
    upstream: [],
    downstream: ['indicator-queue', 'screener', 'regime-compute', 'pipeline', 'post-pipeline-chain', 'post-verify-chain'],
    requiredBeforeDisable: [],
    operatorRisk: 'high',
    recommendation: 'Keep as the single post-market root scheduler.',
  },
  'morning-setup': {
    task: 'morning-setup',
    owner: 'gcp_scheduler',
    consolidationClass: 'keep_scheduler',
    currentFunction: 'Settles T2 state, warms up control plane, creates debate/pending-buy candidates.',
    upstream: ['recommendation'],
    downstream: ['pre-market-warmup', 'intraday-check'],
    requiredBeforeDisable: [],
    operatorRisk: 'high',
    recommendation: 'Keep; this owns the morning pending-buy creation boundary.',
  },
  'morning-briefing': {
    task: 'morning-briefing',
    owner: 'gcp_scheduler',
    consolidationClass: 'keep_scheduler',
    currentFunction: 'Generates morning briefing/report from recommendation, news, US-leading, and account state.',
    upstream: ['us-leading', 'news-analyst', 'morning-setup'],
    downstream: ['notification-report'],
    requiredBeforeDisable: [],
    operatorRisk: 'medium',
    recommendation: 'Keep user-facing briefing output, but absorb news/us-leading as upstream evidence steps.',
  },
  'pre-market-warmup': {
    task: 'pre-market-warmup',
    owner: 'gcp_scheduler',
    consolidationClass: 'merge_into_chain',
    currentFunction: 'Runs control-plane warmup, reconciles pending-buy debates, and summarizes pre-market state.',
    replacementOwner: 'morning chain / pre-open quote sanity chain',
    upstream: ['morning-setup'],
    downstream: ['intraday-check'],
    requiredBeforeDisable: [
      'morning chain must reconcile pending-buy debates',
      'intraday-check must fail-close when quote sanity/restricted gate is missing',
      'Scheduler UI must show pre-open finalize as a chain step',
    ],
    operatorRisk: 'high',
    recommendation: 'Do not delete first; convert into a pre-open chain step after parity tests pass.',
  },
  'daily-snapshot': {
    task: 'daily-snapshot',
    owner: 'gcp_scheduler',
    consolidationClass: 'merge_into_chain',
    currentFunction: 'Writes paper account, position, PnL, Sharpe/MDD source snapshot.',
    replacementOwner: 'post-market / EOD chain',
    upstream: ['eod-exit'],
    downstream: ['risk-triggers', 'dashboard-performance', 'daily-report'],
    requiredBeforeDisable: [
      'post-market chain must write paper_daily_snapshots',
      'MDD/Sharpe/risk trigger readback must pass after chain run',
      'dashboard performance metrics must read the new chain-owned snapshot',
    ],
    operatorRisk: 'high',
    recommendation: 'Merge into post-market/EOD chain only after account metric parity is verified.',
  },
  'us-leading': {
    task: 'us-leading',
    owner: 'gcp_scheduler',
    consolidationClass: 'downstream_evidence',
    currentFunction: 'Fetches US/SOX/futures leading signal for pre-market context.',
    replacementOwner: 'morning-briefing upstream evidence step',
    upstream: [],
    downstream: ['morning-briefing', 'morning-setup-context'],
    requiredBeforeDisable: [
      'morning briefing must fetch or read latest US-leading signal',
      'stale US-leading signal must be visible in briefing diagnostics',
    ],
    operatorRisk: 'medium',
    recommendation: 'Move under morning briefing context builder; keep manual trigger for debugging.',
  },
  'news-analyst': {
    task: 'news-analyst',
    owner: 'gcp_scheduler',
    consolidationClass: 'downstream_evidence',
    currentFunction: 'Generates daily news bias/confidence/key factors.',
    replacementOwner: 'news queue / morning-briefing upstream evidence step',
    upstream: ['news-ingestion'],
    downstream: ['morning-briefing', 'recommendation-context'],
    requiredBeforeDisable: [
      'news queue or morning briefing must own report generation',
      'recommendation must degrade clearly when news evidence is stale',
    ],
    operatorRisk: 'medium',
    recommendation: 'Move into news queue or briefing chain; avoid separate scheduler if it only produces context.',
  },
  'weekly-audit': {
    task: 'weekly-audit',
    owner: 'gcp_scheduler',
    consolidationClass: 'merge_into_chain',
    currentFunction: 'Calls ml-controller weekly audit and optionally sends Discord report.',
    replacementOwner: 'weekly validation summary',
    upstream: ['weekly-backtest', 'alpha-quality', 'model-ic-tracker'],
    downstream: ['weekly-report'],
    requiredBeforeDisable: [
      'weekly validation summary must include audit report fields',
      'Discord/LINE delivery must use the new summary owner',
    ],
    operatorRisk: 'medium',
    recommendation: 'Merge into a single weekly validation summary report.',
  },
  'alpha-quality': {
    task: 'alpha-quality',
    owner: 'gcp_scheduler',
    consolidationClass: 'merge_into_chain',
    currentFunction: 'Checks alpha bucket/regime quality from config_pool outcomes.',
    replacementOwner: 'weekly validation summary',
    upstream: ['verified-outcomes', 'trading-config'],
    downstream: ['weekly-report', 'adaptive-meta-review'],
    requiredBeforeDisable: [
      'weekly validation summary must run alpha-quality and persist its evidence',
      'OBS must show alpha-quality stale/missing evidence if the weekly chain fails',
    ],
    operatorRisk: 'medium',
    recommendation: 'Merge with weekly backtest/MC/PBO because all are validation evidence.',
  },
  'sector-leaders': {
    task: 'sector-leaders',
    owner: 'gcp_scheduler',
    consolidationClass: 'downstream_evidence',
    currentFunction: 'Computes sector leaders/correlation rotation evidence from D1.',
    replacementOwner: 'screener/evening-chain evidence builder',
    upstream: ['market-data-update', 'sector-tags'],
    downstream: ['screener', 'dashboard-sector-flow'],
    requiredBeforeDisable: [
      'screener/evening-chain must compute or refresh sector leaders',
      'dashboard sector-flow freshness must point to the new owner',
    ],
    operatorRisk: 'medium',
    recommendation: 'Move to screener/evening-chain evidence path; sector data should refresh with market data.',
  },
  'model-ic-tracker': {
    task: 'model-ic-tracker',
    owner: 'gcp_scheduler',
    consolidationClass: 'merge_into_chain',
    currentFunction: 'Runs rolling IC/live-gate refresh after verify; also has a Friday standalone full check.',
    replacementOwner: 'post-verify chain',
    upstream: ['verify-v2'],
    downstream: ['adapt', 'live-gate', 'model-registry'],
    requiredBeforeDisable: [
      'post-verify chain must run model IC tracker every trading day',
      'Friday full-check behavior must be expressible as a manual/admin trigger or weekly validation step',
    ],
    operatorRisk: 'high',
    recommendation: 'Make post-verify chain the owner; keep Friday scheduler only until IC readback proves stable.',
  },
  'paper-active-postmarket': {
    task: 'paper-active-postmarket',
    owner: 'worker_chain',
    consolidationClass: 'downstream_evidence',
    currentFunction: 'Persists paper-active challenger promotion packets and audit rows after verify/daily report.',
    replacementOwner: 'post-verify chain',
    upstream: ['verify-v2', 'model-ic-tracker', 'daily-report'],
    downstream: ['obsidian-sync', 'scheduler-dashboard', 'promotion-review'],
    requiredBeforeDisable: [
      'post-verify chain must run paper-active-postmarket after daily-report',
      'promotion audit rows and scheduler logs must be visible in OBS/dashboard',
      'paper-active promotion must remain non-critical and must not write orders or real trading state',
    ],
    operatorRisk: 'medium',
    recommendation: 'Keep non-critical in post-verify chain; it must never write orders or real trading state.',
  },
  'weekly-cleanup': {
    task: 'weekly-cleanup',
    owner: 'gcp_scheduler',
    consolidationClass: 'manual_maintenance_candidate',
    currentFunction: 'Runs local cleanup, lifecycle dry-run/audit, and weekly local maintenance.',
    replacementOwner: 'manual maintenance + model registry/promotion controller',
    upstream: [],
    downstream: ['model-registry-maintenance'],
    requiredBeforeDisable: [
      'production lifecycle mutation must be owned by model registry/promotion controller',
      'cleanup must be idempotent and available as an admin/manual maintenance action',
      'no production metric may depend on weekly-cleanup as the only writer',
    ],
    operatorRisk: 'medium',
    recommendation: 'Keep weekly cleanup audit-only; production lifecycle side effects require explicit promotion-controller action.',
  },
  'optuna-queue': {
    task: 'optuna-queue',
    owner: 'gcp_scheduler',
    consolidationClass: 'disable_candidate',
    currentFunction: 'Polls KV every 6h, pops one pending Optuna item, and calls a controller endpoint.',
    replacementOwner: 'weekly/monthly optuna research_sweep or explicit manual queue drain',
    upstream: ['optuna-kv-queue'],
    downstream: ['optimizer-kv-candidate'],
    requiredBeforeDisable: [
      'weekly/monthly research_sweep must own normal Optuna/GA parameter search',
      'manual drain endpoint must remain available for exceptional queued items',
      'KV pending queue must be empty or intentionally archived',
    ],
    operatorRisk: 'low',
    recommendation: 'Disable scheduled polling after queue readback proves empty; keep manual drain only.',
  },
  'monthly-strategy-mining': {
    task: 'monthly-strategy-mining',
    owner: 'gcp_scheduler',
    consolidationClass: 'keep_scheduler',
    currentFunction: 'Monthly pymoo NSGA-III + novelty strategy mining preflight and research ledger trigger.',
    upstream: ['feature-registry-materialization', 'formal137-similarity-contract'],
    downstream: ['strategy_mining_runs', 'strategy_backtest_results', 'strategy_promotion_ledger', 'monthly-optuna', 'monthly-retrain'],
    requiredBeforeDisable: [],
    operatorRisk: 'medium',
    recommendation: 'Keep as the monthly strategy discovery owner; endpoint is research-only until promotion gates and Wei approval pass.',
  },
}

export function getSchedulerDependencySpec(task: string): SchedulerDependencySpec | undefined {
  return SCHEDULER_DEPENDENCY_MAP[task]
}

export function schedulerConsolidationCandidates(kind?: SchedulerConsolidationClass): SchedulerDependencySpec[] {
  const specs = Object.values(SCHEDULER_DEPENDENCY_MAP)
  return kind ? specs.filter((spec) => spec.consolidationClass === kind) : specs
}
