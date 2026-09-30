import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { writeEvidenceArtifact, retainArtifactHardReference } from './artifactLifecycle'
import { sha256Text } from './datasetSnapshots'

export const ALLOCATOR_FORECAST_DOMAIN = 'allocator_ev_feature_forecast'
export const ALLOCATOR_FORECAST_ARCHIVE_SCHEMA = 'allocator-forecast-archive-v1'
export const ALLOCATOR_FORECAST_POINTER_SCHEMA = 'allocator-forecast-pointer-v1'
export const ALLOCATOR_FORECAST_MAX_BYTES = 1024 * 1024
export const ALLOCATOR_FORECAST_MAX_ROWS = 16
export const ALLOCATOR_FORECAST_RECONCILE_CURSOR = 'allocator:forecast-reference-reconcile:v1'
export const ALLOCATOR_FORECAST_ACTIVATION_KEY = 'allocator:forecast-writer-activation:v1'
export const ALLOCATOR_FORECAST_READER_CONTRACT = 'allocator-forecast-reader-v1'
const SOURCE = 'allocator_ev_asof_backfill_v2'
const GUARD = 'prediction_before_next_executable_session_open;exact_active8_artifact_lineage;l4_trained_before_snapshot;s12_samples_before_run'
const OWNER = 'allocator_ev_forecast_run'
const REFERENCE_INDEX = 'idx_allocator_forecast_active_refs_v1'
type Env = Pick<Bindings, 'DB' | 'ARTIFACTS'> & Partial<Bindings>
type ForecastRow = { snapshot_date: string; stock_id: number; snapshot_source: string; as_of_guard: string; forecast_data: string }
const bytes = (value: string) => new TextEncoder().encode(value).length
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
function fail(reason: string): never { throw new Error(`allocator_forecast_${reason}`) }
function runId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 140) fail('run_identity_invalid')
  return value
}
function rows(value: unknown): ForecastRow[] {
  if (!Array.isArray(value) || !value.length || value.length > ALLOCATOR_FORECAST_MAX_ROWS) fail('row_limit')
  const seen = new Set<string>()
  for (const row of value) {
    if (!object(row) || Object.keys(row).sort().join(',') !== 'as_of_guard,forecast_data,snapshot_date,snapshot_source,stock_id'
      || typeof row.snapshot_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.snapshot_date)
      || !Number.isSafeInteger(row.stock_id) || row.stock_id <= 0 || row.snapshot_source !== SOURCE
      || row.as_of_guard !== GUARD || typeof row.forecast_data !== 'string') fail('row_identity_invalid')
    let forecast: unknown
    try { forecast = JSON.parse(row.forecast_data) } catch { fail('json_invalid') }
    if (!object(forecast) || forecast.schema_version === ALLOCATOR_FORECAST_POINTER_SCHEMA) fail('inline_original_required')
    const key = JSON.stringify([row.snapshot_date, row.stock_id, row.snapshot_source])
    if (seen.has(key)) fail('duplicate_row')
    seen.add(key)
  }
  if (new Set(value.map(row => row.snapshot_date)).size !== 1) fail('mixed_dates')
  if (bytes(JSON.stringify(value)) > ALLOCATOR_FORECAST_MAX_BYTES - 2048) fail('byte_limit')
  return value as ForecastRow[]
}

/** Exact values used by S12's hot SQL fallback; all other fields hydrate first. */
function hotProjection(raw: string): Record<string, unknown> {
  const source = JSON.parse(raw)
  const projection: Record<string, unknown> = {}
  for (const [parent, children] of [
    ['ensemble_v2', ['model_set_signature', 'target_semantic_version']],
    ['model_score_lineage', ['target_semantic_version']],
  ] as const) {
    if (!object(source[parent])) continue
    const selected = Object.fromEntries(children.filter(key => Object.hasOwn(source[parent], key)).map(key => [key, source[parent][key]]))
    if (Object.keys(selected).length) projection[parent] = selected
  }
  return projection
}

async function assertWritingRun(env: Env, id: string, day: string) {
  const run = await databaseForDataDomain(env, 'learning').prepare(`SELECT status,snapshot_date,snapshot_source,as_of_guard
    FROM allocator_ev_snapshot_runs WHERE run_id=?`).bind(id).first<any>()
  if (!run || run.status !== 'writing' || run.snapshot_date !== day || run.snapshot_source !== SOURCE || run.as_of_guard !== GUARD) fail('run_not_writing')
}

