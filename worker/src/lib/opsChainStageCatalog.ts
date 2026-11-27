/**
 * Stage catalogs of the chains in ops_chain_stage_state_v1. Each chain's node set is exactly one
 * frontend ExecutionChainPanel SCOPES entry (columns + branches, unexpanded, plus its orchestrator
 * root), and `optional` is the NODES flag. chain_id = the scope label in snake_case.
 * Contract: audits/grafana-obs-eval-20261124/p2p3_contract.md.
 */
export const DAILY_READINESS_CHAIN_ID = 'daily_readiness'
export const INTRADAY_GUARD_CHAIN_ID = 'intraday_guard'
export const WEEKLY_RESEARCH_CHAIN_ID = 'weekly_research'
export const MONTHLY_ARTIFACT_CHAIN_ID = 'monthly_artifact'

/** Where a stage's state is written from. */
export type ChainStageWriteSource =
  /** logSchedulerRunResult(kv, <stage_id>, ...) — the generic scheduler run log. */
  | 'scheduler_run_log'
  /** FinLab phase telemetry callback (finlabStageProgress.ts): running + heartbeat only. */
  | 'finlab_progress'
  /** Pipeline phase telemetry callback (pipelineProgress.ts): running + Cloud Run execution_name. */
  | 'pipeline_progress'
  /** Derived from the `pipeline` run log, exactly as schedulerStatus.ts derives the child job. */
  | 'pipeline_derived'
  /** Premarket event chain stage claims (premarketEventChain.ts): running. */
  | 'premarket_event_chain'
  /** Evening-chain durable root closure (eveningChainRootClosure.ts): success / error. */
  | 'evening_root_closure'

/**
 * Which date a source reports for this stage. `business_date`: the source's run_date is the chain's
 * business date X. `trade_date`: the source runs on (and stamps) the next trading day T; the writer
 * maps T back to the chain X whose row was pre-created with an expected_by on T.
 */
export type ChainStageSourceDate = 'business_date' | 'trade_date'

/**
 * Deadline relative to the chain's business date X, in Taiwan time. `anchor: 'business_date'` counts
 * calendar days from X (an overnight stage finishing at 03:00 is dayOffset 1); `anchor:
 * 'next_trading_day'` counts calendar days from the next TW trading day after X (pre-market stages,
 * so Friday's chain expects Monday morning); `anchor: 'first_sunday_of_month'` counts from the first
 * Sunday of X's month (GCP "first sunday of month" jobs, which precede the first Saturday when the
 * 1st is a Sunday). null = no overdue judgement.
 */
export interface ChainStageExpectedBy {
  dayOffset: number
  tw: string
  anchor?: 'business_date' | 'next_trading_day' | 'first_sunday_of_month'
}

export interface ChainStageCatalogEntry {
  stageId: string
  label: string
  optional: boolean
  sources: readonly ChainStageWriteSource[]
  sourceDate: ChainStageSourceDate
  expectedBy: ChainStageExpectedBy | null
  /**
   * Runs many times per business date (intraday-check: every minute). One row per day: status is the
   * worst result of the day, the last result goes to summary, never running, never a heartbeat.
   */
  repeat?: boolean
  /**
   * A watcher guards a window instead of finishing a job (intraday-check: every minute 09:00–13:30).
   * Its expectedBy is the deadline of its first result; completed_at is its last result, so a
   * deadline-minus-completion margin means nothing. Readers judge overdue only while it has no
   * result yet (status pending), never give it an ETA margin, and still judge failed and stalled.
   */
  watcher?: boolean
}

const bd = (dayOffset: number, tw: string): ChainStageExpectedBy => ({ dayOffset, tw, anchor: 'business_date' })
const ntd = (tw: string): ChainStageExpectedBy => ({ dayOffset: 0, tw, anchor: 'next_trading_day' })

/**
 * Deadlines (Q3): the "建議截止" column of audits/grafana-obs-eval-20261124/expected_by_proposal.md
 * (latest normal completion over 11/17–11/24 plus a 20–30 min margin). Owner-confirmed 2026-11-25;
 * edit the numbers here only. T = business_date (bd(0, …)); T+1 = next TW trading
 * day (ntd(…), resolved with nextTwTradingDate at pre-create, never +1 calendar day). The four
 * premarket stages belong to T's chain but run on T+1 morning. Optional stages carry null.
 */
