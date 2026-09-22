import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readPairedNavSnapshotRaw } from './pairedNavSnapshotRead'
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
function db(cold: any, raw: string, overrides: any[] | null = null): D1Database {
  return { prepare(sql: string) { return { bind() { return this },
    async first() { return sql.includes('sqlite_master') ? (cold ? { name: 'paired_nav_cold_objects_v1' } : null) : cold },
    async all() { return { success: true, results: overrides ?? [{ part_no: 0, payload_text: raw }] } }
  } } } as unknown as D1Database
}
async function main() {
  const raw = '{"content":{"price":5.0},"snapshot_kind":"execution_receipt"}'
  const manifest = { snapshot_id: 's', part_count: 1, payload_checksum: hash(raw), snapshot_kind: 'execution_receipt' }
  assert.equal(await readPairedNavSnapshotRaw(db(null, raw), manifest), raw)
  const full = { payload_checksum: hash(raw), view_kind: 'full', view_checksum: hash(raw), view_part_count: 1 }
  assert.equal(await readPairedNavSnapshotRaw(db(full, raw), manifest), raw)
  await assert.rejects(() => readPairedNavSnapshotRaw(db(full, raw + ' '), manifest), /checksum/)
  await assert.rejects(() => readPairedNavSnapshotRaw(db({ ...full, payload_checksum: 'wrong' }, raw), manifest), /identity/)
  await assert.rejects(() => readPairedNavSnapshotRaw(db(full, raw, []), manifest), /parts/)
  await assert.rejects(() => readPairedNavSnapshotRaw(db(null, raw), { ...manifest, part_count: 35000 }), /bound/)
  const projection = { ...full, payload_checksum: 'full-payload-root', view_kind: 'opb_context_v1' }
  const context = { ...manifest, snapshot_kind: 'allocation_context', payload_checksum: 'full-payload-root', part_count: 35000 }
  assert.equal(await readPairedNavSnapshotRaw(db(projection, raw), context, true), raw)
  await assert.rejects(() => readPairedNavSnapshotRaw(db(projection, raw), context), /identity/)
  await assert.rejects(() => readPairedNavSnapshotRaw(db(projection, raw), { ...context, snapshot_kind: 'allocation_pair' }, true), /identity/)
  console.log('pairedNavSnapshotRead: legacy/full/projected checksums, bounds and kind isolation passed')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
