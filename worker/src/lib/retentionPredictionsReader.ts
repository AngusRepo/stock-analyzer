import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { sha256Text } from './datasetSnapshots'
import { RETENTION_HOT_READER_FLOORS } from './retentionHotWindowDrain'

// Cold history of Learning `predictions` rows that retention-hot-window-drain archived to R2
// and deleted. Mirrors ml-controller retention_history.archived_predictions: verified checksum,
// exact source release proof, and hot rows win over archived copies of the same id.
type Row = Record<string, unknown>
export type ArchivedPredictionsEnv = Pick<Bindings, 'DB'> & Partial<Bindings>
const SCHEMA = 'd1-retention-hot-window-drain-v1'
const DOMAIN = 'retention_learning_lineage_v1_predictions'
const MAX_ARCHIVE_BYTES = 7 * 1024 * 1024

export type ArchivedPredictionsQuery = {
  start: string
  end: string
  dateColumn?: 'prediction_date' | 'generated_at'
  modelName?: string
  stockIds?: ReadonlyArray<number | string>
  filter?: (row: Row) => boolean
}

function bound(value: string, field: string): string {
  const text = String(value ?? '')
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) throw new Error(`retention_prediction_request_invalid:${field}`)
  return text
}

type Manifest = Record<string, any>
type ReadState = { stocks: Set<number> | null; fingerprints: Map<number, string> }

const END_EXPR = `COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.coverage_end') END,'9999-12-31')`
const START_EXPR = `COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.coverage_start') END,'0000-01-01')`
const GEN_END_EXPR = `COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.generated_coverage_end') END,'9999-12-31')`
const GEN_START_EXPR = `COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.generated_coverage_start') END,'0000-01-01')`
const MANIFEST_COLUMNS = `a.artifact_id,a.domain,a.r2_key,a.checksum,a.row_count,a.byte_size,a.metadata_json,
      (SELECT MAX(i.completed_at) FROM data_retention_run_items i WHERE i.status='success'
        AND i.deleted_rows=a.row_count
        AND CASE WHEN json_valid(i.evidence_json) THEN json_extract(i.evidence_json,'$.artifact_id') END=a.artifact_id
        AND CASE WHEN json_valid(i.evidence_json) THEN json_extract(i.evidence_json,'$.checksum') END=a.checksum) release_verified_at`
const MANIFEST_SCOPE = `a.domain=? AND a.schema_version=? AND a.retention_class='ten_year_cold_archive'
        AND a.status='ready' AND a.payload_deleted_at IS NULL`

function windowOf(query: ArchivedPredictionsQuery) {
  const start = bound(query.start, 'start'), end = bound(query.end, 'end')
  const dateColumn = query.dateColumn ?? 'prediction_date'
  const empty = start > end || (dateColumn === 'prediction_date' && start.slice(0, 10) >= oldestArchivablePredictionDate())
  return { start, end, dateColumn, empty }
}

function readState(query: ArchivedPredictionsQuery): ReadState {
  return { stocks: query.stockIds ? new Set(query.stockIds.map(Number)) : null, fingerprints: new Map() }
}

/** Newest key a manifest can hold for the read's date column; unknown coverage sorts first (must be read). */
function manifestEndKey(manifest: Manifest, dateColumn: string): string {
  const metadata = JSON.parse(manifest.metadata_json || '{}')
  const value = dateColumn === 'prediction_date' ? metadata.coverage_end : metadata.generated_coverage_end
  return typeof value === 'string' && value ? value : '9999-12-31'
}

/** Manifests overlapping the window, in artifact order (ops metadata only, no R2). */
async function* manifestsByArtifact(env: ArchivedPredictionsEnv, query: ArchivedPredictionsQuery): AsyncGenerator<Manifest> {
  const { start, end, dateColumn } = windowOf(query)
  const ops = databaseForDataDomain(env, 'ops')
  const coverage = dateColumn === 'prediction_date' ? 'coverage' : 'generated_coverage'
  const [coverageStart, coverageEnd] = dateColumn === 'prediction_date' ? [start.slice(0, 10), end.slice(0, 10)] : [start, end]
  let cursor = ''
  while (true) {
    const manifests = (await ops.prepare(`SELECT ${MANIFEST_COLUMNS}
      FROM run_artifacts a
      WHERE ${MANIFEST_SCOPE} AND a.artifact_id>?
        AND COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.${coverage}_end') END,'9999-12-31')>=?
        AND COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.${coverage}_start') END,'0000-01-01')<=?
      ORDER BY a.artifact_id LIMIT 100`).bind(DOMAIN, SCHEMA, cursor, coverageStart, coverageEnd).all<Manifest>()).results ?? []
    for (const manifest of manifests) { cursor = manifest.artifact_id; yield manifest }
    if (manifests.length < 100) return
  }
}

