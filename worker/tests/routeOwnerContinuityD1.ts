// Original legacy route evaluator/publisher/reader on private workerd D1.
// Synthetic labeled observations test transactions, NOT NAV or investment ROI.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { refreshStrategyRouteCalibration, loadPromotedStrategyRouteCalibration,
  STRATEGY_ROUTE_CHALLENGER_VERSION, STRATEGY_ROUTE_AFFINITY_VERSION } from '../src/lib/strategyRouteCalibration'

async function fixture(run: (db: D1Database, owners: Record<string, string>) => Promise<void>) {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("private") } }',
    d1Databases: ['LEARNING'] })
  try {
    const db = await mf.getD1Database('LEARNING') as unknown as D1Database
    const baseline = fs.readFileSync('domain-migrations/learning/0001_learning_baseline.sql', 'utf8')
    for (const name of ['strategy_route_calibration_runs_v1', 'strategy_route_calibration_head_v1']) {
      const ddl = baseline.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))?.[0]
      assert(ddl)
      await db.prepare(ddl).run()
    }
    const alterations = fs.readFileSync('domain-migrations/learning/0023_strategy_route_paired_incumbent_evidence.sql', 'utf8')
    for (const ddl of alterations.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(ddl).run()
    await db.prepare(`CREATE TABLE selection_reference_snapshots_v1(signal_date TEXT,symbol TEXT,producer_run_id TEXT,
      strategy_challenger_route_score REAL,strategy_router_score REAL,strategy_challenger_route_version TEXT,
      strategy_router_version TEXT,strategy_challenger_affinity_version TEXT,hard_gate_passed INTEGER)`).run()
    await db.prepare(`CREATE TABLE strategy_route_versioned_evidence_v1(signal_date TEXT,symbol TEXT,producer_run_id TEXT,
      route_version TEXT,route_score REAL,incumbent_route_score REAL)`).run()
    await db.prepare(`CREATE TABLE canonical_selection_labels_v4(signal_date TEXT,symbol TEXT,producer_run_id TEXT,
      absolute_return_net REAL,residual_return_net REAL,label_schema_version TEXT,outcome_known_date TEXT)`).run()
    const owners: Record<string, string> = {}
    for (let day = 0; day < 21; day++) {
      const date = day === 20 ? '2026-06-30' : `2026-06-${String(day + 1).padStart(2, '0')}`
      owners[date] = `original-${date}`
      const writes = []
      for (let symbol = 0; symbol < 20; symbol++) {
        const high = symbol >= 14
        writes.push(db.prepare('INSERT INTO selection_reference_snapshots_v1 VALUES(?,?,?,?,?,?,?,?,1)')
          .bind(date, String(1000 + symbol), owners[date], high ? 80 + symbol / 10 : 10 + symbol,
            100 - symbol, STRATEGY_ROUTE_CHALLENGER_VERSION, 'original-incumbent', STRATEGY_ROUTE_AFFINITY_VERSION))
        // Current coverage is present, but current outcomes are NOT known.
        if (day < 20) writes.push(db.prepare('INSERT INTO canonical_selection_labels_v4 VALUES(?,?,?,?,?,?,?)')
          .bind(date, String(1000 + symbol), owners[date], high ? .025 + day * .0001 : -.01,
            high ? .02 + day * .0001 : -.008, 'canonical-strategy-selection-label-v4', '2026-06-29'))
      }
      await db.batch(writes)
    }
    await run(db, owners)
  } finally { await mf.dispose() }
}

