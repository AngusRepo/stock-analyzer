import { archivedS12ReplayChunks, type ReplayArchiveEnv, type ReplayRow } from './retentionS12ReplayReader'
import { sha256Text } from './datasetSnapshots'
import { S12_REPLAY_COLD_INTEGRITY_SQL } from './s12ReplayRewardHistory'
import { CANONICAL_SELECTION_ROUNDTRIP_COST_BPS } from './canonicalSelectionLabels'
import { paperExecutionDate } from './paperExecutionScope'

export interface ReplayReadCheckpoint {
  version:'s12-replay-read-checkpoint-v1'
  startDate:string
  endDate:string
  snapshotAt:string
  upperRowid:number
  inventoryBatches:number
  inventoryRows:number
  afterRowid:number
  manifestsRead:number
  bytesRead:number
  sourceRowsRead:number
  checksum:string
}
export interface ReplayReadPage {
  rows:ReplayRow[]
  checkpoint:ReplayReadCheckpoint
  complete:boolean
  page:{manifests:number;bytes:number;sourceRows:number}
}
type Inventory = {max_id:number;batches:number;rows:number}
const FIELDS = ['version','startDate','endDate','snapshotAt','upperRowid','inventoryBatches','inventoryRows',
  'afterRowid','manifestsRead','bytesRead','sourceRowsRead'] as const
async function checkpointHash(value:Omit<ReplayReadCheckpoint,'checksum'>):Promise<string> {
  return sha256Text(JSON.stringify(FIELDS.map(k=>value[k])))
}
/** Seal an inventory captured in the same Learning transaction as hot/lifecycle inputs. */
export async function sealReplayReadCheckpoint(value:Omit<ReplayReadCheckpoint,'checksum'>):Promise<ReplayReadCheckpoint> {
  return {...value,checksum:await checkpointHash(value)}
}
async function inventory(db:D1Database,upper:number|null):Promise<Inventory> {
  return (await db.prepare(`SELECT COALESCE(MAX(rowid),0) max_id,COUNT(*) batches,COALESCE(SUM(row_count),0) rows
    FROM s12_replay_cold_batches_v1 ${upper===null?'':'WHERE rowid<=?'}`).bind(...(upper===null?[]:[upper])).first<Inventory>())!
}
async function assertHistoryComplete(db:D1Database):Promise<void> {
  const bad = await db.prepare(`SELECT 1 invalid FROM (${S12_REPLAY_COLD_INTEGRITY_SQL}) LIMIT 1`)
    .bind(CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,CANONICAL_SELECTION_ROUNDTRIP_COST_BPS).first()
  if (bad) throw new Error('retention_replay_page_legacy_or_incomplete_history')
}

/** A JSON checkpoint is restartable and checksum-checked, not an authorization token.
 * Only immutable, atomically released batches are supported. Legacy raw-only archives need verified derived backfill.
 * Returns a bounded PAGE, never a completed calibration population. Persist the checkpoint only after consuming the page.
 */
