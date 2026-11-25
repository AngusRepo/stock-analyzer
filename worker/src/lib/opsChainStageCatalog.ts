/**
 * Stage catalog for the `daily_readiness` chain (ops_chain_stage_state_v1). The node set is exactly
 * frontend ExecutionChainPanel SCOPES[daily_readiness] (columns + branches, unexpanded), and
 * `optional` is the NODES flag. Contract: audits/grafana-obs-eval-20261124/p2p3_contract.md.
 */
export const DAILY_READINESS_CHAIN_ID = 'daily_readiness'

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
 * so Friday's chain expects Monday morning). null = no overdue judgement.
 */
export interface ChainStageExpectedBy {
  dayOffset: number
  tw: string
  anchor?: 'business_date' | 'next_trading_day'
}

export interface ChainStageCatalogEntry {
  stageId: string
  label: string
  optional: boolean
  sources: readonly ChainStageWriteSource[]
  sourceDate: ChainStageSourceDate
  expectedBy: ChainStageExpectedBy | null
}

const bd = (dayOffset: number, tw: string): ChainStageExpectedBy => ({ dayOffset, tw, anchor: 'business_date' })
const ntd = (tw: string): ChainStageExpectedBy => ({ dayOffset: 0, tw, anchor: 'next_trading_day' })

/**
 * Deadlines (Q3): the "建議截止" column of audits/grafana-obs-eval-20261124/expected_by_proposal.md
 * (latest normal completion over 11/17–11/24 plus a 20–30 min margin). STILL AWAITING OWNER
 * CONFIRMATION — edit the numbers here only. T = business_date (bd(0, …)); T+1 = next TW trading
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

const BY_ID = new Map(DAILY_READINESS_STAGE_CATALOG.map(entry => [entry.stageId, entry]))

export function dailyReadinessStage(stageId: string): ChainStageCatalogEntry | undefined {
  return BY_ID.get(stageId)
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
  const anchorDate = spec.anchor === 'next_trading_day' ? nextTradingDate : businessDate
  if (!anchorDate || !DATE.test(anchorDate) || !HHMM.test(spec.tw)) return null
  if (!Number.isSafeInteger(spec.dayOffset) || spec.dayOffset < 0 || spec.dayOffset > 14) return null
  // Taiwan has no DST: TW = UTC+8 all year.
  const ms = Date.parse(`${anchorDate}T${spec.tw}:00+08:00`) + spec.dayOffset * 86_400_000
  // Same format as every other stored timestamp (toISOString, ms + Z) so string order is time order.
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** TW calendar date (YYYY-MM-DD) of a UTC ISO instant. */
export function twDateOfUtc(iso: string | null | undefined): string | null {
  const ms = Date.parse(String(iso ?? ''))
  return Number.isFinite(ms) ? new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10) : null
}