/** A deployment operator installs this evidence only after reader rollout and
 * explicit approval. This module never creates/approves an activation receipt.
 * KV revocation is eventually consistent: disabling new writes never makes an
 * old reader safe again while any stored forecast pointer still exists.
 */
export async function allocatorForecastWriterGate(env: Env) {
  const off = (reason: string) => ({ writer_enabled: false, activation_id: null, reason })
  const raw = await env.KV?.get(ALLOCATOR_FORECAST_ACTIVATION_KEY)
  if (!raw) return off('activation_missing')
  // Bounded evidence, with room for the existing ~100 tagged revisions.
  if (bytes(raw) > 512 * 1024) return off('activation_byte_limit')
  let value: any
  try { value = JSON.parse(raw) } catch { return off('activation_invalid_json') }
  if (!object(value) || value.schema_version !== 'allocator-forecast-writer-activation-v1') return off('activation_schema_invalid')
  if (value.enabled === false) return off('activation_disabled')
  if (value.enabled !== true) return off('activation_invalid')
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 2048
  const hash = (v: unknown) => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v)
  const now = Date.now()
  const timestamp = (v: unknown) => typeof v === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(v)
    && Number.isFinite(Date.parse(v)) && Date.parse(v) <= now
  const evidence = (v: any) => object(v) && text(v.uri) && hash(v.sha256) && timestamp(v.observed_at)
  if (!text(value.activation_id) || !/^[a-zA-Z0-9:_-]{1,140}$/.test(value.activation_id)
    || value.reader_contract !== ALLOCATOR_FORECAST_READER_CONTRACT
    || !object(value.approval) || !text(value.approval.reference) || !timestamp(value.approval.approved_at)) return off('activation_approval_missing')
  if (!env.CF_VERSION_METADATA?.id || value.worker_version_id !== env.CF_VERSION_METADATA.id) return off('activation_worker_version_mismatch')
  if (!env.ML_CONTROLLER_URL || value.controller_url !== env.ML_CONTROLLER_URL.trim().replace(/\/$/, '')) return off('activation_controller_mismatch')
  const inventory = value.deployment_inventory, controller = value.controller
  if (!evidence(inventory) || inventory.complete !== true || !Number.isSafeInteger(inventory.resource_count)
    || inventory.resource_count < 1 || !hash(inventory.job_entrypoint_audit_sha256)
    || !object(controller) || !/^projects\/[^/]+\/locations\/[^/]+\/services\/ml-controller$/.test(controller.resource)
    || !Array.isArray(controller.revisions) || !controller.revisions.length || controller.revisions.length > 2048
    || controller.inventory_count !== controller.revisions.length
    || !Array.isArray(controller.full_reader_routes)
    || [...controller.full_reader_routes].sort().join(',') !== '/allocator_ev_fusion/refresh,/opb_arm_prior/refresh') return off('activation_inventory_incomplete')
  const seen = new Set<string>()
  let reachable = 0
  for (const revision of controller.revisions) {
    if (!object(revision) || typeof revision.revision !== 'string' || !/^ml-controller-[a-zA-Z0-9-]+$/.test(revision.revision)
      || seen.has(revision.revision)) return off('activation_revision_invalid')
    seen.add(revision.revision)
    if (revision.reachable === true) {
      reachable++
      if (!hash(revision.image_digest) || typeof revision.source_commit !== 'string'
        || !/^[0-9a-f]{40}$/.test(revision.source_commit)) return off('activation_revision_invalid')
      if (revision.reader_contract !== ALLOCATOR_FORECAST_READER_CONTRACT) return off('activation_old_reader_reachable')
    } else if (revision.reachable === false) {
      const drain = revision.quiescence
      if (!evidence(drain) || drain.method !== 'revision_unreachable_and_drained'
        || drain.inflight_requests !== 0 || drain.background_work !== 0) return off('activation_old_reader_not_drained')
      if (Date.parse(value.approval.approved_at) < Date.parse(drain.observed_at)) return off('activation_approval_predates_evidence')
    } else return off('activation_reachability_unknown')
  }
  if (!reachable) return off('activation_reader_inventory_empty')
  if (Date.parse(value.approval.approved_at) < Date.parse(inventory.observed_at)) return off('activation_approval_predates_evidence')
  await allocatorForecastArchivePreflight(env)
  return { writer_enabled: true, activation_id: String(value.activation_id), reason: 'approved_reader_rollout' }
}