export async function readReleasedReplayPage(env:ReplayArchiveEnv,db:D1Database,
  input:{startDate:string;endDate:string;checkpoint?:ReplayReadCheckpoint;snapshotAt?:string;
    maxManifests?:number;maxBytes?:number;maxSourceRows?:number}):Promise<ReplayReadPage> {
  const {startDate,endDate}=input
  if (![startDate,endDate].every(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)) || startDate>endDate)
    throw new Error('retention_replay_page_window_invalid')
  const maxManifests=input.maxManifests ?? 8,maxBytes=input.maxBytes ?? 8*1024*1024,maxRows=input.maxSourceRows ?? 2000
  if (!Number.isSafeInteger(maxManifests)||maxManifests<1||maxManifests>32
    ||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>32*1024*1024
    ||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>5000) throw new Error('retention_replay_page_budget_invalid')
  let checkpoint=input.checkpoint
  if (checkpoint) {
    if (checkpoint.version!=='s12-replay-read-checkpoint-v1' || checkpoint.startDate!==startDate || checkpoint.endDate!==endDate
      || (input.snapshotAt!==undefined && checkpoint.snapshotAt!==new Date(input.snapshotAt).toISOString())
      || !Number.isFinite(Date.parse(checkpoint.snapshotAt))
      || ![checkpoint.upperRowid,checkpoint.afterRowid,checkpoint.inventoryBatches,checkpoint.inventoryRows,
        checkpoint.manifestsRead,checkpoint.bytesRead,checkpoint.sourceRowsRead].every(n=>Number.isSafeInteger(n)&&n>=0)
      || checkpoint.afterRowid>checkpoint.upperRowid || checkpoint.checksum!==await checkpointHash(checkpoint))
      throw new Error('retention_replay_checkpoint_invalid')
  }
  if (!checkpoint) {
    await assertHistoryComplete(db)
    const frozen=await inventory(db,null)
    const initial:Omit<ReplayReadCheckpoint,'checksum'>={version:'s12-replay-read-checkpoint-v1',startDate,endDate,
      snapshotAt:new Date(input.snapshotAt ?? paperExecutionDate().toISOString()).toISOString(),upperRowid:Number(frozen.max_id),
      inventoryBatches:Number(frozen.batches),inventoryRows:Number(frozen.rows),afterRowid:0,manifestsRead:0,bytesRead:0,sourceRowsRead:0}
    checkpoint={...initial,checksum:await checkpointHash(initial)}
  }
  const batches=(await db.prepare(`SELECT b.rowid release_rowid,b.artifact_id,b.source_checksum,b.row_count,b.projection_bytes
    FROM s12_replay_cold_batches_v1 b WHERE b.rowid>? AND b.rowid<=?
      AND EXISTS(SELECT 1 FROM s12_replay_cold_identities_v1 i WHERE i.artifact_id=b.artifact_id AND i.trade_date>=? AND i.trade_date<=?)
    ORDER BY b.rowid LIMIT ?`).bind(checkpoint.afterRowid,checkpoint.upperRowid,startDate,endDate,maxManifests+1)
    .all<ReplayRow>()).results ?? []
  const rows:ReplayRow[]=[],admitted:ReplayRow[]=[],page={manifests:0,bytes:0,sourceRows:0}
  let afterRowid=checkpoint.afterRowid
  for (const batch of batches) {
    if (!Number.isSafeInteger(batch.projection_bytes)||batch.projection_bytes<=0
      ||!Number.isSafeInteger(batch.row_count)||batch.row_count<1||batch.row_count>250)
      throw new Error('retention_replay_page_batch_invalid')
    if (page.manifests>=maxManifests || page.bytes+batch.projection_bytes>maxBytes || page.sourceRows+batch.row_count>maxRows) {
      if (!page.manifests) throw new Error('retention_replay_page_single_batch_exceeds_budget')
      break
    }
    admitted.push(batch)
    page.manifests++;page.bytes+=batch.projection_bytes;page.sourceRows+=batch.row_count;afterRowid=Number(batch.release_rowid)
  }
  const complete=page.manifests===batches.length
  // Immutable release rows are checked individually below. Full inventory guards belong at the session boundaries,
  // not every page: otherwise N batches across P pages cause N*P catalog scans. Partial pages cannot publish calibration.
  if (complete && input.checkpoint) {
    await assertHistoryComplete(db)
    const frozen=await inventory(db,checkpoint.upperRowid)
    if (Number(frozen.max_id)!==checkpoint.upperRowid || Number(frozen.batches)!==checkpoint.inventoryBatches
      || Number(frozen.rows)!==checkpoint.inventoryRows) throw new Error('retention_replay_frozen_inventory_changed')
  }
  for (const batch of admitted) {
    for await (const chunk of archivedS12ReplayChunks(env,db,startDate,endDate,checkpoint.snapshotAt,
      {artifactId:batch.artifact_id,checksum:batch.source_checksum,rowCount:batch.row_count})) rows.push(...chunk)
  }
  const next:Omit<ReplayReadCheckpoint,'checksum'>={...checkpoint,afterRowid:complete?checkpoint.upperRowid:afterRowid,
    manifestsRead:checkpoint.manifestsRead+page.manifests,bytesRead:checkpoint.bytesRead+page.bytes,
    sourceRowsRead:checkpoint.sourceRowsRead+page.sourceRows}
  return {rows,complete,page,checkpoint:{...next,checksum:await checkpointHash(next)}}
}
