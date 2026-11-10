import type { Bindings } from '../types'
import { databaseForDataDomain, shadowDatabaseForDataDomain } from './dataDomainRegistry'
import { loadLatestSchedulerRootTicket } from './schedulerExecutionTickets'
import { PRICE_HORIZON_PROJECTION_VERSION, PRICE_HORIZON_SOURCE,
  STRATEGY_MULTI_HORIZON_PROJECTION_VERSION, type PriceHorizonProjectionResult,
  type StrategyMultiHorizonProjectionResult } from './priceHorizonProjection'
import { STRATEGY_MULTI_HORIZON_OUTCOME_SCHEMA_VERSION, type StrategyMultiHorizonOutcomeResult } from './strategyMultiHorizonOutcomes'
import { SELECTION_REFERENCE_MATURE_COMPATIBLE_CONTRACT_VERSIONS } from './selectionReferenceEvidence'

type Task = 'price-horizon-projection' | 'strategy-multi-horizon-outcomes'
type ProducerResult = { canonical?: PriceHorizonProjectionResult; multiHorizon?: StrategyMultiHorizonProjectionResult;
  outcomes?: StrategyMultiHorizonOutcomeResult }
type Input = { task: Task; businessDate: string; canonicalRunId: string; rootTicketId?: string;
  sourceSha?: string; projectionRunId?: string; summary?: string; producerResult?: ProducerResult }
type Row = Record<string, string | number | null>
type TableProof = { table: string; binding: string; columns: string[]; primaryKey: string[];
  scope: { predicate: string; parameters: unknown[]; rowScope?: string };
  rows: number; pages: number; checksum: string; firstKey: unknown[] | null; lastKey: unknown[] | null; empty: boolean }
type GroupProof = { table: string; binding: string; kind: 'group-count'; groupBy: string[];
  scope: { predicate: string; parameters: unknown[] }; groups: number; checksum: string }
// v2: row-level proof only for the date x horizon keys whose projection status was written on or after the
// business date (every attempt of this chain, plus any later night) and the producer's processed keys; the
// rest of the 120-day window is proven by SQL GROUP BY counts reconciled against status/producer counts.
// v1 (whole-window row proof) receipts never verify.
const SCHEMA = 'post-verify-label-evidence-v2' as const
export type PostVerifyLabelEvidence = Record<string, unknown> & {
  schema: typeof SCHEMA; input: Input; versionId: string;
  window: { startDate: string; endDate: string; outcomeAsOfDate: string };
  algorithm: 'sha256-page-chain-v1+group-count-v1'; pageSize: number; tables: Array<TableProof | GroupProof>;
  rowScope: Record<string, string[]>; checksum: string
}
// D1 round trips, not row volume, bound the capture: 4096-row pages keep the
// 120-day outcome proof to ~75 queries. Same 524,288-row budget as 1024x512.
const PAGE_SIZE = 4096
const MAX_PAGES = 128
const LABEL_COLUMNS = ['stock_id','price_date','entry_date','entry_raw_open','entry_adjustment_factor',
  'exit_date','exit_raw_close','exit_adjustment_factor','outcome_known_date','source','projection_version','materialized_at']
const REJECTION_COLUMNS = ['stock_id','price_date','entry_date','exit_date','rejection_reason','source','projection_version','updated_at']
const STATUS_COLUMNS = ['signal_date','entry_date','exit_date','candidate_count','materialized_count','rejected_count',
  'status','source','projection_version','updated_at']
const STATUS_V2_COLUMNS = [STATUS_COLUMNS[0],'horizon_days',...STATUS_COLUMNS.slice(1)]
const OUTCOME_COLUMNS = ['signal_date','symbol','producer_run_id','horizon_days','label_schema_version',
  'market_segment','sector','entry_date','exit_date','outcome_known_date','gross_return','transaction_cost_bps',
  'absolute_return_net','benchmark_return_net','benchmark_scope','residual_return_net','cross_section_rank',
  'adjustment_source','reference_contract_version','created_at']

async function digest(value: unknown): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))),
    byte => byte.toString(16).padStart(2,'0')).join('')
}
function day(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(value+'T00:00:00Z'))
      || new Date(value+'T00:00:00Z').toISOString().slice(0,10) !== value) throw new Error('post_verify_evidence_date_invalid')
  return value
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('post_verify_evidence_count_invalid')
  return Number(value)
}
function horizon(value: unknown): number {
  if (![3,5,10].includes(Number(value))) throw new Error('post_verify_evidence_horizon_invalid')
  return Number(value)
}
function maturity(row: Row, date: string, priceDate: string): void {
  if (day(row.entry_date) <= priceDate || day(row.exit_date) < String(row.entry_date)
      || row.outcome_known_date !== row.exit_date || String(row.exit_date) > date) throw new Error('post_verify_evidence_maturity_invalid')
}

