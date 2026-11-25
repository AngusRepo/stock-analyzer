/** Miniflare-backed fixtures for the monitoring Worker: real D1 (workerd SQLite) so EXPLAIN QUERY PLAN and
 * meta.rows_read are D1's own. Tables come from the repo schema snapshot + domain migrations; the P2 chain
 * tables from P2's migration when present, else from p2p3_contract.md. miniflare is wrangler's pinned dependency. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import type { MonitoringEnv } from './env'
import type { ExecutedQuery } from './readOnlyD1'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const P2_MIGRATION = '../../domain-migrations/ops/0027_ops_chain_stage_state.sql'

// p2p3_contract.md (11/24): used until P2's migration file lands in this tree.
const CONTRACT_CHAIN_DDL = `
CREATE TABLE IF NOT EXISTS ops_chain_stage_state_v1 (
  business_date TEXT NOT NULL, chain_id TEXT NOT NULL, stage_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','success','error','skipped','blocked')),
  optional INTEGER NOT NULL DEFAULT 0, expected_by TEXT, attempt INTEGER NOT NULL DEFAULT 0,
  root_ticket_id TEXT, ticket_id TEXT, run_id TEXT, execution_name TEXT, summary TEXT, error TEXT,
  started_at TEXT, completed_at TEXT, heartbeat_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (business_date, chain_id, stage_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ops_chain_stage_transitions_v1 (
  business_date TEXT NOT NULL, chain_id TEXT NOT NULL, stage_id TEXT NOT NULL, transition_at TEXT NOT NULL,
  to_status TEXT NOT NULL, from_status TEXT, attempt INTEGER NOT NULL DEFAULT 0, ticket_id TEXT, run_id TEXT, summary TEXT,
  PRIMARY KEY (business_date, chain_id, stage_id, transition_at, to_status)
) WITHOUT ROWID;`

/** Splits on top-level semicolons (outside quotes, comments and BEGIN ... END trigger bodies). */
function statements(sql: string): string[] {
  const out: string[] = []
  let current = ''
  let depth = 0
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end; current += '\n'; continue }
    if (c === "'" || c === '"') { const end = sql.indexOf(c, i + 1); current += sql.slice(i, end + 1); i = end; continue }
    current += c
    if (/[A-Za-z]/.test(c) && /\bBEGIN$/i.test(current.slice(-7)) && /CREATE\s+TRIGGER/i.test(current)) depth++
    if (depth > 0 && /\bEND$/i.test(current.slice(-5))) depth--
    if (c === ';' && depth === 0) { if (current.trim() !== ';') out.push(current.trim()); current = '' }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

const tableOf = (stmt: string) => /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(stmt)?.[1]
const indexTable = (stmt: string) => /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+(\w+)/i.exec(stmt)?.[1]
const indexName = (stmt: string) => /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(stmt)?.[1]

/** DDL for the named tables of one domain as production has them: snapshot table (else first migration),
 * migration ALTER ... ADD COLUMNs, then indexes in schema+migration order with migration DROP INDEXes applied. */
export function domainDdl(domain: string, tables: string[]): string[] {
  const schema = statements(read(`../../domain-schemas/${domain}.sql`))
  const dir = new URL(`../../domain-migrations/${domain}/`, import.meta.url)
  const migrations = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()
    .flatMap((name) => statements(readFileSync(new URL(name, dir), 'utf8')))
  const out: string[] = []
  const indexes = new Map<string, string>()
  for (const table of tables) {
    const create = schema.find((stmt) => tableOf(stmt) === table) ?? migrations.find((stmt) => tableOf(stmt) === table)
    if (!create) throw new Error(`no DDL for ${domain}.${table}`)
    out.push(create)
    for (const stmt of migrations) {
      const alter = new RegExp(`^ALTER\\s+TABLE\\s+${table}\\s+ADD\\s+COLUMN\\s+(\\w+)`, 'i').exec(stmt)
      if (alter && !new RegExp(`\\b${alter[1]}\\b`).test(create)) out.push(stmt)
    }
  }
  for (const stmt of [...schema, ...migrations]) {
    const table = indexTable(stmt)
    if (table && tables.includes(table)) indexes.set(indexName(stmt)!, stmt)
    const dropped = /^DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(\w+)/i.exec(stmt)?.[1]
    if (dropped && migrations.includes(stmt)) indexes.delete(dropped)
  }
  return [...out, ...indexes.values()]
}

