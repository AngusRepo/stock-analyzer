import type { Bindings } from '../types'
import { databaseForTable } from './dataDomainRegistry'
import { LegacyEvidenceResolveError, resolveLegacyScreenerEvidence, type ResolvedLegacyEvidenceRow } from './legacyEvidenceResolver'

export const AUDIT_POINTER_SCHEMA = 'd1-audit-json-pointer-v1'
const KIND = 'd1_audit_json_archive'
const SCHEMA = 'd1-audit-json-archive-v1'
const TARGETS = ['screener_funnel_items', 'canonical_screener_funnel_items']

function fail(reason: string, status = 409): never {
  throw new LegacyEvidenceResolveError(`audit_evidence_${reason}`, status)
}

function archiveTarget(id: string, key: string): string | undefined {
  return TARGETS.find(value => id.startsWith(`${KIND}:${value}:`)
    && key.startsWith(`archives/${KIND}/target=${value}/`))
}

// Byte fail-safe for one archive chunk: its bytes are held whole for the checksum and scanned
// row by row, so a chunk costs ~1x its size plus one row. Prod max chunk is 15.72 MB of evidence
// (2026-08-05 retention, 500 rows) and bodies run ~1.07x that (JSON escaping), so ~16.8 MB;
// 20 MiB leaves headroom while keeping one chunk far under the 128 MB isolate.
export const FUNNEL_ARCHIVE_CHUNK_BYTE_LIMIT = 20 * 1024 * 1024
// Bytes one request may stream through, one chunk at a time. Prod max whole run is 68.6 MB of
// evidence (10-19, 72 chunks; ~73 MB of bodies); this bounds CPU and R2 reads, not retained heap.
export const FUNNEL_ARCHIVE_REQUEST_BYTE_LIMIT = 96 * 1024 * 1024

/** Bytes charged against a request's archive budget (see FunnelArchiveReader). */
interface ArchiveByteMeter {
  chunkBytes: number
  requestBytes: number
  bytesRead: number
  fetches: number
}

function chargeArchiveBytes(meter: ArchiveByteMeter | undefined, bytes: number, chunkLimit: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) return
  if (bytes > chunkLimit) fail('archive_chunk_bytes', 413)
  if (meter && meter.bytesRead + bytes > meter.requestBytes) fail('archive_request_bytes', 413)
}

const enum Byte { Tab = 0x09, Lf = 0x0a, Cr = 0x0d, Space = 0x20, Quote = 0x22, Comma = 0x2c, Colon = 0x3a,
  OpenBracket = 0x5b, Backslash = 0x5c, CloseBracket = 0x5d, OpenBrace = 0x7b, CloseBrace = 0x7d }

function scanError(): never {
  throw new SyntaxError('archive_scan')
}

function skipJsonSpace(bytes: Uint8Array, at: number): number {
  while (bytes[at] === Byte.Space || bytes[at] === Byte.Lf || bytes[at] === Byte.Cr || bytes[at] === Byte.Tab) at++
  return at
}

/** End (exclusive) of the JSON string opening at `at`; jumps quote to quote, honoring escapes. */
function jsonStringEnd(bytes: Uint8Array, at: number): number {
  for (let from = at + 1; ;) {
    const quote = bytes.indexOf(Byte.Quote, from)
    if (quote < 0) scanError()
    let backslashes = 0
    while (bytes[quote - 1 - backslashes] === Byte.Backslash) backslashes++
    if (backslashes % 2 === 0) return quote + 1
    from = quote + 1
  }
}

/** End (exclusive) of the JSON value starting at `at` (UTF-8 never puts structural bytes inside a code point). */
function jsonValueEnd(bytes: Uint8Array, at: number): number {
  const first = bytes[at]
  if (first === Byte.Quote) return jsonStringEnd(bytes, at)
  if (first === Byte.OpenBrace || first === Byte.OpenBracket) {
    let depth = 0
    for (let i = at; i < bytes.length;) {
      const byte = bytes[i]
      if (byte === Byte.Quote) { i = jsonStringEnd(bytes, i); continue }
      if (byte === Byte.OpenBrace || byte === Byte.OpenBracket) depth++
      else if ((byte === Byte.CloseBrace || byte === Byte.CloseBracket) && --depth === 0) return i + 1
      i++
    }
    scanError()
  }
  let end = at
  while (end < bytes.length && bytes[end] !== Byte.Comma && bytes[end] !== Byte.CloseBrace && bytes[end] !== Byte.CloseBracket
    && bytes[end] !== Byte.Space && bytes[end] !== Byte.Lf && bytes[end] !== Byte.Cr && bytes[end] !== Byte.Tab) end++
  if (end === at) scanError()
  return end
}

