/** /v1/opb: is the online portfolio bandit learning (p4_sources.md §4). Per signal date the chosen arm and status
 * from the plan's $.opb (json_extract only: payloads are 0.8-1.7 MB), the account reward receipts, the arm replay
 * of the current context (the v2 learning source), and the LinUCB reward ledger. Counts only, no trading judgment.
 * Definitions (p4 open questions 6 and 7, simplest stored reading; the owner may change them):
 * - arm share: the arm's signal dates ÷ signal dates with a plan (one plan per date: activated, then newest).
 * - clip rate: dates with $.opb.arm_inert = 1 (risk limits collapsed every arm into one effective group) ÷ plan
 *   dates. effective_groups and arm_count are served per date for the 1 − groups ÷ arms reading.
 * - reward receipts: receipts with known_date in the window, and how many are complete (learnable); the replay
 *   rows of the latest plan's context are served next to them, since v2 learns from replay, not receipts. */
import { addDays, twDate, type MonitoringEnv } from './env'
import { PAPER_ACCOUNT_ID } from './paperNav'

const PLANS_SQL = `SELECT plan_id, signal_date, activated, created_at,
       json_extract(payload_json, '$.opb.enabled') AS enabled, json_extract(payload_json, '$.opb.arm_id') AS arm_id,
       json_extract(payload_json, '$.opb.status') AS status, json_extract(payload_json, '$.opb.arm_inert') AS arm_inert,
       json_array_length(payload_json, '$.opb.effective_groups') AS effective_groups,
       json_extract(payload_json, '$.opb.context_identity') AS context_identity,
       json_extract(payload_json, '$.opb.schema_version') AS schema_version,
       payload_json -> '$.opb.arm_statistics' AS arm_statistics_json
  FROM l4_portfolio_plans_v1 WHERE account_id = ? AND signal_date >= ?`
// known_date has no index (WHERE known_date >= ? is a SCAN): read the rowid tail instead. One receipt per trading
// day and inserts never conflict-skip a rowid, so the last `days` rowids hold every receipt of a `days`-day window.
const RECEIPTS_SQL = `SELECT receipt_id, known_date, policy_identity,
       json_extract(payload_json, '$.arm_id') AS arm_id, json_extract(payload_json, '$.complete') AS complete,
       json_extract(payload_json, '$.reason') AS reason, json_extract(payload_json, '$.reward') AS reward,
       json_extract(payload_json, '$.arm_inert') AS arm_inert
  FROM l4_policy_account_rewards_v1 WHERE rowid > (SELECT MAX(rowid) FROM l4_policy_account_rewards_v1) - ?`
const REPLAY_SQL = `SELECT signal_date, known_date, arm_id, arm_return, base_return, delta, arm_inert, status
  FROM l4_opb_arm_replay_v1 WHERE context_identity = ? AND signal_date >= ?`
const LEDGER_SQL = `SELECT arm_id, context_hash, samples, reward_sum, reward_mean, last_reward_at, updated_at
  FROM meta_reward_ledger WHERE policy_id = 'LinUCB'`

type PlanRow = { plan_id: string; signal_date: string; activated: number; created_at: string; enabled: number | null
  arm_id: string | null; status: string | null; arm_inert: number | null; effective_groups: number | null
  context_identity: string | null; schema_version: string | null; arm_statistics_json: string | null }
type ArmStatistics = Record<string, { samples?: number; effective_samples?: number; mean?: number | null; lower_bound?: number | null }>
type LedgerRow = { arm_id: string; context_hash: string; samples: number; reward_sum: number; reward_mean: number | null
  last_reward_at: string | null; updated_at: string }

const ratio = (part: number, whole: number) => whole > 0 ? Math.round(part / whole * 1e4) / 1e4 : null

function armStatistics(text: string | null): ArmStatistics {
  try { return text ? JSON.parse(text) as ArmStatistics : {} } catch { return {} }
}

/** arm_inert / fixed_policy / forced plans store `$.opb.arm_statistics = {}`: the statistics are the newest plan's that
 * has any, with its date and context (statistics are per context, so they may predate the current one). */
export function latestArmStatistics(daily: Pick<PlanRow, 'signal_date' | 'context_identity' | 'arm_statistics_json'>[]) {
  for (let i = daily.length - 1; i >= 0; i -= 1) {
    const stats = armStatistics(daily[i].arm_statistics_json)
    if (Object.keys(stats).length) return { signal_date: daily[i].signal_date, context_identity: daily[i].context_identity, stats }
  }
  return { signal_date: null, context_identity: null, stats: {} as ArmStatistics }
}