export const DAILY_READINESS_STAGE_CATALOG: readonly ChainStageCatalogEntry[] = [
  // columns
  { stageId: 'market-close-refresh', label: 'Close refresh', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '18:30') },
  { stageId: 'finlab-v4-backfill', label: 'FinLab canonical', optional: false, sources: ['scheduler_run_log', 'finlab_progress'], sourceDate: 'business_date', expectedBy: bd(0, '22:45') },
  { stageId: 'finlab-backfill-watchdog', label: 'FinLab watchdog', optional: true, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: null },
  { stageId: 'update', label: 'Market update', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '22:50') },
  { stageId: 'indicator-queue', label: 'Indicator queue', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '23:00') },
  { stageId: 'regime-compute', label: 'HMM regime', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '23:30') },
  { stageId: 'strategy-learning-mature-evidence', label: '成熟策略證據', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '23:15') },
  { stageId: 'screener', label: 'Screener', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '23:30') },
  { stageId: 'allocator-ev-readiness', label: 'Allocator EV', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '23:30') },
  { stageId: 'pipeline', label: 'Pipeline · 整體進度', optional: false, sources: ['scheduler_run_log', 'pipeline_progress'], sourceDate: 'business_date', expectedBy: ntd('08:00') },
  { stageId: 'ml-predict', label: 'ML Predict · L3 預測', optional: false, sources: ['pipeline_derived', 'scheduler_run_log'], sourceDate: 'business_date', expectedBy: ntd('08:00') },
  { stageId: 'post-pipeline-chain', label: 'Pipeline callback', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: ntd('14:45') },
  { stageId: 'allocator-ev-feature-snapshot-backfill', label: 'EV feature snapshot', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: ntd('14:45') },
  { stageId: 'verify-v2', label: 'Verify', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: ntd('14:45') },
  { stageId: 'post-verify-chain', label: 'Verify callback', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: ntd('15:00') },
  { stageId: 'model-ic-rolling', label: 'Model IC rolling', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: ntd('15:00') },
  { stageId: 'linucb-reward-ledger', label: 'Reward ledger', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: ntd('15:00') },
  { stageId: 'adapt', label: 'Adapt params', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: ntd('15:00') },
  { stageId: 'daily-report', label: 'Daily report', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: ntd('15:00') },
  { stageId: 'paper-active-postmarket', label: 'Paper active', optional: true, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: null },
  { stageId: 'obsidian-sync', label: 'Obsidian sync', optional: true, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: null },
  { stageId: 'meta-learning-shadow', label: 'Meta shadow', optional: true, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: null },
  { stageId: 'strategy-learning', label: 'Strategy learning', optional: true, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: null },
  { stageId: 'evening-closure', label: '全鏈完成收據', optional: false, sources: ['evening_root_closure'], sourceDate: 'business_date', expectedBy: ntd('15:30') },
  { stageId: 'us-leading', label: 'US leading', optional: false, sources: ['scheduler_run_log'], sourceDate: 'trade_date', expectedBy: ntd('07:00') },
  { stageId: 'news-analyst', label: 'News analyst', optional: false, sources: ['scheduler_run_log'], sourceDate: 'trade_date', expectedBy: ntd('07:15') },
  { stageId: 'morning-setup', label: 'Morning setup', optional: false, sources: ['scheduler_run_log', 'premarket_event_chain'], sourceDate: 'trade_date', expectedBy: ntd('08:50') },
  { stageId: 'recommendation', label: 'Recommendation · L4 推薦', optional: false, sources: ['pipeline_derived', 'scheduler_run_log'], sourceDate: 'business_date', expectedBy: ntd('08:00') },
  { stageId: 'pre-market-warmup', label: 'Pre-market', optional: false, sources: ['scheduler_run_log', 'premarket_event_chain'], sourceDate: 'trade_date', expectedBy: ntd('08:50') },
  // branches
  { stageId: 'premarket-evidence-watchdog', label: '盤前鏈監看', optional: true, sources: ['scheduler_run_log'], sourceDate: 'trade_date', expectedBy: null },
  { stageId: 'dataset-snapshot-export', label: 'Research snapshot', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: ntd('15:30') },
  { stageId: 'active8-oof-daily', label: 'Active-8 daily evidence', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: ntd('15:30') },
  { stageId: 'allocator-ev-lifecycle-watchdog', label: 'EV lifecycle', optional: true, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: null },
]

