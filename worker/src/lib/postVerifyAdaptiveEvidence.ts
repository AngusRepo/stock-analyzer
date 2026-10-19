import type { Bindings } from '../types'
import { ADAPTIVE_PARAMS_KV_KEY } from './adaptiveConfig'
import { databaseForDataDomain } from './dataDomainRegistry'
import type { LinUcbRewardLedgerRow } from './metaLearningRewardLedger'

type Task = 'linucb-reward-ledger' | 'adapt'
type Envelope = { schema: 'post-verify-adaptive-evidence-v1'; task: Task; businessDate: string }
type LedgerDescriptor = { stamp: string | null; rows: number; checksum: string }
export type PostVerifyAdaptiveEvidence = Envelope & (
  { ledger: LedgerDescriptor } | { kv: { datedKey: string; checksum: string } }
)
const outputs = new WeakMap<object, { task: Task; ledger?: LedgerDescriptor }>()
const PAGE = 512
const encoder = new TextEncoder()
class InvalidAdaptiveEvidence extends Error {}

async function digest(value: unknown): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value))))]
    .map(n => n.toString(16).padStart(2, '0')).join('')
}

export function enablePostVerifyAdaptiveEvidence(env: object, task: string): void {
  if (task === 'linucb-reward-ledger' || task === 'adapt') outputs.set(env, { task })
}

function project(row: any): LinUcbRewardLedgerRow {
  return { policy_id: row.policy_id, arm_id: row.arm_id, context_hash: row.context_hash,
    samples: row.samples, reward_sum: row.reward_sum, reward_mean: row.reward_mean,
    last_reward_at: row.last_reward_at, updated_at: row.updated_at, evidence_json: row.evidence_json }
}

function binaryOrder(a: string, b: string): number {
  const left = encoder.encode(a), right = encoder.encode(b)
  for (let n = 0; n < Math.min(left.length, right.length); n++) {
    if (left[n] !== right[n]) return left[n] - right[n]
  }
  return left.length - right.length
}

async function pageChain(rows: LinUcbRewardLedgerRow[]): Promise<string> {
  let checksum = await digest('post-verify-linucb-rows-v1')
  for (let i = 0; i < rows.length; i += PAGE) checksum = await digest([checksum, rows.slice(i, i + PAGE)])
  return checksum
}

// The actual owner supplies its exact output rows. Non-checkpoint callers pay
// no proof cost; a MAX(timestamp) guess cannot attest somebody else's refresh.
export async function recordPostVerifyLinUcbOutput(env: object, rows: LinUcbRewardLedgerRow[]): Promise<void> {
  const scope = outputs.get(env)
  if (scope?.task !== 'linucb-reward-ledger') return
  const ordered = rows.map(project).sort((a, b) => binaryOrder(a.arm_id, b.arm_id) || binaryOrder(a.context_hash, b.context_hash))
  const stamp = ordered[0]?.updated_at ?? null
  if (ordered.some(row => row.policy_id !== 'LinUCB' || row.updated_at !== stamp)
      || (stamp !== null && !Number.isFinite(Date.parse(stamp)))) throw new Error('post_verify_linucb_output_identity_invalid')
  scope.ledger = { stamp, rows: ordered.length, checksum: await pageChain(ordered) }
}

async function readLedger(env: Bindings, expected: LedgerDescriptor): Promise<LedgerDescriptor> {
  if (!Number.isSafeInteger(expected.rows) || expected.rows < 0 || expected.rows > 51200
      || !/^[a-f0-9]{64}$/.test(expected.checksum)) throw new InvalidAdaptiveEvidence('post_verify_linucb_evidence_invalid')
  if (expected.rows === 0) {
    if (expected.stamp !== null) throw new InvalidAdaptiveEvidence('post_verify_linucb_empty_stamp_invalid')
    return { stamp: null, rows: 0, checksum: await pageChain([]) }
  }
  if (typeof expected.stamp !== 'string' || !Number.isFinite(Date.parse(expected.stamp))) throw new InvalidAdaptiveEvidence('post_verify_linucb_stamp_missing')
  const db = databaseForDataDomain(env, 'learning')
  let arm: string | null = null, context = '', count = 0
  let checksum = await digest('post-verify-linucb-rows-v1')
  while (true) {
    const result = await db.prepare(`SELECT policy_id,arm_id,context_hash,samples,reward_sum,reward_mean,
      last_reward_at,updated_at,evidence_json FROM meta_reward_ledger
      WHERE policy_id='LinUCB' AND updated_at=? AND (? IS NULL OR arm_id>? OR (arm_id=? AND context_hash>?))
      ORDER BY arm_id,context_hash LIMIT 512`).bind(expected.stamp, arm, arm, arm, context).all<any>()
    if (result.success === false || !Array.isArray(result.results)) throw new Error('post_verify_linucb_readback_failed')
    const rows = result.results.map(project)
    if (!rows.length) break
    count += rows.length
    if (count > expected.rows || count > 51200) throw new InvalidAdaptiveEvidence('post_verify_linucb_readback_count_mismatch')
    checksum = await digest([checksum, rows])
    arm = rows[rows.length - 1].arm_id
    context = rows[rows.length - 1].context_hash
    if (rows.length < PAGE) break
  }
  return { stamp: expected.stamp, rows: count, checksum }
}

