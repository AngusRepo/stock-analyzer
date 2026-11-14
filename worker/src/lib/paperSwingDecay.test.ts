import assert from 'node:assert/strict'
import test from 'node:test'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { withPaperExecutionScope } from './paperExecutionScope'
import { readSwingState, writeSwingState } from './paperSwingLifecycle'
import { applySwingDecay, assessSwingExit, closeSwingSession, ORL_SWING_EXIT, swingDecayEvidence, swingExitRules,
  SWING_POLICY_VERSION, type SwingPositionState } from './paperSwingPolicy'
import { swingExitEvaluator } from './paperSwingRuntime'
import { checkExitConditions } from './paperExitPolicy'
import { updateLifecycleS12TrailingStop } from './paperExitTasks'

const R33 = 'r33_roster_isotonic_v1'
const r33Config = (exit: unknown = { swingHardStopPct: -.08, swingMaxHoldSessions: 20 }) =>
  ({ l4Distribution: { operating_mode: R33 }, exit }) as any
const state: SwingPositionState = { policy: SWING_POLICY_VERSION, entryDate: '2026-10-02', entryPrice: 100, entryOrLow: 97 }
const calendar = ['2026-10-02', '2026-10-05', '2026-10-06']

test('exit rules: ORL rules outside R33, KV-owned decay rules under R33, no built-in fallback', () => {
  assert.equal(swingExitRules({}), ORL_SWING_EXIT)
  assert.equal(swingExitRules({ l4Distribution: { operating_mode: 'l4_mlp_v1' }, exit: { swingHardStopPct: -.5, swingMaxHoldSessions: 3 } }), ORL_SWING_EXIT)
  assert.deepEqual(swingExitRules(r33Config({ swingHardStopPct: -.1, swingMaxHoldSessions: 15 })), { decay: true, hardStopMultiplier: .9, maxHoldSessions: 15 })
  assert.equal(swingExitRules(r33Config()).hardStopMultiplier, ORL_SWING_EXIT.hardStopMultiplier)
  assert.throws(() => swingExitRules({ l4Distribution: { operating_mode: R33 } }), /swing_exit_rules_invalid:swingHardStopPct/)
  for (const bad of [null, {}, { swingHardStopPct: -.08 }, { swingHardStopPct: 0, swingMaxHoldSessions: 20 }, { swingHardStopPct: -.08, swingMaxHoldSessions: 0 }])
    assert.throws(() => swingExitRules(r33Config(bad)), /swing_exit_rules_invalid/)
})

test('decay evidence: E-hat from the R33 plan for that signal date; anything missing is a recorded skip', () => {
  const plan = { signal_date: '2026-10-02', r33_projection: {}, targets: { '2340': { expected_return_gross: -.01, ehat_missing_reason: null } } }
  assert.deepEqual(swingDecayEvidence(plan, '2340', '2026-10-02'), { ehat: -.01 })
  assert.deepEqual(swingDecayEvidence(plan, '2340', '2026-10-05'), { skip: 'ehat_plan_signal_date_mismatch' })
  const { r33_projection: _, ...legacy } = plan
  assert.deepEqual(swingDecayEvidence(legacy, '2340', '2026-10-02'), { skip: 'ehat_plan_not_r33' })
  assert.deepEqual(swingDecayEvidence(plan, '1101', '2026-10-02'), { skip: 'ehat_target_missing' })
  assert.deepEqual(swingDecayEvidence({ ...plan, targets: { '2340': { expected_return_gross: null, ehat_missing_reason: 'suspended' } } }, '2340', '2026-10-02'), { skip: 'suspended' })
  assert.deepEqual(swingDecayEvidence({ ...plan, targets: { '2340': { expected_return_gross: null } } }, '2340', '2026-10-02'), { skip: 'ehat_value_missing' })
})

test('E-hat <= 0 exits at the next open; positive or missing E-hat holds; an earlier exit is kept', () => {
  const input = { signalDate: '2026-10-02', openMs: Date.parse('2026-10-05T09:05:00+08:00') }
  assert.deepEqual(applySwingDecay(state, { ehat: 0 }, input).pendingExit, { reason: 'swing_ehat_decay', notBeforeMs: input.openMs })
  assert.equal(applySwingDecay(state, { ehat: .001 }, input).pendingExit, undefined)
  const skipped = applySwingDecay(state, { skip: 'suspended' }, input)
  assert.equal(skipped.pendingExit, undefined); assert.equal(skipped.decayCheckedSignalDate, '2026-10-02')
  const stop = { ...state, pendingExit: { reason: 'swing_hard_stop_8' as const, notBeforeMs: 1 } }
  assert.deepEqual(applySwingDecay(stop, { ehat: -1 }, input).pendingExit, stop.pendingExit)
  const sell = assessSwingExit({ ...state, pendingExit: { reason: 'swing_ehat_decay', notBeforeMs: input.openMs } },
    { date: '2026-10-05', nowMs: input.openMs, price: 101, calendar }, swingExitRules(r33Config()))
  assert.deepEqual(sell, { action: 'full_sell', reason: 'swing_ehat_decay', exitIntentKind: 'model_exit' })
})

