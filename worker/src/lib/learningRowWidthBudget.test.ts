import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  persistSelectionEvidenceV4,
  type SelectionReferenceRowV1,
  type StrategyLabelMatrixRowV4,
} from './selectionReferenceEvidence'
import { STRATEGY_AFFINITY_CHALLENGER_VERSION } from './multiStrategyPleRouter'
import { STRATEGY_FORMAL_LABELER_VERSION } from './strategySpec'

// M2 row-width budgets (D1 ten-year plan §3): learning-db grows by its hot
// write points, so each one has a byte budget per row that CI enforces. Bytes
// are SQLite's own record payload (dbstat) of rows written by the production
// writer into the migrated learning schema, so a new column, a longer version
// string or a new index shows up here. Raise a budget only with the M2 owner's
// review and the new D1 growth estimate (audits/matrix-split-plan-20261112).
//
// Measured 2026-11-13 with production-length identifiers (strategy_id ~42 B,
// sha256 registry checksum 71 B, labeler 49 B, reference contract 52 B):
//   strategy_label_matrix_v4         517 B/row record, 341 B/row in its 5 indexes
//   strategy_label_matrix_runs_v4    558 B, one header row per run incl. the count summary
//   selection_reference_snapshots_v1 1,956 B/row, of which score_components ~1.4 KB; 7 indexes
const BUDGET = {
  matrixRow: 540,
  matrixIndexes: 360,
  matrixIndexCount: 5,
  headerRow: 600,
  referenceRow: 2_050,
  referenceIndexCount: 7,
  decisionIndexCount: 8,
}

const SIGNAL_DATE = '2026-11-12'
const PRODUCER = 'screener-v2-2026-11-12T09-35-00-000Z-a1b2c3d4'
const CHECKSUM = `sha256:${'ab'.repeat(32)}`
const SYMBOLS = Array.from({ length: 60 }, (_, index) => String(1101 + index * 7))
const STRATEGIES = Array.from({ length: 20 }, (_, index) => `stock_tech_s${String(index).padStart(2, '0')}_multitimeframe_reclaim_v2`)

const SCORE_COMPONENTS = JSON.stringify({
  version: 'score_v2',
  weights: { mlEdge: 0.3, chipFlow: 0.2, technicalStructure: 0.25, fundamentalQuality: 0.15, newsTheme: 0.1 },
  components: { mlEdge: 61.234, chipFlow: 55.871, technicalStructure: 72.112, fundamentalQuality: 48.03, newsTheme: 50 },
  total: 60.512, finalScore: 61.003, alphaAdjustment: 0.491,
  technicalBreakdown: { trendStructure: 71.2, volatilityStructure: 64.8, reversalExtreme: 40.1, volumeConfirmation: 58.3, executionRisk: 22.7 },
  chipEvidence: {
    schema_version: 'chip-evidence-v2', evidenceStatus: 'complete', evidence_status: 'complete', source: 'canonical_chip_daily',
    scoringPolicy: 'broker-flow-weighted-v1', scoring_policy: 'broker-flow-weighted-v1', brokerFlowUsed: true, brokerEvidenceStatus: 'complete',
    broker: { netBuyLots5d: 1532, netBuyLots20d: 4410, concentration5d: 0.183, concentration20d: 0.121, topBrokerShare: 0.072,
      buyerCount: 312, sellerCount: 298, foreignNetLots: 2210, trustNetLots: 310, dealerNetLots: -120, asOf: SIGNAL_DATE },
    creditLending: { marginBalance: 15320, marginChange5d: -210, shortBalance: 820, shortChange5d: 40, lendingBalance: 3310,
      lendingChange5d: 150, marginUtilization: 0.212, shortMarginRatio: 0.0535, asOf: SIGNAL_DATE },
  },
  riskFlags: ['volatility_elevated', 'gap_risk'],
  reasons: ['趨勢結構轉強', '籌碼集中度上升', '量能確認', '外資連續買超'],
})

function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = []
      const values = () => params.map((value) => (value === undefined ? null : value)) as never[]
      const statement = {
        bind(...bound: unknown[]) { params = bound; return statement },
        async all() { return { success: true, results: db.prepare(sql).all(...values()), meta: {} } },
        async first() { return db.prepare(sql).get(...values()) ?? null },
        async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...values()).changes) } } },
      }
      return statement
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      db.exec('BEGIN')
      try {
        const out = []
        for (const statement of statements) out.push(await statement.run())
        db.exec('COMMIT')
        return out
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
}

function migrated(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const dir = new URL('../../domain-migrations/learning/', import.meta.url)
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, dir), 'utf8'))
  }
  return db
}