async function groupCount(db: D1Database, options: {
  table: string; binding: string; groupBy: string[]; sql: string; binds: unknown[]
}): Promise<{ proof: GroupProof; rows: Row[] }> {
  const result = await db.prepare(options.sql).bind(...options.binds).all<Row>()
  if (result.success === false) throw new Error(`post_verify_evidence_read_failed:${options.table}`)
  const rows = result.results ?? []
  return { rows, proof: { table: options.table, binding: options.binding, kind: 'group-count', groupBy: options.groupBy,
    scope: { predicate: options.sql, parameters: options.binds }, groups: rows.length,
    checksum: await digest({ sql: options.sql, binds: options.binds, rows }) } }
}

function processedKeys(value: unknown): Array<[string, number]> {
  if (!Array.isArray(value)) throw new Error('post_verify_evidence_processed_keys_missing')
  const pairs = value.map(key => [day(key?.signalDate), horizon(key?.horizonDays)] as [string, number])
  if (new Set(pairs.map(pair => pair.join(':'))).size !== pairs.length) throw new Error('post_verify_evidence_duplicate_processed_key')
  return pairs
}

/** Keys proven row by row: the processed keys plus every status row written on or after the business date (UTC).
 * A retried producer skips the dates an earlier attempt finished, but their status rows still carry tonight's
 * updated_at; derived from the status rows in this proof, so a verify re-derives the same keys. */
function rowScope(processed: Array<[string, number]>, statusRows: Row[], date: string, v: 1 | 2): Array<[string, number]> {
  const keys = new Map(processed.map(([signal, h]) => [`${signal}:${h}`, [signal, h] as [string, number]]))
  for (const row of statusRows) {
    if (String(row.updated_at ?? '').slice(0, 10) < date) continue
    const key: [string, number] = [day(row.signal_date), v === 1 ? 5 : horizon(row.horizon_days)]
    keys.set(key.join(':'), key)
  }
  return [...keys.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1])
}

/** One key's row predicate, written so each table is read through an index on that key alone (no OR chains,
 * which SQLite answers with a MULTI-INDEX OR over the horizon index). labels_v2 has no price_date-leading
 * index: its outcome_known_date (= exit_date) is bounded by the key's status contract instead. */
function keyPredicate(table: string, signal: string, h: number, exitDate?: string): { where: string; binds: unknown[] } {
  if (table === 'price_horizon_labels_v2') {
    if (!exitDate) throw new Error('post_verify_evidence_scope_status_missing')
    return { where: 'horizon_days=? AND outcome_known_date>? AND outcome_known_date<=? AND price_date=?', binds: [h, signal, exitDate, signal] }
  }
  if (table === 'price_horizon_label_rejections_v2') return { where: 'horizon_days=? AND price_date=?', binds: [h, signal] }
  if (table === 'canonical_selection_outcomes_v1') return { where: 'signal_date=? AND +horizon_days=?', binds: [signal, h] }
  if (table === 'selection_reference_snapshots_v1') return { where: 'signal_date=?', binds: [signal] }
  return { where: 'price_date=?', binds: [signal] }
}

async function tableProof(db: D1Database, options: {
  table: string; binding: string; columns: string[]; keys: string[]; where: string; binds: unknown[];
  onRow?: (row: Row) => void
}): Promise<TableProof> {
  let cursor: unknown[] | null = null, firstKey: unknown[] | null = null, checksum = await digest(options)
  let rows = 0, pages = 0, complete = false
  for (let page=0; page<MAX_PAGES; page++) {
    // The cursor bound leads the predicate. Behind the window's own lower
    // bound, D1 seeks from the window start and only filters on the cursor,
    // so every page re-read all earlier rows (94,823 rows for one deep page).
    const seek = cursor ? `${options.keys[0]}>=? AND (${options.keys.join(',')}) > (${options.keys.map(()=>'?').join(',')}) AND ` : ''
    const result = await db.prepare(`SELECT ${options.columns.join(',')} FROM ${options.table}
      WHERE ${seek}(${options.where}) ORDER BY ${options.keys.join(',')} LIMIT ${PAGE_SIZE}`)
      .bind(...(cursor ? [cursor[0],...cursor] : []),...options.binds).all<Row>()
    if (result.success === false) throw new Error(`post_verify_evidence_read_failed:${options.table}`)
    const pageRows = result.results ?? []
    if (!pageRows.length) { complete = true; break }
    const next = options.keys.map(key=>pageRows.at(-1)![key])
    if (next.some(value=>value===null || value===undefined) || JSON.stringify(next)===JSON.stringify(cursor)) {
      throw new Error(`post_verify_evidence_cursor_invalid:${options.table}`)
    }
    for (const row of pageRows) options.onRow?.(row)
    firstKey ??= options.keys.map(key=>pageRows[0][key])
    checksum = await digest({ previous: checksum, rows: pageRows })
    rows += pageRows.length; pages++; cursor = next
    if (pageRows.length < PAGE_SIZE) { complete = true; break }
  }
  if (!complete) throw new Error(`post_verify_evidence_page_budget:${options.table}`)
  const count = await db.prepare(`SELECT COUNT(*) AS n FROM ${options.table} WHERE ${options.where}`)
    .bind(...options.binds).first<{n:number}>()
  if (!count || integer(count.n)!==rows) throw new Error(`post_verify_evidence_concurrent_change:${options.table}`)
  return { table: options.table, binding: options.binding, columns: options.columns, primaryKey: options.keys,
    scope: { predicate: options.where, parameters: options.binds },
    rows, pages, checksum, firstKey, lastKey: cursor, empty: rows===0 }
}

