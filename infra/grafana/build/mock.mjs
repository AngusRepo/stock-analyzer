/** Authored responses for the fixture build where no Worker fixture exists (panel descriptions say 示範資料):
 * - Worker routes not deployed yet, in the shapes of worker/src/monitoring/{paperNav,modelRoster,opb,schedulerTickets}.ts
 *   (branch feat/monitoring-model-health-endpoints): /v1/paper/nav, /v1/models/roster, /v1/opb, /v1/chain/failure-classes, /v1/kv-drift.
 * - mock:billing-* — rows as the BigQuery billing queries return them (build.mjs costPanels).
 * - plan:cloudflare-* — Cloudflare usage, no source wired yet (fixture only).
 * Deterministic and dated back from the fixture evening, so the page reads like that evening. */
const TW = 8 * 3600_000
const DAY = 86_400_000
const ARMS = ['base', 'diversified_alpha', 'diversified_all_eligible', 'liquidity_diversified', 'conservative_diversified', 'high_score_conservative']
const MODELS = ['LightGBM', 'ExtraTrees', 'TabM', 'GNN']
/** TWD per day before noise; Cloud Run is most of it, weekends run less. */
const SERVICES = [['Cloud Run', 38], ['Cloud Storage', 9], ['Artifact Registry', 5], ['Cloud Build', 3], ['Secret Manager', 1.2], ['Cloud Scheduler', 0.6], ['BigQuery', 0.4]]

/** `slackStages` (v5 preview): the daily chain's required stages in Canvas order, each { id, label, deadline, typical } in
 * minutes after the business date's Taiwan midnight. */