const sun = (dayOffset: number, tw: string): ChainStageExpectedBy => ({ dayOffset, tw, anchor: 'first_sunday_of_month' })

/**
 * Intraday guard: business_date = the trading date the stages run on. Deadlines are the scheduled
 * time plus a 10–20 min margin (infra/gcp-scheduler-jobs.json; 5 KV samples 11/18–11/24 all finish
 * within 10 s). Owner-confirmed 2026-11-25.
 */
export const INTRADAY_GUARD_STAGE_CATALOG: readonly ChainStageCatalogEntry[] = [
  // columns. intraday-check: two GCP jobs, every minute 09:00–13:30; a watcher, its deadline is the first result.
  { stageId: 'intraday-check', label: 'Intraday check', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '09:10'), repeat: true, watcher: true },
  { stageId: 'eod-exit', label: 'EOD exit', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '13:30') },
  { stageId: 'post-close-price-refresh', label: 'Close price', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '13:50') },
  // 14:20 run; the 18:25 settle re-run may turn a 14:20 refusal (error) into success.
  { stageId: 'daily-snapshot', label: 'Daily snapshot', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '14:40') },
  // branch: one GCP job (rescore-10, 10/11/12 UTC+8) plus rescore-1230; each slot logs its own task once a day.
  { stageId: 'rescore-10', label: '10:00 re-score', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '10:10') },
  { stageId: 'rescore-11', label: '11:00 re-score', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '11:10') },
  { stageId: 'rescore-12', label: '12:00 re-score', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '12:10') },
  { stageId: 'rescore-1230', label: '12:30 re-score', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '12:40') },
]

/**
 * Weekly research: business_date = the period key, the Friday of weekly-audit (periodKeyFor), so
 * dayOffset 2 is Sunday. Deadlines: scheduled time plus 30 min (1 KV sample, 11/20–11/22). A stage
 * the scheduler manifest keeps PAUSED gets no deadline at row creation (cadenceReadiness D7c rule).
 * Owner-confirmed 2026-11-25. Optional stages carry null.
 */
export const WEEKLY_RESEARCH_STAGE_CATALOG: readonly ChainStageCatalogEntry[] = [
  // first scheduled stage first: its deadline is the period's missed-run cut-off.
  { stageId: 'weekly-audit', label: 'Weekly audit', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '19:00') },
  { stageId: 'storage-integrity-audit', label: 'Storage integrity', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(2, '04:00') },
  { stageId: 'model-ic-full-check', label: 'Model IC full', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '20:00') },
  { stageId: 'weekly-backtest', label: 'Validation / MC', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(2, '07:00') },
  { stageId: 'alpha-quality', label: 'Alpha quality', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(2, '06:30') },
  { stageId: 'active8-oof-weekly', label: 'Active-8 weekly cohort / validation-release', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(2, '09:00') },
  { stageId: 'weekly-optuna', label: 'Drift research', optional: true, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: null },
  { stageId: 'sector-leaders', label: 'Sector leaders', optional: true, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: null },
  { stageId: 'adaptive-meta-policy-replay', label: 'Meta replay', optional: true, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: null },
  { stageId: 's12-smcvwap-calibration', label: 'S12 calibration', optional: true, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: null },
  { stageId: 'linucb-multiplier-replay', label: 'LinUCB replay', optional: true, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: null },
  { stageId: 'weekly-cleanup', label: 'Weekly cleanup', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(2, '04:30') },
  // orchestrator root (Sunday 12:00 Asia/Taipei terminal closure)
  { stageId: 'weekly-readiness', label: 'Weekly root', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(2, '12:30') },
]