/**
 * Parses an archive body (top-level JSON object) without materializing it as one string:
 * header fields are parsed one by one and each `rows` element is parsed alone and handed to
 * `onRow`, so a chunk costs its bytes plus one row, not body string + whole parse tree (a
 * two-byte body string alone is ~2x the chunk). Returns the header with `rows` = row count.
 * Throws on anything that is not one well-formed object (duplicate top-level keys included).
 */
export function scanAuditArchiveBody(bytes: Uint8Array, onRow: (row: any) => void): Record<string, any> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parse = (from: number, to: number) => JSON.parse(decoder.decode(bytes.subarray(from, to)))
  const header: Record<string, any> = Object.create(null)
  let at = skipJsonSpace(bytes, 0)
  if (bytes[at] !== Byte.OpenBrace) scanError()
  at = skipJsonSpace(bytes, at + 1)
  if (bytes[at] === Byte.CloseBrace) at++
  else for (;;) {
    if (bytes[at] !== Byte.Quote) scanError()
    const keyEnd = jsonStringEnd(bytes, at)
    const key = parse(at, keyEnd)
    if (typeof key !== 'string' || key in header) scanError()
    at = skipJsonSpace(bytes, keyEnd)
    if (bytes[at] !== Byte.Colon) scanError()
    at = skipJsonSpace(bytes, at + 1)
    if (key === 'rows' && bytes[at] === Byte.OpenBracket) {
      let count = 0
      at = skipJsonSpace(bytes, at + 1)
      if (bytes[at] !== Byte.CloseBracket) for (;;) {
        const end = jsonValueEnd(bytes, at)
        onRow(parse(at, end))
        count++
        at = skipJsonSpace(bytes, end)
        if (bytes[at] === Byte.Comma) { at = skipJsonSpace(bytes, at + 1); continue }
        if (bytes[at] !== Byte.CloseBracket) scanError()
        break
      }
      header.rows = count
      at++
    } else {
      const end = jsonValueEnd(bytes, at)
      header[key] = parse(at, end)
      at = end
    }
    at = skipJsonSpace(bytes, at)
    if (bytes[at] === Byte.Comma) { at = skipJsonSpace(bytes, at + 1); continue }
    if (bytes[at] !== Byte.CloseBrace) scanError()
    at++
    break
  }
  if (skipJsonSpace(bytes, at) !== bytes.length) scanError()
  return header
}

async function sha256Bytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** What one chunk read keeps: the rows asked for, and (when asked) every row's projection. */
interface AuditArchiveRead {
  rows: Map<number, Record<string, any>>
  projection: Map<number, ArchivedRowProjection> | null
}

/**
 * One verified archive chunk (manifest, byte budget, R2 checksum, payload contract). Keeps only
 * the `wanted` rows (and, with `project`, a small projection of every row); nothing is kept
 * unless the whole chunk verifies.
 */