test('under R33 the ORL never exits, and the stop and holding limit follow the KV rules', () => {
  const close = { date: '2026-10-02', close: 90, observedAtMs: Date.parse('2026-10-02T13:30:00+08:00'), nextSession: '2026-10-05', calendar }
  assert.equal(closeSwingSession(state, close).pendingExit?.reason, 'swing_daily_orl')
  assert.equal(closeSwingSession(state, close, swingExitRules(r33Config())).pendingExit, undefined)
  const short = swingExitRules(r33Config({ swingHardStopPct: -.1, swingMaxHoldSessions: 1 }))
  assert.equal(closeSwingSession(state, { ...close, date: '2026-10-05', nextSession: '2026-10-06', observedAtMs: Date.parse('2026-10-05T13:30:00+08:00') }, short).pendingExit?.reason, 'swing_20_sessions')
  const at = { date: '2026-10-05', nowMs: Date.parse('2026-10-05T10:00:00+08:00'), price: 91, calendar }
  assert.equal(assessSwingExit(state, at).reason, 'swing_hard_stop_8')
  assert.equal(assessSwingExit(state, at, short).reason, 'swing_hold')
  assert.equal(assessSwingExit(state, { ...at, nowMs: Date.parse('2026-10-05T13:24:00+08:00') }, short).reason, 'swing_20_sessions')
  assert.equal(assessSwingExit(state, { ...at, date: '2026-10-02' }, short).reason, 'swing_hold')
  assert.equal(JSON.parse(writeSwingState({}, state, short)).exit.initialStop, 90)
  assert.equal(JSON.parse(writeSwingState({}, state)).exit.initialStop, 92)
})

function seeded(nowIso: string) {
  const f = l4NativeFixture(); f.ports.nowMs = Date.parse(nowIso)
  f.sqls.core.exec("INSERT INTO stocks(id,symbol,name) VALUES(1,'0050','ETF'),(2,'2340','stock')")
  f.sqls.market.exec("INSERT INTO stock_prices(stock_id,date,close) VALUES(1,'2026-10-02',100),(2,'2026-10-02',96)")
  const lifecycle = writeSwingState({ version: 'canonical_trade_lifecycle_v1' }, state)
  f.sqls.paper.prepare('INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,trade_lifecycle_json) VALUES(1,?,?,?,?,?)')
    .run('2340', 'stock', 1000, 100, lifecycle)
  const plan = (target: Record<string, unknown>, signalDate = '2026-10-02', planId = 'p'.repeat(64)) => f.sqls.paper.prepare(`INSERT INTO l4_portfolio_plans_v1
    (plan_id,account_id,signal_date,policy_identity,activated,allocation_snapshot_id,payload_json) VALUES(?,1,?,?,1,?,?)`)
    .run(planId, signalDate, 'i'.repeat(64), 's'.repeat(64),
      JSON.stringify({ signal_date: signalDate, r33_projection: {}, targets: { '2340': target } }))
  const shadow = () => f.sqls.paper.prepare('SELECT caller,actual_action,actual_reason,hypothetical_order,hypothetical_mult FROM exit_shadow_log').all() as any[]
  return { f, pos: { symbol: '2340', trade_lifecycle_json: lifecycle as unknown }, plan, shadow }
}

test('runtime: E-hat <= 0 in the previous session plan sells at the open and logs the ORL arm', async () => {
  const { f, pos, plan, shadow } = seeded('2026-10-05T09:05:00+08:00')
  try {
    plan({ expected_return_gross: -.002, ehat_missing_reason: null })
    await withPaperExecutionScope(f.ports, async () => {
      const decision = await swingExitEvaluator(f.env, [pos], '2026-10-05', r33Config())(pos, 105)
      assert.deepEqual(decision, { action: 'full_sell', reason: 'swing_ehat_decay', exitIntentKind: 'model_exit' })
      assert.equal(readSwingState(pos.trade_lifecycle_json)?.decayCheckedSignalDate, '2026-10-02')
    })
    const [row] = shadow()
    assert.equal(row.caller, 'r33-ehat-decay-stop-age-v1'); assert.equal(row.actual_action, 'pending_exit')
    assert.equal(row.actual_reason, 'swing_ehat_decay')
    assert.deepEqual(JSON.parse(row.hypothetical_order), { rule: 'swing_daily_orl', close_date: '2026-10-02', close: 96, entry_or_low: 97, would_exit: true })
    assert.deepEqual(JSON.parse(row.hypothetical_mult), { signal_date: '2026-10-02', ehat: -.002 })
  } finally { f.close() }
})

