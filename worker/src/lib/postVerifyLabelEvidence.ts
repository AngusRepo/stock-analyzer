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
  scope: { predicate: string; parameters: unknown[] };
  rows: number; pages: number; checksum: string; firstKey: unknown[] | null; lastKey: unknown[] | null; empty: boolean }
export type PostVerifyLabelEvidence = Record<string, unknown> & {
  schema: 'post-verify-label-evidence-v1'; input: Input; versionId: string;
  window: { startDate: string; endDate: string; outcomeAsOfDate: string };
  algorithm: 'sha256-page-chain-v1'; pageSize: number; tables: TableProof[]; checksum: string
}
const PAGE_SIZE = 512
const MAX_PAGES = 1024
const LABEL_COLUMNS = ['stock_id','price_date','entry_date','entry_raw_open','entry_adjustment_factor',
  'exit_date','exit_raw_close','exit_adjustment_factor','outcome_known_date','source','projection_version','materialized_at']
const REJECTION_COLUMNS = ['stock_id','price_date','entry_date','exit_date','rejection_reason','source','projection_version','updated_at']
const STATUS_COLUMNS = ['signal_date','entry_date','exit_date','candidate_count','materialized_count','rejected_count',
  'status','source','projection_version','updated_at']
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

async function tableProof(db: D1Database, options: {
  table: string; binding: string; columns: string[]; keys: string[]; where: string; binds: unknown[];
  onRow?: (row: Row) => void
}): Promise<TableProof> {
  let cursor: unknown[] | null = null, firstKey: unknown[] | null = null, checksum = await digest(options)
  let rows = 0, pages = 0, complete = false
  for (let page=0; page<MAX_PAGES; page++) {
    const extra = cursor ? ` AND (${options.keys.join(',')}) > (${options.keys.map(()=>'?').join(',')})` : ''
    const result = await db.prepare(`SELECT ${options.columns.join(',')} FROM ${options.table}
      WHERE ${options.where}${extra} ORDER BY ${options.keys.join(',')} LIMIT ${PAGE_SIZE}`)
      .bind(...options.binds,...(cursor ?? [])).all<Row>()
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
  const startDate = start.toISOString().slice(0,10), tables: TableProof[] = []
  const normalized: Input = JSON.parse(JSON.stringify({...input, sourceSha, rootTicketId:root.ticket_id}))
  delete normalized.summary // Expected counts are structured producer results; prose is not proof.
  if (input.task==='price-horizon-projection') {
    const counts = new Map<string,{labels:number;rejections:number}>(), statuses = new Map<string,Row>()
    const groupKey = (v:number,row:Row)=>`${v}:${row.price_date ?? row.signal_date}:${v===1?5:horizon(row.horizon_days)}`
    for (const v of [1,2]) {
      const db = v===1?learning:targetLearning, statusDb = v===1?ops:targetOps
      const version = v===1?PRICE_HORIZON_PROJECTION_VERSION:STRATEGY_MULTI_HORIZON_PROJECTION_VERSION
      for (const rejection of [false,true]) {
        const columns = [...(rejection?REJECTION_COLUMNS:LABEL_COLUMNS)]
        if (v===2) columns.splice(2,0,'horizon_days')
        tables.push(await tableProof(db,{table:`price_horizon_${rejection?'label_rejections':'labels'}_v${v}`,
          binding:v===1?'learning':'learning-target',columns,keys:v===1?['stock_id','price_date']:['stock_id','price_date','horizon_days'],
          where:'price_date>=? AND price_date<=? AND source=? AND projection_version=?',binds:[startDate,date,PRICE_HORIZON_SOURCE,version],
          onRow:row=>{
            const signal=day(row.price_date); if(integer(row.stock_id)===0) throw new Error('post_verify_evidence_stock_invalid')
            if (rejection) {
              if(!row.rejection_reason || day(row.entry_date)<=signal || day(row.exit_date)<String(row.entry_date) || String(row.exit_date)>date) throw new Error('post_verify_evidence_rejection_invalid')
            } else {
              maturity(row,date,signal)
              if(['entry_raw_open','entry_adjustment_factor','exit_raw_close','exit_adjustment_factor'].some(key=>typeof row[key]!=='number'||!Number.isFinite(row[key])||Number(row[key])<=0)) throw new Error('post_verify_evidence_price_invalid')
            }
            const key=groupKey(v,row), value=counts.get(key)??{labels:0,rejections:0}
            value[rejection?'rejections':'labels']++;counts.set(key,value)
          }}))
      }
      const columns = [...STATUS_COLUMNS]; if(v===2)columns.splice(1,0,'horizon_days')
      tables.push(await tableProof(statusDb,{table:`price_horizon_projection_status${v===2?'_v2':''}`,
        binding:v===1?'ops':'ops-target',columns,keys:v===1?['signal_date']:['signal_date','horizon_days'],
        where:'signal_date>=? AND signal_date<=? AND source=? AND projection_version=?',binds:[startDate,date,PRICE_HORIZON_SOURCE,version],
        onRow:row=>{const key=groupKey(v,row), actual=counts.get(key)??{labels:0,rejections:0}
          const materialized=integer(row.materialized_count), rejected=integer(row.rejected_count)
          if(integer(row.candidate_count)!==materialized+rejected || materialized!==actual.labels || rejected!==actual.rejections) throw new Error(`post_verify_evidence_label_count_mismatch:${key}`)
          statuses.set(key,row)
        }}))
    }
    for(const key of counts.keys()) if(!statuses.has(key)) throw new Error(`post_verify_evidence_label_status_missing:${key}`)
    const expected=input.producerResult
    for(const [v,result] of [[1,expected?.canonical],[2,expected?.multiHorizon]] as const) {
      if(!result || !Array.isArray(result.processedHorizonKeys) || result.processedHorizonKeys.length!==integer(result.processedSignalDates)) throw new Error('post_verify_evidence_processed_keys_missing')
      const keys=result.processedHorizonKeys.map(key=>`${v}:${day(key.signalDate)}:${horizon(key.horizonDays)}`)
      if(new Set(keys).size!==keys.length) throw new Error('post_verify_evidence_duplicate_processed_key')
      const actual=keys.map(key=>{const value=statuses.get(key);if(!value)throw new Error(`post_verify_evidence_processed_status_missing:${key}`);return value})
      for(const [field,number] of [['candidate_count',result.candidateCount],['materialized_count',result.materializedCount],['rejected_count',result.rejectedCount]] as const) {
        if(actual.reduce((sum,row)=>sum+integer(row[field]),0)!==integer(number))throw new Error('post_verify_evidence_processed_count_mismatch')
      }
    }
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
    const heads=new Map<string,string>(), references=new Map<string,string>(), outcomeCounts=new Map<number,number>()
    const byPrice=new Map<string,string[]>(), eligible=new Set<string>(), mature=new Map<number,number>(), pending=new Map<number,number>()
    tables.push(await tableProof(ops,{table:'canonical_run_heads',binding:'ops',
      columns:['logical_run_key','run_id','previous_run_id','promoted_at','updated_at'],keys:['logical_run_key'],
      where:"logical_run_key LIKE 'screener:%:TW:production:market_screener' AND substr(logical_run_key,10,10)>=? AND substr(logical_run_key,10,10)<=?",binds:[startDate,date],
      onRow:row=>{heads.set(String(row.logical_run_key).slice(9,19),String(row.run_id))}}))
    tables.push(await tableProof(learning,{table:'selection_reference_snapshots_v1',binding:'learning',
      columns:['signal_date','symbol','producer_run_id','stock_id','market_segment','sector','feature_contract_version','hard_gate_passed'],
      keys:['signal_date','symbol','producer_run_id'],where:`signal_date>=? AND signal_date<=? AND hard_gate_passed=1 AND feature_contract_version IN (${SELECTION_REFERENCE_MATURE_COMPATIBLE_CONTRACT_VERSIONS.map(()=>'?').join(',')})`,
      binds:[startDate,date,...SELECTION_REFERENCE_MATURE_COMPATIBLE_CONTRACT_VERSIONS],onRow:row=>{
        if(heads.get(String(row.signal_date))===row.producer_run_id) {
          const key=JSON.stringify([row.signal_date,row.symbol,row.producer_run_id])
          references.set(key,String(row.feature_contract_version))
          const priceKey=`${row.stock_id}:${row.signal_date}`
          byPrice.set(priceKey,[...(byPrice.get(priceKey)??[]),key])
        }
      }}))
    tables.push(await tableProof(targetLearning,{table:'price_horizon_labels_v2',binding:'learning-target',
      columns:[...LABEL_COLUMNS.slice(0,2),'horizon_days',...LABEL_COLUMNS.slice(2)],keys:['stock_id','price_date','horizon_days'],
      where:'price_date>=? AND price_date<=? AND projection_version=?',binds:[startDate,date,STRATEGY_MULTI_HORIZON_PROJECTION_VERSION],onRow:row=>{
        const keys=byPrice.get(`${row.stock_id}:${row.price_date}`)??[],h=horizon(row.horizon_days)
        if(String(row.outcome_known_date)>date) {pending.set(h,(pending.get(h)??0)+keys.length);return}
        if(['entry_raw_open','entry_adjustment_factor','exit_raw_close','exit_adjustment_factor'].some(key=>!Number.isFinite(Number(row[key]))||Number(row[key])<=0))return
        for(const key of keys)eligible.add(`${key}:${h}`)
        mature.set(h,(mature.get(h)??0)+keys.length)
      }}))
    tables.push(await tableProof(targetLearning,{table:'canonical_selection_outcomes_v1',binding:'learning-target',columns:OUTCOME_COLUMNS,
      keys:['signal_date','symbol','producer_run_id','horizon_days','label_schema_version'],
      where:'signal_date>=? AND signal_date<=? AND outcome_known_date<=? AND label_schema_version=?',binds:[startDate,date,date,STRATEGY_MULTI_HORIZON_OUTCOME_SCHEMA_VERSION],onRow:row=>{
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
        if(eligible.has(`${referenceKey}:${h}`))outcomeCounts.set(h,(outcomeCounts.get(h)??0)+1)
      }}))
    const expected=input.producerResult?.outcomes
    if(!expected || expected.asOfDate!==date || integer(expected.referenceRows)!==references.size || expected.horizons.length!==3)throw new Error('post_verify_evidence_outcome_expected_missing')
    const seen=new Set<number>()
    for(const row of expected.horizons){const h=horizon(row.horizonDays),m=mature.get(h)??0,p=pending.get(h)??0
      if(seen.has(h)||integer(row.persistedRows)!==integer(row.matureRows)||m!==row.matureRows||p!==integer(row.pendingRows)
        ||references.size-m-p!==integer(row.unavailableRows)||(outcomeCounts.get(h)??0)!==row.persistedRows)throw new Error('post_verify_evidence_outcome_count_mismatch');seen.add(h)}
  }
  const after=await loadLatestSchedulerRootTicket(ops,{schedulerJobId:'evening-chain',businessDate:date})
  if(after?.ticket_id!==root.ticket_id)throw new Error('post_verify_evidence_root_changed')
  const body={schema:'post-verify-label-evidence-v1' as const,input:normalized,versionId,
    window:{startDate,endDate:date,outcomeAsOfDate:date},algorithm:'sha256-page-chain-v1' as const,pageSize:PAGE_SIZE,tables}
  return {...body,checksum:await digest(body)}
}

export async function verifyPostVerifyLabelEvidence(env: Bindings, evidence: unknown): Promise<boolean> {
  let saved: PostVerifyLabelEvidence
  try {
    saved=evidence as PostVerifyLabelEvidence
    if(!saved || saved.schema!=='post-verify-label-evidence-v1' || typeof saved.checksum!=='string')return false
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
      || /^post_verify_evidence_(read_failed|page_budget|concurrent_change|cursor_invalid)/.test(message))throw error
    return false
  }
}