export function mockResponses(nowIso, { slackStages = [] } = {}) {
  const now = Date.parse(nowIso)
  const today = new Date(now + TW).toISOString().slice(0, 10)
  let seed = 20261124
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits
  const date = (offset) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * DAY).toISOString().slice(0, 10)
  const weekday = (d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())
  const midnight = (d) => new Date(Date.parse(`${d}T00:00:00+08:00`)).toISOString()
  const days = (count) => Array.from({ length: count }, (_, i) => date(i - count + 1))
  const head = (ttl) => ({ generated_at: nowIso, rows_read: 0, queries: 0, cache_ttl_s: ttl })

  const billingRows = days(30).flatMap((d) => SERVICES.map(([svc, base]) => ({ time: midnight(d), svc,
    net: round(base * (weekday(d) ? 1 : 0.55) * (0.8 + rand() * 0.4)) })))
  const daily = (rows) => [...new Set(rows.map((row) => row.time))].map((time) => ({ time, net: round(rows.filter((row) => row.time === time).reduce((sum, row) => sum + row.net, 0)) }))
  const month = billingRows.filter((row) => new Date(Date.parse(row.time) + TW).toISOString().slice(0, 7) === today.slice(0, 7))
  const mtd = month.reduce((sum, row) => sum + row.net, 0)
  const elapsed = Number(today.slice(8, 10))
  const monthDays = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate()

  // Paper NAV against the index over 90 calendar days of trading days, each rebased to its first value.
  let nav = 1_000_000
  let twii = 22_400
  let peak = 0
  const navDays = days(90).filter(weekday)
  const navRows = navDays.map((d, i) => {
    if (i) { nav *= 1 + (rand() - 0.47) * 0.018; twii *= 1 + (rand() - 0.48) * 0.014 }
    peak = Math.max(peak, nav)
    const navReturn = round((nav / 1_000_000 - 1) * 100)
    // The last day's index close lands after the paper snapshot.
    const twiiClose = i === navDays.length - 1 ? null : round(twii)
    const twiiReturn = twiiClose == null ? null : round((twii / 22_400 - 1) * 100)
    return { date: d, nav: round(nav, 0), cash: round(nav * 0.32, 0), positions_value: round(nav * 0.68, 0), nav_return_pct: navReturn, twii_close: twiiClose,
      twii_return_pct: twiiReturn, excess_return_pct: twiiReturn == null ? null : round(navReturn - twiiReturn), drawdown_pct: round((nav / peak - 1) * 100),
      pnl_pct_since_inception: navReturn, benchmark_0050_close: null, max_drawdown_to_date_pct: null }
  })
  const lastNav = navRows.at(-1)
  const lastIndexed = [...navRows].reverse().find((row) => row.twii_close != null)

  const opbDays = days(60).filter(weekday)
  const opbRows = opbDays.map((d, i) => {
    const inert = i < 18 && i % 3 === 0
    return { signal_date: d, plan_id: `plan-${d}`, activated: true, enabled: true, arm_id: inert ? 'base' : ARMS[Math.floor(rand() * ARMS.length)],
      status: inert ? 'arm_inert' : i === 0 ? 'cold_start_base' : 'learned_policy', arm_inert: inert, effective_groups: inert ? 1 : 6, arm_count: 6,
      context_identity: 'ctx-current', schema_version: 'opb-v2', plans_on_date: 1 }
  })
  const share = ARMS.map((arm) => ({ arm_id: arm, plan_days: opbRows.filter((row) => row.arm_id === arm).length }))
    .map((row) => ({ ...row, share: round(row.plan_days / opbRows.length, 4) })).sort((a, b) => b.plan_days - a.plan_days)
  const inertDays = opbRows.filter((row) => row.arm_inert).length

  const jobs = [['weekly-root', 'weekly'], ['allocator-ev-lifecycle-watchdog', 'watchdog'], ['finlab-v4-backfill', 'evening'], ['rescore-1230', 'intraday'],
    ['active8-oof-daily', 'daily'], ['pipeline', 'evening']]
  const CLASSES = ['final_failure', 'recovered', 'designed_retry', 'upstream_blocked', 'recovered', 'in_progress']
  const failureRows = days(14).filter(weekday).flatMap((d, i) => jobs.filter((_, j) => (i + j) % 3 === 0).map(([job, task], j) => {
    const klass = CLASSES[(i + j) % CLASSES.length]
    return { business_date: d, job_id: job, task, ticket_kind: 'root', class: klass, final_status: klass === 'final_failure' ? 'error' : 'success',
      final_ticket_id: `t-${job}-${d}`, final_known: true, non_success_tickets: 1 + j % 2, error_tickets: klass === 'final_failure' ? 1 : 0,
      detail: klass === 'final_failure' ? `${job}: upstream artifact not ready` : '', updated_at: `${d} 15:00:00`, failure_occurrence: null, failure_days_in_window: 0 }
  }))
  const classes = Object.fromEntries(['final_failure', 'upstream_blocked', 'designed_retry', 'recovered', 'orphan_running', 'unsettled_triggered', 'in_progress']
    .map((klass) => [klass, failureRows.filter((row) => row.class === klass).length]))

  const kvRows = days(7).reverse().map((d, i) => ({ business_date: d, status: i === 0 ? 'error' : 'success', completed_at: `${d} 22:00:30`, updated_at: `${d} 22:00:30`,
    drift: i === 0, drifted_keys: i === 0 ? 'trading:config' : '', 'trading:config': i === 0 ? 'drift' : 'match', 'trading:risk_config': 'match',
    stored_risk_v2: 'match', stored_risk_v2_failed: 0, summary: `kv_config_drift trading:config=${i === 0 ? 'drift' : 'match'} trading:risk_config=match` }))


  // v5 preview. Margin to the deadline per required stage and business day: the night pipeline and everything after it
  // drift later by about 3.5 minutes a day; one Market update ran an hour late.
  const NIGHT = new Set(['pipeline', 'ml-predict', 'post-pipeline-chain', 'allocator-ev-feature-snapshot-backfill', 'verify-v2', 'post-verify-chain',
    'recommendation', 'morning-setup', 'pre-market-warmup'])
  const businessDays = days(14).filter(weekday)
  const CLOCK_BASE = Date.parse('2000-01-01T00:00:00+08:00')
  const slackRows = businessDays.map((d, i) => {
    const row = { time: midnight(d) }
    let tail = null
    for (const stage of slackStages) {
      const typical = stage.typical ?? stage.deadline - 30
      const done = typical + (NIGHT.has(stage.id) ? 3.5 * i : 0) + (stage.id === 'update' && i === 6 ? 60 : 0) + (rand() - 0.5) * 16
      row[stage.id] = round(stage.deadline - done, 0)
      if (stage.id === 'pipeline') tail = done
    }
    // Clock time on a fixed reference day, so the axis reads HH:mm in Taiwan time.
    row.tail = round(CLOCK_BASE + tail * 60_000, 0)
    return row
  })
  const pipelineDeadline = slackStages.find((stage) => stage.id === 'pipeline')?.deadline

  // Daily rows per hour as a day × hour grid (Taiwan time), reads and writes, shaped like the evening chain's timeline
  // (audits/evening-chain-overload-20261106): the heavy readers run 21:45–23:30, the post-close refresh and screener
  // 14:00–18:00, the small hours are nearly idle. Share of the 22:00 peak per Taiwan hour; on weekends the chains do not run.
  const D1_READS = [0.12, 0.03, 0.02, 0.02, 0.02, 0.02, 0.02, 0.04, 0.09, 0.06, 0.06, 0.06, 0.07, 0.08, 0.32, 0.42, 0.38, 0.28, 0.12, 0.10, 0.12, 0.55, 1, 0.72]
  const D1_WRITES = [0.10, 0.02, 0.01, 0.01, 0.01, 0.01, 0.01, 0.03, 0.07, 0.04, 0.04, 0.04, 0.05, 0.06, 0.48, 0.58, 0.44, 0.30, 0.10, 0.08, 0.10, 0.45, 1, 0.68]
  const d1Load = (at) => {
    const local = new Date(at + TW), hour = local.getUTCHours(), weekend = [0, 6].includes(local.getUTCDay())
    // Saturday's first hours still carry Friday night's chain.
    const quiet = weekend && !(local.getUTCDay() === 6 && hour < 1) ? 0.06 : 1
    const jitter = () => 0.85 + rand() * 0.3
    return { reads: round(Math.max(D1_READS[hour] * quiet, 0.015) * 9e6 * jitter(), 0), writes: round(Math.max(D1_WRITES[hour] * quiet, 0.01) * 1.8e5 * jitter(), 0) }
  }
  const d1Hourly = Array.from({ length: 30 * 24 }, (_, i) => {
    const at = now - (30 * 24 - 1 - i) * 3600_000
    return { at, ...d1Load(at) }
  })
  const pad = (n) => String(n).padStart(2, '0')
  const d1Grid = days(30).map((d) => {
    const row = { time: midnight(d) }
    for (const { at, reads, writes } of d1Hourly) {
      const local = new Date(at + TW)
      if (local.toISOString().slice(0, 10) !== d) continue
      row[`r${pad(local.getUTCHours())}`] = reads
      row[`w${pad(local.getUTCHours())}`] = writes
    }
    return row
  })

  // This month by service, and the running total by day of month with a straight-line projection to month end.
  const monthByService = SERVICES.map(([svc]) => ({ svc, net: round(month.filter((row) => row.svc === svc).reduce((sum, row) => sum + row.net, 0)) }))
    .sort((a, b) => b.net - a.net)
  let running = 0
  const monthDaily = daily(month)
  const cumulative = Array.from({ length: monthDays }, (_, i) => {
    const day = i + 1
    if (day <= monthDaily.length) running += monthDaily[i].net
    const actual = day <= monthDaily.length ? round(running) : null
    const forecast = day >= monthDaily.length ? round(mtd / Math.max(monthDaily.length, 1) * day) : null
    return { day, actual, forecast }
  })

  // Training and research jobs, one row per job and Taiwan day it ran: 'ok|…' or 'fail|…' with the runs and minutes that day.
  const JOB_DAYS = [['pipeline-v2', 'weekday', 42], ['screener-v2', 'weekday', 9], ['verify-v2', 'weekday', 6], ['active8-oof-materialize', 'weekday', 18],
    ['dataset-snapshot-export', 'weekday', 4], ['realtime-runtime', 'weekday', 270], ['optuna-research-sweep', 'mon-thu', 95], ['weekly-backtest-research', 'sunday', 140]]
  const jobDays = days(14).flatMap((d, i) => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay()
    return JOB_DAYS.filter(([, when]) => when === 'weekday' ? weekday(d) : when === 'sunday' ? dow === 0 : dow === 1 || dow === 4).map(([job, , minutes], j) => {
      const failed = (i * 5 + j * 3) % 19 === 0, runs = failed ? 2 : (i + j) % 7 === 0 ? 2 : 1
      const total = round(minutes * runs * (0.8 + rand() * 0.4), 0)
      return { time: midnight(d), job, cell: failed ? `fail|失敗 1／${runs} 次・${total} 分` : `ok|成功 ${runs} 次・${total} 分` }
    })
  })

  // Last result of each Cloud Run job, one row per run; the state holds until the next run.
  const jobRuns = days(14).flatMap((d, i) => jobs.filter(([, task]) => task !== 'weekly' || new Date(`${d}T00:00:00Z`).getUTCDay() === 0)
    .map(([job], j) => ({ time: new Date(Date.parse(`${d}T00:00:00+08:00`) + (18 + j) * 3600_000).toISOString(), job,
      result: (i * 7 + j * 3) % 17 === 0 ? 'failed' : 'success' })))
  return {
    'plan:chain-slack': { deadline_ms: pipelineDeadline == null ? null : CLOCK_BASE + pipelineDeadline * 60_000, rows: slackRows },
    'plan:cloudflare-d1-grid': { rows: d1Grid },
    'mock:billing-month-by-service': { rows: monthByService },
    'mock:billing-month-cumulative': { rows: cumulative },
    'plan:cloud-run-job-runs': { rows: jobRuns },
    'plan:cloud-run-job-days': { rows: jobDays },
    'mock:billing-by-service': { rows: billingRows },
    'mock:billing-month-daily': { rows: daily(month) },
    'mock:billing-recent-daily': { rows: daily(billingRows) },
    'mock:billing-forecast': { rows: [{ mtd: round(mtd), forecast: round(mtd / elapsed * monthDays) }] },
    // Names fit under a gauge; the period (本月, KV 今日) is in the panel description.
    'plan:cloudflare-quota': { rows: [['Workers 請求', 41], ['D1 讀取', 87], ['D1 寫入', 34], ['D1 儲存', 62], ['KV 讀取', 9],
      ['R2 儲存', 18]].map(([product, pct]) => ({ product, pct })) },
    'plan:cloudflare-d1-rows': { rows: Array.from({ length: 30 * 24 }, (_, i) => {
      const at = now - (30 * 24 - 1 - i) * 3600_000
      return { time: new Date(at - at % 3600_000).toISOString(), ...d1Load(at) }
    }) },
    '/v1/paper/nav?days=90': { ...head(300), account_id: 1, today, since: navDays[0], days: 90, index_source: 'core.market_risk.twii_close',
      summary: { latest_date: lastNav.date, nav: lastNav.nav, nav_return_pct: lastNav.nav_return_pct, twii_as_of: lastIndexed.date, twii_return_pct: lastIndexed.twii_return_pct,
        excess_return_pct: lastIndexed.excess_return_pct, drawdown_pct: lastNav.drawdown_pct, min_drawdown_pct: Math.min(...navRows.map((row) => row.drawdown_pct)),
        pnl_pct_since_inception: lastNav.nav_return_pct, max_drawdown_to_date_pct: null, positions: 9, orders_today: 4, buys_today: 3, sells_today: 1, intents_today: 4 },
      rows: navRows, positions: [], orders_today: [], intents_today: [] },
    '/v1/models/roster': { ...head(3600), roster_status: 'published', roster_error: null, model_count: MODELS.length,
      ensemble: { artifact_id: 'ens-nov', cohort_id: 'core4', state: 'production', promoted_at: '2026-11-24T10:55:24Z', promotion_reason: 'monthly_cutover',
        knowledge_cutoff_date: '2026-10-29', training_run_id: 'run-nov', validation_decision: 'PASS', validation: { decision: 'PASS' } },
      rows: MODELS.map((model, slot) => ({ model_name: model, slot, champion_version: 'v-run-nov', champion_artifact_id: `${model}:run-nov:oof_full_fit_release`,
        champion_promoted_at: '2026-11-24 10:55:24', champion_promotion_reason: 'monthly_cutover', gate_training_run_id: 'run-nov', version: 'v-run-nov',
        state: 'production', source_run_date: '2026-11-05', gate_decision: 0.041 - slot * 0.008 < 0.02 ? 'FAIL' : 'PASS',
        failed_gates: 0.041 - slot * 0.008 < 0.02 ? ['min_oos_ic_mean'] : [],
        oos_ic: round(0.041 - slot * 0.008, 4), min_oos_ic_mean: 0.02, weak_oos_ic_mean: 0.015, strong_oos_ic_mean: 0.035, max_pbo: 0.5,
        live_gate_status: 'pending', promotion_decision: 'promoted' })),
      latest_monthly_run: { training_run_id: 'run-nov', source_run_date: '2026-11-05', is_live: true, models: [] },
      next_monthly_run: { job_id: 'active8-oof-monthly', schedule: 'first sun of month 02:00', time_zone: 'Asia/Taipei', repo_desired_state: 'ENABLED',
        next_run_at: '2026-12-06T02:00+08:00' } },
    '/v1/opb?days=60': { ...head(900), account_id: 1, since: opbDays[0], days: 60, definitions: {},
      summary: { plan_days: opbRows.length, latest_signal_date: opbRows.at(-1).signal_date, latest_arm_id: opbRows.at(-1).arm_id, latest_status: opbRows.at(-1).status,
        arm_inert_days: inertDays, clip_rate: round(inertDays / opbRows.length, 4), receipts: opbRows.length - 2, complete_receipts: opbRows.length - 6,
        receipt_coverage: round((opbRows.length - 2) / opbRows.length, 4), replay_rows_current_context: 132, current_context_identity: 'ctx-current',
        latest_arm_samples_total: 132, linucb_ledger_rows: 80, linucb_last_reward_at: `${date(-1)} 15:10:00` },
      rows: opbRows, arm_share: share,
      latest_arm_statistics: ARMS.map((arm, i) => ({ arm_id: arm, samples: 14 + i * 5 + Math.floor(rand() * 6), effective_samples: 10 + i * 4,
        mean: round((rand() - 0.4) * 0.01, 5), lower_bound: round((rand() - 0.7) * 0.01, 5) })),
      receipts: [], replay: [], linucb_ledger: [] },
    '/v1/chain/failure-classes?days=14': { ...head(300), since: date(-13), days: 14, tickets_read: failureRows.length, truncated: false,
      final_lookups: failureRows.length, final_lookups_truncated: false, classes, rows: failureRows, by_job: [] },
    '/v1/kv-drift': { ...head(1800), job_id: 'kv-config-drift', since: date(-6), days: 7, latest: kvRows[0], rows: kvRows },
  }
}
