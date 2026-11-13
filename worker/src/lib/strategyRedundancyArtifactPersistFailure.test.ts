import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, test } from 'node:test'
import { auditEveningChainEvidenceClosure } from './eveningChainEvidenceClosure'
import {
  loadL125StrategySimilarityGraphEvidence,
  STRATEGY_REDUNDANCY_PERSIST_RETRY_DELAYS_MS,
  STRATEGY_REDUNDANCY_PERSIST_RETRY_WINDOW_MS,
} from './marketScreener'

// 2026-11-10/11: the controller answered 200, the learning-db write of the redundancy artifact got
// "D1 DB is overloaded" (7429) through the REST binding, and the catch turned it into
// unavailable_blocked, indistinguishable from a controller outage. strategy-learning then stopped
// at before_promotion:evening_chain_similarity_artifact_incomplete with nothing naming the cause.
// The write is retried; a final failure keeps the screener's candidates (no throw) and is recorded
// as persist_failed, which the evening-chain closure names.

const OVERLOADED = 'D1 REST HTTP 429: {"errors":[{"code":7429,"message":"D1 DB is overloaded. Too many resources consumed within a 10 second window."}]}'
const MIGRATIONS = new URL('../../domain-migrations/learning/', import.meta.url)

function learningDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'))
  }
  return db
}

type InsertFaults = { failures: number; attempts: number }

function d1(db: DatabaseSync, faults: InsertFaults): any {
  const statement = (sql: string, params: unknown[] = []): any => ({
    bind: (...next: unknown[]) => statement(sql, next),
    async run() {
      if (/INSERT INTO strategy_redundancy_artifacts_v1/.test(sql)) {
        faults.attempts += 1
        if (faults.attempts <= faults.failures) throw new Error(OVERLOADED)
      }
      db.prepare(sql).run(...(params as any[]))
      return { success: true, meta: {} }
    },
    async first() { return db.prepare(sql).get(...(params as any[])) ?? null },
    async all() { return { success: true, results: db.prepare(sql).all(...(params as any[])) } },
  })
  return { prepare: (sql: string) => statement(sql) }
}

function env(db: DatabaseSync, faults: InsertFaults): any {
  return {
    DB: d1(db, faults),
    ML_CONTROLLER_URL: 'https://controller.test',
    EVIDENCE_ARTIFACT_WRITER: {
      async write(input: any) {
        return {
          artifact_id: `artifact:${input.domain}:${input.businessDate}:test`,
          r2_key: `evidence/domain=${input.domain}/test.json`,
          checksum: 'sha256:test',
        }
      },
    },
  }
}

const payload: any = {
  input_scope: 'mature_oof_residual_returns_with_same_day_overlap_diagnostic',
  strategies: [{ strategy_id: 's1', family_id: 'f1', symbols: ['2330'], oof_returns: [] }],
  edge_threshold: null,
  threshold_quantile: null,
  random_state: 0,
}

const controllerBody = {
  status: 'computed',
  method: 'networkx_connected_components_oof_residual_correlation',
  input_scope: 'mature_oof_residual_returns_with_same_day_overlap_diagnostic',
  eligible_oof_pair_count: 3,
  strategy_count: 1,
  edge_count: 0,
  oof_max_date: '2026-11-03',
}

const realFetch = globalThis.fetch
const realConsoleError = console.error
const realConsoleWarn = console.warn
let logged: string[] = []
let controllerStatus = 200

