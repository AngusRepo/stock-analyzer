/** v6 ④ / ① reads (11/26 Wei: 研究資料新鮮度 folded into ④ and ①, no new dashboard, no new ops tables).
 * Each answers one question from rows that already exist; every read is an index seek (monitoringV6Endpoints.test.ts).
 * - /v1/policy/seal: was today's formal plan sealed before the premarket cutoff (paper_daily_plan_heads_v1 is written only
 *   then, persistDailyReview), and the 14-day history of sealed / missing trading days.
 * - /v1/opb/ledger: how far the OPB v2 reward ledger (l4_opb_arm_replay_v1, the arm replay selection learns from;
 *   l4_opb_selection.py) lags, in trading days, and how much of it the live context has.
 * - /v1/models/serving: per published model and trading day, whether the day's predictions were served, and which
 *   champion version served them (model_champion_history).
 * - /v1/serving-guard: the T+5 serving-forward guard of the Fusion artifact (expected_return_forward_guard_state):
 *   degraded / recovery streaks against the 3-date thresholds of expected_return_serving_forward_guard.py. */
import { publishedAlphaModelOrderProjected } from '../lib/alphaModelRoster'
import { premarketPublicationCutoff } from '../lib/premarketPublicationWindow'
import { addDays, TW_OFFSET_MS, twDate, type MonitoringEnv } from './env'
import { PAPER_ACCOUNT_ID } from './paperNav'
import { isTradingDay, previousTradingDay } from './tradingDay'

