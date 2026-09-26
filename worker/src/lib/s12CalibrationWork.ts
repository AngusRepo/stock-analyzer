import { paperExecutionDate, paperExecutionUUID } from './paperExecutionScope'
import { readReleasedReplayPage, sealReplayReadCheckpoint, type ReplayReadCheckpoint } from './retentionS12ReplayPages'
import { projectS12ReplayChunk, type ReplayArchiveEnv } from './retentionS12ReplayReader'
import { S12_REPLAY_COLD_INTEGRITY_SQL } from './s12ReplayRewardHistory'
import { S12_REPLAY_ENGINE_SIGNATURE } from './s12ReplayContract'
import { CANONICAL_SELECTION_ROUNDTRIP_COST_BPS } from './canonicalSelectionLabels'
import { CALIBRATION_EVIDENCE_SCAN_LIMIT, CALIBRATION_LIFECYCLE_RECENT_MS, CALIBRATION_DETAIL_KEYS, calibrationEvidenceFromRow,
  runS12TwCalibrationFromEvidence, type CalibrationEvidence, type S12TwCalibrationCadence,
  type S12TwCalibrationLifecycleCensoring } from './s12TwEquityCalibration'

const WORK='s12_calibration_work_v1', ROWS='s12_calibration_work_rows_v1', LIFE='s12_calibration_work_lifecycle_v1'
const CENSOR='s12_calibration_work_censor_v1', CURRENT='s12_calibration_work_current_v1'
const MAX_BYTES=64*1024*1024, encoder=new TextEncoder()
const contract=(sourceVersion:string)=>JSON.stringify(['s12-calibration-work-v1',sourceVersion,
  S12_REPLAY_ENGINE_SIGNATURE,CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,CALIBRATION_EVIDENCE_SCAN_LIMIT])
export type CalibrationWork = {
  run_id:string;run_date:string;cadence:S12TwCalibrationCadence;start_date:string;snapshot_at:string;contract:string;
  phase:'reading'|'ready'|'committed'|'deferred'|'expired';revision:number;commit_token:string;checkpoint_json:string|null;
  cold_upper:number;cold_batches:number;cold_rows:number;retained_rows:number;retained_bytes:number;
}
// SQLite json_object rounds REAL values. Decimal strings with 26 significant digits round-trip
// their binary64 values; the existing evidence decoder converts them with Number().
const exactReal=(column:string)=>`CASE WHEN typeof(${column}) IN ('real','integer') THEN printf('%!.26g',${column}) ELSE ${column} END`
// Keep exactly the detail tokens used by the decoder, in original order, including empty/duplicate values.
// JSON quoting handles Unicode/escapes; splitting on semicolons matches detailValue's delimiter semantics.
const DETAIL=`COALESCE(json_extract(o.detail_json,'$.assessment_detail'),json_extract(o.detail_json,'$.assessmentDetail'),'')`
const COMPACT_DETAIL=`COALESCE((SELECT group_concat(value,';') FROM (
 SELECT value FROM json_each('[' || replace(json_quote(${DETAIL} || ''),';','","') || ']')
 WHERE instr(value,'=')>0 AND substr(value,1,instr(value,'=')-1) IN (${CALIBRATION_DETAIL_KEYS.map(k=>`'${k}'`).join(',')})
 ORDER BY CAST(key AS INTEGER))), '')`
const PROJECTION=`json_object('symbol',o.symbol,
 'trade_date',o.trade_date,'assessment_state',o.assessment_state,'market',COALESCE(NULLIF(TRIM(o.market),''),'UNKNOWN'),
 'entry_ms',o.entry_ms,'entry_price',${exactReal('o.entry_price')},'stop_price',${exactReal('o.stop_price')},'pnl_pct',${exactReal('o.pnl_pct')},
 'max_favorable_pct',${exactReal('o.max_favorable_pct')},'max_adverse_pct',${exactReal('o.max_adverse_pct')},
 'assessment_detail',${COMPACT_DETAIL},
 'detail_assessment_state',json_extract(o.detail_json,'$.assessment_state'),
 'market_segment',json_extract(o.detail_json,'$.market_segment'),'alpha_bucket',json_extract(o.detail_json,'$.alpha_bucket'))`