/** Deployment gate; a namesake nonpartial index must not silently pass. */
export async function allocatorForecastArchivePreflight(env: Env) {
  const index = await databaseForDataDomain(env, 'ops').prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name=?").bind(REFERENCE_INDEX).first<{ sql: string }>()
  const normalized = String(index?.sql ?? '').replace(/\s/g, '').toLowerCase()
  if (!normalized.includes('onartifact_hard_references(owner_id,artifact_id)')
    || !normalized.endsWith("whereowner_type='allocator_ev_forecast_run'andactive=1")) fail('active_reference_index_not_ready')
  return { ready: true, index: REFERENCE_INDEX }
}

/** No canonical source writes: the producer stages only after this returns. */
export async function writeAllocatorForecastArchive(env: Env, input: unknown) {
  if (!object(input) || Object.keys(input).sort().join(',') !== 'rows,run_id') fail('request_invalid')
  const id = runId(input.run_id), originals = rows(input.rows), day = originals[0].snapshot_date
  const gate = await allocatorForecastWriterGate(env)
  if (!gate.writer_enabled) return { ...gate, manifest: null, rows: originals }
  await assertWritingRun(env, id, day)
  const manifest = await writeEvidenceArtifact(env, {
    domain: ALLOCATOR_FORECAST_DOMAIN, businessDate: day, producerRunId: id,
    retentionClass: 'ten_year_cold_archive', schemaVersion: ALLOCATOR_FORECAST_ARCHIVE_SCHEMA,
    payload: { run_id: id, source_table: 'allocator_ev_feature_snapshots', rows: originals },
    rowCount: originals.length,
    metadata: { source_table: 'allocator_ev_feature_snapshots', blob_column: 'forecast_data', minimum_cold_days: 3650 },
  })
  // A writing run protects the reference until stage/publish or explicit failure.
  // Do not reactivate a reference that a terminal run's reconciler released.
  const ops = databaseForDataDomain(env, 'ops')
  const released = await ops.prepare(`SELECT 1 released FROM artifact_hard_references
    WHERE owner_type=? AND owner_id=? AND artifact_id=? AND active=0 LIMIT 1`).bind(OWNER, id, manifest.artifact_id).first()
  if (released) fail('terminal_reference_reactivation_forbidden')
  await assertWritingRun(env, id, day)
  await retainArtifactHardReference(ops, { artifactId: manifest.artifact_id, ownerType: OWNER, ownerId: id })
  const replacements = []
  for (const row of originals) {
    const forecastChecksum = await sha256Text(row.forecast_data)
    const pointer = JSON.stringify({
      ...hotProjection(row.forecast_data), schema_version: ALLOCATOR_FORECAST_POINTER_SCHEMA,
      artifact_id: manifest.artifact_id, checksum: manifest.checksum,
      snapshot_date: row.snapshot_date, stock_id: row.stock_id, snapshot_source: row.snapshot_source,
      as_of_guard: row.as_of_guard, forecast_checksum: forecastChecksum,
      original_bytes: bytes(row.forecast_data),
    })
    replacements.push({ snapshot_date: row.snapshot_date, stock_id: row.stock_id,
      snapshot_source: row.snapshot_source, forecast_checksum: forecastChecksum,
      forecast_data: bytes(pointer) < bytes(row.forecast_data) ? pointer : row.forecast_data })
  }
  const result = { ...gate, manifest, rows: replacements }
  if (bytes(JSON.stringify({ ok: true, ...result })) > ALLOCATOR_FORECAST_MAX_BYTES) fail('response_byte_limit')
  return result
}

