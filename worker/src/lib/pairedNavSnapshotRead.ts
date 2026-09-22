/** Checksum-verified bounded NAV view; full payload remains in held cold storage. */
type Row = Record<string, any>
const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))
  .map(v => v.toString(16).padStart(2, '0')).join('')
const LIMIT = 2 * 1024 * 1024
export async function readPairedNavSnapshotRaw(db: D1Database, manifest: Row, allowProjection = false): Promise<string> {
  // Rollout compatibility: distinguish missing migration from failed queries.
  const exists = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .bind('paired_nav_cold_objects_v1').first<Row>()
  const cold = exists ? await db.prepare('SELECT * FROM paired_nav_cold_objects_v1 WHERE snapshot_id=?')
    .bind(manifest.snapshot_id).first<Row>() : null
  const count = cold ? cold.view_part_count : manifest.part_count
  const checksum = cold ? cold.view_checksum : manifest.payload_checksum
  if (cold && (cold.payload_checksum !== manifest.payload_checksum
    || cold.view_kind !== 'full' && !(allowProjection && (manifest.snapshot_kind === 'allocation_context' && cold.view_kind === 'opb_context_v1'
      || manifest.snapshot_kind === 'allocation_pair' && cold.view_kind === 'allocation_proof_v1'))
    || cold.view_kind === 'full' && cold.view_checksum !== manifest.payload_checksum)) throw Error('paired_nav_cold_view_identity_invalid')
  if (!Number.isInteger(count) || count < 1 || count > 105) throw Error('paired_nav_view_exceeds_worker_bound')
  const table = cold ? 'paired_nav_cold_views_v1' : 'paired_nav_frozen_parts_v1'
  const response = await db.prepare(`SELECT part_no,payload_text FROM ${table} WHERE snapshot_id=? ORDER BY part_no LIMIT 106`)
    .bind(manifest.snapshot_id).all<Row>()
  const parts = response.results
  if (response.success === false || !Array.isArray(parts) || parts.length !== count
    || parts.some((part, i) => part.part_no !== i || typeof part.payload_text !== 'string')) throw Error('paired_nav_view_parts_missing')
  const raw = parts.map(part => part.payload_text).join('')
  if (new TextEncoder().encode(raw).length > LIMIT) throw Error('paired_nav_view_exceeds_worker_bound')
  if (await hash(raw) !== checksum) throw Error('paired_nav_view_checksum_mismatch')
  return raw
}