test('evidence-only retry cannot unpublish the original route or rewrite its receipt', async () => {
  await fixture(async (db, canonicalRunIds) => {
    const first = await refreshStrategyRouteCalibration(db, '2026-06-30', { allowPromotion: true, canonicalRunIds })
    assert.equal(first.status, 'promoted')
    const serving = await loadPromotedStrategyRouteCalibration(db)
    assert(serving)
    const receipt = await db.prepare('SELECT * FROM strategy_route_calibration_runs_v1 WHERE run_id=?').bind(first.runId).first()
    const head = await db.prepare('SELECT * FROM strategy_route_calibration_head_v1').first()
    const rerun = await refreshStrategyRouteCalibration(db, '2026-06-30', { allowPromotion: false, canonicalRunIds })
    assert.equal(rerun.result.status, 'pass')
    assert.equal(rerun.status, 'promoted')
    assert.deepEqual(rerun.publication, { requested: false, pointerChanged: false, servingRunId: first.runId })
    assert.deepEqual(await loadPromotedStrategyRouteCalibration(db), serving)
    assert.deepEqual(await db.prepare('SELECT * FROM strategy_route_calibration_runs_v1 WHERE run_id=?').bind(first.runId).first(), receipt)
    assert.deepEqual(await db.prepare('SELECT * FROM strategy_route_calibration_head_v1').first(), head)
    await db.prepare("UPDATE selection_reference_snapshots_v1 SET strategy_challenger_affinity_version=NULL WHERE signal_date='2026-06-30'").run()
    const missingCoverage = await refreshStrategyRouteCalibration(db, '2026-06-30', { allowPromotion: false, canonicalRunIds })
    assert.equal(missingCoverage.result.gates.current_day_threshold_affinity_complete, false)
    assert.deepEqual(await db.prepare('SELECT * FROM strategy_route_calibration_runs_v1 WHERE run_id=?').bind(first.runId).first(), receipt)
    assert.deepEqual(await loadPromotedStrategyRouteCalibration(db), serving)
  })
})

for (const fault of ['run', 'head']) test(`failure writing route ${fault} must roll back all publication`, async () => {
  await fixture(async (db, canonicalRunIds) => {
    const failing = new Proxy(db, { get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        if (sql.includes(`INSERT INTO strategy_route_calibration_${fault === 'run' ? 'runs' : 'head'}_v1`)) {
          // Valid prepared statement, native SQL failure when actually executed.
          // Preserve bind arity so failure happens inside D1, not during prepare.
          return { bind(...params: unknown[]) { return target.prepare(`SELECT json('injected_publication_failure')
            ${params.length ? ',' + params.map(() => '?').join(',') : ''}`).bind(...params as any[]) } }
        }
        return target.prepare(sql)
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } }) as D1Database
    await assert.rejects(() => refreshStrategyRouteCalibration(failing, '2026-06-30', { allowPromotion: true, canonicalRunIds }))
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM strategy_route_calibration_runs_v1').first<any>())?.n, 0)
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM strategy_route_calibration_head_v1').first<any>())?.n, 0)
    assert.equal(await loadPromotedStrategyRouteCalibration(db), null)
  })
})

test('lost acknowledgement retries without rewriting the committed run/head', async () => {
  await fixture(async (db, canonicalRunIds) => {
    const lost = new Proxy(db, { get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        await target.batch(statements)
        throw new Error('injected_ack_lost_after_commit')
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } }) as D1Database
    await assert.rejects(() => refreshStrategyRouteCalibration(lost, '2026-06-30',
      { allowPromotion: true, canonicalRunIds }), /injected_ack_lost_after_commit/)
    const run = await db.prepare('SELECT * FROM strategy_route_calibration_runs_v1').first<any>()
    const head = await db.prepare('SELECT * FROM strategy_route_calibration_head_v1').first()
    assert(run && head)
    const retry = await refreshStrategyRouteCalibration(db, '2026-06-30', { allowPromotion: true, canonicalRunIds })
    assert.equal(retry.status, 'promoted')
    assert.deepEqual(retry.publication, { requested: true, pointerChanged: false, servingRunId: run.run_id })
    assert.deepEqual(await db.prepare('SELECT * FROM strategy_route_calibration_runs_v1').first(), run)
    assert.deepEqual(await db.prepare('SELECT * FROM strategy_route_calibration_head_v1').first(), head)
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM strategy_route_calibration_runs_v1').first<any>())?.n, 1)
    // A new, poorer diagnostic candidate never demotes the existing head.
    await db.prepare('UPDATE canonical_selection_labels_v4 SET absolute_return_net=0,residual_return_net=0').run()
    const worse = await refreshStrategyRouteCalibration(db, '2026-06-30', { allowPromotion: false, canonicalRunIds })
    assert.equal(worse.status, 'fail')
    assert.notEqual(worse.runId, run.run_id)
    assert.deepEqual(await db.prepare('SELECT * FROM strategy_route_calibration_head_v1').first(), head)
    assert.equal((await loadPromotedStrategyRouteCalibration(db))?.runId, run.run_id)
  })
})
