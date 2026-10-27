import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { loadLatestSchedulerRootTicket } from './schedulerExecutionTickets'
import type { SchedulerRunStatus } from './schedulerRunLogger'
import { postVerifyDigest as digest, recordPostVerifyOwnerAck, registerPostVerifyScope, type EffectAck } from './postVerifyEffectScope'
export { assertPostVerifyEffectAllowed, isPostVerifyTaskScope, postVerifyAckDescriptor, postVerifyControllerResponse,
  postVerifyOwnerAckEvidence, recordPostVerifyOwnerAck } from './postVerifyEffectScope'

export type PostVerifyTaskResult = { task: string; summary: string; status: SchedulerRunStatus; critical?: boolean; evidence?: Record<string, unknown> }
type Identity = {
  businessDate: string; canonicalRunId: string; rootTicketId: string; sourceSha: string; versionId: string
  productionEligible: boolean
  configurationChecksum: string
}
type Receipt = {
  schema: 'post-verify-task-receipt-v1'; identity: Identity; task: string; predecessor: string
  claim: string; leaseOwner: string; result?: PostVerifyTaskResult; checksum?: string
}
type Row = { state: string; receipt_json: string }
const PREFIX = 'post_verify_task_v1:'
const RUNNING = PREFIX + 'running'
const SUCCESS = PREFIX + 'success'
const ERROR = PREFIX + 'error'
const UNCERTAIN = PREFIX + 'uncertain'

function writes(sql: string): boolean {
  // WITH may contain writes. False-positive guards are safe; no writes bypass
  // the guard through a RETURNING first/all/raw call.
  return !/^\s*(?:--[^\n]*\n\s*)*(SELECT\b|EXPLAIN\b)/i.test(sql)
}

function scopedEnvironment(env: Bindings, assertActive: () => Promise<void>): Bindings {
  const cache = new WeakMap<object, object>()
  const statements = new WeakMap<object, object>()
  const statementInputs = new WeakMap<object, {sql:string;binds:unknown[]}>()
  const acks:EffectAck[]=[]
  let scoped:Bindings
  const wrapStatement = (statement: any, mutates: boolean, sql: string, binds: unknown[] = []): any => {
    const proxy = new Proxy(statement, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (property === 'bind') return (...args: unknown[]) => wrapStatement(value.apply(target, args), mutates,sql,args)
      return async (...args: unknown[]) => {
        if (mutates && ['run', 'all', 'first', 'raw'].includes(String(property))) await assertActive()
        const result=await value.apply(target, args)
        if(mutates) await recordPostVerifyOwnerAck(scoped,'d1',String(property),{sql,binds},result,
          {table:sql.match(/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_]\w*)/i)?.[1]??null,successful:result?.success!==false})
        return result
      }
    },
    })
    statements.set(proxy, statement)
    statementInputs.set(proxy,{sql,binds})
    return proxy
  }
  const wrap = (binding: any, kind: 'db' | 'effect'): any => {
    if (!binding || typeof binding !== 'object') return binding
    const previous = cache.get(binding)
    if (previous) return previous
    const proxy = new Proxy(binding, {
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        if (kind === 'db' && property === 'prepare') return (sql: string) => wrapStatement(value.call(target, sql), writes(sql),sql)
        return async (...args: unknown[]) => {
          const request=kind==='db'&&property==='batch'&&Array.isArray(args[0])?args[0].map(statement=>statementInputs.get(statement)??null):args
          if ((kind === 'db' && ['batch', 'exec'].includes(String(property)))
              || (kind === 'effect' && ['put', 'delete', 'send', 'sendBatch', 'write'].includes(String(property)))) await assertActive()
          if (kind === 'db' && property === 'batch' && Array.isArray(args[0])) args[0] = args[0].map(statement => statements.get(statement) ?? statement)
          const result=await value.apply(target, args)
          if(kind==='db'&&['batch','exec'].includes(String(property))) await recordPostVerifyOwnerAck(scoped,'d1',String(property),request,result,
            {successful:Array.isArray(result)?result.every(row=>row?.success!==false):result?.success!==false})
          if(kind==='effect'&&['put','delete','send','sendBatch','write'].includes(String(property))) {
            const effectKind = ['send','sendBatch'].includes(String(property)) ? 'queue' : property==='write' ? 'artifact' : 'storage'
            await recordPostVerifyOwnerAck(scoped,effectKind,String(property),args,result,
              effectKind==='queue'?{enqueue_acknowledged:true,payload_checksum:await digest(args[0])}:{successful:true})
          }
          return result
        }
      },
    })
    cache.set(binding, proxy)
    return proxy
  }
  scoped = new Proxy(env, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (/^(?:DB|[A-Z]+_DB)$/.test(String(property))) return wrap(value, 'db')
      if (['KV', 'ARTIFACTS', 'EVIDENCE_ARTIFACT_WRITER', 'UPDATE_QUEUE', 'NEWS_QUEUE', 'ML_QUEUE'].includes(String(property))) return wrap(value, 'effect')
      return value
    },
  })
  registerPostVerifyScope(scoped, assertActive, acks)
  return scoped
}