function payloadPerRow(db: DatabaseSync, table: string): { row: number; indexes: number; indexCount: number } {
  const rows = Number((db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n)
  assert.ok(rows > 0, table)
  const objects = db.prepare(`
    SELECT s.name, s.type, COALESCE(SUM(d.payload), 0) payload
      FROM sqlite_master s LEFT JOIN dbstat d ON d.name=s.name
     WHERE s.tbl_name=? AND s.type IN ('table', 'index')
     GROUP BY s.name, s.type
  `).all(table) as Array<{ name: string; type: string; payload: number }>
  const table_ = objects.find((item) => item.type === 'table')!
  const indexes = objects.filter((item) => item.type === 'index')
  return {
    row: Number(table_.payload) / rows,
    indexes: indexes.reduce((sum, item) => sum + Number(item.payload), 0) / rows,
    indexCount: indexes.length,
  }
}

test('selection evidence promotion stays within its learning-db row budgets', async () => {
  const db = migrated()
  const identity = new DatabaseSync(':memory:')
  identity.exec('CREATE TABLE stocks (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL UNIQUE)')
  SYMBOLS.forEach((symbol, index) => identity.prepare('INSERT INTO stocks(id, symbol) VALUES (?, ?)').run(index + 1, symbol))
  const references: SelectionReferenceRowV1[] = SYMBOLS.map((symbol) => ({
    signal_date: SIGNAL_DATE, symbol, producer_run_id: PRODUCER, name: '台灣積體電路製造', market_segment: 'listed',
    sector: 'semiconductor', strategy_selected: 1, selection_stage: 'l1_labeled_observe', rejection_reason: null,
    score_v2: 61.003, score_components: SCORE_COMPONENTS, feature_available: 1, feature_rejection_reason: null,
    strategy_labeler_version: STRATEGY_FORMAL_LABELER_VERSION, strategy_affinity_version: 'strategy-affinity-threshold-margin-v1',
    strategy_router_version: 'strategy-route-l15-v3', strategy_router_score: 0.613,
    strategy_challenger_affinity_version: STRATEGY_AFFINITY_CHALLENGER_VERSION,
    strategy_challenger_route_version: 'strategy-route-l15-challenger-v4', strategy_challenger_route_score: 0.588,
    strategy_registry_checksum: CHECKSUM,
  }))
  const matrix: StrategyLabelMatrixRowV4[] = SYMBOLS.flatMap((symbol, s) => STRATEGIES.map((strategy, k) => {
    const hit = (s + k) % 9 === 0 ? 1 : 0
    return {
      signal_date: SIGNAL_DATE, symbol, producer_run_id: PRODUCER, strategy_id: strategy, strategy_version: 'v2',
      strategy_status: 'active', alpha_bucket: 'trend_following', family_id: 'trend-reclaim', production_owner: k % 2,
      strategy_hit: hit, pre_regime_setup_hit: hit, regime_eligible: 1, formal_veto_reason: null,
      counterfactual_affinity: hit ? 63.25 : 0, counterfactual_production_effect: 0, weak_label: hit, affinity: hit,
      affinity_version: 'strategy-affinity-threshold-margin-v1', match_strength: hit ? 0.7341 : 0.1213,
      threshold_margin: hit ? 0.0342 : -0.2107, affinity_evidence_count: hit ? 5 : 0, position_weight: 0,
      challenger_affinity: hit ? 61.123 : 0, challenger_affinity_version: STRATEGY_AFFINITY_CHALLENGER_VERSION,
      challenger_position_weight: 0, overlap: 0, evaluable: 1, evaluability_status: 'EVALUABLE', unavailable_reason: null,
      labeler_version: STRATEGY_FORMAL_LABELER_VERSION, strategy_registry_checksum: CHECKSUM,
    }
  }))
  assert.deepEqual(await persistSelectionEvidenceV4(d1(db), {
    signalDate: SIGNAL_DATE, producerRunId: PRODUCER, references, matrix, strategyCount: STRATEGIES.length,
    strategyRegistryChecksum: CHECKSUM, labelerVersion: STRATEGY_FORMAL_LABELER_VERSION,
    evidenceArtifactId: `artifact:selection-evidence:${PRODUCER}`,
  }, d1(identity)), { referenceRows: SYMBOLS.length, matrixRows: SYMBOLS.length * STRATEGIES.length })

  const cells = payloadPerRow(db, 'strategy_label_matrix_v4')
  const header = payloadPerRow(db, 'strategy_label_matrix_runs_v4')
  const reference = payloadPerRow(db, 'selection_reference_snapshots_v1')
  const report = JSON.stringify({ cells, header, reference })
  assert.ok(cells.row <= BUDGET.matrixRow, `strategy_label_matrix_v4 row ${cells.row} B > ${BUDGET.matrixRow}: ${report}`)
  assert.ok(cells.indexes <= BUDGET.matrixIndexes, `strategy_label_matrix_v4 indexes ${cells.indexes} B > ${BUDGET.matrixIndexes}: ${report}`)
  assert.equal(cells.indexCount, BUDGET.matrixIndexCount, report)
  assert.ok(header.row <= BUDGET.headerRow, `strategy_label_matrix_runs_v4 row ${header.row} B > ${BUDGET.headerRow}: ${report}`)
  assert.ok(reference.row <= BUDGET.referenceRow, `selection_reference_snapshots_v1 row ${reference.row} B > ${BUDGET.referenceRow}: ${report}`)
  assert.equal(reference.indexCount, BUDGET.referenceIndexCount, report)
  // The header carries the count summary; staging is emptied by the promotion.
  assert.equal((db.prepare(`SELECT summary_matrix_rows n FROM strategy_label_matrix_runs_v4`).get() as { n: number }).n, matrix.length)
  for (const staging of ['strategy_label_matrix_staging_v4', 'selection_reference_snapshots_staging_v1']) {
    assert.equal(Number((db.prepare(`SELECT COUNT(*) n FROM ${staging}`).get() as { n: number }).n), 0, staging)
  }
})

test('strategy_decision_log keeps its index budget', () => {
  const db = migrated()
  const count = Number((db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND tbl_name='strategy_decision_log'`)
    .get() as { n: number }).n)
  assert.equal(count, BUDGET.decisionIndexCount)
})
