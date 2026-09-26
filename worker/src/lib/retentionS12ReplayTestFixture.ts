import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { releaseArchivedRows } from './retentionSourceRelease'
import { buildReplayCompactPayload, REPLAY_COMPACT_DOMAIN, REPLAY_COMPACT_SCHEMA, type ReplayReleaseProjection } from './retentionS12ReplayProjection'
import { sha256Text } from './datasetSnapshots'
import type { RetentionArchiveSource } from './retentionArchiveOnly'
import type { EvidenceArtifactManifest } from './evidenceArtifactContract'

export const schema = readFileSync('domain-schemas/learning.sql','utf8')
const ddl = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS s12_replay_trade_outcomes')).split(';')[0]
export const source: RetentionArchiveSource = {datasetId:'s12_replay_trade_outcomes',sourceDomain:'learning',
  fromSql:'s12_replay_trade_outcomes',selectSql:'s12_replay_trade_outcomes.*',keyExpression:'s12_replay_trade_outcomes.rowid',
  dateExpression:'s12_replay_trade_outcomes.trade_date',eligibilitySql:'1=1',deleteTable:'s12_replay_trade_outcomes',deleteKeyColumn:'rowid'}

export function replayReleaseFixture() {
  const sql = new DatabaseSync(':memory:')
  sql.exec('PRAGMA foreign_keys=ON;'+ddl)
  sql.exec(`CREATE UNIQUE INDEX signal_key ON s12_replay_trade_outcomes(symbol,signal_date,setup_id) WHERE signal_date IS NOT NULL;
    CREATE TABLE allocator_ev_daily_lifecycle(business_date TEXT PRIMARY KEY,state TEXT,updated_at TEXT,upstream_run_id TEXT);
    CREATE TABLE run_artifacts(artifact_id TEXT PRIMARY KEY,domain TEXT,r2_key TEXT,checksum TEXT,row_count INTEGER,byte_size INTEGER,
      schema_version TEXT,metadata_json TEXT,retention_class TEXT,status TEXT,payload_deleted_at TEXT,created_at TEXT);
    CREATE TABLE data_retention_run_items(status TEXT,deleted_rows INTEGER,evidence_json TEXT,completed_at TEXT);`)
  for (const migration of ['0050_retention_source_release.sql','0056_s12_replay_reward_covering_index.sql','0057_s12_replay_cold_release.sql'])
    sql.exec(readFileSync('domain-migrations/learning/'+migration,'utf8'))
  const objects = new Map<string,string>(), downloads:string[]=[], queries:string[]=[]
  let calls=0, fail='', lose=false
  function prepare(query:string, params:any[]=[], record=true) {
    if(record)queries.push(query)
    return {query,get params(){return params},bind(...values:any[]){return prepare(query,values,false)},
      async first(){calls++;return sql.prepare(query).get(...params)??null},
      async all(){calls++;return {results:sql.prepare(query).all(...params)}},
      async run(){calls++;const r=sql.prepare(query).run(...params);return {meta:{changes:Number(r.changes)}}}}
  }
  const db = {prepare,async batch(statements:any[]) {
    calls++;sql.exec('BEGIN')
    try {
      const result=statements.map(s=>{
        if(fail && s.query.includes(fail))throw new Error('injected '+fail)
        const q=sql.prepare(s.query)
        return {results:q.columns().length?q.all(...s.params):(q.run(...s.params),[])}
      })
      sql.exec('COMMIT');if(lose)throw new Error('lost HTTP acknowledgement');return result
    } catch(error){if(sql.isTransaction)sql.exec('ROLLBACK');throw error}
  }} as unknown as D1Database
  const env={DB:db,ARTIFACTS:{async get(key:string){downloads.push(key);const raw=objects.get(key)
    return raw===undefined?null:{size:Buffer.byteLength(raw),text:async()=>raw}}}} as any
  function insert(r:Record<string,any>) {sql.prepare(`INSERT INTO s12_replay_trade_outcomes(${Object.keys(r).join(',')})
    VALUES(${Object.keys(r).map(()=>'?').join(',')})`).run(...Object.values(r))}
  function rows() {return sql.prepare('SELECT id __cursor_key,trade_date __archive_date,* FROM s12_replay_trade_outcomes ORDER BY id').all() as any[]}
  async function seal(name:string, rows:Record<string,any>[], cutoff='2026-09-01') {
    const domain='retention_learning_lineage_v1_s12_replay_trade_outcomes',version='d1-retention-hot-window-drain-v1'
    const raw=JSON.stringify({schema_version:version,domain,payload:{schema_version:version,policy_id:'learning_lineage_v1',
      dataset_id:source.datasetId,source_domain:'learning',cutoff_date:cutoff,source_schema_sql:ddl,rows}})
    const artifact={artifact_id:name,checksum:await sha256Text(raw)}
    const payload=await buildReplayCompactPayload(rows,artifact)
    const body=JSON.stringify({schema_version:REPLAY_COMPACT_SCHEMA,domain:REPLAY_COMPACT_DOMAIN,payload})
    const projection:EvidenceArtifactManifest={artifact_id:name+':compact',checksum:await sha256Text(body),row_count:rows.length,
      byte_size:Buffer.byteLength(body),r2_key:name+':compact',status:'ready',retention_class:'ten_year_cold_archive',
      schema_version:REPLAY_COMPACT_SCHEMA,domain:REPLAY_COMPACT_DOMAIN,business_date:'2026-09-26',producer_run_id:name,
      canonical_run_id:null,created_at:'2026-09-26T00:00:00Z',retain_until:'2036-09-23',checksum_verified_at:'2026-09-26',metadata_json:'{}'}
    objects.set(name,raw);objects.set(projection.r2_key,body)
    sql.prepare('INSERT INTO run_artifacts VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?)')
      .run(name,domain,name,artifact.checksum,rows.length,Buffer.byteLength(raw),version,'{}','ten_year_cold_archive','ready','2026-09-26T00:00:00Z')
    const compact:ReplayReleaseProjection={source_artifact_id:name,source_checksum:artifact.checksum,rows_checksum:payload.rows_checksum,projection}
    return {artifact,compact,rows,release:()=>releaseArchivedRows(db,source,cutoff,rows,artifact,compact)}
  }
  function count(table:string) {return Number(sql.prepare('SELECT COUNT(*) n FROM '+table).get()?.n)}
  return {sql,db,env,objects,downloads,queries,insert,rows,seal,count,get calls(){return calls},failAt(value:string){fail=value},loseAck(){lose=true}}
}