async function loadAuditArchiveRows(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  id: string, key: string, checksum: string, target: string,
  options: { meter?: ArchiveByteMeter; wanted?: ReadonlySet<number>; project?: boolean } = {},
): Promise<AuditArchiveRead> {
  const { meter, wanted, project = false } = options
  const db = databaseForTable(env, 'dataset_snapshots')
  const manifest = await db.prepare(`
    SELECT snapshot_id, kind, schema_version, status, primary_store, r2_key,
           checksum, row_count, metadata_json
      FROM dataset_snapshots WHERE snapshot_id=? LIMIT 1
  `).bind(id).first<Record<string, any>>()
  if (!manifest) fail('manifest_missing')
  if (manifest.kind !== KIND || manifest.schema_version !== SCHEMA || manifest.status !== 'ready'
    || manifest.primary_store !== 'r2' || manifest.r2_key !== key
    || String(manifest.checksum).toLowerCase() !== checksum) fail('manifest_mismatch')
  let metadata: any
  try { metadata = JSON.parse(manifest.metadata_json ?? '{}') } catch { fail('manifest_json_invalid') }
  if (metadata.table !== 'screener_funnel_items' || metadata.target !== target
    || metadata.key_column !== 'id' || !Array.isArray(metadata.blob_columns)
    || !metadata.blob_columns.includes('evidence')) fail('manifest_identity_mismatch')
  const chunkLimit = meter?.chunkBytes ?? FUNNEL_ARCHIVE_CHUNK_BYTE_LIMIT
  // Manifest pre-check: refuse before any R2 read (evidence bytes are a lower bound of the body).
  chargeArchiveBytes(meter, Number(metadata.archived_blob_bytes), chunkLimit)
  const object = await env.ARTIFACTS?.get(key)
  if (meter) meter.fetches += 1
  if (!object) fail('payload_missing')
  // R2 reports the body size before it is read: the hard guard against reading an oversized chunk.
  chargeArchiveBytes(meter, Number((object as { size?: unknown }).size), chunkLimit)
  const reader = object as { arrayBuffer?: () => Promise<ArrayBuffer>; text: () => Promise<string> }
  const bytes = typeof reader.arrayBuffer === 'function'
    ? new Uint8Array(await reader.arrayBuffer())
    : new TextEncoder().encode(await reader.text())
  chargeArchiveBytes(meter, bytes.length, chunkLimit)
  if (meter) meter.bytesRead += bytes.length
  if ((await sha256Bytes(bytes)) !== checksum) fail('checksum_mismatch')
  const ids = new Set<number>()
  const rows = new Map<number, Record<string, any>>()
  const projection = project ? new Map<number, ArchivedRowProjection>() : null
  let header: Record<string, any>
  try {
    header = scanAuditArchiveBody(bytes, (row) => {
      const rowId = Number(row?.id)
      if (!Number.isSafeInteger(rowId) || rowId <= 0 || ids.has(rowId)) fail('duplicate_or_invalid_row')
      ids.add(rowId)
      if (wanted?.has(rowId)) rows.set(rowId, row)
      projection?.set(rowId, projectArchivedRow(row))
    })
  } catch (error) {
    if (error instanceof LegacyEvidenceResolveError) throw error
    fail('payload_json_invalid')
  }
  if (header.schema_version !== SCHEMA || header.archive_kind !== KIND || header.target !== target
    || header.table !== 'screener_funnel_items' || header.key_column !== 'id'
    || !Array.isArray(header.blob_columns) || !header.blob_columns.includes('evidence') || typeof header.rows !== 'number'
    || header.rows !== Number(manifest.row_count) || header.row_count !== header.rows) {
    fail('payload_contract_mismatch')
  }
  return { rows, projection }
}

async function resolveAuditArchive(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  request: Record<string, any>,
): Promise<ResolvedLegacyEvidenceRow[]> {
  const id = String(request.snapshot_id ?? '')
  const key = String(request.r2_key ?? '')
  const checksum = String(request.checksum ?? '').toLowerCase()
  const sourceRun = String(request.source_run_id ?? '')
  const target = archiveTarget(id, key)
  if (!target || id.length > 1024 || key.length > 2048 || request.artifact_id !== id
    || !/^sha256:[a-f0-9]{64}$/.test(checksum) || !sourceRun || sourceRun.length > 500) {
    fail('pointer_invalid', 400)
  }
  const { rows: byId } = await loadAuditArchiveRows(env, id, key, checksum, target, { wanted: new Set(request.row_ids) })
  return request.row_ids.map((rowId: number) => {
    const row = byId.get(rowId)
    if (!row || row.run_id !== sourceRun || row.stage !== 'scoring'
      || typeof row.symbol !== 'string' || !row.symbol.trim()
      || typeof row.evidence !== 'string' || !row.evidence.trim()) fail(`row_identity_mismatch:${rowId}`)
    let evidence: any
    try { evidence = JSON.parse(row.evidence) } catch { fail(`row_json_invalid:${rowId}`) }
    // Never recursively follow pointers or return another archived placeholder.
    if (!evidence?.score_components || evidence.schema_version === AUDIT_POINTER_SCHEMA) fail(`row_payload_missing:${rowId}`)
    return { row_id: rowId, symbol: row.symbol.trim(), stage: row.stage, evidence: row.evidence,
      source_run_id: sourceRun, artifact_id: id, r2_key: key, checksum }
  })
}