export function chainDdl(): string[] {
  return statements(existsSync(new URL(P2_MIGRATION, import.meta.url)) ? read(P2_MIGRATION) : CONTRACT_CHAIN_DDL)
}

export type Fixture = { mf: Miniflare; env: MonitoringEnv; raw: Record<string, D1Database>; kv: KVNamespace }

export const FIXTURE_TABLES: Record<string, { binding: string; tables: string[] }> = {
  market: { binding: 'MARKET_DB', tables: ['stock_prices', 'chip_data', 'technical_indicators', 'canonical_market_daily',
    'canonical_market_index_daily', 'canonical_futures_daily', 'canonical_market_summary_daily', 'canonical_institutional_amount_daily',
    'canonical_regime_context_daily', 'external_evidence_items', 'source_quality_metrics'] },
  ops: { binding: 'OPS_DB', tables: ['storage_capacity_daily', 'pipeline_stage_runs'] },
  learning: { binding: 'LEARNING_DB', tables: ['strategy_route_calibration_runs_v1', 'rfs_sparse_comparisons_v1'] },
  paper: { binding: 'PAPER_DB', tables: ['paper_order_intents', 'l4_portfolio_plans_v1', 'l4_portfolio_head_v1'] },
  execution: { binding: 'EXECUTION_DB', tables: ['broker_execution_intents'] },
}

export async function startFixture(): Promise<Fixture> {
  const bindings = ['DB', 'CORE_DB', 'MARKET_DB', 'LEARNING_DB', 'OPS_DB', 'EXECUTION_DB', 'PAPER_DB', 'RESEARCH_DB']
  const mf = new Miniflare({
    modules: true, script: 'export default { fetch() { return new Response(null, { status: 404 }) } }',
    d1Databases: Object.fromEntries(bindings.map((name) => [name, name.toLowerCase()])), kvNamespaces: ['KV'],
  })
  const raw: Record<string, D1Database> = {}
  for (const name of bindings) raw[name] = await mf.getD1Database(name) as unknown as D1Database
  for (const [domain, { binding, tables }] of Object.entries(FIXTURE_TABLES)) {
    for (const stmt of domainDdl(domain, tables)) await raw[binding].prepare(stmt).run()
  }
  for (const stmt of chainDdl()) await raw.OPS_DB.prepare(stmt).run()
  const kv = await mf.getKVNamespace('KV') as unknown as KVNamespace
  const env = { ...raw, KV: kv } as unknown as MonitoringEnv
  return { mf, env, raw, kv }
}

const columnCache = new Map<string, Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>>()

/** Batched inserts; NOT NULL columns without a default that the row omits get a type-shaped filler. */
export async function insertRows(db: D1Database, table: string, rows: Array<Record<string, unknown>>): Promise<void> {
  if (!rows.length) return
  let columns = columnCache.get(table)
  if (!columns) {
    columns = (await db.prepare(`PRAGMA table_info(${table})`).all<any>()).results
    columnCache.set(table, columns)
  }
  const fill = columns.filter((col) => col.notnull && col.dflt_value == null && !(col.pk && /INT/i.test(col.type) && !col.notnull))
  for (let offset = 0; offset < rows.length; offset += 400) {
    const chunk = rows.slice(offset, offset + 400).map((row) => {
      const full: Record<string, unknown> = { ...row }
      for (const col of fill) if (!(col.name in full)) full[col.name] = /INT/i.test(col.type) ? 0 : /REAL/i.test(col.type) ? 0 : 'x'
      return full
    })
    await db.batch(chunk.map((row) => {
      const names = Object.keys(row)
      return db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).bind(...names.map((name) => row[name]))
    }))
  }
}

/** Temp B-trees for ORDER BY / GROUP BY / DISTINCT: D1 bills each sorted row as a second read. */
export async function tempSorts(db: D1Database, query: ExecutedQuery): Promise<string[]> {
  const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.params).all<{ detail: string }>()).results ?? []
  return plan.map((row) => row.detail).filter((detail) => /TEMP B-TREE/.test(detail))
}

/** Plan rows that read a whole table or index (SCAN <table|alias> [USING ...]). EQP names a table by its alias,
 * so every named SCAN counts; only constant-row and subquery scans (`SCAN (subquery-1)`) are not table reads. */