/**
 * Manifests overlapping the window, newest coverage end first, so latest-N reads stop early:
 * prediction_date pages idx_artifact_retention_coverage, generated_at pages ops 0029's index.
 */
async function* manifestsNewestFirst(env: ArchivedPredictionsEnv, query: ArchivedPredictionsQuery): AsyncGenerator<Manifest> {
  const { start, end, dateColumn } = windowOf(query)
  const ops = databaseForDataDomain(env, 'ops')
  if (dateColumn !== 'prediction_date') {
    // ops 0029 idx_artifact_retention_generated_coverage orders by the newest generated_at.
    let cursor: [string, string] = ['9999-12-31\uffff', '']
    while (true) {
      const manifests = (await ops.prepare(`SELECT ${MANIFEST_COLUMNS}, ${GEN_END_EXPR} AS coverage_end_key
        FROM run_artifacts a
        WHERE ${MANIFEST_SCOPE}
          AND ${GEN_END_EXPR}>=? AND ${GEN_START_EXPR}<=?
          AND (${GEN_END_EXPR}, a.artifact_id) < (?, ?)
        ORDER BY ${GEN_END_EXPR} DESC, a.artifact_id DESC LIMIT 100`)
        .bind(DOMAIN, SCHEMA, start, end, ...cursor).all<Manifest>()).results ?? []
      for (const manifest of manifests) {
        cursor = [manifest.coverage_end_key, manifest.artifact_id]
        yield manifest
      }
      if (manifests.length < 100) return
    }
  }
  let cursor: [string, string, string] = ['9999-12-31\uffff', '', '']
  while (true) {
    const manifests = (await ops.prepare(`SELECT ${MANIFEST_COLUMNS}, ${END_EXPR} AS coverage_end_key, ${START_EXPR} AS coverage_start_key
      FROM run_artifacts a
      WHERE ${MANIFEST_SCOPE}
        AND ${END_EXPR}>=? AND ${START_EXPR}<=?
        AND (${END_EXPR}, ${START_EXPR}, a.artifact_id) < (?, ?, ?)
      ORDER BY ${END_EXPR} DESC, ${START_EXPR} DESC, a.artifact_id DESC LIMIT 100`)
      .bind(DOMAIN, SCHEMA, start.slice(0, 10), end.slice(0, 10), ...cursor).all<Manifest>()).results ?? []
    for (const manifest of manifests) {
      cursor = [manifest.coverage_end_key, manifest.coverage_start_key, manifest.artifact_id]
      yield manifest
    }
    if (manifests.length < 100) return
  }
}

