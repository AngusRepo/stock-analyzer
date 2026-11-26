import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { twTimeOn } from '../chain'
import { CHAIN_IDS, CHAIN_SPECS, isWatcherStage, periodKeyFor, periodKeys, previousPeriodKey, REPEAT_REFRESH_MIN_MS, REPEAT_STALL_AFTER_MS, type ChainId } from './chainCatalog'
import { chainStageIds, OTHER_CHAIN_PHASES } from './chainPhases'
import { STAGES } from './executionChainDag'

// The writer (worker/src/lib/opsChainStageCatalog.ts, P2b) is on branch feat/obs-p2b-other-chains, not in this
// tree yet, so its functions cannot be imported here. These tables are its output, generated on 11/25 by running
// periodKeyFor / stageExpectedByUtc / CHAIN_DEFINITIONS of that branch; once it lands here the test also compares
// against it directly (below). Dates: every weekday, month starts on a Sunday (2026-02, 2026-03, 2026-11,
// 2027-08) and a Saturday (2026-08), the year end, a leap day.
const PERIOD_KEYS: Array<[date: string, intraday: string, weekly: string, monthly: string]> = [
  ['2026-10-30', '2026-10-30', '2026-10-30', '2026-10-03'],
  ['2026-10-31', '2026-10-31', '2026-10-30', '2026-10-03'],
  ['2026-11-01', '2026-11-01', '2026-10-30', '2026-11-07'],
  ['2026-11-02', '2026-11-02', '2026-10-30', '2026-11-07'],
  ['2026-11-05', '2026-11-05', '2026-10-30', '2026-11-07'],
  ['2026-11-06', '2026-11-06', '2026-11-06', '2026-11-07'],
  ['2026-11-07', '2026-11-07', '2026-11-06', '2026-11-07'],
  ['2026-11-08', '2026-11-08', '2026-11-06', '2026-11-07'],
  ['2026-11-20', '2026-11-20', '2026-11-20', '2026-11-07'],
  ['2026-11-21', '2026-11-21', '2026-11-20', '2026-11-07'],
  ['2026-11-22', '2026-11-22', '2026-11-20', '2026-11-07'],
  ['2026-11-24', '2026-11-24', '2026-11-20', '2026-11-07'],
  ['2026-11-25', '2026-11-25', '2026-11-20', '2026-11-07'],
  ['2026-11-26', '2026-11-26', '2026-11-20', '2026-11-07'],
  ['2026-11-27', '2026-11-27', '2026-11-27', '2026-11-07'],
  ['2026-11-30', '2026-11-30', '2026-11-27', '2026-11-07'],
  ['2026-12-01', '2026-12-01', '2026-11-27', '2026-12-05'],
  ['2026-12-04', '2026-12-04', '2026-12-04', '2026-12-05'],
  ['2026-12-05', '2026-12-05', '2026-12-04', '2026-12-05'],
  ['2026-12-31', '2026-12-31', '2026-12-25', '2026-12-05'],
  ['2027-01-01', '2027-01-01', '2027-01-01', '2027-01-02'],
  ['2027-01-02', '2027-01-02', '2027-01-01', '2027-01-02'],
  ['2026-02-01', '2026-02-01', '2026-01-30', '2026-02-07'],
  ['2026-02-07', '2026-02-07', '2026-02-06', '2026-02-07'],
  ['2026-03-01', '2026-03-01', '2026-02-27', '2026-03-07'],
  ['2026-03-06', '2026-03-06', '2026-03-06', '2026-03-07'],
  ['2026-03-07', '2026-03-07', '2026-03-06', '2026-03-07'],
  ['2026-08-01', '2026-08-01', '2026-07-31', '2026-08-01'],
  ['2026-08-02', '2026-08-02', '2026-07-31', '2026-08-01'],
  ['2027-08-01', '2027-08-01', '2027-07-30', '2027-08-07'],
  ['2027-08-07', '2027-08-07', '2027-08-06', '2027-08-07'],
  ['2028-02-29', '2028-02-29', '2028-02-25', '2028-02-05'],
  ['2028-03-03', '2028-03-03', '2028-03-03', '2028-03-04'],
  ['2028-04-01', '2028-04-01', '2028-03-31', '2028-04-01'],
]

/** stageExpectedByUtc(key, first catalog stage) of the writer: the missed cut-off. */
const FIRST_DEADLINES: Array<[chain: ChainId, stage: string, key: string, utc: string]> = [
  ['intraday_guard', 'intraday-check', '2026-11-20', '2026-11-20T01:10:00.000Z'],
  ['weekly_research', 'weekly-audit', '2026-11-20', '2026-11-20T11:00:00.000Z'],
  ['monthly_artifact', 'monthly-strategy-mining', '2026-11-20', '2026-11-20T05:00:00.000Z'],
]