export async function tableScans(db: D1Database, query: ExecutedQuery): Promise<string[]> {
  const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.params).all<{ detail: string }>()).results ?? []
  return plan.map((row) => row.detail).filter((detail) => /^SCAN \w+/.test(detail) && !/^SCAN CONSTANT ROW/.test(detail))
}

export const day = (base: string, offset: number) => new Date(Date.parse(`${base}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
/** Trading weekdays ending at `last` (inclusive), newest first. */
export function weekdays(last: string, count: number): string[] {
  const out: string[] = []
  for (let offset = 0; out.length < count; offset--) {
    const date = day(last, offset)
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
    if (dow !== 0 && dow !== 6) out.push(date)
  }
  return out
}

type ReceiptStatus = 'completed' | 'failed' | 'blocked' | 'waiting'

/** Sub-stage progress of one business date, as the main Worker's progress callbacks leave it in pipeline_stage_runs. */
export type StageProgressSeed = {
  finlab?: {
    /** Must equal the finlab-v4-backfill state row's run_id, or the cards show no record. */
    runId: string
    /** acquire / validate / publish in order; a phase not listed has not started. Only the last may be running or waiting. */
    phases: Array<'completed' | 'running' | 'failed' | 'waiting'>
    startedAt: string
    /** Length of each ended phase (default 10 min). */
    phaseMs?: number
    observedAt?: string
    dispatchAttempt?: number
  }
  pipeline?: {
    runId: string
    /** The durable pipeline_execution row; waiting + lastError 'awaiting_premarket' is an accepted L3 seal. */
    execution: { status: 'queued' | 'running' | 'waiting' | 'success' | 'error'; lastError?: string | null }
    /** Omit for a run that has reported no phase yet. `runId` differing from the execution's is a previous run's progress. */
    progress?: {
      runId?: string
      phase: string
      status: 'running' | 'waiting' | 'completed' | 'failed' | 'blocked'
      /** Phase receipts in order, each `phaseMs` long (default 4 min) from `startedAt`. */
      done: Array<string | { phase: string; status: ReceiptStatus }>
      startedAt: string
      phaseMs?: number
      observedAt?: string
    }
    batches?: Array<{ phase: 'input_prep' | 'prepare_prediction_request'; completed: number; total: number }>
  }
}

const iso = (ms: number) => new Date(ms).toISOString()
/** Phase receipts as the Python writers store them: microseconds and `+00:00`. */
const pyIso = (ms: number) => new Date(ms).toISOString().replace('Z', '000+00:00')

/** Replaces the date's progress rows (finlab_progress, pipeline_execution, pipeline_progress, pipeline_batches:*). */
export async function seedStageProgress(db: D1Database, date: string, seed: StageProgressSeed): Promise<void> {
  await db.prepare(`DELETE FROM pipeline_stage_runs WHERE business_date = ? AND stage IN ('finlab_progress', 'pipeline_execution',
    'pipeline_progress', 'pipeline_batches:input_prep', 'pipeline_batches:prepare_prediction_request')`).bind(date).run()
  const rows: Array<Record<string, unknown>> = []
  const { finlab, pipeline } = seed
  if (finlab) {
    const step = finlab.phaseMs ?? 10 * 60_000
    const start = Date.parse(finlab.startedAt)
    const phases = finlab.phases.map((status, i) => ({
      phase: (['acquire', 'validate', 'publish'] as const)[i], status, started_at: pyIso(start + i * step),
      ...(status === 'running' ? {} : { completed_at: pyIso(start + (i + 1) * step), elapsed_ms: step }),
    }))
    const last = finlab.phases.at(-1)
    const observed = finlab.observedAt ?? iso(start + finlab.phases.length * step - (last === 'running' ? step / 2 : 0))
    rows.push({
      business_date: date, stage: 'finlab_progress', canonical_run_id: finlab.runId, started_at: phases[0].started_at, updated_at: observed,
      status: last === 'running' ? 'running' : finlab.phases.includes('failed') ? 'error' : last === 'completed' && phases.length === 3 ? 'success' : 'waiting',
      cursor_key: JSON.stringify({ run_id: finlab.runId, run_date: date, dispatch_attempt: finlab.dispatchAttempt ?? 1, sequence: phases.length * 2,
        observed_at: observed, phases }),
    })
  }
  if (pipeline) {
    rows.push({ business_date: date, stage: 'pipeline_execution', canonical_run_id: pipeline.runId, status: pipeline.execution.status,
      last_error: pipeline.execution.lastError ?? null, updated_at: pipeline.progress?.startedAt ?? `${date}T00:00:00.000Z` })
    const progress = pipeline.progress
    if (progress) {
      const step = progress.phaseMs ?? 4 * 60_000
      const start = Date.parse(progress.startedAt)
      const receipts = progress.done.map((item, i) => ({
        phase: typeof item === 'string' ? item : item.phase, status: typeof item === 'string' ? 'completed' : item.status,
        elapsed_ms: step, started_at: pyIso(start + i * step), completed_at: pyIso(start + (i + 1) * step),
      }))
      const phaseStart = start + receipts.length * step
      const observed = progress.observedAt ?? iso(phaseStart + step / 2)
      const runId = progress.runId ?? pipeline.runId
      const execution = `${runId}-exec-1`
      rows.push({
        business_date: date, stage: 'pipeline_progress', canonical_run_id: runId, status: 'running', started_at: iso(start), updated_at: observed,
        cursor_key: JSON.stringify({ phase: progress.phase, status: progress.status, started_at: iso(start), phase_started_at: iso(phaseStart),
          observed_at: observed, execution_id: execution, completed: receipts, executions: { [execution]: receipts } }),
      })
      for (const batch of pipeline.batches ?? []) {
        rows.push({ business_date: date, stage: `pipeline_batches:${batch.phase}`, canonical_run_id: runId, status: 'running', updated_at: observed,
          cursor_key: JSON.stringify({ stage_id: 'a'.repeat(64), phase: batch.phase, completed: batch.completed, total: batch.total, observed_at: observed }) })
      }
    }
  }
  await insertRows(db, 'pipeline_stage_runs', rows)
}

/** Pipeline phases in run order: the six cards' phases through the L3 seal, then pre-market L4. */
export const PIPELINE_RUN_PHASES = ['node_load_inputs', 'node_load_market_env', 'node_attach_serving_context', 'node_prepare_l2_inputs',
  'input_snapshot', 'input_prep', 'node_build_payloads', 'node_prepare_sequence_inputs', 'node_l2_timesfm_enrich', 'seal_l2_inputs',
  'prepare_prediction_request', 'dispatch_prediction', 'modal_inference', 'node_l3_formal_predict', 'seal_l3_results',
  'node_compute_personas', 'node_recommend', 'node_write_d1']

/** A mid-run evening as of `nowMs`: FinLab published all three phases; the pipeline is in L2 (TimesFM) with the
 * input, snapshot, feature-batch and assembly cards done. The state rows to go with it: finlab-v4-backfill
 * success with run_id `finlab-<date>`, pipeline running. */
export function midRunProgress(date: string, nowMs: number): StageProgressSeed {
  const pipelineStart = nowMs - (8 * 4 + 2) * 60_000
  return {
    finlab: { runId: `finlab-${date}`, phases: ['completed', 'completed', 'completed'], startedAt: iso(pipelineStart - 60 * 60_000) },
    pipeline: { runId: `pipeline-${date}`, execution: { status: 'running' }, batches: [{ phase: 'input_prep', completed: 8, total: 8 }],
      progress: { phase: 'node_l2_timesfm_enrich', status: 'running', done: PIPELINE_RUN_PHASES.slice(0, 8), startedAt: iso(pipelineStart) } },
  }
}

/** A finished day: every phase has its receipt and the durable pipeline stage is success. State rows: both parents
 * success, finlab-v4-backfill with run_id `finlab-<date>`. */
export function finishedProgress(date: string): StageProgressSeed {
  return {
    finlab: { runId: `finlab-${date}`, phases: ['completed', 'completed', 'completed'], startedAt: `${date}T10:20:00.000Z` },
    pipeline: { runId: `pipeline-${date}`, execution: { status: 'success' }, batches: [{ phase: 'input_prep', completed: 8, total: 8 }],
      progress: { phase: 'node_export_dataset_snapshot', status: 'completed', done: PIPELINE_RUN_PHASES, startedAt: `${date}T15:40:00.000Z` } },
  }
}