/** Returns the exact bounded body; Python verifies SHA and row identity again. */
export async function readAllocatorForecastArchive(env: Env, artifactId: unknown) {
  if (typeof artifactId !== 'string' || !artifactId.startsWith(`artifact:${ALLOCATOR_FORECAST_DOMAIN}:`) || artifactId.length > 250) fail('artifact_identity_invalid')
  const manifest = await databaseForDataDomain(env, 'ops').prepare(`SELECT * FROM run_artifacts
    WHERE artifact_id=? AND domain=? AND schema_version=? AND retention_class='ten_year_cold_archive'
      AND status='ready' AND checksum_verified_at IS NOT NULL AND payload_deleted_at IS NULL LIMIT 1`)
    .bind(artifactId, ALLOCATOR_FORECAST_DOMAIN, ALLOCATOR_FORECAST_ARCHIVE_SCHEMA).first<any>()
  if (!manifest) fail('manifest_missing')
  if (!Number.isSafeInteger(manifest.byte_size) || manifest.byte_size < 1 || manifest.byte_size > ALLOCATOR_FORECAST_MAX_BYTES) fail('byte_limit')
  const stored = await env.ARTIFACTS?.get(manifest.r2_key)
  if (!stored) fail('object_missing')
  if (stored.size !== manifest.byte_size) fail('size_mismatch')
  const body = await stored.text()
  if (bytes(body) !== manifest.byte_size || await sha256Text(body) !== manifest.checksum) fail('checksum_mismatch')
  let archive: any
  try { archive = JSON.parse(body) } catch { fail('archive_json_invalid') }
  if (!object(archive) || archive.domain !== ALLOCATOR_FORECAST_DOMAIN || archive.schema_version !== ALLOCATOR_FORECAST_ARCHIVE_SCHEMA
    || !object(archive.payload) || archive.payload.source_table !== 'allocator_ev_feature_snapshots') fail('archive_identity_mismatch')
  const originals = rows(archive.payload.rows)
  if (originals.length !== manifest.row_count || originals[0].snapshot_date !== manifest.business_date
    || archive.business_date !== manifest.business_date || archive.payload.run_id !== manifest.producer_run_id) fail('manifest_identity_mismatch')
  return { manifest, body, rows: originals, run_id: runId(archive.payload.run_id) }
}

/** Explicit bounded reconciliation; never alters source rows or R2 objects. */
export async function reconcileAllocatorForecastReferences(env: Env, input: unknown, budget = 16) {
  if (!object(input) || !['run_id', 'after_artifact_id,run_id'].includes(Object.keys(input).sort().join(','))) fail('request_invalid')
  const id = runId(input.run_id)
  const after = input.after_artifact_id ?? ''
  if (typeof after !== 'string' || after.length > 250) fail('cursor_invalid')
  const learning = databaseForDataDomain(env, 'learning'), ops = databaseForDataDomain(env, 'ops')
  if (!Number.isInteger(budget) || budget < 1 || budget > 16) fail('reconcile_budget_invalid')
  const run = await learning.prepare('SELECT status FROM allocator_ev_snapshot_runs WHERE run_id=?').bind(id).first<any>()
  if (!run || !['ready', 'failed'].includes(run.status)) return { checked: 0, released: 0, protected: 0, has_more: false, reason: 'run_not_terminal' }
  const references = (await ops.prepare(`SELECT artifact_id FROM artifact_hard_references INDEXED BY ${REFERENCE_INDEX}
    WHERE owner_type='allocator_ev_forecast_run' AND owner_id=? AND active=1 AND artifact_id>? ORDER BY artifact_id LIMIT ?`)
    .bind(id, after, budget).all<{ artifact_id: string }>()).results ?? []
  const releasable: string[] = []
  for (const { artifact_id: artifactId } of references) {
    const artifact = await readAllocatorForecastArchive(env, artifactId)
    if (artifact.run_id !== id) fail('reference_owner_mismatch')
    const referenced = await learning.prepare(`WITH keys AS (SELECT value FROM json_each(?))
      SELECT 1 live FROM keys k WHERE EXISTS (
        SELECT 1 FROM allocator_ev_feature_snapshots f
         WHERE f.snapshot_date=json_extract(k.value,'$.snapshot_date') AND f.stock_id=json_extract(k.value,'$.stock_id')
           AND f.snapshot_source=json_extract(k.value,'$.snapshot_source')
           AND CASE WHEN json_valid(f.forecast_data) THEN json_extract(f.forecast_data,'$.artifact_id') END=?
      ) OR EXISTS (
        SELECT 1 FROM allocator_ev_feature_snapshot_staging s WHERE s.run_id=? AND s.stock_id=json_extract(k.value,'$.stock_id')
          AND CASE WHEN json_valid(s.forecast_data) THEN json_extract(s.forecast_data,'$.artifact_id') END=?
      ) LIMIT 1`).bind(JSON.stringify(artifact.rows.map(({ snapshot_date, stock_id, snapshot_source }) => ({ snapshot_date, stock_id, snapshot_source }))), artifactId, id, artifactId).first()
    if (!referenced) releasable.push(String(artifactId))
  }
  // Release just the explicitly checked artifact edges, not the whole run.
  let released = 0
  for (const artifactId of releasable) {
    const result = await ops.batch([
      ops.prepare(`UPDATE artifact_hard_references SET active=0,released_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
        WHERE owner_type=? AND owner_id=? AND artifact_id=? AND active=1`).bind(OWNER, id, artifactId),
      ops.prepare(`UPDATE run_artifacts SET hard_ref_count=(SELECT COUNT(*) FROM artifact_hard_references r
        WHERE r.artifact_id=run_artifacts.artifact_id AND r.active=1),updated_at=CURRENT_TIMESTAMP WHERE artifact_id=?`).bind(artifactId),
    ])
    released += Number(result[0]?.meta?.changes ?? 0)
  }
  return { checked: references.length, released, protected: references.length - releasable.length,
    has_more: references.length === budget, after_artifact_id: references.at(-1)?.artifact_id ?? after }
}