/** Same authenticated read API, both retention formats; all-or-error coverage. */
export async function resolveScreenerEvidence(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  raw: unknown,
): Promise<{ rows: ResolvedLegacyEvidenceRow[]; artifacts: number }> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) fail('artifact_limit', 400)
  const ids = new Set<number>()
  for (const request of raw) {
    if (!Array.isArray(request?.row_ids) || !request.row_ids.length) fail('row_ids_missing', 400)
    for (const id of request.row_ids) {
      if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id)) fail('row_ids_invalid', 400)
      ids.add(id)
    }
  }
  if (ids.size > 400) fail('row_limit', 400)
  const rows: ResolvedLegacyEvidenceRow[] = []
  for (const request of raw) {
    if (request.schema_version === AUDIT_POINTER_SCHEMA) rows.push(...await resolveAuditArchive(env, request))
    else if (!request.schema_version || request.schema_version === 'legacy-screener-evidence-pointer-v1') {
      rows.push(...(await resolveLegacyScreenerEvidence(env, [request])).rows)
    } else fail('pointer_schema_unsupported', 400)
  }
  return { rows: rows.sort((a, b) => a.row_id - b.row_id), artifacts: raw.length }
}

export interface ArchivedFunnelEvidenceRow {
  id?: unknown
  run_id?: unknown
  stage?: unknown
  symbol?: unknown
  evidence?: unknown
}

// Chunk-count guard per call, next to the byte budget. A whole historical run is read in one
// call: prod 10-19 is 72 chunks (10-13: 66), so 128 leaves headroom; bytes are the real bound.
export const FUNNEL_EVIDENCE_ARCHIVE_LIMIT = 128

/** Per archived row, what is kept after its chunk is dropped: identity plus strategy ids. */
interface ArchivedRowProjection {
  run_id: unknown
  stage: unknown
  symbol: unknown
  strategy_ids: string[] | null
  invalid: string | null
}

/** Strategy ids of one funnel evidence object (array elements, object values or the scalar). */
export function funnelEvidenceStrategyIds(evidence: Record<string, any>): string[] {
  const ids = evidence?.strategy_pool_ids ?? evidence?.strategy_ids
  // Same as the SQL json_each: array elements, object values, or the scalar itself.
  return (Array.isArray(ids) ? ids : ids && typeof ids === 'object' ? Object.values(ids) : [ids])
    .filter((value) => typeof value === 'string' || typeof value === 'number').map(String)
}

/** Parsed pre-image of one archived row, or the reason it is unusable. */
function archivedRowEvidence(original: Record<string, any> | undefined): { evidence: Record<string, any> } | { invalid: string } {
  if (!original || typeof original.evidence !== 'string' || !original.evidence.trim()) return { invalid: 'row_identity_mismatch' }
  let evidence: any
  try { evidence = JSON.parse(original.evidence) } catch { return { invalid: 'row_json_invalid' } }
  // Never recursively follow pointers or return another archived placeholder.
  if (!evidence || typeof evidence !== 'object' || evidence.schema_version === AUDIT_POINTER_SCHEMA) {
    return { invalid: 'row_payload_missing' }
  }
  return { evidence }
}

function projectArchivedRow(original: Record<string, any>): ArchivedRowProjection {
  const parsed = archivedRowEvidence(original)
  return { run_id: original?.run_id, stage: original?.stage, symbol: original?.symbol,
    strategy_ids: 'evidence' in parsed ? funnelEvidenceStrategyIds(parsed.evidence) : null,
    invalid: 'invalid' in parsed ? parsed.invalid : null }
}

/**
 * Request-scoped archive reader. Chunks are read one at a time and dropped after use; what
 * outlives a chunk is a small per-row projection (identity + strategy ids), so the pipeline
 * stages and every symbol slice of one request share one R2 read per chunk without holding
 * parsed chunks. Byte budgets fail closed (archive_chunk_bytes / archive_request_bytes).
 * Create it per request; never keep it across requests.
 */
