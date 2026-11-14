import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { POST_VERIFY_RETRY_SAFE_TASKS } from './postVerifyTaskCheckpoint'
import { backfillMissingStrategyEvidenceMetricSnapshots, materializeStrategyEvidenceMetrics } from './strategyEvidenceMetrics'
import { refreshStrategyEvidenceOwnerCalibration } from './strategyEvidenceOwnerCalibration'
import { seedDefaultStrategySpecRegistry } from './strategyLearning'

// EC-F: the strategy-evidence producers run again after a killed invocation (11/2), so a rerun of
// what the dead producer may already have committed must neither duplicate nor change any row.
const date = '2026-11-02'

async function fixture() {
  const sql = new DatabaseSync(':memory:')
  for (const domain of ['learning', 'ops', 'market']) {
    for (const file of fs.readdirSync(`domain-migrations/${domain}`).filter(name => name.endsWith('.sql')).sort()) {
      sql.exec(fs.readFileSync(`domain-migrations/${domain}/${file}`, 'utf8'))
    }
  }
  let killAt: number | undefined
  const db = { prepare(query: string) {
    const bound = (values: any[]) => ({
      async first() { return sql.prepare(query).get(...values) ?? null },
      async all() { return { success: true, results: sql.prepare(query).all(...values) } },
      async run() { return { success: true, meta: { changes: Number(sql.prepare(query).run(...values).changes) } } },
      runSync() { return sql.prepare(query).run(...values) },
    })
    return { ...bound([]), bind: (...values: any[]) => bound(values) }
  }, async batch(statements: any[]) {
    // A D1 batch is one transaction: an isolate killed inside it commits nothing.
    const kill = killAt
    killAt = undefined
    sql.exec('BEGIN')
    try {
      const out = statements.map((statement, index) => {
        if (index === kill) throw new Error('isolate_killed_mid_batch')
        return statement.runSync()
      })
      sql.exec('COMMIT')
      return out
    } catch (error) {
      sql.exec('ROLLBACK')
      throw error
    }
  } } as any
  await seedDefaultStrategySpecRegistry(db)
  sql.prepare(`INSERT INTO canonical_run_heads(logical_run_key,run_id,promoted_at)
    VALUES('screener:2026-10-30:TW:production:market_screener','run-1030','2026-10-30')`).run()
  const count = (table: string) => Number((sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n)
  return { sql, env: { DB: db } as any, count, killNextBatchAt: (index: number) => { killAt = index } }
}

const evidenceCurrent = async (env: any) => ({
  metrics: await materializeStrategyEvidenceMetrics(env, { outcomeAsOfDate: date, publicationScope: 'canonical:run-1102' }),
  calibration: await refreshStrategyEvidenceOwnerCalibration(env, { knowledgeCutoffDate: date, allowPromotion: true }),
})

test('both strategy-evidence producers are on the retry-safe list', () => {
  for (const task of ['strategy-evidence-current', 'strategy-evidence-metric-backfill']) {
    assert.ok(POST_VERIFY_RETRY_SAFE_TASKS.includes(task), task)
  }
})

test('rerun after the dead producer committed both writes returns the same snapshot and calibration run', async () => {
  const f = await fixture()
  const first = await evidenceCurrent(f.env)
  const snapshotRows = f.count('strategy_evidence_metric_snapshot_rows_v2')
  const artifacts = f.count('strategy_evidence_owner_calibration_artifacts_v1')
  assert.ok(snapshotRows > 0)
  assert.ok(artifacts > 0)
  const second = await evidenceCurrent(f.env)
  assert.equal(second.metrics.snapshot_run_id, first.metrics.snapshot_run_id)
  assert.equal(second.metrics.payload_checksum, first.metrics.payload_checksum)
  assert.equal(second.calibration.runId, first.calibration.runId)
  assert.equal(f.count('strategy_evidence_metric_snapshot_runs_v2'), 1)
  assert.equal(f.count('strategy_evidence_metric_snapshot_rows_v2'), snapshotRows)
  assert.equal(f.count('strategy_evidence_owner_calibration_runs_v1'), 1)
  assert.equal(f.count('strategy_evidence_owner_calibration_artifacts_v1'), artifacts)
  f.sql.close()
})

test('rerun after the producer died between the snapshot and the calibration completes once', async () => {
  const f = await fixture()
  const metrics = await materializeStrategyEvidenceMetrics(f.env, { outcomeAsOfDate: date, publicationScope: 'canonical:run-1102' })
  assert.equal(f.count('strategy_evidence_owner_calibration_runs_v1'), 0)
  const rerun = await evidenceCurrent(f.env)
  assert.equal(rerun.metrics.snapshot_run_id, metrics.snapshot_run_id)
  assert.equal(f.count('strategy_evidence_metric_snapshot_runs_v2'), 1)
  assert.equal(f.count('strategy_evidence_owner_calibration_runs_v1'), 1)
  f.sql.close()
})

test('a producer killed inside either batch leaves no partial rows and the rerun publishes once', async () => {
  for (const killedBatch of ['snapshot', 'calibration'] as const) {
    const f = await fixture()
    if (killedBatch === 'calibration') {
      await materializeStrategyEvidenceMetrics(f.env, { outcomeAsOfDate: date, publicationScope: 'canonical:run-1102' })
    }
    f.killNextBatchAt(1)
    await assert.rejects(evidenceCurrent(f.env), /isolate_killed_mid_batch/)
    assert.equal(f.count('strategy_evidence_metric_snapshot_runs_v2'), killedBatch === 'snapshot' ? 0 : 1)
    if (killedBatch === 'snapshot') assert.equal(f.count('strategy_evidence_metric_snapshot_rows_v2'), 0)
    assert.equal(f.count('strategy_evidence_owner_calibration_runs_v1'), 0)
    assert.equal(f.count('strategy_evidence_owner_calibration_artifacts_v1'), 0)
    const rerun = await evidenceCurrent(f.env)
    assert.equal(f.count('strategy_evidence_metric_snapshot_runs_v2'), 1)
    assert.equal(f.count('strategy_evidence_metric_snapshot_rows_v2'), rerun.metrics.metric_rows)
    assert.equal(f.count('strategy_evidence_owner_calibration_runs_v1'), 1)
    f.sql.close()
  }
})

test('metric backfill rerun skips the date the dead producer already published', async () => {
  const f = await fixture()
  await materializeStrategyEvidenceMetrics(f.env, { outcomeAsOfDate: date, publicationScope: 'canonical:run-1102' })
  // One outcome known on 2026-10-30 whose selection has an evaluable strategy hit: the backfill's
  // candidate dates come from these base tables.
  f.sql.exec(`INSERT INTO canonical_selection_outcomes_v1(signal_date,symbol,producer_run_id,horizon_days,
      entry_date,exit_date,outcome_known_date,gross_return,transaction_cost_bps,absolute_return_net,
      benchmark_return_net,benchmark_scope,residual_return_net,cross_section_rank,adjustment_source,reference_contract_version)
    VALUES('2026-10-23','2330','run-1023',5,'2026-10-24','2026-10-30','2026-10-30',0.01,30,0.007,0.002,'market',0.005,0.5,'test','test');
    INSERT INTO strategy_label_matrix_v4(signal_date,symbol,producer_run_id,strategy_id,strategy_version,strategy_status,
      alpha_bucket,family_id,production_owner,strategy_hit,evaluable,weak_label,affinity,position_weight,overlap,
      labeler_version,strategy_registry_checksum,reference_contract_version)
    VALUES('2026-10-23','2330','run-1023','s','v1','active','b','f',0,1,1,1,0.5,0.1,0,'t','c','test')`)
  const first = await backfillMissingStrategyEvidenceMetricSnapshots(f.env, { knowledgeCutoffDate: date, maxDates: 1 })
  assert.deepEqual(first.processedDates, ['2026-10-30'])
  const runs = f.count('strategy_evidence_metric_snapshot_runs_v2')
  const rows = f.count('strategy_evidence_metric_snapshot_rows_v2')
  const second = await backfillMissingStrategyEvidenceMetricSnapshots(f.env, { knowledgeCutoffDate: date, maxDates: 1 })
  assert.deepEqual(second.processedDates, [])
  assert.equal(f.count('strategy_evidence_metric_snapshot_runs_v2'), runs)
  assert.equal(f.count('strategy_evidence_metric_snapshot_rows_v2'), rows)
  f.sql.close()
})