/** The writer's refresh throttle of a repeating stage (opsChainStageState.ts CHAIN_STAGE_HEARTBEAT_MIN_MS) and its
 * one repeating stage (catalog `repeat: true`). */
const WRITER_REPEAT = { refreshMinMs: 5 * 60_000, chain: 'intraday_guard' as const, stageId: 'intraday-check' }

/** The writer's CHAIN_DEFINITIONS stages: id → optional (intraday-check is its one `repeat` stage). */
const WRITER_STAGES: Record<Exclude<ChainId, 'daily_readiness'>, Record<string, boolean>> = {
  intraday_guard: { 'intraday-check': false, 'eod-exit': false, 'post-close-price-refresh': false, 'daily-snapshot': false,
    'rescore-10': false, 'rescore-11': false, 'rescore-12': false, 'rescore-1230': false },
  weekly_research: { 'weekly-audit': false, 'storage-integrity-audit': false, 'model-ic-full-check': false, 'weekly-backtest': false,
    'alpha-quality': false, 'active8-oof-weekly': false, 'weekly-optuna': true, 'sector-leaders': true, 'adaptive-meta-policy-replay': true,
    's12-smcvwap-calibration': true, 'linucb-multiplier-replay': true, 'weekly-cleanup': false, 'weekly-readiness': false },
  monthly_artifact: { 'monthly-strategy-mining': false, 'monthly-optuna': false, 'active8-oof-monthly': false, 'monthly-readiness': false },
}

test('periodKeyFor is the writer\'s (table taken from opsChainStageCatalog.ts, P2b)', () => {
  for (const [date, intraday, weekly, monthly] of PERIOD_KEYS) {
    assert.deepEqual([periodKeyFor('daily_readiness', date), periodKeyFor('intraday_guard', date), periodKeyFor('weekly_research', date),
      periodKeyFor('monthly_artifact', date)], [date, intraday, weekly, monthly], date)
  }
  assert.deepEqual([periodKeyFor('weekly_research', 'bad'), periodKeyFor('weekly_research', '2026-13-01'), periodKeyFor('nope', '2026-11-25')], [null, null, null])
})