/** One proof per table over the row-scope keys: each key is paged on its own index search, and the per-key page
 * checksums are chained. The key list is stored once in the evidence (`rowScope[name]`), not per table or key,
 * so the receipt stays far below its 32 KB cap even when every date of the window is in scope. */
async function keyedProof(db: D1Database, scope: { name: string; keys: Array<[string, number]> }, options: {
  table: string; binding: string; columns: string[]; keys: string[]; where: string; binds: unknown[];
  predicate: (signal: string, h: number) => { where: string; binds: unknown[] }; onRow?: (row: Row) => void
}): Promise<TableProof> {
  const { predicate, ...base } = options
  let checksum = await digest({ ...base, rowScope: scope.name }), rows = 0, pages = 0, template = ''
  let firstKey: unknown[] | null = null, lastKey: unknown[] | null = null
  for (const [signal, h] of scope.keys) {
    const key = predicate(signal, h); template ||= key.where
    const proof = await tableProof(db, { ...base, where: `${options.where} AND ${key.where}`, binds: [...options.binds, ...key.binds] })
    checksum = await digest({ previous: checksum, key: `${signal}:${h}`, checksum: proof.checksum, rows: proof.rows })
    rows += proof.rows; pages += proof.pages; firstKey ??= proof.firstKey; lastKey = proof.lastKey ?? lastKey
  }
  return { table: options.table, binding: options.binding, columns: options.columns, primaryKey: options.keys,
    scope: { predicate: template ? `${options.where} AND ${template}` : options.where, parameters: options.binds, rowScope: scope.name },
    rows, pages, checksum, firstKey, lastKey, empty: rows === 0 }
}