beforeEach(() => {
  logged = []
  controllerStatus = 200
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
  console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
  globalThis.fetch = (async () => new Response(
    controllerStatus === 200 ? JSON.stringify(controllerBody) : 'unavailable',
    { status: controllerStatus, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  console.error = realConsoleError
  console.warn = realConsoleWarn
})

function recordSleep(slept: number[]) {
  return { sleep: async (ms: number) => { slept.push(ms) } }
}

function events(name: string): any[] {
  return logged.map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter((row) => row?.event === name)
}

test('a write that keeps failing is retried twice, then marked persist_failed without throwing', async () => {
  const db = learningDb()
  const faults = { failures: 99, attempts: 0 }
  const slept: number[] = []
  const result = await loadL125StrategySimilarityGraphEvidence(env(db, faults), payload, '2026-11-10', recordSleep(slept))
  assert.equal(result.status, 'persist_failed')
  assert.equal(result.evidence, null)
  assert.equal(result.artifact_id, undefined)
  assert.match(String(result.error), /^strategy_redundancy_artifact_persist_failed:2026-11-10:d1_overloaded:D1 REST HTTP 429/)
  assert.ok(String(result.error).length <= 300)
  assert.equal(faults.attempts, 3)
  assert.deepEqual(slept, [...STRATEGY_REDUNDANCY_PERSIST_RETRY_DELAYS_MS])
  assert.deepEqual(events('strategy_redundancy_artifact_persist_retry').map((row) => [row.failed_attempt, row.error_type]),
    [[1, 'd1_overloaded'], [2, 'd1_overloaded']])
  const [failed] = events('strategy_redundancy_artifact_persist_failed')
  assert.equal(failed?.error_type, 'd1_overloaded')
  assert.equal(failed?.attempts, 3)
  const rows = db.prepare('SELECT COUNT(*) n FROM strategy_redundancy_artifacts_v1').get() as { n: number }
  assert.equal(rows.n, 0)
})

test('an attempt that already waited out the rate limit is not retried', async () => {
  // The REST binding waited (up to 330 s) inside the first attempt; another attempt would open a
  // fresh per-request budget and eat the process window the funnel writes still need.
  const db = learningDb()
  const faults = { failures: 99, attempts: 0 }
  const slept: number[] = []
  let clock = 0
  const result = await loadL125StrategySimilarityGraphEvidence(env(db, faults), payload, '2026-11-10', {
    sleep: async (ms: number) => { slept.push(ms) },
    now: () => { const value = clock; clock += STRATEGY_REDUNDANCY_PERSIST_RETRY_WINDOW_MS + 1; return value },
  })
  assert.equal(result.status, 'persist_failed')
  assert.equal(faults.attempts, 1)
  assert.deepEqual(slept, [])
  assert.equal(events('strategy_redundancy_artifact_persist_retry').length, 0)
  assert.equal(events('strategy_redundancy_artifact_persist_failed')[0]?.attempts, 1)
})

test('a write that succeeds on the second attempt yields the normal artifact', async () => {
  const db = learningDb()
  const faults = { failures: 1, attempts: 0 }
  const slept: number[] = []
  const result = await loadL125StrategySimilarityGraphEvidence(env(db, faults), payload, '2026-11-10', recordSleep(slept))
  assert.notEqual(result.status, 'persist_failed')
  assert.match(String(result.artifact_id), /^strategy-redundancy-oof-v1-2026-11-10-/)
  assert.equal(faults.attempts, 2)
  assert.deepEqual(slept, [STRATEGY_REDUNDANCY_PERSIST_RETRY_DELAYS_MS[0]])
  assert.equal(events('strategy_redundancy_artifact_persist_failed').length, 0)
  const row = db.prepare('SELECT artifact_id, status FROM strategy_redundancy_artifacts_v1 WHERE as_of_date=?')
    .get('2026-11-10') as { artifact_id: string; status: string }
  assert.equal(row.artifact_id, result.artifact_id)
  assert.equal(row.status, 'pass')
})

test('a persisted redundancy artifact is returned and readable by the closure query', async () => {
  const db = learningDb()
  const faults = { failures: 0, attempts: 0 }
  const slept: number[] = []
  const result = await loadL125StrategySimilarityGraphEvidence(env(db, faults), payload, '2026-11-10', recordSleep(slept))
  assert.match(String(result.artifact_id), /^strategy-redundancy-oof-v1-2026-11-10-/)
  assert.deepEqual(slept, [])
  const row = db.prepare(`
    SELECT status, evidence_artifact_id
      FROM strategy_redundancy_artifacts_v1
     WHERE as_of_date=?
     ORDER BY created_at DESC
     LIMIT 1
  `).get('2026-11-10') as { status: string; evidence_artifact_id: string }
  assert.equal(row.status, 'pass')
  assert.equal(row.evidence_artifact_id, 'artifact:strategy_redundancy_oof:2026-11-10:test')
})

test('a controller failure stays a blocked evidence status and is logged with its error_type', async () => {
  controllerStatus = 503
  const db = learningDb()
  const faults = { failures: 0, attempts: 0 }
  const result = await loadL125StrategySimilarityGraphEvidence(env(db, faults), payload, '2026-11-10', recordSleep([]))
  assert.equal(result.status, 'unavailable_blocked')
  assert.equal(result.artifact_id, undefined)
  assert.equal(faults.attempts, 0)
  const [record] = events('strategy_similarity_evidence_unavailable')
  assert.equal(record?.error_type, 'controller_call_failed')
})

test('the screener records the load status and reason in the funnel candidate-pool metadata', () => {
  const source = readFileSync(new URL('./marketScreener.ts', import.meta.url), 'utf8')
  // Telemetry keys the closure reads back with json_extract('$.strategyCandidatePool.…').
  assert.match(source, /strategy_similarity_evidence_status: strategySimilarityEvidence\.status,/)
  assert.match(source, /strategy_similarity_blocked_reason: strategySimilarityEvidence\.error \?\?/)
  assert.match(source, /strategyCandidatePool: strategySelectionTelemetry,/)
  // The load is awaited in the Promise.all without a throwing wrapper: persist_failed keeps the run.
  assert.match(source, /loadL125StrategySimilarityGraphEvidence\(env, strategySimilarityPayload, endDate\),/)
})

// Closure: answers the reads before the similarity check with passing values, has no redundancy
// artifact, and serves screener_funnel_runs from sqlite so the json_extract path is real.
function closureEnv(funnelMetadata: Record<string, unknown> | null): any {
  const ops = new DatabaseSync(':memory:')
  ops.exec(`CREATE TABLE screener_funnel_runs (run_id TEXT PRIMARY KEY, date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'success', metadata TEXT)`)
  if (funnelMetadata) {
    ops.prepare(`INSERT INTO screener_funnel_runs (run_id, date, metadata) VALUES ('run-1110', '2026-11-10', ?)`)
      .run(JSON.stringify(funnelMetadata))
  }
  const first = (sql: string, params: unknown[]): unknown => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.includes('FROM screener_funnel_runs')) return ops.prepare(sql).get(...(params as any[])) ?? null
    if (normalized.includes('SUM(CASE WHEN r.stock_id IS NOT NULL')) {
      return { reference_rows: 5, identity_rows: 5, artifact_rows: 5, reconciled_rows: 5, reference_projection_rows: 5 }
    }
    if (normalized.includes('FROM strategy_label_matrix_runs_v4 r')) {
      return {
        expected_cell_count: 10, persisted_cell_count: 10, matrix_rows: 10, matched_rows: 4,
        threshold_evidence_rows: 4, challenger_projection_rows: 10, projected_threshold_rows: 4,
      }
    }
    if (normalized.includes('FROM strategy_redundancy_artifacts_v1')) return null
    throw new Error(`unexpected SQL: ${normalized}`)
  }
  const statement = (sql: string, params: unknown[] = []): any => ({
    bind: (...next: unknown[]) => statement(sql, next),
    async first() { return first(sql, params) },
  })
  return { DB: { prepare: (sql: string) => statement(sql) }, MULTI_D1_ACTIVE_DOMAINS: '' }
}

test('the evening-chain closure names a persist_failed similarity artifact and still fails', async () => {
  const db = learningDb()
  const failed = await loadL125StrategySimilarityGraphEvidence(env(db, { failures: 99, attempts: 0 }), payload, '2026-11-10', recordSleep([]))
  await assert.rejects(
    auditEveningChainEvidenceClosure(closureEnv({
      strategyCandidatePool: {
        strategy_similarity_evidence_status: failed.status,
        strategy_similarity_blocked_reason: failed.error,
      },
    }), '2026-11-10', 'run-1110'),
    // The _incomplete token stays: the strategy-learning watchdog holds redispatch on it.
    /^Error: evening_chain_similarity_artifact_incomplete:2026-11-10:persist_failed:d1_overloaded$/,
  )
})

test('the evening-chain closure keeps the plain reason when the run recorded no persist failure', async () => {
  for (const metadata of [null, { strategyCandidatePool: { strategy_similarity_evidence_status: 'unavailable_blocked' } }]) {
    await assert.rejects(
      auditEveningChainEvidenceClosure(closureEnv(metadata), '2026-11-10', 'run-1110'),
      /^Error: evening_chain_similarity_artifact_incomplete:2026-11-10$/,
    )
  }
})