test('previous period keys: a week earlier; the previous month\'s first Saturday', () => {
  assert.equal(previousPeriodKey('weekly_research', '2026-11-20'), '2026-11-13')
  assert.equal(previousPeriodKey('monthly_artifact', '2026-11-07'), '2026-10-03')
  assert.equal(previousPeriodKey('monthly_artifact', '2027-01-02'), '2026-12-05')
  assert.equal(previousPeriodKey('intraday_guard', '2026-11-24'), null)
  assert.deepEqual(periodKeys('weekly_research', '2026-11-20', 5), ['2026-11-20', '2026-11-13', '2026-11-06', '2026-10-30', '2026-10-23'])
  // Every key's previous is the key of the day before its period starts.
  for (const [, , weekly, monthly] of PERIOD_KEYS) {
    assert.equal(previousPeriodKey('weekly_research', weekly), periodKeyFor('weekly_research', new Date(Date.parse(`${weekly}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)))
    assert.equal(previousPeriodKey('monthly_artifact', monthly), periodKeyFor('monthly_artifact', new Date(Date.parse(`${monthly.slice(0, 7)}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)))
  }
})

test('the missed cut-off is the writer\'s first-stage deadline; the stages are its catalog\'s', () => {
  for (const [chain, stage, key, utc] of FIRST_DEADLINES) {
    assert.equal(CHAIN_SPECS[chain].firstStage, stage)
    assert.equal(new Date(twTimeOn(key, CHAIN_SPECS[chain].firstDeadlineTw)!).toISOString(), utc, chain)
  }
  for (const [chain, stages] of Object.entries(WRITER_STAGES) as Array<[Exclude<ChainId, 'daily_readiness'>, Record<string, boolean>]>) {
    assert.deepEqual([...chainStageIds(chain)].sort(), Object.keys(stages).sort(), chain)
    for (const [id, optional] of Object.entries(stages)) assert.equal(Boolean(STAGES[id]?.optional), optional, id)
    // Every stage is in exactly one presentation phase; a phase's lane is part of its stages.
    const phased = OTHER_CHAIN_PHASES[chain].flatMap((phase) => phase.stages)
    assert.deepEqual([...phased].sort(), Object.keys(stages).sort(), `${chain} phases`)
    for (const phase of OTHER_CHAIN_PHASES[chain]) assert.ok(phase.main.every((id) => phase.stages.includes(id)), phase.id)
  }
  assert.deepEqual([...CHAIN_IDS], ['daily_readiness', 'intraday_guard', 'weekly_research', 'monthly_artifact'])
})

test('stall judgment: the writer\'s refresh throttle, the repeating stage, and the scheduler\'s last intraday-check run', () => {
  assert.equal(REPEAT_REFRESH_MIN_MS, WRITER_REPEAT.refreshMinMs)
  assert.ok(REPEAT_STALL_AFTER_MS > REPEAT_REFRESH_MIN_MS + 60_000, 'a healthy row is at most one throttle plus one cron minute old')
  assert.deepEqual(CHAIN_IDS.filter((id) => CHAIN_SPECS[id].repeat).map((id) => [id, CHAIN_SPECS[id].repeat!.stageId]), [[WRITER_REPEAT.chain, WRITER_REPEAT.stageId]])
  assert.equal(CHAIN_SPECS.intraday_guard.repeat!.stageId, CHAIN_SPECS.intraday_guard.firstStage, 'the window opens at its own first deadline')
  // infra/gcp-scheduler-jobs.json: the last intraday-check job ends at minute 30 of 05 UTC (13:30 TW).
  const jobs = JSON.parse(readFileSync(new URL('../../../../infra/gcp-scheduler-jobs.json', import.meta.url), 'utf8'))
  const schedules = JSON.stringify(jobs).match(/"schedule":"[^"]*","task":"intraday-check"/g) ?? []
  assert.deepEqual(schedules, ['"schedule":"* 1-4 * * 1-5","task":"intraday-check"', '"schedule":"0-30 5 * * 1-5","task":"intraday-check"'])
  assert.equal(CHAIN_SPECS.intraday_guard.repeat!.windowEndTw, '13:30')
  // The repeating stage is a watcher: its completed_at is the last result, so its 09:10 deadline is the first result's.
  assert.deepEqual(CHAIN_SPECS.intraday_guard.watchers, [WRITER_REPEAT.stageId])
  assert.deepEqual([isWatcherStage('intraday_guard', 'intraday-check'), isWatcherStage('intraday_guard', 'eod-exit'), isWatcherStage('nope', 'intraday-check')], [true, false, false])
})

test('once the writer\'s catalog is in this tree, the copy matches it directly', async (t) => {
  const path = new URL('../../lib/opsChainStageCatalog.ts', import.meta.url)
  if (!existsSync(path)) return t.skip('opsChainStageCatalog.ts (P2b) not in this tree yet; the tables above stand in for it')
  const writer = await import(path.href) as Record<string, any>
  if (typeof writer.periodKeyFor !== 'function') return t.skip('the writer catalog in this tree predates P2b (no periodKeyFor)')
  const state = await import(new URL('../../lib/opsChainStageState.ts', import.meta.url).href) as Record<string, any>
  assert.equal(REPEAT_REFRESH_MIN_MS, state.CHAIN_STAGE_HEARTBEAT_MIN_MS)
  const repeating = writer.CHAIN_DEFINITIONS.flatMap((definition: any) => definition.stages.filter((entry: any) => entry.repeat).map((entry: any) => [definition.chainId, entry.stageId]))
  assert.deepEqual(repeating, [[WRITER_REPEAT.chain, WRITER_REPEAT.stageId]])
  // Watchers (no ETA margin, overdue only without a result): the copy's per-chain lists are the writer's `watcher` entries.
  for (const definition of writer.CHAIN_DEFINITIONS) {
    assert.deepEqual([...(CHAIN_SPECS[definition.chainId as ChainId].watchers ?? [])],
      definition.stages.filter((entry: any) => entry.watcher).map((entry: any) => entry.stageId), `${definition.chainId} watchers`)
  }
  for (const [date] of PERIOD_KEYS) for (const chain of CHAIN_IDS) assert.equal(periodKeyFor(chain, date), writer.periodKeyFor(chain, date), `${chain} ${date}`)
  for (const definition of writer.CHAIN_DEFINITIONS) {
    const spec = CHAIN_SPECS[definition.chainId as ChainId]
    assert.ok(spec, definition.chainId)
    const first = definition.stages[0]
    assert.equal(spec.firstStage, first.stageId)
    for (const [, , key] of FIRST_DEADLINES) {
      assert.equal(new Date(twTimeOn(key, spec.firstDeadlineTw)!).toISOString(), writer.stageExpectedByUtc(key, first, null), definition.chainId)
    }
    if (definition.chainId !== 'daily_readiness') {
      assert.deepEqual(chainStageIds(definition.chainId).sort(), definition.stages.map((entry: { stageId: string }) => entry.stageId).sort())
    }
  }
})