export class FunnelArchiveReader implements ArchiveByteMeter {
  readonly chunkBytes: number
  readonly requestBytes: number
  readonly chunkLimit: number
  bytesRead = 0
  fetches = 0
  private readonly projections = new Map<string, Map<number, ArchivedRowProjection>>()
  private readonly inflight = new Map<string, Promise<Map<number, ArchivedRowProjection>>>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
    budget: { chunkBytes?: number; requestBytes?: number; chunks?: number } = {},
  ) {
    this.chunkBytes = budget.chunkBytes ?? FUNNEL_ARCHIVE_CHUNK_BYTE_LIMIT
    this.requestBytes = budget.requestBytes ?? FUNNEL_ARCHIVE_REQUEST_BYTE_LIMIT
    this.chunkLimit = budget.chunks ?? FUNNEL_EVIDENCE_ARCHIVE_LIMIT
  }

  /**
   * Loads one verified chunk and returns its `wanted` rows; loads are serialized so at most one
   * chunk is read at a time. The first read of a chunk also caches its row projection.
   */
  loadChunk(archive: ArchiveGroup, wanted: ReadonlySet<number> = new Set()): Promise<Map<number, Record<string, any>>> {
    const cacheKey = archiveCacheKey(archive)
    const run = this.queue.then(() => loadAuditArchiveRows(this.env, archive.id, archive.key, archive.checksum, archive.target,
      { meter: this, wanted, project: !this.projections.has(cacheKey) }))
    // The queue must not hold the chunk itself once it is handed out.
    this.queue = run.then(() => undefined, () => undefined)
    return run.then(({ rows, projection }) => {
      if (projection && !this.projections.has(cacheKey)) this.projections.set(cacheKey, projection)
      return rows
    })
  }

  private async projection(archive: ArchiveGroup): Promise<Map<number, ArchivedRowProjection>> {
    const cacheKey = archiveCacheKey(archive)
    const ready = this.projections.get(cacheKey)
    if (ready) return ready
    let pending = this.inflight.get(cacheKey)
    if (!pending) {
      // The full chunk is dropped once projected; only the projection stays cached.
      pending = this.loadChunk(archive).then(() => this.projections.get(cacheKey)!)
        .finally(() => this.inflight.delete(cacheKey))
      this.inflight.set(cacheKey, pending)
    }
    return pending
  }

  /**
   * Strategy ids of each pointer row (by row index), all-or-error like visitArchivedFunnelEvidence.
   * Served from projections when the chunk was already read in this request.
   */
  async strategyIds<T extends ArchivedFunnelEvidenceRow>(rows: T[]): Promise<Map<number, string[]>> {
    const archives = groupArchivePointers(rows)
    if (archives.size > this.chunkLimit) fail('archive_limit', 413)
    const out = new Map<number, string[]>()
    for (const archive of archives.values()) {
      const projected = await this.projection(archive)
      for (const index of archive.indexes) {
        const row = rows[index]
        const original = projected.get(Number(row.id))
        if (!original || original.run_id !== row.run_id || original.stage !== row.stage || original.symbol !== row.symbol) {
          fail(`row_identity_mismatch:${row.id}`)
        }
        if (original.invalid || !original.strategy_ids) fail(`${original.invalid ?? 'row_payload_missing'}:${row.id}`)
        out.set(index, original.strategy_ids)
      }
    }
    return out
  }
}

interface ArchiveGroup { id: string; key: string; checksum: string; target: string; indexes: number[] }

function archiveCacheKey(archive: { id: string; key: string; checksum: string }): string {
  return `${archive.id}\u0000${archive.key}\u0000${archive.checksum}`
}

export interface FunnelArchiveReadOptions {
  limit?: number
  reader?: FunnelArchiveReader
}

/** True for evidence the retention job replaced with a d1-audit-json-pointer-v1. */
export function isAuditPointerEvidence(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw.includes(AUDIT_POINTER_SCHEMA)) return false
  try { return JSON.parse(raw)?.schema_version === AUDIT_POINTER_SCHEMA } catch { return false }
}