export async function opbReport(env: MonitoringEnv, nowMs: number, days: number) {
  const since = addDays(twDate(nowMs), -(days - 1))
  const [plans, receipts, ledger] = await Promise.all([
    env.PAPER_DB.prepare(PLANS_SQL).bind(PAPER_ACCOUNT_ID, since).all<PlanRow>(),
    env.PAPER_DB.prepare(RECEIPTS_SQL).bind(days).all<Record<string, unknown>>(),
    env.LEARNING_DB.prepare(LEDGER_SQL).all<LedgerRow>(),
  ])
  const byDate = new Map<string, PlanRow>()
  for (const plan of plans.results ?? []) {
    const held = byDate.get(plan.signal_date)
    if (!held || plan.activated > held.activated || (plan.activated === held.activated && plan.created_at > held.created_at)) byDate.set(plan.signal_date, plan)
  }
  const daily = [...byDate.values()].sort((a, b) => a.signal_date.localeCompare(b.signal_date))
  const latest = daily.at(-1)
  const replay = latest?.context_identity
    ? (await env.LEARNING_DB.prepare(REPLAY_SQL).bind(latest.context_identity, since).all<Record<string, unknown>>()).results ?? []
    : []
  const rows = daily.map((plan) => {
    const armCount = Object.keys(armStatistics(plan.arm_statistics_json)).length
    return {
      signal_date: plan.signal_date, plan_id: plan.plan_id, activated: plan.activated === 1, enabled: plan.enabled === 1,
      arm_id: plan.arm_id, status: plan.status, arm_inert: plan.arm_inert === 1, effective_groups: plan.effective_groups,
      arm_count: armCount || null, context_identity: plan.context_identity, schema_version: plan.schema_version, plans_on_date:
        (plans.results ?? []).filter((row) => row.signal_date === plan.signal_date).length,
    }
  })
  const shares = new Map<string, number>()
  for (const row of rows) shares.set(row.arm_id ?? 'none', (shares.get(row.arm_id ?? 'none') ?? 0) + 1)
  const windowReceipts = (receipts.results ?? []).filter((row) => String(row.known_date) >= since)
    .sort((a, b) => String(a.known_date).localeCompare(String(b.known_date)))
  const inertDays = rows.filter((row) => row.arm_inert).length
  const completeReceipts = windowReceipts.filter((row) => row.complete === 1).length
  const ledgerByArm = new Map<string, { arm_id: string; contexts: number; samples: number; reward_sum: number; last_reward_at: string | null; updated_at: string }>()
  for (const row of ledger.results ?? []) {
    const arm = ledgerByArm.get(row.arm_id) ?? { arm_id: row.arm_id, contexts: 0, samples: 0, reward_sum: 0, last_reward_at: null, updated_at: '' }
    arm.contexts += 1
    arm.samples += Number(row.samples ?? 0)
    arm.reward_sum += Number(row.reward_sum ?? 0)
    if (row.last_reward_at && (!arm.last_reward_at || row.last_reward_at > arm.last_reward_at)) arm.last_reward_at = row.last_reward_at
    if (row.updated_at > arm.updated_at) arm.updated_at = row.updated_at
    ledgerByArm.set(row.arm_id, arm)
  }
  const { signal_date: statsDate, context_identity: statsContext, stats: latestStats } = latestArmStatistics(daily)
  return {
    account_id: PAPER_ACCOUNT_ID, since, days,
    definitions: {
      arm_share: 'signal dates on the arm / signal dates with a plan',
      clip_rate: 'signal dates with $.opb.arm_inert = 1 / signal dates with a plan',
      reward_receipts: 'account receipts with known_date in the window (complete = learnable); v2 learns from replay_rows_current_context',
    },
    summary: {
      plan_days: rows.length, latest_signal_date: latest?.signal_date ?? null, latest_arm_id: latest?.arm_id ?? null,
      latest_status: latest?.status ?? null, arm_inert_days: inertDays, clip_rate: ratio(inertDays, rows.length),
      receipts: windowReceipts.length, complete_receipts: completeReceipts, receipt_coverage: ratio(windowReceipts.length, rows.length),
      replay_rows_current_context: replay.length, current_context_identity: latest?.context_identity ?? null,
      latest_arm_statistics_signal_date: statsDate, latest_arm_statistics_context_identity: statsContext,
      latest_arm_samples_total: Object.values(latestStats).reduce((sum, arm) => sum + Number(arm.samples ?? 0), 0),
      linucb_ledger_rows: ledger.results?.length ?? 0,
      linucb_last_reward_at: [...ledgerByArm.values()].reduce<string | null>((max, arm) => arm.last_reward_at && (!max || arm.last_reward_at > max) ? arm.last_reward_at : max, null),
    },
    rows,
    arm_share: [...shares.entries()].map(([arm_id, plan_days]) => ({ arm_id, plan_days, share: ratio(plan_days, rows.length) }))
      .sort((a, b) => b.plan_days - a.plan_days || a.arm_id.localeCompare(b.arm_id)),
    latest_arm_statistics: Object.entries(latestStats).map(([arm_id, stats]) => ({
      arm_id, samples: stats.samples ?? null, effective_samples: stats.effective_samples ?? null, mean: stats.mean ?? null, lower_bound: stats.lower_bound ?? null,
    })),
    receipts: windowReceipts,
    replay: replay.sort((a, b) => String(a.signal_date).localeCompare(String(b.signal_date)) || String(a.arm_id).localeCompare(String(b.arm_id))),
    linucb_ledger: [...ledgerByArm.values()].map((arm) => ({ ...arm, reward_mean: arm.samples > 0 ? arm.reward_sum / arm.samples : null }))
      .sort((a, b) => a.arm_id.localeCompare(b.arm_id)),
  }
}