/**
 * Monthly artifact: business_date = the period key, the first Saturday of the month (periodKeyFor).
 * The two "first sunday of month" jobs anchor on that Sunday (sun(…)), which is the 1st, six days
 * before the key, when the month starts on a Sunday (GCP lastAttemptTime: monthly-readiness ran
 * 2026-11-01). No KV samples (7-day TTL): deadlines are the schedule plus a guessed run time.
 * PAUSED stages get no deadline at row creation. Owner-confirmed 2026-11-25 as provisional;
 * re-check against the 2026-12-05/06 run.
 */
export const MONTHLY_ARTIFACT_STAGE_CATALOG: readonly ChainStageCatalogEntry[] = [
  { stageId: 'monthly-strategy-mining', label: 'Strategy mining', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '13:00') },
  { stageId: 'monthly-optuna', label: 'Monthly search', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: bd(0, '17:00') },
  { stageId: 'active8-oof-monthly', label: 'Active-8 monthly release / validation', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: sun(0, '06:00') },
  // orchestrator root (first Sunday 12:30 Asia/Taipei terminal closure)
  { stageId: 'monthly-readiness', label: 'Monthly root', optional: false, sources: ['scheduler_run_log'], sourceDate: 'business_date', expectedBy: sun(0, '13:00') },
]

export interface ChainDefinition {
  chainId: string
  stages: readonly ChainStageCatalogEntry[]
  /**
   * 'trading_day': business_date is a TW trading day, and a closed day has no rows. 'week' / 'month':
   * business_date is the period key (periodKeyFor) and the period runs on non-trading days.
   */
  period: 'trading_day' | 'week' | 'month'
  /** 'precreate': market-close-refresh pre-creates X. 'first_write': the period's first write creates every row. */
  creation: 'precreate' | 'first_write'
  /** Rows of business dates older than this are trimmed (one oldest date per creation of this chain). */
  retentionDays: number
}

/** Monthly keeps 70 days: the previous period stays visible for a whole period (first Saturdays are 28 or 35 days apart). */
export const CHAIN_DEFINITIONS: readonly ChainDefinition[] = [
  { chainId: DAILY_READINESS_CHAIN_ID, stages: DAILY_READINESS_STAGE_CATALOG, period: 'trading_day', creation: 'precreate', retentionDays: 35 },
  { chainId: INTRADAY_GUARD_CHAIN_ID, stages: INTRADAY_GUARD_STAGE_CATALOG, period: 'trading_day', creation: 'first_write', retentionDays: 35 },
  { chainId: WEEKLY_RESEARCH_CHAIN_ID, stages: WEEKLY_RESEARCH_STAGE_CATALOG, period: 'week', creation: 'first_write', retentionDays: 35 },
  { chainId: MONTHLY_ARTIFACT_CHAIN_ID, stages: MONTHLY_ARTIFACT_STAGE_CATALOG, period: 'month', creation: 'first_write', retentionDays: 70 },
]

const CHAINS = new Map(CHAIN_DEFINITIONS.map(chain => [chain.chainId, chain]))
const BY_CHAIN_STAGE = new Map(CHAIN_DEFINITIONS.flatMap(chain =>
  chain.stages.map(entry => [`${chain.chainId}/${entry.stageId}`, entry] as const)))
// A stage id in two chains (none today) is recorded in each of them; chainsOfStage lists them all.
const CHAINS_BY_STAGE = new Map<string, string[]>()
for (const chain of CHAIN_DEFINITIONS) {
  for (const entry of chain.stages) CHAINS_BY_STAGE.set(entry.stageId, [...(CHAINS_BY_STAGE.get(entry.stageId) ?? []), chain.chainId])
}

export function chainDefinition(chainId: string): ChainDefinition | undefined {
  return CHAINS.get(chainId)
}

/** The catalog entry of (chainId, stageId); the one lookup writer and monitoring side share. */
export function chainStage(chainId: string, stageId: string): ChainStageCatalogEntry | undefined {
  return BY_CHAIN_STAGE.get(`${chainId}/${stageId}`)
}

/** Every chain a stage id belongs to (the scheduler run log names a task, not a chain). */
export function chainsOfStage(stageId: string): readonly string[] {
  return CHAINS_BY_STAGE.get(stageId) ?? []
}