const ELIGIBLE=`o.trade_date>=? AND o.trade_date<=? AND o.sample_eligible=1 AND o.pnl_pct IS NOT NULL
 AND json_extract(o.detail_json,'$.replay_diagnostics.replay_engine_signature')=?
 AND json_extract(o.detail_json,'$.replay_diagnostics.replay_cohort_signature') IS NOT NULL`
const KIND=`CASE WHEN l.state='replay_complete' THEN 'complete' WHEN l.state='replay_pending_maturity' THEN 'pending'
 WHEN l.state='replay_enqueued' AND datetime(l.updated_at)>=datetime(?) THEN 'recent'
 WHEN l.state='replay_enqueued' AND datetime(l.updated_at)<datetime(?) THEN 'stale'
 WHEN l.state='replay_enqueued' THEN 'ignored' ELSE 'missing' END`
const terminal=`l.state IN ('replay_complete','replay_pending_maturity') AND datetime(l.updated_at)<=datetime(?)`
const windowParams=(w:CalibrationWork)=>[w.start_date,w.run_date,S12_REPLAY_ENGINE_SIGNATURE]
const canonicalId=(date:string,cadence:S12TwCalibrationCadence)=>`s12-tw-calibration-${cadence}-${date}`
const COMMIT_OWNERSHIP_SQL=`EXISTS(SELECT 1 FROM ${WORK} w WHERE w.run_id=? AND w.commit_token=?)`
async function readWork(db:D1Database,id:string) {
  const w=await db.prepare(`SELECT * FROM ${WORK} WHERE run_id=?`).bind(id).first<CalibrationWork>()
  if (!w) throw new Error('s12_calibration_work_missing')
  return w
}

/** Scratch only: one day without committed progress expires a crashed attempt, preserving its receipt.
 * This is independent of source-retention deletion gates; source evidence is never deleted here. */
async function expireIdleCalibrationWork(db:D1Database):Promise<void> {
  const now=paperExecutionDate().toISOString(),cutoff=new Date(Date.parse(now)-24*60*60_000).toISOString()
  const expired=`phase IN ('reading','ready') AND updated_at<?`
  if(!await db.prepare(`SELECT 1 found FROM ${WORK} WHERE ${expired} LIMIT 1`).bind(cutoff).first())return
  const token=paperExecutionUUID(),ids=`SELECT run_id FROM ${WORK} WHERE phase='expired' AND commit_token=?`
  await db.batch([
    db.prepare(`UPDATE ${WORK} SET phase='expired',commit_token=?,updated_at=? WHERE ${expired}`).bind(token,now,cutoff),
    ...[ROWS,LIFE,CENSOR].map(table=>db.prepare(`DELETE FROM ${table} WHERE run_id IN (${ids})`).bind(token)),
    db.prepare(`DELETE FROM ${CURRENT} WHERE work_id IN (${ids})`).bind(token),
    db.prepare(`UPDATE ${WORK} SET retained_rows=0,retained_bytes=0 WHERE phase='expired' AND commit_token=?`).bind(token),
  ])
}