async function readAdaptive(env: Bindings, businessDate: string, datedKey?: string) {
  const latest = await env.KV.get(ADAPTIVE_PARAMS_KV_KEY)
  if (typeof latest !== 'string') throw new InvalidAdaptiveEvidence('post_verify_adaptive_latest_missing')
  const value = JSON.parse(latest)
  const computed = Date.parse(value?.computed_at)
  if (!Number.isFinite(computed) || new Date(computed + 8 * 3600000).toISOString().slice(0, 10) !== businessDate
      || value?.provenance?.owner !== 'ml-controller' || value?.provenance?.fallback !== false
      || value?.provenance?.schema_version !== 'adaptive-params-v2') throw new InvalidAdaptiveEvidence('post_verify_adaptive_identity_invalid')
  const key = ADAPTIVE_PARAMS_KV_KEY + ':' + String(value.computed_at).slice(0, 10)
  if (datedKey !== undefined && datedKey !== key) throw new InvalidAdaptiveEvidence('post_verify_adaptive_dated_key_changed')
  const raw = await env.KV.get(key)
  if (raw !== latest) throw new InvalidAdaptiveEvidence('post_verify_adaptive_dated_readback_mismatch')
  return { datedKey: key, checksum: await digest(JSON.parse(raw)) }
}

export async function capturePostVerifyAdaptiveEvidence(env: Bindings, task: Task,
  businessDate: string): Promise<PostVerifyAdaptiveEvidence> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new Error('post_verify_adaptive_business_date_invalid')
  const base: Envelope = { schema: 'post-verify-adaptive-evidence-v1', task, businessDate }
  if (task === 'adapt') return { ...base, kv: await readAdaptive(env, businessDate) }
  const expected = outputs.get(env)?.ledger
  if (!expected) throw new Error('post_verify_linucb_owner_output_missing')
  const actual = await readLedger(env, expected)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('post_verify_linucb_output_readback_mismatch')
  return { ...base, ledger: actual }
}

export async function verifyPostVerifyAdaptiveEvidence(env: Bindings, task: Task,
  businessDate: string, proof: unknown): Promise<boolean> {
  try {
    const saved = proof as PostVerifyAdaptiveEvidence
    if (saved?.schema !== 'post-verify-adaptive-evidence-v1' || saved.task !== task || saved.businessDate !== businessDate) return false
    if (task === 'adapt' && (!('kv' in saved) || !saved.kv || typeof saved.kv.datedKey !== 'string'
        || !/^[a-f0-9]{64}$/.test(saved.kv.checksum))) return false
    if (task === 'linucb-reward-ledger' && (!('ledger' in saved) || !saved.ledger || typeof saved.ledger !== 'object')) return false
    const actual = task === 'adapt' && 'kv' in saved
      ? { schema: saved.schema, task, businessDate, kv: await readAdaptive(env, businessDate, saved.kv.datedKey) }
      : task === 'linucb-reward-ledger' && 'ledger' in saved
        ? { schema: saved.schema, task, businessDate, ledger: await readLedger(env, saved.ledger) } : null
    return JSON.stringify(actual) === JSON.stringify(saved)
  } catch (error) {
    // Successful reads can establish invalid content. Transport/schema failures
    // cannot establish invalidation and must retain the settled receipt.
    if (error instanceof InvalidAdaptiveEvidence || error instanceof SyntaxError) return false
    throw error
  }
}