export async function createPostVerifyTaskCheckpoints(env: Bindings, input: {
  businessDate: string; canonicalRunId: string; leaseOwner: string; productionEligible: boolean
  assertStageLease: (boundary?: string) => Promise<void>
}) {
  const sourceSha = String(env.CF_VERSION_METADATA?.tag ?? '')
  const versionId = String(env.CF_VERSION_METADATA?.id ?? '')
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !versionId || !input.leaseOwner) {
    throw new Error('post_verify_checkpoint_source_or_lease_identity_missing')
  }
  const db = databaseForDataDomain(env, 'ops')
  const root = await loadLatestSchedulerRootTicket(db, { schedulerJobId: 'evening-chain', businessDate: input.businessDate })
  if (!root) throw new Error('post_verify_checkpoint_root_missing')
  const identity: Identity = { businessDate: input.businessDate, canonicalRunId: input.canonicalRunId,
    rootTicketId: root.ticket_id, sourceSha, versionId, productionEligible: input.productionEligible,
    configurationChecksum: await digest(await env.KV.get('trading:config')) }
  let predecessor = await digest(identity)
  const assertAuthority = async (receiptKey?: string, receiptJson?: string) => {
    if (!receiptKey) await input.assertStageLease('post-verify:checkpoint-write')
    const current = await db.prepare(`SELECT 1 AS ok FROM pipeline_stage_runs stage
      WHERE stage.business_date=? AND stage.stage='post_verify_chain' AND stage.canonical_run_id=?
        AND stage.status='running' AND stage.lease_owner=? AND stage.lease_expires_at >= CURRENT_TIMESTAMP
        AND ?=(SELECT ticket_id FROM scheduler_execution_tickets_v1
          WHERE scheduler_job_id='evening-chain' AND business_date=? AND ticket_kind='physical_root'
          ORDER BY updated_at DESC, ticket_id DESC LIMIT 1)
        AND (? IS NULL OR EXISTS(SELECT 1 FROM post_verify_task_receipts_v1
          WHERE receipt_key=? AND state=? AND receipt_json=?))`)
      .bind(input.businessDate, input.canonicalRunId, input.leaseOwner, identity.rootTicketId, input.businessDate,
        receiptKey ?? null, receiptKey ?? null, RUNNING, receiptJson ?? null).first()
    if (!current) throw new Error('post_verify_checkpoint_authority_lost')
  }
  return {
    async run(task: string, fn: (scoped: Bindings) => Promise<PostVerifyTaskResult>, options: {
      timeoutMs?: number; retrySafe?: boolean; critical?: boolean; verifyResult?: (result: PostVerifyTaskResult) => Promise<boolean>
    } = {}): Promise<PostVerifyTaskResult> {
      await assertAuthority()
      const key = PREFIX + await digest({ identity, task, predecessor })
      const old = await db.prepare('SELECT state,receipt_json FROM post_verify_task_receipts_v1 WHERE receipt_key=?').bind(key).first<Row>()
      if (old && [SUCCESS, ERROR].includes(old.state)) {
        const receipt = JSON.parse(old.receipt_json) as Receipt
        if (JSON.stringify(receipt.identity) !== JSON.stringify(identity) || receipt.task !== task
            || receipt.predecessor !== predecessor || !receipt.result || !receipt.checksum
            || receipt.checksum !== await digest({ ...receipt, checksum: undefined })) {
          throw new Error(`post_verify_checkpoint_corrupt:${task}`)
        }
        const verified = old.state !== SUCCESS || !options.verifyResult || await options.verifyResult(receipt.result)
        if (!verified) {
          if (!options.retrySafe) {
            if(options.critical===false){
              // The original producer is confirmed terminal. Report a fresh
              // optional integrity error without repeating its side effects or
              // invalidating already completed downstream operations.
              predecessor=receipt.checksum
              return {task,summary:`post_verify_checkpoint_artifact_changed_requires_reconciliation:${task}`,status:'error',critical:false}
            }
            throw new Error(`post_verify_checkpoint_artifact_changed_requires_reconciliation:${task}`)
          }
          // Preserve the previous success receipt before invalidating its active
          // alias. An idempotent producer may repair changed/missing output.
          const authority=`EXISTS(SELECT 1 FROM pipeline_stage_runs WHERE business_date=? AND stage='post_verify_chain'
            AND canonical_run_id=? AND status='running' AND lease_owner=? AND lease_expires_at>=CURRENT_TIMESTAMP)
            AND ?=(SELECT ticket_id FROM scheduler_execution_tickets_v1 WHERE scheduler_job_id='evening-chain'
              AND business_date=? AND ticket_kind='physical_root' ORDER BY updated_at DESC,ticket_id DESC LIMIT 1)`
          const binds=[input.businessDate,input.canonicalRunId,input.leaseOwner,identity.rootTicketId,input.businessDate]
          await db.prepare(`INSERT OR IGNORE INTO post_verify_task_receipts_v1(receipt_key,state,business_date,receipt_json)
            SELECT ?,?,?,? WHERE ${authority}`).bind(`${key}:invalidated:${receipt.checksum}`, ERROR, input.businessDate, old.receipt_json,...binds).run()
          const changed=await db.prepare(`UPDATE post_verify_task_receipts_v1 SET state=?
            WHERE receipt_key=? AND state=? AND receipt_json=? AND ${authority} RETURNING receipt_key`)
            .bind(ERROR,key,SUCCESS,old.receipt_json,...binds).first()
          if(!changed)throw new Error('post_verify_checkpoint_authority_lost_during_invalidation')
        } else if (old.state === SUCCESS || options.retrySafe !== true) {
          // A settled optional error remains an error, never a successful hit.
          predecessor = receipt.checksum
          return receipt.result
        }
      }
      const receipt: Receipt = { schema: 'post-verify-task-receipt-v1', identity, task, predecessor,
        claim: crypto.randomUUID(), leaseOwner: input.leaseOwner }
      const serialized = JSON.stringify(receipt)
      const claim = await db.prepare(`INSERT INTO post_verify_task_receipts_v1(receipt_key,state,business_date,receipt_json)
        SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM pipeline_stage_runs
          WHERE business_date=? AND stage='post_verify_chain' AND canonical_run_id=? AND status='running'
            AND lease_owner=? AND lease_expires_at>=CURRENT_TIMESTAMP)
          AND ?=(SELECT ticket_id FROM scheduler_execution_tickets_v1
            WHERE scheduler_job_id='evening-chain' AND business_date=? AND ticket_kind='physical_root'
            ORDER BY updated_at DESC,ticket_id DESC LIMIT 1)
          AND NOT EXISTS(SELECT 1 FROM post_verify_task_receipts_v1 WHERE state IN (?,?) AND business_date=?)
        ON CONFLICT(receipt_key) DO UPDATE SET state=excluded.state,receipt_json=excluded.receipt_json,updated_at=CURRENT_TIMESTAMP
          WHERE post_verify_task_receipts_v1.state=? AND ?=1
        RETURNING receipt_key`).bind(key, RUNNING, input.businessDate, serialized, input.businessDate,
          input.canonicalRunId, input.leaseOwner, identity.rootTicketId, input.businessDate,
          RUNNING, UNCERTAIN, input.businessDate, ERROR, options.retrySafe === true ? 1 : 0).first()
      if (!claim) throw new Error(`post_verify_checkpoint_unsettled_side_effect:${task}`)
      let terminal = false
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const assertEffects = async () => {
        if (terminal) throw new Error(`post_verify_checkpoint_task_closed:${task}`)
        await assertAuthority(key, serialized)
      }
      const scoped = scopedEnvironment(env, assertEffects)
      const settle = async (result: PostVerifyTaskResult) => {
        terminal = true
        const completed: Receipt = { ...receipt, result }
        completed.checksum = await digest(completed)
        // Only this exact original claim may publish its own terminal receipt.
        // It never mutates a newer stage/root or claims that root succeeded.
        const encoded = JSON.stringify(completed)
        if (new TextEncoder().encode(encoded).length > 32_768) throw new Error(`post_verify_checkpoint_receipt_too_large:${task}`)
        const uncertain = result.status === 'error' && options.retrySafe !== true
          && /timeout|timed out|abort|network|fetch failed|HTTP\s*5\d\d|socket|connection|unacknowledged/i.test(result.summary)
        const state = result.status === 'error' ? uncertain ? UNCERTAIN : ERROR : SUCCESS
        const saved = await db.prepare(`UPDATE post_verify_task_receipts_v1 SET state=?,receipt_json=?,updated_at=CURRENT_TIMESTAMP
          WHERE receipt_key=? AND state=? AND receipt_json=? RETURNING receipt_key`)
          .bind(state, encoded, key, RUNNING, serialized).first()
        if (!saved) throw new Error(`post_verify_checkpoint_terminal_write_conflict:${task}`)
        const readback = await db.prepare('SELECT state,receipt_json FROM post_verify_task_receipts_v1 WHERE receipt_key=?').bind(key).first<Row>()
        if (!readback || readback.receipt_json !== encoded
            || readback.state !== state) {
          throw new Error(`post_verify_checkpoint_terminal_readback_mismatch:${task}`)
        }
        return completed
      }
      const work = (async () => {
        let result: PostVerifyTaskResult
        try {
          result = await fn(scoped)
        } catch (error) {
          // Rejection is an observed terminal result. The function is no longer
          // running; only explicitly idempotent tasks may retry this failure.
          result = { task, status: 'error', summary: error instanceof Error ? error.message : String(error) }
          await settle(result)
          throw error
        }
        return settle(result)
      })()
      // If a live producer settles after the observer timed out, wake the same
      // canonical stage. Queue duplication is harmless: the stage lease and
      // validated task receipts still own execution. Stale roots never wake.
      const wake = async () => {
        if (!timedOut) return
        const current = await db.prepare(`SELECT 1 AS ok FROM pipeline_stage_runs
          WHERE business_date=? AND stage='post_verify_chain' AND canonical_run_id=?
            AND ?=(SELECT ticket_id FROM scheduler_execution_tickets_v1
              WHERE scheduler_job_id='evening-chain' AND business_date=? AND ticket_kind='physical_root'
              ORDER BY updated_at DESC,ticket_id DESC LIMIT 1)`)
          .bind(input.businessDate, input.canonicalRunId, identity.rootTicketId, input.businessDate).first()
        if (current) await env.UPDATE_QUEUE.send({ type: 'post_verify_chain', cursor: 0,
          triggerTime: input.businessDate, runId: input.canonicalRunId })
      }
      void work.then(wake, wake).catch(() => {})
      try {
        const completed = options.timeoutMs ? await Promise.race([work, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { timedOut = true; reject(new Error(`post_verify_checkpoint_timeout_unsettled:${task}`)) }, options.timeoutMs)
        })]) : await work
        predecessor = completed.checksum!
        return completed.result!
      } catch (error) {
        // Timeout does not cancel the producer. Its running claim remains and
        // all future attempts block until the original promise really settles.
        void work.catch(() => {})
        throw error
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
}