/** Existing daily artifact owner: bounded durable round-robin, no source writes.
 * KV can replay an older cursor under concurrency; all pages are idempotent.
 * A failed page never advances. Writing/unknown runs are revisited next cycle.
 */
export async function reconcileAllocatorForecastReferenceTick(env: Env) {
  if (!env.KV) fail('reconcile_cursor_binding_missing')
  const raw = await env.KV.get(ALLOCATOR_FORECAST_RECONCILE_CURSOR)
  let cursor = { schema_version: 1, after_run_id: '', active_run_id: '', after_artifact_id: '' }
  if (raw != null) {
    let value: any
    try { value = JSON.parse(raw) } catch { fail('reconcile_cursor_invalid') }
    if (!object(value) || value.schema_version !== 1
      || Object.keys(cursor).some(key => key !== 'schema_version' && (typeof value[key] !== 'string' || value[key].length > 250))) fail('reconcile_cursor_invalid')
    cursor = { schema_version: 1, after_run_id: value.after_run_id,
      active_run_id: value.active_run_id, after_artifact_id: value.after_artifact_id }
  }
  const result = { runs: 0, checked: 0, released: 0, protected: 0, skipped: 0, cycle_complete: false }
  const ops = databaseForDataDomain(env, 'ops')
  while (result.runs < 16 && result.checked < 16) {
    const next = cursor.active_run_id ? { run_id: cursor.active_run_id }
      : await ops.prepare(`SELECT owner_id AS run_id FROM artifact_hard_references INDEXED BY ${REFERENCE_INDEX}
          WHERE owner_type='allocator_ev_forecast_run' AND active=1 AND owner_id>? ORDER BY owner_id LIMIT 1`)
        .bind(cursor.after_run_id).first<{ run_id: string }>()
    if (!next) {
      cursor = { schema_version: 1, after_run_id: '', active_run_id: '', after_artifact_id: '' }
      await env.KV.put(ALLOCATOR_FORECAST_RECONCILE_CURSOR, JSON.stringify(cursor))
      result.cycle_complete = true
      break
    }
    const page = await reconcileAllocatorForecastReferences(env,
      { run_id: next.run_id, after_artifact_id: cursor.active_run_id ? cursor.after_artifact_id : '' }, 16 - result.checked)
    result.runs++; result.checked += page.checked; result.released += page.released; result.protected += page.protected
    if (page.reason) result.skipped++
    cursor = page.has_more
      ? { ...cursor, active_run_id: next.run_id, after_artifact_id: page.after_artifact_id! }
      : { schema_version: 1, after_run_id: next.run_id, active_run_id: '', after_artifact_id: '' }
    // Only a fully verified page is acknowledged. Lost put ACK repeats safe work.
    await env.KV.put(ALLOCATOR_FORECAST_RECONCILE_CURSOR, JSON.stringify(cursor))
  }
  return { ...result, cursor }
}