export async function capturePostVerifyLabelEvidence(env: Bindings, input: Input): Promise<PostVerifyLabelEvidence> {
  const date = day(input.businessDate)
  if (!['price-horizon-projection','strategy-multi-horizon-outcomes'].includes(input.task) || !input.canonicalRunId) {
    throw new Error('post_verify_evidence_identity_missing')
  }
  const sourceSha = String(env.CF_VERSION_METADATA?.tag ?? ''), versionId = String(env.CF_VERSION_METADATA?.id ?? '')
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !versionId || (input.sourceSha && input.sourceSha!==sourceSha)) {
    throw new Error('post_verify_evidence_source_changed')
  }
  const ops = databaseForDataDomain(env,'ops'), learning = databaseForDataDomain(env,'learning')
  const targetLearning = shadowDatabaseForDataDomain(env,'learning') ?? learning
  const targetOps = shadowDatabaseForDataDomain(env,'ops') ?? ops
  const root = await loadLatestSchedulerRootTicket(ops,{schedulerJobId:'evening-chain',businessDate:date})
  if (!root || (input.rootTicketId && input.rootTicketId!==root.ticket_id)) throw new Error('post_verify_evidence_root_changed')
  // Read-only late-producer capture remains valid after the observer's lease
  // expires. Exact task-claim terminal CAS is owned by the checkpoint manager.
  const stage=await ops.prepare(`SELECT canonical_run_id FROM pipeline_stage_runs WHERE business_date=?
    AND stage='post_verify_chain' AND canonical_run_id=?`)
    .bind(date,input.canonicalRunId).first()
  if(!stage)throw new Error('post_verify_evidence_canonical_stage_changed')
  const start = new Date(date+'T00:00:00Z'); start.setUTCDate(start.getUTCDate()-120)
  const startDate = start.toISOString().slice(0,10), tables: Array<TableProof | GroupProof> = [], rowScopes: Record<string,string[]> = {}
  const named=(name:string,keys:Array<[string,number]>)=>{rowScopes[name]=keys.map(key=>key.join(':'));return {name,keys}}
  const normalized: Input = JSON.parse(JSON.stringify({...input, sourceSha, rootTicketId:root.ticket_id}))
  delete normalized.summary // Expected counts are structured producer results; prose is not proof.
  const statusWhere = { where:'signal_date>=? AND signal_date<=? AND source=? AND projection_version=?',
    binds:(version:string)=>[startDate,date,PRICE_HORIZON_SOURCE,version] }
  if (input.task==='price-horizon-projection') {
    const counts = new Map<string,{labels:number;rejections:number}>(), statuses = new Map<string,Row>()
    const groupKey = (v:number,row:Row)=>`${v}:${day(row.price_date ?? row.signal_date)}:${v===1?5:horizon(row.horizon_days)}`
    const expected=input.producerResult
    for (const v of [1,2] as const) {
      const db = v===1?learning:targetLearning, statusDb = v===1?ops:targetOps
      const version = v===1?PRICE_HORIZON_PROJECTION_VERSION:STRATEGY_MULTI_HORIZON_PROJECTION_VERSION
      const result = v===1?expected?.canonical:expected?.multiHorizon
      if(!result || !Array.isArray(result.processedHorizonKeys) || result.processedHorizonKeys.length!==integer(result.processedSignalDates)) throw new Error('post_verify_evidence_processed_keys_missing')
      const processed = processedKeys(result.processedHorizonKeys)
      // The window's status rows first: they carry the counts to reconcile and decide the row-level keys.
      const statusRows: Row[] = []
      tables.push(await tableProof(statusDb,{table:`price_horizon_projection_status${v===2?'_v2':''}`,
        binding:v===1?'ops':'ops-target',columns:v===1?STATUS_COLUMNS:STATUS_V2_COLUMNS,keys:v===1?['signal_date']:['signal_date','horizon_days'],
        where:statusWhere.where,binds:statusWhere.binds(version),
        onRow:row=>{statusRows.push(row);statuses.set(groupKey(v,row),row)}}))
      for (const [signal,h] of processed) if(!statuses.has(`${v}:${signal}:${h}`)) throw new Error(`post_verify_evidence_processed_status_missing:${v}:${signal}:${h}`)
      const scope = rowScope(processed,statusRows,date,v), projectionKeys = named(`projection-v${v}`,scope)
      const window = { where:'price_date>=? AND price_date<=? AND source=? AND projection_version=?', binds:[startDate,date,PRICE_HORIZON_SOURCE,version] }
      const rowCounts = new Map<string,{labels:number;rejections:number}>()
      for (const rejection of [false,true]) {
        const table = `price_horizon_${rejection?'label_rejections':'labels'}_v${v}`, binding = v===1?'learning':'learning-target'
        const columns = [...(rejection?REJECTION_COLUMNS:LABEL_COLUMNS)]
        if (v===2) columns.splice(2,0,'horizon_days')
        // Row-level content proof, one key at a time.
        tables.push(await keyedProof(db,projectionKeys,{table,binding,columns,keys:v===1?['stock_id','price_date']:['stock_id','price_date','horizon_days'],
            where:window.where,binds:window.binds,
            predicate:(signal,h)=>keyPredicate(table,signal,h,v===2?day(statuses.get(`2:${signal}:${h}`)?.exit_date):undefined),
            onRow:row=>{
              const signal=day(row.price_date); if(integer(row.stock_id)===0) throw new Error('post_verify_evidence_stock_invalid')
              if (rejection) {
                if(!row.rejection_reason || day(row.entry_date)<=signal || day(row.exit_date)<String(row.entry_date) || String(row.exit_date)>date) throw new Error('post_verify_evidence_rejection_invalid')
              } else {
                maturity(row,date,signal)
                if(['entry_raw_open','entry_adjustment_factor','exit_raw_close','exit_adjustment_factor'].some(key=>typeof row[key]!=='number'||!Number.isFinite(row[key])||Number(row[key])<=0)) throw new Error('post_verify_evidence_price_invalid')
              }
              const key=groupKey(v,row), value=rowCounts.get(key)??{labels:0,rejections:0}
              value[rejection?'rejections':'labels']++;rowCounts.set(key,value)
            }}))
        // The whole window: one GROUP BY count per date (x horizon), reconciled against the status rows below.
        // v2 tables lead their indexes with horizon_days; the IN list (the CHECK's whole domain) and, for labels,
        // outcome_known_date>start (implied by the CHECKs: known = exit >= entry > price_date >= start) select
        // exactly the window's rows through the index instead of scanning the whole retained table.
        const groupBy = v===1?['price_date']:['price_date','horizon_days']
        const indexed = v===1?{where:'',binds:[] as unknown[]}:rejection?{where:'horizon_days IN (3,5,10) AND ',binds:[]}
          :{where:'horizon_days IN (3,5,10) AND outcome_known_date>? AND ',binds:[startDate]}
        const grouped = await groupCount(db,{table,binding,groupBy,binds:[...indexed.binds,...window.binds],
          sql:`SELECT ${groupBy.join(',')},COUNT(*) AS n FROM ${table} WHERE ${indexed.where}${window.where} GROUP BY ${groupBy.join(',')} ORDER BY ${groupBy.join(',')}`})
        tables.push(grouped.proof)
        for (const row of grouped.rows) {
          const key=groupKey(v,row), value=counts.get(key)??{labels:0,rejections:0}
          value[rejection?'rejections':'labels']+=integer(row.n);counts.set(key,value)
        }
      }
      for (const row of statusRows) {
        const key=groupKey(v,row), actual=counts.get(key)??{labels:0,rejections:0}
        const materialized=integer(row.materialized_count), rejected=integer(row.rejected_count)
        if(integer(row.candidate_count)!==materialized+rejected || materialized!==actual.labels || rejected!==actual.rejections) throw new Error(`post_verify_evidence_label_count_mismatch:${key}`)
      }
      // The row reads of the scope keys must agree with the window counts at those keys; otherwise the tables
      // changed under this capture (or rows sit outside the key's status contract, which no rerun repairs).
      for (const [signal,h] of scope) {
        const key=`${v}:${signal}:${h}`, rows=rowCounts.get(key)??{labels:0,rejections:0}, all=counts.get(key)??{labels:0,rejections:0}
        if (rows.labels!==all.labels || rows.rejections!==all.rejections) throw new Error(`post_verify_evidence_concurrent_change:${key}`)
      }
      const actual=processed.map(([signal,h])=>statuses.get(`${v}:${signal}:${h}`)!)
      for(const [field,number] of [['candidate_count',result.candidateCount],['materialized_count',result.materializedCount],['rejected_count',result.rejectedCount]] as const) {
        if(actual.reduce((sum,row)=>sum+integer(row[field]),0)!==integer(number))throw new Error('post_verify_evidence_processed_count_mismatch')
      }
    }
    for(const key of counts.keys()) if(!statuses.has(key)) throw new Error(`post_verify_evidence_label_status_missing:${key}`)
    const runId=input.projectionRunId??expected?.canonical?.runId
    const run=await ops.prepare('SELECT * FROM price_horizon_projection_runs WHERE run_id=? AND start_date=? AND end_date=? AND outcome_as_of_date=?')
      .bind(runId??'',startDate,date,date).first<Row>()
    if(!run || !['success','complete_with_rejections'].includes(String(run.status)) || !run.completed_at) throw new Error('post_verify_evidence_projection_run_missing')
    for(const [field,value] of [['processed_signal_dates',expected!.canonical!.processedSignalDates],['candidate_count',expected!.canonical!.candidateCount],['materialized_count',expected!.canonical!.materializedCount],['rejected_count',expected!.canonical!.rejectedCount]] as const) {
      if(integer(run[field])!==integer(value))throw new Error('post_verify_evidence_projection_run_mismatch')
    }
    tables.push({table:'price_horizon_projection_runs',binding:'ops',columns:Object.keys(run),primaryKey:['run_id'],rows:1,pages:1,
      scope:{predicate:'run_id=? AND start_date=? AND end_date=? AND outcome_as_of_date=?',parameters:[runId,startDate,date,date]},
      checksum:await digest(run),firstKey:[run.run_id],lastKey:[run.run_id],empty:false})
  } else {
    // The window counts JOIN references, labels and outcomes, so they must share one learning database.
    if (learning!==targetLearning) throw new Error('post_verify_evidence_split_learning_binding')
    // Same row-level keys as the projection: multi-horizon status rows written on or after the business date.
    const statusRows: Row[] = [], exits=new Map<string,string>()
    tables.push(await tableProof(targetOps,{table:'price_horizon_projection_status_v2',binding:'ops-target',columns:STATUS_V2_COLUMNS,
      keys:['signal_date','horizon_days'],where:statusWhere.where,binds:statusWhere.binds(STRATEGY_MULTI_HORIZON_PROJECTION_VERSION),
      onRow:row=>{statusRows.push(row);exits.set(`${day(row.signal_date)}:${horizon(row.horizon_days)}`,day(row.exit_date))}}))
    const scope=rowScope([],statusRows,date,2), scopeDates=[...new Set(scope.map(([signal])=>signal))]
    const outcomeKeys=named('outcomes-v2',scope), referenceDates={name:'outcomes-v2-dates',keys:scopeDates.map(signal=>[signal,0] as [string,number])}
    const heads=new Map<string,string>(), references=new Map<string,string>(), rowOutcomes=new Map<string,number>()
    const byPrice=new Map<string,string[]>(), eligible=new Set<string>(), rowMature=new Map<string,number>(), rowPending=new Map<string,number>()
    const rowReferences=new Map<string,number>(), rowAllOutcomes=new Map<string,number>()
    const versions=SELECTION_REFERENCE_MATURE_COMPATIBLE_CONTRACT_VERSIONS
    const referenceScope=(alias:string)=>`${alias}signal_date>=? AND ${alias}signal_date<=? AND ${alias}hard_gate_passed=1`
      +` AND ${alias}feature_contract_version IN (${versions.map(()=>'?').join(',')})`
    const referenceWhere=referenceScope('')
    tables.push(await tableProof(ops,{table:'canonical_run_heads',binding:'ops',
      columns:['logical_run_key','run_id','previous_run_id','promoted_at','updated_at'],keys:['logical_run_key'],
      where:"logical_run_key LIKE 'screener:%:TW:production:market_screener' AND substr(logical_run_key,10,10)>=? AND substr(logical_run_key,10,10)<=?",binds:[startDate,date],
      onRow:row=>{heads.set(String(row.logical_run_key).slice(9,19),String(row.run_id))}}))
    // Row-level content proof of the scope keys: references per date, then labels and outcomes per key.
    // References are read once per scope date (the dates of the same key list).
    tables.push(await keyedProof(learning,referenceDates,{table:'selection_reference_snapshots_v1',binding:'learning',
        columns:['signal_date','symbol','producer_run_id','stock_id','market_segment','sector','feature_contract_version','hard_gate_passed'],
        keys:['signal_date','symbol','producer_run_id'],where:referenceWhere,
        binds:[startDate,date,...versions],predicate:signal=>keyPredicate('selection_reference_snapshots_v1',signal,0),onRow:row=>{
          if(heads.get(String(row.signal_date))===row.producer_run_id) {
            const key=JSON.stringify([row.signal_date,row.symbol,row.producer_run_id])
            references.set(key,String(row.feature_contract_version))
            const priceKey=`${row.stock_id}:${row.signal_date}`
            byPrice.set(priceKey,[...(byPrice.get(priceKey)??[]),key])
            rowReferences.set(String(row.signal_date),(rowReferences.get(String(row.signal_date))??0)+1)
          }
        }}))
    tables.push(await keyedProof(targetLearning,outcomeKeys,{table:'price_horizon_labels_v2',binding:'learning-target',
        columns:[...LABEL_COLUMNS.slice(0,2),'horizon_days',...LABEL_COLUMNS.slice(2)],keys:['stock_id','price_date','horizon_days'],
        where:'price_date>=? AND price_date<=? AND projection_version=?',binds:[startDate,date,STRATEGY_MULTI_HORIZON_PROJECTION_VERSION],
        predicate:(signal,h)=>keyPredicate('price_horizon_labels_v2',signal,h,exits.get(`${signal}:${h}`)),onRow:row=>{
          const keys=byPrice.get(`${row.stock_id}:${row.price_date}`)??[],h=horizon(row.horizon_days),group=`${row.price_date}:${h}`
          if(String(row.outcome_known_date)>date) {rowPending.set(group,(rowPending.get(group)??0)+keys.length);return}
          if(['entry_raw_open','entry_adjustment_factor','exit_raw_close','exit_adjustment_factor'].some(key=>!Number.isFinite(Number(row[key]))||Number(row[key])<=0))return
          for(const key of keys)eligible.add(`${key}:${h}`)
          rowMature.set(group,(rowMature.get(group)??0)+keys.length)
        }}))
    tables.push(await keyedProof(targetLearning,outcomeKeys,{table:'canonical_selection_outcomes_v1',binding:'learning-target',columns:OUTCOME_COLUMNS,
        keys:['signal_date','symbol','producer_run_id','horizon_days','label_schema_version'],
        where:'signal_date>=? AND signal_date<=? AND outcome_known_date<=? AND label_schema_version=?',
        binds:[startDate,date,date,STRATEGY_MULTI_HORIZON_OUTCOME_SCHEMA_VERSION],
        predicate:(signal,h)=>keyPredicate('canonical_selection_outcomes_v1',signal,h),onRow:row=>{
          const group=`${row.signal_date}:${horizon(row.horizon_days)}`
          rowAllOutcomes.set(group,(rowAllOutcomes.get(group)??0)+1)
          const referenceKey=JSON.stringify([row.signal_date,row.symbol,row.producer_run_id])
          const reference=references.get(referenceKey); if(!reference)return
          maturity(row,date,day(row.signal_date));const h=horizon(row.horizon_days)
          if(row.reference_contract_version!==reference || row.adjustment_source!=='price_horizon_labels_v2:finlab_primary_canonical_mirror'
            || !['sector','market_segment','market'].includes(String(row.benchmark_scope))
            || ['gross_return','transaction_cost_bps','absolute_return_net','benchmark_return_net','residual_return_net','cross_section_rank'].some(key=>typeof row[key]!=='number'||!Number.isFinite(row[key]))
            || Number(row.transaction_cost_bps)<0 || Number(row.cross_section_rank)<0 || Number(row.cross_section_rank)>1
            || Math.abs(Number(row.absolute_return_net)-(Number(row.gross_return)-Number(row.transaction_cost_bps)/10000))>1e-12
            || Math.abs(Number(row.residual_return_net)-(Number(row.absolute_return_net)-Number(row.benchmark_return_net)))>1e-12)throw new Error('post_verify_evidence_outcome_invalid')
          // Temporarily unavailable inputs intentionally retain prior outcomes.
          // They remain in the content hash, but are not this invocation's writes.
          if(eligible.has(`${referenceKey}:${h}`))rowOutcomes.set(group,(rowOutcomes.get(group)??0)+1)
        }}))
    // The whole window by SQL GROUP BY counts (canonical head producer only), same rules as the row reads.
    const mature=`l.outcome_known_date<=? AND l.entry_raw_open>0 AND l.entry_adjustment_factor>0 AND l.exit_raw_close>0 AND l.exit_adjustment_factor>0`
    const referenceGroups=await groupCount(learning,{table:'selection_reference_snapshots_v1',binding:'learning',groupBy:['signal_date','producer_run_id'],
      sql:`SELECT signal_date,producer_run_id,COUNT(*) AS n FROM selection_reference_snapshots_v1 WHERE ${referenceWhere}
        GROUP BY signal_date,producer_run_id ORDER BY signal_date,producer_run_id`,binds:[startDate,date,...versions]})
    const labelGroups=await groupCount(learning,{table:'selection_reference_snapshots_v1*price_horizon_labels_v2',binding:'learning',
      groupBy:['signal_date','producer_run_id','horizon_days'],
      sql:`SELECT r.signal_date AS signal_date,r.producer_run_id AS producer_run_id,l.horizon_days AS horizon_days,
          SUM(CASE WHEN l.outcome_known_date>? THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN ${mature} THEN 1 ELSE 0 END) AS mature
        FROM selection_reference_snapshots_v1 r JOIN price_horizon_labels_v2 l ON l.stock_id=r.stock_id AND l.price_date=r.signal_date
        WHERE ${referenceScope('r.')} AND l.projection_version=?
        GROUP BY r.signal_date,r.producer_run_id,l.horizon_days ORDER BY 1,2,3`,
      binds:[date,date,startDate,date,...versions,STRATEGY_MULTI_HORIZON_PROJECTION_VERSION]})
    // Every outcome row of the window is counted (n_all: retained, unmatured-input and non-head rows too);
    // n is the subset with a canonical reference and a mature label, which the producer persisted.
    const outcomeGroups=await groupCount(learning,{table:'canonical_selection_outcomes_v1*selection_reference_snapshots_v1*price_horizon_labels_v2',binding:'learning',
      groupBy:['signal_date','producer_run_id','horizon_days'],
      sql:`SELECT o.signal_date AS signal_date,o.producer_run_id AS producer_run_id,o.horizon_days AS horizon_days,COUNT(*) AS n_all,
          SUM(CASE WHEN r.signal_date IS NOT NULL AND l.stock_id IS NOT NULL THEN 1 ELSE 0 END) AS n
        FROM canonical_selection_outcomes_v1 o
        LEFT JOIN selection_reference_snapshots_v1 r ON r.signal_date=o.signal_date AND r.symbol=o.symbol AND r.producer_run_id=o.producer_run_id
          AND r.hard_gate_passed=1 AND r.feature_contract_version IN (${versions.map(()=>'?').join(',')})
        LEFT JOIN price_horizon_labels_v2 l ON l.stock_id=r.stock_id AND l.price_date=r.signal_date AND l.horizon_days=o.horizon_days
          AND l.projection_version=? AND ${mature}
        WHERE o.signal_date>=? AND o.signal_date<=? AND o.outcome_known_date<=? AND o.label_schema_version=?
        GROUP BY o.signal_date,o.producer_run_id,o.horizon_days ORDER BY 1,2,3`,
      binds:[...versions,STRATEGY_MULTI_HORIZON_PROJECTION_VERSION,date,startDate,date,date,STRATEGY_MULTI_HORIZON_OUTCOME_SCHEMA_VERSION]})
    tables.push(referenceGroups.proof,labelGroups.proof,outcomeGroups.proof)
    const head=(row:Row)=>heads.get(day(row.signal_date))===row.producer_run_id
    let referenceRows=0
    const allReferences=new Map<string,number>(), allMature=new Map<string,number>(), allPending=new Map<string,number>(), allOutcomes=new Map<string,number>()
    const everyOutcome=new Map<string,number>()
    for(const row of referenceGroups.rows)if(head(row)){referenceRows+=integer(row.n);allReferences.set(String(row.signal_date),integer(row.n))}
    for(const row of labelGroups.rows)if(head(row)){const group=`${row.signal_date}:${horizon(row.horizon_days)}`
      allMature.set(group,integer(row.mature));allPending.set(group,integer(row.pending))}
    for(const row of outcomeGroups.rows){const group=`${row.signal_date}:${horizon(row.horizon_days)}`
      everyOutcome.set(group,(everyOutcome.get(group)??0)+integer(row.n_all))
      if(head(row))allOutcomes.set(group,integer(row.n))}
    // The row reads of the scope keys must agree with the window counts at those keys.
    for(const signal of scopeDates)if((rowReferences.get(signal)??0)!==(allReferences.get(signal)??0))throw new Error(`post_verify_evidence_concurrent_change:${signal}`)
    for(const [signal,h] of scope){const group=`${signal}:${h}`
      if((rowMature.get(group)??0)!==(allMature.get(group)??0)||(rowPending.get(group)??0)!==(allPending.get(group)??0)
        ||(rowOutcomes.get(group)??0)!==(allOutcomes.get(group)??0)||(rowAllOutcomes.get(group)??0)!==(everyOutcome.get(group)??0))throw new Error(`post_verify_evidence_concurrent_change:${group}`)}
    const total=(values:Map<string,number>,h:number)=>[...values].reduce((sum,[group,n])=>group.endsWith(`:${h}`)?sum+n:sum,0)
    const expected=input.producerResult?.outcomes
    if(!expected || expected.asOfDate!==date || integer(expected.referenceRows)!==referenceRows || expected.horizons.length!==3)throw new Error('post_verify_evidence_outcome_expected_missing')
    const seen=new Set<number>()
    for(const row of expected.horizons){const h=horizon(row.horizonDays),m=total(allMature,h),p=total(allPending,h)
      if(seen.has(h)||integer(row.persistedRows)!==integer(row.matureRows)||m!==row.matureRows||p!==integer(row.pendingRows)
        ||referenceRows-m-p!==integer(row.unavailableRows)||total(allOutcomes,h)!==row.persistedRows)throw new Error('post_verify_evidence_outcome_count_mismatch');seen.add(h)}
  }
  const after=await loadLatestSchedulerRootTicket(ops,{schedulerJobId:'evening-chain',businessDate:date})
  if(after?.ticket_id!==root.ticket_id)throw new Error('post_verify_evidence_root_changed')
  const body={schema:SCHEMA,input:normalized,versionId,
    window:{startDate,endDate:date,outcomeAsOfDate:date},algorithm:'sha256-page-chain-v1+group-count-v1' as const,pageSize:PAGE_SIZE,tables,rowScope:rowScopes}
  return {...body,checksum:await digest(body)}
}

export async function verifyPostVerifyLabelEvidence(env: Bindings, evidence: unknown): Promise<boolean> {
  let saved: PostVerifyLabelEvidence
  try {
    saved=evidence as PostVerifyLabelEvidence
    // A v1 (whole-window row proof) receipt is superseded: the retry-safe producer reruns once.
    if(!saved || saved.schema!==SCHEMA || typeof saved.checksum!=='string')return false
    if(!saved.input || typeof saved.input.businessDate!=='string' || typeof saved.input.canonicalRunId!=='string')return false
    const {checksum,...body}=saved
    if(await digest(body)!==checksum)return false
  } catch { return false }
  try {
    const current=await capturePostVerifyLabelEvidence(env,saved.input)
    return current.checksum===saved.checksum
  } catch(error) {
    const message=error instanceof Error?error.message:String(error)
    // An unreadable database is not evidence that rerunning a producer helps.
    // The caller retains its settled receipt and retries only the readback.
    if(!message.startsWith('post_verify_evidence_')
      || /^post_verify_evidence_(read_failed|page_budget|concurrent_change|cursor_invalid|split_learning_binding)/.test(message))throw error
    return false
  }
}