function funnelEvidencePointer(row: ArchivedFunnelEvidenceRow) {
  const raw = row.evidence
  if (!isAuditPointerEvidence(raw)) return null
  const pointer = JSON.parse(raw as string)
  const rowId = Number(row.id)
  const id = String(pointer.snapshot_id ?? '')
  const key = String(pointer.r2_key ?? '')
  const checksum = String(pointer.checksum ?? '').toLowerCase()
  const target = archiveTarget(id, key)
  if (!target || id.length > 1024 || key.length > 2048 || !/^sha256:[a-f0-9]{64}$/.test(checksum)
    || pointer.table !== 'screener_funnel_items' || pointer.key_column !== 'id' || pointer.blob_column !== 'evidence'
    || !Number.isSafeInteger(rowId) || rowId <= 0 || Number(pointer.key_value) !== rowId) {
    fail(`pointer_invalid:${row.id}`, 400)
  }
  return { id, key, checksum, target }
}

/** Pointer rows grouped by archive chunk (row indexes per chunk); rows without a pointer are skipped. */
function groupArchivePointers(rows: ArchivedFunnelEvidenceRow[]): Map<string, ArchiveGroup> {
  const archives = new Map<string, ArchiveGroup>()
  rows.forEach((row, index) => {
    const pointer = funnelEvidencePointer(row)
    if (!pointer) return
    const group = archives.get(pointer.id) ?? { ...pointer, indexes: [] }
    if (group.key !== pointer.key || group.checksum !== pointer.checksum) fail(`pointer_invalid:${row.id}`, 400)
    group.indexes.push(index)
    archives.set(pointer.id, group)
  })
  return archives
}

/**
 * Hands each pointer row its verified R2 pre-image (text and parsed object), for any
 * stage, one chunk at a time; rows without a pointer are not visited. All-or-error: an
 * unverifiable pointer or too many chunks throws. Rows must carry id, run_id, stage and
 * symbol so each pre-image is matched to its row.
 */
export async function visitArchivedFunnelEvidence<T extends ArchivedFunnelEvidenceRow>(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  rows: T[],
  visit: (index: number, row: T, evidenceText: string, evidence: Record<string, any>) => void,
  options: FunnelArchiveReadOptions = {},
): Promise<number> {
  const archives = groupArchivePointers(rows)
  if (archives.size > (options.limit ?? options.reader?.chunkLimit ?? FUNNEL_EVIDENCE_ARCHIVE_LIMIT)) fail('archive_limit', 413)
  let byId: Map<number, Record<string, any>> | null = null
  for (const archive of archives.values()) {
    // One chunk at a time: drop the previous chunk before reading the next; only the
    // reader's small projection outlives an iteration.
    byId = null
    const wanted = new Set(archive.indexes.map((index) => Number(rows[index].id)))
    byId = options.reader
      ? await options.reader.loadChunk(archive, wanted)
      : (await loadAuditArchiveRows(env, archive.id, archive.key, archive.checksum, archive.target, { wanted })).rows
    for (const index of archive.indexes) {
      const row = rows[index]
      const original = byId.get(Number(row.id))
      if (!original || original.run_id !== row.run_id || original.stage !== row.stage || original.symbol !== row.symbol) {
        fail(`row_identity_mismatch:${row.id}`)
      }
      const parsed = archivedRowEvidence(original)
      if ('invalid' in parsed) fail(`${parsed.invalid}:${row.id}`)
      visit(index, row, original.evidence, parsed.evidence)
    }
  }
  return archives.size
}

/**
 * Puts the verified R2 pre-image back into screener_funnel_items.evidence for rows the
 * retention job replaced with a d1-audit-json-pointer-v1; other rows pass through.
 * All-or-error, never a mix (see visitArchivedFunnelEvidence).
 */
export async function restoreArchivedFunnelEvidence<T extends ArchivedFunnelEvidenceRow>(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  rows: T[],
  options: FunnelArchiveReadOptions = {},
): Promise<T[]> {
  const restored = rows.slice()
  const archives = await visitArchivedFunnelEvidence(env, rows, (index, row, evidenceText) => {
    restored[index] = { ...row, evidence: evidenceText }
  }, options)
  return archives ? restored : rows
}