/** Trading days in [from, to], oldest first (KV calendar, memoized per day). */
export async function tradingDaysBetween(env: Pick<MonitoringEnv, 'KV' | 'MEMO'>, from: string, to: string): Promise<string[]> {
  const out: string[] = []
  for (let date = from; date <= to; date = addDays(date, 1)) if (await isTradingDay(env, date)) out.push(date)
  return out
}
const twMinutes = (nowMs: number) => Math.floor(((nowMs + TW_OFFSET_MS) % 86_400_000) / 60_000)
/** SQLite CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS', UTC) or an ISO stamp, to epoch ms. */
const utcMs = (value: string | null | undefined) => value ? Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`) : NaN

/* ---- /v1/policy/seal ---- */

export const SEAL_DAYS = 14
const HEADS_SQL = 'SELECT trade_date, plan_id FROM paper_daily_plan_heads_v1 WHERE account_id = ? AND trade_date >= ? AND trade_date <= ?'
// GROUP BY the primary key's second column after its first: no temp B-tree.
const REVIEWS_SQL = `SELECT trade_date, MIN(created_at) AS first_sealed_at, MAX(created_at) AS last_revised_at, MAX(revision) AS revision
  FROM paper_daily_plan_reviews_v1 WHERE account_id = ? AND trade_date >= ? AND trade_date <= ? GROUP BY trade_date`

export async function policySealReport(env: MonitoringEnv, nowMs: number) {
  const today = twDate(nowMs)
  const since = addDays(today, -(SEAL_DAYS - 1))
  const [heads, reviews, days] = await Promise.all([
    env.PAPER_DB.prepare(HEADS_SQL).bind(PAPER_ACCOUNT_ID, since, today).all<{ trade_date: string; plan_id: string }>(),
    env.PAPER_DB.prepare(REVIEWS_SQL).bind(PAPER_ACCOUNT_ID, since, today)
      .all<{ trade_date: string; first_sealed_at: string; last_revised_at: string; revision: number }>(),
    tradingDaysBetween(env, since, today),
  ])
  const head = new Map((heads.results ?? []).map((row) => [row.trade_date, row]))
  const review = new Map((reviews.results ?? []).map((row) => [row.trade_date, row]))
  const rows = days.map((date) => {
    const sealed = head.get(date)
    const cutoffMs = premarketPublicationCutoff(date)
    const first = sealed ? review.get(date) : undefined
    const sealedMs = utcMs(first?.first_sealed_at)
    return {
      date, status: sealed ? 'sealed' : nowMs < cutoffMs ? 'waiting' : 'missing', plan_id: sealed?.plan_id ?? null,
      sealed_at: first?.first_sealed_at ?? null, revised_at: first && first.revision > 0 ? first.last_revised_at : null, revision: first?.revision ?? null,
      cutoff_at: new Date(cutoffMs).toISOString(),
      minutes_before_cutoff: Number.isFinite(sealedMs) ? Math.round((cutoffMs - sealedMs) / 60_000) : null,
    }
  })
  const todayRow = rows.find((row) => row.date === today) ?? null
  return {
    account_id: PAPER_ACCOUNT_ID, today, since, days: SEAL_DAYS,
    definitions: { sealed: 'paper_daily_plan_heads_v1 has the trade date (first published before the premarket cutoff, persistDailyReview)' },
    summary: {
      today_trading: todayRow != null, today_status: todayRow?.status ?? 'not_trading', today_sealed_at: todayRow?.sealed_at ?? null,
      today_cutoff_at: todayRow?.cutoff_at ?? null, trading_days: rows.length,
      sealed_days: rows.filter((row) => row.status === 'sealed').length, missing_days: rows.filter((row) => row.status === 'missing').length,
      latest_missing_date: rows.filter((row) => row.status === 'missing').at(-1)?.date ?? null,
    },
    rows,
  }
}

/* ---- /v1/opb/ledger ---- */

/** Rowid tail of the replay ledger: one nightly run inserts at most 10 dates × 6 arms (BACKFILL_DATES_PER_RUN), newest
 * date first, so the last two runs' rows hold the newest known_date. known_date has no index of its own. */
export const LEDGER_TAIL_ROWS = 128
/** The daily closure that writes the replay (active8-oof-daily, 14:30 TW) is counted as run from 16:00 TW. */
const CLOSURE_DONE_MINUTES = 16 * 60
/** Lags are counted up to this many trading days (then served as this value with lag_capped). */
export const LEDGER_LAG_CAP = 20
const LEDGER_PLAN_DAYS = 10
const LEDGER_PLANS_SQL = `SELECT signal_date, activated, created_at, json_extract(payload_json, '$.opb.context_identity') AS context_identity
  FROM l4_portfolio_plans_v1 WHERE account_id = ? AND signal_date >= ?`
const LEDGER_TAIL_SQL = `SELECT MAX(known_date) AS last_known_date, MAX(signal_date) AS last_signal_date, COUNT(*) AS tail_rows
  FROM l4_opb_arm_replay_v1 WHERE rowid > (SELECT MAX(rowid) FROM l4_opb_arm_replay_v1) - ?`
/** A context's rows are counted up to this many (a reward window of observations × arms is far below it). */
export const LEDGER_CONTEXT_ROW_CAP = 500
const LEDGER_CONTEXT_COUNT_SQL = 'SELECT COUNT(*) AS rows_in_context FROM (SELECT 1 FROM l4_opb_arm_replay_v1 WHERE context_identity = ? LIMIT ?)'
const LEDGER_CONTEXT_LAST_SQL = 'SELECT known_date FROM l4_opb_arm_replay_v1 WHERE context_identity = ? ORDER BY known_date DESC LIMIT 1'

/** Trading days after `last` up to and including `expected` (0 when last >= expected), walking back at most `cap`. */
async function tradingLag(env: MonitoringEnv, last: string | null, expected: string | null, cap = LEDGER_LAG_CAP) {
  if (!last || !expected) return { lag: null as number | null, capped: false }
  let lag = 0
  for (let date = expected; date > last; date = addDays(date, -1)) {
    if (await isTradingDay(env, date)) lag += 1
    if (lag >= cap) return { lag: cap, capped: true }
  }
  return { lag, capped: false }
}

export async function opbLedgerReport(env: MonitoringEnv, nowMs: number) {
  const today = twDate(nowMs)
  const [plans, tail, todayTrading] = await Promise.all([
    env.PAPER_DB.prepare(LEDGER_PLANS_SQL).bind(PAPER_ACCOUNT_ID, addDays(today, -(LEDGER_PLAN_DAYS - 1)))
      .all<{ signal_date: string; activated: number; created_at: string; context_identity: string | null }>(),
    env.LEARNING_DB.prepare(LEDGER_TAIL_SQL).bind(LEDGER_TAIL_ROWS).first<{ last_known_date: string | null; last_signal_date: string | null; tail_rows: number }>(),
    isTradingDay(env, today),
  ])
  const activated = (plans.results ?? []).filter((row) => row.activated === 1)
    .sort((a, b) => a.signal_date.localeCompare(b.signal_date) || a.created_at.localeCompare(b.created_at))
  const latest = activated.at(-1) ?? null
  const context = latest?.context_identity ?? null
  const [counted, newest] = context ? await Promise.all([
    env.LEARNING_DB.prepare(LEDGER_CONTEXT_COUNT_SQL).bind(context, LEDGER_CONTEXT_ROW_CAP).first<{ rows_in_context: number }>(),
    env.LEARNING_DB.prepare(LEDGER_CONTEXT_LAST_SQL).bind(context).first<{ known_date: string }>(),
  ]) : [null, null]
  const current = counted ? { rows_in_context: counted.rows_in_context, last_known_date: newest?.known_date ?? null } : null
  // The latest closure that has run, and the newest known_date it can replay (known_date < its business date).
  const lastClosure = todayTrading && twMinutes(nowMs) >= CLOSURE_DONE_MINUTES ? today : await previousTradingDay(env, today)
  const expectedKnown = lastClosure ? await previousTradingDay(env, lastClosure) : null
  const ledger = await tradingLag(env, tail?.last_known_date ?? null, expectedKnown)
  const live = await tradingLag(env, current?.last_known_date ?? null, expectedKnown)
  const contextSince = context ? activated.find((row) => row.context_identity === context)?.signal_date ?? null : null
  return {
    today, expected_known_date: expectedKnown, last_closure_date: lastClosure,
    definitions: {
      lag_trading_days: 'trading days after the newest replay known_date up to expected_known_date (the trading day before the latest daily closure); 0 = current',
      current_context: 'the OPB context of the newest activated plan; selection learns only from its rows',
    },
    summary: {
      ledger_last_known_date: tail?.last_known_date ?? null, ledger_last_signal_date: tail?.last_signal_date ?? null,
      lag_trading_days: ledger.lag, lag_capped: ledger.capped,
      current_context_identity: context, current_context_since: contextSince, current_context_rows: current?.rows_in_context ?? 0, current_context_rows_capped: (current?.rows_in_context ?? 0) >= LEDGER_CONTEXT_ROW_CAP,
      current_context_last_known_date: current?.last_known_date ?? null, current_context_lag_trading_days: live.lag, current_context_lag_capped: live.capped,
      latest_plan_signal_date: latest?.signal_date ?? null,
    },
    rows: [{ ledger: 'all_contexts', last_known_date: tail?.last_known_date ?? null, lag_trading_days: ledger.lag },
      { ledger: 'current_context', last_known_date: current?.last_known_date ?? null, lag_trading_days: live.lag }],
  }
}

/* ---- /v1/models/serving ---- */

export const SERVING_DAYS = 14
/** Predictions of a signal date land after its overnight pipeline (L3 by ~08:00 TW); before 09:00 the previous
 * trading day is still pending, not missing. */
const PIPELINE_DONE_MINUTES = 9 * 60
const SERVED_SQL = 'SELECT 1 AS served FROM predictions WHERE prediction_date = ? AND model_name = ? LIMIT 1'
const CHAMPION_BEFORE_SQL = `SELECT model_name, version, effective_at FROM model_champion_history
 WHERE model_name = ? AND effective_at < ? ORDER BY effective_at DESC LIMIT 1`
const championWindowSql = (models: number) => `SELECT model_name, version, effective_at FROM model_champion_history
 WHERE model_name IN (${Array(models).fill('?').join(', ')}) AND effective_at >= ?`

type Champion = { model_name: string; version: string; effective_at: string }

export async function modelServingReport(env: MonitoringEnv, nowMs: number) {
  const today = twDate(nowMs)
  const since = addDays(today, -(SERVING_DAYS - 1))
  const db = env.LEARNING_DB
  // Window start as the UTC instant of `since` 00:00 TW, in model_champion_history's ISO shape.
  const sinceUtc = new Date(Date.parse(`${since}T00:00:00Z`) - TW_OFFSET_MS).toISOString().slice(0, 19)
  const [models, days, prevTrading] = await Promise.all([
    publishedAlphaModelOrderProjected(db), tradingDaysBetween(env, since, today), previousTradingDay(env, today)])
  const pairs = days.flatMap((date) => models.map((model) => ({ date, model })))
  const [served, before, inWindow] = await Promise.all([
    pairs.length ? db.batch<{ served: number }>(pairs.map(({ date, model }) => db.prepare(SERVED_SQL).bind(date, model))) : [],
    models.length ? db.batch<Champion>(models.map((model) => db.prepare(CHAMPION_BEFORE_SQL).bind(model, sinceUtc))) : [],
    models.length ? db.prepare(championWindowSql(models.length)).bind(...models, sinceUtc).all<Champion>() : null,
  ])
  const history = [...before.flatMap((result) => result.results ?? []), ...(inWindow?.results ?? [])]
    .sort((a, b) => utcMs(a.effective_at) - utcMs(b.effective_at))
  /** The champion in effect at the end of a TW date. */
  const versionOn = (model: string, date: string) => {
    const end = Date.parse(`${addDays(date, 1)}T00:00:00Z`) - TW_OFFSET_MS
    return history.filter((row) => row.model_name === model && utcMs(row.effective_at) < end).at(-1)?.version ?? null
  }
  const pending = (date: string) => date === today || (date === prevTrading && twMinutes(nowMs) < PIPELINE_DONE_MINUTES)
  const rows = pairs.map(({ date, model }, i) => {
    const version = versionOn(model, date)
    const previous = days.indexOf(date) > 0 ? versionOn(model, days[days.indexOf(date) - 1]) : version
    const isServed = (served[i]?.results ?? []).length > 0
    const state = isServed ? (version && previous && version !== previous ? 'switched' : 'serving') : pending(date) ? 'pending' : 'missing'
    return { date, model_name: model, state, version, cell: `${state}|${version ?? '—'}` }
  })
  const latestDone = [...days].reverse().find((date) => !pending(date)) ?? null
  return {
    today, since, days: SERVING_DAYS, models,
    definitions: {
      serving: 'predictions has rows for the model and prediction_date', switched: 'served, and the champion version changed since the previous trading day',
      pending: 'the date\'s overnight pipeline has not finished yet', missing: 'a finished trading day without predictions for the model',
    },
    summary: {
      model_count: models.length, trading_days: days.length, latest_finished_date: latestDone,
      missing_cells: rows.filter((row) => row.state === 'missing').length,
      latest_missing_models: latestDone ? rows.filter((row) => row.date === latestDone && row.state === 'missing').map((row) => row.model_name) : [],
    },
    rows,
  }
}

/* ---- /v1/serving-guard ---- */

/** expected_return_serving_forward_guard.py: three jointly inferior forward dates bypass the residual, three passing
 * dates recover it, from five evaluable dates. */
export const GUARD_THRESHOLDS = { degraded_streak_to_bypass: 3, pass_streak_to_recover: 3, min_evaluable_dates: 5 } as const
export const GUARD_EVALUATION_DAYS = 30
const GUARD_SQL = `SELECT model_name, artifact_id, model_fingerprint, model_version, state, evaluable_date_count, degraded_streak, recovery_streak,
       last_prediction_date, json_extract(evidence_json, '$.reason') AS reason, updated_at
  FROM expected_return_forward_guard_state WHERE model_name = 'allocator_ev_fusion'`
const GUARD_EVALUATIONS_SQL = `SELECT prediction_date, label_known_date, quality_decision, sample_count, corr_delta, spread_delta
  FROM expected_return_serving_forward_evaluations WHERE artifact_id = ? AND model_fingerprint = ? AND prediction_date >= ?`

type GuardRow = { model_name: string; artifact_id: string; model_fingerprint: string; model_version: string; state: 'monitoring' | 'residual_bypass'
  evaluable_date_count: number; degraded_streak: number; recovery_streak: number; last_prediction_date: string; reason: string | null; updated_at: string }

/** expectedReturnServingState.ts EXPECTED_RETURN_SERVING_STATE_KEY (not imported: that module pulls the main Worker's
 * serving registry into this bundle; monitoringV6Endpoints.test.ts asserts the two are equal). */
export const SERVING_STATE_KEY = 'expected-return:serving-state:v1'
/** The Fusion artifact the main Worker serves: none while trading:config carries l4Distribution (readNewL4ServingState
 * retires Fusion), else the persisted serving state's allocator_ev_fusion (refreshExpectedReturnServingState). KV only,
 * read only when a guard row exists. */
async function servingFusionIdentity(env: MonitoringEnv): Promise<{ artifact_id: string | null; model_fingerprint: string | null; source: string }> {
  const config = await env.KV.get('trading:config', 'json') as Record<string, unknown> | null
  if (config?.l4Distribution != null) return { artifact_id: null, model_fingerprint: null, source: 'l4_distribution_retires_fusion' }
  const state = await env.KV.get(SERVING_STATE_KEY, 'json') as
    { artifacts?: { allocator_ev_fusion?: { artifact_id?: string | null; model_fingerprint?: string | null } } } | null
  const fusion = state?.artifacts?.allocator_ev_fusion
  return { artifact_id: fusion?.artifact_id ?? null, model_fingerprint: fusion?.model_fingerprint ?? null, source: state ? 'serving_state' : 'serving_state_missing' }
}

export async function servingGuardReport(env: MonitoringEnv, nowMs: number) {
  const guard = await env.LEARNING_DB.prepare(GUARD_SQL).first<GuardRow>()
  // pipelineDecisionMaturity: a guard row counts only when it is bound to the serving Fusion artifact and fingerprint.
  const serving = guard ? await servingFusionIdentity(env) : null
  const bound = Boolean(guard && serving?.artifact_id && serving.model_fingerprint
    && guard.artifact_id === serving.artifact_id && guard.model_fingerprint === serving.model_fingerprint)
  const evaluations = guard && bound
    ? (await env.LEARNING_DB.prepare(GUARD_EVALUATIONS_SQL).bind(guard.artifact_id, guard.model_fingerprint, addDays(twDate(nowMs), -GUARD_EVALUATION_DAYS))
      .all<{ prediction_date: string; label_known_date: string; quality_decision: string; sample_count: number; corr_delta: number | null; spread_delta: number | null }>()).results ?? []
    : []
  const status = !guard ? 'not_applicable' : !bound ? 'mismatch' : guard.state === 'residual_bypass' ? 'bypass' : guard.degraded_streak > 0 ? 'warning' : 'monitoring'
  const streaks = guard && bound
  return {
    thresholds: GUARD_THRESHOLDS,
    definitions: {
      not_applicable: 'no guard row: no Fusion residual is serving, so no T+5 guard is required (pipelineDecisionMaturity no_serving_residual_guard_required)',
      mismatch: 'a guard row not bound to the serving Fusion artifact_id and model_fingerprint (runtime_guard_identity_mismatch); its streaks are not served',
    },
    summary: {
      status, state: guard?.state ?? null, identity_bound: guard ? bound : null, serving_identity_source: serving?.source ?? null,
      guard_artifact_id: guard?.artifact_id ?? null, serving_artifact_id: serving?.artifact_id ?? null,
      degraded_streak: streaks ? guard.degraded_streak : null, recovery_streak: streaks ? guard.recovery_streak : null,
      evaluable_date_count: streaks ? guard.evaluable_date_count : null, last_prediction_date: guard?.last_prediction_date ?? null,
      model_version: guard?.model_version ?? null, reason: !guard ? null : bound ? guard.reason : 'runtime_guard_identity_mismatch', updated_at: guard?.updated_at ?? null,
    },
    rows: evaluations.sort((a, b) => a.prediction_date.localeCompare(b.prediction_date)),
  }
}