test('runtime: positive E-hat holds although the ORL would have exited; checked once per signal date', async () => {
  const { f, pos, plan, shadow } = seeded('2026-10-05T09:05:00+08:00')
  try {
    plan({ expected_return_gross: .004, ehat_missing_reason: null })
    await withPaperExecutionScope(f.ports, async () => {
      const run = swingExitEvaluator(f.env, [pos], '2026-10-05', r33Config())
      assert.equal((await run(pos, 105))?.reason, 'swing_hold')
      assert.equal((await run(pos, 105))?.reason, 'swing_hold')
      assert.equal((await swingExitEvaluator(f.env, [pos], '2026-10-05', r33Config())(pos, 92))?.reason, 'swing_hard_stop_8')
    })
    assert.deepEqual(shadow().map(r => [r.actual_action, r.actual_reason]), [['hold', 'swing_ehat_positive']])
  } finally { f.close() }
})

test('runtime: missing E-hat skips the decay exit and records exit_skip_reason', async () => {
  const { f, pos, plan, shadow } = seeded('2026-10-05T09:05:00+08:00')
  try {
    plan({ expected_return_gross: null, ehat_missing_reason: 'r33_rank_pool_missing' })
    await withPaperExecutionScope(f.ports, async () => {
      assert.equal((await swingExitEvaluator(f.env, [pos], '2026-10-05', r33Config())(pos, 105))?.reason, 'swing_hold')
    })
    assert.deepEqual(shadow().map(r => [r.actual_action, r.actual_reason]), [['skip', 'exit_skip_reason:r33_rank_pool_missing']])
  } finally { f.close() }
})

test('runtime: before the plan is activated the decay check waits and leaves no record', async () => {
  const { f, pos, plan, shadow } = seeded('2026-10-05T09:05:00+08:00')
  try {
    await withPaperExecutionScope(f.ports, async () => {
      assert.equal((await swingExitEvaluator(f.env, [pos], '2026-10-05', r33Config())(pos, 105))?.reason, 'swing_hold')
      assert.equal(readSwingState(pos.trade_lifecycle_json)?.decayCheckedSignalDate, undefined)
      plan({ expected_return_gross: -.01, ehat_missing_reason: null })
      assert.equal((await swingExitEvaluator(f.env, [pos], '2026-10-05', r33Config())(pos, 105))?.reason, 'swing_ehat_decay')
    })
    assert.equal(shadow().length, 1)
  } finally { f.close() }
})

test('runtime: a malformed R33 exit config holds and never substitutes built-in values', async () => {
  const { f, pos } = seeded('2026-10-05T09:05:00+08:00')
  try {
    await withPaperExecutionScope(f.ports, async () => {
      assert.match((await swingExitEvaluator(f.env, [pos], '2026-10-05', r33Config(null))(pos, 80))!.reason, /swing_exit_rules_invalid/)
      // A second poll builds a new evaluator; the alert is still one row for the date.
      assert.match((await swingExitEvaluator(f.env, [pos], '2026-10-05', r33Config(null))(pos, 80))!.reason, /swing_exit_rules_invalid/)
      const alerts = f.sqls.ops.prepare("SELECT level,cron_name FROM system_logs WHERE cron_name='swing-exit'").all() as any[]
      assert.deepEqual(alerts.map(r => [r.level, r.cron_name]), [['error', 'swing-exit']])
      // Another date is another alert; an alert that cannot be written still leaves the hold.
      await swingExitEvaluator(f.env, [pos], '2026-10-07', r33Config(null))(pos, 80)
      assert.equal((f.sqls.ops.prepare("SELECT COUNT(*) AS n FROM system_logs WHERE cron_name='swing-exit'").get() as any).n, 2)
      const legacy = { ...f.cfg, l4Distribution: { ...(f.cfg as any).l4Distribution, operating_mode: R33 }, exit: { ...f.cfg.exit, swingHardStopPct: -.2, swingMaxHoldSessions: 20 } }
      const position = { symbol: '2340', shares: 1000, avg_cost: 100, entry_price: 100, trade_lifecycle_json: pos.trade_lifecycle_json } as any
      assert.equal(checkExitConditions(position, 85, 3, false, false, legacy as any).action, 'hold')
      assert.equal(checkExitConditions(position, 80, 3, false, false, legacy as any).reason, 'swing_hard_stop_8')
      assert.match(checkExitConditions(position, 80, 3, false, false, { ...legacy, exit: f.cfg.exit } as any).reason, /swing_exit_rules_invalid/)
    })
    // Outside the paper scope the ops lookup itself throws (no binding); the evaluator still holds.
    const noOps = { ...f.env, OPS_DB: undefined }
    assert.match((await swingExitEvaluator(noOps, [pos], '2026-10-08', r33Config(null))(pos, 80))!.reason, /swing_exit_rules_invalid/)
  } finally { f.close() }
})