export function dailyReadinessStage(stageId: string): ChainStageCatalogEntry | undefined {
  return chainStage(DAILY_READINESS_CHAIN_ID, stageId)
}

/**
 * Minute of the Taiwan day (0–1439) by which a stage of business date X is due: its same-day deadline. Data a
 * stage writes is expected for X only from then on (dataQualityMonitor's chip / technical / market dashboard
 * targets). Throws for a stage without a same-day business-date deadline, so a catalog edit cannot silently
 * move a data target to another day.
 */
export function writerDeadlineMinuteTw(stageId: string): number {
  const expectedBy = dailyReadinessStage(stageId)?.expectedBy
  if (!expectedBy || expectedBy.dayOffset !== 0 || expectedBy.anchor !== 'business_date') throw new Error(`no same-day deadline for ${stageId}`)
  const [hours, minutes] = expectedBy.tw.split(':').map(Number)
  return hours * 60 + minutes
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * Pure: the UTC ISO instant (Z) by which a stage of chain `businessDate` is expected to finish.
 * `nextTradingDate` is the TW trading day after businessDate (needed only for next_trading_day
 * anchors; without it such a stage has no deadline). Returns null when no deadline applies.
 */
export function stageExpectedByUtc(
  businessDate: string,
  entry: Pick<ChainStageCatalogEntry, 'expectedBy'>,
  nextTradingDate?: string | null,
): string | null {
  const spec = entry.expectedBy
  if (!spec || !DATE.test(businessDate)) return null
  const anchorDate = spec.anchor === 'next_trading_day' ? nextTradingDate
    : spec.anchor === 'first_sunday_of_month' ? firstWeekdayOfMonth(businessDate, 0) : businessDate
  if (!anchorDate || !DATE.test(anchorDate) || !HHMM.test(spec.tw)) return null
  if (!Number.isSafeInteger(spec.dayOffset) || spec.dayOffset < 0 || spec.dayOffset > 14) return null
  // Taiwan has no DST: TW = UTC+8 all year.
  const ms = Date.parse(`${anchorDate}T${spec.tw}:00+08:00`) + spec.dayOffset * 86_400_000
  // Same format as every other stored timestamp (toISOString, ms + Z) so string order is time order.
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

const DAY_MS = 86_400_000
const dayIndex = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS
const dateOfIndex = (index: number) => new Date(index * DAY_MS).toISOString().slice(0, 10)

/** First `weekday` (0 = Sunday … 6 = Saturday) of the month of a YYYY-MM-DD date. */
function firstWeekdayOfMonth(date: string, weekday: number): string {
  const first = dayIndex(`${date.slice(0, 7)}-01`)
  // 1970-01-01 (index 0) was a Thursday (4).
  return dateOfIndex(first + ((weekday - (first + 4) % 7) + 7) % 7)
}

/**
 * Pure: the business_date (period key) a stage run on TW date `twDate` belongs to. Trading-day
 * chains: the date itself. weekly_research: the latest Friday on or before it (weekly-audit's day;
 * Saturday/Sunday stages and a Monday–Thursday re-run belong to that Friday). monthly_artifact: the
 * first Saturday of its month (also for the first-Sunday jobs when the 1st is a Sunday). null for an
 * unknown chain or a malformed date. The monitoring Worker uses it with the first catalog stage's
 * deadline to judge a period missed (no rows) without reading anything else.
 */
export function periodKeyFor(chainId: string, twDate: string): string | null {
  const chain = CHAINS.get(chainId)
  if (!chain || !DATE.test(twDate) || !Number.isFinite(dayIndex(twDate))) return null
  if (chain.period === 'week') {
    const index = dayIndex(twDate)
    return dateOfIndex(index - ((index + 4) % 7 - 5 + 7) % 7)
  }
  return chain.period === 'month' ? firstWeekdayOfMonth(twDate, 6) : twDate
}

/** TW calendar date (YYYY-MM-DD) of a UTC ISO instant. */
export function twDateOfUtc(iso: string | null | undefined): string | null {
  const ms = Date.parse(String(iso ?? ''))
  return Number.isFinite(ms) ? new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10) : null
}