/** One Learning transaction freezes mutable hot rows/lifecycle and the immutable cold inventory boundary. */
export async function captureS12CalibrationWork(db:D1Database,input:{runDate:string;cadence:S12TwCalibrationCadence;
  sourceVersion:string;snapshotAt?:string}):Promise<CalibrationWork> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.runDate) || !['weekly','monthly','regime_shift'].includes(input.cadence)
    || !input.sourceVersion.trim()) throw new Error('s12_calibration_work_input_invalid')
  await expireIdleCalibrationWork(db)
  const canonical=canonicalId(input.runDate,input.cadence),signature=contract(input.sourceVersion)
  const existing=await db.prepare(`SELECT w.* FROM ${CURRENT} c JOIN ${WORK} w ON w.run_id=c.work_id
    WHERE c.canonical_run_id=?`).bind(canonical).first<CalibrationWork>()
  if (existing) {
    if (existing.contract!==signature) throw new Error('s12_calibration_work_source_version_changed')
    return existing
  }
  const snapshotAt=new Date(input.snapshotAt ?? paperExecutionDate().toISOString()).toISOString()
  const start=new Date(input.runDate+'T00:00:00.000Z');start.setUTCDate(start.getUTCDate()-(input.cadence==='monthly'?180:90))
  const startDate=start.toISOString().slice(0,10),recent=new Date(Date.parse(snapshotAt)-CALIBRATION_LIFECYCLE_RECENT_MS).toISOString()
  const id=canonical+':'+paperExecutionUUID(),token=paperExecutionUUID(),guard=COMMIT_OWNERSHIP_SQL
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO ${CURRENT}(canonical_run_id,work_id) VALUES(?,?)`).bind(canonical,id),
    db.prepare(`INSERT INTO ${WORK}(run_id,run_date,cadence,start_date,snapshot_at,contract,phase,commit_token,
      cold_upper,cold_batches,cold_rows,capture_valid,updated_at)
      SELECT ?,?,?,?,?,?,'reading',?,COALESCE(MAX(rowid),0),COUNT(*),COALESCE(SUM(row_count),0),
       CASE WHEN NOT EXISTS(${S12_REPLAY_COLD_INTEGRITY_SQL}) AND (SELECT COUNT(*) FROM ${WORK} WHERE phase IN ('reading','ready'))<2
         THEN 1 ELSE 0 END,? FROM s12_replay_cold_batches_v1
      HAVING EXISTS(SELECT 1 FROM ${CURRENT} WHERE canonical_run_id=? AND work_id=?)`)
      .bind(id,input.runDate,input.cadence,startDate,snapshotAt,signature,token,
        CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,paperExecutionDate().toISOString(),canonical,id),
    db.prepare(`INSERT INTO ${LIFE}(run_id,business_date,state,updated_at)
      SELECT ?,business_date,state,updated_at FROM allocator_ev_daily_lifecycle WHERE ${guard}`).bind(id,id,token),
    db.prepare(`INSERT INTO ${ROWS}(run_id,id,row_json,payload_bytes)
      SELECT ?,id,row_json,length(CAST(row_json AS BLOB)) FROM (
       SELECT o.id,${PROJECTION} row_json FROM s12_replay_trade_outcomes o
       LEFT JOIN ${LIFE} l ON l.run_id=? AND l.business_date=o.signal_date
       WHERE ${ELIGIBLE} AND ${terminal} AND ${guard} ORDER BY o.id LIMIT ?)`)
      .bind(id,id,startDate,input.runDate,S12_REPLAY_ENGINE_SIGNATURE,snapshotAt,id,token,CALIBRATION_EVIDENCE_SCAN_LIMIT),
    db.prepare(`INSERT INTO ${CENSOR}(run_id,signal_key,kind,rows)
      SELECT ?,json_quote(o.signal_date),${KIND} AS kind,COUNT(*) FROM s12_replay_trade_outcomes o
      LEFT JOIN ${LIFE} l ON l.run_id=? AND l.business_date=o.signal_date
      WHERE ${ELIGIBLE} AND ${guard} GROUP BY o.signal_date,kind`)
      .bind(id,recent,recent,id,startDate,input.runDate,S12_REPLAY_ENGINE_SIGNATURE,id,token),
    db.prepare(`UPDATE ${WORK} SET retained_rows=(SELECT COUNT(*) FROM ${ROWS} WHERE run_id=?),
      retained_bytes=COALESCE((SELECT SUM(payload_bytes) FROM ${ROWS} WHERE run_id=?),0),
      scratch_valid=CASE WHEN (SELECT COUNT(*) FROM ${LIFE} WHERE run_id=?)<=5000
        AND (SELECT COUNT(*) FROM ${CENSOR} WHERE run_id=?)<=10000 THEN 1 ELSE 0 END
      WHERE run_id=? AND commit_token=?`).bind(id,id,id,id,id,token),
  ])
  const pointer=await db.prepare(`SELECT work_id FROM ${CURRENT} WHERE canonical_run_id=?`).bind(canonical).first<{work_id:string}>()
  if (!pointer) throw new Error('s12_calibration_capture_pointer_missing')
  const result=await readWork(db,pointer.work_id)
  if (result.contract!==signature) throw new Error('s12_calibration_work_source_version_changed')
  return result
}

function jsonPages(rows:unknown[]):string[] {
  const pages:string[]=[],batch:unknown[]=[];let bytes=2
  for (const row of rows) {
    const size=encoder.encode(JSON.stringify(row)).length+1
    if(size>48*1024) throw new Error('s12_calibration_commit_row_too_large')
    if(batch.length&&bytes+size>48*1024){pages.push(JSON.stringify(batch));batch.length=0;bytes=2}
    batch.push(row);bytes+=size
  }
  if(batch.length)pages.push(JSON.stringify(batch))
  return pages
}
export async function readCalibrationWorkCensoring(db:D1Database,id:string):Promise<S12TwCalibrationLifecycleCensoring> {
  const rows=(await db.prepare(`SELECT signal_key,kind,rows FROM ${CENSOR} WHERE run_id=?`).bind(id).all<
    {signal_key:string;kind:string;rows:number}>()).results??[]
  const count=(kind:string)=>rows.filter(r=>r.kind===kind).reduce((n,r)=>n+r.rows,0)
  const dates=(kind:string)=>rows.filter(r=>r.kind===kind&&r.rows>0).map(r=>JSON.parse(r.signal_key)).filter(d=>d!=null)
  return {completeRows:count('complete'),completeDates:new Set(dates('complete')).size,
    pendingMaturityTerminalRows:count('pending'),pendingMaturityTerminalDates:new Set(dates('pending')).size,
    recentEnqueuedRows:count('recent'),recentEnqueuedDates:[...new Set(dates('recent').filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)))].sort(),
    staleEnqueuedRows:count('stale'),staleEnqueuedDates:[...new Set(dates('stale').filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)))].sort(),
    missingOrOtherRows:count('missing'),missingOrOtherDates:new Set(dates('missing')).size}
}

/** CAS ownership guards EVERY statement. Lost responses and stale workers cannot add a page twice. */
export async function appendS12CalibrationPage(env:ReplayArchiveEnv,db:D1Database,w:CalibrationWork,
  options: {maxManifests?:number;maxBytes?:number;maxSourceRows?:number;beforeCommit?:()=>Promise<void>}={}):Promise<CalibrationWork> {
  if(w.phase!=='reading') return w
  const initial=await sealReplayReadCheckpoint({version:'s12-replay-read-checkpoint-v1',startDate:w.start_date,endDate:w.run_date,
    snapshotAt:w.snapshot_at,upperRowid:w.cold_upper,inventoryBatches:w.cold_batches,inventoryRows:w.cold_rows,
    afterRowid:0,manifestsRead:0,bytesRead:0,sourceRowsRead:0})
  const page=await readReleasedReplayPage(env,db,{startDate:w.start_date,endDate:w.run_date,snapshotAt:w.snapshot_at,
    checkpoint:w.checkpoint_json?JSON.parse(w.checkpoint_json) as ReplayReadCheckpoint:initial,
    maxManifests:options.maxManifests??4,maxBytes:options.maxBytes??4*1024*1024,maxSourceRows:options.maxSourceRows??1000})
  const recent=new Date(Date.parse(w.snapshot_at)-CALIBRATION_LIFECYCLE_RECENT_MS).toISOString()
  const candidates:Array<{id:number;row_json:string;payload_bytes:number}>=[],censors=new Map<string,{signal_key:string;kind:string;rows:number}>()
  const sql=`SELECT o.id,${PROJECTION} row_json,json_quote(o.signal_date) signal_key,${KIND} kind,
    CASE WHEN ${terminal} THEN 1 ELSE 0 END terminal FROM s12_replay_trade_outcomes o
    LEFT JOIN ${LIFE} l ON l.run_id=? AND l.business_date=o.signal_date WHERE ${ELIGIBLE}`
  for await(const projected of projectS12ReplayChunk(db,page.rows,sql,[recent,recent,w.snapshot_at,w.run_id,...windowParams(w)])) {
    for(const row of projected) {
      const key=row.signal_key+'\0'+row.kind,c=censors.get(key)??{signal_key:row.signal_key,kind:row.kind,rows:0};c.rows++;censors.set(key,c)
      if(Number(row.terminal)===1)candidates.push({id:Number(row.id),row_json:row.row_json,payload_bytes:encoder.encode(row.row_json).length})
    }
  }
  if(candidates.some(r=>!Number.isSafeInteger(r.id)||r.id<1) || new Set(candidates.map(r=>r.id)).size!==candidates.length)
    throw new Error('s12_calibration_page_identity_invalid')
  // Only inspect the tail that could be displaced, not all 100000 retained candidates on every page.
  const tail=candidates.length?(await db.prepare(`SELECT id,payload_bytes FROM ${ROWS} WHERE run_id=? ORDER BY id DESC LIMIT ?`)
    .bind(w.run_id,candidates.length).all<{id:number;payload_bytes:number}>()).results??[]:[]
  const overflow=Math.max(0,w.retained_rows+candidates.length-CALIBRATION_EVIDENCE_SCAN_LIMIT)
  const drop=new Set([...tail,...candidates].map(r=>r.id).sort((a,b)=>b-a).slice(0,overflow))
  const insert=candidates.filter(r=>!drop.has(r.id)),remove=tail.filter(r=>drop.has(r.id))
  const retainedRows=w.retained_rows+insert.length-remove.length
  const retainedBytes=w.retained_bytes+insert.reduce((n,r)=>n+r.payload_bytes,0)-remove.reduce((n,r)=>n+r.payload_bytes,0)
  if(retainedBytes>MAX_BYTES)throw new Error('s12_calibration_scratch_byte_budget_exceeded')
  const token=paperExecutionUUID(),guard=COMMIT_OWNERSHIP_SQL
  const statements=[db.prepare(`UPDATE ${WORK} SET revision=revision+1,commit_token=?,checkpoint_json=?,phase=?,
    retained_rows=?,retained_bytes=?,updated_at=? WHERE run_id=? AND revision=? AND phase='reading'`)
    .bind(token,JSON.stringify(page.checkpoint),page.complete?'ready':'reading',retainedRows,retainedBytes,
      paperExecutionDate().toISOString(),w.run_id,w.revision)]
  // Release tail slots before inserts; all writes remain in this single transaction.
  if(remove.length)statements.push(db.prepare(`DELETE FROM ${ROWS} WHERE run_id=? AND id IN (SELECT value FROM json_each(?)) AND ${guard}`)
    .bind(w.run_id,JSON.stringify(remove.map(r=>r.id)),w.run_id,token))
  for(const payload of jsonPages(insert))statements.push(db.prepare(`INSERT INTO ${ROWS}(run_id,id,row_json,payload_bytes)
    SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.row_json'),json_extract(value,'$.payload_bytes')
    FROM json_each(?) WHERE ${guard}`).bind(w.run_id,payload,w.run_id,token))
  for(const payload of jsonPages([...censors.values()]))statements.push(db.prepare(`INSERT INTO ${CENSOR}(run_id,signal_key,kind,rows)
    SELECT ?,json_extract(value,'$.signal_key'),json_extract(value,'$.kind'),json_extract(value,'$.rows')
    FROM json_each(?) WHERE ${guard} ON CONFLICT(run_id,signal_key,kind) DO UPDATE SET rows=rows+excluded.rows`)
    .bind(w.run_id,payload,w.run_id,token))
  statements.push(db.prepare(`UPDATE ${WORK} SET scratch_valid=CASE WHEN
    (SELECT COUNT(*) FROM ${CENSOR} WHERE run_id=?)<=10000 THEN 1 ELSE 0 END WHERE run_id=? AND commit_token=?`)
    .bind(w.run_id,w.run_id,token))
  if(statements.length>250)throw new Error('s12_calibration_page_statement_budget_exceeded')
  await options.beforeCommit?.()
  await db.batch(statements)
  return readWork(db,w.run_id)
}

function cleanupStatements(db:D1Database,w:CalibrationWork):D1PreparedStatement[] {
  return [ROWS,LIFE,CENSOR].map(table=>db.prepare(`DELETE FROM ${table} WHERE run_id=?`).bind(w.run_id)).concat([
    db.prepare(`DELETE FROM ${CURRENT} WHERE work_id=?`).bind(w.run_id),
    db.prepare(`UPDATE ${WORK} SET retained_rows=0,retained_bytes=0 WHERE run_id=?`).bind(w.run_id),
  ])
}
export async function loadFrozenCalibrationEvidence(db:D1Database,w:CalibrationWork):Promise<CalibrationEvidence[]> {
  if(w.phase!=='ready')throw new Error('s12_calibration_input_incomplete')
  const evidence:CalibrationEvidence[]=[];let after=0,seen=0,bytes=0
  while(true) {
    // Up to 512 rows / 4 MiB per response; the window sum only scans this bounded keyset page.
    const rows=(await db.prepare(`SELECT id,row_json,payload_bytes FROM (
      SELECT *,SUM(payload_bytes) OVER(ORDER BY id) page_bytes FROM (
        SELECT id,row_json,payload_bytes FROM ${ROWS} WHERE run_id=? AND id>? ORDER BY id LIMIT 512
      )) WHERE page_bytes<=4194304 ORDER BY id`)
      .bind(w.run_id,after).all<{id:number;row_json:string;payload_bytes:number}>()).results??[]
    if(!rows.length)break
    for(const r of rows){after=r.id;seen++;bytes+=r.payload_bytes;const value=calibrationEvidenceFromRow(JSON.parse(r.row_json));if(value)evidence.push(value)}
  }
  if(seen!==w.retained_rows||bytes!==w.retained_bytes)throw new Error('s12_calibration_frozen_scratch_incomplete')
  evidence.sort((a,b)=>a.tradeDate.localeCompare(b.tradeDate)||a.symbol.localeCompare(b.symbol))
  return evidence
}
export async function finishS12CalibrationWork(db:D1Database,w:CalibrationWork,options:{beforeCommit?:()=>Promise<void>;
  replaceExistingRunArtifacts?:boolean}={}) {
  const lifecycleCensoring=await readCalibrationWorkCensoring(db,w.run_id)
  if(w.phase!=='ready')throw new Error('s12_calibration_input_incomplete')
  const fence=(phase:string)=>db.prepare(`UPDATE ${WORK} SET scratch_valid=CASE WHEN phase='ready' AND revision=? THEN 1 ELSE 0 END,
    phase=?,updated_at=? WHERE run_id=?`).bind(w.revision,phase,paperExecutionDate().toISOString(),w.run_id)
  if(lifecycleCensoring.recentEnqueuedRows>0) {
    // This frozen attempt cannot mature. Retain its checkpoint receipt, discard only scratch, and let recovery recapture later.
    await options.beforeCommit?.()
    await db.batch([fence('deferred'),...cleanupStatements(db,w)])
    return {deferred:true as const,dates:lifecycleCensoring.recentEnqueuedDates}
  }
  if(lifecycleCensoring.staleEnqueuedRows>0 || lifecycleCensoring.missingOrOtherRows>0) {
    console.warn('[S12 calibration] excluded non-terminal replay lifecycle evidence '+JSON.stringify({
      stale_enqueued_rows:lifecycleCensoring.staleEnqueuedRows,
      stale_enqueued_dates:lifecycleCensoring.staleEnqueuedDates,
      missing_or_other_rows:lifecycleCensoring.missingOrOtherRows,
      missing_or_other_dates:lifecycleCensoring.missingOrOtherDates,
    }))
  }
  const evidence=await loadFrozenCalibrationEvidence(db,w)
  const result=await runS12TwCalibrationFromEvidence(db,{runDate:w.run_date,cadence:w.cadence,lifecycleCensoring,
    replaceExistingRunArtifacts:options.replaceExistingRunArtifacts,beforeCommit:options.beforeCommit,
    transactionBefore:[fence('committed')],transactionAfter:cleanupStatements(db,w)},evidence)
  return {deferred:false as const,result,workId:w.run_id,checkpoint:w.checkpoint_json?JSON.parse(w.checkpoint_json):null}
}