test('runtime: the decay exit waits for 09:05, and a non-default KV stop moves the hard stop', async () => {
  const { f, pos, plan } = seeded('2026-10-05T09:00:00+08:00')
  try {
    plan({ expected_return_gross: -.01, ehat_missing_reason: null })
    await withPaperExecutionScope(f.ports, async () => {
      const wide = r33Config({ swingHardStopPct: -.2, swingMaxHoldSessions: 20 })
      assert.equal((await swingExitEvaluator(f.env, [pos], '2026-10-05', wide)(pos, 85))?.reason, 'swing_hold')
      assert.equal(readSwingState(pos.trade_lifecycle_json)?.pendingExit?.reason, 'swing_ehat_decay')
      assert.equal((await swingExitEvaluator(f.env, [pos], '2026-10-05', wide)(pos, 80))?.reason, 'swing_hard_stop_8')
    })
  } finally { f.close() }
})

test('runtime: no decay check on the plan that preceded the entry', async () => {
  const { f, plan, shadow } = seeded('2026-10-05T09:05:00+08:00')
  try {
    const entry = writeSwingState({ version: 'canonical_trade_lifecycle_v1' }, { ...state, entryDate: '2026-10-05' })
    f.sqls.paper.prepare('UPDATE paper_positions SET trade_lifecycle_json=? WHERE symbol=?').run(entry, '2340')
    const pos = { symbol: '2340', trade_lifecycle_json: entry as unknown }
    plan({ expected_return_gross: -.01, ehat_missing_reason: null })
    await withPaperExecutionScope(f.ports, async () => {
      assert.equal((await swingExitEvaluator(f.env, [pos], '2026-10-05', r33Config())(pos, 105))?.reason, 'swing_hold')
    })
    assert.equal(shadow().length, 0)
  } finally { f.close() }
})

test('runtime: two activated plans for one date, or no plan after the close, are recorded skips', async () => {
  for (const kind of ['ambiguous', 'missing'] as const) {
    const { f, pos, plan, shadow } = seeded(kind === 'missing' ? '2026-10-05T13:31:00+08:00' : '2026-10-05T09:05:00+08:00')
    try {
      if (kind === 'ambiguous') {
        plan({ expected_return_gross: -.01, ehat_missing_reason: null })
        plan({ expected_return_gross: -.01, ehat_missing_reason: null }, '2026-10-02', 'q'.repeat(64))
      }
      await withPaperExecutionScope(f.ports, async () => {
        assert.equal((await swingExitEvaluator(f.env, [pos], '2026-10-05', r33Config())(pos, 105))?.action, 'hold')
      })
      assert.deepEqual(shadow().map(r => r.actual_reason), ['exit_skip_reason:ehat_plan_' + kind])
      assert.equal(readSwingState(pos.trade_lifecycle_json)?.pendingExit, undefined)
    } finally { f.close() }
  }
})


test('S12 trailing-stop rewrite of a swing lifecycle takes the stop from the KV rules, never the ORL default', () => {
  const raw = writeSwingState({ version: 'canonical_trade_lifecycle_v1' }, state)
  const stop = (json: string | null) => JSON.parse(json!).exit.initialStop
  assert.equal(stop(updateLifecycleS12TrailingStop(raw, 95, 's12', r33Config({ swingHardStopPct: -.2, swingMaxHoldSessions: 20 }))), 80)
  assert.equal(stop(updateLifecycleS12TrailingStop(raw, 95, 's12', { exit: {} } as any)), 100 * ORL_SWING_EXIT.hardStopMultiplier)
  // A malformed R33 config leaves the stored lifecycle untouched.
  const wide = writeSwingState({ version: 'canonical_trade_lifecycle_v1' }, state, { ...ORL_SWING_EXIT, hardStopMultiplier: .7 })
  assert.equal(updateLifecycleS12TrailingStop(wide, 95, 's12', r33Config(null)), wide)
})