/** One archive chunk: verified payload, rows in the window that are no longer hot, deduplicated by id. */
async function archivedChunkRows(env: ArchivedPredictionsEnv, manifest: Manifest, query: ArchivedPredictionsQuery,
  state: ReadState, onGet?: () => void): Promise<Row[]> {
  const { start, end, dateColumn } = windowOf(query)
  const learning = databaseForDataDomain(env, 'learning')
  // Archives listing their stocks are skipped for other stocks; unknown metadata is read.
  const keys = JSON.parse(manifest.metadata_json || '{}').stock_keys
  if (state.stocks && Array.isArray(keys) && keys.length && !keys.some((key: unknown) => state.stocks!.has(Number(key)))) return []
  if (!(manifest.byte_size > 0 && manifest.byte_size <= MAX_ARCHIVE_BYTES)) throw new Error('retention_prediction_archive_size_invalid')
  onGet?.()
  const object = await env.ARTIFACTS?.get(manifest.r2_key)
  if (!object) throw new Error('retention_prediction_archive_missing')
  if (object.size > MAX_ARCHIVE_BYTES) throw new Error('retention_prediction_archive_size_invalid')
  const raw = await object.text()
  if (await sha256Text(raw) !== manifest.checksum) throw new Error('retention_prediction_checksum_mismatch')
  const body = JSON.parse(raw), payload = body.payload
  if (body.domain !== DOMAIN || body.schema_version !== SCHEMA || payload?.schema_version !== SCHEMA
      || payload.dataset_id !== 'predictions' || payload.source_domain !== 'learning' || payload.policy_id !== 'learning_lineage_v1'
      || !Array.isArray(payload.rows) || payload.rows.length !== manifest.row_count)
    throw new Error('retention_prediction_payload_mismatch')
  const relevant = (payload.rows as Row[]).filter((row) => {
    const when = String(row[dateColumn] ?? '')
    return when >= start && when <= end
      && (query.modelName == null || row.model_name === query.modelName)
      && (state.stocks == null || state.stocks.has(Number(row.stock_id)))
      && (query.filter?.(row) ?? true)
  })
  if (!relevant.length) return []
  for (const row of relevant) {
    if (!Number.isSafeInteger(row.id) || row.id !== row.__cursor_key || typeof payload.cutoff_date !== 'string'
        || String(row.prediction_date ?? '') >= payload.cutoff_date)
      throw new Error('retention_prediction_row_identity_invalid')
  }
  const present = new Set(((await learning.prepare('SELECT id FROM predictions WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(relevant.map((row) => row.id))).all<{ id: number }>()).results ?? []).map((row) => Number(row.id)))
  const missing = relevant.filter((row) => !present.has(Number(row.id)))
  if (!missing.length) return [] // Recovered or still-online rows stay authoritative.
  if (!manifest.release_verified_at) {
    const proof = await learning.prepare('SELECT checksum,dataset_id,row_count FROM learning_retention_releases_v1 WHERE artifact_id=?')
      .bind(manifest.artifact_id).first<Record<string, any>>()
    // No receipt: the delete never committed (the receipt shares its batch), so this orphan released
    // nothing; any of its rows missing from hot were deleted by another, receipted release.
    if (!proof) return []
    if (proof.checksum !== manifest.checksum || proof.dataset_id !== 'predictions' || proof.row_count !== manifest.row_count)
      throw new Error('retention_prediction_release_receipt_incomplete')
  }
  const out: Row[] = []
  for (const row of missing) {
    const clean = Object.fromEntries(Object.entries(row).filter(([name]) => name !== '__cursor_key' && name !== '__archive_date'))
    const fingerprint = await sha256Text(JSON.stringify(Object.entries(clean).sort(([a], [b]) => a.localeCompare(b))))
    const id = Number(clean.id)
    const previous = state.fingerprints.get(id)
    if (previous && previous !== fingerprint) throw new Error('retention_prediction_conflicting_versions')
    if (previous) continue
    state.fingerprints.set(id, fingerprint)
    out.push(clean)
  }
  return out
}

/** Every archived row in the window (callers that need the whole window, e.g. one date or one stock range). */
export async function readArchivedPredictions(env: ArchivedPredictionsEnv, query: ArchivedPredictionsQuery,
  observe?: { onGet?: () => void }): Promise<Row[]> {
  if (windowOf(query).empty) return []
  const state = readState(query)
  const out: Row[] = []
  for await (const manifest of manifestsByArtifact(env, query)) out.push(...await archivedChunkRows(env, manifest, query, state, observe?.onGet))
  return out
}

/**
 * The archived rows an ORDER BY <date column> DESC ... LIMIT `limit` read can still need: chunks are
 * read newest coverage first and reading stops once `limit` keys (hot `seedKeys` plus archived rows
 * found so far) are all newer than every remaining chunk. Rows tied on the key are kept, so the
 * caller's full ORDER BY decides them.
 */
export async function readArchivedPredictionsLatest(env: ArchivedPredictionsEnv, query: ArchivedPredictionsQuery,
  options: { limit: number; seedKeys?: readonly string[]; onGet?: () => void }): Promise<Row[]> {
  const { dateColumn, empty } = windowOf(query)
  if (empty || options.limit <= 0) return []
  const state = readState(query)
  const keys = [...(options.seedKeys ?? [])].sort().reverse()
  const out: Row[] = []
  for await (const manifest of manifestsNewestFirst(env, query)) {
    if (keys.length >= options.limit && manifestEndKey(manifest, dateColumn) < keys[options.limit - 1]) break
    const rows = await archivedChunkRows(env, manifest, query, state, options.onGet)
    if (!rows.length) continue
    out.push(...rows)
    keys.push(...rows.map((row) => String(row[dateColumn] ?? '')))
    keys.sort().reverse()
    keys.length = Math.min(keys.length, options.limit)
  }
  return out
}

/** True when the archive holds at least one row in the window (fail-closed readers; stops at the first one). */
export async function archivedPredictionsExist(env: ArchivedPredictionsEnv, query: ArchivedPredictionsQuery,
  observe?: { onGet?: () => void }): Promise<boolean> {
  if (windowOf(query).empty) return false
  const state = readState(query)
  for await (const manifest of manifestsNewestFirst(env, query)) {
    if ((await archivedChunkRows(env, manifest, query, state, observe?.onGet)).length) return true
  }
  return false
}

/**
 * Ensemble stock ids per archived prediction_date in [start, end] (price-horizon candidate sets).
 * Answered from manifest metadata (ensemble_stock_dates, written by the drain); a manifest without
 * it is read. Sets only: a receipt-less orphan names rows that are still hot, which the hot query
 * returns anyway.
 */
export async function readArchivedEnsembleStockDates(env: ArchivedPredictionsEnv, start: string, end: string,
  observe?: { onGet?: () => void }): Promise<Map<string, Set<number>>> {
  const query: ArchivedPredictionsQuery = { start, end, modelName: 'ensemble' }
  const out = new Map<string, Set<number>>()
  if (windowOf(query).empty) return out
  const add = (date: string, id: number) => {
    if (date < start.slice(0, 10) || date > end.slice(0, 10) || !Number.isSafeInteger(id)) return
    if (!out.has(date)) out.set(date, new Set())
    out.get(date)!.add(id)
  }
  const state = readState(query)
  for await (const manifest of manifestsByArtifact(env, query)) {
    const listed = JSON.parse(manifest.metadata_json || '{}').ensemble_stock_dates
    if (listed && typeof listed === 'object' && !Array.isArray(listed)) {
      for (const [date, ids] of Object.entries(listed)) for (const id of Array.isArray(ids) ? ids : []) add(date, Number(id))
      continue
    }
    for (const row of await archivedChunkRows(env, manifest, query, state, observe?.onGet))
      add(String(row.prediction_date ?? ''), Number(row.stock_id))
  }
  return out
}

/**
 * retentionHotDrainCutoff floors predictions at 120 + 7 buffer days from min(business date, Taipei today), so
 * every archived row is older than this date and newer prediction_date windows skip the ops lookup.
 * generated_at windows are always looked up: a backfilled row can be generated long after its date.
 */
export function oldestArchivablePredictionDate(now = Date.now()): string {
  const floor = RETENTION_HOT_READER_FLOORS.predictions
  const days = floor ? floor.days + floor.bufferDays : 120
  return new Date(now + 8 * 3600_000 - days * 86_400_000).toISOString().slice(0, 10)
}

/** SQLite json_extract(json, '$.a.b') for a JSON-valid text; undefined means NULL. */
export function sqliteJsonExtract(raw: unknown, path: readonly string[]): unknown {
  if (typeof raw !== 'string') return undefined
  let value: unknown
  try { value = JSON.parse(raw) } catch { return undefined }
  for (const key of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

/** COALESCE(json rank_score, json ensemble_v2.avg_rank, direction_accuracy), as the replay SQL projects it. */
export function predictionRankScore(row: Row): unknown {
  return sqliteJsonExtract(row.forecast_data, ['rank_score'])
    ?? sqliteJsonExtract(row.forecast_data, ['ensemble_v2', 'avg_rank'])
    ?? row.direction_accuracy ?? null
}

function sqliteCompare(a: unknown, b: unknown): number {
  // NULL < numbers < text, like SQLite's default ordering for these columns.
  const rank = (v: unknown) => v == null ? 0 : typeof v === 'number' ? 1 : 2
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  if (a == null) return 0
  if (typeof a === 'number') return a - (b as number)
  const x = String(a), y = String(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Sort comparator over keys; `desc` flags follow the SQL ORDER BY terms. */
export function sqliteOrder<T extends object>(...terms: Array<[(row: T) => unknown, 'asc' | 'desc']>) {
  return (a: T, b: T) => {
    for (const [key, direction] of terms) {
      const result = sqliteCompare(key(a), key(b))
      if (result) return direction === 'desc' ? -result : result
    }
    return 0
  }
}

/**
 * Latest-N reads (ORDER BY <date> DESC ... LIMIT): the archived rows the original query would have
 * kept. A full hot page only needs archived rows at or after its oldest key; a short page needs the
 * newest archived rows of the whole window. Either way chunks are read newest first and only until
 * the result can no longer change. Returns `hotRows` itself when no archived row makes the cut.
 */
export async function mergeArchivedLatestPredictions<T extends object>(env: ArchivedPredictionsEnv, input: {
  hotRows: T[]
  limit: number
  start?: string | null
  end?: string | null
  dateOf: (row: T) => string
  order: (a: T, b: T) => number
  project: (row: Row) => T
  query: Omit<ArchivedPredictionsQuery, 'start' | 'end'>
  onGet?: () => void
}): Promise<T[]> {
  const hotKeys = input.hotRows.map(input.dateOf)
  const oldestHot = input.hotRows.length >= input.limit ? [...hotKeys].sort()[0] ?? null : null
  const start = [input.start ?? '0000-01-01', ...(oldestHot ? [oldestHot] : [])].sort().at(-1)!
  const cold = await readArchivedPredictionsLatest(env,
    { ...input.query, start, end: endOfDay(input.end ?? '9999-12-31', input.query.dateColumn) },
    { limit: input.limit, seedKeys: hotKeys, onGet: input.onGet })
  if (!cold.length) return input.hotRows
  const projected = new Set(cold.map(input.project))
  const merged = [...input.hotRows, ...projected].sort(input.order).slice(0, input.limit)
  return merged.some((row) => projected.has(row)) ? merged : input.hotRows
}

/**
 * Fail-closed guard for single-database ORDER BY <date> DESC LIMIT reads that cannot merge archived
 * rows: true when some archived row could have been in the result. A full page is only affected at
 * or after its oldest date, so the usual nightly read touches neither ops nor R2.
 */
export async function archivedPredictionsCouldChangeLatest(env: ArchivedPredictionsEnv, input: {
  hotDates: readonly string[]
  limit: number
  start?: string | null
  end?: string | null
  query: Omit<ArchivedPredictionsQuery, 'start' | 'end'>
  onGet?: () => void
}): Promise<boolean> {
  const oldestHot = input.hotDates.length >= input.limit ? [...input.hotDates].sort()[0] ?? null : null
  const start = [input.start ?? '0000-01-01', ...(oldestHot ? [oldestHot] : [])].sort().at(-1)!
  return archivedPredictionsExist(env, { ...input.query, start, end: input.end ?? '9999-12-31' }, { onGet: input.onGet })
}

function endOfDay(value: string, dateColumn?: string): string {
  return dateColumn === 'generated_at' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value
}

/** /recommendations/daily prediction reads for one stock chunk: hot rows plus the R2 archive of that date. */
export async function readDailyRecommendationPredictions(env: ArchivedPredictionsEnv, learningDb: D1Database,
  date: string, stockIds: number[]): Promise<{ ensembleRows: { results: any[] }; perModelRows: { results: any[] } }> {
  const placeholders = stockIds.map(() => '?').join(',')
  const [ensembleRows, perModelRows] = await Promise.all([
    learningDb.prepare(`
      SELECT stock_id, forecast_data, generated_at, id
        FROM predictions
       WHERE stock_id IN (${placeholders})
         AND model_name = 'ensemble'
         AND prediction_date = ?
       ORDER BY stock_id, generated_at DESC, id DESC
    `).bind(...stockIds, date).all<any>().catch(() => ({ results: [] as any[], failed: true })),
    learningDb.prepare(`
      SELECT stock_id, model_name, signal_raw, direction_accuracy, forecast_data
        FROM predictions
       WHERE stock_id IN (${placeholders})
         AND model_name != 'ensemble'
         AND model_name NOT LIKE '%::challenger'
         AND prediction_date = ?
       ORDER BY stock_id, model_name
    `).bind(...stockIds, date).all<any>().catch(() => ({ results: [] as any[], failed: true })),
  ])
  // A date past the 120-day hot window reads its R2 archive; same filters and order as the SQL above.
  const archived = (await readArchivedPredictions(env, { start: date, end: date, stockIds }))
    .filter((row) => row.prediction_date === date)
  if (!archived.length) return { ensembleRows: { results: ensembleRows.results ?? [] }, perModelRows: { results: perModelRows.results ?? [] } }
  // A hot query that failed served [] before the drain; its archived rows stay out the same way.
  const ensembleArchived = 'failed' in ensembleRows ? [] : archived.filter((row) => row.model_name === 'ensemble')
  const perModelArchived = 'failed' in perModelRows ? [] : archived
  return {
    ensembleRows: { results: [...(ensembleRows.results ?? []), ...ensembleArchived
      .map((row) => ({ stock_id: row.stock_id, forecast_data: row.forecast_data ?? null, generated_at: row.generated_at ?? null, id: row.id }))]
      .sort(sqliteOrder<any>([(row) => row.stock_id, 'asc'], [(row) => row.generated_at, 'desc'], [(row) => row.id, 'desc'])) },
    perModelRows: { results: [...(perModelRows.results ?? []), ...perModelArchived
      .filter((row) => row.model_name !== 'ensemble' && !/::challenger$/i.test(String(row.model_name)))
      .map((row) => ({ stock_id: row.stock_id, model_name: row.model_name, signal_raw: row.signal_raw ?? null,
        direction_accuracy: row.direction_accuracy ?? null, forecast_data: row.forecast_data ?? null }))]
      .sort(sqliteOrder<any>([(row) => row.stock_id, 'asc'], [(row) => row.model_name, 'asc'])) },
  }
}

const TRADE_HISTORY_COLUMNS = ['generated_at', 'model_name', 'trade_signal', 'predicted_direction', 'actual_direction',
  'direction_correct', 'entry_price', 'stop_loss', 'target1', 'target2', 'trade_outcome', 'trade_pnl_pct', 'trade_pnl_r',
  'max_favorable_pct', 'max_adverse_pct', 'actual_return_pct', 'market_risk_level', 'verified_at'] as const

/** /ml/trade-history/:stockId: latest simulated trades; ones older than the hot window come from R2. */
export async function readPredictionTradeHistory(env: ArchivedPredictionsEnv, stockId: number, limit: number): Promise<Row[]> {
  const { results } = await databaseForDataDomain(env, 'learning').prepare(`
    SELECT ${TRADE_HISTORY_COLUMNS.join(', ')}
    FROM predictions
    WHERE stock_id=? AND trade_pnl_pct IS NOT NULL
    ORDER BY generated_at DESC
    LIMIT ?
  `).bind(stockId, limit).all<Row>()
  return mergeArchivedLatestPredictions<Row>(env, {
    hotRows: results ?? [], limit, dateOf: (row) => String(row.generated_at ?? ''),
    order: sqliteOrder<Row>([(row) => row.generated_at, 'desc']),
    query: { dateColumn: 'generated_at', stockIds: [stockId], filter: (row) => row.trade_pnl_pct != null },
    project: (row) => Object.fromEntries(TRADE_HISTORY_COLUMNS.map((name) => [name, row[name] ?? null])),
  })
}

/** GET /api/dashboard/v4/stocks/:id model signals: latest rows by prediction_date, hot plus R2 archive. */
export async function readStockModelSignals(env: ArchivedPredictionsEnv, stockId: number, limit: number): Promise<Row[]> {
  const { results } = await databaseForDataDomain(env, 'learning').prepare(`
      SELECT prediction_date, generated_at, model_name, trade_signal, direction_accuracy
      FROM predictions
      WHERE stock_id=? AND prediction_date IS NOT NULL
      ORDER BY prediction_date DESC, generated_at DESC
      LIMIT ?
    `).bind(stockId, limit).all<Row>()
  return mergeArchivedLatestPredictions<Row>(env, {
    hotRows: results ?? [], limit, dateOf: (row) => String(row.prediction_date ?? ''),
    order: sqliteOrder<Row>([(row) => row.prediction_date, 'desc'], [(row) => row.generated_at, 'desc']),
    query: { stockIds: [stockId], filter: (row) => row.prediction_date != null },
    project: (row) => ({ prediction_date: row.prediction_date ?? null, generated_at: row.generated_at ?? null,
      model_name: row.model_name ?? null, trade_signal: row.trade_signal ?? null, direction_accuracy: row.direction_accuracy ?? null }),
  })
}

/** GET /api/stocks/:id/predictions: the latest rows by generated_at (all columns), hot plus R2 archive. */
export async function readStockLatestPredictions(env: ArchivedPredictionsEnv, stockId: number, limit: number): Promise<Row[]> {
  const { results } = await databaseForDataDomain(env, 'learning').prepare(
    'SELECT * FROM predictions WHERE stock_id=? ORDER BY generated_at DESC LIMIT ?',
  ).bind(stockId, limit).all<Row>()
  return mergeArchivedLatestPredictions<Row>(env, {
    hotRows: results ?? [], limit, dateOf: (row) => String(row.generated_at ?? ''),
    order: sqliteOrder<Row>([(row) => row.generated_at, 'desc']),
    query: { dateColumn: 'generated_at', stockIds: [stockId] },
    project: (row) => row,
  })
}
